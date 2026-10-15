(function () {
  const $ = (sel) => document.querySelector(sel);

  // ---- date helpers (same math as every other dashboard here) ----
  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(d, n) { const nd = new Date(d); nd.setDate(nd.getDate() + n); return nd; }
  function startOfMonth(y, m) { return new Date(y, m - 1, 1); }
  function endOfMonth(y, m) { return new Date(y, m, 0); }
  function mondayOf(d) { const day = d.getDay(); const diff = day === 0 ? -6 : 1 - day; return addDays(d, diff); }
  function pacificToday() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    return new Date(get('year'), get('month') - 1, get('day'));
  }
  function computeRange(key) {
    const today = pacificToday();
    switch (key) {
      case 'today': return { start: toISO(today), end: toISO(today) };
      case 'yesterday': { const y = addDays(today, -1); return { start: toISO(y), end: toISO(y) }; }
      case 'wtd': return { start: toISO(mondayOf(today)), end: toISO(today) };
      case 'lastweek': { const lastMon = addDays(mondayOf(today), -7); const lastSun = addDays(lastMon, 6); return { start: toISO(lastMon), end: toISO(lastSun) }; }
      default: {
        const m = /^(\d{4})-(\d{2})$/.exec(key);
        if (m) { const y = Number(m[1]), mo = Number(m[2]); return { start: toISO(startOfMonth(y, mo)), end: toISO(endOfMonth(y, mo)) }; }
        return { start: null, end: null };
      }
    }
  }
  function buildQuickRangeOptions(floorYear, floorMonth) {
    const sel = $('#quick-range');
    const today = pacificToday();
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const idxToKey = (idx) => { const y = Math.floor((idx - 1) / 12); return y + '-' + pad(idx - y * 12); };
    const idxToName = (idx) => { const y = Math.floor((idx - 1) / 12); return names[idx - y * 12 - 1] + ' ' + y; };
    const thisIdx = today.getFullYear() * 12 + (today.getMonth() + 1);
    const lastIdx = thisIdx - 1;
    const floorIdx = floorYear * 12 + floorMonth;
    const mkOpt = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; };
    sel.innerHTML = '';
    sel.appendChild(mkOpt('all', 'All time'));
    sel.appendChild(mkOpt('today', 'Today'));
    sel.appendChild(mkOpt('yesterday', 'Yesterday'));
    sel.appendChild(mkOpt('wtd', 'This week'));
    sel.appendChild(mkOpt('lastweek', 'Last week'));
    sel.appendChild(mkOpt(idxToKey(thisIdx), 'This month'));
    sel.appendChild(mkOpt(idxToKey(lastIdx), 'Last month'));
    for (let idx = lastIdx - 1; idx >= floorIdx; idx--) sel.appendChild(mkOpt(idxToKey(idx), idxToName(idx)));
    return idxToKey(thisIdx);
  }

  function parseDate(s) {
    const [m, d, y] = String(s || '').split('/').map(Number);
    if (!m || !d || !y) return null;
    return new Date(y, m - 1, d);
  }
  function parseInputDate(value, endOfDay) {
    if (!value) return null;
    const [y, m, d] = value.split('-').map(Number);
    return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d);
  }
  function fmtMoney(n) { const sign = n < 0 ? '-' : ''; return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }
  function fmtPct(n) { return n.toFixed(2) + '%'; }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const state = {
    range: { start: null, end: null },
    section: 'global',
    rows: { 'ca-nw': [], nw: [], ca: [], 'live-agency': [], 'media-spend': [], 'agency-leads': [], 'google-ad-spent': [] },
    leadDetail: [],
    trendsDays: [], trendsVertical: 'combined',
    lateQmvas: [], restoredLeads: [], correlation: [],
    restoredSub: 'late',
    posted: null, hourly: null,
    loadedSections: new Set(),
  };

  // ---- known duplicate ad-spend corrections (replicated from the source spreadsheet's own
  // correction formula — see the original walker-dashboard repo's public/app.js) ----
  const AD_SPEND_CORRECTIONS = [
    { adName: 'LF - NewDeskHook - Texas', from: '2026-08-03', to: '2026-08-05', amount: 8729.72 },
    { adName: 'LF - TX - HeliQConfrontationRonV2 - 2', from: '2026-08-03', to: '2026-08-05', amount: 1647.12 },
    { adName: 'LF - YouHaveToSeeThisVillainRon - TX', from: '2026-08-03', to: '2026-08-05', amount: 329.42 },
    { adName: 'LF - MessageForYouVillainRon - TX', from: '2026-08-03', to: '2026-08-05', amount: 164.71 },
    { adName: 'Long Form - YouHaveSeeThisConfrontRonTX', from: '2026-08-03', to: '2026-08-05', amount: 329.42 },
    { adName: 'Long Form - MessageForYouConfrontRonTX', from: '2026-08-03', to: '2026-08-05', amount: 329.42 },
    { adName: 'LF - NewDeskHook - Texas', from: '2026-08-17', to: '2026-08-19', amount: 509.28 },
    { adName: 'LF - TX - HeliQConfrontationRonV2 - NC3', from: '2026-08-17', to: '2026-08-19', amount: 169.76 },
    { adName: 'LF - TX - HeliQConfrontationRonV2 - NC2', from: '2026-08-17', to: '2026-08-19', amount: 339.52 },
  ];
  function rangesOverlap(aFrom, aTo, bFrom, bTo) { return aFrom <= bTo && aTo >= bFrom; }
  function adSpendCorrectionTotal(rows) {
    const viewFrom = state.range.start ? parseInputDate(state.range.start, false) : new Date(2000, 0, 1);
    const viewTo = state.range.end ? parseInputDate(state.range.end, true) : new Date(2100, 0, 1);
    const adNamesPresent = new Set(rows.map((r) => r.adName));
    let total = 0;
    AD_SPEND_CORRECTIONS.forEach((c) => {
      if (!adNamesPresent.has(c.adName)) return;
      const cFrom = parseInputDate(c.from, false), cTo = parseInputDate(c.to, true);
      if (rangesOverlap(viewFrom, viewTo, cFrom, cTo)) total += c.amount;
    });
    return total;
  }
  // ---- historical ad-spend reconciliation (Feb-Mar 2026) ----
  // Cross-checked the "Walker INVOICE Weekly" sheet (the manually-reconciled, PAID invoice
  // ledger — spreadsheet 1500g7cuyitT9Xmn85TkMoWXs9XYBoDOBs1cvz5Na36w, tab "Walker INVOICE
  // Weekly") against this dashboard's own computed ad spend, week by week, for every settled
  // invoice period from Feb 2026 through Oct 2026. Every week from March 30, 2026 onward matches
  // the invoiced Ad Spent figure within a few hundred dollars (ordinary late-data drift). But
  // five early, already-PAID weeks are overcounted far beyond that — ad spend computed here is
  // up to 2.6x the actual invoiced amount for March 1-15, 2026 alone ($247,648.83 computed vs.
  // $95,280.02 invoiced) — a pre-existing data issue from early in this campaign's history that
  // was never corrected (unlike the August 2026 incidents in AD_SPEND_CORRECTIONS above, which
  // only ever covered duplicate spend for specific ads, not this). Confirmed these five weeks
  // are the entire source of the "only $1.77M profit, not $2.1M+" gap reported against the
  // invoice ledger's own Profit total. These are closed, paid invoice periods — the invoiced
  // amount is final and won't change — so this corrects total ad spend down to what was actually
  // paid. Split by vertical (see renderNwCa): checking NW alone against the ledger for these same
  // weeks matched exactly with zero correction needed — CA PPL hadn't even launched yet for the
  // first three of the five weeks, so 100% of the overcount sits on the CA side; apply the full
  // amount only where CA rows are summed (Global PPL and the CA half of NW & CA PPL), never to
  // NW alone, and never to Agency, which has its own separate, unverified data source.
  const HISTORICAL_SPEND_CORRECTIONS = [
    { from: '2026-02-09', to: '2026-02-15', amount: 8791.25 },
    { from: '2026-02-16', to: '2026-02-28', amount: 44308.45 },
    { from: '2026-03-01', to: '2026-03-15', amount: 152368.81 },
    { from: '2026-03-16', to: '2026-03-23', amount: 7907.36 },
    { from: '2026-03-24', to: '2026-03-29', amount: 2292.08 },
  ];
  function historicalSpendCorrectionTotal() {
    const viewFrom = state.range.start ? parseInputDate(state.range.start, false) : new Date(2000, 0, 1);
    const viewTo = state.range.end ? parseInputDate(state.range.end, true) : new Date(2100, 0, 1);
    let total = 0;
    HISTORICAL_SPEND_CORRECTIONS.forEach((c) => {
      const cFrom = parseInputDate(c.from, false), cTo = parseInputDate(c.to, true);
      if (rangesOverlap(viewFrom, viewTo, cFrom, cTo)) total += c.amount;
    });
    return total;
  }
  function inRange(row) {
    const d = parseDate(row.date);
    if (!d) return false;
    if (state.range.start && toISO(d) < state.range.start) return false;
    if (state.range.end && toISO(d) > state.range.end) return false;
    return true;
  }
  // ---- Late QMVA Invoice bonus ----
  // The "Walker INVOICE Weekly" ledger's own Profit formula is (Invoice Amount - Ad Spent) +
  // Late QMVA Invoice: a separate bonus recognized only once a batch of late-qualifying QMVAs
  // gets formally invoiced, on top of the base weekly numbers — not folded into Invoice Amount
  // itself. This dashboard recognizes late-arriving commission continuously as it updates at the
  // source (confirmed directly, lead by lead), which is why matching the ledger's Profit total
  // needs this added explicitly: these are the ledger's own "Late QMVA Invoice" column values,
  // one per invoice batch, added to profit only (never to revenue, matching the ledger's own
  // formula) and only once, at Global PPL — not split by vertical, since the ledger doesn't
  // break this column out by NW vs CA.
  const LATE_QMVA_INVOICE_BONUS = [
    { from: '2026-07-01', to: '2026-07-05', amount: 21625 },
    { from: '2026-07-27', to: '2026-08-02', amount: 43193 },
    { from: '2026-08-31', to: '2026-09-06', amount: 52432.00 },
    { from: '2026-09-28', to: '2026-10-04', amount: 28285.00 },
  ];
  function lateQmvaBonusTotal() {
    const viewFrom = state.range.start ? parseInputDate(state.range.start, false) : new Date(2000, 0, 1);
    const viewTo = state.range.end ? parseInputDate(state.range.end, true) : new Date(2100, 0, 1);
    let total = 0;
    LATE_QMVA_INVOICE_BONUS.forEach((c) => {
      const cFrom = parseInputDate(c.from, false), cTo = parseInputDate(c.to, true);
      if (rangesOverlap(viewFrom, viewTo, cFrom, cTo)) total += c.amount;
    });
    return total;
  }
  function computeKPIs(rows, opts) {
    const includeHistorical = !opts || opts.includeHistorical !== false;
    const includeLateBonus = !!(opts && opts.includeLateBonus);
    const totalLeads = rows.reduce((s, r) => s + r.totalLeads, 0);
    const correction = adSpendCorrectionTotal(rows) + (includeHistorical ? historicalSpendCorrectionTotal() : 0);
    const totalSpent = rows.reduce((s, r) => s + r.totalSpent, 0) - correction;
    const revenue = rows.reduce((s, r) => s + r.revenue, 0);
    const profit = rows.reduce((s, r) => s + r.profit, 0) + correction + (includeLateBonus ? lateQmvaBonusTotal() : 0);
    const qmva = rows.reduce((s, r) => s + r.currentQmva, 0);
    const conversionRate = totalLeads ? (qmva / totalLeads) * 100 : 0;
    const cpl = totalLeads ? totalSpent / totalLeads : 0;
    const cpqmva = qmva ? totalSpent / qmva : 0;
    const profitMargin = revenue ? (profit / revenue) * 100 : 0;
    return { totalLeads, totalSpent, revenue, profit, qmva, conversionRate, cpl, cpqmva, profitMargin };
  }
  function kpiTiles(k) {
    return [
      ['REVENUE', fmtMoney(k.revenue), true, false],
      ['AD SPENT', fmtMoney(k.totalSpent), true, false],
      ['PROFIT', (k.profit < 0 ? '⚠ ' : '') + fmtMoney(k.profit), true, k.profit < 0],
      ['PROFIT MARGIN', fmtPct(k.profitMargin), true, k.profitMargin < 0],
      ['CONVERSION RATE', fmtPct(k.conversionRate), false, false],
      ['CURRENT QMVA', fmtInt(k.qmva), true, false],
      ['CPQMVA', fmtMoney(k.cpqmva), true, false],
      ['TOTAL LEADS', fmtInt(k.totalLeads), false, false],
      ['COST PER LEAD', fmtMoney(k.cpl), false, false],
    ];
  }
  function renderKpiRow(elId, rows, opts) {
    const k = computeKPIs(rows, opts);
    $('#' + elId).innerHTML = kpiTiles(k).map(([label, value, highlight, negative]) =>
      '<div class="kpi' + (highlight ? ' kpi--highlight' : '') + (negative ? ' negative' : '') + '">' +
      '<div class="kpi-label">' + label + '</div><div class="kpi-value num">' + value + '</div></div>'
    ).join('');
  }

  // ---- grouping for charts ----
  function groupByDate(rows) {
    const map = new Map();
    rows.forEach((r) => {
      if (!map.has(r.date)) map.set(r.date, { profit: 0, spent: 0, date: parseDate(r.date), raw: r.date });
      const g = map.get(r.date);
      g.profit += r.profit; g.spent += r.totalSpent;
    });
    return Array.from(map.values()).filter((g) => g.date).sort((a, b) => a.date - b.date);
  }
  const STATE_CODES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);
  const STATE_NAME_TO_CODE = { ALABAMA:'AL', ALASKA:'AK', ARIZONA:'AZ', ARKANSAS:'AR', CALIFORNIA:'CA', COLORADO:'CO', CONNECTICUT:'CT', DELAWARE:'DE', FLORIDA:'FL', GEORGIA:'GA', HAWAII:'HI', IDAHO:'ID', ILLINOIS:'IL', INDIANA:'IN', IOWA:'IA', KANSAS:'KS', KENTUCKY:'KY', LOUISIANA:'LA', MAINE:'ME', MARYLAND:'MD', MASSACHUSETTS:'MA', MICHIGAN:'MI', MINNESOTA:'MN', MISSISSIPPI:'MS', MISSOURI:'MO', MONTANA:'MT', NEBRASKA:'NE', NEVADA:'NV', 'NEW HAMPSHIRE':'NH', 'NEW JERSEY':'NJ', 'NEW MEXICO':'NM', 'NEW YORK':'NY', 'NORTH CAROLINA':'NC', 'NORTH DAKOTA':'ND', OHIO:'OH', OKLAHOMA:'OK', OREGON:'OR', PENNSYLVANIA:'PA', 'RHODE ISLAND':'RI', 'SOUTH CAROLINA':'SC', 'SOUTH DAKOTA':'SD', TENNESSEE:'TN', TEXAS:'TX', UTAH:'UT', VERMONT:'VT', VIRGINIA:'VA', WASHINGTON:'WA', 'WEST VIRGINIA':'WV', WISCONSIN:'WI', WYOMING:'WY', 'WASHINGTON DC':'DC', 'WASHINGTON D.C.':'DC', 'DISTRICT OF COLUMBIA':'DC' };
  function normalizeStateLabel(raw) {
    if (!raw) return null;
    const s = raw.trim().toUpperCase();
    if (STATE_CODES.has(s)) return s;
    if (STATE_NAME_TO_CODE[s]) return STATE_NAME_TO_CODE[s];
    return null;
  }
  function groupByState(rows) {
    const map = new Map();
    rows.forEach((r) => { const s = normalizeStateLabel(r.state); if (!s) return; map.set(s, (map.get(s) || 0) + r.currentQmva); });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
  }
  function groupByDow(rows) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const totals = new Array(7).fill(0);
    rows.forEach((r) => { const d = parseDate(r.date); if (d) totals[d.getDay()] += r.currentQmva; });
    return days.map((name, i) => ({ name, value: totals[i] }));
  }
  const PALETTE = ['#7ea6f7', '#e0a92d', '#4dd6a0', '#b48af0', '#f06c9b', '#f0965d', '#5cc8e0', '#c98af0', '#e0d15c'];
  function chartOptions(extra) {
    extra = extra || {};
    const scales = {
      x: { ticks: { color: '#8b96ac' }, grid: { color: '#232d42' } },
      y: { ticks: { color: '#8b96ac' }, grid: { color: '#232d42' } },
    };
    if (extra.y1) scales.y1 = { position: 'right', ticks: { color: '#8b96ac' }, grid: { display: false } };
    return { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false, axis: 'x' }, plugins: { legend: { labels: { color: '#e8ecf4' } } }, scales };
  }
  const charts = {};
  function upsertChart(id, config) {
    const el = $('#' + id);
    if (!el) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(el, config);
  }
  function renderChartTrio(prefix, rows) {
    const byDate = groupByDate(rows);
    const labels = byDate.map((g) => g.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    upsertChart('chart-' + prefix + '-bydate', {
      data: { labels, datasets: [
        { type: 'bar', label: 'Profit', data: byDate.map((g) => g.profit), backgroundColor: PALETTE[0] },
        { type: 'bar', label: 'Total Amount Spent', data: byDate.map((g) => g.spent), backgroundColor: PALETTE[1], yAxisID: 'y1' },
        { type: 'line', label: 'Spent Trend', data: byDate.map((g) => g.spent), borderColor: PALETTE[1], tension: 0.4, pointRadius: 2, yAxisID: 'y1' },
      ] },
      options: chartOptions({ y1: true }),
    });
    const byState = groupByState(rows);
    const totalQmva = byState.reduce((s, g) => s + g.value, 0);
    upsertChart('chart-' + prefix + '-state', {
      type: 'doughnut',
      data: { labels: byState.map((g) => g.label + ' (' + fmtInt(g.value) + ')'), datasets: [{ data: byState.map((g) => g.value), backgroundColor: byState.map((_, i) => PALETTE[i % PALETTE.length]), borderWidth: 0 }] },
      options: { cutout: '65%', plugins: { legend: { position: 'right', labels: { color: '#e8ecf4', boxWidth: 10, font: { size: 11 } } } } },
      plugins: [{ id: 'centerText', beforeDraw(chart) {
        const { ctx, chartArea } = chart;
        if (!chartArea) return;
        ctx.save(); ctx.font = '700 22px sans-serif'; ctx.fillStyle = '#e8ecf4'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(fmtInt(totalQmva), (chartArea.left + chartArea.right) / 2, (chartArea.top + chartArea.bottom) / 2);
        ctx.restore();
      } }],
    });
    const byDow = groupByDow(rows);
    upsertChart('chart-' + prefix + '-dow', {
      type: 'bar',
      data: { labels: byDow.map((d) => d.name), datasets: [{ label: 'Current QMVA', data: byDow.map((d) => d.value), backgroundColor: PALETTE[0], borderRadius: 4 }] },
      options: chartOptions(),
    });
  }
  function renderOverTimeChart(id, rows) {
    const byDate = groupByDate(rows);
    const labels = byDate.map((g) => g.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    upsertChart(id, {
      data: { labels, datasets: [
        { type: 'bar', label: 'Profit', data: byDate.map((g) => g.profit), backgroundColor: PALETTE[0] },
        { type: 'line', label: 'Total Amount Spent', data: byDate.map((g) => g.spent), borderColor: PALETTE[1], backgroundColor: 'rgba(224,169,45,.15)', fill: true, tension: 0.35 },
      ] },
      options: chartOptions(),
    });
  }

  // ---- fetch helpers ----
  async function fetchTab(tab) {
    const r = await fetch('/walker-api/data?tab=' + tab, { cache: 'no-store' });
    const json = await r.json();
    return json.rows || [];
  }

  async function loadGlobal() {
    const [caNw, leadDetail] = await Promise.all([fetchTab('ca-nw'), fetchTab('publisher-leads')]);
    state.rows['ca-nw'] = caNw;
    state.leadDetail = leadDetail;
    renderGlobal();
  }
  function renderGlobal() {
    const rows = state.rows['ca-nw'].filter(inRange);
    renderKpiRow('global-kpis', rows, { includeLateBonus: true });
    renderChartTrio('global', rows);
    renderOverTimeChart('chart-global-overtime', rows);
    renderLeadDetail();
  }

  const LEAD_DETAIL_CA = new Set(['Loudr', 'LoudrDQ', 'LoudrSPCA', 'LoudrSP_DQ', 'Loudr - IB SP', 'Loudr - IB CA', 'LoudrCA - IB SP']);
  const LEAD_DETAIL_NW = new Set(['LoudrNWCPA', 'LoudrNWDQ', 'Loudr - IB NW TX', 'LoudrNWCPA - IB', 'Loudr - IB NW GA', 'LoudrNWCPA_SP', 'LoudrNWCPA - IB SP', 'LoudrNW', 'Loudr - IB Catchall']);
  function parsePublisherDate(s) {
    const m = /^(\d{2})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    return new Date(2000 + Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  }
  function renderLeadDetail() {
    const commission = (r) => Number(String(r['Partner Commission'] || '0').replace(/[$,]/g, '')) || 0;
    const filtered = state.leadDetail.filter((r) => {
      const campaign = r['Campaign'];
      if (campaign === 'Loudr_NWA' || campaign === 'Loudr NWA - IB' || campaign === 'LoudrDupe') return false;
      if (!LEAD_DETAIL_CA.has(campaign) && !LEAD_DETAIL_NW.has(campaign)) return false;
      if (commission(r) <= 0) return false;
      const d = parsePublisherDate(r['Date']);
      if (!d) return false;
      if (state.range.start && toISO(d) < state.range.start) return false;
      if (state.range.end && toISO(d) > state.range.end) return false;
      return true;
    }).sort((a, b) => (parsePublisherDate(b['Date']) || 0) - (parsePublisherDate(a['Date']) || 0));
    const term = ($('#lead-search').value || '').trim().toLowerCase();
    const searched = term ? filtered.filter((r) => [r['First Name'], r['Last Name'], r['Consumer Phone'], r['Consumer Phone(Primary)'], r['Incident State'], r['Campaign']].join(' ').toLowerCase().includes(term)) : filtered;
    const total = searched.reduce((a, r) => a + commission(r), 0);
    $('#lead-count').textContent = searched.length.toLocaleString() + ' leads — ' + fmtMoney(total) + ' total commission' + (term ? ' (filtered from ' + filtered.length.toLocaleString() + ')' : '');
    const shown = searched.slice(0, 500);
    $('#lead-detail-body').innerHTML = shown.map((r) =>
      '<tr><td>' + escapeHtml(r['Date']) + '</td>' +
      '<td>' + escapeHtml((r['First Name'] || '') + ' ' + (r['Last Name'] || '')) + '</td>' +
      '<td>' + escapeHtml(r['Consumer Phone'] || r['Consumer Phone(Primary)'] || '') + '</td>' +
      '<td>' + escapeHtml(r['Incident State'] || '') + '</td>' +
      '<td>' + escapeHtml(r['Campaign'] || '') + '</td>' +
      '<td class="td-num num">' + fmtMoney(commission(r)) + '</td>' +
      '<td>' + escapeHtml(r['Qualified'] || '') + '</td></tr>'
    ).join('');
  }

  async function loadNwCa() {
    const [nw, ca] = await Promise.all([fetchTab('nw'), fetchTab('ca')]);
    state.rows.nw = nw; state.rows.ca = ca;
    renderNwCa();
  }
  function renderNwCa() {
    const nwRows = state.rows.nw.filter(inRange);
    const caRows = state.rows.ca.filter(inRange);
    // The historical ad-spend reconciliation above lives entirely on the CA side: cross-checking
    // NW alone against the invoice ledger for Feb-Mar 2026 found it matched exactly with zero
    // correction needed (CA PPL hadn't launched yet for the first three of those weeks — its
    // computed spend in that window was 100% the overcounted artifact). Applying it to NW too
    // would double it on the combined Global PPL view.
    renderKpiRow('nw-kpis', nwRows, { includeHistorical: false });
    renderKpiRow('ca-kpis', caRows);
    const nwByState = groupByState(nwRows);
    upsertChart('chart-nw-state', { type: 'doughnut', data: { labels: nwByState.map((g) => g.label), datasets: [{ data: nwByState.map((g) => g.value), backgroundColor: nwByState.map((_, i) => PALETTE[i % PALETTE.length]) }] }, options: { plugins: { legend: { position: 'right', labels: { color: '#e8ecf4' } } } } });
    const caByState = groupByState(caRows);
    upsertChart('chart-ca-state', { type: 'doughnut', data: { labels: caByState.map((g) => g.label), datasets: [{ data: caByState.map((g) => g.value), backgroundColor: caByState.map((_, i) => PALETTE[i % PALETTE.length]) }] }, options: { plugins: { legend: { position: 'right', labels: { color: '#e8ecf4' } } } } });
    renderOverTimeChart('chart-nw-overtime', nwRows);
    renderOverTimeChart('chart-ca-overtime', caRows);
  }

  async function loadAgency() {
    const [agency, mediaSpend, agencyLeads, googleAdSpent] = await Promise.all([
      fetchTab('live-agency'), fetchTab('media-spend'), fetchTab('agency-leads'), fetchTab('google-ad-spent'),
    ]);
    state.rows['live-agency'] = agency;
    state.rows['media-spend'] = mediaSpend;
    state.rows['agency-leads'] = agencyLeads;
    state.rows['google-ad-spent'] = googleAdSpent;
    renderAgency();
  }
  // Ported from the original walker-dashboard's renderAgency(): Agency has no Revenue/Profit
  // concept of its own (it's a pass-through ad-buying service, not a per-lead payout one) — its
  // real scorecards are actual ad spend plus the 35% agency fee from the Media Spend Tracker,
  // with QMVA/CPQMVA from the LIVE AGENCY rows and a real lead count from the AGENCY Leads
  // Import sheet (one row per lead — LIVE AGENCY's own Total Leads column just mirrors Current
  // QMVA 1:1 in the source sheet, not an independent count).
  function renderAgency() {
    const rows = state.rows['live-agency'].filter(inRange);
    const mediaRows = state.rows['media-spend'].filter(inRange);
    const leadRows = state.rows['agency-leads'].filter(inRange);

    const realAdSpent = mediaRows.reduce((s, r) => s + r.totalSpent, 0);
    const realFee = mediaRows.reduce((s, r) => s + r.agencyFee, 0);
    const realTotalWithFee = mediaRows.reduce((s, r) => s + r.totalWithFee, 0);
    const qmva = rows.reduce((s, r) => s + r.currentQmva, 0);
    const cpqmva = qmva ? realTotalWithFee / qmva : 0;
    const totalLeads = leadRows.reduce((s, r) => s + r.totalLeads, 0);
    const cpl = totalLeads ? realAdSpent / totalLeads : 0;

    $('#agency-kpis').innerHTML = [
      ['AD SPENT', fmtMoney(realAdSpent), true],
      ['AGENCY FEE (35%)', fmtMoney(realFee), true],
      ['AD SPENT + 35% FEE', fmtMoney(realTotalWithFee), true],
      ['CURRENT QMVA', fmtInt(qmva), true],
      ['CPQMVA', fmtMoney(cpqmva), true],
      ['TOTAL LEADS', fmtInt(totalLeads), false],
      ['COST PER LEAD', fmtMoney(cpl), false],
    ].map(([label, value, highlight]) =>
      '<div class="kpi' + (highlight ? ' kpi--highlight' : '') + '">' +
      '<div class="kpi-label">' + label + '</div><div class="kpi-value num">' + value + '</div></div>'
    ).join('');

    renderChartTrio('agency', rows);
    renderLeadsByAd(leadRows);
  }

  // Joins each lead's UTM Term to the Google Ad Spent sheet's Ad ID to show how many leads each
  // ad actually produced and its cost per lead on that specific ad.
  function renderLeadsByAd(leadRows) {
    const el = $('#agency-leads-by-ad');
    if (!el) return;
    const adSpendRows = state.rows['google-ad-spent'].filter(inRange);
    const spendByAdId = new Map();
    adSpendRows.forEach((r) => {
      if (!r.adId) return;
      if (!spendByAdId.has(r.adId)) spendByAdId.set(r.adId, { adName: r.adName, campaignName: r.campaignName, spend: 0 });
      spendByAdId.get(r.adId).spend += r.totalSpent;
    });
    const leadsByAdId = new Map();
    leadRows.forEach((r) => {
      if (!r.utmTerm) return;
      leadsByAdId.set(r.utmTerm, (leadsByAdId.get(r.utmTerm) || 0) + 1);
    });
    const adIds = new Set([...spendByAdId.keys(), ...leadsByAdId.keys()]);
    const combined = Array.from(adIds).map((adId) => {
      const spendInfo = spendByAdId.get(adId);
      const leads = leadsByAdId.get(adId) || 0;
      const spend = spendInfo ? spendInfo.spend : 0;
      return {
        adName: spendInfo ? spendInfo.adName : '(unmatched ad ID)',
        campaignName: spendInfo ? spendInfo.campaignName : '',
        leads, spend, cpl: leads ? spend / leads : 0,
      };
    }).filter((r) => r.leads > 0 || r.spend > 0).sort((a, b) => b.leads - a.leads).slice(0, 30);

    if (!combined.length) { el.innerHTML = '<p style="padding:16px;opacity:0.7">No data for the current filters.</p>'; return; }
    el.innerHTML = '<table><thead><tr><th>Ad Name</th><th>Campaign</th><th class="th-num">Leads</th><th class="th-num">Spend</th><th class="th-num">Cost/Lead</th></tr></thead><tbody>' +
      combined.map((r) =>
        '<tr><td>' + escapeHtml(r.adName) + '</td><td>' + escapeHtml(r.campaignName) + '</td>' +
        '<td class="td-num num">' + fmtInt(r.leads) + '</td><td class="td-num num">' + fmtMoney(r.spend) + '</td>' +
        '<td class="td-num num">' + fmtMoney(r.cpl) + '</td></tr>'
      ).join('') + '</tbody></table>';
  }

  async function loadTrends() {
    const r = await fetch('/walker-api/campaign-trends', { cache: 'no-store' });
    const json = await r.json();
    state.trendsDays = json.days || [];
    renderTrends();
  }
  function renderTrends() {
    const rows = state.trendsDays.filter((d) => {
      const dt = parseDate(d.date.replace(/-/g, '/'));
      if (!dt) return true;
      if (state.range.start && toISO(dt) < state.range.start) return false;
      if (state.range.end && toISO(dt) > state.range.end) return false;
      return true;
    });
    $('#trends-sub').textContent = rows.length + ' days';
    $('#trends-body').innerHTML = rows.slice().reverse().map((d) => {
      const c = d[state.trendsVertical] || d.combined;
      return '<tr><td>' + escapeHtml(d.date) + '</td>' +
        '<td class="td-num num">' + fmtInt(c.totalLeads) + '</td>' +
        '<td class="td-num num">' + fmtInt(c.acceptedLeads) + '</td>' +
        '<td class="td-num num">' + fmtInt(c.qmvaCount) + '</td>' +
        '<td class="td-num num">' + fmtMoney(c.spend) + '</td>' +
        '<td class="td-num num">' + (c.recency != null ? c.recency.toFixed(1) : '—') + '</td></tr>';
    }).join('');

    const metrics = rows.map((d) => d[state.trendsVertical] || d.combined);
    const totalLeads = metrics.reduce((s, c) => s + c.totalLeads, 0);
    const totalAccepted = metrics.reduce((s, c) => s + c.acceptedLeads, 0);
    const totalQmva = metrics.reduce((s, c) => s + c.qmvaCount, 0);
    const totalSpend = metrics.reduce((s, c) => s + c.spend, 0);
    const recencies = metrics.map((c) => c.recency).filter((v) => v != null).sort((a, b) => a - b);
    const medianRecency = recencies.length ? recencies[Math.floor(recencies.length / 2)] : null;
    $('#trends-kpis').innerHTML = [
      ['TOTAL LEADS', fmtInt(totalLeads), false],
      ['ACCEPTED', fmtInt(totalAccepted), false],
      ['QMVA', fmtInt(totalQmva), true],
      ['CONVERSION RATE', totalAccepted ? fmtPct((totalQmva / totalAccepted) * 100) : '0.00%', false],
      ['AD SPEND', fmtMoney(totalSpend), true],
      ['CPQMVA', fmtMoney(totalQmva ? totalSpend / totalQmva : 0), true],
      ['MEDIAN RECENCY (HRS)', medianRecency != null ? medianRecency.toFixed(1) : '—', false],
    ].map(([label, value, highlight]) =>
      '<div class="kpi' + (highlight ? ' kpi--highlight' : '') + '"><div class="kpi-label">' + label + '</div><div class="kpi-value num">' + value + '</div></div>'
    ).join('');

    const byDate = rows.map((d) => ({ date: d.date, c: d[state.trendsVertical] || d.combined }));
    upsertChart('chart-trends', {
      data: {
        labels: byDate.map((g) => g.date),
        datasets: [
          { type: 'bar', label: 'Leads', data: byDate.map((g) => g.c.totalLeads), backgroundColor: PALETTE[0] + '99', yAxisID: 'y' },
          { type: 'line', label: 'QMVA', data: byDate.map((g) => g.c.qmvaCount), borderColor: PALETTE[2], tension: 0.3, pointRadius: 1.5, yAxisID: 'y' },
          { type: 'line', label: 'Ad Spend', data: byDate.map((g) => g.c.spend), borderColor: PALETTE[1], borderDash: [5, 3], tension: 0.3, pointRadius: 1.5, yAxisID: 'y1' },
        ],
      },
      options: chartOptions({ y1: true }),
    });
  }

  async function loadRestored() {
    const [lateRows, restoredRows, corrRes] = await Promise.all([
      fetchTab('late-qmvas'), fetchTab('restored-leads'),
      fetch('/walker-api/late-qmva-correlation', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    state.lateQmvas = lateRows; state.restoredLeads = restoredRows; state.correlation = corrRes.weeks || [];
    renderRestored();
  }
  function renderCorrelationChart() {
    const weeks = state.correlation || [];
    if (!weeks.length) { upsertChart('chart-correlation', { type: 'bar', data: { labels: [], datasets: [] } }); return; }
    upsertChart('chart-correlation', {
      data: {
        labels: weeks.map((w) => w.weekStart),
        datasets: [
          { type: 'bar', label: 'Ad Spend', data: weeks.map((w) => w.spend), backgroundColor: PALETTE[0] + '99', yAxisID: 'y' },
          { type: 'bar', label: 'Late QMVA Revenue', data: weeks.map((w) => w.lateRevenue), backgroundColor: PALETTE[1] + '99', yAxisID: 'y' },
          { type: 'line', label: 'Late QMVA % of Spend', data: weeks.map((w) => w.lateRevenuePctOfSpend), borderColor: PALETTE[4], backgroundColor: PALETTE[4], yAxisID: 'y1', tension: 0.2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false, axis: 'x' },
        plugins: {
          legend: { labels: { color: '#e8ecf4' } },
          tooltip: { callbacks: { label: (ctx) => ctx.dataset.yAxisID === 'y1' ? (ctx.dataset.label + ': ' + (ctx.parsed.y == null ? 'n/a' : ctx.parsed.y.toFixed(1) + '%')) : (ctx.dataset.label + ': ' + fmtMoney(ctx.parsed.y)) } },
        },
        scales: {
          x: { ticks: { color: '#8b96ac' }, grid: { color: '#232d42' } },
          y: { position: 'left', ticks: { color: '#8b96ac', callback: (v) => '$' + Number(v).toLocaleString('en-US') }, grid: { color: '#232d42' } },
          y1: { position: 'right', ticks: { color: '#8b96ac', callback: (v) => v + '%' }, grid: { display: false } },
        },
      },
    });
  }
  const RL_COLUMNS = ['Original Date', 'Call ID', 'Name', 'Campaign', 'Commission', 'Invoice Period', 'Was $0 As Of', 'Converted By', 'Reason'];
  function renderRestored() {
    $('#correlation-pane').hidden = state.restoredSub !== 'correlation';
    $('#restored-late-pane').hidden = state.restoredSub === 'correlation';
    $('#restored-late-kpis').hidden = state.restoredSub === 'correlation';
    $('#restored-late-chart-card').hidden = state.restoredSub === 'correlation';
    if (state.restoredSub === 'correlation') {
      $('#correlation-body').innerHTML = state.correlation.map((w) =>
        '<tr><td>' + escapeHtml(w.weekStart) + '</td>' +
        '<td class="td-num num">' + fmtMoney(w.spend) + '</td>' +
        '<td class="td-num num">' + fmtMoney(w.lateRevenue) + '</td>' +
        '<td class="td-num num">' + (w.lateRevenuePctOfSpend != null ? w.lateRevenuePctOfSpend.toFixed(1) + '%' : '—') + '</td></tr>'
      ).join('');
      renderCorrelationChart();
      return;
    }
    const all = state.restoredSub === 'late' ? state.lateQmvas : state.restoredLeads;
    const rows = all.filter((r) => {
      const d = parsePublisherDate(r['Original Date']);
      if (!d) return true;
      if (state.range.start && toISO(d) < state.range.start) return false;
      if (state.range.end && toISO(d) > state.range.end) return false;
      return true;
    });
    $('#restored-late-head').innerHTML = '<tr>' + RL_COLUMNS.map((c) => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr>';
    $('#restored-late-body').innerHTML = rows.map((r) =>
      '<tr>' + RL_COLUMNS.map((c) => '<td>' + escapeHtml(r[c] || '') + '</td>').join('') + '</tr>'
    ).join('');

    const commission = (r) => Number(String(r['Commission'] || '0').replace(/[$,]/g, '')) || 0;
    const total = rows.reduce((s, r) => s + commission(r), 0);
    const avg = rows.length ? total / rows.length : 0;
    $('#restored-late-kpis').innerHTML = [
      [state.restoredSub === 'late' ? 'LATE QMVAS' : 'RESTORED LEADS', fmtInt(rows.length), true],
      ['TOTAL COMMISSION', fmtMoney(total), true],
      ['AVG COMMISSION', fmtMoney(avg), false],
    ].map(([label, value, highlight]) =>
      '<div class="kpi' + (highlight ? ' kpi--highlight' : '') + '"><div class="kpi-label">' + label + '</div><div class="kpi-value num">' + value + '</div></div>'
    ).join('');
    $('#restored-late-chart-title').textContent = (state.restoredSub === 'late' ? 'Late QMVA' : 'Restored Lead') + ' Commission by Date';

    const byDate = new Map();
    rows.forEach((r) => {
      const d = parsePublisherDate(r['Original Date']);
      if (!d) return;
      const key = toISO(d);
      if (!byDate.has(key)) byDate.set(key, { date: d, count: 0, commission: 0 });
      const g = byDate.get(key);
      g.count += 1;
      g.commission += commission(r);
    });
    const sorted = Array.from(byDate.values()).sort((a, b) => a.date - b.date);
    upsertChart('chart-restored-late', {
      data: {
        labels: sorted.map((g) => g.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
        datasets: [
          { type: 'bar', label: 'Commission', data: sorted.map((g) => g.commission), backgroundColor: PALETTE[1] + '99', yAxisID: 'y1' },
          { type: 'line', label: 'Count', data: sorted.map((g) => g.count), borderColor: PALETTE[0], tension: 0.3, pointRadius: 1.5, yAxisID: 'y' },
        ],
      },
      options: chartOptions({ y1: true }),
    });
  }

  // ---- Hourly Performance: static export, not live (same as the original app — its own two
  // source files, posted-to-qualified-raw.json and hourly-performance-raw.json, are one-time
  // Domo/sheet exports with no live refresh; re-export and overwrite the JSON files to update) ----
  function pct1(n) { return (n * 100).toFixed(1) + '%'; }
  function median(sorted) {
    const n = sorted.length;
    if (!n) return 0;
    const mid = Math.floor(n / 2);
    return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  function fmtHours(h) {
    if (h == null) return '—';
    if (h < 1) return Math.round(h * 60) + 'm';
    if (h < 24) return h.toFixed(1) + 'h';
    const totalHours = Math.round(h);
    const days = Math.floor(totalHours / 24), remHours = totalHours % 24;
    return remHours ? days + 'd ' + remHours + 'h' : days + 'd';
  }
  function fmtHour(h) { const hh = ((h + 11) % 12) + 1; return hh + (h < 12 ? 'am' : 'pm'); }

  function computePostedRows(leads, bucketLabels) {
    const buckets = Array.from({ length: 6 }, () => ({ weblead: 0, inbound: 0, hours: [] }));
    leads.forEach(([, channel, bucket, hours]) => {
      if (channel === 0) buckets[bucket].weblead += 1; else buckets[bucket].inbound += 1;
      buckets[bucket].hours.push(hours);
    });
    const totalWeblead = buckets.reduce((s, b) => s + b.weblead, 0);
    const totalInbound = buckets.reduce((s, b) => s + b.inbound, 0);
    const totalAll = totalWeblead + totalInbound;
    const allHours = buckets.flatMap((b) => b.hours).sort((a, b) => a - b);
    return {
      rows: buckets.map((b, i) => {
        const sorted = [...b.hours].sort((a, b) => a - b);
        const n = sorted.length;
        return {
          label: bucketLabels[i],
          weblead: b.weblead, webleadPct: totalWeblead ? b.weblead / totalWeblead : 0,
          inbound: b.inbound, inboundPct: totalInbound ? b.inbound / totalInbound : 0,
          all: b.weblead + b.inbound, allPct: totalAll ? (b.weblead + b.inbound) / totalAll : 0,
          avgHours: n ? sorted.reduce((s, v) => s + v, 0) / n : null,
          medianHours: n ? median(sorted) : null,
          minHours: n ? sorted[0] : null,
          maxHours: n ? sorted[n - 1] : null,
        };
      }),
      total: {
        weblead: totalWeblead, inbound: totalInbound, all: totalAll,
        avgHours: allHours.length ? allHours.reduce((s, v) => s + v, 0) / allHours.length : null,
        medianHours: allHours.length ? median(allHours) : null,
        minHours: allHours.length ? allHours[0] : null,
        maxHours: allHours.length ? allHours[allHours.length - 1] : null,
      },
    };
  }
  function renderPostedTable(computed) {
    const bodyRows = computed.rows.map((r) =>
      '<tr><td>' + escapeHtml(r.label) + '</td><td class="td-num num">' + fmtInt(r.weblead) + '</td><td class="td-num num">' + pct1(r.webleadPct) + '</td>' +
      '<td class="td-num num">' + fmtInt(r.inbound) + '</td><td class="td-num num">' + pct1(r.inboundPct) + '</td>' +
      '<td class="td-num num">' + fmtInt(r.all) + '</td><td class="td-num num">' + pct1(r.allPct) + '</td>' +
      '<td class="td-num num">' + fmtHours(r.avgHours) + '</td><td class="td-num num">' + fmtHours(r.medianHours) + '</td>' +
      '<td class="td-num num">' + fmtHours(r.minHours) + '</td><td class="td-num num">' + fmtHours(r.maxHours) + '</td></tr>'
    ).join('');
    const t = computed.total;
    $('#posted-table').innerHTML =
      '<thead><tr><th>Days from posted</th><th class="th-num">Weblead</th><th class="th-num">% of Weblead</th>' +
      '<th class="th-num">Inbound</th><th class="th-num">% of Inbound</th><th class="th-num">All channels</th><th class="th-num">% of All</th>' +
      '<th class="th-num">Avg hrs</th><th class="th-num">Median hrs</th><th class="th-num">Fastest</th><th class="th-num">Slowest</th></tr></thead>' +
      '<tbody>' + bodyRows +
      '<tr class="row-total"><td>Total measurable</td><td class="td-num num">' + fmtInt(t.weblead) + '</td><td class="td-num num">100.0%</td>' +
      '<td class="td-num num">' + fmtInt(t.inbound) + '</td><td class="td-num num">100.0%</td><td class="td-num num">' + fmtInt(t.all) + '</td><td class="td-num num">100.0%</td>' +
      '<td class="td-num num">' + fmtHours(t.avgHours) + '</td><td class="td-num num">' + fmtHours(t.medianHours) + '</td>' +
      '<td class="td-num num">' + fmtHours(t.minHours) + '</td><td class="td-num num">' + fmtHours(t.maxHours) + '</td></tr></tbody>';
  }

  function computeHourlyRows(cells) {
    const byHour = Array.from({ length: 24 }, () => ({ caSpend: 0, caQmva: 0, caRevenue: 0, nwSpend: 0, nwQmva: 0, nwRevenue: 0 }));
    cells.forEach(([, hour, caSpend, caQmva, caRevenue, nwSpend, nwQmva, nwRevenue]) => {
      const b = byHour[hour];
      b.caSpend += caSpend; b.caQmva += caQmva; b.caRevenue += caRevenue;
      b.nwSpend += nwSpend; b.nwQmva += nwQmva; b.nwRevenue += nwRevenue;
    });
    return byHour.map((b, hour) => ({
      hour, caSpend: b.caSpend, caQmva: b.caQmva, caCostPerQmva: b.caQmva ? b.caSpend / b.caQmva : 0,
      caRevenue: b.caRevenue, caProfit: b.caRevenue - b.caSpend,
      nwSpend: b.nwSpend, nwQmva: b.nwQmva, nwCostPerQmva: b.nwQmva ? b.nwSpend / b.nwQmva : 0,
      nwRevenue: b.nwRevenue, nwProfit: b.nwRevenue - b.nwSpend,
    }));
  }
  function renderHourlyTable(rows) {
    const bodyRows = rows.map((r) =>
      '<tr><td>' + fmtHour(r.hour) + '</td>' +
      '<td class="td-num num">' + fmtMoney(r.caSpend) + '</td><td class="td-num num">' + fmtInt(r.caQmva) + '</td>' +
      '<td class="td-num num">' + fmtMoney(r.caCostPerQmva) + '</td><td class="td-num num">' + fmtMoney(r.caRevenue) + '</td>' +
      '<td class="td-num num ' + (r.caProfit < 0 ? 'compare-down' : 'compare-up') + '">' + fmtMoney(r.caProfit) + '</td>' +
      '<td class="td-num num">' + fmtMoney(r.nwSpend) + '</td><td class="td-num num">' + fmtInt(r.nwQmva) + '</td>' +
      '<td class="td-num num">' + fmtMoney(r.nwCostPerQmva) + '</td><td class="td-num num">' + fmtMoney(r.nwRevenue) + '</td>' +
      '<td class="td-num num ' + (r.nwProfit < 0 ? 'compare-down' : 'compare-up') + '">' + fmtMoney(r.nwProfit) + '</td></tr>'
    ).join('');
    $('#hourly-table').innerHTML =
      '<thead><tr><th>Hour</th><th class="th-num">CA Spend</th><th class="th-num">CA QMVA</th><th class="th-num">CA Cost/QMVA</th><th class="th-num">CA Revenue</th><th class="th-num">CA Profit</th>' +
      '<th class="th-num">NW Spend</th><th class="th-num">NW QMVA</th><th class="th-num">NW Cost/QMVA</th><th class="th-num">NW Revenue</th><th class="th-num">NW Profit</th></tr></thead>' +
      '<tbody>' + bodyRows + '</tbody>';
  }
  function renderHourlyChart(rows) {
    const labels = rows.map((r) => fmtHour(r.hour));
    upsertChart('chart-hourly', {
      data: { labels, datasets: [
        { type: 'line', label: 'CA QMVA', data: rows.map((r) => r.caQmva), borderColor: PALETTE[0], tension: 0.35, pointRadius: 2, yAxisID: 'y' },
        { type: 'line', label: 'CA Spend', data: rows.map((r) => r.caSpend), borderColor: PALETTE[1], borderDash: [5, 3], tension: 0.35, pointRadius: 2, yAxisID: 'y1' },
        { type: 'line', label: 'NW QMVA', data: rows.map((r) => r.nwQmva), borderColor: PALETTE[2], tension: 0.35, pointRadius: 2, yAxisID: 'y' },
        { type: 'line', label: 'NW Spend', data: rows.map((r) => r.nwSpend), borderColor: PALETTE[3], borderDash: [5, 3], tension: 0.35, pointRadius: 2, yAxisID: 'y1' },
      ] },
      options: chartOptions({ y1: true }),
    });
  }

  async function loadHourly() {
    const [postedRes, hourlyRes] = await Promise.all([
      fetch('posted-to-qualified-raw.json', { cache: 'no-store' }).then((r) => r.json()),
      fetch('hourly-performance-raw.json', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    state.posted = postedRes;
    state.hourly = hourlyRes;
    renderHourly();
  }

  // ---- Hourly Performance: Lead Detail pane ----
  let hourlyLeadDetailCache = null;
  let hourlyInnerTab = 'summary';
  let hourlyDetailDateField = 'posted'; // 'posted' | 'converted'
  let hourlyDetailGroup = 'all'; // 'all' | 'nwa' | 'nwaib' | 'agency'
  let hourlyDetailDqFilter = 'nondq'; // 'nondq' | 'dq' | 'all'
  function campaignGroup(c) {
    if (/NWA/i.test(c) && /IB/i.test(c)) return 'nwaib';
    if (/NWA/i.test(c)) return 'nwa';
    if (/WAGENCY|AGENCY/i.test(c)) return 'agency';
    return 'other';
  }
  // Render's free tier can take ~30s to wake from a cold start, and this is a 1.2MB file —
  // without a timeout, a stalled request leaves the pane stuck on "Loading leads…" forever.
  async function loadHourlyLeadDetail() {
    if (hourlyLeadDetailCache) return hourlyLeadDetailCache;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch('hourly-lead-detail.json', { signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      hourlyLeadDetailCache = await res.json();
      return hourlyLeadDetailCache;
    } finally {
      clearTimeout(timeout);
    }
  }
  function setHourlyInnerTab(tab) {
    hourlyInnerTab = tab;
    document.querySelectorAll('#hourly-inner-tabs .chip').forEach((b) => b.classList.toggle('is-active', b.dataset.innertab === tab));
    $('#hourly-summary-pane').style.display = tab === 'summary' ? '' : 'none';
    $('#hourly-detail-pane').style.display = tab === 'detail' ? '' : 'none';
    if (tab === 'detail') renderHourlyDetailPane();
  }
  async function renderHourlyDetailPane() {
    const head = $('#hourly-detail-head');
    const table = $('#hourly-detail-table');
    head.textContent = 'Loading leads…';
    table.innerHTML = '';
    let leads;
    try {
      leads = await loadHourlyLeadDetail();
    } catch (err) {
      head.textContent = '';
      table.innerHTML = '<tbody><tr><td style="padding:8px 10px;opacity:0.7">Failed to load lead detail (' + escapeHtml(err.name === 'AbortError' ? 'timed out — the server may be waking up' : err.message) + ').</td></tr></tbody>';
      return;
    }
    const range = state.range.start && state.range.end ? { from: state.range.start, to: state.range.end } : null;
    const byConverted = hourlyDetailDateField === 'converted';
    const filtered = leads
      .filter((l) => {
        if (hourlyDetailDqFilter === 'nondq' && l.dq === 'DQ') return false;
        if (hourlyDetailGroup !== 'all' && campaignGroup(l.campaign) !== hourlyDetailGroup) return false;
        if (hourlyDetailDqFilter === 'dq' && l.dq !== 'DQ') return false;
        if (!range) return true;
        const d = byConverted ? l.convertedDate : l.date;
        return d && d >= range.from && d <= range.to;
      })
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    const fieldLabel = byConverted ? 'converted' : 'posted';
    head.textContent = filtered.length + ' lead' + (filtered.length === 1 ? '' : 's') + (range ? ' ' + fieldLabel + ' from ' + range.from + ' to ' + range.to : '');
    if (!filtered.length) {
      table.innerHTML = '';
      head.textContent += ' — none match this filter.';
      return;
    }
    const MAX_ROWS = 500;
    const shown = filtered.slice(0, MAX_ROWS);
    const rows = shown.map((l) =>
      '<tr><td>' + escapeHtml(l.date) + ' ' + escapeHtml(l.time) + '</td>' +
      '<td>' + (l.convertedDate ? escapeHtml(l.convertedDate) + ' ' + escapeHtml(l.convertedTime) : '—') + '</td>' +
      '<td class="td-num num">' + fmtHours(l.hoursToConvert) + '</td>' +
      '<td>' + escapeHtml((l.vertical || '').toUpperCase()) + '</td>' +
      '<td>' + escapeHtml(l.campaign) + '</td>' +
      '<td>' + escapeHtml(l.channel) + '</td>' +
      '<td>' + escapeHtml(l.state) + '</td>' +
      '<td>' + escapeHtml(l.lawType) + '</td>' +
      '<td>' + escapeHtml(l.dq) + '</td>' +
      '<td>' + escapeHtml(l.name || '—') + '</td>' +
      '<td class="td-num num" title="' + escapeHtml(l.revenueNote || '') + '">' + fmtMoney(l.revenue) + (l.revenueNote ? ' ⚠️' : '') + '</td></tr>'
    ).join('');
    const truncNote = filtered.length > MAX_ROWS ? '<tr><td colspan="11" style="padding:8px 0;opacity:0.7">Showing the most recent ' + MAX_ROWS + ' of ' + filtered.length.toLocaleString() + ' — narrow the date range to see more.</td></tr>' : '';
    table.innerHTML =
      '<thead><tr><th>Posted</th><th>Converted</th><th class="th-num">Hrs to convert</th><th>Vertical</th><th>Campaign</th><th>Channel</th><th>State</th><th>Law Type</th><th>DQ</th><th>Name</th><th class="th-num">Revenue</th></tr></thead>' +
      '<tbody>' + rows + truncNote + '</tbody>';
  }
  function renderHourly() {
    const posted = state.posted, hourly = state.hourly;
    if (!posted || !hourly) return;
    const from = state.range.start || posted.minDate, to = state.range.end || posted.maxDate;
    const pFrom = from < posted.minDate ? posted.minDate : from, pTo = to > posted.maxDate ? posted.maxDate : to;
    if (pTo < posted.minDate || pFrom > posted.maxDate) {
      renderPostedTable(computePostedRows([], posted.bucketLabels));
      $('#posted-note').textContent = 'No data — this export only covers leads posted ' + posted.minDate + ' to ' + posted.maxDate + '.';
    } else {
      renderPostedTable(computePostedRows(posted.leads.filter((l) => l[0] >= pFrom && l[0] <= pTo), posted.bucketLabels));
      $('#posted-note').textContent = (pFrom === posted.minDate && pTo === posted.maxDate)
        ? 'Data covers leads posted ' + posted.minDate + ' to ' + posted.maxDate + ' — not live.'
        : 'Showing leads posted ' + pFrom + ' to ' + pTo + ' (export covers ' + posted.minDate + ' to ' + posted.maxDate + ') — not live.';
    }
    const hFrom = from < hourly.minDate ? hourly.minDate : from, hTo = to > hourly.maxDate ? hourly.maxDate : to;
    if (hTo < hourly.minDate || hFrom > hourly.maxDate) {
      renderHourlyTable(computeHourlyRows([]));
      renderHourlyChart(computeHourlyRows([]));
      $('#hourly-note').textContent = 'No data — this table only covers ' + hourly.minDate + ' to ' + hourly.maxDate + '. Pick a date in that window to see numbers.';
    } else {
      const rows = computeHourlyRows(hourly.cells.filter((c) => c[0] >= hFrom && c[0] <= hTo));
      renderHourlyTable(rows);
      renderHourlyChart(rows);
      $('#hourly-note').textContent = (hFrom === hourly.minDate && hTo === hourly.maxDate)
        ? 'Showing the full export: ' + hourly.minDate + ' to ' + hourly.maxDate + ' — not live.'
        : 'Showing ' + hFrom + ' to ' + hTo + ' (export covers ' + hourly.minDate + ' to ' + hourly.maxDate + ') — not live.';
    }
    if (hourlyInnerTab === 'detail') renderHourlyDetailPane();
  }

  $('#hourly-inner-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    setHourlyInnerTab(btn.dataset.innertab);
  });
  document.querySelectorAll('input[name="hourlyDetailDateField"]').forEach((radio) => {
    radio.addEventListener('change', () => { hourlyDetailDateField = radio.value; renderHourlyDetailPane(); });
  });
  document.querySelectorAll('input[name="hourlyDetailGroup"]').forEach((radio) => {
    radio.addEventListener('change', () => { hourlyDetailGroup = radio.value; renderHourlyDetailPane(); });
  });
  document.querySelectorAll('input[name="hourlyDetailDq"]').forEach((radio) => {
    radio.addEventListener('change', () => { hourlyDetailDqFilter = radio.value; renderHourlyDetailPane(); });
  });

  // ---- section switching ----
  async function showSection(name) {
    state.section = name;
    document.querySelectorAll('#walker-tabs .segment-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.section === name));
    document.querySelectorAll('.walker-section').forEach((s) => s.classList.toggle('is-active', s.id === 'section-' + name));
    if (!state.loadedSections.has(name)) {
      state.loadedSections.add(name);
      if (name === 'global') await loadGlobal();
      else if (name === 'nwca') await loadNwCa();
      else if (name === 'agency') await loadAgency();
      else if (name === 'trends') await loadTrends();
      else if (name === 'restored') await loadRestored();
      else if (name === 'hourly') await loadHourly();
    } else {
      if (name === 'global') renderGlobal();
      else if (name === 'nwca') renderNwCa();
      else if (name === 'agency') renderAgency();
      else if (name === 'trends') renderTrends();
      else if (name === 'restored') renderRestored();
      else if (name === 'hourly') renderHourly();
    }
  }

  function renderAll() {
    // Re-render whichever section is visible (and drop cached loads for the rest so the next
    // tab switch re-fetches with the new date range).
    state.loadedSections.clear();
    state.loadedSections.add(state.section);
    if (state.section === 'global') renderGlobal();
    else if (state.section === 'nwca') renderNwCa();
    else if (state.section === 'agency') renderAgency();
    else if (state.section === 'trends') renderTrends();
    else if (state.section === 'restored') renderRestored();
    else if (state.section === 'hourly') renderHourly();
  }

  $('#walker-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.segment-tab');
    if (!btn) return;
    showSection(btn.dataset.section);
  });
  $('#restored-inner-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    document.querySelectorAll('#restored-inner-tabs .chip').forEach((b) => b.classList.toggle('is-active', b === btn));
    state.restoredSub = btn.dataset.rl;
    renderRestored();
  });
  $('#trends-vertical-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    document.querySelectorAll('#trends-vertical-tabs .chip').forEach((b) => b.classList.toggle('is-active', b === btn));
    state.trendsVertical = btn.dataset.trendsVertical;
    renderTrends();
  });
  $('#lead-search').addEventListener('input', renderLeadDetail);

  $('#quick-range').addEventListener('change', (e) => {
    const { start, end } = computeRange(e.target.value);
    state.range = { start, end };
    $('#range-start').value = start || '';
    $('#range-end').value = end || '';
    renderAll();
  });
  function applyCustomRange() {
    const start = $('#range-start').value || null, end = $('#range-end').value || null;
    if (!start && !end) return;
    state.range = { start, end };
    $('#quick-range').value = '';
    renderAll();
  }
  $('#range-start').addEventListener('change', applyCustomRange);
  $('#range-end').addEventListener('change', applyCustomRange);
  $('#range-clear').addEventListener('click', () => {
    const key = $('#quick-range').value;
    const { start, end } = computeRange(key);
    state.range = { start, end };
    $('#range-start').value = start || '';
    $('#range-end').value = end || '';
    renderAll();
  });
  $('#refresh-btn').addEventListener('click', () => {
    $('#refresh-btn').classList.add('is-spinning');
    state.loadedSections.delete(state.section);
    showSection(state.section).finally(() => setTimeout(() => $('#refresh-btn').classList.remove('is-spinning'), 400));
  });

  // Walker's own data floor (per the source dashboard's month-option generator) is August 2026 —
  // but Global PPL's history goes back further (the "WALKER - AGENCY PROFIT DASHBOARD" workbook),
  // so default to January 2026 same as Sasooness/KM's floor for consistency across the site.
  const defaultKey = buildQuickRangeOptions(2026, 1);
  const initial = computeRange(defaultKey);
  state.range = initial;
  $('#quick-range').value = defaultKey;
  $('#range-start').value = initial.start || '';
  $('#range-end').value = initial.end || '';

  showSection('global');
  setInterval(() => { state.loadedSections.delete(state.section); showSection(state.section); }, 60000);
})();

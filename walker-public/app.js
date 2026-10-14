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
    rows: { 'ca-nw': [], nw: [], ca: [], 'live-agency': [] },
    leadDetail: [],
    trendsDays: [],
    lateQmvas: [], restoredLeads: [], correlation: [],
    restoredSub: 'late',
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
  function inRange(row) {
    const d = parseDate(row.date);
    if (!d) return false;
    if (state.range.start && toISO(d) < state.range.start) return false;
    if (state.range.end && toISO(d) > state.range.end) return false;
    return true;
  }
  function computeKPIs(rows) {
    const totalLeads = rows.reduce((s, r) => s + r.totalLeads, 0);
    const correction = adSpendCorrectionTotal(rows);
    const totalSpent = rows.reduce((s, r) => s + r.totalSpent, 0) - correction;
    const revenue = rows.reduce((s, r) => s + r.revenue, 0);
    const profit = rows.reduce((s, r) => s + r.profit, 0) + correction;
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
  function renderKpiRow(elId, rows) {
    const k = computeKPIs(rows);
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
    renderKpiRow('global-kpis', rows);
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
    renderKpiRow('nw-kpis', nwRows);
    renderKpiRow('ca-kpis', caRows);
    const nwByState = groupByState(nwRows);
    upsertChart('chart-nw-state', { type: 'doughnut', data: { labels: nwByState.map((g) => g.label), datasets: [{ data: nwByState.map((g) => g.value), backgroundColor: nwByState.map((_, i) => PALETTE[i % PALETTE.length]) }] }, options: { plugins: { legend: { position: 'right', labels: { color: '#e8ecf4' } } } } });
    const caByState = groupByState(caRows);
    upsertChart('chart-ca-state', { type: 'doughnut', data: { labels: caByState.map((g) => g.label), datasets: [{ data: caByState.map((g) => g.value), backgroundColor: caByState.map((_, i) => PALETTE[i % PALETTE.length]) }] }, options: { plugins: { legend: { position: 'right', labels: { color: '#e8ecf4' } } } } });
    renderOverTimeChart('chart-nw-overtime', nwRows);
    renderOverTimeChart('chart-ca-overtime', caRows);
  }

  async function loadAgency() {
    const rows = await fetchTab('live-agency');
    state.rows['live-agency'] = rows;
    renderAgency();
  }
  function renderAgency() {
    const rows = state.rows['live-agency'].filter(inRange);
    renderKpiRow('agency-kpis', rows);
    renderChartTrio('agency', rows);
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
      const c = d.combined;
      return '<tr><td>' + escapeHtml(d.date) + '</td>' +
        '<td class="td-num num">' + fmtInt(c.totalLeads) + '</td>' +
        '<td class="td-num num">' + fmtInt(c.acceptedLeads) + '</td>' +
        '<td class="td-num num">' + fmtInt(c.qmvaCount) + '</td>' +
        '<td class="td-num num">' + fmtMoney(c.spend) + '</td>' +
        '<td class="td-num num">' + (c.recency != null ? c.recency.toFixed(1) : '—') + '</td></tr>';
    }).join('');
  }

  async function loadRestored() {
    const [lateRows, restoredRows, corrRes] = await Promise.all([
      fetchTab('late-qmvas'), fetchTab('restored-leads'),
      fetch('/walker-api/late-qmva-correlation', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    state.lateQmvas = lateRows; state.restoredLeads = restoredRows; state.correlation = corrRes.weeks || [];
    renderRestored();
  }
  const RL_COLUMNS = ['Original Date', 'Call ID', 'Name', 'Campaign', 'Commission', 'Invoice Period', 'Was $0 As Of', 'Converted By', 'Reason'];
  function renderRestored() {
    $('#correlation-pane').hidden = state.restoredSub !== 'correlation';
    $('#restored-late-pane').hidden = state.restoredSub === 'correlation';
    if (state.restoredSub === 'correlation') {
      $('#correlation-body').innerHTML = state.correlation.map((w) =>
        '<tr><td>' + escapeHtml(w.weekStart) + '</td>' +
        '<td class="td-num num">' + fmtMoney(w.spend) + '</td>' +
        '<td class="td-num num">' + fmtMoney(w.lateRevenue) + '</td>' +
        '<td class="td-num num">' + (w.lateRevenuePctOfSpend != null ? w.lateRevenuePctOfSpend.toFixed(1) + '%' : '—') + '</td></tr>'
      ).join('');
      return;
    }
    const rows = state.restoredSub === 'late' ? state.lateQmvas : state.restoredLeads;
    $('#restored-late-head').innerHTML = '<tr>' + RL_COLUMNS.map((c) => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr>';
    $('#restored-late-body').innerHTML = rows.map((r) =>
      '<tr>' + RL_COLUMNS.map((c) => '<td>' + escapeHtml(r[c] || '') + '</td>').join('') + '</tr>'
    ).join('');
  }

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
    } else {
      if (name === 'global') renderGlobal();
      else if (name === 'nwca') renderNwCa();
      else if (name === 'agency') renderAgency();
      else if (name === 'trends') renderTrends();
      else if (name === 'restored') renderRestored();
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

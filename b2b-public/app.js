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
      case 'wtd': return { start: toISO(mondayOf(today)), end: toISO(addDays(today, -1)) };
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

  function fmtMoney(n) { const sign = n < 0 ? '-' : ''; return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const state = { range: { start: null, end: null }, leads: [], leadsDaily: [], adSpendDaily: [], adSpendByAd: [] };

  function inRange(dateStr) {
    if (state.range.start && dateStr < state.range.start) return false;
    if (state.range.end && dateStr > state.range.end) return false;
    return true;
  }

  const PALETTE = ['#7ea6f7', '#e0a92d', '#4dd6a0', '#b48af0', '#f06c9b'];
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

  async function fetchData() {
    const r = await fetch('/b2b-api/data', { cache: 'no-store' });
    const json = await r.json();
    state.leads = json.leads || [];
    state.leadsDaily = json.leadsDaily || [];
    state.adSpendDaily = json.adSpendDaily || [];
    state.adSpendByAdName = json.adSpendByAdName || [];
    renderAll();
  }

  function renderAll() {
    const leads = state.leads.filter((l) => inRange(l.date));
    const leadsByDate = new Map();
    leads.forEach((l) => leadsByDate.set(l.date, (leadsByDate.get(l.date) || 0) + 1));
    const spendByDate = new Map();
    state.adSpendDaily.filter((d) => inRange(d.date)).forEach((d) => spendByDate.set(d.date, (spendByDate.get(d.date) || 0) + d.spend));

    const dates = [...new Set([...leadsByDate.keys(), ...spendByDate.keys()])].sort();
    const totalLeads = leads.length;
    const totalSpend = [...spendByDate.values()].reduce((s, v) => s + v, 0);
    const cpl = totalLeads ? totalSpend / totalLeads : 0;

    $('#b2b-kpis').innerHTML = [
      ['TOTAL B2B LEADS', fmtInt(totalLeads), true],
      ['TOTAL AD SPEND', fmtMoney(totalSpend), true],
      ['COST PER LEAD', fmtMoney(cpl), true],
      ['DAYS SHOWN', fmtInt(dates.length), false],
    ].map(([label, value, highlight]) =>
      '<div class="kpi' + (highlight ? ' kpi--highlight' : '') + '"><div class="kpi-label">' + label + '</div><div class="kpi-value num">' + value + '</div></div>'
    ).join('');

    upsertChart('chart-b2b-bydate', {
      data: {
        labels: dates,
        datasets: [
          { type: 'bar', label: 'Leads', data: dates.map((d) => leadsByDate.get(d) || 0), backgroundColor: PALETTE[0] + '99', yAxisID: 'y' },
          { type: 'line', label: 'Ad Spend', data: dates.map((d) => spendByDate.get(d) || 0), borderColor: PALETTE[1], tension: 0.3, pointRadius: 1.5, yAxisID: 'y1' },
        ],
      },
      options: chartOptions({ y1: true }),
    });

    $('#b2b-daily-sub').textContent = dates.length + ' days';
    $('#b2b-daily-body').innerHTML = dates.slice().reverse().map((d) => {
      const dayLeads = leadsByDate.get(d) || 0;
      const daySpend = spendByDate.get(d) || 0;
      const dayCpl = dayLeads ? daySpend / dayLeads : 0;
      return '<tr><td>' + escapeHtml(d) + '</td>' +
        '<td class="td-num num">' + fmtInt(dayLeads) + '</td>' +
        '<td class="td-num num">' + fmtMoney(daySpend) + '</td>' +
        '<td class="td-num num">' + (dayLeads ? fmtMoney(dayCpl) : '—') + '</td></tr>';
    }).join('');

    renderLeadsByAd(leads);
    renderLeadDetail();
  }

  // Joined by ad NAME (UTM Content <-> Meta's Ad Name) — UTM Term never matches a real Ad ID for
  // B2B leads (see b2b.js), so name is the only attribution path that actually works.
  function renderLeadsByAd(leads) {
    const el = $('#b2b-leads-by-ad');
    const spendByName = new Map(state.adSpendByAdName.map((r) => [r.adName, r.spend]));
    const leadsByName = new Map();
    leads.forEach((l) => { if (l.utmContent) leadsByName.set(l.utmContent, (leadsByName.get(l.utmContent) || 0) + 1); });
    const names = new Set([...spendByName.keys(), ...leadsByName.keys()]);
    const combined = Array.from(names).map((adName) => {
      const leadsN = leadsByName.get(adName) || 0;
      const spend = spendByName.get(adName) || 0;
      return { adName, leads: leadsN, spend, cpl: leadsN ? spend / leadsN : 0 };
    }).filter((r) => r.leads > 0 || r.spend > 0).sort((a, b) => b.leads - a.leads).slice(0, 30);

    if (!combined.length) { el.innerHTML = '<p style="padding:16px;opacity:0.7">No data for the current filters.</p>'; return; }
    el.innerHTML = '<table><thead><tr><th>Ad Name</th><th class="th-num">Leads</th><th class="th-num">Spend</th><th class="th-num">Cost/Lead</th></tr></thead><tbody>' +
      combined.map((r) =>
        '<tr><td>' + escapeHtml(r.adName) + '</td>' +
        '<td class="td-num num">' + fmtInt(r.leads) + '</td><td class="td-num num">' + fmtMoney(r.spend) + '</td>' +
        '<td class="td-num num">' + (r.leads ? fmtMoney(r.cpl) : '—') + '</td></tr>'
      ).join('') + '</tbody></table>';
  }

  function renderLeadDetail() {
    const filtered = state.leads.filter((l) => inRange(l.date)).sort((a, b) => (a.date < b.date ? 1 : -1));
    const term = ($('#lead-search').value || '').trim().toLowerCase();
    const searched = term ? filtered.filter((l) => [l.name, l.firmName, l.state, l.source, l.utmContent, l.stage, l.status].join(' ').toLowerCase().includes(term)) : filtered;
    $('#lead-count').textContent = searched.length.toLocaleString() + ' leads' + (term ? ' (filtered from ' + filtered.length.toLocaleString() + ')' : '');
    const shown = searched.slice(0, 500);
    $('#lead-detail-body').innerHTML = shown.map((l) =>
      '<tr><td>' + escapeHtml(l.date) + '</td>' +
      '<td>' + escapeHtml(l.name) + '</td>' +
      '<td>' + escapeHtml(l.firmName) + '</td>' +
      '<td>' + escapeHtml(l.state) + '</td>' +
      '<td>' + escapeHtml(l.source) + '</td>' +
      '<td>' + escapeHtml(l.utmContent) + '</td>' +
      '<td>' + escapeHtml(l.stage) + '</td>' +
      '<td>' + escapeHtml(l.status) + '</td></tr>'
    ).join('');
  }

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
    fetchData().finally(() => setTimeout(() => $('#refresh-btn').classList.remove('is-spinning'), 400));
  });

  const defaultKey = buildQuickRangeOptions(2026, 1);
  const initial = computeRange(defaultKey);
  state.range = initial;
  $('#quick-range').value = defaultKey;
  $('#range-start').value = initial.start || '';
  $('#range-end').value = initial.end || '';

  fetchData();
  setInterval(fetchData, 60000);
})();

(function () {
  const $ = (sel) => document.querySelector(sel);

  // ---- date helpers (same math as every other dashboard here) ----
  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(d, n) { const nd = new Date(d); nd.setDate(nd.getDate() + n); return nd; }
  function startOfMonth(y, m) { return new Date(y, m - 1, 1); }
  function endOfMonth(y, m) { return new Date(y, m, 0); }
  function mondayOf(d) { const day = d.getDay(); const diff = day === 0 ? -6 : 1 - day; return addDays(d, diff); }
  function weekLabel(monday) {
    const sunday = addDays(monday, 6);
    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return fmt(monday) + ' - ' + fmt(sunday);
  }
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

  const state = {
    range: { start: null, end: null }, leads: [], leadsDaily: [], adSpendDaily: [], adSpendByAd: [],
    weeklyMetrics: new Set(['Total Leads', 'Total Ad Spend']),
  };

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
    state.adSpendByAdNameDaily = json.adSpendByAdNameDaily || [];
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

    renderWeekly(leadsByDate, spendByDate);
    renderLeadsByAd(leads);
    renderLeadDetail();
  }

  // ---- heatmap coloring for the Weekly Breakdown table (same red-to-green scale used on the
  // Walker Data Analysis Weekly Breakdown) ----
  function heatColor(t) {
    t = Math.max(0, Math.min(1, t));
    const stops = [[224, 102, 102], [255, 217, 102], [87, 187, 138]]; // red -> yellow -> green
    const seg = t < 0.5 ? 0 : 1;
    const localT = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const a = stops[seg], b = stops[seg + 1];
    const r = Math.round(a[0] + (b[0] - a[0]) * localT);
    const g = Math.round(a[1] + (b[1] - a[1]) * localT);
    const bl = Math.round(a[2] + (b[2] - a[2]) * localT);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }
  function heatRowColors(values, direction) {
    if (!direction) return values.map(() => null);
    const nums = values.filter((v) => v != null && isFinite(v));
    if (nums.length < 2) return values.map(() => null);
    const min = Math.min(...nums), max = Math.max(...nums);
    if (max === min) return values.map(() => null);
    return values.map((v) => {
      if (v == null || !isFinite(v)) return null;
      let t = (v - min) / (max - min);
      if (direction === 'down') t = 1 - t;
      return heatColor(t);
    });
  }

  const WEEKLY_MONEY_METRICS = new Set(['Total Ad Spend', 'Cost Per Lead']);
  const WEEKLY_METRIC_ROWS = [
    ['Total Leads', (r) => r.leads, (r) => fmtInt(r.leads), 'up'],
    ['Total Ad Spend', (r) => r.spend, (r) => fmtMoney(r.spend), null],
    ['Cost Per Lead', (r) => r.cpl, (r) => (r.cpl != null ? fmtMoney(r.cpl) : '—'), 'down'],
  ];
  function renderWeekly(leadsByDate, spendByDate) {
    const dates = [...new Set([...leadsByDate.keys(), ...spendByDate.keys()])];
    const weeks = new Map();
    dates.forEach((dateStr) => {
      const d = new Date(dateStr + 'T00:00:00');
      if (isNaN(d)) return;
      const monday = mondayOf(d);
      const key = toISO(monday);
      if (!weeks.has(key)) weeks.set(key, { monday, leads: 0, spend: 0 });
      const w = weeks.get(key);
      w.leads += leadsByDate.get(dateStr) || 0;
      w.spend += spendByDate.get(dateStr) || 0;
    });
    const weekRows = [...weeks.values()].sort((a, b) => a.monday - b.monday).map((w) => ({
      label: weekLabel(w.monday), leads: w.leads, spend: w.spend, cpl: w.leads ? w.spend / w.leads : null,
    }));
    $('#b2b-weekly-sub').textContent = weekRows.length + ' week' + (weekRows.length === 1 ? '' : 's');

    const thead = '<thead><tr><th></th>' + weekRows.map((r) => '<th class="th-num">' + escapeHtml(r.label) + '</th>').join('') + '</tr></thead>';
    const tbody = '<tbody>' + WEEKLY_METRIC_ROWS.map(([label, rawFn, fmtFn, direction]) => {
      const colors = heatRowColors(weekRows.map(rawFn), direction);
      const cells = weekRows.map((r, i) => {
        const bg = colors[i];
        const style = bg ? ' style="background:' + bg + ';color:#15201a"' : '';
        return '<td class="td-num num"' + style + '>' + fmtFn(r) + '</td>';
      }).join('');
      return '<tr><td>' + escapeHtml(label) + '</td>' + cells + '</tr>';
    }).join('') + '</tbody>';
    $('#b2b-weekly-table').innerHTML = thead + tbody;

    state.weeklyRows = weekRows;
    renderWeeklyTrendChart();
  }
  function renderWeeklyTrendChart() {
    const weekRows = state.weeklyRows || [];
    const selected = WEEKLY_METRIC_ROWS.filter(([label]) => state.weeklyMetrics.has(label));
    const labels = weekRows.map((r) => r.label);
    const hasMoney = selected.some(([label]) => WEEKLY_MONEY_METRICS.has(label));
    const hasCount = selected.some(([label]) => !WEEKLY_MONEY_METRICS.has(label));
    const dualAxis = hasMoney && hasCount;
    const datasets = selected.map(([label, rawFn], i) => {
      const color = PALETTE[i % PALETTE.length];
      const isMoney = WEEKLY_MONEY_METRICS.has(label);
      return {
        type: 'line', label, data: weekRows.map(rawFn), borderColor: color, backgroundColor: color + '22',
        tension: 0.3, pointRadius: 3, spanGaps: true, yAxisID: dualAxis && !isMoney ? 'y1' : 'y',
      };
    });
    upsertChart('chart-b2b-weekly-trend', {
      data: { labels, datasets },
      options: chartOptions({ y1: dualAxis }),
    });
  }

  // Joined by ad NAME (UTM Content <-> Meta's Ad Name) — UTM Term never matches a real Ad ID for
  // B2B leads (see b2b.js), so name is the only attribution path that actually works.
  function renderLeadsByAd(leads) {
    const el = $('#b2b-leads-by-ad');
    // Spend filtered to the same date range as `leads` — adSpendByAdName alone is a lifetime
    // total and would overstate spend (and Cost/Lead) whenever a range is picked.
    const spendByName = new Map();
    state.adSpendByAdNameDaily.filter((r) => inRange(r.date)).forEach((r) => {
      spendByName.set(r.adName, (spendByName.get(r.adName) || 0) + r.spend);
    });
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

  $('#b2b-weekly-metrics').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const metric = btn.dataset.weeklyMetric;
    if (state.weeklyMetrics.has(metric)) state.weeklyMetrics.delete(metric); else state.weeklyMetrics.add(metric);
    btn.classList.toggle('is-active', state.weeklyMetrics.has(metric));
    renderWeeklyTrendChart();
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

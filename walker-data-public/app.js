(function () {
  const $ = (sel) => document.querySelector(sel);

  // ---- date helpers (same math as walker-public/app.js and every other dashboard here) ----
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

  function parseDate(s) {
    const [m, d, y] = String(s || '').split('/').map(Number);
    if (!m || !d || !y) return null;
    return new Date(y, m - 1, d);
  }
  function fmtMoney(n) { const sign = n < 0 ? '-' : ''; return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }
  function fmtPct(n) { return n.toFixed(2) + '%'; }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const state = {
    range: { start: null, end: null },
    trendsDays: [], trendsVertical: 'combined',
    lateQmvas: [], restoredLeads: [], correlation: [],
    restoredSub: 'late',
    posted: null, hourly: null,
    dataTab: 'trends', weeklyVertical: 'combined', weeklyMetric: 'PROFIT',
    loadedTabs: new Set(),
  };

  // Shared by the Weekly Breakdown table and the Weekly Trend chart's metric picker — direction:
  // 'up' = higher is better (green at the high end), 'down' = lower is better (green at the low
  // end), null = left uncolored (no clear "better" direction).
  const fmtPctOrDash = (n) => (n != null ? fmtPct(n) : '—');
  const fmtNumOrDash = (n) => (n != null ? n.toFixed(1) : '—');
  const WEEKLY_METRIC_ROWS = [
    ['Total Spend', (r) => r.spend, (r) => fmtMoney(r.spend), null],
    ['Total Raw Leads', (r) => r.totalLeads, (r) => fmtInt(r.totalLeads), 'up'],
    ['CPL', (r) => r.cpl, (r) => (r.cpl != null ? fmtMoney(r.cpl) : '—'), 'down'],
    ['Total Accepted Leads', (r) => r.acceptedLeads, (r) => fmtInt(r.acceptedLeads), 'up'],
    ['Cost Accepted Lead', (r) => r.costPerAcceptedLead, (r) => (r.costPerAcceptedLead != null ? fmtMoney(r.costPerAcceptedLead) : '—'), 'down'],
    ['% Accepted Leads', (r) => r.acceptedLeadsPct, (r) => fmtPctOrDash(r.acceptedLeadsPct), 'up'],
    ['Total QMVAs Q', (r) => r.qmvaQ, (r) => fmtInt(r.qmvaQ), 'up'],
    ['Total QMVAs DQ', (r) => r.qmvaDQ, (r) => fmtInt(r.qmvaDQ), 'down'],
    ['Total QMVAs', (r) => r.qmvaCount, (r) => fmtInt(r.qmvaCount), 'up'],
    ['Total NON MVA', (r) => r.nonMvaCount, (r) => fmtInt(r.nonMvaCount), null],
    ['Conversion Rate Overall', (r) => r.conversionRateOverall, (r) => fmtPctOrDash(r.conversionRateOverall), 'up'],
    ['Recency', (r) => r.recency, (r) => fmtNumOrDash(r.recency), 'down'],
    ['Total Payout', (r) => r.payout, (r) => fmtMoney(r.payout), 'up'],
    ['PROFIT', (r) => r.profit, (r) => fmtMoney(r.profit), 'up'],
    ['REVENUE PER QMVA', (r) => r.revenuePerQmva, (r) => (r.revenuePerQmva != null ? fmtMoney(r.revenuePerQmva) : '—'), 'up'],
  ];

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

  // ---- Campaign Trends ----
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
      const dash = (n) => (n != null ? n : null);
      return '<tr><td>' + escapeHtml(d.date) + '</td>' +
        '<td class="td-num num">' + fmtMoney(c.spend) + '</td>' +
        '<td class="td-num num">' + fmtInt(c.totalLeads) + '</td>' +
        '<td class="td-num num">' + (dash(c.cpl) != null ? fmtMoney(c.cpl) : '—') + '</td>' +
        '<td class="td-num num">' + fmtInt(c.acceptedLeads) + '</td>' +
        '<td class="td-num num">' + fmtInt(c.qmvaCount) + '</td>' +
        '<td class="td-num num">' + fmtInt(c.nonMvaCount || 0) + '</td>' +
        '<td class="td-num num">' + (dash(c.costPerAcceptedLead) != null ? fmtMoney(c.costPerAcceptedLead) : '—') + '</td>' +
        '<td class="td-num num">' + (dash(c.acceptedLeadsPct) != null ? fmtPct(c.acceptedLeadsPct) : '—') + '</td>' +
        '<td class="td-num num">' + (dash(c.conversionRate) != null ? fmtPct(c.conversionRate) : '—') + '</td>' +
        '<td class="td-num num">' + (c.recency != null ? c.recency.toFixed(1) : '—') + '</td>' +
        '<td class="td-num num">' + fmtMoney(c.payout || 0) + '</td>' +
        '<td class="td-num num">' + fmtMoney(c.profit != null ? c.profit : (c.payout || 0) - c.spend) + '</td>' +
        '<td class="td-num num">' + (dash(c.revenuePerQmva) != null ? fmtMoney(c.revenuePerQmva) : '—') + '</td></tr>';
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

  // ---- Weekly Breakdown (shares the same per-day data Campaign Trends uses) ----
  async function loadWeekly() {
    const r = await fetch('/walker-api/campaign-trends', { cache: 'no-store' });
    const json = await r.json();
    state.trendsDays = json.days || [];
    renderWeekly();
  }
  function mondayOfWeek(d) {
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const m = new Date(d); m.setDate(d.getDate() + diff); m.setHours(0, 0, 0, 0);
    return m;
  }
  function weekLabel(monday) {
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return fmt(monday) + ' - ' + fmt(sunday);
  }
  function renderWeekly() {
    const rows = state.trendsDays.filter((d) => {
      const dt = parseDate(d.date.replace(/-/g, '/'));
      if (!dt) return true;
      if (state.range.start && toISO(dt) < state.range.start) return false;
      if (state.range.end && toISO(dt) > state.range.end) return false;
      return true;
    });
    const weeks = new Map();
    rows.forEach((d) => {
      const dt = parseDate(d.date.replace(/-/g, '/'));
      if (!dt) return;
      const monday = mondayOfWeek(dt);
      const key = toISO(monday);
      if (!weeks.has(key)) weeks.set(key, { monday, days: [] });
      weeks.get(key).days.push(d[state.weeklyVertical] || d.combined);
    });
    const sorted = [...weeks.values()].sort((a, b) => a.monday - b.monday);
    $('#weekly-sub').textContent = sorted.length + ' week' + (sorted.length === 1 ? '' : 's');

    const today = pacificToday();
    const sum = (days, key) => days.reduce((s, c) => s + (c[key] || 0), 0);
    const weekRows = sorted.map((w) => {
      const totalLeads = sum(w.days, 'totalLeads');
      const acceptedLeads = sum(w.days, 'acceptedLeads');
      const spend = sum(w.days, 'spend');
      const qmvaCount = sum(w.days, 'qmvaCount');
      const qmvaQ = sum(w.days, 'qmvaQ');
      const qmvaDQ = sum(w.days, 'qmvaDQ');
      const nonMvaCount = sum(w.days, 'nonMvaCount');
      const payout = sum(w.days, 'payout');
      const recencies = w.days.map((c) => c.recency).filter((v) => v != null).sort((a, b) => a - b);
      const recency = recencies.length ? recencies[Math.floor(recencies.length / 2)] : null;
      const sunday = addDays(w.monday, 6);
      return {
        label: weekLabel(w.monday), ongoing: sunday >= today, spend, totalLeads,
        cpl: totalLeads ? spend / totalLeads : null,
        acceptedLeads, costPerAcceptedLead: acceptedLeads ? spend / acceptedLeads : null,
        acceptedLeadsPct: totalLeads ? (acceptedLeads / totalLeads) * 100 : null,
        qmvaCount, qmvaQ, qmvaDQ, nonMvaCount,
        conversionRateOverall: acceptedLeads ? (qmvaCount / acceptedLeads) * 100 : null,
        recency, payout, profit: payout - spend,
        revenuePerQmva: qmvaCount ? payout / qmvaCount : null,
      };
    });

    const thead = '<thead><tr><th></th>' + weekRows.map((r) =>
      '<th class="th-num">' + escapeHtml(r.label) + (r.ongoing ? ' <span class="week-ongoing-badge" title="Week still in progress — totals are partial">&#9679;</span>' : '') + '</th>'
    ).join('') + '</tr></thead>';
    const tbody = '<tbody>' + WEEKLY_METRIC_ROWS.map(([label, rawFn, fmtFn, direction]) => {
      const colors = heatRowColors(weekRows.map(rawFn), direction);
      const cells = weekRows.map((r, i) => {
        const bg = colors[i];
        const style = bg ? ' style="background:' + bg + ';color:#15201a"' : '';
        return '<td class="td-num num"' + style + '>' + fmtFn(r) + '</td>';
      }).join('');
      return '<tr><td>' + escapeHtml(label) + '</td>' + cells + '</tr>';
    }).join('') + '</tbody>';
    $('#weekly-table').innerHTML = thead + tbody;
    const anyOngoing = weekRows.some((r) => r.ongoing);
    $('#weekly-ongoing-note').style.display = anyOngoing ? '' : 'none';

    state.weeklyRows = weekRows;
    renderWeeklyTrendChart();
  }

  function renderWeeklyTrendChart() {
    const weekRows = state.weeklyRows || [];
    const metric = WEEKLY_METRIC_ROWS.find(([label]) => label === state.weeklyMetric) || WEEKLY_METRIC_ROWS[0];
    const [label, rawFn] = metric;
    const values = weekRows.map(rawFn);
    upsertChart('chart-weekly-trend', {
      data: {
        labels: weekRows.map((r) => r.label),
        datasets: [
          { type: 'line', label, data: values, borderColor: PALETTE[0], backgroundColor: PALETTE[0] + '33', fill: true, tension: 0.3, pointRadius: 3, spanGaps: true },
        ],
      },
      options: chartOptions(),
    });
  }

  // ---- heatmap coloring for the Weekly Breakdown table, matching the reference invoice sheet's
  // own red/yellow/green conditional-format scale, scaled per row across the visible weeks ----
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

  // ---- Restored & Late QMVAs ----
  function parsePublisherDate(s) {
    const m = /^(\d{2})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    return new Date(2000 + Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  }
  async function fetchTab(tab) {
    const r = await fetch('/walker-api/data?tab=' + tab, { cache: 'no-store' });
    const json = await r.json();
    return json.rows || [];
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

  // ---- Hourly Performance: static export, not live (same as the original — its two source
  // files, posted-to-qualified-raw.json and hourly-performance-raw.json, are one-time Domo/sheet
  // exports with no live refresh; re-export and overwrite the JSON files in walker-public/ to
  // update — fetched from there directly rather than duplicating the files here) ----
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
      fetch('/walker/posted-to-qualified-raw.json', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/walker/hourly-performance-raw.json', { cache: 'no-store' }).then((r) => r.json()),
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
      const res = await fetch('/walker/hourly-lead-detail.json', { signal: controller.signal });
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

  // ---- tab switching ----
  async function showDataTab(tab) {
    state.dataTab = tab;
    document.querySelectorAll('#data-inner-tabs .chip').forEach((b) => b.classList.toggle('is-active', b.dataset.datatab === tab));
    ['trends', 'restored', 'hourly', 'weekly'].forEach((t) => { $('#section-' + t).style.display = t === tab ? '' : 'none'; });
    if (!state.loadedTabs.has(tab)) {
      state.loadedTabs.add(tab);
      if (tab === 'trends') await loadTrends();
      else if (tab === 'restored') await loadRestored();
      else if (tab === 'hourly') await loadHourly();
      else if (tab === 'weekly') await loadWeekly();
    } else {
      if (tab === 'trends') renderTrends();
      else if (tab === 'restored') renderRestored();
      else if (tab === 'hourly') renderHourly();
      else if (tab === 'weekly') renderWeekly();
    }
  }
  function renderAll() {
    state.loadedTabs.clear();
    state.loadedTabs.add(state.dataTab);
    if (state.dataTab === 'trends') renderTrends();
    else if (state.dataTab === 'restored') renderRestored();
    else if (state.dataTab === 'hourly') renderHourly();
    else if (state.dataTab === 'weekly') renderWeekly();
  }

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
  $('#data-inner-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    showDataTab(btn.dataset.datatab);
  });
  $('#weekly-vertical-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    document.querySelectorAll('#weekly-vertical-tabs .chip').forEach((b) => b.classList.toggle('is-active', b === btn));
    state.weeklyVertical = btn.dataset.weeklyVertical;
    renderWeekly();
  });
  $('#weekly-chart-metric').addEventListener('change', (e) => {
    state.weeklyMetric = e.target.value;
    renderWeeklyTrendChart();
  });

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
    state.loadedTabs.delete(state.dataTab);
    showDataTab(state.dataTab).finally(() => setTimeout(() => $('#refresh-btn').classList.remove('is-spinning'), 400));
  });

  // Same floor as Walker PPL/Agency for consistency across the site.
  const defaultKey = buildQuickRangeOptions(2026, 1);
  const initial = computeRange(defaultKey);
  state.range = initial;
  $('#quick-range').value = defaultKey;
  $('#range-start').value = initial.start || '';
  $('#range-end').value = initial.end || '';

  showDataTab('trends');
  setInterval(() => { state.loadedTabs.delete(state.dataTab); showDataTab(state.dataTab); }, 60000);
})();

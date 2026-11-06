(function () {
  const $ = (sel) => document.querySelector(sel);
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const pct = (n) => (isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '0') + '%';
  const COLOR_GOOGLE = '#3987e5';
  const COLOR_META = '#d95926';
  const COLOR_LEADS = '#3987e5';
  const COLOR_CASES = '#199e70';

  const NO_AD = '@none';

  const state = {
    cases: [], leadsDaily: [], spend: [], settings: { feePerLead: 35, monthlyAdBudget: 20000 },
    search: '',
    range: { key: 'all', start: null, end: null },
    // Clicking a slice, bar, point, row or legend item sets one of these; the tiles, charts and
    // tables then re-compute from what matches.
    filters: { platform: null, ad: null },
    monthlyMetrics: new Set(['Total Leads', 'Total Ad Spend']),
    monthlyRows: [],
  };
  let defaultRangeKey = null; // set once the quick-range dropdown is built, at the bottom of this file

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---- date range (same math as the main creative dashboard, so "August 2026" etc. line up) ----
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
      case 'all': return { start: null, end: null };
      default: {
        const m = /^(\d{4})-(\d{2})$/.exec(key);
        if (m) { const y = Number(m[1]), mo = Number(m[2]); return { start: toISO(startOfMonth(y, mo)), end: toISO(endOfMonth(y, mo)) }; }
        return { start: null, end: null };
      }
    }
  }
  // Builds the quick-range dropdown fresh off today's date every load, so it never goes stale —
  // Today/Yesterday/This week/Last week/This month/Last month, then every earlier month back to
  // floorYear-floorMonth, newest first. Month keys are "YYYY-MM", which computeRange's default
  // case already parses generically.
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

  function inRange(dateStr) {
    const { start, end } = state.range;
    if (!dateStr) return !start && !end;
    if (start && dateStr < start) return false;
    if (end && dateStr > end) return false;
    return true;
  }
  function rangeLabel() {
    const { key, start, end } = state.range;
    const opt = document.querySelector(`#quick-range option[value="${key}"]`);
    if (key !== 'custom' && opt) return key === 'all' ? '' : '· ' + opt.textContent.toLowerCase();
    if (start && end) return '· ' + (start === end ? start : start + ' to ' + end);
    return '';
  }
  function rangeText() {
    const { key, start, end } = state.range;
    const opt = document.querySelector(`#quick-range option[value="${key}"]`);
    if (key !== 'custom' && opt) return opt.textContent;
    return start === end ? start : start + ' to ' + end;
  }
  // Sets the date range and keeps the quick-range dropdown and date boxes in step with it.
  function setRange(key, start, end) {
    state.range = { key, start, end };
    const opt = document.querySelector(`#quick-range option[value="${key}"]`);
    $('#quick-range').value = opt ? key : 'custom';
    $('#range-start').value = start || '';
    $('#range-end').value = end || '';
  }

  // 2025 isn't in this dashboard's own live feed (spend tracking here starts 2026-01-01), so the
  // same twelve hand-entered months used by the Monthly Trend chart are injected here too, once,
  // right after every live fetch — this is what lets the date-range picker, KPI tiles, and every
  // other chart on the page show real 2025 numbers instead of just the Monthly Trend section.
  // Any live 2025 rows are dropped first so a real and a synthetic entry for the same day can
  // never be double-counted.
  function injectHistorical2025() {
    state.leadsDaily = state.leadsDaily.filter((r) => r.date >= '2026-01-01');
    state.spend = state.spend.filter((r) => r.date >= '2026-01-01');
    state.cases = state.cases.filter((c) => !c.conversionDate || c.conversionDate >= '2026-01-01');
    HIST_2025.forEach((h) => {
      const d1 = h.key + '-01';
      state.leadsDaily.push({ date: d1, leads: h.leads });
      state.spend.push({ date: d1, platform: 'Meta', spend: h.spend });
      for (let i = 0; i < h.cases; i++) {
        state.cases.push({ name: '—', email: '', intakeDate: d1, conversionDate: d1, ad: '2025 historical (monthly total)', adName: '2025 historical (monthly total)' });
      }
    });
    state.leadsDaily.sort((a, b) => (a.date < b.date ? -1 : 1));
    state.spend.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  async function fetchData() {
    try {
      const r = await fetch('/km-api/data', { cache: 'no-store' });
      if (!r.ok) throw new Error('bad status');
      const d = await r.json();
      state.cases = d.cases || [];
      state.leadsDaily = d.leadsDaily || [];
      state.spend = [
        ...(d.googleDaily || []).map((x) => ({ date: x.date, platform: 'Google', spend: x.spend })),
        ...(d.metaDaily || []).map((x) => ({ date: x.date, platform: 'Meta', spend: x.spend })),
      ];
      state.settings = d.settings || state.settings;
      injectHistorical2025();
      setLive(true);
    } catch (err) {
      setLive(false);
    }
    render();
  }

  function setLive(ok) {
    $('#live-text').textContent = ok ? 'Live – checked just now' : 'Connection lost – retrying…';
    $('#live-pill').style.opacity = ok ? '1' : '.6';
  }

  function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }

  // Spend only exists from 2026-01-01, so leads/cases before the first spend day are left out.
  function firstSpendDay() { const d = state.spend.map((r) => r.date).sort(); return d[0] || null; }
  function inWindow(dateStr) { const f = firstSpendDay(); return !f || (dateStr && dateStr >= f); }
  const adOf = (c) => c.adName || NO_AD;

  // What matches the current filters. A view that offers its own dimension to click is computed
  // with that one filter skipped, so the other choices stay on screen to switch to.
  function spendFor(skip) {
    const f = state.filters;
    return state.spend.filter((r) => inRange(r.date) && !(f.platform && skip !== 'platform' && r.platform !== f.platform));
  }
  function casesFor(skip, ignoreDate) {
    const f = state.filters;
    return state.cases.filter((c) => inWindow(c.conversionDate) && (ignoreDate || inRange(c.conversionDate)) && !(f.ad && skip !== 'ad' && adOf(c) !== f.ad));
  }
  function leadsDailyFor(ignoreDate) {
    return state.leadsDaily.filter((r) => inWindow(r.date) && (ignoreDate || inRange(r.date)));
  }

  function toggleFilter(name, value) {
    state.filters[name] = state.filters[name] === value ? null : value;
    render();
  }

  // ================= active-filter bar =================
  function filterLabel(name, value) { return name === 'ad' ? 'Ad: ' + (value === NO_AD ? '(no ad listed)' : value) : 'Platform: ' + value; }
  function renderFilterBar() {
    const chips = Object.entries(state.filters).filter(([, v]) => v).map(([name, v]) =>
      '<button class="filter-chip" data-clear="' + name + '" title="Remove this filter">' + escapeHtml(filterLabel(name, v)) + '<span aria-hidden="true">&times;</span></button>'
    );
    if (state.range.key !== 'all') {
      chips.push('<button class="filter-chip" data-clear="range" title="Remove this filter">Dates: ' + escapeHtml(rangeText()) + '<span aria-hidden="true">&times;</span></button>');
    }
    const bar = $('#filter-bar');
    bar.hidden = chips.length === 0;
    bar.innerHTML = chips.length
      ? '<span class="filter-bar-label">Filtered by</span>' + chips.join('') + '<button class="filter-clear-all" data-clear="all">Clear all</button>'
      : '';
  }
  function clearRange() { const { start, end } = computeRange(defaultRangeKey); setRange(defaultRangeKey, start, end); }
  function clearAll() { state.filters = { platform: null, ad: null }; clearRange(); }

  // The sheet's AD Budget is a monthly figure, so a range's budget is that amount spread over each
  // day's month (a full month gets exactly one month's budget; a week gets about a quarter of it).
  function adBudgetForRange() {
    const spendDays = state.spend.map((r) => r.date).sort();
    if (!spendDays.length) return 0;
    const start = state.range.start || spendDays[0];
    const end = state.range.end || toISO(pacificToday());
    if (end < start) return 0;
    let total = 0;
    for (let d = new Date(start + 'T00:00:00'), last = new Date(end + 'T00:00:00'); d <= last; d.setDate(d.getDate() + 1)) {
      total += state.settings.monthlyAdBudget / new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    }
    return total;
  }

  // ================= KPI row =================
  function renderKpis(cases, spendRows, leadsDaily) {
    const f = state.filters;
    const signed = cases.length;
    const leads = leadsDaily.reduce((a, r) => a + r.leads, 0);
    const googleSpend = spendRows.filter((r) => r.platform === 'Google').reduce((a, r) => a + r.spend, 0);
    const metaSpend = spendRows.filter((r) => r.platform === 'Meta').reduce((a, r) => a + r.spend, 0);
    const totalSpend = googleSpend + metaSpend;

    // Spend is split by platform but not by ad; cases are split by ad but not by platform; leads
    // by neither. A ratio is only honest when both halves respect every active filter.
    const ratiosOk = !f.platform && !f.ad;
    const note = f.ad ? 'spend and leads aren’t split by ad' : 'leads and cases aren’t split by platform';
    const conversionRate = leads > 0 && ratiosOk ? (signed / leads) * 100 : 0;
    const cpl = leads > 0 && ratiosOk ? totalSpend / leads : 0;
    const costPerCase = signed > 0 && ratiosOk ? totalSpend / signed : 0;

    const fee = leads * state.settings.feePerLead;
    const budget = adBudgetForRange();
    const totalCost = totalSpend + fee;
    const cpcWithFee = signed > 0 && ratiosOk ? totalCost / signed : 0;
    const used = budget > 0 ? (totalSpend / budget) * 100 : 0;
    const budgetSub = budget > 0
      ? (totalSpend <= budget ? pct(used) + ' used · ' + money(budget - totalSpend) + ' left' : money(totalSpend - budget) + ' over budget')
      : '';
    const dash = '—';

    const tiles = [
      ['clear', 'Total Leads', leads.toLocaleString('en-US'), '', 'Click to clear the filters'],
      ['', 'Signed Cases', signed.toLocaleString('en-US'), 'of ' + leads.toLocaleString('en-US') + ' leads', ''],
      ['', 'Conversion Rate', ratiosOk ? pct(conversionRate) : dash, ratiosOk ? 'signed ÷ leads' : note, ''],
      ['', 'Cost / Lead', cpl ? money(cpl) : dash, ratiosOk ? 'ad spend ÷ leads' : note, ''],
      ['', 'Ad Spend', money(totalSpend), money(googleSpend) + ' Google + ' + money(metaSpend) + ' Meta', ''],
      ['', 'Marketing Fee', money(fee), leads.toLocaleString('en-US') + ' leads × $' + state.settings.feePerLead + ' per lead', ''],
      ['', 'Ad Budget', money(budget), budgetSub, ''],
      ['', 'Total Cost', money(totalCost), 'ad spend + marketing fee', ''],
      ['', 'CPC (Cost / Case)', costPerCase ? money(costPerCase) : dash, !ratiosOk ? note : signed ? 'ad spend ÷ signed cases' : 'no signed cases yet', ''],
      ['', 'CPC + Marketing Fee', cpcWithFee ? money(cpcWithFee) : dash, !ratiosOk ? note : signed ? 'total cost ÷ signed cases' : 'no signed cases yet', ''],
    ];
    $('#kpi-row').innerHTML = tiles.map(([key, label, value, sub, hint]) =>
      '<div class="kpi' + (key ? ' is-clickable' : '') + '"' + (key ? ' data-tile="' + key + '" title="' + hint + '"' : '') + '>' +
      '<div class="kpi-label">' + escapeHtml(label) + '</div>' +
      '<div class="kpi-value num">' + value + '</div>' +
      (sub ? '<div class="kpi-sub">' + escapeHtml(sub) + '</div>' : '') + '</div>'
    ).join('');
  }

  // ================= shared SVG/tooltip helpers =================
  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }
  function niceMax(v) {
    if (v <= 0) return 10;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }
  function ensureTooltip(container) {
    let tip = container.querySelector('.viz-tooltip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'viz-tooltip'; tip.hidden = true; container.appendChild(tip); }
    return tip;
  }
  function positionTooltip(tip, container, x, y) {
    const cw = container.clientWidth;
    tip.style.left = Math.min(x + 14, cw - tip.offsetWidth - 8) + 'px';
    tip.style.top = Math.max(y - 46, 4) + 'px';
  }

  // ================= line chart: daily Google vs Meta spend =================
  function renderSpendChart() {
    const container = $('#spend-chart');
    container.innerHTML = '';
    const pf = state.filters.platform;
    const legendItem = (name, color) =>
      '<button class="legend-item legend-btn' + (pf === name ? ' is-selected' : '') + (pf && pf !== name ? ' is-dim' : '') + '" data-platform="' + name + '" title="Click to filter by ' + name + '">' +
      '<span class="legend-swatch legend-swatch--line" style="background:' + color + '"></span>' + name + '</button>';
    $('#spend-legend').innerHTML = legendItem('Google', COLOR_GOOGLE) + legendItem('Meta', COLOR_META);

    const byDate = new Map();
    for (const r of spendFor('platform')) {
      if (!byDate.has(r.date)) byDate.set(r.date, { google: 0, meta: 0 });
      byDate.get(r.date)[r.platform === 'Google' ? 'google' : 'meta'] += r.spend;
    }
    const dates = [...byDate.keys()].sort();
    if (!dates.length) { container.innerHTML = '<div class="empty-msg">No spend recorded for this selection.</div>'; return; }

    const W = 900, H = 260, padL = 44, padR = 12, padT = 14, padB = 28;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxVal = niceMax(Math.max(...dates.map((d) => Math.max(byDate.get(d).google, byDate.get(d).meta))));
    const x = (i) => padL + (dates.length === 1 ? innerW / 2 : (i / (dates.length - 1)) * innerW);
    const y = (v) => padT + innerH - (v / maxVal) * innerH;

    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, style: 'display:block;overflow:visible' });
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = (maxVal / steps) * i;
      const gy = y(v);
      svg.appendChild(svgEl('line', { class: 'viz-gridline', x1: padL, x2: W - padR, y1: gy, y2: gy }));
      const label = svgEl('text', { class: 'viz-axis-label', x: padL - 8, y: gy + 3, 'text-anchor': 'end' });
      label.textContent = '$' + Math.round(v).toLocaleString('en-US');
      svg.appendChild(label);
    }
    const labelEvery = Math.max(1, Math.ceil(dates.length / 6));
    dates.forEach((d, i) => {
      if (i % labelEvery !== 0 && i !== dates.length - 1) return;
      const label = svgEl('text', { class: 'viz-axis-label', x: x(i), y: H - 6, 'text-anchor': 'middle' });
      label.textContent = d.slice(5);
      svg.appendChild(label);
    });

    const linePath = (key) => dates.map((d, i) => (i === 0 ? 'M' : 'L') + x(i) + ',' + y(byDate.get(d)[key])).join(' ');
    const lineOpacity = (name) => (pf && pf !== name ? 0.18 : 1);
    svg.appendChild(svgEl('path', { d: linePath('google'), fill: 'none', stroke: COLOR_GOOGLE, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: lineOpacity('Google') }));
    svg.appendChild(svgEl('path', { d: linePath('meta'), fill: 'none', stroke: COLOR_META, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: lineOpacity('Meta') }));

    const crosshair = svgEl('line', { class: 'viz-crosshair', x1: 0, x2: 0, y1: padT, y2: H - padB, visibility: 'hidden' });
    const dotG = svgEl('circle', { r: 4, fill: COLOR_GOOGLE, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
    const dotM = svgEl('circle', { r: 4, fill: COLOR_META, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(crosshair); svg.appendChild(dotG); svg.appendChild(dotM);

    const hitW = innerW / Math.max(1, dates.length - 1 || 1);
    const tip = ensureTooltip(container);
    dates.forEach((d, i) => {
      const rect = svgEl('rect', { class: 'bar-hover-rect is-clickable', x: x(i) - hitW / 2, y: padT, width: hitW, height: innerH });
      rect.addEventListener('mouseenter', () => {
        const v = byDate.get(d);
        crosshair.setAttribute('x1', x(i)); crosshair.setAttribute('x2', x(i)); crosshair.setAttribute('visibility', 'visible');
        dotG.setAttribute('cx', x(i)); dotG.setAttribute('cy', y(v.google)); dotG.setAttribute('visibility', 'visible');
        dotM.setAttribute('cx', x(i)); dotM.setAttribute('cy', y(v.meta)); dotM.setAttribute('visibility', 'visible');
        tip.innerHTML = '<div class="t-date">' + d + '</div>' +
          '<div class="t-row"><span><span class="legend-swatch" style="background:' + COLOR_GOOGLE + ';display:inline-block;margin-right:5px"></span>Google</span><strong>' + money(v.google) + '</strong></div>' +
          '<div class="t-row"><span><span class="legend-swatch" style="background:' + COLOR_META + ';display:inline-block;margin-right:5px"></span>Meta</span><strong>' + money(v.meta) + '</strong></div>' +
          '<div class="t-hint">Click to filter to this day</div>';
        tip.hidden = false;
        positionTooltip(tip, container, (x(i) / W) * container.clientWidth, y(Math.max(v.google, v.meta)));
      });
      rect.addEventListener('mouseleave', () => { crosshair.setAttribute('visibility', 'hidden'); dotG.setAttribute('visibility', 'hidden'); dotM.setAttribute('visibility', 'hidden'); tip.hidden = true; });
      rect.addEventListener('click', () => { setRange('custom', d, d); render(); });
      svg.appendChild(rect);
    });

    container.style.position = 'relative';
    container.appendChild(svg);
  }

  // ================= grouped bar chart: leads vs signed cases per month =================
  function renderBarChart() {
    const container = $('#bar-chart');
    container.innerHTML = '';
    $('#bar-legend').innerHTML =
      '<span class="legend-item"><span class="legend-swatch" style="background:' + COLOR_LEADS + '"></span>Leads</span>' +
      '<span class="legend-item"><span class="legend-swatch" style="background:' + COLOR_CASES + '"></span>Signed Cases</span>';

    // Months outside the chosen dates stay on screen (dimmed) so another month is one click away.
    const byMonth = new Map();
    const bump = (key, field, n) => { if (!byMonth.has(key)) byMonth.set(key, { leads: 0, cases: 0 }); byMonth.get(key)[field] += n; };
    for (const r of leadsDailyFor(true)) bump(r.date.slice(0, 7), 'leads', r.leads);
    for (const c of casesFor(null, true)) if (c.conversionDate) bump(c.conversionDate.slice(0, 7), 'cases', 1);
    const months = [...byMonth.keys()].sort();
    if (!months.length) { container.innerHTML = '<div class="empty-msg">Nothing for this selection.</div>'; return; }
    const { start, end } = state.range;
    const monthInRange = (m) => {
      const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7));
      return (!end || toISO(startOfMonth(y, mo)) <= end) && (!start || toISO(endOfMonth(y, mo)) >= start);
    };

    const W = 560, H = 260, padL = 34, padR = 10, padT = 14, padB = 30;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxVal = niceMax(Math.max(...months.map((m) => Math.max(byMonth.get(m).leads, byMonth.get(m).cases))));
    const groupW = innerW / months.length;
    const barW = Math.min(22, groupW * 0.32);
    const yOf = (v) => padT + innerH - (v / maxVal) * innerH;

    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, style: 'display:block;overflow:visible' });
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = (maxVal / steps) * i;
      const gy = yOf(v);
      svg.appendChild(svgEl('line', { class: 'viz-gridline', x1: padL, x2: W - padR, y1: gy, y2: gy }));
      const label = svgEl('text', { class: 'viz-axis-label', x: padL - 6, y: gy + 3, 'text-anchor': 'end' });
      label.textContent = Math.round(v);
      svg.appendChild(label);
    }

    const tip = ensureTooltip(container);
    const monthName = (m) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString('en-US', { month: 'short' });
    months.forEach((m, i) => {
      const cx = padL + groupW * i + groupW / 2;
      const v = byMonth.get(m);
      const gap = 3;
      const on = monthInRange(m);
      const g = svgEl('g', { opacity: on ? 1 : 0.3 });
      g.appendChild(svgEl('rect', { x: cx - barW - gap / 2, y: yOf(v.leads), width: barW, height: innerH - (yOf(v.leads) - padT), rx: 3, fill: COLOR_LEADS }));
      g.appendChild(svgEl('rect', { x: cx + gap / 2, y: yOf(v.cases), width: barW, height: innerH - (yOf(v.cases) - padT), rx: 3, fill: COLOR_CASES }));
      svg.appendChild(g);
      const label = svgEl('text', { class: 'viz-axis-label', x: cx, y: H - 8, 'text-anchor': 'middle' });
      label.textContent = monthName(m);
      svg.appendChild(label);

      const hit = svgEl('rect', { class: 'bar-hover-rect is-clickable', x: padL + groupW * i, y: padT, width: groupW, height: innerH });
      hit.addEventListener('mouseenter', () => {
        tip.innerHTML = '<div class="t-date">' + monthName(m) + ' ' + m.slice(0, 4) + '</div>' +
          '<div class="t-row"><span><span class="legend-swatch" style="background:' + COLOR_LEADS + ';display:inline-block;margin-right:5px"></span>Leads</span><strong>' + v.leads + '</strong></div>' +
          '<div class="t-row"><span><span class="legend-swatch" style="background:' + COLOR_CASES + ';display:inline-block;margin-right:5px"></span>Signed Cases</span><strong>' + v.cases + '</strong></div>' +
          '<div class="t-hint">Click to filter to this month</div>';
        tip.hidden = false;
        positionTooltip(tip, container, (cx / W) * container.clientWidth, yOf(Math.max(v.leads, v.cases)));
      });
      hit.addEventListener('mouseleave', () => { tip.hidden = true; });
      hit.addEventListener('click', () => {
        const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7));
        if (state.range.key === m) clearRange(); else setRange(m, toISO(startOfMonth(y, mo)), toISO(endOfMonth(y, mo)));
        render();
      });
      svg.appendChild(hit);
    });

    container.style.position = 'relative';
    container.appendChild(svg);
  }

  // ================= line chart + breakdown table: monthly trend =================
  // Same metric set and red-to-green heatmap scale as the B2B dashboard's Weekly Trend, just
  // bucketed by calendar month instead of Monday-Sunday week.
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

  const COLOR_SPEND_TREND = '#e0a92d';
  const COLOR_SIGNED_CASES = '#9085e9';
  const COLOR_COST_CASE_FEE = '#d55181';
  const COLOR_COST_CASE_AD = '#e34948';
  const COLOR_CVR = '#2dd4bf';
  const MONTHLY_METRIC_DEFS = {
    'Total Leads': { color: COLOR_LEADS, isMoney: false, get: (r) => r.leads, fmt: (v) => Math.round(v).toLocaleString('en-US') },
    'Total Ad Spend': { color: COLOR_SPEND_TREND, isMoney: true, get: (r) => r.spend, fmt: (v) => money(v) },
    'Cost Per Lead': { color: COLOR_CASES, isMoney: true, get: (r) => (r.cpl != null ? r.cpl : 0), fmt: (v) => (v ? money(v) : '—') },
    'Signed Cases': { color: COLOR_SIGNED_CASES, isMoney: false, get: (r) => r.cases, fmt: (v) => Math.round(v).toLocaleString('en-US') },
    'Cost per Case (+Fee)': { color: COLOR_COST_CASE_FEE, isMoney: true, get: (r) => (r.costCaseFee != null ? r.costCaseFee : 0), fmt: (v) => (v ? money(v) : '—') },
    'Cost per Case (Ad only)': { color: COLOR_COST_CASE_AD, isMoney: true, get: (r) => (r.costCaseAdOnly != null ? r.costCaseAdOnly : 0), fmt: (v) => (v ? money(v) : '—') },
    'CVR': { color: COLOR_CVR, isMoney: false, get: (r) => (r.cvr != null ? r.cvr : 0), fmt: (v) => pct(v) },
  };
  const MONTHLY_BREAKDOWN_ROWS = [
    ['Total Leads', (r) => r.leads, (r) => Math.round(r.leads).toLocaleString('en-US'), 'up'],
    ['Total Ad Spend', (r) => r.spend, (r) => money(r.spend), null],
    ['Cost Per Lead', (r) => r.cpl, (r) => (r.cpl != null ? money(r.cpl) : '—'), 'down'],
    ['Signed Cases', (r) => r.cases, (r) => Math.round(r.cases).toLocaleString('en-US'), 'up'],
    ['Cost per Case (+Fee)', (r) => r.costCaseFee, (r) => (r.costCaseFee != null ? money(r.costCaseFee) : '—'), 'down'],
    ['Cost per Case (Ad only)', (r) => r.costCaseAdOnly, (r) => (r.costCaseAdOnly != null ? money(r.costCaseAdOnly) : '—'), 'down'],
    ['CVR', (r) => r.cvr, (r) => (r.cvr != null ? pct(r.cvr) : '—'), 'up'],
  ];

  // 2025 predates this dashboard's own live tracking — ad spend here only goes back to
  // 2026-01-01 (see the footnote above the Signed Case Details table) — so these twelve months
  // are hand-entered from the KM Law Facebook Ads Report sheet's own "Monthly Report" tabs and
  // the GLOBAL MONTHLY-corrected Case Study Data build (Sep-Dec use the flat $12,000/mo fee
  // confirmed there; every other month is the flat $7,000/mo fee), not fetched live.
  const HIST_2025 = [
    { key: '2025-01', label: 'Jan 2025', leads: 122, spend: 4843.01, cases: 8, cpl: 39.70, costCaseFee: 1480.38, costCaseAdOnly: 605.38, cvr: 6.56 },
    { key: '2025-02', label: 'Feb 2025', leads: 242, spend: 14446.50, cases: 20, cpl: 59.70, costCaseFee: 1072.33, costCaseAdOnly: 722.33, cvr: 8.26 },
    { key: '2025-03', label: 'Mar 2025', leads: 281, spend: 19725.11, cases: 11, cpl: 70.20, costCaseFee: 2429.56, costCaseAdOnly: 1793.19, cvr: 3.91 },
    { key: '2025-04', label: 'Apr 2025', leads: 225, spend: 16926.75, cases: 20, cpl: 75.23, costCaseFee: 1196.34, costCaseAdOnly: 846.34, cvr: 8.89 },
    { key: '2025-05', label: 'May 2025', leads: 239, spend: 18398.96, cases: 20, cpl: 76.98, costCaseFee: 1269.95, costCaseAdOnly: 919.95, cvr: 8.37 },
    { key: '2025-06', label: 'Jun 2025', leads: 218, spend: 18041.08, cases: 10, cpl: 82.76, costCaseFee: 2504.11, costCaseAdOnly: 1804.11, cvr: 4.59 },
    { key: '2025-07', label: 'Jul 2025', leads: 366, spend: 22425.40, cases: 18, cpl: 61.27, costCaseFee: 1634.74, costCaseAdOnly: 1245.86, cvr: 4.92 },
    { key: '2025-08', label: 'Aug 2025', leads: 254, spend: 17497.23, cases: 13, cpl: 68.89, costCaseFee: 2269.02, costCaseAdOnly: 1345.94, cvr: 5.12 },
    { key: '2025-09', label: 'Sep 2025', leads: 507, spend: 28730.30, cases: 12, cpl: 56.67, costCaseFee: 3394.19, costCaseAdOnly: 2394.19, cvr: 2.37 },
    { key: '2025-10', label: 'Oct 2025', leads: 402, spend: 29756.51, cases: 14, cpl: 74.02, costCaseFee: 2982.61, costCaseAdOnly: 2125.47, cvr: 3.48 },
    { key: '2025-11', label: 'Nov 2025', leads: 360, spend: 29011.35, cases: 10, cpl: 80.59, costCaseFee: 4101.14, costCaseAdOnly: 2901.14, cvr: 2.78 },
    { key: '2025-12', label: 'Dec 2025', leads: 365, spend: 27970.34, cases: 14, cpl: 76.63, costCaseFee: 2497.88, costCaseAdOnly: 1997.88, cvr: 3.84 },
  ];

  // Full history, bucketed by calendar month — ignores the page's own date-range picker (which
  // only goes back to Jan 2026 and is meant for the KPI tiles/other charts above) since this
  // trend is meant to read like the B2B dashboard's Weekly Trend: always the whole timeline.
  function monthlyRows() {
    const byMonth = new Map();
    const bump = (key, field, n) => { if (!byMonth.has(key)) byMonth.set(key, { leads: 0, spend: 0, cases: 0 }); byMonth.get(key)[field] += n; };
    for (const r of state.leadsDaily) bump(r.date.slice(0, 7), 'leads', r.leads);
    for (const r of state.spend) bump(r.date.slice(0, 7), 'spend', r.spend);
    for (const c of state.cases) if (c.conversionDate) bump(c.conversionDate.slice(0, 7), 'cases', 1);
    const liveRows = [...byMonth.keys()].sort().map((key) => {
      const v = byMonth.get(key);
      const y = Number(key.slice(0, 4)), mo = Number(key.slice(5, 7));
      const label = new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      const fee = v.leads * state.settings.feePerLead;
      return {
        key, label, leads: v.leads, spend: v.spend, cases: v.cases,
        cpl: v.leads ? v.spend / v.leads : null,
        costCaseFee: v.cases ? (v.spend + fee) / v.cases : null,
        costCaseAdOnly: v.cases ? v.spend / v.cases : null,
        cvr: v.leads ? (v.cases / v.leads) * 100 : null,
      };
    });
    // Guard against double-counting: only live rows from 2026 onward are kept, since HIST_2025
    // already covers every 2025 month and the live feed isn't expected to have 2025 data anyway.
    return [...HIST_2025, ...liveRows.filter((r) => r.key >= '2026-01')];
  }

  // Every metric is shown indexed to its own first-month value = 100 (% change from Jan 2025),
  // not its raw value — with leads in the hundreds, ad spend in the tens of thousands, and CVR a
  // single-digit percent all on screen together, a shared raw-value axis (even a dual-axis one)
  // leaves most lines flattened near zero. Indexing is the only way all seven read at once; the
  // tooltip still shows each metric's real value.
  function renderMonthlyTrendChart() {
    const rows = state.monthlyRows;
    const container = $('#monthly-trend-chart');
    container.innerHTML = '';
    if (!rows.length) { container.innerHTML = '<div class="empty-msg">Nothing for this selection.</div>'; return; }
    const defs = Object.entries(MONTHLY_METRIC_DEFS).filter(([label]) => state.monthlyMetrics.has(label));
    if (!defs.length) { container.innerHTML = '<div class="empty-msg">Pick at least one metric.</div>'; return; }

    const indexedDefs = defs.map(([label, d]) => {
      const baseline = d.get(rows[0]) || 1;
      return { label, d, baseline, idx: (r) => (d.get(r) / baseline) * 100 };
    });

    const padR = 150; // room for end-of-line labels
    const W = 900, H = 300, padL = 50, padT = 14, padB = 30;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const allIdx = indexedDefs.flatMap(({ idx }) => rows.map((r) => idx(r)));
    const maxVal = niceMax(Math.max(...allIdx, 150) * 1.1);
    const y = (v) => padT + innerH - (v / maxVal) * innerH;
    const x = (i) => padL + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);

    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, style: 'display:block;overflow:visible' });
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const v = (maxVal / steps) * i;
      const gy = y(v);
      svg.appendChild(svgEl('line', { class: 'viz-gridline', x1: padL, x2: padL + innerW, y1: gy, y2: gy }));
      const lbl = svgEl('text', { class: 'viz-axis-label', x: padL - 8, y: gy + 3, 'text-anchor': 'end' });
      lbl.textContent = Math.round(v);
      svg.appendChild(lbl);
    }
    // dashed reference line at the first-month baseline (100)
    const baseY = y(100);
    svg.appendChild(svgEl('line', { x1: padL, x2: padL + innerW, y1: baseY, y2: baseY, stroke: 'var(--text-faint)', 'stroke-width': 1, 'stroke-dasharray': '3,3', opacity: 0.6 }));
    const baseLbl = svgEl('text', { class: 'viz-axis-label', x: padL + innerW + 6, y: baseY + 3 });
    baseLbl.textContent = rows[0].label + ' baseline';
    svg.appendChild(baseLbl);

    const labelEvery = Math.max(1, Math.ceil(rows.length / 8));
    rows.forEach((r, i) => {
      if (i % labelEvery !== 0 && i !== rows.length - 1) return;
      const lbl = svgEl('text', { class: 'viz-axis-label', x: x(i), y: H - 8, 'text-anchor': 'middle' });
      lbl.textContent = r.label;
      svg.appendChild(lbl);
    });

    indexedDefs.forEach(({ d, idx }) => {
      const path = rows.map((r, i) => (i === 0 ? 'M' : 'L') + x(i) + ',' + y(idx(r))).join(' ');
      svg.appendChild(svgEl('path', { d: path, fill: 'none', stroke: d.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      rows.forEach((r, i) => svg.appendChild(svgEl('circle', { cx: x(i), cy: y(idx(r)), r: 3, fill: d.color })));
    });

    // end-of-line direct labels, nudged apart if two lines finish close together
    const lastX = x(rows.length - 1);
    const lastPoints = indexedDefs.map(({ label, d, idx }) => ({ label, color: d.color, y: y(idx(rows[rows.length - 1])) })).sort((a, b) => a.y - b.y);
    const minGap = 13;
    for (let i = 1; i < lastPoints.length; i++) {
      if (lastPoints[i].y - lastPoints[i - 1].y < minGap) lastPoints[i].y = lastPoints[i - 1].y + minGap;
    }
    lastPoints.forEach(({ label, color, y: ly }) => {
      const lbl = svgEl('text', { x: lastX + 8, y: ly + 3, style: 'font-size:11px;font-weight:600;fill:' + color });
      lbl.textContent = label;
      svg.appendChild(lbl);
    });

    const tip = ensureTooltip(container);
    const hitW = innerW / Math.max(1, rows.length - 1 || 1);
    rows.forEach((r, i) => {
      const rect = svgEl('rect', { class: 'bar-hover-rect is-clickable', x: x(i) - hitW / 2, y: padT, width: hitW, height: innerH });
      rect.addEventListener('mouseenter', () => {
        tip.innerHTML = '<div class="t-date">' + r.label + '</div>' +
          indexedDefs.map(({ label, d }) => '<div class="t-row"><span><span class="legend-swatch" style="background:' + d.color + ';display:inline-block;margin-right:5px"></span>' + label + '</span><strong>' + d.fmt(d.get(r)) + '</strong></div>').join('') +
          '<div class="t-hint">Click to filter to this month</div>';
        tip.hidden = false;
        positionTooltip(tip, container, (x(i) / W) * container.clientWidth, padT);
      });
      rect.addEventListener('mouseleave', () => { tip.hidden = true; });
      rect.addEventListener('click', () => {
        const y2 = Number(r.key.slice(0, 4)), mo = Number(r.key.slice(5, 7));
        if (state.range.key === r.key) clearRange(); else setRange(r.key, toISO(startOfMonth(y2, mo)), toISO(endOfMonth(y2, mo)));
        render();
      });
      svg.appendChild(rect);
    });

    container.style.position = 'relative';
    container.appendChild(svg);
  }

  function renderMonthlyBreakdown() {
    const rows = state.monthlyRows;
    $('#monthly-sub').textContent = rows.length + ' month' + (rows.length === 1 ? '' : 's');
    const thead = '<thead><tr><th></th>' + rows.map((r) => '<th class="th-num">' + escapeHtml(r.label) + '</th>').join('') + '</tr></thead>';
    const tbody = '<tbody>' + MONTHLY_BREAKDOWN_ROWS.map(([label, rawFn, fmtFn, direction]) => {
      const colors = heatRowColors(rows.map(rawFn), direction);
      const cells = rows.map((r, i) => {
        const bg = colors[i];
        const style = bg ? ' style="background:' + bg + ';color:#15201a"' : '';
        return '<td class="td-num num"' + style + '>' + fmtFn(r) + '</td>';
      }).join('');
      return '<tr><td>' + escapeHtml(label) + '</td>' + cells + '</tr>';
    }).join('') + '</tbody>';
    $('#monthly-table').innerHTML = thead + tbody;
  }

  function renderMonthlyTrend() {
    state.monthlyRows = monthlyRows();
    renderMonthlyTrendChart();
    renderMonthlyBreakdown();
  }

  // ================= donut chart: ad spend by platform =================
  function renderPieChart() {
    const container = $('#pie-chart');
    container.innerHTML = '';
    const rows = spendFor('platform');
    const google = rows.filter((r) => r.platform === 'Google').reduce((a, r) => a + r.spend, 0);
    const meta = rows.filter((r) => r.platform === 'Meta').reduce((a, r) => a + r.spend, 0);
    const total = google + meta;
    if (!total) { container.innerHTML = '<div class="empty-msg">No spend for this selection.</div>'; return; }
    const slices = [['Google', google, COLOR_GOOGLE], ['Meta', meta, COLOR_META]].filter(([, v]) => v > 0);
    const pf = state.filters.platform;

    const size = 220, cx = size / 2, cy = size / 2, rOuter = 92, rInner = 58;
    const svg = svgEl('svg', { viewBox: '0 0 ' + size + ' ' + size, width: size, height: size });
    let angle = -Math.PI / 2;
    const tip = ensureTooltip(container);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:22px;flex-wrap:wrap;justify-content:center';

    slices.forEach(([name, value, color]) => {
      const frac = value / total;
      const a0 = angle, a1 = angle + frac * Math.PI * 2;
      angle = a1;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p0o = [cx + rOuter * Math.cos(a0), cy + rOuter * Math.sin(a0)];
      const p1o = [cx + rOuter * Math.cos(a1), cy + rOuter * Math.sin(a1)];
      const p0i = [cx + rInner * Math.cos(a1), cy + rInner * Math.sin(a1)];
      const p1i = [cx + rInner * Math.cos(a0), cy + rInner * Math.sin(a0)];
      const d = frac >= 0.9999
        ? ['M', cx, cy - rOuter, 'A', rOuter, rOuter, 0, 1, 1, cx - 0.01, cy - rOuter, 'L', cx - 0.01, cy - rInner, 'A', rInner, rInner, 0, 1, 0, cx, cy - rInner, 'Z'].join(' ')
        : ['M', p0o.join(','), 'A', rOuter, rOuter, 0, large, 1, p1o.join(','), 'L', p0i.join(','), 'A', rInner, rInner, 0, large, 0, p1i.join(','), 'Z'].join(' ');
      const path = svgEl('path', { d, class: 'is-clickable', fill: color, stroke: 'var(--surface)', 'stroke-width': 2, opacity: pf && pf !== name ? 0.3 : 1 });
      path.addEventListener('mouseenter', (e) => {
        tip.innerHTML = '<div class="t-row"><span><span class="legend-swatch" style="background:' + color + ';display:inline-block;margin-right:5px"></span>' + name + '</span><strong>' + money(value) + ' (' + pct((value / total) * 100) + ')</strong></div><div class="t-hint">Click to filter to ' + name + '</div>';
        tip.hidden = false;
        const rect = container.getBoundingClientRect();
        positionTooltip(tip, container, e.clientX - rect.left, e.clientY - rect.top);
      });
      path.addEventListener('mousemove', (e) => { const rect = container.getBoundingClientRect(); positionTooltip(tip, container, e.clientX - rect.left, e.clientY - rect.top); });
      path.addEventListener('mouseleave', () => { tip.hidden = true; });
      path.addEventListener('click', () => { tip.hidden = true; toggleFilter('platform', name); });
      svg.appendChild(path);
    });

    const centerVal = svgEl('text', { class: 'pie-center-label', x: cx, y: cy - 2, 'font-size': 22 });
    centerVal.textContent = money(total);
    const centerSub = svgEl('text', { class: 'pie-center-sub', x: cx, y: cy + 16 });
    centerSub.textContent = 'total spend';
    svg.appendChild(centerVal); svg.appendChild(centerSub);

    const legend = document.createElement('div');
    legend.innerHTML = slices.map(([name, value, color]) =>
      '<button class="legend-item legend-btn' + (pf === name ? ' is-selected' : '') + (pf && pf !== name ? ' is-dim' : '') + '" data-platform="' + name + '" style="display:flex;margin-bottom:7px"><span class="legend-swatch" style="background:' + color + '"></span>' + name + ' &middot; ' + money(value) + '</button>'
    ).join('');

    container.style.position = 'relative';
    wrap.appendChild(svg); wrap.appendChild(legend);
    container.appendChild(wrap);
    container.appendChild(tip);
  }

  // ================= signed cases by ad =================
  function renderAds() {
    const cases = casesFor('ad');
    const selected = state.filters.ad;
    const byAd = new Map();
    for (const c of cases) byAd.set(adOf(c), (byAd.get(adOf(c)) || 0) + 1);
    const rows = [...byAd.entries()].sort((a, b) => b[1] - a[1]);
    $('#ad-sub').textContent = rows.length ? rows.length + ' ads · click a row to filter' : '';
    $('#ad-empty').hidden = rows.length > 0;
    const total = cases.length;
    const cls = (key) => 'is-clickable' + (selected === key ? ' is-selected' : selected ? ' is-dim' : '');
    $('#ad-body').innerHTML = rows.map(([ad, n]) => (
      '<tr class="' + cls(ad) + '" data-ad="' + escapeHtml(ad) + '"><td class="name-cell">' + escapeHtml(ad === NO_AD ? '(no ad listed)' : ad) + '</td>' +
      '<td class="td-num num">' + n.toLocaleString('en-US') + '</td><td class="td-num num">' + pct((n / total) * 100) + '</td></tr>'
    )).join('') + (rows.length ? '<tr class="row-total"><td>Total</td><td class="td-num num">' + total.toLocaleString('en-US') + '</td><td class="td-num num">100%</td></tr>' : '');
  }

  // ================= signed case details (secondary) =================
  function renderCasesTable(cases) {
    const q = state.search.trim().toLowerCase();
    const rows = cases
      .filter((c) => !q || (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q))
      .sort((a, b) => (b.conversionDate || '').localeCompare(a.conversionDate || ''));
    $('#lead-count').textContent = cases.length.toLocaleString('en-US');
    $('#range-label').textContent = rangeLabel();
    $('#leads-empty').hidden = rows.length > 0;
    $('#leads-body').innerHTML = rows.map((c) => {
      const days = c.intakeDate && c.conversionDate ? daysBetween(c.intakeDate, c.conversionDate) : null;
      return '<tr>' +
        '<td><div class="name-cell">' + escapeHtml(c.name || '(no name)') + '</div><div class="email-cell">' + escapeHtml(c.email) + '</div></td>' +
        '<td>' + escapeHtml(c.intakeDate || '—') + '</td>' +
        '<td>' + escapeHtml(c.conversionDate || '—') + '</td>' +
        '<td class="num">' + (days == null || days < 0 ? '—' : days) + '</td>' +
        '<td>' + escapeHtml(c.adName || '—') + '</td>' +
      '</tr>';
    }).join('');
  }

  function render() {
    const cases = casesFor();
    renderFilterBar();
    renderKpis(cases, spendFor(), leadsDailyFor());
    renderSpendChart();
    renderBarChart();
    renderMonthlyTrend();
    renderPieChart();
    renderAds();
    renderCasesTable(cases);
  }

  // ---- click handling: everything clickable is wired here by data attribute ----
  document.addEventListener('click', (e) => {
    const clear = e.target.closest('[data-clear]');
    if (clear) {
      const what = clear.dataset.clear;
      if (what === 'all') clearAll(); else if (what === 'range') clearRange(); else state.filters[what] = null;
      render();
      return;
    }
    if (e.target.closest('[data-tile]')) { clearAll(); render(); return; }
    const platform = e.target.closest('[data-platform]');
    if (platform) { toggleFilter('platform', platform.dataset.platform); return; }
    const adRow = e.target.closest('tr[data-ad]');
    if (adRow) { toggleFilter('ad', adRow.dataset.ad); return; }
  });

  $('#monthly-metrics').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const metric = btn.dataset.monthlyMetric;
    if (state.monthlyMetrics.has(metric)) state.monthlyMetrics.delete(metric); else state.monthlyMetrics.add(metric);
    btn.classList.toggle('is-active', state.monthlyMetrics.has(metric));
    renderMonthlyTrendChart();
  });

  // ---- date-range controls ----
  $('#quick-range').addEventListener('change', (e) => {
    const key = e.target.value;
    if (key === 'custom') { $('#range-start').focus(); return; }
    const { start, end } = computeRange(key);
    setRange(key, start, end);
    render();
  });
  function applyCustomRange() {
    const start = $('#range-start').value || null, end = $('#range-end').value || null;
    if (!start && !end) return;
    setRange('custom', start, end);
    render();
  }
  $('#range-start').addEventListener('change', applyCustomRange);
  $('#range-end').addEventListener('change', applyCustomRange);
  $('#range-clear').addEventListener('click', () => { clearAll(); render(); });

  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('#refresh-btn').addEventListener('click', () => {
    $('#refresh-btn').classList.add('is-spinning');
    fetchData().finally(() => setTimeout(() => $('#refresh-btn').classList.remove('is-spinning'), 400));
  });

  buildQuickRangeOptions(2025, 1);
  defaultRangeKey = 'all';
  clearRange();
  fetchData();
  setInterval(fetchData, 30000);
})();

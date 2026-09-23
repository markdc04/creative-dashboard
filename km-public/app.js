(function () {
  const $ = (sel) => document.querySelector(sel);
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const pct = (n) => (isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '0') + '%';
  const COLOR_GOOGLE = '#3987e5';
  const COLOR_META = '#d95926';
  const COLOR_LEADS = '#3987e5';
  const COLOR_CASES = '#199e70';

  const state = {
    cases: [], leadsDaily: [], googleDaily: [], metaDaily: [], settings: { feePerLead: 35, monthlyAdBudget: 20000 },
    search: '',
    range: { key: 'all', start: null, end: null },
  };

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
    if (start && end) return '· ' + start + ' to ' + end;
    return '';
  }

  async function fetchData() {
    try {
      const r = await fetch('/km-api/data', { cache: 'no-store' });
      if (!r.ok) throw new Error('bad status');
      const d = await r.json();
      state.cases = d.cases || [];
      state.leadsDaily = d.leadsDaily || [];
      state.googleDaily = d.googleDaily || [];
      state.metaDaily = d.metaDaily || [];
      state.settings = d.settings || state.settings;
      setLive(true);
    } catch (err) {
      setLive(false);
    }
    render();
  }

  function setLive(ok) {
    $('#live-text').textContent = ok ? 'Live \u2013 checked just now' : 'Connection lost \u2013 retrying\u2026';
    $('#live-pill').style.opacity = ok ? '1' : '.6';
  }

  function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }

  // Spend only exists from 2026-01-01, so leads/cases before the first spend day are left out —
  // otherwise all-time cost-per-lead would divide 2026 spend by 2025 leads too.
  function firstSpendDay() {
    const days = [...state.googleDaily, ...state.metaDaily].map((r) => r.date).sort();
    return days[0] || null;
  }
  function inWindow(dateStr) { const f = firstSpendDay(); return !f || (dateStr && dateStr >= f); }
  // Signed cases count on the day they signed (conversion date); leads on the day they came in.
  function filteredCases() { return state.cases.filter((c) => inWindow(c.conversionDate) && inRange(c.conversionDate)); }
  function filteredLeadsDaily() { return state.leadsDaily.filter((r) => inWindow(r.date) && inRange(r.date)); }
  function filteredGoogle() { return state.googleDaily.filter((r) => inRange(r.date)); }
  function filteredMeta() { return state.metaDaily.filter((r) => inRange(r.date)); }

  // The sheet's AD Budget is a monthly figure, so a range's budget is that amount spread over each
  // day's month (a full month gets exactly one month's budget; a week gets about a quarter of it).
  function adBudgetForRange() {
    const spendDays = [...state.googleDaily, ...state.metaDaily].map((r) => r.date).sort();
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

  function renderKpis(cases, googleDaily, metaDaily, leadsDaily) {
    const signed = cases.length;
    const leads = leadsDaily.reduce((a, r) => a + r.leads, 0);
    const googleSpend = googleDaily.reduce((a, r) => a + r.spend, 0);
    const metaSpend = metaDaily.reduce((a, r) => a + r.spend, 0);
    const totalSpend = googleSpend + metaSpend;
    const cpl = leads > 0 ? totalSpend / leads : 0;
    const costPerCase = signed > 0 ? totalSpend / signed : 0;
    const conversionRate = leads > 0 ? (signed / leads) * 100 : 0;

    const fee = leads * state.settings.feePerLead;
    const budget = adBudgetForRange();
    const totalCost = totalSpend + fee;
    const cpcWithFee = signed > 0 ? totalCost / signed : 0;
    const used = budget > 0 ? (totalSpend / budget) * 100 : 0;
    const budgetSub = budget > 0
      ? (totalSpend <= budget ? pct(used) + ' used \u00b7 ' + money(budget - totalSpend) + ' left' : money(totalSpend - budget) + ' over budget')
      : '';

    const tiles = [
      ['Total Leads', leads.toLocaleString('en-US'), ''],
      ['Signed Cases', signed.toLocaleString('en-US'), 'of ' + leads.toLocaleString('en-US') + ' leads'],
      ['Conversion Rate', pct(conversionRate), 'signed \u00f7 leads'],
      ['Cost / Lead', cpl ? money(cpl) : '\u2014', 'ad spend \u00f7 leads'],
      ['Ad Spend', money(totalSpend), money(googleSpend) + ' Google + ' + money(metaSpend) + ' Meta'],
      ['Marketing Fee', money(fee), leads.toLocaleString('en-US') + ' leads \u00d7 $' + state.settings.feePerLead + ' per lead'],
      ['Ad Budget', money(budget), budgetSub],
      ['Total Cost', money(totalCost), 'ad spend + marketing fee'],
      ['CPC (Cost / Case)', costPerCase ? money(costPerCase) : '\u2014', signed ? 'ad spend \u00f7 signed cases' : 'no signed cases yet'],
      ['CPC + Marketing Fee', cpcWithFee ? money(cpcWithFee) : '\u2014', signed ? 'total cost \u00f7 signed cases' : 'no signed cases yet'],
    ];
    $('#kpi-row').innerHTML = tiles.map(([label, value, sub]) =>
      '<div class="kpi"><div class="kpi-label">' + escapeHtml(label) + '</div>' +
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
  function renderSpendChart(googleDaily, metaDaily) {
    const container = $('#spend-chart');
    container.innerHTML = '';
    $('#spend-legend').innerHTML =
      '<span class="legend-item"><span class="legend-swatch legend-swatch--line" style="background:' + COLOR_GOOGLE + '"></span>Google</span>' +
      '<span class="legend-item"><span class="legend-swatch legend-swatch--line" style="background:' + COLOR_META + '"></span>Meta</span>';

    const byDate = new Map();
    for (const r of googleDaily) { if (!byDate.has(r.date)) byDate.set(r.date, { google: 0, meta: 0 }); byDate.get(r.date).google += r.spend; }
    for (const r of metaDaily) { if (!byDate.has(r.date)) byDate.set(r.date, { google: 0, meta: 0 }); byDate.get(r.date).meta += r.spend; }
    const dates = [...byDate.keys()].sort();
    if (!dates.length) { container.innerHTML = '<div class="empty-msg">No spend recorded yet for this range.</div>'; return; }

    const W = 900, H = 260, padL = 44, padR = 12, padT = 14, padB = 28;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxVal = niceMax(Math.max(...dates.map((d) => Math.max(byDate.get(d).google, byDate.get(d).meta))));
    const x = (i) => padL + (dates.length === 1 ? innerW / 2 : (i / (dates.length - 1)) * innerW);
    const y = (v) => padT + innerH - (v / maxVal) * innerH;

    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, style: 'display:block;overflow:visible' });

    // gridlines + y labels
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = (maxVal / steps) * i;
      const gy = y(v);
      svg.appendChild(svgEl('line', { class: 'viz-gridline', x1: padL, x2: W - padR, y1: gy, y2: gy }));
      const label = svgEl('text', { class: 'viz-axis-label', x: padL - 8, y: gy + 3, 'text-anchor': 'end' });
      label.textContent = '$' + Math.round(v).toLocaleString('en-US');
      svg.appendChild(label);
    }
    // x labels — about 6 evenly spaced
    const labelEvery = Math.max(1, Math.ceil(dates.length / 6));
    dates.forEach((d, i) => {
      if (i % labelEvery !== 0 && i !== dates.length - 1) return;
      const label = svgEl('text', { class: 'viz-axis-label', x: x(i), y: H - 6, 'text-anchor': 'middle' });
      label.textContent = d.slice(5);
      svg.appendChild(label);
    });

    function linePath(key) {
      return dates.map((d, i) => (i === 0 ? 'M' : 'L') + x(i) + ',' + y(byDate.get(d)[key])).join(' ');
    }
    svg.appendChild(svgEl('path', { d: linePath('google'), fill: 'none', stroke: COLOR_GOOGLE, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    svg.appendChild(svgEl('path', { d: linePath('meta'), fill: 'none', stroke: COLOR_META, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    const crosshair = svgEl('line', { class: 'viz-crosshair', x1: 0, x2: 0, y1: padT, y2: H - padB, visibility: 'hidden' });
    const dotG = svgEl('circle', { r: 4, fill: COLOR_GOOGLE, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
    const dotM = svgEl('circle', { r: 4, fill: COLOR_META, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(crosshair); svg.appendChild(dotG); svg.appendChild(dotM);

    const hitW = innerW / Math.max(1, dates.length - 1 || 1);
    const tip = ensureTooltip(container);
    dates.forEach((d, i) => {
      const rect = svgEl('rect', { class: 'bar-hover-rect', x: x(i) - hitW / 2, y: padT, width: hitW, height: innerH });
      rect.addEventListener('mouseenter', () => {
        const v = byDate.get(d);
        crosshair.setAttribute('x1', x(i)); crosshair.setAttribute('x2', x(i)); crosshair.setAttribute('visibility', 'visible');
        dotG.setAttribute('cx', x(i)); dotG.setAttribute('cy', y(v.google)); dotG.setAttribute('visibility', 'visible');
        dotM.setAttribute('cx', x(i)); dotM.setAttribute('cy', y(v.meta)); dotM.setAttribute('visibility', 'visible');
        tip.innerHTML = '<div class="t-date">' + d + '</div>' +
          '<div class="t-row"><span><span class="legend-swatch" style="background:' + COLOR_GOOGLE + ';display:inline-block;margin-right:5px"></span>Google</span><strong>' + money(v.google) + '</strong></div>' +
          '<div class="t-row"><span><span class="legend-swatch" style="background:' + COLOR_META + ';display:inline-block;margin-right:5px"></span>Meta</span><strong>' + money(v.meta) + '</strong></div>';
        tip.hidden = false;
        positionTooltip(tip, container, (x(i) / W) * container.clientWidth, (y(Math.max(v.google, v.meta)) / H) * H);
      });
      rect.addEventListener('mouseleave', () => { crosshair.setAttribute('visibility', 'hidden'); dotG.setAttribute('visibility', 'hidden'); dotM.setAttribute('visibility', 'hidden'); tip.hidden = true; });
      svg.appendChild(rect);
    });

    container.style.position = 'relative';
    container.appendChild(svg);
  }

  // ================= grouped bar chart: leads vs signed cases per month =================
  function renderBarChart(cases, leadsDaily) {
    const container = $('#bar-chart');
    container.innerHTML = '';
    $('#bar-legend').innerHTML =
      '<span class="legend-item"><span class="legend-swatch" style="background:' + COLOR_LEADS + '"></span>Leads</span>' +
      '<span class="legend-item"><span class="legend-swatch" style="background:' + COLOR_CASES + '"></span>Signed Cases</span>';

    const byMonth = new Map();
    const bump = (key, field, n) => { if (!byMonth.has(key)) byMonth.set(key, { leads: 0, cases: 0 }); byMonth.get(key)[field] += n; };
    for (const r of leadsDaily) bump(r.date.slice(0, 7), 'leads', r.leads);
    for (const c of cases) if (c.conversionDate) bump(c.conversionDate.slice(0, 7), 'cases', 1);
    const months = [...byMonth.keys()].sort();
    if (!months.length) { container.innerHTML = '<div class="empty-msg">Nothing in this range.</div>'; return; }

    const W = 560, H = 260, padL = 34, padR = 10, padT = 14, padB = 30;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxVal = niceMax(Math.max(...months.map((m) => Math.max(byMonth.get(m).leads, byMonth.get(m).cases))));
    const groupW = innerW / months.length;
    const barW = Math.min(22, groupW * 0.32);
    const y0 = padT + innerH;
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
      const leadsX = cx - barW - gap / 2, casesX = cx + gap / 2;
      const leadsH = innerH - (yOf(v.leads) - padT), casesH = innerH - (yOf(v.cases) - padT);

      const rLeads = svgEl('rect', { x: leadsX, y: yOf(v.leads), width: barW, height: leadsH, rx: 3, fill: COLOR_LEADS });
      const rCases = svgEl('rect', { x: casesX, y: yOf(v.cases), width: barW, height: casesH, rx: 3, fill: COLOR_CASES });
      svg.appendChild(rLeads); svg.appendChild(rCases);

      const label = svgEl('text', { class: 'viz-axis-label', x: cx, y: H - 8, 'text-anchor': 'middle' });
      label.textContent = monthName(m);
      svg.appendChild(label);

      const hit = svgEl('rect', { class: 'bar-hover-rect', x: padL + groupW * i, y: padT, width: groupW, height: innerH });
      hit.addEventListener('mouseenter', (e) => {
        tip.innerHTML = '<div class="t-date">' + monthName(m) + ' ' + m.slice(0, 4) + '</div>' +
          '<div class="t-row"><span><span class="legend-swatch" style="background:' + COLOR_LEADS + ';display:inline-block;margin-right:5px"></span>Leads</span><strong>' + v.leads + '</strong></div>' +
          '<div class="t-row"><span><span class="legend-swatch" style="background:' + COLOR_CASES + ';display:inline-block;margin-right:5px"></span>Signed Cases</span><strong>' + v.cases + '</strong></div>';
        tip.hidden = false;
        positionTooltip(tip, container, (cx / W) * container.clientWidth, (yOf(Math.max(v.leads, v.cases)) / H) * H);
      });
      hit.addEventListener('mouseleave', () => { tip.hidden = true; });
      svg.appendChild(hit);
    });

    container.style.position = 'relative';
    container.appendChild(svg);
  }

  // ================= donut chart: ad spend by platform =================
  function renderPieChart(googleDaily, metaDaily) {
    const container = $('#pie-chart');
    container.innerHTML = '';
    const google = googleDaily.reduce((a, r) => a + r.spend, 0);
    const meta = metaDaily.reduce((a, r) => a + r.spend, 0);
    const total = google + meta;
    if (!total) { container.innerHTML = '<div class="empty-msg">No spend in this range.</div>'; return; }
    const slices = [['Google', google, COLOR_GOOGLE], ['Meta', meta, COLOR_META]].filter(([, v]) => v > 0);
    const colors = slices.map((x) => x[2]);

    const size = 220, cx = size / 2, cy = size / 2, rOuter = 92, rInner = 58;
    const svg = svgEl('svg', { viewBox: '0 0 ' + size + ' ' + size, width: size, height: size });
    let angle = -Math.PI / 2;
    const tip = ensureTooltip(container);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:22px;flex-wrap:wrap;justify-content:center';

    slices.forEach(([status, count], i) => {
      const frac = count / total;
      const a0 = angle, a1 = angle + frac * Math.PI * 2;
      angle = a1;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p0o = [cx + rOuter * Math.cos(a0), cy + rOuter * Math.sin(a0)];
      const p1o = [cx + rOuter * Math.cos(a1), cy + rOuter * Math.sin(a1)];
      const p0i = [cx + rInner * Math.cos(a1), cy + rInner * Math.sin(a1)];
      const p1i = [cx + rInner * Math.cos(a0), cy + rInner * Math.sin(a0)];
      const d = ['M', p0o.join(','), 'A', rOuter, rOuter, 0, large, 1, p1o.join(','), 'L', p0i.join(','), 'A', rInner, rInner, 0, large, 0, p1i.join(','), 'Z'].join(' ');
      const path = svgEl('path', { d, fill: colors[i], stroke: 'var(--surface)', 'stroke-width': 2 });
      path.addEventListener('mouseenter', (e) => {
        tip.innerHTML = '<div class="t-row"><span><span class="legend-swatch" style="background:' + colors[i] + ';display:inline-block;margin-right:5px"></span>' + escapeHtml(status) + '</span><strong>' + count + ' (' + pct((count / total) * 100) + ')</strong></div>';
        tip.hidden = false;
        const rect = container.getBoundingClientRect();
        positionTooltip(tip, container, e.clientX - rect.left, e.clientY - rect.top);
      });
      path.addEventListener('mousemove', (e) => {
        const rect = container.getBoundingClientRect();
        positionTooltip(tip, container, e.clientX - rect.left, e.clientY - rect.top);
      });
      path.addEventListener('mouseleave', () => { tip.hidden = true; });
      svg.appendChild(path);
    });

    const centerVal = svgEl('text', { class: 'pie-center-label', x: cx, y: cy - 2, 'font-size': 22 });
    centerVal.textContent = money(total);
    const centerSub = svgEl('text', { class: 'pie-center-sub', x: cx, y: cy + 16 });
    centerSub.textContent = 'total spend';
    svg.appendChild(centerVal); svg.appendChild(centerSub);

    const legend = document.createElement('div');
    legend.innerHTML = slices.map(([status, count], i) =>
      '<div class="legend-item" style="margin-bottom:7px"><span class="legend-swatch" style="background:' + colors[i] + '"></span>' +
      escapeHtml(status) + ' &middot; ' + money(count) + '</div>'
    ).join('');

    container.style.position = 'relative';
    wrap.appendChild(svg); wrap.appendChild(legend);
    container.appendChild(wrap);
    container.appendChild(tip);
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
        '<td>' + escapeHtml(c.intakeDate || '\u2014') + '</td>' +
        '<td>' + escapeHtml(c.conversionDate || '\u2014') + '</td>' +
        '<td class="num">' + (days == null || days < 0 ? '\u2014' : days) + '</td>' +
        '<td>' + escapeHtml(c.adName || '\u2014') + '</td>' +
      '</tr>';
    }).join('');
  }

  function render() {
    const cases = filteredCases();
    const googleDaily = filteredGoogle();
    const metaDaily = filteredMeta();
    const leadsDaily = filteredLeadsDaily();
    renderKpis(cases, googleDaily, metaDaily, leadsDaily);
    renderSpendChart(googleDaily, metaDaily);
    renderBarChart(cases, leadsDaily);
    renderPieChart(googleDaily, metaDaily);
    renderCasesTable(cases);
  }

  // ---- date-range controls ----
  $('#quick-range').addEventListener('change', (e) => {
    const key = e.target.value;
    if (key === 'custom') { $('#range-start').focus(); return; }
    const { start, end } = computeRange(key);
    state.range = { key, start, end };
    $('#range-start').value = start || ''; $('#range-end').value = end || '';
    render();
  });
  function applyCustomRange() {
    const start = $('#range-start').value || null, end = $('#range-end').value || null;
    if (!start && !end) return;
    state.range = { key: 'custom', start, end };
    $('#quick-range').value = 'custom';
    render();
  }
  $('#range-start').addEventListener('change', applyCustomRange);
  $('#range-end').addEventListener('change', applyCustomRange);
  $('#range-clear').addEventListener('click', () => {
    $('#quick-range').value = 'all';
    $('#range-start').value = ''; $('#range-end').value = '';
    state.range = { key: 'all', start: null, end: null };
    render();
  });

  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('#refresh-btn').addEventListener('click', () => {
    $('#refresh-btn').classList.add('is-spinning');
    fetchData().finally(() => setTimeout(() => $('#refresh-btn').classList.remove('is-spinning'), 400));
  });

  fetchData();
  setInterval(fetchData, 30000);
})();

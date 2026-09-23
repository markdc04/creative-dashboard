(function () {
  const $ = (sel) => document.querySelector(sel);
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const pct = (n) => (isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '0') + '%';
  const COLOR_GOOGLE = '#3987e5';
  const COLOR_META = '#d95926';
  const COLOR_LEADS = '#3987e5';
  const COLOR_CASES = '#199e70';
  const STATUS_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];

  const state = {
    leads: [], googleDaily: [], metaDaily: [], campaignSpend: [], campaignLeads: [],
    search: '', statusFilter: 'all',
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
      const r = await fetch('/sasooness-api/data', { cache: 'no-store' });
      const d = await r.json();
      state.leads = d.leads || [];
      state.googleDaily = d.googleDaily || [];
      state.metaDaily = d.metaDaily || [];
      state.campaignSpend = d.campaignSpend || [];
      state.campaignLeads = d.campaignLeads || [];
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

  function statusClass(status) {
    const s = (status || '').toLowerCase();
    if (s.includes('sign') || s === 'client') return 'status-pill--signed';
    if (s.includes('reject')) return 'status-pill--rejected';
    return 'status-pill--other';
  }
  function isSignedStatus(status) { return (status || '').trim() === 'Signed Up' || (status || '').trim() === 'Client'; }

  function matchesSearch(lead) {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    return [lead.name, lead.email, lead.phone].some((v) => (v || '').toLowerCase().includes(q));
  }

  // ---- filtered views, recomputed on every render ----
  function filteredLeads() { return state.leads.filter((l) => inRange(l.createdDate)); }
  function filteredGoogle() { return state.googleDaily.filter((r) => inRange(r.date)); }
  function filteredMeta() { return state.metaDaily.filter((r) => inRange(r.date)); }

  function statusGroups(leads) {
    const groups = new Map();
    for (const l of leads) {
      const key = l.status || '(blank)';
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    return [...groups.entries()].sort((a, b) => b[1] - a[1]);
  }

  // ================= KPI row =================
  function renderKpis(leads, googleDaily, metaDaily) {
    const total = leads.length;
    const signed = leads.filter((l) => isSignedStatus(l.status)).length;
    const rejected = leads.filter((l) => statusClass(l.status) === 'status-pill--rejected').length;
    const googleSpend = googleDaily.reduce((a, r) => a + r.spend, 0);
    const metaSpend = metaDaily.reduce((a, r) => a + r.spend, 0);
    const totalSpend = googleSpend + metaSpend;
    const cpl = total > 0 ? totalSpend / total : 0;
    const costPerCase = signed > 0 ? totalSpend / signed : 0;
    const conversionRate = total > 0 ? (signed / total) * 100 : 0;

    const tiles = [
      ['Total Leads', total.toLocaleString('en-US'), rejected ? rejected.toLocaleString('en-US') + ' rejected' : ''],
      ['Signed Cases', signed.toLocaleString('en-US'), 'of ' + total.toLocaleString('en-US') + ' leads'],
      ['Conversion Rate', pct(conversionRate), 'signed ÷ leads'],
      ['Total Ad Spend', money(totalSpend), money(googleSpend) + ' Google + ' + money(metaSpend) + ' Meta'],
      ['Cost / Lead', money(cpl), 'spend ÷ leads'],
      ['Cost / Case', costPerCase ? money(costPerCase) : '—', signed ? 'spend ÷ signed cases' : 'no signed cases yet'],
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
  function renderBarChart(leads) {
    const container = $('#bar-chart');
    container.innerHTML = '';
    $('#bar-legend').innerHTML =
      '<span class="legend-item"><span class="legend-swatch" style="background:' + COLOR_LEADS + '"></span>Leads</span>' +
      '<span class="legend-item"><span class="legend-swatch" style="background:' + COLOR_CASES + '"></span>Signed Cases</span>';

    const byMonth = new Map();
    for (const l of leads) {
      if (!l.createdDate) continue;
      const key = l.createdDate.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, { leads: 0, cases: 0 });
      byMonth.get(key).leads++;
      if (isSignedStatus(l.status)) byMonth.get(key).cases++;
    }
    const months = [...byMonth.keys()].sort();
    if (!months.length) { container.innerHTML = '<div class="empty-msg">No leads in this range.</div>'; return; }

    const W = 560, H = 260, padL = 34, padR = 10, padT = 14, padB = 30;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxVal = niceMax(Math.max(...months.map((m) => byMonth.get(m).leads)));
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
        tip.innerHTML = '<div class="t-date">' + monthName(m) + ' 2026</div>' +
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

  // ================= donut chart: leads by status =================
  function renderPieChart(leads) {
    const container = $('#pie-chart');
    container.innerHTML = '';
    if (!leads.length) { container.innerHTML = '<div class="empty-msg">No leads in this range.</div>'; return; }

    const groups = statusGroups(leads);
    const top = groups.slice(0, 4);
    const otherCount = groups.slice(4).reduce((a, [, c]) => a + c, 0);
    const slices = otherCount > 0 ? [...top, ['Other', otherCount]] : top;
    const colors = STATUS_COLORS;
    const total = leads.length;

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
      const path = svgEl('path', { d, fill: colors[i % colors.length], stroke: 'var(--surface)', 'stroke-width': 2 });
      path.addEventListener('mouseenter', (e) => {
        tip.innerHTML = '<div class="t-row"><span><span class="legend-swatch" style="background:' + colors[i % colors.length] + ';display:inline-block;margin-right:5px"></span>' + escapeHtml(status) + '</span><strong>' + count + ' (' + pct((count / total) * 100) + ')</strong></div>';
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

    const centerVal = svgEl('text', { class: 'pie-center-label', x: cx, y: cy - 2, 'font-size': 26 });
    centerVal.textContent = total.toLocaleString('en-US');
    const centerSub = svgEl('text', { class: 'pie-center-sub', x: cx, y: cy + 16 });
    centerSub.textContent = 'leads';
    svg.appendChild(centerVal); svg.appendChild(centerSub);

    const legend = document.createElement('div');
    legend.innerHTML = slices.map(([status, count], i) =>
      '<div class="legend-item" style="margin-bottom:7px"><span class="legend-swatch" style="background:' + colors[i % colors.length] + '"></span>' +
      escapeHtml(status) + ' &middot; ' + count + '</div>'
    ).join('');

    container.style.position = 'relative';
    wrap.appendChild(svg); wrap.appendChild(legend);
    container.appendChild(wrap);
    container.appendChild(tip);
  }

  // ================= lead details table (secondary) =================
  function renderChips(leads) {
    const groups = statusGroups(leads);
    const chips = ['<button class="chip' + (state.statusFilter === 'all' ? ' is-active' : '') + '" data-status="all">All<span class="n">' + leads.length + '</span></button>']
      .concat(groups.map(([status, count]) =>
        '<button class="chip' + (state.statusFilter === status ? ' is-active' : '') + '" data-status="' + escapeHtml(status) + '">' + escapeHtml(status) + '<span class="n">' + count + '</span></button>'
      ));
    $('#status-chips').innerHTML = chips.join('');
    $('#status-chips').querySelectorAll('.chip').forEach((btn) => {
      btn.addEventListener('click', () => { state.statusFilter = btn.dataset.status; render(); });
    });
  }

  function renderLeadsTable(leads) {
    const rows = leads
      .filter((l) => (state.statusFilter === 'all' || (l.status || '(blank)') === state.statusFilter) && matchesSearch(l))
      .sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));

    $('#lead-count').textContent = leads.length.toLocaleString('en-US');
    $('#range-label').textContent = rangeLabel();
    $('#leads-empty').hidden = rows.length > 0;
    $('#leads-body').innerHTML = rows.map((l) => (
      '<tr>' +
        '<td><div class="name-cell">' + escapeHtml(l.name || '(no name)') + '</div><div class="email-cell">' + escapeHtml(l.email) + (l.phone ? ' &middot; ' + escapeHtml(l.phone) : '') + '</div></td>' +
        '<td><span class="status-pill ' + statusClass(l.status) + '">' + escapeHtml(l.status || '—') + '</span>' + (l.subStatus ? '<div class="kpi-sub" style="margin-top:4px">' + escapeHtml(l.subStatus) + '</div>' : '') + '</td>' +
        '<td>' + escapeHtml(l.caseType || '—') + '</td>' +
        '<td>' + escapeHtml(l.createdDate || '—') + '</td>' +
        '<td>' + escapeHtml(l.signedUpDate || '—') + '</td>' +
        '<td>' + escapeHtml(l.state || '—') + '</td>' +
        '<td>' + escapeHtml(l.severity || '—') + '</td>' +
        '<td>' + escapeHtml(l.marketingSource || '—') + '</td>' +
        '<td><span class="source-tag">' + escapeHtml(l.channel || 'CRM only') + '</span></td>' +
      '</tr>'
    )).join('');
  }

  // ================= performance by campaign =================
  function renderCampaigns() {
    const spendRows = state.campaignSpend.filter((r) => inRange(r.date));
    const leadRows = state.campaignLeads.filter((r) => inRange(r.date));
    const byCampaign = new Map();
    const get = (name, platform) => {
      if (!byCampaign.has(name)) byCampaign.set(name, { name, platform: platform || '', spend: 0, leads: 0, first: '9999', last: '' });
      const row = byCampaign.get(name);
      if (platform && !row.platform) row.platform = platform;
      return row;
    };
    for (const r of spendRows) {
      const row = get(r.campaign, r.platform);
      row.spend += r.spend;
      if (r.date < row.first) row.first = r.date;
      if (r.date > row.last) row.last = r.date;
    }
    let unattributed = 0;
    for (const r of leadRows) { if (!r.campaign) unattributed++; else get(r.campaign).leads++; }

    const rows = [...byCampaign.values()].filter((r) => r.spend > 0 || r.leads > 0).sort((a, b) => b.spend - a.spend);
    const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
    const totalLeads = rows.reduce((s, r) => s + r.leads, 0) + unattributed;
    $('#campaign-sub').textContent = rows.length ? rows.length + ' campaigns' : '';
    $('#campaign-empty').hidden = rows.length > 0 || unattributed > 0;
    if (!rows.length && !unattributed) { $('#campaign-body').innerHTML = ''; return; }

    const tag = (p) => p ? '<span class="platform-tag platform-tag--' + p.toLowerCase() + '">' + escapeHtml(p) + '</span>' : '\u2014';
    let html = rows.map((r) => (
      '<tr>' +
        '<td><div class="name-cell">' + escapeHtml(r.name) + '</div>' + (r.first <= r.last ? '<div class="email-cell">' + escapeHtml(r.first) + ' \u2192 ' + escapeHtml(r.last) + '</div>' : '') + '</td>' +
        '<td>' + tag(r.platform) + '</td>' +
        '<td class="td-num num">' + money(r.spend) + '</td>' +
        '<td class="td-num num">' + r.leads.toLocaleString('en-US') + '</td>' +
        '<td class="td-num num">' + (r.leads > 0 && r.spend > 0 ? money(r.spend / r.leads) : '\u2014') + '</td>' +
        '<td class="td-num num">' + (totalSpend > 0 ? pct((r.spend / totalSpend) * 100) : '\u2014') + '</td>' +
      '</tr>'
    )).join('');
    if (unattributed > 0) {
      html += '<tr class="row-muted"><td><div class="name-cell">No campaign tag</div><div class="email-cell">leads without a UTM campaign</div></td><td>\u2014</td><td class="td-num num">\u2014</td><td class="td-num num">' + unattributed.toLocaleString('en-US') + '</td><td class="td-num num">\u2014</td><td class="td-num num">\u2014</td></tr>';
    }
    html += '<tr class="row-total"><td>Total</td><td></td><td class="td-num num">' + money(totalSpend) + '</td><td class="td-num num">' + totalLeads.toLocaleString('en-US') + '</td><td class="td-num num">' + (totalLeads > 0 && totalSpend > 0 ? money(totalSpend / totalLeads) : '\u2014') + '</td><td class="td-num num">' + (totalSpend > 0 ? '100%' : '\u2014') + '</td></tr>';
    $('#campaign-body').innerHTML = html;
  }

  // ================= leads by source (OG / Lead Prosper AZ / Lead Prosper WA) =================
  const SOURCES = ['OG', 'Lead Prosper AZ', 'Lead Prosper WA'];
  function renderSources(leads) {
    const groups = new Map(SOURCES.map((s) => [s, []]));
    groups.set('Other', []);
    for (const l of leads) groups.get(SOURCES.includes(l.channel) ? l.channel : 'Other').push(l);
    const line = (name, list, muted) => {
      const signed = list.filter((l) => isSignedStatus(l.status)).length;
      const rejected = list.filter((l) => statusClass(l.status) === 'status-pill--rejected').length;
      return '<tr' + (muted ? ' class="row-muted"' : '') + '><td class="name-cell">' + escapeHtml(name) + '</td>' +
        '<td class="td-num num">' + list.length.toLocaleString('en-US') + '</td>' +
        '<td class="td-num num">' + signed.toLocaleString('en-US') + '</td>' +
        '<td class="td-num num">' + (list.length ? pct((signed / list.length) * 100) : '\u2014') + '</td>' +
        '<td class="td-num num">' + rejected.toLocaleString('en-US') + '</td></tr>';
    };
    let html = '';
    for (const [name, list] of groups) html += line(name, list, list.length === 0);
    const signedAll = leads.filter((l) => isSignedStatus(l.status)).length;
    const rejectedAll = leads.filter((l) => statusClass(l.status) === 'status-pill--rejected').length;
    html += '<tr class="row-total"><td>Total</td><td class="td-num num">' + leads.length.toLocaleString('en-US') + '</td><td class="td-num num">' + signedAll.toLocaleString('en-US') + '</td><td class="td-num num">' + (leads.length ? pct((signedAll / leads.length) * 100) : '\u2014') + '</td><td class="td-num num">' + rejectedAll.toLocaleString('en-US') + '</td></tr>';
    $('#source-body').innerHTML = html;
  }

  function render() {
    const leads = filteredLeads();
    const googleDaily = filteredGoogle();
    const metaDaily = filteredMeta();
    renderKpis(leads, googleDaily, metaDaily);
    renderSpendChart(googleDaily, metaDaily);
    renderBarChart(leads);
    renderPieChart(leads);
    renderCampaigns();
    renderSources(leads);
    renderChips(leads);
    renderLeadsTable(leads);
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

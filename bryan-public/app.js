(function () {
  const $ = (sel) => document.querySelector(sel);
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const pct = (n) => (isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '0') + '%';
  const COLOR_SPEND = '#3987e5';
  const COLOR_LEADS = '#3987e5';
  const COLOR_SIGNED = '#199e70';
  const CAMPAIGN_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];

  const state = {
    leads: [], walker: { campaigns: [], leadsDaily: [], spendDaily: [] },
    search: '',
    range: { key: 'all', start: null, end: null },
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---- date range (same math as the main creative dashboard) ----
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
    if (start && end) return '· ' + (start === end ? start : start + ' to ' + end);
    return '';
  }
  function setRange(key, start, end) {
    state.range = { key, start, end };
    const opt = document.querySelector(`#quick-range option[value="${key}"]`);
    $('#quick-range').value = opt ? key : 'custom';
    $('#range-start').value = start || '';
    $('#range-end').value = end || '';
  }

  async function fetchData() {
    try {
      const r = await fetch('/bryan-api/data', { cache: 'no-store' });
      if (!r.ok) throw new Error('bad status');
      const d = await r.json();
      state.leads = d.leads || [];
      state.walker = d.walker || state.walker;
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

  function isSigned(status) { return status === 'Signed'; }
  function statusClass(status) {
    if (status === 'Signed') return 'status-pill--signed';
    if (status === 'Rejected') return 'status-pill--rejected';
    return 'status-pill--other';
  }
  function matchesSearch(l) {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    return [l.name, l.email, l.phone].some((v) => (v || '').toLowerCase().includes(q));
  }
  function leadsFor(ignoreDate) { return state.leads.filter((l) => ignoreDate || inRange(l.createdDate)); }

  // What Bryan's leads cost in the shared campaigns, day by day. A lead's cost lands on the day
  // it was created: that day's campaign spend divided by every lead Walker logged from that
  // campaign that day (any buyer), times the leads that went to Bryan that day.
  function dailyDeduction(leads) {
    const sent = new Map(); // campaignId|date -> count
    for (const l of leads) {
      const o = l.origin;
      if (!o || !o.campaignId || !l.createdDate) continue;
      const key = o.campaignId + '|' + l.createdDate;
      sent.set(key, (sent.get(key) || 0) + 1);
    }
    const nameOf = new Map(state.walker.campaigns.map((c) => [c.campaignId, c.name]));
    const days = [...sent.entries()].map(([key, n]) => {
      const [campaignId, date] = key.split('|');
      const spend = state.walker.spendDaily.filter((r) => r.campaignId === campaignId && r.date === date).reduce((a, r) => a + r.spend, 0);
      const walkerLeads = state.walker.leadsDaily.filter((r) => r.campaignId === campaignId && r.date === date).reduce((a, r) => a + r.leads, 0);
      const cpl = walkerLeads > 0 ? spend / walkerLeads : 0;
      return { campaignId, date, name: nameOf.get(campaignId) || campaignId, n, spend, walkerLeads, cpl, deduct: n * cpl };
    }).sort((a, b) => b.date.localeCompare(a.date));
    return { days, total: days.reduce((a, d) => a + d.deduct, 0) };
  }

  // ================= KPI row =================
  function renderKpis(leads) {
    const total = leads.length;
    const signed = leads.filter((l) => isSigned(l.status)).length;
    const rejected = leads.filter((l) => l.status === 'Rejected').length;
    const conversionRate = total > 0 ? (signed / total) * 100 : 0;
    const { total: spend } = dailyDeduction(leads);
    const cpl = total > 0 && spend > 0 ? spend / total : 0;
    const costPerCase = signed > 0 && spend > 0 ? spend / signed : 0;
    const dash = '—';

    const tiles = [
      ['Total Leads', total.toLocaleString('en-US'), rejected ? rejected.toLocaleString('en-US') + ' rejected' : ''],
      ['Signed', signed.toLocaleString('en-US'), 'of ' + total.toLocaleString('en-US') + ' leads'],
      ['Conversion Rate', pct(conversionRate), 'signed ÷ leads'],
      ['Ad Spend', money(spend), 'Bryan’s share of the shared campaigns'],
      ['Cost / Lead', cpl ? money(cpl) : dash, 'ad spend ÷ leads'],
      ['Cost / Signed', costPerCase ? money(costPerCase) : dash, signed ? 'ad spend ÷ signed leads' : 'no signed leads yet'],
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

  // ================= line chart: Bryan's daily ad spend =================
  function renderSpendChart(days) {
    const container = $('#spend-chart');
    container.innerHTML = '';
    $('#spend-legend').innerHTML = '<span class="legend-item"><span class="legend-swatch legend-swatch--line" style="background:' + COLOR_SPEND + '"></span>Ad spend</span>';
    const byDate = new Map(days.map((d) => [d.date, d.deduct]));
    const dates = [...byDate.keys()].sort();
    if (!dates.length) { container.innerHTML = '<div class="empty-msg">No spend recorded for this range.</div>'; return; }

    const W = 900, H = 260, padL = 44, padR = 12, padT = 14, padB = 28;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxVal = niceMax(Math.max(...dates.map((d) => byDate.get(d))));
    const x = (i) => padL + (dates.length === 1 ? innerW / 2 : (i / (dates.length - 1)) * innerW);
    const y = (v) => padT + innerH - (v / maxVal) * innerH;

    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, style: 'display:block;overflow:visible' });
    for (let i = 0; i <= 4; i++) {
      const v = (maxVal / 4) * i, gy = y(v);
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
    const path = dates.map((d, i) => (i === 0 ? 'M' : 'L') + x(i) + ',' + y(byDate.get(d))).join(' ');
    svg.appendChild(svgEl('path', { d: path, fill: 'none', stroke: COLOR_SPEND, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    const crosshair = svgEl('line', { class: 'viz-crosshair', x1: 0, x2: 0, y1: padT, y2: H - padB, visibility: 'hidden' });
    const dot = svgEl('circle', { r: 4, fill: COLOR_SPEND, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(crosshair); svg.appendChild(dot);
    const hitW = innerW / Math.max(1, dates.length - 1 || 1);
    const tip = ensureTooltip(container);
    dates.forEach((d, i) => {
      const rect = svgEl('rect', { class: 'bar-hover-rect', x: x(i) - hitW / 2, y: padT, width: hitW, height: innerH });
      rect.addEventListener('mouseenter', () => {
        const v = byDate.get(d);
        crosshair.setAttribute('x1', x(i)); crosshair.setAttribute('x2', x(i)); crosshair.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(v)); dot.setAttribute('visibility', 'visible');
        tip.innerHTML = '<div class="t-date">' + d + '</div><div class="t-row"><span>Ad spend</span><strong>' + money(v) + '</strong></div>';
        tip.hidden = false;
        positionTooltip(tip, container, (x(i) / W) * container.clientWidth, y(v));
      });
      rect.addEventListener('mouseleave', () => { crosshair.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; });
      svg.appendChild(rect);
    });
    container.style.position = 'relative';
    container.appendChild(svg);
  }

  // ================= grouped bar chart: leads vs signed per month =================
  function renderBarChart(leads) {
    const container = $('#bar-chart');
    container.innerHTML = '';
    $('#bar-legend').innerHTML =
      '<span class="legend-item"><span class="legend-swatch" style="background:' + COLOR_LEADS + '"></span>Leads</span>' +
      '<span class="legend-item"><span class="legend-swatch" style="background:' + COLOR_SIGNED + '"></span>Signed</span>';
    const byMonth = new Map();
    for (const l of leads) {
      if (!l.createdDate) continue;
      const key = l.createdDate.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, { leads: 0, signed: 0 });
      byMonth.get(key).leads++;
      if (isSigned(l.status)) byMonth.get(key).signed++;
    }
    const months = [...byMonth.keys()].sort();
    if (!months.length) { container.innerHTML = '<div class="empty-msg">No leads in this range.</div>'; return; }

    const W = 560, H = 260, padL = 34, padR = 10, padT = 14, padB = 30;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxVal = niceMax(Math.max(...months.map((m) => byMonth.get(m).leads)));
    const groupW = innerW / months.length;
    const barW = Math.min(22, groupW * 0.32);
    const yOf = (v) => padT + innerH - (v / maxVal) * innerH;

    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, style: 'display:block;overflow:visible' });
    for (let i = 0; i <= 4; i++) {
      const v = (maxVal / 4) * i, gy = yOf(v);
      svg.appendChild(svgEl('line', { class: 'viz-gridline', x1: padL, x2: W - padR, y1: gy, y2: gy }));
      const label = svgEl('text', { class: 'viz-axis-label', x: padL - 6, y: gy + 3, 'text-anchor': 'end' });
      label.textContent = Math.round(v);
      svg.appendChild(label);
    }
    const tip = ensureTooltip(container);
    const monthName = (m) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleDateString('en-US', { month: 'short' });
    months.forEach((m, i) => {
      const cx = padL + groupW * i + groupW / 2, v = byMonth.get(m), gap = 3;
      svg.appendChild(svgEl('rect', { x: cx - barW - gap / 2, y: yOf(v.leads), width: barW, height: innerH - (yOf(v.leads) - padT), rx: 3, fill: COLOR_LEADS }));
      svg.appendChild(svgEl('rect', { x: cx + gap / 2, y: yOf(v.signed), width: barW, height: innerH - (yOf(v.signed) - padT), rx: 3, fill: COLOR_SIGNED }));
      const label = svgEl('text', { class: 'viz-axis-label', x: cx, y: H - 8, 'text-anchor': 'middle' });
      label.textContent = monthName(m);
      svg.appendChild(label);
      const hit = svgEl('rect', { class: 'bar-hover-rect', x: padL + groupW * i, y: padT, width: groupW, height: innerH });
      hit.addEventListener('mouseenter', () => {
        tip.innerHTML = '<div class="t-date">' + monthName(m) + ' ' + m.slice(0, 4) + '</div>' +
          '<div class="t-row"><span>Leads</span><strong>' + v.leads + '</strong></div>' +
          '<div class="t-row"><span>Signed</span><strong>' + v.signed + '</strong></div>';
        tip.hidden = false;
        positionTooltip(tip, container, (cx / W) * container.clientWidth, yOf(v.leads));
      });
      hit.addEventListener('mouseleave', () => { tip.hidden = true; });
      svg.appendChild(hit);
    });
    container.style.position = 'relative';
    container.appendChild(svg);
  }

  // ================= donut chart: leads by campaign =================
  function renderPieChart(leads) {
    const container = $('#pie-chart');
    container.innerHTML = '';
    const byCampaign = new Map();
    let untraced = 0;
    for (const l of leads) {
      const name = l.origin && l.origin.campaignName;
      if (!name) { untraced++; continue; }
      byCampaign.set(name, (byCampaign.get(name) || 0) + 1);
    }
    const total = leads.length;
    if (!total) { container.innerHTML = '<div class="empty-msg">No leads in this range.</div>'; return; }
    const slices = [...byCampaign.entries()].sort((a, b) => b[1] - a[1]);
    if (untraced) slices.push(['Not traced to a campaign', untraced]);

    const size = 220, cx = size / 2, cy = size / 2, rOuter = 92, rInner = 58;
    const svg = svgEl('svg', { viewBox: '0 0 ' + size + ' ' + size, width: size, height: size });
    let angle = -Math.PI / 2;
    const tip = ensureTooltip(container);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:22px;flex-wrap:wrap;justify-content:center';

    slices.forEach(([name, count], i) => {
      const color = CAMPAIGN_COLORS[i % CAMPAIGN_COLORS.length];
      const frac = count / total;
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
      const path = svgEl('path', { d, fill: color, stroke: 'var(--surface)', 'stroke-width': 2 });
      path.addEventListener('mouseenter', (e) => {
        tip.innerHTML = '<div class="t-row"><span><span class="legend-swatch" style="background:' + color + ';display:inline-block;margin-right:5px"></span>' + escapeHtml(name) + '</span><strong>' + count + ' (' + pct((count / total) * 100) + ')</strong></div>';
        tip.hidden = false;
        const rect = container.getBoundingClientRect();
        positionTooltip(tip, container, e.clientX - rect.left, e.clientY - rect.top);
      });
      path.addEventListener('mousemove', (e) => { const rect = container.getBoundingClientRect(); positionTooltip(tip, container, e.clientX - rect.left, e.clientY - rect.top); });
      path.addEventListener('mouseleave', () => { tip.hidden = true; });
      svg.appendChild(path);
    });

    const centerVal = svgEl('text', { class: 'pie-center-label', x: cx, y: cy - 2, 'font-size': 26 });
    centerVal.textContent = total.toLocaleString('en-US');
    const centerSub = svgEl('text', { class: 'pie-center-sub', x: cx, y: cy + 16 });
    centerSub.textContent = 'leads';
    svg.appendChild(centerVal); svg.appendChild(centerSub);

    const legend = document.createElement('div');
    legend.innerHTML = slices.map(([name, count], i) =>
      '<div class="legend-item" style="display:flex;margin-bottom:7px"><span class="legend-swatch" style="background:' + CAMPAIGN_COLORS[i % CAMPAIGN_COLORS.length] + '"></span>' + escapeHtml(name) + ' &middot; ' + count + '</div>'
    ).join('');
    container.style.position = 'relative';
    wrap.appendChild(svg); wrap.appendChild(legend);
    container.appendChild(wrap);
    container.appendChild(tip);
  }

  // ================= Walker Agency Campaign Deduction panel =================
  function renderDeduction(leads) {
    const { days, total } = dailyDeduction(leads);
    const cents = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dash = '—';

    const byCampaign = new Map(); // campaignId -> { name, n }
    for (const l of leads) {
      const o = l.origin;
      if (!o || !o.campaignId) continue;
      if (!byCampaign.has(o.campaignId)) byCampaign.set(o.campaignId, { name: o.campaignName || o.campaignId, n: 0 });
      byCampaign.get(o.campaignId).n++;
    }
    const campaignNames = [...byCampaign.values()].map((c) => c.name + ' · ' + c.n + ' lead' + (c.n === 1 ? '' : 's')).join(', ');

    $('#deduct-facts').innerHTML =
      '<div class="fact fact--total"><div class="fact-label">Bryan ad spend</div><div class="fact-value">' + cents(total) + '</div><div class="fact-sub">already spent in Walker&rsquo;s campaigns &middot; sum of the days below</div></div>' +
      '<div class="fact"><div class="fact-label">Walker campaigns</div><div class="fact-value">' + (byCampaign.size || dash) + '</div><div class="fact-sub">' + escapeHtml(campaignNames || 'No Walker campaign found for the leads in this range.') + '</div></div>' +
      '<div class="fact"><div class="fact-label">Leads with a traced day</div><div class="fact-value">' + days.reduce((t, d) => t + d.n, 0) + ' of ' + leads.length + '</div></div>';

    const sentTotal = days.reduce((t, d) => t + d.n, 0);
    $('#deduct-days-body').innerHTML = days.map((d) => (
      '<tr><td>' + escapeHtml(d.date) + '</td><td class="name-cell">' + escapeHtml(d.name) + '</td>' +
      '<td class="td-num num">' + cents(d.spend) + '</td>' +
      '<td class="td-num num">' + d.walkerLeads.toLocaleString('en-US') + '</td>' +
      '<td class="td-num num">' + d.n + '</td>' +
      '<td class="td-num num">' + (d.cpl ? cents(d.cpl) : dash) + '</td>' +
      '<td class="td-num num">' + (d.deduct ? cents(d.deduct) : dash) + '</td></tr>'
    )).join('') + (days.length
      ? '<tr class="row-total"><td>Total</td><td></td><td></td><td></td><td class="td-num num">' + sentTotal + '</td><td></td><td class="td-num num">' + cents(total) + '</td></tr>'
      : '<tr class="row-muted"><td colspan="7">No leads to show for this range.</td></tr>');
  }

  // ================= leads by campaign table =================
  function renderCampaignTable(leads) {
    const byCampaign = new Map();
    let untraced = 0;
    for (const l of leads) {
      const name = l.origin && l.origin.campaignName;
      if (!name) { untraced++; continue; }
      byCampaign.set(name, (byCampaign.get(name) || 0) + 1);
    }
    const total = leads.length;
    const rows = [...byCampaign.entries()].sort((a, b) => b[1] - a[1]);
    $('#ad-sub').textContent = rows.length ? rows.length + ' campaigns' : '';
    $('#ad-empty').hidden = rows.length > 0 || untraced > 0;
    let html = rows.map(([name, n]) => (
      '<tr><td class="name-cell">' + escapeHtml(name) + '</td><td class="td-num num">' + n.toLocaleString('en-US') + '</td><td class="td-num num">' + pct((n / total) * 100) + '</td></tr>'
    )).join('');
    if (untraced) html += '<tr class="row-muted"><td class="name-cell">Not traced to a campaign</td><td class="td-num num">' + untraced.toLocaleString('en-US') + '</td><td class="td-num num">' + pct((untraced / total) * 100) + '</td></tr>';
    if (rows.length || untraced) html += '<tr class="row-total"><td>Total</td><td class="td-num num">' + total.toLocaleString('en-US') + '</td><td class="td-num num">100%</td></tr>';
    $('#ad-body').innerHTML = html;
  }

  // ================= lead details =================
  function renderLeadsTable(leads) {
    const rows = leads.filter(matchesSearch).sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));
    const dash = '—';
    const { days } = dailyDeduction(leadsFor(true));
    const cplByKey = new Map(days.map((d) => [d.campaignId + '|' + d.date, d.cpl]));
    $('#lead-count').textContent = leads.length.toLocaleString('en-US');
    $('#range-label').textContent = rangeLabel();
    $('#leads-empty').hidden = rows.length > 0;
    $('#leads-body').innerHTML = rows.map((l) => {
      const o = l.origin;
      const cpl = o && o.campaignId ? cplByKey.get(o.campaignId + '|' + l.createdDate) : 0;
      return '<tr>' +
        '<td><div class="name-cell">' + escapeHtml(l.name || '(no name)') + '</div><div class="email-cell">' + escapeHtml(l.email || l.phone || '') + '</div></td>' +
        '<td>' + escapeHtml(l.createdDate || dash) + '</td>' +
        '<td><span class="status-pill ' + statusClass(l.status) + '">' + escapeHtml(l.status) + '</span></td>' +
        '<td class="email-cell" title="' + escapeHtml(l.note) + '">' + escapeHtml(l.note ? (l.note.length > 60 ? l.note.slice(0, 60) + '…' : l.note) : dash) + '</td>' +
        '<td>' + escapeHtml((o && o.contactSource) || dash) + '</td>' +
        '<td>' + escapeHtml((o && o.campaignName) || dash) + '</td>' +
        '<td class="td-num num">' + (cpl ? money(cpl) : dash) + '</td>' +
      '</tr>';
    }).join('');
  }

  function render() {
    const leads = leadsFor();
    renderKpis(leads);
    const { days } = dailyDeduction(leads);
    renderDeduction(leads);
    renderSpendChart(days);
    renderBarChart(leads);
    renderPieChart(leads);
    renderCampaignTable(leads);
    renderLeadsTable(leads);
  }

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
  $('#range-clear').addEventListener('click', () => { setRange('all', null, null); render(); });

  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('#refresh-btn').addEventListener('click', () => {
    $('#refresh-btn').classList.add('is-spinning');
    fetchData().finally(() => setTimeout(() => $('#refresh-btn').classList.remove('is-spinning'), 400));
  });

  fetchData();
  setInterval(fetchData, 30000);
})();

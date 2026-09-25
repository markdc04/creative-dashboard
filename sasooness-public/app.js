(function () {
  const $ = (sel) => document.querySelector(sel);
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const pct = (n) => (isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '0') + '%';
  const COLOR_GOOGLE = '#3987e5';
  const COLOR_META = '#d95926';
  const COLOR_LEADS = '#3987e5';
  const COLOR_CASES = '#199e70';
  const STATUS_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];
  // The three ways a lead reaches Sasooness:
  //   OG      the Main Landing Page (the ad campaigns send their traffic here)
  //   Agency  Lead Prosper leads from the Walker Agency AZ campaign (the "Lead prosper AZ" tab)
  //   PPL     the Pay Per Lead model (the "Lead prosper WA" tab)
  // Only OG has campaign spend on our side. Anything not on the Agency/PPL tabs, including the few
  // CRM leads with other marketing codes, counts as OG.
  const PROGRAMS = [
    { key: 'og', label: 'OG (Main Landing Page)', short: 'OG' },
    { key: 'agency', label: 'Agency (Lead Prosper)', short: 'Agency' },
    { key: 'ppl', label: 'PPL (Pay Per Lead)', short: 'PPL' },
  ];
  const programOf = (l) => (l.channel === 'Lead Prosper AZ' ? 'agency' : l.channel === 'Lead Prosper WA' ? 'ppl' : 'og');
  const programLabel = (key) => (PROGRAMS.find((p) => p.key === key) || PROGRAMS[0]).label;

  // Special filter values: leads that count as signed cases, statuses folded into the donut's
  // "Other" slice, and leads/spend with no campaign tag.
  const SIGNED = '@signed';
  const OTHER_STATUSES = '@other';
  const NO_CAMPAIGN = '@none';

  const state = {
    leads: [], campaignSpend: [], schedule: [], walker: { campaigns: [], spendDaily: [], leadsDaily: [] },
    search: '',
    range: { key: 'all', start: null, end: null },
    // Clicking any figure, row, slice, bar or point on the page sets one of these; every table,
    // tile and chart then re-computes from the leads and spend that match.
    filters: { status: null, campaign: null, program: 'og', platform: null },
    topStatuses: [],
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

  async function fetchData() {
    try {
      const r = await fetch('/sasooness-api/data', { cache: 'no-store' });
      if (!r.ok) throw new Error('bad status');
      const d = await r.json();
      state.leads = d.leads || [];
      state.campaignSpend = d.campaignSpend || [];
      state.schedule = (d.settings && d.settings.schedule) || [];
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

  // ---- what matches the current filters ----
  // A view that offers its own dimension as the thing to click (the donut for status, the
  // campaign table for campaign, ...) is computed with that one filter skipped, so the other
  // choices stay on screen to switch to instead of vanishing when one is picked.
  const campaignPlatform = () => new Map(state.campaignSpend.map((r) => [r.campaign, r.platform]));

  function leadsFor(skip, ignoreDate) {
    const f = state.filters;
    const platformOf = f.platform && skip !== 'platform' ? campaignPlatform() : null;
    return state.leads.filter((l) => {
      if (!ignoreDate && !inRange(l.createdDate)) return false;
      if (f.status && skip !== 'status') {
        if (f.status === SIGNED) { if (!isSignedStatus(l.status)) return false; }
        else if (f.status === OTHER_STATUSES) { if (state.topStatuses.includes(l.status || '(blank)')) return false; }
        else if ((l.status || '(blank)') !== f.status) return false;
      }
      if (f.campaign && skip !== 'campaign' && (l.campaign || NO_CAMPAIGN) !== f.campaign) return false;
      if (f.program && skip !== 'program' && programOf(l) !== f.program) return false;
      if (platformOf && platformOf.get(l.campaign) !== f.platform) return false;
      return true;
    });
  }

  function spendFor(skip) {
    const f = state.filters;
    // Agency and PPL leads have no ad spend behind them.
    if (f.program && f.program !== 'og' && skip !== 'program') return [];
    return state.campaignSpend.filter((r) => {
      if (!inRange(r.date)) return false;
      if (f.campaign && skip !== 'campaign' && r.campaign !== f.campaign) return false;
      if (f.platform && skip !== 'platform' && r.platform !== f.platform) return false;
      return true;
    });
  }

  function statusGroups(leads) {
    const groups = new Map();
    for (const l of leads) {
      const key = l.status || '(blank)';
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    return [...groups.entries()].sort((a, b) => b[1] - a[1]);
  }

  // The program tabs are the view you're in, not a filter, so clearing filters keeps the program.
  function resetFilters() {
    state.filters = { status: null, campaign: null, program: state.filters.program, platform: null };
  }

  function toggleFilter(name, value) {
    state.filters[name] = state.filters[name] === value ? null : value;
    render();
  }

  // ================= active-filter bar =================
  function filterLabel(name, value) {
    if (name === 'status') return 'Status: ' + (value === SIGNED ? 'Signed cases' : value === OTHER_STATUSES ? 'Other statuses' : value);
    if (name === 'campaign') return 'Campaign: ' + (value === NO_CAMPAIGN ? 'No campaign tag' : value);
    if (name === 'program') return 'Program: ' + programLabel(value);
    return 'Platform: ' + value;
  }
  function renderFilterBar() {
    const chips = Object.entries(state.filters).filter(([name, v]) => v && name !== 'program').map(([name, v]) =>
      '<button class="filter-chip" data-clear="' + name + '" title="Remove this filter">' + escapeHtml(filterLabel(name, v)) + '<span aria-hidden="true">&times;</span></button>'
    );
    if (state.range.key !== 'all') {
      chips.push('<button class="filter-chip" data-clear="range" title="Remove this filter">Dates ' + escapeHtml(rangeLabel().replace('· ', '')) + '<span aria-hidden="true">&times;</span></button>');
    }
    const bar = $('#filter-bar');
    bar.hidden = chips.length === 0;
    bar.innerHTML = chips.length
      ? '<span class="filter-bar-label">Filtered by</span>' + chips.join('') + '<button class="filter-clear-all" data-clear="all">Clear all</button>'
      : '';
  }
  function clearRange() { setRange('all', null, null); }

  // ================= KPI row =================
  // What Sasooness's Agency/PPL leads cost in Walker's campaigns, day by day. A lead's cost lands on
  // the day Walker logged it (when the campaign paid for it): that day's campaign spend divided
  // by every lead Walker logged from the campaign that day, whatever its status. Summing the
  // sent leads' daily costs gives the ad spend already used on Sasooness's leads.
  function partnerDeduction(leads) {
    const sent = new Map();
    for (const l of leads) {
      const o = l.origin;
      if (!o || !o.campaignId || !o.walkerDate) continue;
      const key = o.campaignId + '|' + o.walkerDate;
      if (!sent.has(key)) sent.set(key, { campaignId: o.campaignId, date: o.walkerDate, n: 0 });
      sent.get(key).n++;
    }
    const nameOf = new Map(state.walker.campaigns.map((c) => [c.campaignId, c.name]));
    const days = [...sent.values()].map((x) => {
      const spend = state.walker.spendDaily.filter((r) => r.campaignId === x.campaignId && r.date === x.date).reduce((a, r) => a + r.spend, 0);
      const walkerLeads = state.walker.leadsDaily.filter((r) => r.campaignId === x.campaignId && r.date === x.date).reduce((a, r) => a + r.leads, 0);
      const cpl = walkerLeads > 0 ? spend / walkerLeads : 0;
      return { ...x, name: nameOf.get(x.campaignId) || x.campaignId, spend, walkerLeads, cpl, deduct: x.n * cpl };
    }).sort((a, b) => b.date.localeCompare(a.date));
    return { days, total: days.reduce((a, d) => a + d.deduct, 0) };
  }

  // The contract's ad budget and marketing fee are monthly amounts from the Sasooness tab. With no
  // dates chosen the full schedule counts (each month whole, as the sheet totals them); with a
  // range each day carries its month's amount divided by that month's days, so a full month gives
  // exactly one month's figure. A month past the end of the schedule repeats the last one.
  function contractForRange() {
    const sched = state.schedule;
    if (!sched.length) return { budget: 0, fee: 0 };
    const { start, end } = state.range;
    if (!start && !end) return { budget: sched.reduce((a, m) => a + m.budget, 0), fee: sched.reduce((a, m) => a + m.fee, 0) };
    const byMonth = new Map(sched.map((m) => [m.month, m]));
    const first = sched[0].month, last = sched[sched.length - 1];
    const from = start || first + '-01';
    const to = end || toISO(pacificToday());
    let budget = 0, fee = 0;
    for (let d = new Date(from + 'T00:00:00'), stop = new Date(to + 'T00:00:00'); d <= stop; d.setDate(d.getDate() + 1)) {
      const key = d.getFullYear() + '-' + pad(d.getMonth() + 1);
      const m = key < first ? null : byMonth.get(key) || last;
      if (!m) continue;
      const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      budget += m.budget / days;
      fee += m.fee / days;
    }
    return { budget, fee };
  }

  function renderKpis(leads, spendRows) {
    const total = leads.length;
    const signed = leads.filter((l) => isSignedStatus(l.status)).length;
    const rejected = leads.filter((l) => statusClass(l.status) === 'status-pill--rejected').length;
    const conversionRate = total > 0 ? (signed / total) * 100 : 0;
    const program = state.filters.program;
    let tiles;

    if (program === 'agency' || program === 'ppl') {
      // No ad spend sits behind these leads, so this view is about what the leads turn into.
      const open = leads.filter((l) => !(l.status || '').trim()).length;
      const adSpent = partnerDeduction(leads).total;
      tiles = [
        ['leads', 'Total Leads', total.toLocaleString('en-US'), programLabel(program) + ' program', 'Click to clear the filters'],
        ['signed', 'Signed Cases', signed.toLocaleString('en-US'), 'of ' + total.toLocaleString('en-US') + ' leads', 'Click to show only signed cases'],
        ['', 'Conversion Rate', pct(conversionRate), 'signed ÷ leads', ''],
        ['', 'Rejected', rejected.toLocaleString('en-US'), total ? pct((rejected / total) * 100) + ' of leads' : '', ''],
        ['', 'Awaiting Status', open.toLocaleString('en-US'), 'no status yet', ''],
        ['', 'Ad Spent', adSpent ? money(adSpent) : '—', 'already spent in Walker’s campaign on these leads', ''],
      ];
    } else {
      const googleSpend = spendRows.filter((r) => r.platform === 'Google').reduce((a, r) => a + r.spend, 0);
      const metaSpend = spendRows.filter((r) => r.platform === 'Meta').reduce((a, r) => a + r.spend, 0);
      const totalSpend = googleSpend + metaSpend;
      // Only paid (OG) leads can be produced by ad spend, so costs divide by those and not by
      // Agency/PPL leads that arrived some other way. Spend also isn't split by status.
      const paid = leads.filter((l) => programOf(l) === 'og');
      const paidSigned = paid.filter((l) => isSignedStatus(l.status)).length;
      const costsMeaningful = !state.filters.status;
      const cpl = paid.length > 0 && costsMeaningful ? totalSpend / paid.length : 0;
      const costPerCase = paidSigned > 0 && costsMeaningful ? totalSpend / paidSigned : 0;
      const noSplit = 'spend isn’t split by status';
      // Fee and budget belong to the contract as a whole, so they can't be narrowed to a campaign,
      // platform or status.
      const f = state.filters;
      const contractOk = !f.status && !f.campaign && !f.platform;
      const { budget, fee } = contractForRange();
      const totalCost = totalSpend + fee;
      const cpcWithFee = paidSigned > 0 && costsMeaningful && contractOk ? totalCost / paidSigned : 0;
      const used = budget > 0 ? (totalSpend / budget) * 100 : 0;
      const budgetSub = !contractOk ? 'contract-level, not split by filter'
        : budget <= 0 ? '' : totalSpend <= budget ? pct(used) + ' used · ' + money(budget - totalSpend) + ' left' : money(totalSpend - budget) + ' over budget';
      const dash = '—';
      tiles = [
        ['leads', 'Total Leads', total.toLocaleString('en-US'), rejected ? rejected.toLocaleString('en-US') + ' rejected' : '', 'Click to clear the filters'],
        ['signed', 'Signed Cases', signed.toLocaleString('en-US'), 'of ' + total.toLocaleString('en-US') + ' leads', 'Click to show only signed cases'],
        ['', 'Conversion Rate', pct(conversionRate), 'signed ÷ leads', ''],
        ['', 'Cost / Lead', cpl ? money(cpl) : dash, costsMeaningful ? 'ad spend ÷ OG leads' : noSplit, ''],
        ['', 'Ad Spend', money(totalSpend), money(googleSpend) + ' Google + ' + money(metaSpend) + ' Meta', ''],
        ['', 'Marketing Fee', contractOk ? money(fee) : dash, contractOk ? 'monthly fee from the contract' : 'contract-level, not split by filter', ''],
        ['', 'Ad Budget', contractOk ? money(budget) : dash, budgetSub, ''],
        ['', 'Total Cost', contractOk ? money(totalCost) : dash, contractOk ? 'ad spend + marketing fee' : 'contract-level, not split by filter', ''],
        ['', 'CPC (Cost / Case)', costPerCase ? money(costPerCase) : dash, !costsMeaningful ? noSplit : paidSigned ? 'ad spend ÷ signed cases' : 'no signed cases yet', ''],
        ['', 'CPC + Marketing Fee', cpcWithFee ? money(cpcWithFee) : dash, !costsMeaningful || !contractOk ? 'not split by filter' : paidSigned ? 'total cost ÷ signed cases' : 'no signed cases yet', ''],
      ];
    }
    $('#kpi-row').className = 'kpi-row' + (tiles.length === 10 ? ' kpi-row--10' : '');
    $('#kpi-row').innerHTML = tiles.map(([key, label, value, sub, hint]) =>
      '<div class="kpi' + (key ? ' is-clickable' : '') + (key === 'signed' && state.filters.status === SIGNED ? ' is-selected' : '') + '"' + (key ? ' data-tile="' + key + '" title="' + hint + '"' : '') + '>' +
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
    for (const l of leadsFor(null, true)) {
      if (!l.createdDate) continue;
      const key = l.createdDate.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, { leads: 0, cases: 0 });
      byMonth.get(key).leads++;
      if (isSignedStatus(l.status)) byMonth.get(key).cases++;
    }
    const months = [...byMonth.keys()].sort();
    if (!months.length) { container.innerHTML = '<div class="empty-msg">No leads for this selection.</div>'; return; }
    const { start, end } = state.range;
    const monthInRange = (m) => {
      const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7));
      return (!end || toISO(startOfMonth(y, mo)) <= end) && (!start || toISO(endOfMonth(y, mo)) >= start);
    };

    const W = 560, H = 260, padL = 34, padR = 10, padT = 14, padB = 30;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const maxVal = niceMax(Math.max(...months.map((m) => byMonth.get(m).leads)));
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
        positionTooltip(tip, container, (cx / W) * container.clientWidth, yOf(v.leads));
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

  // ================= donut chart: leads by status =================
  function renderPieChart() {
    const container = $('#pie-chart');
    container.innerHTML = '';
    const leads = leadsFor('status');
    if (!leads.length) { container.innerHTML = '<div class="empty-msg">No leads for this selection.</div>'; return; }

    const groups = statusGroups(leads);
    const top = groups.slice(0, 4);
    const otherCount = groups.slice(4).reduce((a, [, c]) => a + c, 0);
    const slices = otherCount > 0 ? [...top, [OTHER_STATUSES, otherCount]] : top;
    const sliceName = (key) => (key === OTHER_STATUSES ? 'Other' : key);
    const total = leads.length;
    const sf = state.filters.status;
    const isSelected = (key) => sf === key || (sf === SIGNED && isSignedStatus(key));

    const size = 220, cx = size / 2, cy = size / 2, rOuter = 92, rInner = 58;
    const svg = svgEl('svg', { viewBox: '0 0 ' + size + ' ' + size, width: size, height: size });
    let angle = -Math.PI / 2;
    const tip = ensureTooltip(container);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:22px;flex-wrap:wrap;justify-content:center';

    slices.forEach(([key, count], i) => {
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
      const dim = sf && !isSelected(key);
      const path = svgEl('path', { d, class: 'is-clickable', fill: STATUS_COLORS[i % STATUS_COLORS.length], stroke: 'var(--surface)', 'stroke-width': 2, opacity: dim ? 0.3 : 1 });
      path.addEventListener('mouseenter', (e) => {
        tip.innerHTML = '<div class="t-row"><span><span class="legend-swatch" style="background:' + STATUS_COLORS[i % STATUS_COLORS.length] + ';display:inline-block;margin-right:5px"></span>' + escapeHtml(sliceName(key)) + '</span><strong>' + count + ' (' + pct((count / total) * 100) + ')</strong></div><div class="t-hint">Click to filter to this status</div>';
        tip.hidden = false;
        const rect = container.getBoundingClientRect();
        positionTooltip(tip, container, e.clientX - rect.left, e.clientY - rect.top);
      });
      path.addEventListener('mousemove', (e) => { const rect = container.getBoundingClientRect(); positionTooltip(tip, container, e.clientX - rect.left, e.clientY - rect.top); });
      path.addEventListener('mouseleave', () => { tip.hidden = true; });
      path.addEventListener('click', () => { tip.hidden = true; toggleFilter('status', key); });
      svg.appendChild(path);
    });

    const centerVal = svgEl('text', { class: 'pie-center-label', x: cx, y: cy - 2, 'font-size': 26 });
    centerVal.textContent = total.toLocaleString('en-US');
    const centerSub = svgEl('text', { class: 'pie-center-sub', x: cx, y: cy + 16 });
    centerSub.textContent = 'leads';
    svg.appendChild(centerVal); svg.appendChild(centerSub);

    const legend = document.createElement('div');
    legend.innerHTML = slices.map(([key, count], i) =>
      '<button class="legend-item legend-btn' + (isSelected(key) ? ' is-selected' : '') + (sf && !isSelected(key) ? ' is-dim' : '') + '" data-status="' + escapeHtml(key) + '" style="display:flex;margin-bottom:7px"><span class="legend-swatch" style="background:' + STATUS_COLORS[i % STATUS_COLORS.length] + '"></span>' + escapeHtml(sliceName(key)) + ' &middot; ' + count + '</button>'
    ).join('');

    container.style.position = 'relative';
    wrap.appendChild(svg); wrap.appendChild(legend);
    container.appendChild(wrap);
    container.appendChild(tip);
  }

  // ================= performance by campaign =================
  function renderCampaigns() {
    const spendRows = spendFor('campaign');
    const leadRows = leadsFor('campaign');
    const selected = state.filters.campaign;
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
    for (const l of leadRows) { if (!l.campaign) unattributed++; else get(l.campaign).leads++; }

    const rows = [...byCampaign.values()].filter((r) => r.spend > 0 || r.leads > 0).sort((a, b) => b.spend - a.spend);
    const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
    const totalLeads = rows.reduce((s, r) => s + r.leads, 0) + unattributed;
    $('#campaign-sub').textContent = rows.length ? rows.length + ' campaigns · click a row to filter' : '';
    $('#campaign-empty').hidden = rows.length > 0 || unattributed > 0;
    if (!rows.length && !unattributed) { $('#campaign-body').innerHTML = ''; return; }

    const cls = (key) => 'is-clickable' + (selected === key ? ' is-selected' : selected ? ' is-dim' : '');
    const tag = (p) => p ? '<button class="platform-tag platform-tag--' + p.toLowerCase() + (state.filters.platform === p ? ' is-selected' : '') + '" data-platform="' + p + '" title="Click to filter by ' + p + '">' + escapeHtml(p) + '</button>' : '—';
    let html = rows.map((r) => (
      '<tr class="' + cls(r.name) + '" data-campaign="' + escapeHtml(r.name) + '">' +
        '<td><div class="name-cell">' + escapeHtml(r.name) + '</div>' + (r.first <= r.last ? '<div class="email-cell">' + escapeHtml(r.first) + ' → ' + escapeHtml(r.last) + '</div>' : '') + '</td>' +
        '<td>' + tag(r.platform) + '</td>' +
        '<td class="td-num num">' + money(r.spend) + '</td>' +
        '<td class="td-num num">' + r.leads.toLocaleString('en-US') + '</td>' +
        '<td class="td-num num">' + (r.leads > 0 && r.spend > 0 ? money(r.spend / r.leads) : '—') + '</td>' +
        '<td class="td-num num">' + (totalSpend > 0 ? pct((r.spend / totalSpend) * 100) : '—') + '</td>' +
      '</tr>'
    )).join('');
    if (unattributed > 0) {
      html += '<tr class="row-muted ' + cls(NO_CAMPAIGN) + '" data-campaign="' + NO_CAMPAIGN + '"><td><div class="name-cell">No campaign tag</div><div class="email-cell">leads without a UTM campaign</div></td><td>—</td><td class="td-num num">—</td><td class="td-num num">' + unattributed.toLocaleString('en-US') + '</td><td class="td-num num">—</td><td class="td-num num">—</td></tr>';
    }
    html += '<tr class="row-total"><td>Total</td><td></td><td class="td-num num">' + money(totalSpend) + '</td><td class="td-num num">' + totalLeads.toLocaleString('en-US') + '</td><td class="td-num num">' + (totalLeads > 0 && totalSpend > 0 ? money(totalSpend / totalLeads) : '—') + '</td><td class="td-num num">' + (totalSpend > 0 ? '100%' : '—') + '</td></tr>';
    $('#campaign-body').innerHTML = html;
  }

  // ================= leads by program (OG / Agency / PPL) =================
  function renderPrograms() {
    const leads = leadsFor('program');
    const selected = state.filters.program;
    const groups = new Map(PROGRAMS.map((p) => [p.key, []]));
    for (const l of leads) groups.get(programOf(l)).push(l);
    const cls = (key, empty) => 'is-clickable' + (empty ? ' row-muted' : '') + (selected === key ? ' is-selected' : selected ? ' is-dim' : '');
    const line = (key, list) => {
      const signed = list.filter((l) => isSignedStatus(l.status)).length;
      const rejected = list.filter((l) => statusClass(l.status) === 'status-pill--rejected').length;
      return '<tr class="' + cls(key, list.length === 0) + '" data-program="' + key + '"><td class="name-cell">' + escapeHtml(programLabel(key)) + '</td>' +
        '<td class="td-num num">' + list.length.toLocaleString('en-US') + '</td>' +
        '<td class="td-num num">' + signed.toLocaleString('en-US') + '</td>' +
        '<td class="td-num num">' + (list.length ? pct((signed / list.length) * 100) : '—') + '</td>' +
        '<td class="td-num num">' + rejected.toLocaleString('en-US') + '</td></tr>';
    };
    let html = '';
    for (const [key, list] of groups) html += line(key, list);
    const signedAll = leads.filter((l) => isSignedStatus(l.status)).length;
    const rejectedAll = leads.filter((l) => statusClass(l.status) === 'status-pill--rejected').length;
    html += '<tr class="row-total"><td>Total</td><td class="td-num num">' + leads.length.toLocaleString('en-US') + '</td><td class="td-num num">' + signedAll.toLocaleString('en-US') + '</td><td class="td-num num">' + (leads.length ? pct((signedAll / leads.length) * 100) : '—') + '</td><td class="td-num num">' + rejectedAll.toLocaleString('en-US') + '</td></tr>';
    $('#source-body').innerHTML = html;
  }

  // ================= program tabs (All / OG / Agency / PPL) =================
  function renderSegmentTabs() {
    const base = leadsFor('program');
    const counts = { og: 0, agency: 0, ppl: 0 };
    for (const l of base) counts[programOf(l)]++;
    const sel = state.filters.program;
    const tab = (key, label, n) => '<button class="segment-tab' + (sel === key ? ' is-active' : '') + '" data-segment="' + key + '">' + escapeHtml(label) + '<span class="n">' + n.toLocaleString('en-US') + '</span></button>';
    $('#segment-tabs').innerHTML = PROGRAMS.map((p) => tab(p.key, p.label, counts[p.key])).join('');

    // Agency and PPL leads have no ad spend, so the spend chart and campaign table don't apply.
    const noSpend = sel === 'agency' || sel === 'ppl';
    $('#spend-panel').hidden = noSpend;
    $('#campaign-panel').hidden = noSpend;
    const note = $('#program-note');
    note.hidden = !noSpend;
    if (noSpend) {
      note.innerHTML = sel === 'agency'
        ? '<strong>Agency</strong> means Lead Prosper leads from the Walker Agency AZ campaign; some of them go through to Sasooness. There is no ad spend on our side, so this view shows what those leads turn into.'
        : '<strong>PPL</strong> means the Pay Per Lead model (Lead Prosper WA). There is no ad spend on our side, so this view shows the leads delivered and what they turn into.';
    }
  }

  // ================= lead details table (secondary) =================
  function renderChips() {
    const base = leadsFor('status');
    const groups = statusGroups(base);
    const sf = state.filters.status;
    const chips = ['<button class="chip' + (!sf ? ' is-active' : '') + '" data-status="">All<span class="n">' + base.length + '</span></button>']
      .concat(groups.map(([status, count]) =>
        '<button class="chip' + (sf === status ? ' is-active' : '') + '" data-status="' + escapeHtml(status) + '">' + escapeHtml(status) + '<span class="n">' + count + '</span></button>'
      ));
    $('#status-chips').innerHTML = chips.join('');
  }

  // Cost per lead for each lead: a partner (Agency/PPL) lead carries its Walker campaign's cost per
  // lead on the day Walker logged it (all leads, regardless of status); an OG lead carries its own
  // campaign's spend divided by that campaign's leads, the same figure as the campaign table.
  function cplMaps() {
    const walker = new Map(); // campaignId|date -> that day's cost per lead
    for (const r of state.walker.spendDaily) {
      const n = state.walker.leadsDaily.filter((x) => x.campaignId === r.campaignId && x.date === r.date).reduce((t, x) => t + x.leads, 0);
      if (n > 0 && r.spend > 0) walker.set(r.campaignId + '|' + r.date, r.spend / n);
    }
    const spendBy = new Map(), leadsBy = new Map();
    for (const r of spendFor('campaign')) spendBy.set(r.campaign, (spendBy.get(r.campaign) || 0) + r.spend);
    for (const l of leadsFor('campaign')) if (l.campaign) leadsBy.set(l.campaign, (leadsBy.get(l.campaign) || 0) + 1);
    const og = new Map();
    for (const [name, spend] of spendBy) { const n = leadsBy.get(name) || 0; if (n > 0 && spend > 0) og.set(name, spend / n); }
    return { walker, og };
  }

  function renderLeadsTable(leads) {
    const rows = leads.filter(matchesSearch).sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));
    const dash = '—';
    const cpl = cplMaps();
    const platformOf = campaignPlatform();
    $('#lead-count').textContent = leads.length.toLocaleString('en-US');
    $('#range-label').textContent = rangeLabel();
    $('#leads-empty').hidden = rows.length > 0;
    $('#leads-body').innerHTML = rows.map((l) => {
      const o = l.origin || {};
      const partner = programOf(l) !== 'og';
      const source = o.contactSource || (!partner && platformOf.get(l.campaign) ? platformOf.get(l.campaign) + ' ad' : '');
      const campaignName = o.campaignName || l.campaign;
      let cplHtml = dash;
      if (partner) {
        const c = cpl.walker.get(o.campaignId + '|' + o.walkerDate);
        if (c) cplHtml = money(c);
      } else if (cpl.og.get(l.campaign)) {
        cplHtml = money(cpl.og.get(l.campaign));
      }
      return '<tr>' +
        '<td><div class="name-cell">' + escapeHtml(l.name || '(no name)') + '</div><div class="email-cell">' + escapeHtml(l.email || l.phone || '') + (l.email && l.phone ? ' &middot; ' + escapeHtml(l.phone) : '') + '</div></td>' +
        '<td>' + escapeHtml(l.createdDate || dash) + (partner && o.walkerDate && o.walkerDate !== l.createdDate ? '<div class="email-cell">cost day ' + escapeHtml(o.walkerDate) + '</div>' : '') + '</td>' +
        '<td><span class="status-pill ' + statusClass(l.status) + '">' + escapeHtml(l.status || dash) + '</span>' + (l.subStatus ? '<div class="kpi-sub" style="margin-top:4px">' + escapeHtml(l.subStatus) + '</div>' : '') + '</td>' +
        '<td>' + escapeHtml(source || dash) + '</td>' +
        '<td><div class="name-cell">' + escapeHtml(campaignName || dash) + '</div>' + (o.campaignId ? '<div class="email-cell">ID ' + escapeHtml(o.campaignId) + '</div>' : '') + '</td>' +
        '<td><div class="name-cell">' + escapeHtml(o.adName || (o.adId ? 'Ad ' + o.adId : dash)) + '</div>' + (o.adId ? '<div class="email-cell">ID ' + escapeHtml(o.adId) + '</div>' : '') + '</td>' +
        '<td class="td-num num">' + cplHtml + '</td>' +
      '</tr>';
    }).join('');
  }

  // ================= where Agency / PPL leads came from, and what to deduct =================
  function renderOrigins() {
    const partner = state.filters.program === 'agency' || state.filters.program === 'ppl';
    $('#deduct-panel').hidden = !partner;
    $('#origin-panel').hidden = true;
    if (!partner) return;

    const leads = leadsFor().slice().sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));
    const dash = '—';

    // Each Walker campaign these leads came from: its spend and lead counts over the chosen dates
    // give a cost per lead (over all of Walker's leads, regardless of status);
    // multiplying by the leads sent to Sasooness gives the amount to deduct.
    const sent = new Map();
    const statusBy = new Map(); // campaign ID -> Map(status -> leads sent)
    for (const l of leads) {
      const id = l.origin && l.origin.campaignId;
      if (!id) continue;
      sent.set(id, (sent.get(id) || 0) + 1);
      const st = (l.status || '').trim() || 'Awaiting status';
      if (!statusBy.has(id)) statusBy.set(id, new Map());
      statusBy.get(id).set(st, (statusBy.get(id).get(st) || 0) + 1);
    }
    const ded = partnerDeduction(leads);
    const rows = state.walker.campaigns.filter((c) => sent.has(c.campaignId)).map((c) => {
      const spend = state.walker.spendDaily.filter((r) => r.campaignId === c.campaignId && inRange(r.date)).reduce((a, r) => a + r.spend, 0);
      const days = state.walker.leadsDaily.filter((r) => r.campaignId === c.campaignId && inRange(r.date));
      const all = days.reduce((a, r) => a + r.leads, 0), qual = days.reduce((a, r) => a + r.qualified, 0);
      const n = sent.get(c.campaignId);
      const cpl = all > 0 ? spend / all : 0;
      return { id: c.campaignId, name: c.name, n, spend, all, qual, cpl, deduct: ded.days.filter((d) => d.campaignId === c.campaignId).reduce((t, d) => t + d.deduct, 0), statuses: [...(statusBy.get(c.campaignId) || new Map()).entries()].sort((a, b) => b[1] - a[1]) };
    });

    $('#origin-sub').textContent = leads.length ? leads.length + ' leads' : '';
    $('#origin-empty').hidden = leads.length > 0;
    $('#origin-body').innerHTML = leads.map((l) => {
      const o = l.origin;
      return '<tr>' +
        '<td><div class="name-cell">' + escapeHtml(l.name || '(no name)') + '</div><div class="email-cell">' + escapeHtml(l.email || l.phone || '') + '</div></td>' +
        '<td>' + escapeHtml(l.createdDate || dash) + '</td>' +
        (o
          ? '<td>' + escapeHtml(o.contactSource || dash) + '</td>' +
            '<td><div class="name-cell">' + escapeHtml(o.campaignName || (o.campaignId ? 'Campaign ' + o.campaignId : dash)) + '</div>' + (o.campaignId ? '<div class="email-cell">ID ' + escapeHtml(o.campaignId) + '</div>' : '') + '</td>' +
            '<td><div class="name-cell">' + escapeHtml(o.adName || (o.adId ? 'Ad ' + o.adId : dash)) + '</div>' + (o.adId ? '<div class="email-cell">ID ' + escapeHtml(o.adId) + '</div>' : '') + '</td>'
          : '<td colspan="3" class="email-cell">Not found in Walker’s lead log</td>') +
      '</tr>';
    }).join('');

    const tot = rows.reduce((t, r) => ({ n: t.n + r.n, deduct: t.deduct + r.deduct }), { n: 0, deduct: 0 });
    $('#deduct-body').innerHTML = rows.map((r) => (
      '<tr><td class="name-cell">' + escapeHtml(r.name) + '</td>' +
      '<td class="td-num num">' + r.n + '</td>' +
      '<td>' + r.statuses.map(([st, k]) => '<div><strong>' + k + '</strong> ' + escapeHtml(st) + '</div>').join('') + '</td>' +
      '<td class="td-num num">' + money(r.spend) + '</td>' +
      '<td class="td-num num">' + r.all.toLocaleString('en-US') + '<div class="email-cell">' + r.qual.toLocaleString('en-US') + ' qualified &middot; ' + (r.all - r.qual).toLocaleString('en-US') + ' disqualified</div></td>' +
      '<td class="td-num num">' + (r.cpl ? money(r.cpl) : dash) + '</td><td class="td-num num">' + (r.deduct ? money(r.deduct) : dash) + '</td></tr>'
    )).join('') + (rows.length
      ? '<tr class="row-total"><td>Total</td><td class="td-num num">' + tot.n + '</td><td></td><td></td><td></td><td></td><td class="td-num num">' + money(tot.deduct) + '</td></tr>'
      : '<tr class="row-muted"><td colspan="7">No Walker campaign found for the leads in this range.</td></tr>');

    $('#deduct-days-body').innerHTML = ded.days.map((d) => (
      '<tr><td>' + escapeHtml(d.date) + '</td><td class="name-cell">' + escapeHtml(d.name) + '</td>' +
      '<td class="td-num num">' + d.n + '</td><td class="td-num num">' + money(d.spend) + '</td>' +
      '<td class="td-num num">' + d.walkerLeads.toLocaleString('en-US') + '</td>' +
      '<td class="td-num num">' + (d.cpl ? money(d.cpl) : dash) + '</td><td class="td-num num">' + (d.deduct ? money(d.deduct) : dash) + '</td></tr>'
    )).join('') + (ded.days.length
      ? '<tr class="row-total"><td>Total</td><td></td><td class="td-num num">' + ded.days.reduce((t, d) => t + d.n, 0) + '</td><td></td><td></td><td></td><td class="td-num num">' + money(ded.total) + '</td></tr>'
      : '<tr class="row-muted"><td colspan="7">No leads to show for this range.</td></tr>');
  }

  function render() {
    // Which statuses the donut shows individually (the rest fold into "Other") — computed first
    // because an "Other statuses" filter is defined in terms of it.
    state.topStatuses = statusGroups(leadsFor('status')).slice(0, 4).map(([s]) => s);
    const leads = leadsFor();
    renderFilterBar();
    renderKpis(leads, spendFor());
    renderSpendChart();
    renderBarChart();
    renderPieChart();
    renderCampaigns();
    renderPrograms();
    renderSegmentTabs();
    renderOrigins();
    renderChips();
    renderLeadsTable(leads);
  }

  // ---- click handling: everything clickable is wired here by data attribute ----
  document.addEventListener('click', (e) => {
    const clear = e.target.closest('[data-clear]');
    if (clear) {
      const what = clear.dataset.clear;
      if (what === 'all') { resetFilters(); clearRange(); }
      else if (what === 'range') clearRange();
      else state.filters[what] = null;
      render();
      return;
    }
    const tile = e.target.closest('[data-tile]');
    if (tile) {
      if (tile.dataset.tile === 'signed') toggleFilter('status', SIGNED);
      else { resetFilters(); render(); }
      return;
    }
    const platform = e.target.closest('[data-platform]');
    if (platform) { e.stopPropagation(); toggleFilter('platform', platform.dataset.platform); return; }
    const chip = e.target.closest('.chip[data-status]');
    if (chip) { state.filters.status = chip.dataset.status || null; render(); return; }
    const legend = e.target.closest('.legend-btn[data-status]');
    if (legend) { toggleFilter('status', legend.dataset.status); return; }
    const campaignRow = e.target.closest('tr[data-campaign]');
    if (campaignRow) { toggleFilter('campaign', campaignRow.dataset.campaign); return; }
    const programRow = e.target.closest('tr[data-program]');
    if (programRow) { state.filters.program = programRow.dataset.program; render(); return; }
    const segment = e.target.closest('[data-segment]');
    if (segment) { state.filters.program = segment.dataset.segment; render(); return; }
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
  $('#range-clear').addEventListener('click', () => {
    resetFilters();
    clearRange();
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

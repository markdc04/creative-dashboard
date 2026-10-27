(function () {
  const $ = (sel) => document.querySelector(sel);
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const pct = (n) => (isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '0') + '%';
  const AZ_NEW_BUDGET = 75000;
  const MARKETING_FEE_SHARE = 0.35;
  const AZ_BUDGET_FROM = '2026-09-21';
  // Combined ad-budget pool across all three invoiced tranches, all at the AZ_BUDGET_FROM window's
  // 35% fee rate (open-ended, so a same-rate top-up just adds to the pool rather than needing its
  // own tranche/window): $20,000 (9/9) + $48,750 (9/21, 65% of $75k) + $48,750 (10/21, 65% of a
  // second $75k payment) = $117,500.
  const AD_BUDGET_TOTAL = 117500;
  const AD_BUDGET_FROM = '2026-09-09';
  // The 10/21 top-up is new money — the first $68,750 (9/9 + 9/21 tranches) must be spent down to
  // zero before any of it counts as "left." See fifoRemaining().
  const AD_BUDGET_PREVIOUS = 68750;
  const PPL_PRICE_PER_LEAD = 425;
  // Two invoiced PPL (WA) payments make up one combined pool, both tracked from the same
  // PPL_BUDGET_FROM start since the per-lead rate hasn't changed: $20,000 (9/21) + $20,000
  // (10/21) = $40,000.
  const PPL_BUDGET = 40000;
  const PPL_BUDGET_FROM = '2026-09-21';
  // The 10/21 top-up is new money — the first $20,000 (9/21 tranche) must be drawn to zero first.
  const PPL_BUDGET_PREVIOUS = 20000;
  // Splits a combined budget pool into what's left of the earlier tranche(s) vs. the later
  // top-up, assuming spend draws down the earlier money first (FIFO) — so the newer tranche only
  // starts showing a drawdown once the older one hits zero.
  function fifoRemaining(previousPool, totalPool, spent) {
    const previousLeft = Math.max(0, previousPool - spent);
    const totalLeft = Math.max(0, totalPool - spent);
    return { previousLeft, newLeft: totalLeft - previousLeft };
  }
  const COLOR_GOOGLE = '#3987e5';
  const COLOR_META = '#d95926';
  const COLOR_LEADS = '#3987e5';
  const COLOR_CASES = '#199e70';
  const STATUS_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];
  // Two buckets, not three: Agency is AZ (the Main Landing Page's own campaigns plus Lead Prosper
  // leads from the Walker Agency AZ campaign, combined) and PPL is WA only (the "Lead prosper WA"
  // tab). Agency carries both kinds of spend at once — its own Google/Meta campaigns (attributed by
  // l.campaign, so only the Main-Landing-Page leads pick it up) and the Walker partner deduction
  // (attributed by l.origin, so only the Lead Prosper AZ leads pick it up). PPL never has its own
  // campaign spend, only the Walker deduction.
  const PROGRAMS = [
    { key: 'agency', label: 'Agency (AZ)', short: 'Agency' },
    { key: 'ppl', label: 'PPL (WA)', short: 'PPL' },
  ];
  const programOf = (l) => (l.channel === 'Lead Prosper WA' ? 'ppl' : 'agency');
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
    filters: { status: null, campaign: null, program: 'agency', platform: null, reason: null },
    topStatuses: [],
    // KPI tile ordering: me is who's logged in (only 'Mark' gets the drag UI); layout holds the
    // saved order per program, fetched once and applied to every render until changed and saved.
    me: null,
    layout: { agency: null, ppl: null },
    editingLayout: false,
    editProgram: null,
    dragTileLayout: null, // working copy of { order, hidden, titles } for tiles, while editingLayout is true
    // Whole-panel customization: order/visibility/renamed title+subtitle, saved as one object
    // under board 'sasooness', program 'panels' (reusing the same /api/layout endpoint).
    panelLayout: null, // { order: [id,...], hidden: {id:true}, titles: {id:{title,sub}} }
    editingPanels: false,
    dragPanelLayout: null, // working copy of the object above, while editingPanels is true
  };

  // One entry per customizable block. `el` is the whole block to drag/hide; `title`/`sub` are the
  // one heading + one subtitle inside it that can be renamed (the two-chart "trends" row only
  // exposes its first chart's heading — renaming the second independently isn't supported).
  const PANEL_BLOCKS = [
    { id: 'daily-leads', el: '#daily-leads-panel', title: '.panel-title', sub: '.panel-sub' },
    { id: 'deduct', el: '#deduct-panel', title: '.panel-title', sub: '.panel-sub' },
    { id: 'origin', el: '#origin-panel', title: '.panel-title', sub: '#origin-sub' },
    { id: 'spend', el: '#spend-panel', title: '.panel-title' },
    { id: 'trends', el: '#trends-panel', title: '.panel-title' },
    { id: 'campaign', el: '#campaign-panel', title: '.panel-title', sub: '#campaign-sub' },
    { id: 'program-summary', el: '#program-summary-panel', title: '.panel-title' },
    { id: 'status-summary', el: '#status-summary-panel', title: '.panel-title' },
    { id: 'period-comparison', el: '#period-comparison-panel', title: '.panel-title' },
    { id: 'lead-details', el: '#lead-details-panel', title: '.panel-title' },
    { id: 'reasons', el: '#reasons-panel', title: '.panel-title', sub: '#reasons-sub' },
  ];

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
  // Matches a raw status VALUE (used for the donut/legend, which groups strictly by the literal
  // CRM status text) — not "is this lead a signed case" (see isSignedCase below for that).
  function isSignedStatus(status) { return (status || '').trim() === 'Signed Up' || (status || '').trim() === 'Client'; }
  // A lead counts as a signed case if its own Status says so, OR if it was referred out but its
  // SubStatus says "Signed Up"/"Client" — confirmed against the live sheet: 41 Status="Signed Up"
  // + 9 Status="Referred"/SubStatus="Signed Up" = 50 real signed cases, not 41.
  function isSignedCase(l) { return isSignedStatus(l.status) || isSignedStatus(l.subStatus); }
  // The CRM's raw status column has a dozen+ values (Referred, Lost, Hold, Chase, AZ Chase,
  // Existing Client, blank, ...) that don't matter day to day — collapsed to the three that do.
  function statusBucket(l) {
    if (isSignedCase(l)) return 'Signed';
    if ((l.status || '').toLowerCase().includes('reject')) return 'Rejected';
    return 'Reviewing';
  }

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
        if (f.status === SIGNED || f.status === 'Signed') { if (!isSignedCase(l)) return false; }
        else if (f.status === 'Rejected' || f.status === 'Reviewing') { if (statusBucket(l) !== f.status) return false; }
        else if (f.status === OTHER_STATUSES) { if (state.topStatuses.includes(l.status || '(blank)')) return false; }
        else if ((l.status || '(blank)') !== f.status) return false;
      }
      if (f.campaign && skip !== 'campaign' && (l.campaign || NO_CAMPAIGN) !== f.campaign) return false;
      if (f.program && skip !== 'program' && programOf(l) !== f.program) return false;
      if (f.reason && skip !== 'reason' && reasonOf(l) !== f.reason) return false;
      if (platformOf && platformOf.get(l.campaign) !== f.platform) return false;
      return true;
    });
  }

  function spendFor(skip) {
    const f = state.filters;
    // PPL leads have no ad spend on our side. Agency does (its Main Landing Page share) — those
    // rows only ever attribute to leads with a campaign tag, so they don't bleed into PPL.
    if (f.program === 'ppl' && skip !== 'program') return [];
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
    state.filters = { status: null, campaign: null, program: state.filters.program, platform: null, reason: null };
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
    if (name === 'reason') return 'Rejected: ' + value;
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
  // the day it reached Sasooness: that day's campaign spend divided by every lead Walker logged
  // from the campaign that day, whatever its status. Summing the sent leads' daily costs gives the
  // ad spend already used on Sasooness's leads.
  function partnerDeduction(leads) {
    const sent = new Map();
    for (const l of leads) {
      const o = l.origin;
      if (!o || !o.campaignId || !l.createdDate) continue;
      const key = o.campaignId + '|' + l.createdDate;
      if (!sent.has(key)) sent.set(key, { campaignId: o.campaignId, date: l.createdDate, n: 0 });
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

  // The contract's ad budget and marketing fee are monthly amounts from the Sasooness tab, one
  // row per month normally — but a month can have a second row for a mid-month rate change (e.g.
  // a budget bump effective the 21st), sorted by (month, day) from the server. Every day prorates
  // by its own calendar month's day count, so a full month still totals to exactly its row's
  // figure when there's one row, and blends two rows' daily shares when there are two. With no
  // dates chosen the full schedule counts (through the end of its last month, whole, as the sheet
  // totals it); with a range, each day carries its own share. A month past the end of the
  // schedule repeats its last row.
  //
  // September itself is handled differently: it's not a calendar month with a flat monthly rate
  // like Jan-Aug, it's two invoiced tranches whose fee scales with actual ad spend at each
  // tranche's own rate (37.5% for 9/9-9/20, 35% for 9/21 onward) — see renderKpis. So the
  // schedule's own Sep rows are excluded from this day-by-day proration, capped at end of August.
  function contractForRange(rangeOverride) {
    const sched = state.schedule;
    if (!sched.length) return { budget: 0, fee: 0 };
    const { start, end } = rangeOverride || state.range;
    const first = sched[0].month;
    const lastEntry = sched[sched.length - 1];
    const noFilter = !start && !end;
    const from = start || first + '-01';
    // True "all time" counts the whole last scheduled month even if it isn't over yet (the
    // contract's full planned total); an open-ended range instead stops at today.
    const to = end || (noFilter ? toISO(endOfMonth(Number(lastEntry.month.slice(0, 4)), Number(lastEntry.month.slice(5, 7)))) : toISO(pacificToday()));
    let budget = 0, fee = 0;
    for (let d = new Date(from + 'T00:00:00'), stop = new Date(to + 'T00:00:00'); d <= stop; d.setDate(d.getDate() + 1)) {
      const key = d.getFullYear() + '-' + pad(d.getMonth() + 1);
      if (key < first || key >= '2026-09') continue;
      let row = null;
      for (const r of sched) {
        if (r.month > key || (r.month === key && r.day > d.getDate())) break;
        row = r;
      }
      if (!row) continue;
      const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      budget += row.budget / days;
      fee += row.fee / days;
    }
    return { budget, fee };
  }

  function renderKpis(leads, spendRows) {
    const total = leads.length;
    const signed = leads.filter((l) => isSignedCase(l)).length;
    const rejected = leads.filter((l) => statusClass(l.status) === 'status-pill--rejected').length;
    const conversionRate = total > 0 ? (signed / total) * 100 : 0;
    const program = state.filters.program;
    let tiles;

    if (program === 'ppl') {
      // WA leads don't come from our own ad account, but Walker's shared campaign deduction
      // (same day-by-day method as Bryan/PPL) still applies, so spend and CPL are real numbers.
      const open = leads.filter((l) => !(l.status || '').trim()).length;
      const adSpent = partnerDeduction(leads).total;
      const cpl = total > 0 && adSpent > 0 ? adSpent / total : 0;
      const revenue = PPL_PRICE_PER_LEAD * total;
      // The $20k invoice is drawn down by revenue (what Sasooness owes per lead), not ad spend —
      // same pool-since-9/21 pattern as Ad Budget Left above, just against the other side of the
      // ledger.
      const pplLeadsSinceBudget = state.leads.filter((l) => programOf(l) === 'ppl' && l.createdDate >= PPL_BUDGET_FROM).length;
      const pplSpentOfBudget = PPL_PRICE_PER_LEAD * pplLeadsSinceBudget;
      const budgetLeft = PPL_BUDGET - pplSpentOfBudget;
      const pplSplit = fifoRemaining(PPL_BUDGET_PREVIOUS, PPL_BUDGET, pplSpentOfBudget);
      const pplBudgetNote = pplSplit.previousLeft > 0
        ? money(pplSplit.previousLeft) + ' left to exhaust first'
        : 'previous exhausted — ' + money(pplSplit.newLeft) + ' new budget left';
      const costPerCase = signed > 0 && adSpent > 0 ? adSpent / signed : 0;
      const cpcWithFee = signed > 0 ? revenue / signed : 0;
      const profit = revenue - adSpent;
      const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
      const dash = '—';
      tiles = [
        ['leads', 'Total Leads', total.toLocaleString('en-US'), programLabel(program) + ' program', 'Click to clear the filters'],
        ['signed', 'Signed Cases', signed.toLocaleString('en-US'), 'of ' + total.toLocaleString('en-US') + ' leads', 'Click to show only signed cases'],
        ['', 'Conversion Rate', pct(conversionRate), 'signed ÷ leads', ''],
        ['', 'Rejected', rejected.toLocaleString('en-US'), total ? pct((rejected / total) * 100) + ' of leads' : '', ''],
        ['', 'Awaiting Status', open.toLocaleString('en-US'), 'no status yet', ''],
        ['', 'Revenue', money(revenue), '$' + PPL_PRICE_PER_LEAD + ' × ' + total.toLocaleString('en-US') + ' leads', ''],
        ['', 'Ad Spent', adSpent ? money(adSpent) : dash, 'already spent in Walker’s campaign on these leads', ''],
        ['', 'Profit', money(profit), pct(margin) + ' margin · revenue − ad spend', ''],
        ['', 'CPL (Cost / Lead)', cpl ? money(cpl) : dash, 'ad spend ÷ leads', ''],
        ['', 'Budget Left', money(budgetLeft), pplBudgetNote, ''],
        ['', 'Cost / Case', costPerCase ? money(costPerCase) : dash, signed ? 'ad spend ÷ signed cases' : 'no signed cases yet', ''],
        ['', 'CPC + Marketing Fee', cpcWithFee ? money(cpcWithFee) : dash, signed ? 'revenue ÷ signed cases' : 'no signed cases yet', ''],
      ];
    } else {
      // Agency (AZ) mixes two spend sources: the Main Landing Page's own Google/Meta campaigns
      // (attributed by campaign tag) and Walker's shared partner deduction for the Lead Prosper AZ
      // leads inside this same bucket (attributed by origin) — added together for one set of tiles.
      const googleSpend = spendRows.filter((r) => r.platform === 'Google').reduce((a, r) => a + r.spend, 0);
      const metaSpend = spendRows.filter((r) => r.platform === 'Meta').reduce((a, r) => a + r.spend, 0);
      const ownSpend = googleSpend + metaSpend;
      const partnerSpend = partnerDeduction(leads).total;
      const totalSpend = ownSpend + partnerSpend;
      const costsMeaningful = !state.filters.status;
      const cpl = total > 0 && costsMeaningful ? totalSpend / total : 0;
      const costPerCase = signed > 0 && costsMeaningful ? totalSpend / signed : 0;
      const noSplit = 'spend isn’t split by status';
      // Fee and budget belong to the contract as a whole, so they can't be narrowed to a campaign,
      // platform or status.
      const f = state.filters;
      const contractOk = !f.status && !f.campaign && !f.platform;
      const { fee: feeBeforeSept } = contractForRange();
      // Three invoiced tranches make up one combined ad-budget pool: $20,000 (9/9) + $48,750
      // (9/21, 65% of $75k) + $48,750 (10/21, 65% of a second $75k) = $117,500. Tracked from 9/9,
      // the first tranche's own start, not 9/21.
      // A running pool, always accumulating from 9/9 regardless of the picked range's start —
      // only the range's end matters (how much is left as of that date), defaulting to today when
      // no end is picked. The range's start is irrelevant here: picking "October" shouldn't hide
      // the spend that already happened between 9/9 and October.
      const budgetTo = state.range.end || toISO(pacificToday());
      const combinedAgencySpend = (from, to) => {
        const own = state.campaignSpend.filter((r) => r.date >= from && r.date <= to).reduce((a, r) => a + r.spend, 0);
        const partner = partnerDeduction(state.leads.filter((l) => programOf(l) === 'agency' && l.createdDate >= from && l.createdDate <= to)).total;
        return own + partner;
      };
      const spendSinceSept = combinedAgencySpend(AD_BUDGET_FROM, budgetTo);
      const adBudgetLeft = AD_BUDGET_TOTAL - spendSinceSept;
      const adBudgetSplit = fifoRemaining(AD_BUDGET_PREVIOUS, AD_BUDGET_TOTAL, spendSinceSept);
      const adBudgetNote = adBudgetSplit.previousLeft > 0
        ? money(adBudgetSplit.previousLeft) + ' left to exhaust first'
        : 'previous exhausted — ' + money(adBudgetSplit.newLeft) + ' new budget left';
      // September's fee is each tranche's own rate (fee ÷ that invoice's total) applied to actual
      // ad spend in its window, intersected with whatever date range is picked above (unlike Ad
      // Budget Left, which deliberately ignores the range's start) — so spend outside the visible
      // range never contributes fee that isn't actually shown anywhere else on the page:
      //   9/9-9/20: 37.5% only. 9/21-10/8: both tranches are active, so 37.5% + 35%. 10/9 on
      //   (tranche 1 has ended): 35% only.
      const AD_TRANCHE1_END = '2026-10-08';
      const windowSpend = (winFrom, winTo) => {
        const from = state.range.start && state.range.start > winFrom ? state.range.start : winFrom;
        const to = winTo < budgetTo ? winTo : budgetTo;
        return from > to ? 0 : combinedAgencySpend(from, to);
      };
      const spendTranche1 = windowSpend(AD_BUDGET_FROM, AD_TRANCHE1_END);
      const spendTranche2 = windowSpend(AZ_BUDGET_FROM, '9999-12-31');
      const fee = feeBeforeSept + spendTranche1 * 0.375 + spendTranche2 * 0.35;
      const totalCost = totalSpend + fee;
      const cpcWithFee = signed > 0 && costsMeaningful && contractOk ? totalCost / signed : 0;
      const dash = '—';
      tiles = [
        ['leads', 'Total Leads', total.toLocaleString('en-US'), rejected ? rejected.toLocaleString('en-US') + ' rejected' : '', 'Click to clear the filters'],
        ['', 'Cost / Lead', cpl ? money(cpl) : dash, costsMeaningful ? 'ad spend ÷ leads' : noSplit, ''],
        ['signed', 'Signed Cases', signed.toLocaleString('en-US'), 'of ' + total.toLocaleString('en-US') + ' leads', 'Click to show only signed cases'],
        ['', 'Conversion Rate', pct(conversionRate), 'signed ÷ leads', ''],
        ['', 'CPC (Cost / Case)', costPerCase ? money(costPerCase) : dash, !costsMeaningful ? noSplit : signed ? 'ad spend ÷ signed cases' : 'no signed cases yet', ''],
        ['__break__'],
        ['', 'Ad Spend', money(totalSpend), money(ownSpend) + ' own ads + ' + money(partnerSpend) + ' Lead Prosper', ''],
        ['', 'Ad Budget Left', contractOk ? money(adBudgetLeft) : dash, contractOk ? adBudgetNote : '', ''],
        ['', 'Marketing Fee', contractOk ? money(fee) : dash, contractOk ? 'monthly fee from the contract' : 'contract-level, not split by filter', ''],
        ['', 'Total Cost', contractOk ? money(totalCost) : dash, contractOk ? 'ad spend + marketing fee' : 'contract-level, not split by filter', ''],
        ['', 'CPC + Marketing Fee', cpcWithFee ? money(cpcWithFee) : dash, !costsMeaningful || !contractOk ? 'not split by filter' : signed ? 'total cost ÷ signed cases' : 'no signed cases yet', ''],
      ];
    }
    renderLayoutToolbar();
    const overrideOf = (label, layout) => (layout && layout.titles && layout.titles[label]) || {};
    const tileHtml = (layout) => ([key, label, value, sub, hint]) => {
      const o = overrideOf(label, layout);
      return '<div class="kpi' + (key ? ' is-clickable' : '') + (key === 'signed' || label === 'Profit' ? ' kpi--highlight' : '') + (key === 'signed' && state.filters.status === SIGNED ? ' is-selected' : '') + '"' + (key ? ' data-tile="' + key + '" title="' + hint + '"' : '') + '>' +
        '<div class="kpi-label">' + escapeHtml(o.title || label) + '</div>' +
        '<div class="kpi-value num">' + value + '</div>' +
        (sub || o.sub ? '<div class="kpi-sub">' + escapeHtml(o.sub || sub) + '</div>' : '') + '</div>';
    };

    // An admin-chosen tile order/hidden-set/renaming (or the working copy while Mark is editing)
    // replaces the hardcoded two-row grouping above with one flat, re-sortable list — '__break__'
    // markers only matter for the default, un-customized layout.
    const saved = state.layout[program];
    const editingThis = state.editingLayout && state.editProgram === program;
    if (editingThis || (saved && saved.order && saved.order.length)) {
      const flat = tiles.filter((t) => t[0] !== '__break__');
      if (editingThis) {
        if (!state.dragTileLayout) {
          state.dragTileLayout = {
            order: reorderByLabels(flat, (saved && saved.order) || []).map((t) => t[1]),
            hidden: Object.assign({}, saved && saved.hidden),
            titles: JSON.parse(JSON.stringify((saved && saved.titles) || {})),
          };
        }
        const layout = state.dragTileLayout;
        const ordered = reorderByLabels(flat, layout.order);
        const editHtml = ([, label, value, sub]) => {
          const o = overrideOf(label, layout);
          const hidden = !!layout.hidden[label];
          return '<div class="kpi is-draggable' + (hidden ? ' is-panel-hidden' : '') + '" draggable="true" data-drag-label="' + escapeHtml(label) + '">' +
            '<div class="kpi-drag-handle">⠿ drag <button type="button" data-hide-tile="' + escapeHtml(label) + '">' + (hidden ? 'Show' : 'Hide') + '</button></div>' +
            '<div class="kpi-label" contenteditable="true" data-tile-field="title" data-tile-label="' + escapeHtml(label) + '">' + escapeHtml(o.title || label) + '</div>' +
            '<div class="kpi-value num">' + value + '</div>' +
            '<div class="kpi-sub" contenteditable="true" data-tile-field="sub" data-tile-label="' + escapeHtml(label) + '">' + escapeHtml(o.sub || sub || '') + '</div></div>';
        };
        $('#kpi-row').className = 'kpi-row';
        $('#kpi-row').innerHTML = ordered.map(editHtml).join('');
      } else {
        const ordered = reorderByLabels(flat, saved.order).filter((t) => !(saved.hidden && saved.hidden[t[1]]));
        $('#kpi-row').className = 'kpi-row';
        $('#kpi-row').innerHTML = ordered.map(tileHtml(saved)).join('');
      }
      $('#kpi-row-2').hidden = true;
      $('#kpi-row-2').innerHTML = '';
      return;
    }

    const groups = [[]];
    for (const t of tiles) { if (t[0] === '__break__') groups.push([]); else groups[groups.length - 1].push(t); }
    $('#kpi-row').className = 'kpi-row' + (groups[0].length === 4 || groups[0].length === 5 ? ' kpi-row--' + groups[0].length : '');
    $('#kpi-row').innerHTML = groups[0].map(tileHtml(null)).join('');
    $('#kpi-row-2').hidden = groups.length < 2;
    $('#kpi-row-2').className = 'kpi-row' + (groups.length > 1 && groups[1].length === 5 ? ' kpi-row--5' : '');
    $('#kpi-row-2').innerHTML = groups.length > 1 ? groups[1].map(tileHtml(null)).join('') : '';
  }

  // Sorts tiles by a saved/working label order; tiles whose label isn't in `order` (e.g. a tile
  // added after the layout was last saved) keep their original relative order, appended at the end.
  function reorderByLabels(list, order) {
    const idx = new Map((order || []).map((l, i) => [l, i]));
    return list
      .map((t, i) => ({ t, i }))
      .sort((a, b) => {
        const ia = idx.has(a.t[1]) ? idx.get(a.t[1]) : 1e9 + a.i;
        const ib = idx.has(b.t[1]) ? idx.get(b.t[1]) : 1e9 + b.i;
        return ia - ib;
      })
      .map((x) => x.t);
  }

  // Only Mark gets the drag UI; everyone else (other admins, clients) just sees whatever order he
  // last saved, with no button at all — same "only I can touch it, it still applies to everyone"
  // split as /api/visits being Mark-only server-side.
  function renderLayoutToolbar() {
    const canEdit = state.me && state.me.name === 'Mark';
    $('#kpi-toolbar').hidden = !canEdit;
    if (!canEdit) return;
    $('#layout-edit-btn').hidden = state.editingLayout;
    $('#layout-save-btn').hidden = !state.editingLayout;
    $('#layout-cancel-btn').hidden = !state.editingLayout;
  }

  // ================= whole-panel customization (order, visibility, renaming) ===================
  function emptyPanelLayout() { return { order: [], hidden: {}, titles: {} }; }

  function renderPanelToolbar() {
    const canEdit = state.me && state.me.name === 'Mark';
    $('#panel-toolbar').hidden = !canEdit;
    if (!canEdit) return;
    $('#panel-edit-btn').hidden = state.editingPanels;
    $('#panel-save-btn').hidden = !state.editingPanels;
    $('#panel-cancel-btn').hidden = !state.editingPanels;
  }

  // Runs after every other render* call: moves blocks into their saved (or working, mid-edit)
  // order, applies saved hide flags on top of whatever each panel's own render already decided
  // (never force-shows something that's conditionally hidden for the current program), applies
  // renamed titles/subtitles, and — only while editingPanels — adds the drag handle bar and makes
  // the title/subtitle directly editable.
  function applyPanelLayout() {
    renderPanelToolbar();
    const layout = state.editingPanels ? state.dragPanelLayout : (state.panelLayout || emptyPanelLayout());
    const idx = new Map((layout.order || []).map((id, i) => [id, i]));
    const blocks = PANEL_BLOCKS
      .map((b, i) => ({ b, el: $(b.el), i }))
      .filter((x) => x.el)
      .sort((x, y) => {
        const ix = idx.has(x.b.id) ? idx.get(x.b.id) : 1e9 + x.i;
        const iy = idx.has(y.b.id) ? idx.get(y.b.id) : 1e9 + y.i;
        return ix - iy;
      });

    for (const { b, el } of blocks) {
      el.parentNode.appendChild(el); // append in the sorted order, moving each to the end in turn

      if (layout.hidden && layout.hidden[b.id]) el.hidden = true;
      el.classList.toggle('is-panel-hidden', state.editingPanels && !!(layout.hidden && layout.hidden[b.id]));

      const override = layout.titles && layout.titles[b.id];
      const titleEl = b.title ? el.querySelector(b.title) : null;
      const subEl = b.sub ? el.querySelector(b.sub) : null;
      if (!state.editingPanels) {
        if (titleEl && override && override.title) titleEl.textContent = override.title;
        if (subEl && override && override.sub) subEl.textContent = override.sub;
        el.classList.remove('is-editing');
        const bar = el.querySelector(':scope > .panel-edit-bar');
        if (bar) bar.remove();
        if (titleEl) titleEl.removeAttribute('contenteditable');
        if (subEl) subEl.removeAttribute('contenteditable');
        continue;
      }

      // Edit mode: drag handle + hide toggle bar, and inline-editable title/subtitle.
      el.classList.add('is-editing');
      el.draggable = false; // the bar below is the drag handle, not the whole panel
      let bar = el.querySelector(':scope > .panel-edit-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'panel-edit-bar';
        bar.draggable = true;
        bar.dataset.dragPanel = b.id;
        bar.innerHTML = '⠿ drag to reorder <button type="button" data-hide-panel="' + b.id + '">' +
          (layout.hidden && layout.hidden[b.id] ? 'Show' : 'Hide') + '</button>';
        el.prepend(bar);
      } else {
        bar.querySelector('button').textContent = layout.hidden && layout.hidden[b.id] ? 'Show' : 'Hide';
      }
      el.hidden = false; // always visible while editing, so a hidden panel can still be re-shown
      // Re-apply any not-yet-saved edit before wiring contenteditable, so a render() triggered by
      // something else (dragging a different panel, say) doesn't blow away in-progress typing.
      if (titleEl) {
        if (override && override.title) titleEl.textContent = override.title;
        titleEl.setAttribute('contenteditable', 'true');
        titleEl.oninput = () => {
          if (!layout.titles[b.id]) layout.titles[b.id] = {};
          layout.titles[b.id].title = titleEl.textContent;
        };
      }
      if (subEl) {
        if (override && override.sub) subEl.textContent = override.sub;
        subEl.setAttribute('contenteditable', 'true');
        subEl.oninput = () => {
          if (!layout.titles[b.id]) layout.titles[b.id] = {};
          layout.titles[b.id].sub = subEl.textContent;
        };
      }
    }
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
      if (isSignedCase(l)) byMonth.get(key).cases++;
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
      const signed = list.filter((l) => isSignedCase(l)).length;
      const rejected = list.filter((l) => statusClass(l.status) === 'status-pill--rejected').length;
      return '<tr class="' + cls(key, list.length === 0) + '" data-program="' + key + '"><td class="name-cell">' + escapeHtml(programLabel(key)) + '</td>' +
        '<td class="td-num num">' + list.length.toLocaleString('en-US') + '</td>' +
        '<td class="td-num num">' + signed.toLocaleString('en-US') + '</td>' +
        '<td class="td-num num">' + (list.length ? pct((signed / list.length) * 100) : '—') + '</td>' +
        '<td class="td-num num">' + rejected.toLocaleString('en-US') + '</td></tr>';
    };
    let html = '';
    for (const [key, list] of groups) html += line(key, list);
    const signedAll = leads.filter((l) => isSignedCase(l)).length;
    const rejectedAll = leads.filter((l) => statusClass(l.status) === 'status-pill--rejected').length;
    html += '<tr class="row-total"><td>Total</td><td class="td-num num">' + leads.length.toLocaleString('en-US') + '</td><td class="td-num num">' + signedAll.toLocaleString('en-US') + '</td><td class="td-num num">' + (leads.length ? pct((signedAll / leads.length) * 100) : '—') + '</td><td class="td-num num">' + rejectedAll.toLocaleString('en-US') + '</td></tr>';
    $('#source-body').innerHTML = html;
  }

  // ================= period comparison (independent of the date-range picker) =================
  // Each period is [start, end] inclusive, computed off today's Pacific date, not state.range.
  function comparisonWindows(key) {
    const today = pacificToday();
    const thisMon = mondayOf(today);
    if (key === 'thisweek_lastweek') {
      const lastMon = addDays(thisMon, -7), lastSun = addDays(lastMon, 6);
      return { a: { start: toISO(lastMon), end: toISO(lastSun), label: 'Last week' }, b: { start: toISO(thisMon), end: toISO(today), label: 'This week' } };
    }
    if (key === 'lastweek_weekbefore') {
      const lastMon = addDays(thisMon, -7), lastSun = addDays(lastMon, 6);
      const beforeMon = addDays(lastMon, -7), beforeSun = addDays(beforeMon, 6);
      return { a: { start: toISO(beforeMon), end: toISO(beforeSun), label: 'Week before last' }, b: { start: toISO(lastMon), end: toISO(lastSun), label: 'Last week' } };
    }
    // thismonth_lastmonth
    const y = today.getFullYear(), m = today.getMonth() + 1;
    const lastM = m === 1 ? 12 : m - 1, lastY = m === 1 ? y - 1 : y;
    return {
      a: { start: toISO(startOfMonth(lastY, lastM)), end: toISO(endOfMonth(lastY, lastM)), label: 'Last month' },
      b: { start: toISO(startOfMonth(y, m)), end: toISO(today), label: 'This month' },
    };
  }
  // Every metric a program's own KPI tiles show, recomputed for an arbitrary window instead of
  // the page's main date-range picker — same formulas as renderKpis, just parametrized by
  // win.start/win.end so two different periods can be computed side by side.
  function agencyFinancialsForWindow(win) {
    const leads = state.leads.filter((l) => programOf(l) === 'agency' && l.createdDate >= win.start && l.createdDate <= win.end);
    const total = leads.length;
    const signed = leads.filter((l) => isSignedCase(l)).length;
    const rejected = leads.filter((l) => statusClass(l.status) === 'status-pill--rejected').length;
    const ownSpend = state.campaignSpend.filter((r) => r.date >= win.start && r.date <= win.end).reduce((a, r) => a + r.spend, 0);
    const partnerSpend = partnerDeduction(leads).total;
    const totalSpend = ownSpend + partnerSpend;
    const cpl = total > 0 ? totalSpend / total : 0;
    const costPerCase = signed > 0 ? totalSpend / signed : 0;
    const { fee: feeBeforeSept } = contractForRange({ start: win.start, end: win.end });
    const budgetTo = win.end;
    const combinedAgencySpend = (from, to) => {
      const own = state.campaignSpend.filter((r) => r.date >= from && r.date <= to).reduce((a, r) => a + r.spend, 0);
      const partner = partnerDeduction(state.leads.filter((l) => programOf(l) === 'agency' && l.createdDate >= from && l.createdDate <= to)).total;
      return own + partner;
    };
    const adBudgetLeft = AD_BUDGET_TOTAL - combinedAgencySpend(AD_BUDGET_FROM, budgetTo);
    const AD_TRANCHE1_END = '2026-10-08';
    const windowSpend = (winFrom, winTo) => {
      const from = win.start && win.start > winFrom ? win.start : winFrom;
      const to = winTo < budgetTo ? winTo : budgetTo;
      return from > to ? 0 : combinedAgencySpend(from, to);
    };
    const fee = feeBeforeSept + windowSpend(AD_BUDGET_FROM, AD_TRANCHE1_END) * 0.375 + windowSpend(AZ_BUDGET_FROM, '9999-12-31') * 0.35;
    const totalCost = totalSpend + fee;
    return {
      'Total Leads': total, 'Signed Cases': signed, 'Conversion Rate': total ? (signed / total) * 100 : 0, 'Rejected': rejected,
      'Cost / Lead': cpl, 'CPC (Cost / Case)': costPerCase, 'Ad Spend': totalSpend, 'Ad Budget Left': adBudgetLeft,
      'Marketing Fee': fee, 'Total Cost': totalCost, 'CPC + Marketing Fee': signed > 0 ? totalCost / signed : 0,
    };
  }
  function pplFinancialsForWindow(win) {
    const leads = state.leads.filter((l) => programOf(l) === 'ppl' && l.createdDate >= win.start && l.createdDate <= win.end);
    const total = leads.length;
    const signed = leads.filter((l) => isSignedCase(l)).length;
    const rejected = leads.filter((l) => statusClass(l.status) === 'status-pill--rejected').length;
    const open = leads.filter((l) => !(l.status || '').trim()).length;
    const adSpent = partnerDeduction(leads).total;
    const cpl = total > 0 ? adSpent / total : 0;
    const revenue = PPL_PRICE_PER_LEAD * total;
    const pplLeadsSinceBudget = state.leads.filter((l) => programOf(l) === 'ppl' && l.createdDate >= PPL_BUDGET_FROM && l.createdDate <= win.end).length;
    const budgetLeft = PPL_BUDGET - PPL_PRICE_PER_LEAD * pplLeadsSinceBudget;
    const costPerCase = signed > 0 ? adSpent / signed : 0;
    const profit = revenue - adSpent;
    return {
      'Total Leads': total, 'Signed Cases': signed, 'Conversion Rate': total ? (signed / total) * 100 : 0, 'Rejected': rejected,
      'Awaiting Status': open, 'Revenue': revenue, 'Ad Spent': adSpent, 'Profit': profit, 'CPL (Cost / Lead)': cpl,
      'Budget Left': budgetLeft, 'Cost / Case': costPerCase, 'CPC + Marketing Fee': signed > 0 ? revenue / signed : 0,
    };
  }
  function periodMetrics(win) {
    return state.filters.program === 'ppl' ? pplFinancialsForWindow(win) : agencyFinancialsForWindow(win);
  }

  const COMPARE_PCT_METRICS = new Set(['Conversion Rate']);
  const COMPARE_MONEY_METRICS = new Set([
    'Cost / Lead', 'CPC (Cost / Case)', 'Ad Spend', 'Ad Budget Left', 'Marketing Fee', 'Total Cost', 'CPC + Marketing Fee',
    'Revenue', 'Ad Spent', 'Profit', 'CPL (Cost / Lead)', 'Budget Left', 'Cost / Case',
  ]);
  function renderComparison() {
    const key = $('#compare-select').value;
    const { a, b } = comparisonWindows(key);
    $('#compare-th-a').textContent = a.label;
    $('#compare-th-b').textContent = b.label;
    $('#compare-program-label').textContent = programLabel(state.filters.program);
    const ma = periodMetrics(a), mb = periodMetrics(b);
    const fmt = (metric, v) => (COMPARE_PCT_METRICS.has(metric) ? pct(v) : COMPARE_MONEY_METRICS.has(metric) ? money(v) : v.toLocaleString('en-US'));
    const rows = Object.keys(ma).map((metric) => {
      const va = ma[metric], vb = mb[metric];
      const diff = vb - va;
      const diffPct = va ? (diff / va) * 100 : (vb ? 100 : 0);
      const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
      const absDiffPct = Math.abs(diffPct).toLocaleString('en-US', { maximumFractionDigits: 1 });
      let changeText;
      if (COMPARE_PCT_METRICS.has(metric)) changeText = sign + Math.abs(diff).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' pt';
      else if (COMPARE_MONEY_METRICS.has(metric)) changeText = sign + money(Math.abs(diff)) + ' (' + sign + absDiffPct + '%)';
      else changeText = sign + Math.abs(diff).toLocaleString('en-US') + ' (' + sign + absDiffPct + '%)';
      const changeCls = diff > 0 ? 'compare-up' : diff < 0 ? 'compare-down' : '';
      return '<tr><td class="name-cell">' + escapeHtml(metric) + '</td>' +
        '<td class="td-num num">' + fmt(metric, va) + '</td>' +
        '<td class="td-num num">' + fmt(metric, vb) + '</td>' +
        '<td class="td-num num ' + changeCls + '">' + escapeHtml(changeText) + '</td></tr>';
    }).join('');
    $('#compare-body').innerHTML = rows;
  }

  // ================= status summary (full breakdown of raw CRM status values) =================
  function renderStatusSummary() {
    const leads = leadsFor('status');
    const groups = statusGroups(leads);
    const total = leads.length;
    const sf = state.filters.status;
    const isSelected = (key) => sf === key || (sf === SIGNED && isSignedStatus(key));
    const row = ([key, count]) => '<tr class="is-clickable' + (isSelected(key) ? ' is-selected' : sf ? ' is-dim' : '') + '" data-status-row="' + escapeHtml(key) + '"><td class="name-cell">' + escapeHtml(key) + '</td>' +
      '<td class="td-num num">' + count.toLocaleString('en-US') + '</td>' +
      '<td class="td-num num">' + (total ? pct((count / total) * 100) : '—') + '</td></tr>';
    let html = groups.map(row).join('');
    html += '<tr class="row-total"><td>Total</td><td class="td-num num">' + total.toLocaleString('en-US') + '</td><td class="td-num num">' + (total ? '100%' : '—') + '</td></tr>';
    $('#status-summary-body').innerHTML = html;
  }

  // ================= program tabs (All / OG / Agency / PPL) =================
  function renderSegmentTabs() {
    const base = leadsFor('program');
    const counts = { og: 0, agency: 0, ppl: 0 };
    for (const l of base) counts[programOf(l)]++;
    const sel = state.filters.program;
    const tab = (key, label, n) => '<button class="segment-tab' + (sel === key ? ' is-active' : '') + '" data-segment="' + key + '">' + escapeHtml(label) + '<span class="n">' + n.toLocaleString('en-US') + '</span></button>';
    $('#segment-tabs').innerHTML = PROGRAMS.map((p) => tab(p.key, p.label, counts[p.key])).join('');

    // PPL has no ad spend or campaigns of its own, so the spend chart and campaign table don't
    // apply there. Agency does (the Main Landing Page's own Google/Meta campaigns), so it keeps them.
    const noSpend = sel === 'ppl';
    $('#spend-panel').hidden = noSpend;
    $('#campaign-panel').hidden = noSpend;
    const note = $('#program-note');
    note.hidden = false;
    note.innerHTML = sel === 'agency'
      ? '<strong>Agency</strong> combines the Main Landing Page&rsquo;s own campaigns with Lead Prosper leads from the Walker Agency AZ campaign &mdash; both are the AZ side of the business. The spend chart and campaign table below cover the Main Landing Page only; Lead Prosper AZ leads have no campaign of their own, only Sasooness&rsquo;s share of Walker&rsquo;s shared spend (see below).'
      : '<strong>PPL</strong> means the Pay Per Lead model (Lead Prosper WA). Ad spend here is Sasooness’s share of Walker’s shared campaign, not our own ad account.';
  }

  // ================= lead details table (secondary) =================
  function renderChips() {
    const base = leadsFor('status');
    const counts = { Signed: 0, Rejected: 0, Reviewing: 0 };
    for (const l of base) counts[statusBucket(l)]++;
    const sf = state.filters.status;
    const chips = ['<button class="chip' + (!sf ? ' is-active' : '') + '" data-status="">All<span class="n">' + base.length + '</span></button>']
      .concat(['Signed', 'Rejected', 'Reviewing'].map((b) =>
        '<button class="chip' + (sf === b ? ' is-active' : '') + '" data-status="' + b + '">' + b + '<span class="n">' + counts[b] + '</span></button>'
      ));
    $('#status-chips').innerHTML = chips.join('');
  }

  // Cost per lead for each lead: a partner (Agency/PPL) lead carries its Walker campaign's cost per
  // lead on the day it reached Sasooness (all leads, regardless of status); an OG lead carries its own
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
      // Whether this lead is actually Walker-sourced, not just which program tab it's in — OG
      // leads inside the combined Agency bucket carry an origin object too, just with no
      // campaignId (see ogOrigin in sasooness.js), so they must still price off their own campaign.
      const partner = !!o.campaignId;
      const source = o.contactSource || (!partner && platformOf.get(l.campaign) ? platformOf.get(l.campaign) + ' ad' : '');
      const campaignName = o.campaignName || l.campaign;
      let cplHtml = dash;
      if (partner) {
        const c = cpl.walker.get(o.campaignId + '|' + l.createdDate);
        if (c) cplHtml = money(c);
      } else if (cpl.og.get(l.campaign)) {
        cplHtml = money(cpl.og.get(l.campaign));
      }
      let daysToQualify = dash;
      if (l.signedUpDate && l.createdDate) {
        const ms = new Date(l.signedUpDate + 'T00:00:00Z') - new Date(l.createdDate + 'T00:00:00Z');
        const d = Math.round(ms / 86400000);
        if (d >= 0) daysToQualify = d.toLocaleString('en-US');
      }
      return '<tr>' +
        '<td><div class="name-cell">' + escapeHtml(l.name || '(no name)') + '</div><div class="email-cell">' + escapeHtml(l.email || l.phone || '') + (l.email && l.phone ? ' &middot; ' + escapeHtml(l.phone) : '') + '</div></td>' +
        '<td>' + escapeHtml(l.contactMethod || dash) + '</td>' +
        '<td>' + escapeHtml(l.createdDate || dash) + '' + '</td>' +
        '<td><span class="status-pill ' + statusClass(l.status) + '">' + escapeHtml(l.status || dash) + '</span>' + (l.subStatus ? '<div class="kpi-sub" style="margin-top:4px">' + escapeHtml(l.subStatus) + '</div>' : '') + '</td>' +
        '<td>' + escapeHtml(l.signedUpDate || dash) + '</td>' +
        '<td>' + escapeHtml(daysToQualify) + '</td>' +
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

    // Only leads actually sourced from Walker's shared campaign belong here — under the combined
    // Agency bucket that excludes the Main Landing Page's own leads, which were never joined to it.
    const leads = leadsFor().filter((l) => l.origin && l.origin.campaignId).slice().sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));
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

    // One strip of facts per Walker campaign: the Sasooness ad spend that follows from the day-by-day
    // table below, the campaign, and the leads sent.
    const cents0 = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    $('#deduct-facts').innerHTML = rows.length ? rows.map((r) => {
      const statuses = r.statuses.map(([st, k]) => k + ' ' + st.toLowerCase()).join(' · ');
      return '<div class="fact fact--total"><div class="fact-label">Sasooness ad spend</div><div class="fact-value">' + cents0(r.deduct) + '</div><div class="fact-sub">already spent in Walker’s campaign · sum of the days below</div></div>' +
        '<div class="fact"><div class="fact-label">Walker campaign</div><div class="fact-value">' + escapeHtml(r.name) + '</div></div>' +
        '<div class="fact"><div class="fact-label">Sent to Sasooness</div><div class="fact-value">' + r.n + ' lead' + (r.n === 1 ? '' : 's') + '</div><div class="fact-sub">' + escapeHtml(statuses) + '</div></div>';
    }).join('') : '<div class="fact"><div class="fact-value">No Walker campaign found for the leads in this range.</div></div>';

    // Two decimals here so every step can be checked by hand: spend ÷ Walker leads = cost per
    // lead; cost per lead × leads sent = Sasooness's ad spend for the day.
    const cents = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const sentTotal = ded.days.reduce((t, d) => t + d.n, 0);
    $('#deduct-days-body').innerHTML = ded.days.map((d) => (
      '<tr><td>' + escapeHtml(d.date) + '</td><td class="name-cell">' + escapeHtml(d.name) + '</td>' +
      '<td class="td-num num">' + cents(d.spend) + '</td>' +
      '<td class="td-num num">' + d.walkerLeads.toLocaleString('en-US') + '</td>' +
      '<td class="td-num num">' + d.n + '</td>' +
      '<td class="td-num num">' + (d.cpl ? cents(d.cpl) : dash) + '</td>' +
      '<td class="td-num num">' + (d.deduct ? cents(d.deduct) : dash) + '</td></tr>'
    )).join('') + (ded.days.length
      ? '<tr class="row-total"><td>Total</td><td></td><td></td><td></td><td class="td-num num">' + sentTotal + '</td><td></td><td class="td-num num">' + cents(ded.total) + '</td></tr>'
      : '<tr class="row-muted"><td colspan="7">No leads to show for this range.</td></tr>');
  }

  // ================= leads per day (Main Landing Page + Lead Prosper AZ combined) =================
  // Respects the page's own date range like every other panel — whatever's picked at the top
  // (a week, a month, all time, a custom range) is what this table breaks down by day. A day's
  // spend is the Main Landing Page's own campaign spend that day (so it's naturally $0 for a day
  // with only Lead Prosper AZ leads) plus Sasooness's share of Walker's shared spend that day, the
  // same day-by-day deduction used below. Only days that actually have a lead get a row — over
  // "All time" that's the ~200 days with activity, not every calendar day since the contract
  // started.
  function renderDailyLeads() {
    const show = state.filters.program === 'agency';
    $('#daily-leads-panel').hidden = !show;
    if (!show) return;
    const leads = leadsFor();
    const byDay = new Map(); // date -> { og, az }
    for (const l of leads) {
      if (!l.createdDate) continue;
      const isAZ = !!(l.origin && l.origin.campaignId);
      const cur = byDay.get(l.createdDate) || { og: 0, az: 0 };
      if (isAZ) cur.az++; else cur.og++;
      byDay.set(l.createdDate, cur);
    }
    const ownSpendByDay = new Map();
    for (const r of spendFor('campaign')) ownSpendByDay.set(r.date, (ownSpendByDay.get(r.date) || 0) + r.spend);
    const azSpendByDay = new Map();
    for (const d of partnerDeduction(leads).days) azSpendByDay.set(d.date, (azSpendByDay.get(d.date) || 0) + d.deduct);

    // "All time" has no natural end to a day-by-day table, so cap it to the most recent 7 days
    // with a lead — any other picked range (a week, a month, a custom span) is already bounded by
    // that range and shows every day within it.
    let dates = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
    if (state.range.key === 'all') dates = dates.slice(0, 7);
    const dash = '—';
    $('#daily-leads-body').innerHTML = dates.length ? dates.map((date) => {
      const { og, az } = byDay.get(date);
      const total = og + az;
      const spend = (ownSpendByDay.get(date) || 0) + (azSpendByDay.get(date) || 0);
      const cpl = total > 0 && spend > 0 ? spend / total : 0;
      return '<tr><td>' + escapeHtml(date) + '</td>' +
        '<td class="td-num num">' + total.toLocaleString('en-US') + '</td>' +
        '<td class="td-num num">' + og.toLocaleString('en-US') + '</td>' +
        '<td class="td-num num">' + az.toLocaleString('en-US') + '</td>' +
        '<td class="td-num num">' + (spend ? money(spend) : dash) + '</td>' +
        '<td class="td-num num">' + (cpl ? money(cpl) : dash) + '</td></tr>';
    }).join('') : '<tr class="row-muted"><td colspan="6">No leads to show for this range.</td></tr>';
  }

  // ================= top rejection reasons =================
  // Why leads were rejected, from each rejected lead's SubStatus (the sheet's reason column),
  // most common first, over whatever the page's filters currently select.
  function reasonOf(l) { return (l.subStatus || '').trim() || '(no reason given)'; }

  function renderReasons() {
    const rejected = leadsFor('reason').filter((l) => (l.status || '').toLowerCase().includes('reject'));
    const counts = new Map();
    for (const l of rejected) {
      const reason = reasonOf(l);
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
    const sel = state.filters.reason;
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    $('#reasons-sub').textContent = rejected.length ? rejected.length.toLocaleString('en-US') + ' rejected leads' : '';
    $('#reasons-empty').hidden = rows.length > 0;
    $('#reasons-body').innerHTML = rows.map(([reason, n]) =>
      '<tr class="is-clickable' + (sel === reason ? ' is-selected' : sel ? ' is-dim' : '') + '" data-reason="' + escapeHtml(reason) + '"><td class="name-cell">' + escapeHtml(reason) + '</td>' +
      '<td class="td-num num">' + n.toLocaleString('en-US') + '</td>' +
      '<td class="td-num num">' + pct((n / rejected.length) * 100) + '</td></tr>'
    ).join('');
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
    renderStatusSummary();
    renderComparison();
    renderSegmentTabs();
    renderDailyLeads();
    renderOrigins();
    renderChips();
    renderLeadsTable(leads);
    renderReasons();
    applyPanelLayout();
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
    const reasonRow = e.target.closest('tr[data-reason]');
    if (reasonRow) { toggleFilter('reason', reasonRow.dataset.reason); return; }
    const campaignRow = e.target.closest('tr[data-campaign]');
    if (campaignRow) { toggleFilter('campaign', campaignRow.dataset.campaign); return; }
    const programRow = e.target.closest('tr[data-program]');
    if (programRow) { state.filters.program = programRow.dataset.program; render(); return; }
    const statusRow = e.target.closest('tr[data-status-row]');
    if (statusRow) { toggleFilter('status', statusRow.dataset.statusRow); return; }
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
  $('#compare-select').addEventListener('change', renderComparison);
  $('#refresh-btn').addEventListener('click', () => {
    $('#refresh-btn').classList.add('is-spinning');
    fetchData().finally(() => setTimeout(() => $('#refresh-btn').classList.remove('is-spinning'), 400));
  });

  // ================= KPI layout customization (Mark-only; saved order applies to everyone) =====
  async function fetchMe() {
    try { const r = await fetch('/api/me', { cache: 'no-store' }); state.me = r.ok ? await r.json() : null; } catch (err) { state.me = null; }
  }
  function emptyTileLayout() { return { order: [], hidden: {}, titles: {} }; }
  async function fetchLayout(program) {
    try {
      const r = await fetch('/api/layout?board=sasooness&program=' + program, { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      const v = d && d.order;
      // Older saves stored a bare array (order only) — treat that as just the order field.
      state.layout[program] = Array.isArray(v) ? { order: v, hidden: {}, titles: {} } : (v || null);
    } catch (err) { state.layout[program] = null; }
  }

  $('#layout-edit-btn').addEventListener('click', () => {
    state.editingLayout = true;
    state.editProgram = state.filters.program;
    state.dragTileLayout = null;
    render();
  });
  $('#layout-cancel-btn').addEventListener('click', () => {
    state.editingLayout = false;
    state.editProgram = null;
    state.dragTileLayout = null;
    render();
  });
  $('#layout-save-btn').addEventListener('click', async () => {
    const program = state.editProgram;
    const payload = state.dragTileLayout;
    try {
      const r = await fetch('/api/layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: 'sasooness', program, order: payload }),
      });
      if (!r.ok) throw new Error('save failed');
      state.layout[program] = payload;
      state.editingLayout = false;
      state.editProgram = null;
      state.dragTileLayout = null;
      render();
    } catch (err) {
      alert('Could not save the layout — try again.');
    }
  });

  document.addEventListener('click', (e) => {
    const hideBtn = e.target.closest('[data-hide-tile]');
    if (!hideBtn || !state.dragTileLayout) return;
    e.stopPropagation();
    const label = hideBtn.dataset.hideTile;
    state.dragTileLayout.hidden[label] = !state.dragTileLayout.hidden[label];
    render();
  });
  document.addEventListener('input', (e) => {
    const el = e.target.closest('[data-tile-field]');
    if (!el || !state.dragTileLayout) return;
    const label = el.dataset.tileLabel;
    if (!state.dragTileLayout.titles[label]) state.dragTileLayout.titles[label] = {};
    state.dragTileLayout.titles[label][el.dataset.tileField] = el.textContent;
  });

  // Native HTML5 drag-and-drop over whichever tile is currently under the pointer; reorders
  // state.dragTileLayout.order and re-renders on drop, same working-copy-then-save pattern as
  // every other filter on this page.
  let dragSrcLabel = null;
  document.addEventListener('dragstart', (e) => {
    const el = e.target.closest('.kpi[data-drag-label]');
    if (!el) return;
    dragSrcLabel = el.dataset.dragLabel;
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('is-dragging');
  });
  document.addEventListener('dragend', (e) => {
    const el = e.target.closest('.kpi[data-drag-label]');
    if (el) el.classList.remove('is-dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (!dragSrcLabel || !e.target.closest('.kpi[data-drag-label]')) return;
    e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const el = e.target.closest('.kpi[data-drag-label]');
    if (!el || !dragSrcLabel || !state.dragTileLayout) return;
    e.preventDefault();
    const targetLabel = el.dataset.dragLabel;
    if (targetLabel !== dragSrcLabel) {
      const order = state.dragTileLayout.order.slice();
      const from = order.indexOf(dragSrcLabel);
      const to = order.indexOf(targetLabel);
      if (from !== -1 && to !== -1) {
        order.splice(from, 1);
        order.splice(to, 0, dragSrcLabel);
        state.dragTileLayout.order = order;
      }
    }
    dragSrcLabel = null;
    render();
  });

  // ================= whole-panel customization: fetch, buttons, drag, hide toggle =============
  async function fetchPanelLayout() {
    try {
      const r = await fetch('/api/layout?board=sasooness&program=panels', { cache: 'no-store' });
      const d = r.ok ? await r.json() : null;
      state.panelLayout = (d && d.order) || emptyPanelLayout();
    } catch (err) { state.panelLayout = emptyPanelLayout(); }
  }

  $('#panel-edit-btn').addEventListener('click', () => {
    state.editingPanels = true;
    // Deep-enough copy to edit freely without touching the saved version until Save is clicked.
    const saved = state.panelLayout || emptyPanelLayout();
    state.dragPanelLayout = {
      order: saved.order ? saved.order.slice() : [],
      hidden: Object.assign({}, saved.hidden),
      titles: JSON.parse(JSON.stringify(saved.titles || {})),
    };
    render();
  });
  $('#panel-cancel-btn').addEventListener('click', () => {
    state.editingPanels = false;
    state.dragPanelLayout = null;
    render();
  });
  $('#panel-save-btn').addEventListener('click', async () => {
    // The drag code below keeps dragPanelLayout.order updated only for panels actually dragged;
    // fill in the rest from current DOM order so nothing dropped out of the saved order.
    const order = PANEL_BLOCKS.map((b) => $(b.el)).filter(Boolean)
      .sort((a, c) => (a.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((el) => PANEL_BLOCKS.find((b) => $(b.el) === el).id);
    const payload = { order, hidden: state.dragPanelLayout.hidden, titles: state.dragPanelLayout.titles };
    try {
      const r = await fetch('/api/layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: 'sasooness', program: 'panels', order: payload }),
      });
      if (!r.ok) throw new Error('save failed');
      state.panelLayout = payload;
      state.editingPanels = false;
      state.dragPanelLayout = null;
      render();
    } catch (err) {
      alert('Could not save the panel layout — try again.');
    }
  });

  document.addEventListener('click', (e) => {
    const hideBtn = e.target.closest('[data-hide-panel]');
    if (!hideBtn || !state.dragPanelLayout) return;
    const id = hideBtn.dataset.hidePanel;
    state.dragPanelLayout.hidden[id] = !state.dragPanelLayout.hidden[id];
    render();
  });

  let dragSrcPanel = null;
  document.addEventListener('dragstart', (e) => {
    const bar = e.target.closest('.panel-edit-bar[data-drag-panel]');
    if (!bar) return;
    dragSrcPanel = bar.dataset.dragPanel;
    e.dataTransfer.effectAllowed = 'move';
    bar.closest('.panel,.chart-row').classList.add('is-dragging');
  });
  document.addEventListener('dragend', (e) => {
    const bar = e.target.closest('.panel-edit-bar[data-drag-panel]');
    if (bar) bar.closest('.panel,.chart-row').classList.remove('is-dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (!dragSrcPanel || !e.target.closest('.panel-edit-bar[data-drag-panel]')) return;
    e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const bar = e.target.closest('.panel-edit-bar[data-drag-panel]');
    if (!bar || !dragSrcPanel || !state.dragPanelLayout) return;
    e.preventDefault();
    const targetId = bar.dataset.dragPanel;
    if (targetId !== dragSrcPanel) {
      // Seed the working order from current visual order first, so dragging always starts from
      // what's on screen rather than a stale/empty saved order.
      const visible = PANEL_BLOCKS.map((b) => ({ id: b.id, el: $(b.el) })).filter((x) => x.el)
        .sort((a, c) => (a.el.compareDocumentPosition(c.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        .map((x) => x.id);
      const order = state.dragPanelLayout.order && state.dragPanelLayout.order.length ? state.dragPanelLayout.order.slice() : visible;
      const from = order.indexOf(dragSrcPanel);
      const to = order.indexOf(targetId);
      if (from !== -1 && to !== -1) {
        order.splice(from, 1);
        order.splice(to, 0, dragSrcPanel);
        state.dragPanelLayout.order = order;
      }
    }
    dragSrcPanel = null;
    render();
  });

  // Opens on the new AZ budget's start (9/21) through yesterday (Pacific), not all time.
  buildQuickRangeOptions(2026, 1);
  setRange('custom', '2026-09-21', toISO(addDays(pacificToday(), -1)));
  fetchData();
  setInterval(fetchData, 30000);
  fetchMe().then(render);
  Promise.all([fetchLayout('agency'), fetchLayout('ppl'), fetchPanelLayout()]).then(render);
})();

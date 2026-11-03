(function () {
  const $ = (sel) => document.querySelector(sel);
  const pct = (n) => (isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '0') + '%';

  // Which client this is comes from the URL path (/sasooness/, /km/, /bryan/) — the server
  // already scoped the login to exactly one of these, so this only ever reads the one it's for.
  const scope = location.pathname.split('/')[1];
  const TITLES = { sasooness: 'Sasooness', km: 'KM Law Firm PLLC', bryan: 'Bryan Rodriguez' };

  // An admin previewing this page (the server tracks this per-scope in a "pv" cookie, since the
  // ?view=client on the original link never reaches this script's own request) shouldn't see or
  // click their own "Log out" — this isn't their session to log out of, it's a preview.
  const previewing = new RegExp('(?:^|;\\s*)pv=' + scope + '(?:;|$)').test(document.cookie);
  if (previewing) {
    document.getElementById('preview-banner').hidden = false;
    document.getElementById('logout-link').hidden = true;
  }

  const state = { leads: [], financials: null, search: '', range: { key: 'all', start: null, end: null }, program: null, view: 'leads' };
  const PROGRAMS = [
    { key: 'agency', label: 'Agency' },
    { key: 'ppl', label: 'Pay Per Lead' },
  ];

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function statusClass(status) {
    if (status === 'Signed') return 'status-pill--signed';
    if (status === 'Rejected') return 'status-pill--rejected';
    return 'status-pill--other';
  }

  // ---- date range (same math as the other client dashboards) ----
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
        // Sasooness's period keys: y-2026 (year), q-2026-4 (quarter), w-2026-10-26_2026-10-31 (a 2026-tab week).
        const yr = /^y-(\d{4})$/.exec(key);
        if (yr) return { start: yr[1] + '-01-01', end: yr[1] + '-12-31' };
        const qt = /^q-(\d{4})-([1-4])$/.exec(key);
        if (qt) { const y = Number(qt[1]), q = Number(qt[2]); return { start: toISO(startOfMonth(y, q * 3 - 2)), end: toISO(endOfMonth(y, q * 3)) }; }
        const wk = /^w-(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(key);
        if (wk) return { start: wk[1], end: wk[2] };
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

  // Sasooness only: All time, then Year / Quarter / Month / Week groups, newest first. Weeks are
  // the 2026 tab's own week rows (so a week's tiles match the sheet exactly), up to today.
  // Rebuilt whenever new data arrives, keeping whatever is selected.
  function buildSasoonessOptions() {
    const sel = $('#quick-range');
    const keep = state.range.key;
    const today = pacificToday();
    const todayISO = toISO(today);
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const short = (iso) => names[Number(iso.slice(5, 7)) - 1].slice(0, 3) + ' ' + Number(iso.slice(8, 10));
    const mkOpt = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; };
    const group = (label, opts) => { if (!opts.length) return; const g = document.createElement('optgroup'); g.label = label; opts.forEach((o) => g.appendChild(o)); sel.appendChild(g); };
    const y0 = 2026, yNow = today.getFullYear(), mNow = today.getMonth() + 1;
    sel.innerHTML = '';
    sel.appendChild(mkOpt('all', 'All time'));
    const years = [], quarters = [], months = [];
    for (let y = yNow; y >= y0; y--) {
      years.push(mkOpt('y-' + y, String(y)));
      for (let q = (y === yNow ? Math.ceil(mNow / 3) : 4); q >= 1; q--) quarters.push(mkOpt('q-' + y + '-' + q, 'Q' + q + ' ' + y));
      for (let m = (y === yNow ? mNow : 12); m >= 1; m--) months.push(mkOpt(y + '-' + pad(m), names[m - 1] + ' ' + y));
    }
    const seen = new Set();
    const weeks = (state.weeks || [])
      .filter((w) => w.start <= todayISO && !seen.has(w.start) && seen.add(w.start))
      .sort((a, b) => b.start.localeCompare(a.start))
      .map((w) => mkOpt('w-' + w.start + '_' + w.end, short(w.start) + ' – ' + (w.start.slice(5, 7) === w.end.slice(5, 7) ? Number(w.end.slice(8, 10)) : short(w.end)) + ', ' + w.start.slice(0, 4)));
    group('Year', years);
    group('Quarter', quarters);
    group('Month', months);
    group('Week', weeks);
    sel.value = sel.querySelector('option[value="' + keep + '"]') ? keep : 'all';
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
    render();
  }

  async function fetchData() {
    try {
      // Carries ?view=client through so an admin previewing this page (via that flag) still gets
      // the limited payload from the API too, not just the page shell.
      const r = await fetch('/' + scope + '-api/data' + location.search, { cache: 'no-store' });
      if (!r.ok) throw new Error('bad status');
      const d = await r.json();
      state.leads = d.leads || [];
      state.financials = d.financials || null;
      state.weeks = d.weeks || null;
      if (scope === 'sasooness') buildSasoonessOptions();
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

  // Sasooness is the only client whose leads carry a `program` (Agency/PPL) at all — the tabs
  // only appear when there's something to switch between.
  function renderSegmentTabs() {
    const hasPrograms = state.leads.some((l) => l.program);
    $('#segment-tabs').hidden = !hasPrograms;
    if (!hasPrograms) return;
    const counts = new Map();
    for (const l of state.leads) if (l.program) counts.set(l.program, (counts.get(l.program) || 0) + 1);
    const tabs = [{ key: null, label: 'All', n: state.leads.length }, ...PROGRAMS.map((p) => ({ ...p, n: counts.get(p.key) || 0 }))];
    $('#segment-tabs').innerHTML = tabs.map((t) =>
      '<button class="segment-tab' + (state.program === t.key ? ' is-active' : '') + '" data-program="' + (t.key || '') + '">' + escapeHtml(t.label) + '<span class="n">' + t.n + '</span></button>'
    ).join('');
  }

  // Sasooness only: the contract's own ad spend + marketing fee for the Agency program, the
  // same day-by-day math the admin Agency view uses, rebuilt here from the per-day figures the
  // server already computed (no campaign/vendor names, just totals).
  const toISODay = toISO;
  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function feeForRange(schedule) {
    if (!schedule || !schedule.length) return 0;
    const first = schedule[0].month;
    const lastEntry = schedule[schedule.length - 1];
    const { start, end } = state.range;
    const noFilter = !start && !end;
    const from = start || first + '-01';
    const to = end || (noFilter ? toISODay(endOfMonth(Number(lastEntry.month.slice(0, 4)), Number(lastEntry.month.slice(5, 7)))) : toISODay(pacificToday()));
    let fee = 0;
    for (let d = new Date(from + 'T00:00:00'), stop = new Date(to + 'T00:00:00'); d <= stop; d.setDate(d.getDate() + 1)) {
      const key = d.getFullYear() + '-' + pad(d.getMonth() + 1);
      if (key < first) continue;
      let row = null;
      for (const r of schedule) { if (r.month > key || (r.month === key && r.day > d.getDate())) break; row = r; }
      if (!row) continue;
      const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      fee += row.fee / days;
    }
    return fee;
  }
  function agencySpendForRange() {
    if (!state.financials) return 0;
    return state.financials.dailySpend.filter((r) => inRange(r.date)).reduce((a, r) => a + r.spend, 0);
  }

  function render() {
    $('#client-title').textContent = TITLES[scope] || 'Your Dashboard';
    $('#range-label').textContent = rangeLabel();
    renderSegmentTabs();

    const inDateRange = state.leads.filter((l) => inRange(l.date) && (!state.program || l.program === state.program));
    $('#lead-count').textContent = inDateRange.length.toLocaleString('en-US');

    let tiles;
    if (state.weeks) {
      // Sasooness: every tile comes from the 2026 tab's weekly rows (the lead list below still
      // comes from Lead Tracker). A week counts when any of its days fall in the picked range.
      const { start, end } = state.range;
      const weeks = state.weeks.filter((w) => (!state.program || w.program === state.program) &&
        (!start || w.end >= start) && (!end || w.start <= end));
      const sum = (k) => weeks.reduce((a, w) => a + w[k], 0);
      const contacts = sum('contacts'), signedW = sum('signed'), spend = sum('spend'), referrals = sum('referrals');
      $('#lead-count').textContent = contacts.toLocaleString('en-US');
      tiles = [
        ['Total Leads', contacts.toLocaleString('en-US'), ''],
        ['Signed', signedW.toLocaleString('en-US'), 'of ' + contacts.toLocaleString('en-US') + ' leads'],
        ['Conversion Rate', pct(contacts ? (signedW / contacts) * 100 : 0), 'signed ÷ leads'],
        ['Ad Spend', money(spend), ''],
        ['Cost Per Case', signedW > 0 ? money(spend / signedW) : '—', signedW > 0 ? 'ad spend ÷ signed cases' : 'no signed cases yet'],
      ];
      if (referrals > 0) tiles.push(['Signed Referrals', referrals.toLocaleString('en-US'), '']);
    } else {
    const total = inDateRange.length;
    const signed = inDateRange.filter((l) => l.status === 'Signed').length;
    const conversionRate = total ? Math.round((signed / total) * 1000) / 10 : 0;
    tiles = [
      ['Total Leads', total.toLocaleString('en-US'), ''],
      ['Signed', signed.toLocaleString('en-US'), 'of ' + total.toLocaleString('en-US') + ' leads'],
      ['Conversion Rate', pct(conversionRate), 'signed ÷ leads'],
    ];
    }
    // Ad spend + marketing fee only mean something for the Agency program (the contract's own
    // terms), so these only show up on that tab, same as the admin view.
    if (!state.weeks && state.financials && state.program === 'agency') {
      const adSpend = agencySpendForRange();
      const fee = feeForRange(state.financials.schedule);
      const totalCost = adSpend + fee;
      tiles.push(['Total Cost', money(totalCost), 'ad spend + marketing fee']);
      tiles.push(['Cost Per Case', signed > 0 ? money(totalCost / signed) : '—', signed > 0 ? 'total cost ÷ signed cases' : 'no signed cases yet']);
    }
    $('#kpi-row').innerHTML = tiles.map(([label, value, sub]) =>
      '<div class="kpi"><div class="kpi-label">' + escapeHtml(label) + '</div>' +
      '<div class="kpi-value num">' + value + '</div>' +
      (sub ? '<div class="kpi-sub">' + escapeHtml(sub) + '</div>' : '') + '</div>'
    ).join('');

    // Rejected Summary view toggle — only shown when there's a reason to show (Sasooness has
    // per-lead rejection reasons; the other clients don't, so the tab stays hidden for them).
    const hasReasons = state.leads.some((l) => l.reason);
    $('#view-tabs').hidden = !hasReasons;
    $('#leads-panel').hidden = hasReasons && state.view === 'rejected';
    $('#rejected-panel').hidden = !hasReasons || state.view !== 'rejected';
    if (hasReasons && state.view === 'rejected') {
      const rejected = inDateRange.filter((l) => l.reason);
      const counts = new Map();
      for (const l of rejected) counts.set(l.reason, (counts.get(l.reason) || 0) + 1);
      const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      $('#rejected-sub').textContent = rejected.length ? rejected.length.toLocaleString('en-US') + ' rejected leads' : '';
      $('#rejected-empty').hidden = rows.length > 0;
      $('#rejected-body').innerHTML = rows.map(([reason, n]) =>
        '<tr><td class="name-cell">' + escapeHtml(reason) + '</td>' +
        '<td class="td-num num">' + n.toLocaleString('en-US') + '</td>' +
        '<td class="td-num num">' + pct((n / rejected.length) * 100) + '</td></tr>'
      ).join('');
      return;
    }

    const q = state.search.trim().toLowerCase();
    const rows = inDateRange
      .filter((l) => !q || (l.name || '').toLowerCase().includes(q))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    $('#leads-empty').hidden = rows.length > 0;
    $('#leads-body').innerHTML = rows.map((l) => (
      '<tr><td class="name-cell">' + escapeHtml(l.name || '(no name)') + '</td>' +
      '<td>' + escapeHtml(l.date || '—') + '</td>' +
      '<td><span class="status-pill ' + statusClass(l.status) + '">' + escapeHtml(l.status || '—') + '</span></td></tr>'
    )).join('');
  }

  $('#view-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.view-tab');
    if (!btn) return;
    state.view = btn.dataset.view;
    $('#view-tabs').querySelectorAll('.view-tab').forEach((b) => b.classList.toggle('is-active', b === btn));
    render();
  });
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('#segment-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.segment-tab');
    if (!btn) return;
    state.program = btn.dataset.program || null;
    render();
  });

  // ---- date-range controls ----
  $('#quick-range').addEventListener('change', (e) => {
    const key = e.target.value;
    if (key === 'custom') { $('#range-start').focus(); return; }
    const { start, end } = computeRange(key);
    setRange(key, start, end);
  });
  function applyCustomRange() {
    const start = $('#range-start').value || null, end = $('#range-end').value || null;
    if (!start && !end) return;
    setRange('custom', start, end);
  }
  $('#range-start').addEventListener('change', applyCustomRange);
  $('#range-end').addEventListener('change', applyCustomRange);
  $('#range-clear').addEventListener('click', () => { const { start, end } = computeRange(defaultRangeKey); setRange(defaultRangeKey, start, end); });

  // Bryan's own history only starts August 2026; Sasooness and KM go back to January 2026.
  // Sasooness opens on all time (no date filter); the others open on this month.
  const thisMonthKey = buildQuickRangeOptions(2026, scope === 'bryan' ? 8 : 1);
  // Sasooness picks only from fixed periods, so the free date boxes are hidden there.
  if (scope === 'sasooness') { buildSasoonessOptions(); $('.date-inputs').style.display = 'none'; }
  const defaultRangeKey = scope === 'sasooness' ? 'all' : thisMonthKey;
  { const { start, end } = computeRange(defaultRangeKey); setRange(defaultRangeKey, start, end); }

  fetchData();
  setInterval(fetchData, 30000);
})();

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
  const money2 = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (n) => (n * 100).toFixed(1) + '%';
  const int = (n) => Math.round(n).toLocaleString('en-US');
  const shortDate = (iso) => (iso ? Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10)) : '');
  const longDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const ptTime = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT' : '');
  const cls = (c) => (c ? 'c-' + c : '');
  // The one style for anything missing or not applicable: grey "No data", reason on hover.
  const nd = (why) => '<span class="c-grey ov-nd" title="' + esc(why || 'No data') + '">No data</span>';

  let data = null;
  let period = 'mtd';
  const details = []; // click-through specs, indexed by data-d

  function clickable(text, spec, extraCls) {
    details.push(spec);
    return '<span class="ov-click ' + (extraCls || '') + '" data-d="' + (details.length - 1) + '" title="Click for detail">' + text + '</span>';
  }
  const P = () => data.periods[period];
  const rangeText = (p) => (p.start === p.end ? longDate(p.start) : longDate(p.start) + ' – ' + longDate(p.end)) + ', ' + p.end.slice(0, 4);
  const rowsSpec = (title, filt) => ({ kind: 'rows', title: title + ' · ' + rangeText(P()), start: P().start, end: P().end, ...filt });
  const fullName = (c) => c.name + (c.line ? ' · ' + c.line : '');
  const WORD = { green: 'On Track', orange: 'At Risk', red: 'Off Track', grey: 'No data' };
  let statusFilter = null; // table filter set from the Client status tile
  let multiState = new Set(); // buyers (by name) with rows in more than one state
  // "View details >" link under a tile; opens the same detail as clicking its number.
  const viewLink = (spec) => '<div class="ov-view">' + clickable('View details &rsaquo;', spec) + '</div>';

  // ---------------------------------------------------------------- tiles
  // Layout: the Profit card spans the full first row (4 metric tiles on one line, state chips in an
  // aligned grid below); Margin, Client status, Data freshness and the agency balance share row 2.
  function renderTiles() {
    const p = P();
    const split = [
      ['Walker PPL', p.walkerPpl, { group: 'walkerPpl' }], ['Walker Agency fee', p.walkerAgency, { group: 'walkerAgency' }],
      ['Non-Walker clients', p.other, { group: 'other' }], ['Total', p.total, {}],
    ].map(([k, t, f]) => '<div class="ov-metric' + (k === 'Total' ? ' is-total' : '') + '"><div class="ov-k">' + k + '</div><div class="ov-v ' + (t.profit < 0 ? 'c-red' : '') + '">' +
      clickable(money(t.profit), rowsSpec(k + ' profit', f)) + '</div></div>').join('');
    const chips = p.byState.map((s) => '<div class="ov-chip"><span class="ov-chip-k">' + esc(shortState(s)) + '</span>' +
      clickable('<b class="' + (s.profit < 0 ? 'c-red' : '') + '">' + money(s.profit) + '</b>', rowsSpec(s.label + ' profit', { states: [s.state] })) + '</div>').join('');
    const profitTile = '<div class="ov-tile ov-profit"><div class="ov-tile-head"><div class="ov-tile-label">Profit · ' + esc(p.label) + '</div>' + viewLink(rowsSpec('Profit · all clients', {})) + '</div>' +
      '<div class="ov-split">' + split + '</div><div class="ov-states">' + chips + '</div>' +
      '<div class="ov-sub">By state: the table’s state subtotals, which add up to the total.</div></div>';

    const t = p.total;
    const marginTile = '<div class="ov-tile"><div class="ov-tile-label">Margin · ' + esc(p.label) + '</div><div class="ov-big ' + (t.profit < 0 ? 'c-red' : '') + '">' +
      (t.margin == null ? nd('No revenue in this range') : clickable(pct(t.margin), rowsSpec('Margin', {}))) +
      '</div><div class="ov-sub">' + money(t.profit) + ' profit ÷ ' + money(t.revenue) + ' revenue</div>' + viewLink(rowsSpec('Margin · all clients', {})) + '</div>';

    const sc = p.statusCounts;
    const statusTile = '<div class="ov-tile"><div class="ov-tile-label">Client status</div><div class="ov-counts">' +
      ['red', 'orange', 'green', 'grey'].map((c) => clickable('<b>' + sc[c] + '</b> ' + WORD[c], { kind: 'filter', colour: c }, 'ov-pill b-' + c)).join('') +
      '</div><div class="ov-sub">Off Track = losing money. No data = replacement, cost per case or target missing.</div>' +
      viewLink({ kind: 'filter', colour: ['red', 'orange', 'green', 'grey'].find((c) => sc[c]) || 'grey' }) + '</div>';

    const f = data.freshness;
    const freshWord = f.colour === 'green' ? 'Fresh' : f.colour === 'orange' ? 'Not restated' : 'Stale';
    const staleList = (f.stale || []).length
      ? '<ul class="ov-stale">' + f.stale.map((s) => '<li>' + esc(s.source) + ' <span class="c-red">' + esc(/^through/.test(s.age) ? s.age : s.age + ' old') + '</span></li>').join('') + '</ul>'
      : (f.reason ? '<div class="ov-sub">' + esc(f.reason) + '</div>' : '');
    const freshTile = '<div class="ov-tile"><div class="ov-tile-label">Data freshness</div><div class="ov-big c-' + f.colour + '">' +
      clickable(freshWord, { kind: 'fresh', title: 'Data freshness' }) + '</div>' + staleList +
      '<div class="ov-sub">Last load ' + (f.latest ? ptTime(f.latest) : 'unknown') + '</div>' + viewLink({ kind: 'fresh', title: 'Data freshness' }) + '</div>';

    const a = data.agency || { connected: false };
    const agencyTile = '<div class="ov-tile"><div class="ov-tile-label">Walker Agency media balance</div>' +
      (!a.connected ? '<div class="ov-big c-grey">Tracker not connected yet</div>'
        : a.value == null ? '<div class="ov-big">' + nd(a.error) + '</div>'
          : '<div class="ov-big">' + money(a.value) + '</div><div class="ov-sub">left before the next Walker invoice</div>') + viewLink({ kind: 'agency' }) + '</div>';

    $('#tiles').innerHTML = profitTile + '<div class="ov-row2">' + marginTile + statusTile + freshTile + agencyTile + '</div>';
  }
  // Chip label: state code names, with Walker's NW / Multi spelled out as on the sheet's key.
  const shortState = (s) => (s.state === 'NW' ? 'Nationwide' : s.state === 'Multi' ? 'Multi-state' : s.label);

  // ---------------------------------------------------------------- client table
  const td = (inner, c, title) => '<td class="num ' + (c || '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + inner + '</td>';
  // Compact grey dash for a missing half of a pair ("$90 / —"), reason on hover.
  const dash = (why) => '<span class="c-grey" title="' + esc(why || 'No data') + '">—</span>';
  function clientCells(c) {
    const spec = (what) => rowsSpec(fullName(c) + ' · ' + what, { clients: [c.key] });
    const tag = multiState.has(c.name) ? '<span class="ov-tag" title="This buyer has rows in more than one state">multi-state</span>' : '';
    const nameLink = c.href ? '<a href="' + c.href + '" title="Open ' + esc(c.name) + '’s dashboard">' + esc(c.name) + '</a>' : esc(c.name);
    const name = '<td class="ov-client" title="' + esc(fullName(c)) + '"><div class="ov-name">' + nameLink + '</div><div class="ov-line">' + (c.line ? '<span class="ov-vs">' + esc(c.line) + '</span>' : '') + tag + '</div></td>';
    // Status: dot + word on line 1; the reason on one truncated line, full text on hover.
    const status = '<td class="ov-status" title="' + esc(c.statusNote || WORD[c.status]) + '"><div><span class="ov-dot ' + c.status + '"></span>' + WORD[c.status] + '</div>' +
      '<div class="ov-note">' + esc(c.statusNote || '') + '</div></td>';
    const profit = td(clickable(money(c.profit), spec('Profit')), cls(c.profitColour === 'grey' ? '' : c.profitColour));
    const margin = c.margin == null ? td(nd(c.revenue ? '' : 'No revenue in this range')) : td(clickable(pct(c.margin), spec('Margin')), cls(c.profitColour));
    const ppl = c.profitPerLead == null ? td(nd(c.pplApplies === false ? 'Not applicable to this deal' : 'No leads in range'))
      : td(clickable(money(c.profitPerLead), spec('Profit per lead')), c.profitPerLead < 0 ? 'c-red' : '');
    // Cost / lead vs price: "$249 / $307", or "$90 / —" when there's no per-lead price.
    const cpl = c.costPerLead == null ? td(nd(c.cplApplies === false ? 'Not applicable to this deal' : 'No leads in range'))
      : td(clickable(money(c.costPerLead), spec('Cost per lead')) + ' <span class="ov-slash">/</span> ' +
        (c.pricePerLead == null ? dash('No per-lead price for this deal') : clickable(money(c.pricePerLead), spec('Price per lead'))), cls(c.cplColour), 'Cost per lead / price per lead');
    // Cost per case, 2 lines: "Cost per QMVA: $1,327 / —" (cost / our price), then muted "Target: —".
    // Coloured only against the target (grey without one).
    const caseV = c.costPerCase == null ? dash(c.caseApplies === false ? 'Not applicable to this deal' : c.caseNote) : clickable(money(c.costPerCase), spec(c.caseLabel));
    const priceV = c.pricePerCase == null ? dash('No price_per_case on Settings for this client/state') : money(c.pricePerCase);
    const tgtV = c.target == null ? dash(c.targetApplies === false ? 'Not applicable to this deal' : c.targetNote) : money(c.target);
    const caseCell = td('<div><span class="ov-vs">' + esc(c.caseLabel) + ':</span> ' + caseV + ' <span class="ov-slash">/</span> ' + priceV + '</div><div class="ov-vs">Target: ' + tgtV + '</div>',
      'ov-case ' + (c.costPerCase != null && c.target != null ? cls(c.caseColour) : ''), c.caseLabel + ' / our price per case · target');
    const repl = c.replacement == null ? td(nd(c.replApplies === false ? 'Not applicable to this deal' : c.replNote))
      : td(clickable(pct(c.replacement), spec('Replacement')), cls(c.replColour), c.replSource || '');
    const leads = c.leads ? td(clickable(int(c.leads.sent) + ' / ' + int(c.leads.accepted), spec('Leads'))) : td(nd('Leads for this client are not loaded into raw_current'));
    let pack;
    if (!c.isPack) pack = td(nd('Not a lead pack'));
    else if (!c.pack) pack = td(nd('No rows on from_mark_ppl yet'));
    else if (c.pack.delivered == null || c.pack.packSize == null) pack = td(nd('Tracker row has no leads delivered / pack size'));
    else {
      // "46/50", plus "Pack about to run out" when the tracker flags it, with its own flag text.
      const runningOut = /run(ning)?\s*out|almost|low|reorder|renew/i.test(c.pack.flag || '');
      pack = td(int(c.pack.delivered) + '/' + int(c.pack.packSize) +
        (runningOut ? '<div><span class="ov-flag">Pack about to run out</span></div>' : '') + (c.pack.flag ? '<div class="ov-vs">' + esc(c.pack.flag) + '</div>' : ''));
    }
    const chev = '<td class="ov-chev">' + (c.href ? '<a href="' + c.href + '" aria-label="Open ' + esc(c.name) + '">&rsaquo;</a>' : '') + '</td>';
    return name + status + profit + margin + ppl + cpl + caseCell + repl + leads + pack + chev;
  }
  function renderTable() {
    let html = '';
    const groupsAll = P().groups;
    const names = new Map();
    for (const g of groupsAll) for (const c of g.clients) { if (!names.has(c.name)) names.set(c.name, new Set()); names.get(c.name).add(g.state); }
    multiState = new Set([...names].filter(([, st]) => st.size > 1).map(([n]) => n));
    if (statusFilter) {
      const n = groupsAll.reduce((a, g) => a + g.clients.filter((c) => c.status === statusFilter).length, 0);
      html += '<tr class="ov-filter-row"><td colspan="11"><span class="ov-sticky">Showing ' + n + ' ' + WORD[statusFilter] + ' client' + (n === 1 ? '' : 's') + ' · <span class="ov-click" data-clear-filter="1">Show all</span></span></td></tr>';
    }
    for (const g of groupsAll) {
      const shown = statusFilter ? g.clients.filter((c) => c.status === statusFilter) : g.clients;
      if (!shown.length) continue;
      // Every state's header bar carries its subtotal, in the same columns as the rows: summed
      // profit and leads, margin recomputed from the summed dollars (never an average of %s).
      const s = g.subtotal;
      const keys = g.clients.map((c) => c.key);
      const spec = (what) => rowsSpec(g.label + ' · ' + what, { clients: keys });
      html += '<tr class="ov-state-row"><td class="ov-client" colspan="2"><span class="ov-sticky">' + esc(g.label) +
        (s.incomplete ? ' <span class="c-grey" title="A client in this state has leads with no price">(incomplete)</span>' : '') + '</span></td>' +
        td(clickable(money(s.profit), spec('Profit')), s.profit < 0 ? 'c-red' : '', 'State subtotal') +
        (s.margin == null ? td(dash('No revenue in this state')) : td(clickable(pct(s.margin), spec('Margin')), '', 'Margin from the summed dollars')) +
        '<td></td><td></td><td></td><td></td>' +
        (s.leads ? td(clickable(int(s.leads.sent) + ' / ' + int(s.leads.accepted), spec('Leads')), '', 'Summed leads') : td(dash('No leads loaded'))) + '<td></td><td></td></tr>';
      for (const c of shown) html += '<tr class="ov-row">' + clientCells(c) + '</tr>';
    }
    const t = P().total;
    if (!statusFilter) {
      const sent = groupsAll.reduce((a, g) => a + (g.subtotal.leads ? g.subtotal.leads.sent : 0), 0);
      const acc = groupsAll.reduce((a, g) => a + (g.subtotal.leads ? g.subtotal.leads.accepted : 0), 0);
      html += '<tr class="ov-total"><td class="ov-client" colspan="2"><span class="ov-sticky">All clients</span></td>' + td(clickable(money(t.profit), rowsSpec('All clients · Profit', {})), t.profit < 0 ? 'c-red' : '') +
        (t.margin == null ? td(dash()) : td(clickable(pct(t.margin), rowsSpec('All clients · Margin', {})))) + '<td></td><td></td><td></td><td></td>' +
        td(clickable(int(sent) + ' / ' + int(acc), rowsSpec('All clients · Leads', {}))) + '<td></td><td></td></tr>';
    }
    $('#client-body').innerHTML = html;
  }

  // ---------------------------------------------------------------- notices (data problems only)
  function renderNotices() {
    let html = '';
    if (data.error) html += '<div class="ov-notice is-error">Can’t reach the Client Profitability sheet right now — showing the last good read' + (data.lastGoodAt ? ' from ' + ptTime(data.lastGoodAt) : '') + '.</div>';
    if (data.checks && data.checks.length) {
      html += '<details class="ov-notice is-error"><summary>Summary and raw_current disagree on ' + data.checks.length + ' number' + (data.checks.length > 1 ? 's' : '') + ' (' + shortDate(data.summaryWindow.start) + '–' + shortDate(data.summaryWindow.end) + ')</summary><ul>' +
        data.checks.map((c) => '<li>' + esc(c.client) + ' — ' + esc(c.metric) + ': Summary ' + money2(c.summary) + ' vs raw_current ' + money2(c.raw) + ' (' + money2(c.diff) + ')</li>').join('') + '</ul></details>';
    }
    $('#notices').innerHTML = html;
  }

  // ---------------------------------------------------------------- drawer
  function openDrawer(title, sub, body) {
    $('#drawer-title').textContent = title;
    $('#drawer-sub').textContent = sub || '';
    $('#drawer-body').innerHTML = body;
    $('#drawer').classList.add('is-open'); $('#scrim').classList.add('is-open');
    $('#drawer').setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    $('#drawer').classList.remove('is-open'); $('#scrim').classList.remove('is-open');
    $('#drawer').setAttribute('aria-hidden', 'true');
  }
  // Rows grouped client → day → source (Pacific dates, as raw_current stores them).
  function rowsDetail(spec) {
    const rows = data.detail.filter((r) => r.date >= spec.start && r.date <= spec.end &&
      (!spec.group || r.group === spec.group) && (!spec.clients || spec.clients.includes(r.client)) && (!spec.states || spec.states.includes(r.state)));
    if (!rows.length) return '<p class="empty-msg">No raw_current rows for this selection.</p>';
    const byClient = new Map();
    for (const r of rows) { if (!byClient.has(r.name)) byClient.set(r.name, []); byClient.get(r.name).push(r); }
    const tot = (rs) => rs.reduce((a, r) => ({ sent: a.sent + r.sent, acc: a.acc + r.accepted, ret: r.returned == null ? a.ret : (a.ret || 0) + r.returned, cost: a.cost + r.cost, rev: a.rev + r.revenue, profit: a.profit + r.profit }), { sent: 0, acc: 0, ret: null, cost: 0, rev: 0, profit: 0 });
    const line = (c, label, t, extra) => '<tr class="' + c + '"><td>' + label + '</td><td class="num">' + int(t.sent) + ' / ' + int(t.acc) + '</td><td class="num">' + (t.ret == null ? nd('Returns not reported') : int(t.ret)) + '</td><td class="num">' + money2(t.cost) + '</td><td class="num">' + money2(t.rev) + '</td><td class="num ' + (t.profit < 0 ? 'c-red' : '') + '">' + money2(t.profit) + '</td><td>' + (extra || '') + '</td></tr>';
    let html = '<table><thead><tr><th>Client / day / source</th><th class="num">Sent / acc.</th><th class="num">Returned</th><th class="num">Cost</th><th class="num">Revenue</th><th class="num">Profit</th><th>Loaded (PT)</th></tr></thead><tbody>';
    html += line('ov-subtotal', 'Total', tot(rows), '');
    for (const [name, rs] of [...byClient.entries()].sort()) {
      html += line('ov-d-client', esc(name), tot(rs), '<span class="ov-vs">' + esc(rs[0].rule) + '</span>');
      const byDay = new Map();
      for (const r of rs) { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); }
      for (const [day, ds] of [...byDay.entries()].sort().reverse()) {
        html += line('ov-d-day', shortDate(day) + ' (' + new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) + ')', tot(ds), '');
        for (const r of ds) html += line('ov-d-src', esc(r.source) + (r.platform ? ' · ' + esc(r.platform) : '') + (r.revenueMissing ? ' <span class="c-grey">(no price)</span>' : ''), { sent: r.sent, acc: r.accepted, ret: r.returned, cost: r.cost, rev: r.revenue, profit: r.profit }, '<span class="ov-vs">' + esc(r.loadedAt ? ptTime(r.loadedAt) : '') + '</span>');
      }
    }
    return html + '</tbody></table>';
  }
  function showDetail(spec) {
    if (spec.kind === 'rows') return openDrawer(spec.title, 'raw_current rows · client → day → source · Pacific dates', rowsDetail(spec));
    if (spec.kind === 'filter') {
      statusFilter = spec.colour; renderTable();
      document.querySelector('.ov-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (spec.kind === 'agency') {
      const a = data.agency || { connected: false };
      return openDrawer('Walker Agency media balance', 'Balance left before the next Walker invoice',
        !a.connected ? '<p class="empty-msg">The agency tracker sheet isn’t connected yet, so there’s no balance to show. Once it exists, its balance cell is read every 5 minutes.</p>'
          : a.value == null ? '<p class="empty-msg">Tracker connected, but its balance cell is empty or not a number' + (a.error ? ' (' + esc(a.error) + ')' : '') + '.</p>'
            : '<p>' + money(a.value) + ' left before the next Walker invoice.</p>');
    }
    if (spec.kind === 'status') {
      const list = P().groups.flatMap((g) => g.clients).filter((c) => c.status === spec.colour);
      return openDrawer(spec.title, 'Click a client to see its rows', list.length
        ? '<table><tbody>' + list.map((c) => '<tr><td><span class="ov-dot ' + c.status + '"></span>' + clickable(esc(fullName(c)), rowsSpec(fullName(c), { clients: [c.key] })) + '</td><td>' + esc(c.state) + '</td><td class="ov-vs">' + esc(c.statusNote) + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="empty-msg">None.</p>');
    }
    if (spec.kind === 'fresh') {
      const f = data.freshness;
      return openDrawer('Data freshness', 'Latest raw_current load per source · red over 24h · orange = not restated since the last 10:15 AM PT run (' + ptTime(f.lastRun) + ')',
        '<table><thead><tr><th>Source</th><th>Last loaded</th><th class="num">Age</th></tr></thead><tbody>' +
        (f.summaryThrough ? '<tr><td>Summary tab</td><td>Data through ' + longDate(f.summaryThrough) + '</td><td class="num"></td></tr>' : '') +
        f.sources.map((s) => '<tr><td>' + esc(s.source) + '</td><td>' + ptTime(s.loadedAt) + '</td><td class="num ' + (s.ageHours > 24 ? 'c-red' : '') + '">' + (s.ageHours >= 48 ? (s.ageHours / 24).toFixed(1) + ' days' : Math.round(s.ageHours) + 'h') + '</td></tr>').join('') + '</tbody></table>');
    }
  }

  // ---------------------------------------------------------------- load
  function render() {
    details.length = 0;
    const p = P();
    $('#range').textContent = rangeText(p) + ' · Pacific time';
    $('#sub').textContent = '· data through ' + longDate(data.range.end) + ' (' + (data.range.basis === 'Summary' ? 'Summary tab' : 'raw_current') + ')';
    document.querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('is-on', b.dataset.period === period));
    renderNotices(); renderTiles(); renderTable();
  }
  function load(force) {
    $('#live-text').textContent = force ? 'Re-reading the sheet…' : 'Loading…';
    fetch('/overview-api/' + (force ? 'refresh' : 'data'), { method: force ? 'POST' : 'GET', cache: 'no-store' })
      .then((r) => { if (r.status === 403) { location.href = '/'; throw new Error('forbidden'); } return r.json(); })
      .then((d) => {
        if (d.loading) { $('#live-text').textContent = 'Reading the sheet…'; setTimeout(load, 4000); return; }
        if (!d.periods) { $('#live-text').textContent = 'Sheet read failed'; $('#notices').innerHTML = '<div class="ov-notice is-error">' + esc(d.error || 'No data') + '</div>'; return; }
        data = d; render();
        // Never says "Live": just when the page last checked, and the dot follows data freshness.
        $('#live-text').textContent = 'Checked ' + new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }) + ' PT';
        $('#live-pill').className = 'live-pill ov-pill-' + d.freshness.colour;
      })
      .catch(() => {});
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (b && data) { period = b.dataset.period; render(); return; }
    if (e.target.closest('[data-clear-filter]')) { statusFilter = null; renderTable(); return; }
    const d = e.target.closest('[data-d]');
    if (d) showDetail(details[Number(d.dataset.d)]);
  });
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $('#refresh-btn').addEventListener('click', () => load(true));
  load();
  setInterval(load, 5 * 60 * 1000);
})();

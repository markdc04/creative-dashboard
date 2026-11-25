(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n == null || !isFinite(n) ? '—' : (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US'));
  const money2 = (n) => (n == null || !isFinite(n) ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const pct = (n) => (n == null || !isFinite(n) ? '—' : (n * 100).toFixed(1) + '%');
  const int = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
  const shortDate = (iso) => (iso ? Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10)) : '');
  const ptTime = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT' : '—');
  const cls = (c) => (c ? 'c-' + c : '');
  // A missing value is grey with the sheet's own reason on hover (e.g. "MISSING - Mark"), never 0.
  const missing = (text) => '<span class="c-grey" title="' + esc(text || 'No data') + '">' + (/missing/i.test(text || '') ? 'Missing' : /n\/a/i.test(text || '') ? 'n/a' : '—') + '</span>';

  let data = null;
  let period = 'mtd';
  const details = []; // click-through specs, indexed by data-d

  // A clickable number: registers what its detail view should list.
  function clickable(text, spec, extraCls) {
    details.push(spec);
    return '<span class="ov-click ' + (extraCls || '') + '" data-d="' + (details.length - 1) + '" title="Click for detail">' + text + '</span>';
  }

  // ---------------------------------------------------------------- tiles
  function renderTiles() {
    const p = data.profit[period];
    const rowsSpec = (title, group, states) => ({ kind: 'rows', title, start: p.start, end: p.end, group, states });
    const range = p.start === p.end ? shortDate(p.start) : shortDate(p.start) + '–' + shortDate(p.end);
    const split = [
      ['Walker PPL', p.walkerPpl, 'walkerPpl'], ['Walker Agency fee', p.walkerAgency, 'walkerAgency'],
      ['Non-Walker clients', p.other, 'other'], ['Total', p.total, null],
    ].map(([k, t, g]) => '<div><div class="ov-k">' + k + '</div><div class="ov-v ' + (t.profit < 0 ? 'c-red' : '') + '">' +
      clickable(money(t.profit), rowsSpec(k + ' profit · ' + p.label + ' (' + range + ')', g)) + '</div></div>').join('');
    const states = p.byState.map((s) => '<span>' + esc(s.label) + ' ' + clickable(money(s.profit), rowsSpec(s.label + ' profit · ' + p.label, null, [s.state])) + '</span>').join('');
    const stale = p.lastDataDate && p.lastDataDate < p.end ? ' · data only through ' + shortDate(p.lastDataDate) : '';
    const profitTile =
      '<div class="ov-tile ov-profit"><div class="ov-tile-label">Profit<div class="ov-periods">' +
      ['yesterday', 'wtd', 'mtd'].map((k) => '<button data-period="' + k + '" class="' + (k === period ? 'is-on' : '') + '">' + data.profit[k].label + '</button>').join('') +
      '</div></div><div class="ov-sub">' + range + stale + ' · Walker Agency fee = 35% of WAGENCY spend</div>' +
      '<div class="ov-split">' + split + '</div><div class="ov-states">' + states + '</div></div>';

    const m = data.margin;
    const marginTile = '<div class="ov-tile"><div class="ov-tile-label">Margin MTD</div><div class="ov-big ' + (m.profit < 0 ? 'c-red' : '') + '">' +
      clickable(pct(m.margin), { kind: 'rows', title: 'Margin MTD (' + shortDate(m.start) + '–' + shortDate(m.end) + ')', start: m.start, end: m.end }) +
      '</div><div class="ov-sub">' + money(m.profit) + ' profit ÷ ' + money(m.revenue) + ' revenue</div></div>';

    const sc = data.statusCounts;
    const statusTile = '<div class="ov-tile"><div class="ov-tile-label">Client status</div><div class="ov-counts">' +
      ['red', 'orange', 'green', 'grey'].map((c) => '<div class="b-' + c + '">' + clickable(String(sc[c]), { kind: 'status', colour: c, title: c[0].toUpperCase() + c.slice(1) + ' clients' }) + '<small>' + c + '</small></div>').join('') +
      '</div><div class="ov-sub">From Summary “STATUS (worst metric)”</div></div>';

    const f = data.freshness;
    const freshTile = '<div class="ov-tile"><div class="ov-tile-label">Data freshness</div><div class="ov-big c-' + f.colour + '">' +
      clickable(f.colour === 'green' ? 'Fresh' : f.colour === 'orange' ? 'Not restated' : 'Stale', { kind: 'fresh', title: 'Data freshness' }) +
      '</div><div class="ov-sub">' + (f.reason ? esc(f.reason) + ' · ' : '') + 'last update ' + ptTime(f.latest) + '</div></div>';

    const a = data.agency || { connected: false };
    const agencyTile = '<div class="ov-tile"><div class="ov-tile-label">Walker Agency media balance</div>' +
      (!a.connected ? '<div class="ov-big c-grey">Not connected</div><div class="ov-sub">Set OVERVIEW_AGENCY_TRACKER_ID and _RANGE once the agency tracker exists</div>'
        : a.value == null ? '<div class="ov-big c-grey">—</div><div class="ov-sub">' + esc(a.error || 'No value') + '</div>'
          : '<div class="ov-big">' + money(a.value) + '</div><div class="ov-sub">left before the next Walker invoice</div>') + '</div>';

    $('#tiles').innerHTML = profitTile + marginTile + statusTile + freshTile + agencyTile;
  }

  // ---------------------------------------------------------------- client table
  function metricCell(m, text, spec, forceGrey) {
    if (!m || m.value == null) return '<td class="num">' + missing(m && m.text) + '</td>';
    return '<td class="num ' + (forceGrey ? 'c-grey' : cls(m.colour)) + '">' + clickable(esc(text != null ? text : m.text), spec) + '</td>';
  }
  function renderTable() {
    const w = data.summaryWindow;
    const win = shortDate(w.start) + '–' + shortDate(w.end);
    $('#table-sub').textContent = 'Summary MTD ' + win + ' · colours from the sheet';
    const rowsFor = (c, title) => ({ kind: 'rows', title: c.client + ' · ' + title + ' (' + win + ')', start: w.start, end: w.end, clients: [c.key] });
    let html = '';
    for (const g of data.groups) {
      html += '<tr class="ov-state-row"><td colspan="10">' + esc(g.label) + '</td></tr>';
      for (const c of g.clients) {
        const name = c.href ? '<a href="' + c.href + '">' + esc(c.client) + '</a>' : esc(c.client);
        const ppl = c.pricePerLead && c.pricePerLead.value != null ? ' <span class="ov-vs">vs ' + esc(c.pricePerLead.text) + '</span>' : '';
        const tgt = c.target.costPerCase != null ? c.target.costPerCase : (c.targetCell && c.targetCell.value != null ? c.targetCell.value : null);
        const ourPrice = c.target.pricePerCase != null ? money(c.target.pricePerCase) : 'no price';
        const caseText = esc(c.costPerCase.text);
        const caseVs = ' <span class="ov-vs">vs ' + ourPrice + ' vs ' + (tgt != null ? money(tgt) : 'no target') + '</span>';
        const caseCell = c.costPerCase.value == null
          ? '<td class="num"><span class="ov-vs">' + esc(c.caseLabel) + '</span> ' + missing(c.costPerCase.text) + '</td>'
          : '<td class="num ' + (tgt == null ? 'c-grey' : cls(c.costPerCase.colour)) + '"><span class="ov-vs">' + esc(c.caseLabel) + '</span> ' + clickable(caseText, rowsFor(c, c.caseLabel)) + caseVs + '</td>';
        const leads = c.leads.hasRaw ? clickable(int(c.leads.sent) + ' / ' + int(c.leads.accepted), rowsFor(c, 'Leads')) : '<span class="c-grey">—</span>';
        let pack = '';
        if (c.isPack) {
          pack = c.pack
            ? esc([c.pack.pace, c.pack.remaining != null ? int(c.pack.remaining) + ' left of ' + int(c.pack.packSize) : '', c.pack.flag].filter(Boolean).join(' · ') || '—')
            : '<span class="c-grey">No tracker data</span>';
        }
        html += '<tr>' +
          '<td>' + name + '</td>' +
          '<td><span class="ov-dot ' + c.status + '"></span>' + esc(c.status === 'grey' ? 'No data' : c.status[0].toUpperCase() + c.status.slice(1)) + '</td>' +
          metricCell(c.profit, money(c.profit.value), rowsFor(c, 'Profit MTD')) +
          '<td class="num ' + (c.margin == null ? 'c-grey' : cls(c.profit.colour)) + '">' + (c.margin == null ? '—' : clickable(pct(c.margin), rowsFor(c, 'Margin MTD'))) + '</td>' +
          metricCell(c.profitPerLead, null, rowsFor(c, 'Profit per lead')) +
          (c.costPerLead.value == null ? '<td class="num">' + missing(c.costPerLead.text) + '</td>'
            : '<td class="num ' + cls(c.costPerLead.colour) + '">' + clickable(esc(c.costPerLead.text), rowsFor(c, 'Cost per lead')) + ppl + '</td>') +
          caseCell +
          metricCell(c.replacement, null, rowsFor(c, 'Replacement rate')) +
          '<td class="num">' + leads + '</td>' +
          '<td>' + pack + '</td></tr>';
      }
      const s = g.subtotal;
      const inc = s.incomplete ? ' class="num c-grey" title="Incomplete: a client in this state is missing data"' : ' class="num"';
      html += '<tr class="ov-subtotal"><td>' + esc(g.label) + ' subtotal' + (s.incomplete ? ' <span class="c-grey">(incomplete)</span>' : '') + '</td><td></td>' +
        '<td' + inc + '>' + clickable(money(s.profit), { kind: 'rows', title: g.label + ' · Profit MTD (' + win + ')', start: w.start, end: w.end, clients: g.clients.map((c) => c.key) }) + '</td>' +
        '<td' + inc + '>' + pct(s.margin) + '</td><td colspan="4"></td><td class="num">' + int(s.sent) + ' / ' + int(s.accepted) + '</td><td></td></tr>';
    }
    $('#client-body').innerHTML = html;
  }

  // ---------------------------------------------------------------- notices
  function renderNotices() {
    let html = '';
    if (data.error) html += '<div class="ov-notice is-error">Last sheet read failed: ' + esc(data.error) + ' — showing the last good read.</div>';
    if (data.checks && data.checks.length) {
      html += '<details class="ov-notice is-error"><summary>' + data.checks.length + ' mismatch' + (data.checks.length > 1 ? 'es' : '') + ' between Summary and raw_current</summary><ul>' +
        data.checks.map((c) => '<li>' + esc(c.client) + ' — ' + esc(c.metric) + ': Summary ' + money2(c.summary) + ' vs raw_current ' + money2(c.raw) + ' (' + money2(c.diff) + ')</li>').join('') + '</ul></details>';
    }
    if (data.warnings && data.warnings.length) {
      html += '<details class="ov-notice"><summary>' + data.warnings.length + ' sheet note' + (data.warnings.length > 1 ? 's' : '') + ' (unlabelled columns, etc.)</summary><ul>' +
        data.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul></details>';
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
      (!spec.group || r.group === spec.group) && (!spec.clients || spec.clients.includes(r.client)) && (!spec.states || spec.states.includes(r.state || '—')));
    if (!rows.length) return '<p class="empty-msg">No raw_current rows for this selection.</p>';
    const byClient = new Map();
    for (const r of rows) { if (!byClient.has(r.client)) byClient.set(r.client, []); byClient.get(r.client).push(r); }
    const tot = (rs) => rs.reduce((a, r) => ({ sent: a.sent + r.sent, acc: a.acc + r.accepted, cost: a.cost + r.cost, rev: a.rev + r.revenue, profit: a.profit + r.profit }), { sent: 0, acc: 0, cost: 0, rev: 0, profit: 0 });
    const line = (c, label, t, extra) => '<tr class="' + c + '"><td>' + label + '</td><td class="num">' + int(t.sent) + ' / ' + int(t.acc) + '</td><td class="num">' + money2(t.cost) + '</td><td class="num">' + money2(t.rev) + '</td><td class="num ' + (t.profit < 0 ? 'c-red' : '') + '">' + money2(t.profit) + '</td><td>' + (extra || '') + '</td></tr>';
    let html = '<table><thead><tr><th>Client / day / source</th><th class="num">Sent / acc.</th><th class="num">Cost</th><th class="num">Revenue</th><th class="num">Profit</th><th>Loaded</th></tr></thead><tbody>';
    const all = tot(rows);
    html += line('ov-subtotal', 'Total', all, '');
    for (const [client, rs] of [...byClient.entries()].sort()) {
      html += line('ov-d-client', esc(client), tot(rs), '<span class="ov-vs">' + esc(rs[0].rule) + '</span>');
      const byDay = new Map();
      for (const r of rs) { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); }
      for (const [day, ds] of [...byDay.entries()].sort().reverse()) {
        html += line('ov-d-day', shortDate(day) + ' (' + new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) + ')', tot(ds), '');
        for (const r of ds) html += line('ov-d-src', esc(r.source) + (r.platform ? ' · ' + esc(r.platform) : '') + (r.revenueMissing ? ' <span class="c-grey">(no price)</span>' : ''), { sent: r.sent, acc: r.accepted, cost: r.cost, rev: r.revenue, profit: r.profit }, '<span class="ov-vs">' + esc(r.loadedAt ? ptTime(r.loadedAt) : '') + '</span>');
      }
    }
    return html + '</tbody></table>';
  }
  function showDetail(spec) {
    if (spec.kind === 'rows') return openDrawer(spec.title, 'raw_current rows · client → day → source · Pacific dates', rowsDetail(spec));
    if (spec.kind === 'status') {
      const list = data.groups.flatMap((g) => g.clients).filter((c) => c.status === spec.colour);
      return openDrawer(spec.title, 'From Summary “STATUS (worst metric)” and its status note', list.length
        ? '<table><tbody>' + list.map((c) => '<tr><td><span class="ov-dot ' + c.status + '"></span>' + (c.href ? '<a href="' + c.href + '">' + esc(c.client) + '</a>' : esc(c.client)) + '</td><td>' + esc(c.state) + '</td><td class="ov-vs">' + esc(c.statusNote) + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="empty-msg">None.</p>');
    }
    if (spec.kind === 'fresh') {
      const f = data.freshness;
      return openDrawer('Data freshness', 'Latest raw_current loaded_at per source · red > 24h · orange = not restated since the last 10:15 AM PT run (' + ptTime(f.lastRun) + ')',
        '<table><thead><tr><th>Source</th><th>Last loaded</th><th class="num">Age</th></tr></thead><tbody>' +
        f.sources.map((s) => '<tr><td>' + esc(s.source) + '</td><td>' + ptTime(s.loadedAt) + '</td><td class="num ' + (s.ageHours > 24 ? 'c-red' : '') + '">' + s.ageHours.toFixed(1) + 'h</td></tr>').join('') + '</tbody></table>');
    }
  }

  // ---------------------------------------------------------------- load
  function render() {
    details.length = 0;
    const w = data.summaryWindow;
    $('#sub').textContent = 'Client Profitability sheet · Summary through ' + shortDate(w.end) + ' · sheet read ' + ptTime(data.generatedAt);
    renderNotices(); renderTiles(); renderTable();
  }
  function load(force) {
    $('#live-text').textContent = force ? 'Re-reading the sheet…' : 'Loading…';
    fetch('/overview-api/' + (force ? 'refresh' : 'data'), { method: force ? 'POST' : 'GET', cache: 'no-store' })
      .then((r) => { if (r.status === 403) { location.href = '/'; throw new Error('forbidden'); } return r.json(); })
      .then((d) => {
        if (d.loading) { $('#live-text').textContent = 'Reading the sheet…'; setTimeout(load, 4000); return; }
        if (!d.groups) { $('#live-text').textContent = 'Sheet read failed'; $('#notices').innerHTML = '<div class="ov-notice is-error">' + esc(d.error || 'No data') + '</div>'; return; }
        data = d; render();
        $('#live-text').textContent = 'Live – checked ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      })
      .catch(() => {});
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (b) { period = b.dataset.period; render(); return; }
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

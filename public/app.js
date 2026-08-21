(function () {
  const state = {
    dailyRows: [],
    updatedAt: null,
    lastChecked: null, // when we last actually talked to the server, regardless of whether the data changed
    range: { key: 'all', start: null, end: null }, // ISO date strings, inclusive
    search: '',
    board: 'fileName', // 'fileName' | 'hookType' | 'actor' | 'writer' | 'editor' | 'team' | 'new'
    sortBy: 'profit', // 'profit' | 'revenue' | 'spend' — ignored by the 'new' board (always by date)
    expanded: new Set(), // keys ("board::name") of entries with their ad-list dropdown open
  };

  const BOARD_LABELS = { fileName: 'All Creatives', hookType: 'Hook Type', actor: 'Actor', writer: 'Writer', editor: 'Editor', team: 'Collaborators', new: 'New Creatives' };
  const TOP_LABELS = { fileName: 'Top Creative', hookType: 'Top Hook Type', actor: 'Top Actor', writer: 'Top Writer', editor: 'Top Editor', team: 'Top Collaboration', new: 'Top Creative' };
  const TAG_LABELS = { hookType: 'Hook', actor: 'Actor', writer: 'Writer', editor: 'Editor' };
  const ALL_TAG_FIELDS = ['hookType', 'actor', 'writer', 'editor'];

  const $ = (sel) => document.querySelector(sel);
  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const moneySigned = (n) => (n < 0 ? '-$' : '+$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

  // ---------------- date helpers (ISO YYYY-MM-DD strings; "today" is always Pacific time,
  // regardless of the viewer's own timezone, since the underlying campaign data is PT-based) ----
  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(d, n) { const nd = new Date(d); nd.setDate(nd.getDate() + n); return nd; }
  function startOfMonth(y, m) { return new Date(y, m - 1, 1); }
  function endOfMonth(y, m) { return new Date(y, m, 0); }
  function mondayOf(d) { const day = d.getDay(); const diff = day === 0 ? -6 : 1 - day; return addDays(d, diff); }
  function pacificToday() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
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
        if (m) {
          const y = Number(m[1]), mo = Number(m[2]);
          return { start: toISO(startOfMonth(y, mo)), end: toISO(endOfMonth(y, mo)) };
        }
        return { start: null, end: null };
      }
    }
  }

  function rangeLabel() {
    const { key, start, end } = state.range;
    const opt = document.querySelector(`#quick-range option[value="${key}"]`);
    if (key !== 'custom' && opt) return key === 'all' ? '' : '· ' + opt.textContent.toLowerCase();
    if (start && end) return '· ' + start + ' to ' + end;
    return '';
  }

  async function fetchData(url) {
    try {
      const res = await fetch(url || '/api/data', { cache: 'no-store', method: url ? 'POST' : 'GET' });
      const json = await res.json();
      state.dailyRows = json.rows || [];
      state.updatedAt = json.updatedAt;
      state.lastChecked = Date.now();
      render();
      setLive(true);
    } catch (err) {
      setLive(false);
    }
  }

  function setLive(ok) {
    const pill = $('#live-pill');
    const text = $('#live-text');
    pill.classList.toggle('live-pill--live', ok);
    pill.classList.toggle('live-pill--stale', !ok);
    if (ok) {
      const checked = state.lastChecked ? new Date(state.lastChecked) : new Date();
      text.textContent = 'Live – checked ' + timeAgo(checked);
      const t = state.updatedAt ? new Date(state.updatedAt) : checked;
      $('#updated-footer').textContent = 'Last data change: ' + t.toLocaleString();
    } else {
      text.textContent = 'Reconnecting…';
    }
  }

  function timeAgo(date) {
    const s = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    return h + 'h ago';
  }

  // Distinct people credited on an ad (actor/writer/editor), regardless of role, so two
  // people who worked together — in any role combination — group into the same collaborator
  // entry. Sorted alphabetically so role order doesn't create duplicate groups.
  function teamKey(c) {
    const people = [c.actor, c.writer, c.editor].map((v) => (v || '').trim()).filter(Boolean);
    const distinct = [...new Set(people)].sort((a, b) => a.localeCompare(b));
    return distinct.length > 1 ? distinct.join(' + ') : '';
  }

  // Filter raw daily rows by the active date range, then collapse to one row per ad.
  function creativesForRange() {
    const { start, end } = state.range;
    const filtered = (start && end)
      ? state.dailyRows.filter((r) => r.date >= start && r.date <= end)
      : state.dailyRows;

    const byAd = new Map();
    for (const r of filtered) {
      if (r.platform === 'META') continue;
      let c = byAd.get(r.adId);
      if (!c) {
        c = {
          adId: r.adId, adName: r.adName, campaignName: r.campaignName, platform: r.platform,
          spend: 0, revenue: 0,
          youtubeUrl: r.youtubeUrl, landingPageUrl: r.landingPageUrl, frameIoUrl: r.frameIoUrl, fileName: r.fileName,
          hookType: r.hookType, actor: r.actor, writer: r.writer, editor: r.editor, dateUploaded: r.dateUploaded,
        };
        byAd.set(r.adId, c);
      }
      c.spend += r.spend;
      c.revenue += r.revenue;
    }
    return [...byAd.values()].map((c) => ({ ...c, profit: c.revenue - c.spend, team: teamKey(c) }));
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function assetIcons(r) {
    let html = '';
    if (r.youtubeUrl) html += '<a class="asset-link yt" href="' + escapeHtml(r.youtubeUrl) + '" target="_blank" rel="noopener" title="YouTube">YT</a>';
    if (r.landingPageUrl) html += '<a class="asset-link lp" href="' + escapeHtml(r.landingPageUrl) + '" target="_blank" rel="noopener" title="Landing page">LP</a>';
    if (r.frameIoUrl) html += '<a class="asset-link fio" href="' + escapeHtml(r.frameIoUrl) + '" target="_blank" rel="noopener" title="Frame.io">F.io</a>';
    return html;
  }

  // Sheet10's "Date Uploaded" comes through as either a normal date string or a raw Google
  // Sheets date serial (days since 1899-12-30) depending on how that cell was typed.
  function parseSheetDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return new Date((Number(s) - 25569) * 86400000);
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  function formatDate(d) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Aggregate ads by a metadata dimension (File Name / Hook Type / Actor / Writer / Editor /
  // Collaborators), each entry carrying its constituent ads for the always-visible sub-list.
  function aggregateByDimension(rows, field) {
    const byValue = new Map();
    for (const r of rows) {
      const v = (r[field] || '').trim();
      if (!v) continue;
      let g = byValue.get(v);
      if (!g) { g = { name: v, spend: 0, revenue: 0, count: 0, ads: [] }; byValue.set(v, g); }
      g.spend += r.spend;
      g.revenue += r.revenue;
      g.count += 1;
      g.ads.push(r);
    }
    return [...byValue.values()].map((g) => {
      const pick = (f) => g.ads.map((ad) => (ad[f] || '').trim()).find(Boolean) || '';
      const dated = g.ads.map((ad) => parseSheetDate(ad.dateUploaded)).filter(Boolean);
      return {
        ...g,
        profit: g.revenue - g.spend,
        ads: [...g.ads].sort((a, b) => b.profit - a.profit),
        hookType: pick('hookType'), actor: pick('actor'), writer: pick('writer'), editor: pick('editor'),
        uploadedAt: dated.length ? new Date(Math.max(...dated)) : null,
      };
    });
  }

  function sortGroups(groups) {
    const key = state.sortBy;
    return [...groups].sort((a, b) => b[key] - a[key]);
  }

  // Actor/Writer/Editor/Hook Type + upload date, shown under every leaderboard entry —
  // skips whichever field the board is already grouped by (no "Actor: Ron" under Actor itself).
  function metaTags(field, g) {
    let tags = '';
    for (const tf of ALL_TAG_FIELDS) {
      if (tf === field) continue;
      const v = g[tf];
      if (v) tags += '<span class="tag dim-tag">' + TAG_LABELS[tf] + ': ' + escapeHtml(v) + '</span>';
    }
    tags += g.uploadedAt
      ? '<span class="tag dim-tag date-tag">Uploaded ' + formatDate(g.uploadedAt) + '</span>'
      : '<span class="tag dim-tag date-tag date-tag--unknown">No upload date</span>';
    return tags;
  }

  function rankMarkup(idx, isTop) {
    if (isTop) {
      return '<span class="rank rank-top" title="Top creative">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M5 19h14v2H5v-2Zm.6-3L4 7l5.2 3L12 5l2.8 5L20 7l-1.6 9H5.6Z"/></svg>' +
      '</span>';
    }
    return '<span class="rank">' + String(idx + 1).padStart(2, '0') + '</span>';
  }

  function chevronMarkup(isOpen) {
    return '<svg class="dimension-chevron' + (isOpen ? ' is-open' : '') + '" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  }

  function expandHtml(g) {
    return (
      '<div class="dimension-expand">' +
        '<div class="table-scroll">' +
          '<table>' +
            '<thead><tr><th>Ad Name</th><th class="num-col">Spend</th><th class="num-col">Revenue</th><th class="num-col">Profit</th><th class="num-col">ROAS</th><th>Assets</th></tr></thead>' +
            '<tbody>' + g.ads.map(detailRowHtml).join('') + '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>'
    );
  }

  function dimensionRowHtml(field, g, idx, maxAbs) {
    const val = g[state.sortBy];
    const isPos = val >= 0;
    const isTop = idx === 0 && isPos;
    const pct = maxAbs > 0 ? Math.max(4, Math.round((Math.abs(val) / maxAbs) * 100)) : 4;
    const valLabel = state.sortBy === 'profit' ? moneySigned(val) : money(val);
    const key = state.board + '::' + g.name;
    const isOpen = state.expanded.has(key);
    return (
      '<div class="dimension-entry">' +
        '<div class="dimension-row' + (isTop ? ' dimension-row--top' : '') + '" data-key="' + escapeHtml(key) + '">' +
          rankMarkup(idx, isTop) +
          '<div>' +
            '<div class="dimension-name dimension-name-clickable">' + escapeHtml(g.name) +
              (isTop ? '<span class="top-badge">' + TOP_LABELS[state.board] + '</span>' : '') +
              chevronMarkup(isOpen) +
            '</div>' +
            '<div class="dimension-count">' + g.count + ' ' + (g.count === 1 ? 'ad' : 'ads') + ' &middot; ' + money(g.spend) + ' spend</div>' +
            '<div class="dimension-meta">' + metaTags(field, g) + '</div>' +
          '</div>' +
          '<div class="dimension-figs">' +
            '<div class="row-profit ' + (isPos ? 'profit' : 'loss') + ' num">' + valLabel + '</div>' +
          '</div>' +
          '<div class="dimension-bar-track"><div class="bar-fill ' + (isPos ? 'profit' : 'loss') + '" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        (isOpen ? expandHtml(g) : '') +
      '</div>'
    );
  }

  function newRowHtml(g, idx, maxAbs) {
    const showMetric = state.sortBy !== 'date';
    const val = showMetric ? g[state.sortBy] : 0;
    const isPos = val >= 0;
    const isTop = idx === 0 && showMetric && isPos;
    const pct = showMetric && maxAbs > 0 ? Math.max(4, Math.round((Math.abs(val) / maxAbs) * 100)) : 0;
    const valLabel = state.sortBy === 'profit' ? moneySigned(val) : money(val);
    const key = state.board + '::' + g.name;
    const isOpen = state.expanded.has(key);
    return (
      '<div class="dimension-entry">' +
        '<div class="dimension-row' + (isTop ? ' dimension-row--top' : '') + '" data-key="' + escapeHtml(key) + '">' +
          rankMarkup(idx, isTop) +
          '<div>' +
            '<div class="dimension-name dimension-name-clickable">' + escapeHtml(g.name) +
              (isTop ? '<span class="top-badge">' + TOP_LABELS[state.board] + '</span>' : '') +
              chevronMarkup(isOpen) +
            '</div>' +
            '<div class="dimension-count">' + g.count + ' ' + (g.count === 1 ? 'ad' : 'ads') + ' &middot; ' + money(g.spend) + ' spend</div>' +
            '<div class="dimension-meta">' + metaTags('fileName', g) + '</div>' +
          '</div>' +
          '<div class="dimension-figs">' +
            (showMetric
              ? '<div class="row-profit ' + (isPos ? 'profit' : 'loss') + ' num">' + valLabel + '</div>'
              : '<span class="tag dim-tag date-tag">Uploaded ' + formatDate(g.uploadedAt) + '</span>') +
          '</div>' +
          (showMetric ? '<div class="dimension-bar-track"><div class="bar-fill ' + (isPos ? 'profit' : 'loss') + '" style="width:' + pct + '%"></div></div>' : '') +
        '</div>' +
        (isOpen ? expandHtml(g) : '') +
      '</div>'
    );
  }

  function emptyMsg(text) {
    return '<div style="padding:24px 0;color:var(--text-faint);font-size:12.5px;">' + text + '</div>';
  }

  function matchesSearch(name) {
    const q = state.search.trim().toLowerCase();
    return !q || name.toLowerCase().includes(q);
  }

  function renderBoard(rows) {
    $('#board-title').textContent = BOARD_LABELS[state.board];

    if (state.board === 'new') {
      const groups = aggregateByDimension(rows, 'fileName')
        .filter((g) => matchesSearch(g.name) && g.uploadedAt)
        .sort((a, b) => (state.sortBy === 'date' ? b.uploadedAt - a.uploadedAt : b[state.sortBy] - a[state.sortBy]));
      const maxAbs = Math.max(1, ...groups.map((g) => Math.abs(g[state.sortBy] || 0)));
      const sortLabel = state.sortBy === 'date' ? 'newest first' : 'sorted by ' + state.sortBy;
      $('#board-count').innerHTML = groups.length + ' ' + (groups.length === 1 ? 'file' : 'files') + ' &middot; ' + sortLabel;
      $('#board-list').innerHTML = groups.length ? groups.map((g, i) => newRowHtml(g, i, maxAbs)).join('') : emptyMsg('No upload dates tagged yet for this range.');
      return;
    }

    const field = state.board;
    const groups = sortGroups(aggregateByDimension(rows, field).filter((g) => matchesSearch(g.name)));
    const maxAbs = Math.max(1, ...groups.map((g) => Math.abs(g[state.sortBy])));
    $('#board-count').innerHTML = groups.length + ' ' + (groups.length === 1 ? 'entry' : 'entries') + ' &middot; sorted by ' + state.sortBy;
    $('#board-list').innerHTML = groups.length
      ? groups.map((g, i) => dimensionRowHtml(field, g, i, maxAbs)).join('')
      : emptyMsg('No ' + BOARD_LABELS[field].toLowerCase() + ' data tagged yet for this range.');
  }

  function detailRowHtml(ad) {
    const roas = ad.spend > 0 ? ad.revenue / ad.spend : 0;
    return (
      '<tr>' +
        '<td class="name-cell" title="' + escapeHtml(ad.adName) + '">' +
          escapeHtml(ad.adName || '(untitled)') +
          (ad.campaignName ? '<div class="name-sub">' + escapeHtml(ad.campaignName) + '</div>' : '') +
        '</td>' +
        '<td class="num-col">' + money(ad.spend) + '</td>' +
        '<td class="num-col">' + money(ad.revenue) + '</td>' +
        '<td class="num-col ' + (ad.profit >= 0 ? 'profit-pos' : 'profit-neg') + '">' + moneySigned(ad.profit) + '</td>' +
        '<td class="num-col">' + roas.toFixed(2) + '&times;</td>' +
        '<td class="assets-cell">' + (assetIcons(ad) || '<span class="no-assets">&mdash;</span>') + '</td>' +
      '</tr>'
    );
  }

  function render() {
    const rows = creativesForRange();
    $('#creative-count').textContent = rows.length.toLocaleString();
    $('#range-label').textContent = rangeLabel();
    renderBoard(rows);
  }

  // ---- date range controls ----
  $('#quick-range').addEventListener('change', (e) => {
    const key = e.target.value;
    const customBox = $('#custom-dates');
    if (key === 'custom') {
      customBox.hidden = false;
      const { start, end } = state.range;
      if (start) $('#date-start').value = start;
      if (end) $('#date-end').value = end;
      return;
    }
    if (key === 'all') {
      customBox.hidden = true;
      $('#date-start').value = '';
      $('#date-end').value = '';
      state.range = { key, start: null, end: null };
      render();
      return;
    }
    const { start, end } = computeRange(key);
    customBox.hidden = false;
    $('#date-start').value = start || '';
    $('#date-end').value = end || '';
    state.range = { key, start, end };
    render();
  });

  function applyCustomRange() {
    const start = $('#date-start').value;
    const end = $('#date-end').value;
    if (!start || !end) return;
    state.range = { key: 'custom', start, end };
    render();
  }
  $('#date-start').addEventListener('change', applyCustomRange);
  $('#date-end').addEventListener('change', applyCustomRange);

  $('#clear-range').addEventListener('click', () => {
    $('#quick-range').value = 'all';
    $('#custom-dates').hidden = true;
    $('#date-start').value = '';
    $('#date-end').value = '';
    state.range = { key: 'all', start: null, end: null };
    render();
  });

  // ---- leaderboard tabs ----
  $('#leaderboard-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    document.querySelectorAll('#leaderboard-tabs .chip').forEach((c) => c.classList.remove('is-active'));
    btn.classList.add('is-active');
    state.board = btn.dataset.board;
    $('#sort-newest').hidden = state.board !== 'new';
    if (state.board === 'new' && state.sortBy !== 'date') {
      state.sortBy = 'date';
      document.querySelectorAll('#sort-tabs .chip').forEach((c) => c.classList.remove('is-active'));
      $('#sort-newest').classList.add('is-active');
    } else if (state.board !== 'new' && state.sortBy === 'date') {
      state.sortBy = 'profit';
      document.querySelectorAll('#sort-tabs .chip').forEach((c) => c.classList.remove('is-active'));
      $('#sort-tabs [data-sort="profit"]').classList.add('is-active');
    }
    state.expanded.clear();
    render();
  });

  // ---- sort tabs ----
  $('#sort-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    document.querySelectorAll('#sort-tabs .chip').forEach((c) => c.classList.remove('is-active'));
    btn.classList.add('is-active');
    state.sortBy = btn.dataset.sort;
    render();
  });

  // ---- search ----
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    render();
  });

  // ---- click a leaderboard row to expand/collapse its ad list inline ----
  $('#board-list').addEventListener('click', (e) => {
    const row = e.target.closest('.dimension-row');
    if (!row) return;
    const key = row.dataset.key;
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    render();
  });

  // ---- manual refresh ----
  $('#refresh-btn').addEventListener('click', async () => {
    const btn = $('#refresh-btn');
    if (btn.classList.contains('is-spinning')) return;
    btn.classList.add('is-spinning');
    await fetchData('/api/refresh');
    setTimeout(() => btn.classList.remove('is-spinning'), 400);
  });

  // ---- back to top ----
  const backToTop = $('#back-to-top');
  window.addEventListener('scroll', () => {
    backToTop.hidden = window.scrollY < 400;
  });
  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ---- live updates ----
  fetchData();
  setInterval(() => fetchData(), 30000);
  setInterval(() => { if (state.lastChecked) setLive(true); }, 1000);

  try {
    const es = new EventSource('/api/events');
    es.addEventListener('update', () => fetchData());
    es.onerror = () => setLive(false);
  } catch (err) {
    // SSE unsupported — polling above still keeps data fresh.
  }
})();

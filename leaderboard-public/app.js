(function () {
  const state = {
    dailyRows: [],
    updatedAt: null,
    lastChecked: null, // when we last actually talked to the server, regardless of whether the data changed
    range: { key: 'all', start: null, end: null }, // ISO date strings, inclusive
    search: '',
    board: 'fileName', // 'fileName' | 'hookType' | 'actor' | 'writer' | 'editor' | 'team' | 'new'
    sortBy: 'profit', // 'profit' | 'revenue' | 'spend' — used only to rank; values are never shown
    viewMode: 'cards', // 'cards' | 'table'
    openGroupKey: null, // fileName of whichever creative's video panel is currently open
    openCategoryKey: null, // "board::name" of whichever person/hook/team category is open
  };

  // fileName -> ads array (for opening a creative's top ad), and "board::name" -> creatives
  // array (for a person/hook/team category's top creative) — both populated once per render
  // from the full unfiltered per-board aggregation, not from whichever subset is on screen.
  const groupAdsRegistry = new Map();
  const categoryCreativesRegistry = new Map();

  const BOARD_LABELS = { fileName: 'All Creatives', hookType: 'Hook Type', actor: 'Actor', writer: 'Writer', editor: 'Editor', team: 'Collaborators' };
  const TOP_LABELS = { fileName: 'Top Creative', hookType: 'Top Hook Type', actor: 'Top Actor', writer: 'Top Writer', editor: 'Top Editor', team: 'Top Collaboration' };
  const TAG_LABELS = { hookType: 'Hook', actor: 'Actor', writer: 'Writer', editor: 'Editor' };
  const ALL_TAG_FIELDS = ['hookType', 'actor', 'writer', 'editor'];
  const PEOPLE_FIELDS = ['actor', 'writer', 'editor'];
  // Whole campaigns excluded from every figure on the leaderboard, matched by name.
  const EXCLUDED_CAMPAIGN_PATTERN = /agency|sasoon|including km/i;

  const $ = (sel) => document.querySelector(sel);

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
      if (EXCLUDED_CAMPAIGN_PATTERN.test(r.campaignName || '')) continue;
      let c = byAd.get(r.adId);
      if (!c) {
        c = {
          adId: r.adId, fileName: r.fileName, displayName: r.displayName,
          spend: 0, revenue: 0,
          // All-time totals from the Creative Tracker sheet — identical on every daily row for
          // this ad, so they're set once here rather than summed across days.
          leadsAllTime: r.leadsAllTime || 0, qmvaAllTime: r.qmvaAllTime || 0,
          hookType: r.hookType, actor: r.actor, writer: r.writer, editor: r.editor, dateUploaded: r.dateUploaded,
          youtubeUrl: r.youtubeUrl,
        };
        byAd.set(r.adId, c);
      }
      c.spend += r.spend;
      c.revenue += r.revenue;
    }
    return [...byAd.values()].map((c) => ({ ...c, profit: c.revenue - c.spend, team: teamKey(c) }));
  }

  // A handful of "Frame file name" values already have a naming-convention-shaped string
  // baked into them as the literal filename (no separate "naming convention" cell filled in),
  // so falling back to the raw fileName can still end in ".mp4" while every properly filled-in
  // naming convention doesn't — strip a trailing video extension so both cases read the same.
  function stripVideoExt(s) {
    return String(s || '').replace(/\.(mp4|mov|m4v|mpe?g|avi|wmv|mp3)\s*$/i, '').trim();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
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

  function aggregateByDimension(rows, field) {
    const byValue = new Map();
    for (const r of rows) {
      const v = (r[field] || '').trim();
      if (!v) continue;
      let g = byValue.get(v);
      if (!g) { g = { name: v, spend: 0, revenue: 0, leadsAllTime: 0, qmvaAllTime: 0, count: 0, ads: [] }; byValue.set(v, g); }
      g.spend += r.spend;
      g.revenue += r.revenue;
      g.leadsAllTime += r.leadsAllTime;
      g.qmvaAllTime += r.qmvaAllTime;
      g.count += 1;
      g.ads.push(r);
    }
    return [...byValue.values()].map((g) => {
      const pick = (f) => g.ads.map((ad) => (ad[f] || '').trim()).find(Boolean) || '';
      const dated = g.ads.map((ad) => parseSheetDate(ad.dateUploaded)).filter(Boolean);
      // The sheet's "naming convention" column supplies an agreed clean title for a fileName
      // group — use it when present, since raw fileNames are often messy export filenames.
      const displayName = field === 'fileName' ? pick('displayName') : '';
      return {
        ...g,
        name: displayName || stripVideoExt(g.name),
        profit: g.revenue - g.spend,
        hookType: pick('hookType'), actor: pick('actor'), writer: pick('writer'), editor: pick('editor'),
        youtubeUrl: pick('youtubeUrl'),
        uploadedAt: dated.length ? new Date(Math.max(...dated)) : null,
      };
    });
  }

  function sortGroups(groups) {
    if (state.sortBy === 'date') {
      return [...groups].sort((a, b) => (b.uploadedAt ? b.uploadedAt.getTime() : 0) - (a.uploadedAt ? a.uploadedAt.getTime() : 0));
    }
    return [...groups].sort((a, b) => b[state.sortBy] - a[state.sortBy]);
  }

  // Actor/Writer/Editor are the headline info — who's actually credited — so they get their
  // own prominent line up top.
  function peopleTags(field, g) {
    let tags = '';
    for (const tf of PEOPLE_FIELDS) {
      if (tf === field) continue;
      const v = g[tf];
      if (v) tags += '<span class="tag dim-tag dim-tag--' + tf + '">' + TAG_LABELS[tf] + ': ' + escapeHtml(v) + '</span>';
    }
    return tags;
  }

  // Hook Type + upload date are secondary context, shown in the same line as the stats.
  function secondaryTags(field, g) {
    let tags = '';
    if (field !== 'hookType' && g.hookType) {
      tags += '<span class="tag dim-tag dim-tag--hookType">' + TAG_LABELS.hookType + ': ' + escapeHtml(g.hookType) + '</span>';
    }
    if (g.uploadedAt) tags += '<span class="tag dim-tag date-tag">Uploaded ' + formatDate(g.uploadedAt) + '</span>';
    return tags;
  }

  // A row on a person/hook/team board (Actor, Writer, Editor, Hook Type, Collaborators)
  // represents a person or category, not one creative — a tag like "Writer: zeke" picked
  // from just one of their many ads would be misleading, so those rows only show a
  // most-recent-upload date instead of the other roles' names.
  function personMetaTags(g) {
    return g.uploadedAt ? '<span class="tag dim-tag date-tag">Most recent: ' + formatDate(g.uploadedAt) + '</span>' : '';
  }

  function pct(n) { return n.toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%'; }

  // Leads comes from the Creative Tracker sheet's own accurate Leads column, which is
  // all-time only — no daily breakdown — so it's only shown when no date filter is active.
  // Profit contribution / Leads / ROAS shown as a right-aligned mini-table (matching the
  // financial dashboard's card layout), not inline tags — negative contribution reads red.
  function figsTableHtml(g, totalProfit) {
    const contribution = totalProfit > 0 ? (g.profit / totalProfit) * 100 : null;
    const roas = g.spend > 0 ? g.revenue / g.spend : 0;
    let html = '<div class="figs-table">';
    html +=
      '<div class="figs-col"><div class="figs-label">Profit contribution</div>' +
      '<div class="figs-value ' + (contribution != null && contribution < 0 ? 'profit-neg' : 'profit-pos') + '">' +
      (contribution != null ? pct(contribution) : '&mdash;') + '</div></div>';
    if (state.range.key === 'all') {
      html += '<div class="figs-col"><div class="figs-label">Leads</div><div class="figs-value">' + g.leadsAllTime.toLocaleString('en-US') + '</div></div>';
    }
    html += '<div class="figs-col"><div class="figs-label">ROAS</div><div class="figs-value">' + roas.toFixed(2) + '&times;</div></div>';
    html += '</div>';
    return html;
  }

  function youtubeId(url) {
    if (!url) return '';
    const m = /(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{6,})/.exec(url);
    return m ? m[1] : '';
  }

  function rowThumbHtml(g) {
    const ytId = youtubeId(g.youtubeUrl);
    return '<div class="row-thumb-slot">' + (
      ytId
        ? '<button class="ad-thumb" data-yt-id="' + escapeHtml(ytId) + '" data-ad-name="' + escapeHtml(g.name || '') + '"' +
            ' data-actor="' + escapeHtml(g.actor || '') + '" data-writer="' + escapeHtml(g.writer || '') + '" data-editor="' + escapeHtml(g.editor || '') + '"' +
            ' data-hook="' + escapeHtml(g.hookType || '') + '" data-leads="' + (g.leadsAllTime || 0) + '"' +
            ' data-group-key="' + escapeHtml(g.name || '') + '"' +
            ' title="Play video">' +
            '<img src="https://img.youtube.com/vi/' + escapeHtml(ytId) + '/mqdefault.jpg" alt="" loading="lazy">' +
            '<span class="ad-thumb-play">&#9658;</span>' +
          '</button>'
        : ''
    ) + '</div>';
  }

  // A small pulsing dot (matching the "Live" indicator's own style) next to a name, shown only
  // when spend > 0 in the current range — no text label, the dot alone says "still running".
  // Ad IDs that actually spent something today (Pacific) — independent of whatever date range
  // is selected, since "still running" should mean running right now, not "had spend at some
  // point in the selected range" (which was true for almost everything under "All time").
  let activeAdIdsToday = new Set();
  function refreshActiveAdIdsToday() {
    // "Active" means spent on the last day of whatever's currently selected — the end of a
    // specific range (so picking "Yesterday" checks yesterday, not today), or under "All time"
    // the most recent day actually present in the data (robust to the sheet lagging a day
    // behind the calendar, which would otherwise empty every dot for no real reason).
    let referenceDay = state.range.end;
    if (!referenceDay) {
      let latest = '';
      for (const r of state.dailyRows) { if (r.date > latest) latest = r.date; }
      referenceDay = latest;
    }
    activeAdIdsToday = new Set(
      state.dailyRows.filter((r) => r.date === referenceDay && r.spend > 0 && r.platform !== 'META').map((r) => r.adId)
    );
  }
  function creativeActiveDot(ads) {
    return ads && ads.some((ad) => activeAdIdsToday.has(ad.adId)) ? '<span class="active-dot" title="Spent today"></span>' : '';
  }

  function rankMarkup(idx, isTop) {
    if (isTop) {
      return '<span class="rank rank-top" title="Top of the leaderboard">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M5 19h14v2H5v-2Zm.6-3L4 7l5.2 3L12 5l2.8 5L20 7l-1.6 9H5.6Z"/></svg>' +
      '</span>';
    }
    return '<span class="rank">' + String(idx + 1).padStart(2, '0') + '</span>';
  }

  function dimensionRowHtml(field, g, idx, totalProfit) {
    // "Top" only means something for a ranked metric — sorting by Newest has no such notion.
    const isTop = idx === 0 && state.sortBy !== 'date';
    const isCreative = field === 'fileName';
    const categoryKey = field + '::' + g.name;
    const isActive = isCreative ? state.openGroupKey === g.name : state.openCategoryKey === categoryKey;
    return (
      '<div class="dimension-row' + (isTop ? ' dimension-row--top' : '') + (isActive ? ' row-active' : '') + '"' +
        (isCreative
          ? ' data-creative="1" data-group-key="' + escapeHtml(g.name) + '"'
          : ' data-category="1" data-category-key="' + escapeHtml(categoryKey) + '"') + '>' +
        rankMarkup(idx, isTop) +
        (field === 'fileName' ? rowThumbHtml(g) : '<div class="row-thumb-slot"></div>') +
        '<div>' +
          '<div class="dimension-name">' + creativeActiveDot(g.ads) + escapeHtml(g.name) +
            (isTop ? '<span class="top-badge">' + TOP_LABELS[state.board] + '</span>' : '') +
          '</div>' +
          '<div class="dimension-count">' + g.count + ' ' + (g.count === 1 ? 'ad' : 'ads') + '</div>' +
          '<div class="dimension-meta">' + (field === 'fileName' ? peopleTags(field, g) : '') + '</div>' +
          '<div class="dimension-stats">' + (field === 'fileName' ? secondaryTags(field, g) : personMetaTags(g)) + '</div>' +
        '</div>' +
        '<div class="dimension-figs">' + figsTableHtml(g, totalProfit) + '</div>' +
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

  // A flat, spreadsheet-style alternative to the card rows — same underlying groups, no
  // dollar figures (matching this site's no-financial-detail premise). Person/hook/team
  // boards suppress the Actor/Writer/Editor/Hook columns for the same reason the cards do:
  // those values are picked from just one of many ads and would misrepresent the entry.
  function tableHtml(field, groups, totalProfit, dateColLabel) {
    const showPeople = field === 'fileName';
    const showLeads = state.range.key === 'all';
    const numCols = ['Ads', 'Contribution', 'Leads'];
    const cols = ['#', 'Name'];
    if (showPeople) cols.push('Actor', 'Writer', 'Editor', 'Hook');
    cols.push('Ads', 'Contribution');
    if (showLeads) cols.push('Leads');
    cols.push(dateColLabel);

    const thead = '<thead><tr>' + cols.map((c) => '<th' + (numCols.includes(c) ? ' class="num-col"' : '') + '>' + c + '</th>').join('') + '</tr></thead>';

    const bodyRows = groups.map((g, i) => {
      const contribution = totalProfit > 0 ? (g.profit / totalProfit) * 100 : null;
      const isCreative = field === 'fileName';
      const categoryKey = field + '::' + g.name;
      const isActive = isCreative ? state.openGroupKey === g.name : state.openCategoryKey === categoryKey;
      let cells = '<td class="num-col">' + (i + 1) + '</td>';
      cells += '<td class="name-cell">' + creativeActiveDot(g.ads) + escapeHtml(g.name) + '</td>';
      if (showPeople) {
        cells += '<td>' + (g.actor ? escapeHtml(g.actor) : '&mdash;') + '</td>';
        cells += '<td>' + (g.writer ? escapeHtml(g.writer) : '&mdash;') + '</td>';
        cells += '<td>' + (g.editor ? escapeHtml(g.editor) : '&mdash;') + '</td>';
        cells += '<td>' + (g.hookType ? escapeHtml(g.hookType) : '&mdash;') + '</td>';
      }
      cells += '<td class="num-col">' + g.count + '</td>';
      cells += '<td class="num-col">' + (contribution != null ? pct(contribution) : '&mdash;') + '</td>';
      if (showLeads) cells += '<td class="num-col">' + g.leadsAllTime.toLocaleString('en-US') + '</td>';
      cells += '<td>' + (g.uploadedAt ? formatDate(g.uploadedAt) : '&mdash;') + '</td>';
      return '<tr class="table-toggle-row' + (isActive ? ' row-active' : '') + '"' +
        (isCreative
          ? ' data-creative="1" data-group-key="' + escapeHtml(g.name) + '"'
          : ' data-category="1" data-category-key="' + escapeHtml(categoryKey) + '"') +
        '>' + cells + '</tr>';
    }).join('');

    return (
      '<div class="table-scroll">' +
        '<table>' + thead +
          '<tbody>' + (bodyRows || '<tr class="empty-row"><td colspan="' + cols.length + '">No data for this range.</td></tr>') + '</tbody>' +
        '</table>' +
      '</div>'
    );
  }

  function renderBoard(rows, totalProfit) {
    $('#board-title').textContent = BOARD_LABELS[state.board];

    const field = state.board;
    const groups = sortGroups(aggregateByDimension(rows, field).filter((g) => matchesSearch(g.name)));
    const sortLabel = state.sortBy === 'date' ? 'newest first' : 'ranked by ' + state.sortBy;
    $('#board-count').innerHTML = groups.length + ' ' + (groups.length === 1 ? 'entry' : 'entries') + ' &middot; ' + sortLabel;
    $('#board-list').innerHTML = !groups.length
      ? emptyMsg('No ' + BOARD_LABELS[field].toLowerCase() + ' data tagged yet for this range.')
      : state.viewMode === 'table'
        ? tableHtml(field, groups, totalProfit, field === 'fileName' ? 'Uploaded' : 'Most Recent')
        : groups.map((g, i) => dimensionRowHtml(field, g, i, totalProfit)).join('');
  }

  function render() {
    const rows = creativesForRange();
    $('#creative-count').textContent = rows.length;
    $('#range-label').textContent = rangeLabel();
    refreshActiveAdIdsToday();
    // Same fix as creative-dashboard: base "Profit contribution" on total positive profit only,
    // so a single strong performer can't show over 100% just because other entries are net-negative.
    const totalProfit = rows.reduce((a, r) => a + Math.max(r.profit, 0), 0);
    groupAdsRegistry.clear();
    for (const g of aggregateByDimension(rows, 'fileName')) groupAdsRegistry.set(g.name, g.ads);
    categoryCreativesRegistry.clear();
    for (const field of ['hookType', 'actor', 'writer', 'editor', 'team']) {
      for (const g of aggregateByDimension(rows, field)) {
        categoryCreativesRegistry.set(field + '::' + g.name, aggregateByDimension(g.ads, 'fileName').sort((a, b) => b.profit - a.profit));
      }
    }
    renderBoard(rows, totalProfit);
  }

  // ---- quick range ----
  $('#quick-range').addEventListener('change', (e) => {
    const key = e.target.value;
    $('#custom-dates').hidden = key !== 'custom';
    if (key === 'custom') return;
    state.range = { key, ...computeRange(key) };
    render();
  });
  function applyCustomRange() {
    const s = $('#date-start').value;
    const e = $('#date-end').value;
    if (s && e) {
      state.range = { key: 'custom', start: s, end: e };
      render();
    }
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
  // ---- table/cards view toggle ----
  $('#view-toggle').addEventListener('click', () => {
    state.viewMode = state.viewMode === 'table' ? 'cards' : 'table';
    const btn = $('#view-toggle');
    btn.classList.toggle('is-active', state.viewMode === 'table');
    btn.title = state.viewMode === 'table' ? 'Switch to card view' : 'Switch to table view';
    $('#view-toggle-label').textContent = state.viewMode === 'table' ? 'Card view' : 'Table view';
    render();
  });

  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    render();
  });

  // ---- inline video preview: click a thumbnail to watch the ad in a side panel, without
  // leaving or blocking the rest of the leaderboard ----
  // Highlights whichever left-list row matches the creative currently open in the panel,
  // without a full re-render. state.openGroupKey is also read by the row-render functions so a
  // later full render (e.g. the 30s data poll) keeps the same row highlighted.
  function rowSelector(attrSelector) {
    return '.dimension-row' + attrSelector + ', .table-toggle-row' + attrSelector;
  }
  function syncActiveRowHighlight() {
    document.querySelectorAll(rowSelector('.row-active')).forEach((el) => el.classList.remove('row-active'));
    if (state.openGroupKey) {
      document.querySelectorAll(rowSelector('[data-group-key="' + CSS.escape(state.openGroupKey) + '"]')).forEach((el) => el.classList.add('row-active'));
    }
    if (state.openCategoryKey) {
      document.querySelectorAll(rowSelector('[data-category-key="' + CSS.escape(state.openCategoryKey) + '"]')).forEach((el) => el.classList.add('row-active'));
    }
  }

  // A single creative row: plays its top-profit ad with a video directly.
  function openCreativePanel(groupKey) {
    const ads = groupAdsRegistry.get(groupKey);
    if (!ads || !ads.length) return;
    const top = ads.find((ad) => youtubeId(ad.youtubeUrl)) || ads[0];
    const ytId = youtubeId(top.youtubeUrl);
    if (!ytId) return;
    // Leads is this creative's total across every ad using it (matching the card's own Leads
    // figure), not just the one ad whose video happens to play here.
    const totalLeads = ads.reduce((a, ad) => a + (ad.leadsAllTime || 0), 0);
    openVideoPanel(ytId, groupKey, {
      actor: top.actor, writer: top.writer, editor: top.editor, hook: top.hookType, leads: totalLeads,
    }, groupKey);
  }

  // A person/hook/team category row has no single video of its own — it opens its top-profit
  // creative's top ad instead, keyed by that creative's fileName.
  function openCategoryPanel(categoryKey) {
    const creatives = categoryCreativesRegistry.get(categoryKey);
    if (!creatives || !creatives.length) return;
    state.openCategoryKey = categoryKey;
    const topCreative = creatives.find((cg) => cg.ads.some((ad) => youtubeId(ad.youtubeUrl))) || creatives[0];
    openCreativePanel(topCreative.name);
  }

  let openYtId = null; // guards against a slow /api/views response overwriting a later selection

  function openVideoPanel(ytId, title, meta, groupKey) {
    openYtId = ytId;
    state.openGroupKey = groupKey || null;
    syncActiveRowHighlight();
    $('#video-panel').scrollTop = 0; // jump back to the video whenever a new one is opened
    $('#video-panel-embed').innerHTML =
      '<iframe src="https://www.youtube.com/embed/' + ytId + '?rel=0" ' +
      'title="Ad preview" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>';
    $('#video-panel-title').textContent = title || 'Preview';
    $('#video-panel-views').textContent = '';
    let tags = '';
    if (meta.actor) tags += '<span class="tag dim-tag dim-tag--actor">Actor: ' + escapeHtml(meta.actor) + '</span>';
    if (meta.writer) tags += '<span class="tag dim-tag dim-tag--writer">Writer: ' + escapeHtml(meta.writer) + '</span>';
    if (meta.editor) tags += '<span class="tag dim-tag dim-tag--editor">Editor: ' + escapeHtml(meta.editor) + '</span>';
    if (meta.hook) tags += '<span class="tag dim-tag dim-tag--hookType">Hook: ' + escapeHtml(meta.hook) + '</span>';
    if (meta.leads) tags += '<span class="tag stat-tag stat-tag--cost">Leads: ' + Number(meta.leads).toLocaleString('en-US') + '</span>';
    $('#video-panel-body').innerHTML = tags;
    $('#video-panel').classList.add('is-open');
    document.body.classList.add('video-panel-open'); // pushes the page over, doesn't cover it
    // Shown right by the title, the way YouTube itself pairs a video's title with its view count.
    fetch('/api/views?id=' + encodeURIComponent(ytId)).then((r) => r.json()).then((d) => {
      if (openYtId !== ytId) return;
      $('#video-panel-views').textContent = d.views != null ? d.views.toLocaleString('en-US') + ' views' : '';
    }).catch(() => {
      if (openYtId !== ytId) return;
      $('#video-panel-views').textContent = '';
    });
  }
  function closeVideoPanel() {
    openYtId = null;
    state.openGroupKey = null;
    state.openCategoryKey = null;
    syncActiveRowHighlight();
    $('#video-panel').classList.remove('is-open');
    $('#video-panel-embed').innerHTML = ''; // clear so playback actually stops
    $('#video-panel-body').innerHTML = '';
    document.body.classList.remove('video-panel-open');
  }
  // ---- click a leaderboard row: a creative row plays its top ad directly; a category row
  // (Actor/Writer/etc) plays its top creative's top ad instead. Works the same in card view
  // and table view, and from a thumbnail or anywhere else on the row. ----
  $('#board-list').addEventListener('click', (e) => {
    const thumb = e.target.closest('.ad-thumb');
    if (thumb && thumb.dataset.ytId) {
      state.openCategoryKey = null;
      openVideoPanel(thumb.dataset.ytId, thumb.dataset.adName, {
        actor: thumb.dataset.actor, writer: thumb.dataset.writer, editor: thumb.dataset.editor,
        hook: thumb.dataset.hook, leads: thumb.dataset.leads,
      }, thumb.dataset.groupKey);
      return;
    }
    const creativeRow = e.target.closest('[data-creative="1"]');
    if (creativeRow) {
      state.openCategoryKey = null;
      openCreativePanel(creativeRow.dataset.groupKey);
      return;
    }
    const categoryRow = e.target.closest('[data-category="1"]');
    if (categoryRow) {
      openCategoryPanel(categoryRow.dataset.categoryKey);
      return;
    }
  });
  $('#video-panel-close').addEventListener('click', closeVideoPanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#video-panel').classList.contains('is-open')) closeVideoPanel();
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

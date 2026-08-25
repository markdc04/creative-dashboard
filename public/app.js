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
    viewMode: 'cards', // 'cards' | 'table'
    openGroupKey: null, // fileName of whichever creative's video panel is currently open
    openCategoryKey: null, // "board::name" of whichever person/hook/team category is open
  };

  const BOARD_LABELS = { fileName: 'All Creatives', active: 'Active Creatives', hookType: 'Hook Type', actor: 'Actor', writer: 'Writer', editor: 'Editor', team: 'Collaborators', new: 'New Creatives' };
  const TOP_LABELS = { fileName: 'Top Creative', active: 'Top Active Creative', hookType: 'Top Hook Type', actor: 'Top Actor', writer: 'Top Writer', editor: 'Top Editor', team: 'Top Collaboration', new: 'Top Creative' };
  const TAG_LABELS = { hookType: 'Hook', actor: 'Actor', writer: 'Writer', editor: 'Editor' };
  const ALL_TAG_FIELDS = ['hookType', 'actor', 'writer', 'editor'];
  const PEOPLE_FIELDS = ['actor', 'writer', 'editor'];

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
          // All-time totals from the Creative Tracker sheet — identical on every daily row for
          // this ad, so they're set once here rather than summed across days (which would
          // multiply them by however many days are in the selected range).
          leadsAllTime: r.leadsAllTime || 0, qmvaAllTime: r.qmvaAllTime || 0,
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

  function youtubeId(url) {
    if (!url) return '';
    const m = /(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{6,})/.exec(url);
    return m ? m[1] : '';
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
      return {
        ...g,
        profit: g.revenue - g.spend,
        ads: [...g.ads].sort((a, b) => b.profit - a.profit),
        hookType: pick('hookType'), actor: pick('actor'), writer: pick('writer'), editor: pick('editor'),
        youtubeUrl: pick('youtubeUrl'),
        uploadedAt: dated.length ? new Date(Math.max(...dated)) : null,
      };
    });
  }

  function sortGroups(groups) {
    const key = state.sortBy;
    return [...groups].sort((a, b) => b[key] - a[key]);
  }

  // Actor/Writer/Editor are the headline info — who's actually credited — so they get their
  // own prominent line up top. Skips whichever field the board is already grouped by (no
  // "Actor: Ron" under Actor itself).
  function peopleTags(field, g) {
    let tags = '';
    for (const tf of PEOPLE_FIELDS) {
      if (tf === field) continue;
      const v = g[tf];
      if (v) tags += '<span class="tag dim-tag dim-tag--' + tf + '">' + TAG_LABELS[tf] + ': ' + escapeHtml(v) + '</span>';
    }
    return tags;
  }

  // Hook Type + upload date are secondary context, shown in the same line as the performance
  // stats below the people tags. skipDate omits the upload-date tag when it's already shown
  // elsewhere on the row (the New Creatives board shows it as a standalone badge).
  function secondaryTags(field, g, skipDate) {
    let tags = '';
    if (field !== 'hookType' && g.hookType) {
      tags += '<span class="tag dim-tag dim-tag--hookType">' + TAG_LABELS.hookType + ': ' + escapeHtml(g.hookType) + '</span>';
    }
    if (skipDate) return tags;
    if (g.uploadedAt) tags += '<span class="tag dim-tag date-tag">Uploaded ' + formatDate(g.uploadedAt) + '</span>';
    return tags;
  }

  // Top-level rows on a person/hook/team board (Actor, Writer, Editor, Hook Type,
  // Collaborators) represent a person or category, not one creative — so tags like
  // "Writer: zeke" picked from just one of their many ads would be misleading. Those role
  // tags only make sense once you drill into a specific creative (via subRowHtml), so the
  // top-level row just shows a most-recent-upload date alongside the stats.
  function personMetaTags(g) {
    return g.uploadedAt ? '<span class="tag dim-tag date-tag">Most recent: ' + formatDate(g.uploadedAt) + '</span>' : '';
  }

  function pct(n) { return n.toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%'; }

  // Profit contribution = this entry's share of total profit across every currently-filtered
  // creative. Leads comes from the Creative Tracker sheet's own accurate Leads column — but
  // that sheet only has all-time totals, no daily breakdown, so it's only shown when no date
  // filter is narrowing the range (otherwise it'd silently show the all-time count as if it
  // were scoped to the selected range).
  function statsHtml(g, totalProfit) {
    const contribution = totalProfit > 0 ? (g.profit / totalProfit) * 100 : null;
    let html = '';
    html += '<span class="tag stat-tag">Profit contribution: ' + (contribution != null ? pct(contribution) : '&mdash;') + '</span>';
    if (state.range.key === 'all') {
      html += '<span class="tag stat-tag stat-tag--cost">Leads: ' + g.leadsAllTime.toLocaleString('en-US') + '</span>';
    }
    return html;
  }

  // Compact "23 ads · $1.2M spend · $1.7M revenue · +$458K profit · 1.37x ROAS" summary line.
  // The Spend/Revenue/Profit/ROAS mini-table shown beside the main sort value on every row.
  // Skips whichever metric the big colored figure to the right is already showing (the
  // active sort field), so the same number never appears twice on the same row.
  // Labeled Spend/Revenue/Profit/ROAS columns — this is the row's only figure display, so
  // Profit is never duplicated elsewhere (no separate colored number floating beside it).
  function figsTableHtml(g) {
    const active = (f) => (state.sortBy === f ? ' figs-col--active' : '');
    return (
      '<div class="figs-table">' +
        '<div class="figs-col' + active('spend') + '"><div class="figs-label">Spend</div><div class="figs-value">' + money(g.spend) + '</div></div>' +
        '<div class="figs-col' + active('revenue') + '"><div class="figs-label">Revenue</div><div class="figs-value">' + money(g.revenue) + '</div></div>' +
        '<div class="figs-col' + active('profit') + '"><div class="figs-label">Profit</div><div class="figs-value ' + (g.profit >= 0 ? 'profit-pos' : 'profit-neg') + '">' + moneySigned(g.profit) + '</div></div>' +
        '<div class="figs-col"><div class="figs-label">ROAS</div><div class="figs-value">' + roasOf(g).toFixed(2) + '&times;</div></div>' +
      '</div>'
    );
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
  function adActiveDot(adId) {
    return activeAdIdsToday.has(adId) ? '<span class="active-dot" title="Spent today"></span>' : '';
  }
  function creativeActiveDot(ads) {
    return ads && ads.some((ad) => activeAdIdsToday.has(ad.adId)) ? '<span class="active-dot" title="Spent today"></span>' : '';
  }

  // Lets the video panel show "other ads using this video" without re-plumbing the ad list
  // through every call site — keyed by fileName. Populated exactly once per render (see
  // render()) from the full, unfiltered per-creative ad list, never from a board-narrowed
  // subset — a person/hook/team board's drilldown only ever sees the ads credited to that one
  // person within a creative, and letting that overwrite this registry previously caused the
  // panel to show a random person's slice of ads instead of the creative's true full list.
  const groupAdsRegistry = new Map();
  // Same idea, but for a person/hook/team category (e.g. "actor::Ron") — the list of distinct
  // creatives that category is credited on, so clicking that category row can open the panel
  // directly (its top creative playing) instead of dropping an inline list down the page.
  const categoryCreativesRegistry = new Map();

  function adsTableHtml(ads) {
    return (
      '<div class="table-scroll">' +
        '<table>' +
          '<thead><tr><th></th><th>Ad Name</th><th class="num-col">Spend</th><th class="num-col">Revenue</th><th class="num-col">Profit</th><th class="num-col">ROAS</th><th>Assets</th></tr></thead>' +
          '<tbody>' + ads.map((ad) => detailRowHtml(ad, ads[0].fileName)).join('') + '</tbody>' +
        '</table>' +
      '</div>'
    );
  }

  // A person/hook/team entry (Actor, Writer, Editor, Hook Type, Collaborators) expands one
  // level into the distinct creatives they're credited on — each showing who else worked on
  // it — rather than straight into a flat ad list; opening one of those creatives is what
  // reveals its actual running ads. "All Creatives" and "New Creatives" are already grouped
  // by video, so they skip straight to the ad list.
  function rowThumbHtml(g) {
    const ytId = youtubeId(g.youtubeUrl);
    const roas = roasOf(g);
    return '<div class="row-thumb-slot">' + (
      ytId
        ? '<button class="ad-thumb" data-yt-id="' + escapeHtml(ytId) + '" data-ad-name="' + escapeHtml(g.name || '') + '"' +
            ' data-spend="' + g.spend + '" data-revenue="' + g.revenue + '" data-profit="' + g.profit + '" data-roas="' + roas + '"' +
            ' data-group-key="' + escapeHtml(g.name || '') + '"' +
            ' title="Play video">' +
            '<img src="https://img.youtube.com/vi/' + escapeHtml(ytId) + '/mqdefault.jpg" alt="" loading="lazy">' +
            '<span class="ad-thumb-play">&#9658;</span>' +
          '</button>'
        : ''
    ) + '</div>';
  }

  function subRowHtml(parentKey, cg, totalProfit) {
    const subKey = parentKey + '::fileName::' + cg.name;
    return (
      '<div class="dimension-entry">' +
        '<div class="dimension-row dimension-row--sub' + (state.openGroupKey === cg.name ? ' row-active' : '') + '" data-key="' + escapeHtml(subKey) + '" data-creative="1" data-group-key="' + escapeHtml(cg.name) + '">' +
          rowThumbHtml(cg) +
          '<div>' +
            '<div class="dimension-name">' + creativeActiveDot(cg.ads) + escapeHtml(cg.name) + '</div>' +
            '<div class="dimension-count">' + cg.count + ' ' + (cg.count === 1 ? 'ad' : 'ads') + '</div>' +
            '<div class="dimension-meta">' + peopleTags(state.board, cg) + '</div>' +
            '<div class="dimension-stats">' + secondaryTags(state.board, cg) + statsHtml(cg, totalProfit) + '</div>' +
          '</div>' +
          '<div class="dimension-figs">' + figsTableHtml(cg) + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function expandHtml(g, key, totalProfit) {
    if (state.board === 'fileName' || state.board === 'new' || state.board === 'active') {
      return '<div class="dimension-expand">' + adsTableHtml(g.ads) + '</div>';
    }
    const creatives = aggregateByDimension(g.ads, 'fileName');
    return '<div class="dimension-expand dimension-expand--nested">' + creatives.map((cg) => subRowHtml(key, cg, totalProfit)).join('') + '</div>';
  }

  function dimensionRowHtml(field, g, idx, maxAbs, totalProfit) {
    const val = g[state.sortBy];
    const isPos = val >= 0;
    const isTop = idx === 0 && isPos;
    const pct = maxAbs > 0 ? Math.max(4, Math.round((Math.abs(val) / maxAbs) * 100)) : 4;
    const key = state.board + '::' + g.name;
    const isCreative = field === 'fileName';
    const isActive = (isCreative && state.openGroupKey === g.name) || (!isCreative && state.openCategoryKey === key);
    return (
      '<div class="dimension-entry">' +
        '<div class="dimension-row' + (isTop ? ' dimension-row--top' : '') + (isActive ? ' row-active' : '') + '"' +
          (isCreative ? ' data-creative="1" data-group-key="' + escapeHtml(g.name) + '"' : ' data-category="1" data-category-key="' + escapeHtml(key) + '"') + '>' +
          rankMarkup(idx, isTop) +
          '<div>' +
            '<div class="dimension-name dimension-name-clickable">' + creativeActiveDot(g.ads) + escapeHtml(g.name) +
              (isTop ? '<span class="top-badge">' + TOP_LABELS[state.board] + '</span>' : '') +
            '</div>' +
            '<div class="dimension-count">' + g.count + ' ' + (g.count === 1 ? 'ad' : 'ads') + '</div>' +
            '<div class="dimension-meta">' + (field === 'fileName' ? peopleTags(field, g) : '') + '</div>' +
            '<div class="dimension-stats">' + (field === 'fileName' ? secondaryTags(field, g) : personMetaTags(g)) + statsHtml(g, totalProfit) + '</div>' +
          '</div>' +
          '<div class="dimension-figs">' + figsTableHtml(g) + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function newRowHtml(g, idx, maxAbs, totalProfit) {
    const showMetric = state.sortBy !== 'date';
    const val = showMetric ? g[state.sortBy] : 0;
    const isPos = val >= 0;
    const isTop = idx === 0 && showMetric && isPos;
    const pct = showMetric && maxAbs > 0 ? Math.max(4, Math.round((Math.abs(val) / maxAbs) * 100)) : 0;
    const key = state.board + '::' + g.name;
    const isOpen = state.expanded.has(key);
    return (
      '<div class="dimension-entry">' +
        '<div class="dimension-row' + (isTop ? ' dimension-row--top' : '') + (state.openGroupKey === g.name ? ' row-active' : '') + '" data-key="' + escapeHtml(key) + '" data-creative="1" data-group-key="' + escapeHtml(g.name) + '">' +
          rankMarkup(idx, isTop) +
          '<div>' +
            '<div class="dimension-name dimension-name-clickable">' + creativeActiveDot(g.ads) + escapeHtml(g.name) +
              (isTop ? '<span class="top-badge">' + TOP_LABELS[state.board] + '</span>' : '') +
            '</div>' +
            '<div class="dimension-count">' + g.count + ' ' + (g.count === 1 ? 'ad' : 'ads') + '</div>' +
            '<div class="dimension-meta">' + peopleTags('fileName', g) + '</div>' +
            '<div class="dimension-stats">' + secondaryTags('fileName', g, !showMetric) + statsHtml(g, totalProfit) + '</div>' +
          '</div>' +
          '<div class="dimension-figs">' +
            (showMetric
              ? figsTableHtml(g)
              : '<span class="tag dim-tag date-tag">Uploaded ' + formatDate(g.uploadedAt) + '</span>') +
          '</div>' +
        '</div>' +
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

  function roasOf(g) { return g.spend > 0 ? g.revenue / g.spend : 0; }

  // A flat, spreadsheet-style alternative to the card rows — same underlying groups, just
  // laid out as sortable-by-eye columns instead of stacked tags. Person/hook/team boards
  // suppress the Actor/Writer/Editor/Hook columns for the same reason the cards do: those
  // values are picked from just one of many ads and would misrepresent the whole entry.
  function tableHtml(field, groups, totalProfit, dateColLabel) {
    const showPeople = field === 'fileName';
    const showLeads = state.range.key === 'all';
    const numCols = ['Ads', 'Spend', 'Revenue', 'Profit', 'ROAS', 'Contribution', 'Leads'];
    const cols = ['#', 'Name'];
    if (showPeople) cols.push('Actor', 'Writer', 'Editor', 'Hook');
    cols.push('Ads', 'Spend', 'Revenue', 'Profit', 'ROAS', 'Contribution');
    if (showLeads) cols.push('Leads');
    cols.push(dateColLabel);

    const thead = '<thead><tr>' + cols.map((c) => '<th' + (numCols.includes(c) ? ' class="num-col"' : '') + '>' + c + '</th>').join('') + '</tr></thead>';

    const bodyRows = groups.map((g, i) => {
      const contribution = totalProfit > 0 ? (g.profit / totalProfit) * 100 : null;
      const key = state.board + '::' + g.name;
      const isCreative = field === 'fileName';
      const isActive = isCreative ? state.openGroupKey === g.name : state.openCategoryKey === key;
      let cells = '<td class="num-col">' + (i + 1) + '</td>';
      cells += '<td class="name-cell">' + creativeActiveDot(g.ads) + escapeHtml(g.name) + '</td>';
      if (showPeople) {
        cells += '<td>' + (g.actor ? escapeHtml(g.actor) : '&mdash;') + '</td>';
        cells += '<td>' + (g.writer ? escapeHtml(g.writer) : '&mdash;') + '</td>';
        cells += '<td>' + (g.editor ? escapeHtml(g.editor) : '&mdash;') + '</td>';
        cells += '<td>' + (g.hookType ? escapeHtml(g.hookType) : '&mdash;') + '</td>';
      }
      cells += '<td class="num-col">' + g.count + '</td>';
      cells += '<td class="num-col">' + money(g.spend) + '</td>';
      cells += '<td class="num-col">' + money(g.revenue) + '</td>';
      cells += '<td class="num-col ' + (g.profit >= 0 ? 'profit-pos' : 'profit-neg') + '">' + moneySigned(g.profit) + '</td>';
      cells += '<td class="num-col">' + roasOf(g).toFixed(2) + '&times;</td>';
      cells += '<td class="num-col">' + (contribution != null ? pct(contribution) : '&mdash;') + '</td>';
      if (showLeads) cells += '<td class="num-col">' + g.leadsAllTime.toLocaleString('en-US') + '</td>';
      cells += '<td>' + (g.uploadedAt ? formatDate(g.uploadedAt) : '&mdash;') + '</td>';
      return '<tr class="table-toggle-row' + (isActive ? ' row-active' : '') + '"' +
        (isCreative ? ' data-creative="1" data-group-key="' + escapeHtml(g.name) + '"' : ' data-category="1" data-category-key="' + escapeHtml(key) + '"') +
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

    if (state.board === 'new') {
      const groups = aggregateByDimension(rows, 'fileName')
        .filter((g) => matchesSearch(g.name) && g.uploadedAt)
        .sort((a, b) => (state.sortBy === 'date' ? b.uploadedAt - a.uploadedAt : b[state.sortBy] - a[state.sortBy]));
      const maxAbs = Math.max(1, ...groups.map((g) => Math.abs(g[state.sortBy] || 0)));
      const sortLabel = state.sortBy === 'date' ? 'newest first' : 'sorted by ' + state.sortBy;
      $('#board-count').innerHTML = groups.length + ' ' + (groups.length === 1 ? 'file' : 'files') + ' &middot; ' + sortLabel;
      $('#board-list').innerHTML = !groups.length
        ? emptyMsg('No upload dates tagged yet for this range.')
        : state.viewMode === 'table'
          ? tableHtml('fileName', groups, totalProfit, 'Uploaded')
          : groups.map((g, i) => newRowHtml(g, i, maxAbs, totalProfit)).join('');
      return;
    }

    // "Active Creatives" is All Creatives grouped the same way, just pre-filtered to ads that
    // actually spent on the most recent reported day — i.e. videos genuinely still running
    // right now, not just "had spend at some point in the selected range" (which was nearly
    // every ad under "All time").
    const isActiveBoard = state.board === 'active';
    const sourceRows = isActiveBoard ? rows.filter((r) => activeAdIdsToday.has(r.adId)) : rows;
    const field = isActiveBoard ? 'fileName' : state.board;
    const groups = sortGroups(aggregateByDimension(sourceRows, field).filter((g) => matchesSearch(g.name)));
    if (!isActiveBoard && field !== 'fileName') {
      for (const g of groups) {
        categoryCreativesRegistry.set(state.board + '::' + g.name, aggregateByDimension(g.ads, 'fileName').sort((a, b) => b.profit - a.profit));
      }
    }
    const maxAbs = Math.max(1, ...groups.map((g) => Math.abs(g[state.sortBy])));
    $('#board-count').innerHTML = groups.length + ' ' + (groups.length === 1 ? 'entry' : 'entries') + ' &middot; sorted by ' + state.sortBy;
    $('#board-list').innerHTML = !groups.length
      ? emptyMsg('No ' + (isActiveBoard ? 'currently active ads' : BOARD_LABELS[field].toLowerCase() + ' data') + ' for this range.')
      : state.viewMode === 'table'
        ? tableHtml(field, groups, totalProfit, field === 'fileName' ? 'Uploaded' : 'Most Recent')
        : groups.map((g, i) => dimensionRowHtml(field, g, i, maxAbs, totalProfit)).join('');
  }

  function detailRowHtml(ad, groupKey) {
    const roas = ad.spend > 0 ? ad.revenue / ad.spend : 0;
    const ytId = youtubeId(ad.youtubeUrl);
    return (
      '<tr>' +
        '<td class="thumb-cell">' +
          (ytId
            ? '<button class="ad-thumb" data-yt-id="' + escapeHtml(ytId) + '" data-ad-name="' + escapeHtml(ad.adName || '') + '"' +
                ' data-ad-id="' + escapeHtml(ad.adId || '') + '"' +
                ' data-spend="' + ad.spend + '" data-revenue="' + ad.revenue + '" data-profit="' + ad.profit + '" data-roas="' + roas + '"' +
                ' data-group-key="' + escapeHtml(groupKey || '') + '"' +
                ' title="Play video">' +
                '<img src="https://img.youtube.com/vi/' + escapeHtml(ytId) + '/mqdefault.jpg" alt="" loading="lazy">' +
                '<span class="ad-thumb-play">&#9658;</span>' +
              '</button>'
            : '<span class="ad-thumb ad-thumb--empty">&mdash;</span>') +
        '</td>' +
        '<td class="name-cell" title="' + escapeHtml(ad.adName) + '">' +
          adActiveDot(ad.adId) + escapeHtml(ad.adName || '(untitled)') +
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
    refreshActiveAdIdsToday();
    const totalProfit = rows.reduce((a, r) => a + r.profit, 0);
    // Canonical, single source of truth for "what ads belong to this creative" — always the
    // full unfiltered list for the current date range, regardless of which board is on screen,
    // so the video panel never shows a person- or active-only-filtered slice by accident.
    groupAdsRegistry.clear();
    for (const g of aggregateByDimension(rows, 'fileName')) groupAdsRegistry.set(g.name, g.ads);
    renderBoard(rows, totalProfit);
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

  // ---- table/cards view toggle ----
  $('#view-toggle').addEventListener('click', () => {
    state.viewMode = state.viewMode === 'table' ? 'cards' : 'table';
    const btn = $('#view-toggle');
    btn.classList.toggle('is-active', state.viewMode === 'table');
    btn.title = state.viewMode === 'table' ? 'Switch to card view' : 'Switch to table view';
    $('#view-toggle-label').textContent = state.viewMode === 'table' ? 'Card view' : 'Table view';
    render();
  });

  // ---- search ----
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    render();
  });

  // ---- click a leaderboard row (card view or table view): a creative row plays its top ad
  // directly in the right-hand panel; a category row (Actor/Writer/etc) plays its top
  // creative's top ad and lists that person's other creatives below. Nothing expands inline
  // anywhere anymore. ----
  $('#board-list').addEventListener('click', (e) => {
    if (e.target.closest('.ad-thumb')) return;
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

  // ---- inline video preview: click a thumbnail to watch the ad in a side panel, without
  // leaving or blocking the rest of the leaderboard ----
  // Other ads sharing the same creative — shown as a row of thumbnails under the stats,
  // so switching between variants doesn't require closing the panel and dropping down into
  // the ad table separately.
  // A stacked card per ad (thumb + name on top, full Spend/Revenue/Profit/ROAS figures below)
  // instead of a wide multi-column table — so every figure stays fully readable no matter how
  // narrow the panel is, without needing the panel to grow (which would squeeze the list) or
  // the row to scroll horizontally.
  function variantRowHtml(ad, groupKey, isActive) {
    const roas = ad.spend > 0 ? ad.revenue / ad.spend : 0;
    const ytId = youtubeId(ad.youtubeUrl);
    return (
      '<div class="variant-row' + (isActive ? ' is-active' : '') + '">' +
        '<div class="variant-row-head">' +
          (ytId
            ? '<button class="ad-thumb" data-yt-id="' + escapeHtml(ytId) + '" data-ad-name="' + escapeHtml(ad.adName || '') + '"' +
                ' data-ad-id="' + escapeHtml(ad.adId || '') + '"' +
                ' data-spend="' + ad.spend + '" data-revenue="' + ad.revenue + '" data-profit="' + ad.profit + '" data-roas="' + roas + '"' +
                ' data-group-key="' + escapeHtml(groupKey) + '" title="Play video">' +
                '<img src="https://img.youtube.com/vi/' + escapeHtml(ytId) + '/mqdefault.jpg" alt="" loading="lazy">' +
                '<span class="ad-thumb-play">&#9658;</span>' +
              '</button>'
            : '<span class="ad-thumb ad-thumb--empty">&mdash;</span>') +
          '<div class="variant-row-name">' +
            '<div class="name-cell" title="' + escapeHtml(ad.adName || '') + '">' + adActiveDot(ad.adId) + escapeHtml(ad.adName || '(untitled)') + '</div>' +
            (ad.campaignName ? '<div class="name-sub">' + escapeHtml(ad.campaignName) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div class="figs-table video-panel-figs">' +
          '<div class="figs-col"><div class="figs-label">Spend</div><div class="figs-value">' + money(ad.spend) + '</div></div>' +
          '<div class="figs-col"><div class="figs-label">Revenue</div><div class="figs-value">' + money(ad.revenue) + '</div></div>' +
          '<div class="figs-col"><div class="figs-label">Profit</div><div class="figs-value ' + (ad.profit >= 0 ? 'profit-pos' : 'profit-neg') + '">' + moneySigned(ad.profit) + '</div></div>' +
          '<div class="figs-col"><div class="figs-label">ROAS</div><div class="figs-value">' + roas.toFixed(2) + '&times;</div></div>' +
        '</div>' +
        '<div class="assets-cell">' + (assetIcons(ad) || '<span class="no-assets">&mdash;</span>') + '</div>' +
      '</div>'
    );
  }

  function otherAdsHtml(groupKey, currentAdId) {
    const ads = groupAdsRegistry.get(groupKey);
    if (!ads || !ads.length) return '';
    return (
      '<div class="variant-heading">Ads using this creative</div>' +
      ads.map((ad) => variantRowHtml(ad, groupKey, ad.adId === currentAdId)).join('')
    );
  }

  // Clicking a creative's name (rather than a specific thumbnail) opens its whole ad list in
  // the panel — defaulting the preview to that creative's top-profit ad — instead of dropping
  // an ad table down inline below the row.
  function openCreativePanel(groupKey) {
    const ads = groupAdsRegistry.get(groupKey);
    if (!ads || !ads.length) return;
    const top = ads.find((ad) => youtubeId(ad.youtubeUrl)) || ads[0];
    const roas = top.spend > 0 ? top.revenue / top.spend : 0;
    const ytId = youtubeId(top.youtubeUrl);
    if (!ytId) return;
    openVideoPanel(ytId, top.adName, { spend: top.spend, revenue: top.revenue, profit: top.profit, roas }, groupKey, top.adId);
  }

  // A person/hook/team category row (e.g. "actor::Ron") has no single video of its own — it
  // opens its top-profit creative's top ad, keyed by that creative's fileName so the panel's
  // "Ads using this creative" list works exactly as it does from a direct creative click.
  function openCategoryPanel(categoryKey) {
    const creatives = categoryCreativesRegistry.get(categoryKey);
    if (!creatives || !creatives.length) return;
    state.openCategoryKey = categoryKey;
    const topCreative = creatives.find((cg) => cg.ads.some((ad) => youtubeId(ad.youtubeUrl))) || creatives[0];
    openCreativePanel(topCreative.name);
  }

  let openYtId = null; // guards against a slow /api/views response overwriting a later selection

  // Highlights whichever left-list row matches the creative currently open in the panel,
  // without a full re-render (which would reset scroll position mid-browse). state.openGroupKey
  // is also read by the row-render functions so a later full render (e.g. the 30s data poll)
  // keeps the same row highlighted.
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

  function openVideoPanel(ytId, title, stats, groupKey, adId) {
    openYtId = ytId;
    state.openGroupKey = groupKey || null;
    syncActiveRowHighlight();
    $('#video-panel-embed').innerHTML =
      '<iframe src="https://www.youtube.com/embed/' + ytId + '?rel=0" ' +
      'title="Ad preview" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>';
    $('#video-panel-title').textContent = title || 'Preview';
    $('#video-panel-views').textContent = '';
    // Spend/Revenue/Profit/ROAS for this exact ad already appear on its card in the list below
    // (highlighted as the active one), so nothing needs repeating up here.
    $('#video-panel-body').innerHTML = otherAdsHtml(groupKey, adId);
    $('#video-panel').classList.add('is-open');
    document.body.classList.add('video-panel-open'); // pushes the page over, doesn't cover it
    // Shown right by the title, the way YouTube itself pairs a video's title with its view
    // count, rather than as a separate figure further down the panel.
    fetch('/api/views?id=' + encodeURIComponent(ytId)).then((r) => r.json()).then((d) => {
      if (openYtId !== ytId) return; // panel moved on to a different video before this resolved
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
  function handleThumbClick(e) {
    if (e.target.closest('a')) return; // let YT/LP/Frame.io asset links navigate normally
    const thumb = e.target.closest('.ad-thumb') || e.target.closest('.variant-row')?.querySelector('.ad-thumb');
    if (!thumb || !thumb.dataset.ytId) return;
    e.stopPropagation();
    openVideoPanel(thumb.dataset.ytId, thumb.dataset.adName, {
      spend: Number(thumb.dataset.spend), revenue: Number(thumb.dataset.revenue),
      profit: Number(thumb.dataset.profit), roas: Number(thumb.dataset.roas),
    }, thumb.dataset.groupKey, thumb.dataset.adId);
  }
  $('#board-list').addEventListener('click', handleThumbClick);
  $('#video-panel-body').addEventListener('click', handleThumbClick);
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

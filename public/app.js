(function () {
  const state = {
    dailyRows: [],       // raw: {date, adId, adName, campaignName, platform, spend, revenue}
    updatedAt: null,
    range: { key: 'all', start: null, end: null }, // ISO date strings, inclusive
    search: '',
    platform: 'all',
    sortKey: 'profit',
    sortDir: 'desc',
    board: 'ads', // 'ads' | 'hookType' | 'actor' | 'writer' | 'editor'
  };

  const BOARD_LABELS = { hookType: 'Hook Type', actor: 'Actor', writer: 'Writer', editor: 'Editor' };

  const $ = (sel) => document.querySelector(sel);
  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const moneySigned = (n) => (n < 0 ? '-$' : '+$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

  // ---------------- date helpers (all in local time, ISO YYYY-MM-DD strings) ----------------
  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fromISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(d, n) { const nd = new Date(d); nd.setDate(nd.getDate() + n); return nd; }
  function startOfMonth(y, m) { return new Date(y, m - 1, 1); }
  function endOfMonth(y, m) { return new Date(y, m, 0); }
  // Monday-start week.
  function mondayOf(d) { const day = d.getDay(); const diff = day === 0 ? -6 : 1 - day; return addDays(d, diff); }

  function computeRange(key) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
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

  async function fetchData() {
    try {
      const res = await fetch('/api/data', { cache: 'no-store' });
      const json = await res.json();
      state.dailyRows = json.rows || [];
      state.updatedAt = json.updatedAt;
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
      const t = state.updatedAt ? new Date(state.updatedAt) : new Date();
      text.textContent = 'Live – updated ' + timeAgo(t);
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
          hookType: r.hookType, actor: r.actor, writer: r.writer, editor: r.editor,
        };
        byAd.set(r.adId, c);
      }
      c.spend += r.spend;
      c.revenue += r.revenue;
    }
    return [...byAd.values()].map((c) => ({ ...c, profit: c.revenue - c.spend }));
  }

  function aggregate(rows) {
    const totalSpend = rows.reduce((a, r) => a + r.spend, 0);
    const totalRevenue = rows.reduce((a, r) => a + r.revenue, 0);
    const totalProfit = rows.reduce((a, r) => a + r.profit, 0);
    const profitable = rows.filter((r) => r.profit > 0).length;
    return {
      totalSpend, totalRevenue, totalProfit, profitable,
      total: rows.length,
      roas: totalSpend > 0 ? totalRevenue / totalSpend : 0,
    };
  }

  function renderKpis(agg) {
    $('#creative-count').textContent = agg.total.toLocaleString();
    $('#range-label').textContent = rangeLabel();
    $('#kpi-spend').textContent = money(agg.totalSpend);
    $('#kpi-revenue').textContent = money(agg.totalRevenue);
    const profitEl = $('#kpi-profit');
    profitEl.textContent = moneySigned(agg.totalProfit);
    profitEl.className = 'kpi-value num ' + (agg.totalProfit >= 0 ? 'profit' : 'loss');
    $('#kpi-roas').textContent = agg.roas.toFixed(2) + '×';
    $('#kpi-winrate').textContent = agg.profitable + ' / ' + agg.total;
  }

  function rowItemHtml(r, idx, maxAbs) {
    const isProfit = r.profit >= 0;
    const pct = maxAbs > 0 ? Math.max(4, Math.round((Math.abs(r.profit) / maxAbs) * 100)) : 4;
    return (
      '<div class="row-item row-clickable" data-adname="' + escapeHtml(r.adName) + '">' +
        '<span class="rank">' + String(idx + 1).padStart(2, '0') + '</span>' +
        '<div class="row-main">' +
          '<div class="row-name" title="' + escapeHtml(r.adName) + '">' + escapeHtml(r.adName || '(untitled)') + '</div>' +
          '<div class="row-meta">' + assetIcons(r) + '<span class="row-spend num">' + money(r.spend) + ' spend</span></div>' +
        '</div>' +
        '<div class="row-figs">' +
          '<div class="row-profit ' + (isProfit ? 'profit' : 'loss') + ' num">' + moneySigned(r.profit) + '</div>' +
          '<div class="bar-track"><div class="bar-fill ' + (isProfit ? 'profit' : 'loss') + '" style="width:' + pct + '%"></div></div>' +
        '</div>' +
      '</div>'
    );
  }

  function assetIcons(r) {
    let html = '';
    if (r.youtubeUrl) html += '<a class="asset-link yt" href="' + escapeHtml(r.youtubeUrl) + '" target="_blank" rel="noopener" title="YouTube" onclick="event.stopPropagation()">YT</a>';
    if (r.landingPageUrl) html += '<a class="asset-link lp" href="' + escapeHtml(r.landingPageUrl) + '" target="_blank" rel="noopener" title="Landing page" onclick="event.stopPropagation()">LP</a>';
    if (r.frameIoUrl) html += '<a class="asset-link fio" href="' + escapeHtml(r.frameIoUrl) + '" target="_blank" rel="noopener" title="Frame.io" onclick="event.stopPropagation()">F.io</a>';
    return html;
  }

  function renderRankedPanels(rows) {
    const sorted = [...rows].sort((a, b) => b.profit - a.profit);
    const top = sorted.slice(0, 10);
    const bottom = sorted.slice(-10).reverse();
    const maxTop = Math.max(1, ...top.map((r) => Math.abs(r.profit)));
    const maxBottom = Math.max(1, ...bottom.map((r) => Math.abs(r.profit)));
    $('#top-list').innerHTML = top.map((r, i) => rowItemHtml(r, i, maxTop)).join('') || emptyMsg();
    $('#bottom-list').innerHTML = bottom.map((r, i) => rowItemHtml(r, i, maxBottom)).join('') || emptyMsg();
  }

  // Aggregate ads by a metadata dimension (Hook Type / Actor / Writer / Editor), ranked by profit.
  function aggregateByDimension(rows, field) {
    const byValue = new Map();
    for (const r of rows) {
      const v = (r[field] || '').trim();
      if (!v) continue;
      let g = byValue.get(v);
      if (!g) { g = { name: v, spend: 0, revenue: 0, count: 0 }; byValue.set(v, g); }
      g.spend += r.spend;
      g.revenue += r.revenue;
      g.count += 1;
    }
    return [...byValue.values()]
      .map((g) => ({ ...g, profit: g.revenue - g.spend }))
      .sort((a, b) => b.profit - a.profit);
  }

  function dimensionRowHtml(g, idx, maxAbs) {
    const isProfit = g.profit >= 0;
    const pct = maxAbs > 0 ? Math.max(4, Math.round((Math.abs(g.profit) / maxAbs) * 100)) : 4;
    return (
      '<div class="dimension-row">' +
        '<span class="rank">' + String(idx + 1).padStart(2, '0') + '</span>' +
        '<div>' +
          '<div class="dimension-name">' + escapeHtml(g.name) + '</div>' +
          '<div class="dimension-count">' + g.count + ' ' + (g.count === 1 ? 'ad' : 'ads') + ' &middot; ' + money(g.spend) + ' spend</div>' +
        '</div>' +
        '<div class="dimension-figs">' +
          '<div class="row-profit ' + (isProfit ? 'profit' : 'loss') + ' num">' + moneySigned(g.profit) + '</div>' +
        '</div>' +
        '<div class="dimension-bar-track"><div class="bar-fill ' + (isProfit ? 'profit' : 'loss') + '" style="width:' + pct + '%"></div></div>' +
      '</div>'
    );
  }

  function renderDimensionBoard(rows) {
    const field = state.board;
    const groups = aggregateByDimension(rows, field);
    const maxAbs = Math.max(1, ...groups.map((g) => Math.abs(g.profit)));
    $('#dimension-title').textContent = BOARD_LABELS[field] + ' Leaderboard';
    $('#dimension-count').innerHTML = groups.length + ' ' + (groups.length === 1 ? 'entry' : 'entries') + ' &middot; ranked by profit';
    $('#dimension-list').innerHTML = groups.length
      ? groups.map((g, i) => dimensionRowHtml(g, i, maxAbs)).join('')
      : '<div style="padding:24px 0;color:var(--text-faint);font-size:12.5px;">No ' + BOARD_LABELS[field].toLowerCase() + ' data tagged yet for this range.</div>';
  }

  function emptyMsg() {
    return '<div style="padding:24px 0;color:var(--text-faint);font-size:12.5px;">No data in this range.</div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function applyFilters(rows) {
    let out = rows;
    if (state.search.trim()) {
      const q = state.search.trim().toLowerCase();
      out = out.filter(
        (r) => r.adName.toLowerCase().includes(q) || r.campaignName.toLowerCase().includes(q)
      );
    }
    return out;
  }

  function sortRows(rows) {
    const { sortKey, sortDir } = state;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (sortKey === 'roas') { av = a.spend > 0 ? a.revenue / a.spend : 0; bv = b.spend > 0 ? b.revenue / b.spend : 0; }
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  }

  function renderTable(rows) {
    const filtered = applyFilters(rows);
    const sorted = sortRows(filtered);
    $('#row-count').textContent = sorted.length.toLocaleString() + ' of ' + rows.length.toLocaleString() + ' creatives';

    const body = $('#table-body');
    if (!sorted.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="6">No creatives match your filters.</td></tr>';
      return;
    }
    body.innerHTML = sorted
      .map((r) => {
        const roas = r.spend > 0 ? r.revenue / r.spend : 0;
        return (
          '<tr class="row-clickable" data-adname="' + escapeHtml(r.adName) + '">' +
            '<td class="name-cell" title="' + escapeHtml(r.fileName || r.adName) + '">' + escapeHtml(r.adName || '(untitled)') + '</td>' +
            '<td class="num-col">' + money(r.spend) + '</td>' +
            '<td class="num-col">' + money(r.revenue) + '</td>' +
            '<td class="num-col ' + (r.profit >= 0 ? 'profit-pos' : 'profit-neg') + '">' + moneySigned(r.profit) + '</td>' +
            '<td class="num-col">' + roas.toFixed(2) + '×</td>' +
            '<td class="assets-cell">' + (assetIcons(r) || '<span class="no-assets">&mdash;</span>') + '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function render() {
    const rows = creativesForRange();
    const agg = aggregate(rows);
    renderKpis(agg);
    if (state.board === 'ads') {
      renderRankedPanels(rows);
    } else {
      renderDimensionBoard(rows);
    }
    renderTable(rows);
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
      return; // wait for explicit date input before re-rendering
    }
    customBox.hidden = true;
    const { start, end } = computeRange(key);
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
    $('#ads-board').hidden = state.board !== 'ads';
    $('#dimension-board').hidden = state.board === 'ads';
    render();
  });

  // ---- table controls ----
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    render();
  });

  // Click any ad row (top/bottom panels or table) to filter the table to just that ad.
  document.addEventListener('click', (e) => {
    const row = e.target.closest('.row-clickable');
    if (!row) return;
    const name = row.dataset.adname;
    $('#search').value = name;
    state.search = name;
    document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    render();
  });

  document.querySelectorAll('#data-table thead th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = key === 'adName' || key === 'platform' ? 'asc' : 'desc';
      }
      document.querySelectorAll('#data-table thead th').forEach((h) => {
        h.classList.remove('is-sorted');
        h.removeAttribute('data-dir');
      });
      th.classList.add('is-sorted');
      th.dataset.dir = state.sortDir;
      render();
    });
  });

  // ---- live updates ----
  fetchData();
  setInterval(fetchData, 30000);
  setInterval(() => { if (state.updatedAt) setLive(true); }, 1000);

  try {
    const es = new EventSource('/api/events');
    es.addEventListener('update', fetchData);
    es.onerror = () => setLive(false);
  } catch (err) {
    // SSE unsupported — polling above still keeps data fresh.
  }
})();

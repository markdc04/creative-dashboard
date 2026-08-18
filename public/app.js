(function () {
  const state = {
    rows: [],
    updatedAt: null,
    search: '',
    platform: 'all',
    sortKey: 'profit',
    sortDir: 'desc',
  };

  const $ = (sel) => document.querySelector(sel);
  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const moneySigned = (n) => (n < 0 ? '-$' : '+$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

  async function fetchData() {
    try {
      const res = await fetch('/api/data', { cache: 'no-store' });
      const json = await res.json();
      state.rows = json.rows || [];
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

  function aggregate(rows) {
    const totalSpend = rows.reduce((a, r) => a + r.spend, 0);
    const totalRevenue = rows.reduce((a, r) => a + r.revenue, 0);
    const totalProfit = rows.reduce((a, r) => a + r.profit, 0);
    const profitable = rows.filter((r) => r.profit > 0).length;
    const byPlatform = (name) => {
      const sub = rows.filter((r) => r.platform === name);
      return {
        count: sub.length,
        spend: sub.reduce((a, r) => a + r.spend, 0),
        revenue: sub.reduce((a, r) => a + r.revenue, 0),
        profit: sub.reduce((a, r) => a + r.profit, 0),
      };
    };
    return {
      totalSpend, totalRevenue, totalProfit, profitable,
      total: rows.length,
      roas: totalSpend > 0 ? totalRevenue / totalSpend : 0,
      google: byPlatform('GOOGLE'),
      meta: byPlatform('META'),
    };
  }

  function renderKpis(agg) {
    $('#creative-count').textContent = agg.total.toLocaleString();
    $('#kpi-spend').textContent = money(agg.totalSpend);
    $('#kpi-revenue').textContent = money(agg.totalRevenue);
    const profitEl = $('#kpi-profit');
    profitEl.textContent = moneySigned(agg.totalProfit);
    profitEl.className = 'kpi-value num ' + (agg.totalProfit >= 0 ? 'profit' : 'loss');
    $('#kpi-roas').textContent = agg.roas.toFixed(2) + '×';
    $('#kpi-winrate').textContent = agg.profitable + ' / ' + agg.total;
  }

  function renderPlatforms(agg) {
    const set = (prefix, p) => {
      $('#' + prefix + '-count').textContent = p.count + ' creatives';
      $('#' + prefix + '-spend').textContent = money(p.spend);
      $('#' + prefix + '-revenue').textContent = money(p.revenue);
      const profEl = $('#' + prefix + '-profit');
      profEl.textContent = moneySigned(p.profit);
      profEl.style.color = p.profit >= 0 ? 'var(--profit)' : 'var(--loss)';
      const chip = $('#' + prefix + '-chip');
      if (p.profit >= 0) {
        chip.className = 'status-chip ok';
        chip.textContent = '↑ Profitable';
      } else {
        chip.className = 'status-chip bad';
        chip.textContent = '↓ Losing money';
      }
    };
    set('google', agg.google);
    set('meta', agg.meta);
  }

  function rowItemHtml(r, idx, maxAbs) {
    const isProfit = r.profit >= 0;
    const pct = maxAbs > 0 ? Math.max(4, Math.round((Math.abs(r.profit) / maxAbs) * 100)) : 4;
    return (
      '<div class="row-item">' +
        '<span class="rank">' + String(idx + 1).padStart(2, '0') + '</span>' +
        '<div class="row-main">' +
          '<div class="row-name" title="' + escapeHtml(r.adName) + '">' + escapeHtml(r.adName || '(untitled)') + '</div>' +
          '<div class="row-meta"><span class="tag ' + (r.platform === 'META' ? 'meta' : 'google') + '">' + r.platform + '</span>' +
          '<span class="row-spend num">' + money(r.spend) + ' spend</span></div>' +
        '</div>' +
        '<div class="row-figs">' +
          '<div class="row-profit ' + (isProfit ? 'profit' : 'loss') + ' num">' + moneySigned(r.profit) + '</div>' +
          '<div class="bar-track"><div class="bar-fill ' + (isProfit ? 'profit' : 'loss') + '" style="width:' + pct + '%"></div></div>' +
        '</div>' +
      '</div>'
    );
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

  function emptyMsg() {
    return '<div style="padding:24px 0;color:var(--text-faint);font-size:12.5px;">No data yet.</div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function applyFilters(rows) {
    let out = rows;
    if (state.platform !== 'all') {
      const want = state.platform === 'google' ? 'GOOGLE' : 'META';
      out = out.filter((r) => r.platform === want);
    }
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

  function renderTable() {
    const filtered = applyFilters(state.rows);
    const sorted = sortRows(filtered);
    $('#row-count').textContent = sorted.length.toLocaleString() + ' of ' + state.rows.length.toLocaleString() + ' creatives';

    const body = $('#table-body');
    if (!sorted.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="6">No creatives match your filters.</td></tr>';
      return;
    }
    body.innerHTML = sorted
      .map((r) => {
        const roas = r.spend > 0 ? r.revenue / r.spend : 0;
        return (
          '<tr>' +
            '<td class="name-cell" title="' + escapeHtml(r.adName) + '">' + escapeHtml(r.adName || '(untitled)') + '</td>' +
            '<td><span class="tag ' + (r.platform === 'META' ? 'meta' : 'google') + '">' + r.platform + '</span></td>' +
            '<td class="num-col">' + money(r.spend) + '</td>' +
            '<td class="num-col">' + money(r.revenue) + '</td>' +
            '<td class="num-col ' + (r.profit >= 0 ? 'profit-pos' : 'profit-neg') + '">' + moneySigned(r.profit) + '</td>' +
            '<td class="num-col">' + roas.toFixed(2) + '×</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function render() {
    const agg = aggregate(state.rows);
    renderKpis(agg);
    renderPlatforms(agg);
    renderRankedPanels(state.rows);
    renderTable();
  }

  // ---- controls ----
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderTable();
  });

  $('#platform-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    document.querySelectorAll('#platform-filter .chip').forEach((c) => c.classList.remove('is-active'));
    btn.classList.add('is-active');
    state.platform = btn.dataset.platform;
    renderTable();
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
      renderTable();
    });
  });

  // ---- live updates ----
  fetchData();
  setInterval(fetchData, 15000);
  setInterval(() => { if (state.updatedAt) setLive(true); }, 1000);

  try {
    const es = new EventSource('/api/events');
    es.addEventListener('update', fetchData);
    es.onerror = () => setLive(false);
  } catch (err) {
    // SSE unsupported — polling above still keeps data fresh.
  }
})();

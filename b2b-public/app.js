(function () {
  const $ = (sel) => document.querySelector(sel);

  // ---- date helpers (same math as every other dashboard here) ----
  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(d, n) { const nd = new Date(d); nd.setDate(nd.getDate() + n); return nd; }
  function startOfMonth(y, m) { return new Date(y, m - 1, 1); }
  function endOfMonth(y, m) { return new Date(y, m, 0); }
  function mondayOf(d) { const day = d.getDay(); const diff = day === 0 ? -6 : 1 - day; return addDays(d, diff); }
  function weekLabel(monday) {
    const sunday = addDays(monday, 6);
    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return fmt(monday) + ' - ' + fmt(sunday);
  }
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
      case 'wtd': return { start: toISO(mondayOf(today)), end: toISO(addDays(today, -1)) };
      case 'lastweek': { const lastMon = addDays(mondayOf(today), -7); const lastSun = addDays(lastMon, 6); return { start: toISO(lastMon), end: toISO(lastSun) }; }
      default: {
        const m = /^(\d{4})-(\d{2})$/.exec(key);
        if (m) { const y = Number(m[1]), mo = Number(m[2]); return { start: toISO(startOfMonth(y, mo)), end: toISO(endOfMonth(y, mo)) }; }
        return { start: null, end: null };
      }
    }
  }
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

  function fmtMoney(n) { const sign = n < 0 ? '-' : ''; return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const state = { range: { key: 'yesterday', start: null, end: null }, leads: [], adSpendDaily: [], adSpendByAdNameDaily: [], ads: [], openAd: null,
    // Click-to-filter: kind is 'qualified' or 'won' (from the KPI tiles); the rest are exact values
    // picked by clicking an ad row or a cell in the Leads table.
    filters: { kind: null, ad: null, stage: null, status: null, state: null, source: null } };
  const FILTER_LABELS = { ad: 'Ad', stage: 'Stage', status: 'Status', state: 'State', source: 'Contact Source' };
  const FIELD_OF = { ad: 'utmContent', stage: 'stage', status: 'status', state: 'state', source: 'source' };

  function inRange(dateStr) {
    if (state.range.start && dateStr < state.range.start) return false;
    if (state.range.end && dateStr > state.range.end) return false;
    return true;
  }
  function mdy(iso) { const [y, m, d] = (iso || '').split('-'); return y ? m + '/' + d + '/' + y : ''; }
  function shortMd(iso) { const [, m, d] = (iso || '').split('-'); return m ? Number(m) + '/' + Number(d) : ''; }

  async function fetchData() {
    const r = await fetch('/b2b-api/data', { cache: 'no-store' });
    const json = await r.json();
    state.leads = json.leads || [];
    state.adSpendDaily = json.adSpendDaily || [];
    state.adSpendByAdNameDaily = json.adSpendByAdNameDaily || [];
    state.ads = json.ads || [];
    renderAll();
    if (state.openAd) openAdPanel(state.openAd, state.openPost); // keep the panel's numbers current
  }

  // The posts an ad name ran as within the picked dates, biggest spend first — one ad name can run
  // as several posts (different Ad IDs, or Meta and X). Falls back to its most recent post overall.
  function postsFor(adName) {
    const byPost = new Map();
    for (const a of state.ads) {
      if (a.adName !== adName || !inRange(a.date)) continue;
      const key = a.instagramUrl || a.mediaUrl || a.postUrl || a.tweetUrl;
      const cur = byPost.get(key) || { ...a, spend: 0 };
      cur.spend += a.spend;
      byPost.set(key, cur);
    }
    const posts = [...byPost.values()].sort((a, b) => b.spend - a.spend);
    if (posts.length) return posts;
    const latest = state.ads.filter((a) => a.adName === adName).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    return latest ? [latest] : [];
  }
  const postKey = (p) => p && (p.instagramUrl || p.mediaUrl || p.postUrl || p.tweetUrl);
  const postUrl = (p) => p && (p.instagramUrl || p.tweetUrl || p.postUrl || p.mediaUrl);

  function rangeTitle() {
    const { key, start, end } = state.range;
    const opt = document.querySelector('#quick-range option[value="' + key + '"]');
    const label = key && opt ? opt.textContent : 'Custom range';
    if (!start && !end) return 'B2B (' + label + ') Report';
    const dates = start === end ? shortMd(start) : shortMd(start) + ' – ' + shortMd(end);
    return 'B2B (' + label + ') Report: ' + dates;
  }

  // Closed deals are leads at the "Won (Payment Recieved)" stage in GHL. The synced tab has no
  // deal-value column, so each won deal's value is listed here by lead name (lowercase) until
  // one is synced from GHL — a won deal missing from this list counts as a closed deal with $0.
  const DEAL_VALUES = { 'ruy mireles': 25000 };
  const isQualified = (l) => /^qualified$/i.test(l.status || '');
  const isWon = (l) => /^won\b/i.test(l.stage || '');
  const dealValue = (l) => DEAL_VALUES[(l.name || '').trim().toLowerCase()] || 0;

  // Leads matching every active filter except `skip`. Leads are dated by their lead date; with the
  // Closed Deals filter on, won deals are dated by their Close Date instead (same as the tile).
  function filteredLeads(skip) {
    const f = state.filters;
    return state.leads.filter((l) => {
      const kind = skip === 'kind' ? null : f.kind;
      if (kind === 'won') { if (!isWon(l) || !inRange(l.closeDate || l.date)) return false; }
      else if (!inRange(l.date)) return false;
      if (kind === 'qualified' && !isQualified(l)) return false;
      for (const k of Object.keys(FIELD_OF)) {
        if (k === skip || !f[k]) continue;
        if ((l[FIELD_OF[k]] || '') !== f[k]) return false;
      }
      return true;
    });
  }
  const anyFilter = () => Object.values(state.filters).some(Boolean);
  function setFilter(key, value) {
    state.filters[key] = state.filters[key] === value ? null : value; // clicking the same thing again clears it
    renderAll();
  }

  function renderFilterBar() {
    const f = state.filters;
    const chips = [];
    if (f.kind) chips.push(['kind', f.kind === 'won' ? 'Closed deals' : 'Qualified leads']);
    for (const k of Object.keys(FIELD_OF)) if (f[k]) chips.push([k, FILTER_LABELS[k] + ': ' + f[k]]);
    const bar = $('#filter-bar');
    bar.hidden = !chips.length;
    bar.innerHTML = chips.length ? '<span class="filter-bar-label">Filtered by</span>' +
      chips.map(([k, label]) => '<button class="filter-chip" data-clear="' + k + '">' + escapeHtml(label) + ' <span>&times;</span></button>').join('') +
      '<button class="filter-clear-all" data-clear="all">Clear all</button>' : '';
  }

  function renderAll() {
    const f = state.filters;
    // The tiles reflect every filter except Qualified/Closed (those pick which tile is selected).
    const leads = filteredLeads('kind');
    const spendRows = state.adSpendByAdNameDaily.filter((r) => inRange(r.date) && (!f.ad || r.adName === f.ad));
    const totalSpend = f.ad ? spendRows.reduce((s, r) => s + r.spend, 0) : state.adSpendDaily.filter((d) => inRange(d.date)).reduce((s, d) => s + d.spend, 0);
    const cpl = leads.length ? totalSpend / leads.length : 0;
    const qualified = leads.filter(isQualified).length;
    // A won deal lands on its Close Date (when it was actually closed), falling back to the lead's
    // own date only when no close date has been entered yet.
    const won = state.filters.kind === 'won' ? filteredLeads() : (() => { const k = f.kind; f.kind = 'won'; const w = filteredLeads(); f.kind = k; return w; })();
    const revenue = won.reduce((s, l) => s + dealValue(l), 0);
    const tile = ([label, value, sub, kind]) => {
      const selected = kind !== undefined && (kind ? f.kind === kind : false);
      return '<div class="kpi kpi--highlight' + (kind !== undefined ? ' is-clickable' : '') + (selected ? ' is-selected' : '') + '"' + (kind !== undefined ? ' data-kind="' + kind + '" title="' + (kind ? 'Click to filter by this' : 'Click to show all leads') + '"' : '') + '><div class="kpi-label">' + label + '</div><div class="kpi-value num">' + value + '</div>' + (sub ? '<div class="kpi-sub">' + escapeHtml(sub) + '</div>' : '') + '</div>';
    };
    $('#report-title').textContent = rangeTitle();
    renderFilterBar();
    $('#b2b-kpis').innerHTML = [
      ['Leads', fmtInt(leads.length), '', ''],
      ['Ad Spent', fmtMoney(totalSpend), f.ad ? 'this ad only' : ''],
      ['CPL', leads.length ? fmtMoney(cpl) : '—'],
    ].map(tile).join('');
    $('#b2b-kpis-2').innerHTML = [
      ['Qualified Leads', fmtInt(qualified), 'leads with Status “Qualified”', 'qualified'],
      ['Cost / Qualified Lead', qualified ? fmtMoney(totalSpend / qualified) : '—', 'ad spent ÷ qualified leads', 'qualified'],
      ['Closed Deals', fmtInt(won.length), won.length ? won.map((l) => (l.firmName || l.name) + (l.closeDate ? ' · closed ' + shortMd(l.closeDate) : '')).join(', ') : 'stage “Won (Payment Received)”', 'won'],
      ['Revenue', fmtMoney(revenue), 'value of the closed deals', 'won'],
    ].map(tile).join('');
    renderAds(filteredLeads('ad'));
    renderLeadDetail();
  }

  // Ad name (UTM Content on the lead) joins to the spend sheets' Ad Name — see b2b.js.
  function adRows(leads) {
    const spendByName = new Map();
    state.adSpendByAdNameDaily.filter((r) => inRange(r.date)).forEach((r) => spendByName.set(r.adName, (spendByName.get(r.adName) || 0) + r.spend));
    const leadsByName = new Map();
    leads.forEach((l) => { if (l.utmContent) leadsByName.set(l.utmContent, (leadsByName.get(l.utmContent) || 0) + 1); });
    return [...new Set([...spendByName.keys(), ...leadsByName.keys()])].map((adName) => {
      const n = leadsByName.get(adName) || 0, spend = spendByName.get(adName) || 0;
      return { adName, leads: n, spend, cpl: n ? spend / n : 0 };
    }).filter((r) => r.leads > 0 || r.spend > 0).sort((a, b) => b.leads - a.leads || b.spend - a.spend);
  }

  function renderAds(leads) {
    const rows = adRows(leads);
    $('#ads-sub').textContent = rows.length ? rows.length + ' ad' + (rows.length === 1 ? '' : 's') : '';
    if (!rows.length) { $('#b2b-ads').innerHTML = '<p class="empty-msg">No ad spend or leads in this range.</p>'; return; }
    $('#b2b-ads').innerHTML = '<table><thead><tr><th>Ad Name</th><th class="th-num">Leads</th><th class="th-num">Spend</th><th class="th-num">Cost/Lead</th><th>Links</th></tr></thead><tbody>' +
      rows.map((r) => {
        const top = postsFor(r.adName)[0];
        const url = postUrl(top);
        return '<tr class="is-clickable' + (state.filters.ad === r.adName ? ' is-selected' : '') + '" data-filter-ad="' + escapeHtml(r.adName) + '" title="Click to filter everything by this ad">' +
          '<td class="name-cell">' + escapeHtml(r.adName) + '</td>' +
          '<td class="td-num num">' + fmtInt(r.leads) + '</td>' +
          '<td class="td-num num">' + fmtMoney(r.spend) + '</td>' +
          '<td class="td-num num">' + (r.leads ? fmtMoney(r.cpl) : '—') + '</td>' +
          '<td>' + (url ? '<button class="ad-link" data-ad="' + escapeHtml(r.adName) + '" title="Preview">' + escapeHtml(url) + '</button>' +
            '<a class="ad-ext" href="' + escapeHtml(url) + '" target="_blank" rel="noopener" title="Open in a new tab">&#8599;</a>' : '<span class="muted">—</span>') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderLeadDetail() {
    const won = state.filters.kind === 'won';
    const dateOf = (l) => (won ? l.closeDate || l.date : l.date);
    const filtered = filteredLeads().sort((a, b) => (dateOf(a) < dateOf(b) ? 1 : -1));
    const term = ($('#lead-search').value || '').trim().toLowerCase();
    const searched = term ? filtered.filter((l) => [l.name, l.firmName, l.state, l.source, l.utmContent, l.stage, l.status].join(' ').toLowerCase().includes(term)) : filtered;
    $('#lead-count').textContent = searched.length.toLocaleString() + ' lead' + (searched.length === 1 ? '' : 's') + (term ? ' (filtered from ' + filtered.length.toLocaleString() + ')' : '') + (anyFilter() ? ' · click a cell to filter by it' : ' · click an ad, stage, status, state or source to filter by it');
    $('#leads-empty').hidden = searched.length > 0;
    // Clickable cells filter the whole page by that value (clicking it again clears the filter).
    const cell = (key, v) => v ? '<button class="cell-filter' + (state.filters[key] === v ? ' is-on' : '') + '" data-filter-' + key + '="' + escapeHtml(v) + '">' + escapeHtml(v) + '</button>' : '';
    $('#lead-detail-body').innerHTML = searched.slice(0, 500).map((l) =>
      '<tr><td>' + escapeHtml(mdy(dateOf(l))) + '</td>' +
      '<td>' + escapeHtml(l.name) + '</td>' +
      '<td>' + escapeHtml(l.firmName) + '</td>' +
      '<td>' + cell('state', l.state) + '</td>' +
      '<td>' + cell('source', l.source) + '</td>' +
      '<td>' + cell('ad', l.utmContent) + '</td>' +
      '<td>' + cell('stage', l.stage) + '</td>' +
      '<td>' + cell('status', l.status) + '</td></tr>'
    ).join('');
    $('#lead-date-th').textContent = won ? 'Close Date' : 'Date';
  }

  // ---- side preview panel (same behavior as the Creative Dashboard's video panel) ----
  function embedHtml(p) {
    if (!p) return '';
    const ig = /instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/.exec(p.instagramUrl || '');
    if (ig) return '<iframe src="https://www.instagram.com/' + ig[1] + '/' + ig[2] + '/embed/" allowfullscreen scrolling="no" loading="lazy"></iframe>';
    if (p.mediaUrl && /\.mp4(\?|$)|video\.twimg\.com/i.test(p.mediaUrl)) return '<video src="' + escapeHtml(p.mediaUrl) + '" controls autoplay playsinline' + (p.thumbUrl ? ' poster="' + escapeHtml(p.thumbUrl) + '"' : '') + '></video>';
    if (p.mediaUrl) return '<img src="' + escapeHtml(p.mediaUrl) + '" alt="">';
    if (p.postUrl) return '<iframe src="https://www.facebook.com/plugins/post.php?href=' + encodeURIComponent(p.postUrl) + '&show_text=true&width=500" scrolling="no" loading="lazy"></iframe>';
    return '';
  }

  function openAdPanel(adName, wantedKey) {
    const posts = postsFor(adName);
    const post = posts.find((p) => postKey(p) === wantedKey) || posts[0];
    const playing = postKey(post);
    if (state.openAd !== adName || state.openPost !== playing || !$('#video-panel').classList.contains('is-open')) {
      $('#video-panel-embed').innerHTML = embedHtml(post);
    }
    state.openAd = adName;
    state.openPost = playing;
    const leads = state.leads.filter((l) => inRange(l.date) && l.utmContent === adName).sort((a, b) => (a.date < b.date ? 1 : -1));
    const spend = state.adSpendByAdNameDaily.filter((r) => inRange(r.date) && r.adName === adName).reduce((s, r) => s + r.spend, 0);
    $('#video-panel-title').textContent = adName;
    $('#video-panel-sub').textContent = (post ? post.platform + ' ad' : 'No preview link') + ' · ' + rangeTitle().replace(/^B2B \((.*)\) Report:?\s*/, '$1 ');
    const links = [];
    if (post && post.instagramUrl) links.push(['Instagram', post.instagramUrl]);
    if (post && post.postUrl) links.push(['Facebook post', post.postUrl]);
    if (post && post.tweetUrl) links.push(['Tweet', post.tweetUrl]);
    if (post && post.mediaUrl && !post.instagramUrl) links.push(['Media file', post.mediaUrl]);
    $('#video-panel-body').innerHTML =
      '<div class="panel-figs">' +
        '<div class="panel-fig"><div class="panel-fig-label">Leads</div><div class="panel-fig-value num">' + fmtInt(leads.length) + '</div></div>' +
        '<div class="panel-fig"><div class="panel-fig-label">Spend</div><div class="panel-fig-value num">' + fmtMoney(spend) + '</div></div>' +
        '<div class="panel-fig"><div class="panel-fig-label">Cost/Lead</div><div class="panel-fig-value num">' + (leads.length ? fmtMoney(spend / leads.length) : '—') + '</div></div>' +
      '</div>' +
      (links.length ? '<div class="panel-links">' + links.map(([label, url]) => '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + label + ' &#8599;</a>').join('') + '</div>' : '') +
      (posts.length > 1 ? '<div class="panel-section-title">Posts running under this ad name</div><ul class="panel-list">' +
        posts.map((p) => '<li><button data-ad="' + escapeHtml(adName) + '" data-post="' + escapeHtml(postKey(p)) + '">' + escapeHtml(postUrl(p)) + (postKey(p) === playing ? ' (showing)' : '') + '</button><span class="num">' + fmtMoney(p.spend || 0) + '</span></li>').join('') + '</ul>' : '') +
      '<div class="panel-section-title">Leads from this ad</div>' +
      (leads.length ? '<ul class="panel-list">' + leads.map((l) => '<li><span>' + escapeHtml(l.name) + (l.firmName ? ' <span class="muted">· ' + escapeHtml(l.firmName) + '</span>' : '') + '</span><span class="muted">' + escapeHtml(l.stage || mdy(l.date)) + '</span></li>').join('') + '</ul>' : '<p class="muted" style="font-size:12.5px;margin:0">No leads from this ad in this range.</p>');
    $('#video-panel').classList.add('is-open');
    $('#video-panel').setAttribute('aria-hidden', 'false');
    document.body.classList.add('video-panel-open');
  }
  function closeAdPanel() {
    state.openAd = null;
    state.openPost = null;
    $('#video-panel').classList.remove('is-open');
    $('#video-panel').setAttribute('aria-hidden', 'true');
    $('#video-panel-embed').innerHTML = ''; // clear so playback actually stops
    $('#video-panel-body').innerHTML = '';
    document.body.classList.remove('video-panel-open');
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('.ad-ext, .panel-links a')) return; // real links open in a new tab
    const postBtn = e.target.closest('#video-panel-body button[data-post]');
    if (postBtn) { openAdPanel(postBtn.dataset.ad, postBtn.dataset.post); return; }
    const adEl = e.target.closest('[data-ad]');
    if (adEl && !adEl.closest('#video-panel')) { e.preventDefault(); e.stopPropagation(); openAdPanel(adEl.dataset.ad); return; }
    const clear = e.target.closest('[data-clear]');
    if (clear) {
      const k = clear.dataset.clear;
      if (k === 'all') Object.keys(state.filters).forEach((x) => { state.filters[x] = null; }); else state.filters[k] = null;
      renderAll();
      return;
    }
    const kpi = e.target.closest('.kpi[data-kind]');
    if (kpi) {
      if (!kpi.dataset.kind) { state.filters.kind = null; renderAll(); } else setFilter('kind', kpi.dataset.kind);
      return;
    }
    // An ad row or any filterable cell: data-filter-<key>="value".
    const fEl = e.target.closest('[data-filter-ad],[data-filter-stage],[data-filter-status],[data-filter-state],[data-filter-source]');
    if (fEl) {
      const key = Object.keys(FIELD_OF).find((k) => fEl.hasAttribute('data-filter-' + k));
      setFilter(key, fEl.getAttribute('data-filter-' + key));
      // Picking an ad also opens its preview, like before.
      if (key === 'ad' && state.filters.ad && fEl.closest('#b2b-ads') && postsFor(state.filters.ad).length) openAdPanel(state.filters.ad);
    }
  });

  // Leads table full screen.
  function setLeadsFull(on) {
    $('#leads-panel').classList.toggle('is-fullscreen', on);
    document.body.classList.toggle('leads-full-open', on);
    $('#leads-expand').innerHTML = on
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
    $('#leads-expand').title = on ? 'Exit full screen' : 'Full screen';
  }
  $('#leads-expand').addEventListener('click', () => setLeadsFull(!$('#leads-panel').classList.contains('is-fullscreen')));
  $('#video-panel-close').addEventListener('click', closeAdPanel);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#leads-panel').classList.contains('is-fullscreen')) setLeadsFull(false);
    else if (state.openAd) closeAdPanel();
  });

  $('#lead-search').addEventListener('input', renderLeadDetail);
  $('#quick-range').addEventListener('change', (e) => {
    const { start, end } = computeRange(e.target.value);
    state.range = { key: e.target.value, start, end };
    $('#range-start').value = start || '';
    $('#range-end').value = end || '';
    renderAll();
  });
  function applyCustomRange() {
    const start = $('#range-start').value || null, end = $('#range-end').value || null;
    if (!start && !end) return;
    state.range = { key: '', start, end };
    $('#quick-range').value = '';
    renderAll();
  }
  $('#range-start').addEventListener('change', applyCustomRange);
  $('#range-end').addEventListener('change', applyCustomRange);
  $('#range-clear').addEventListener('click', () => {
    const key = $('#quick-range').value || 'yesterday';
    const { start, end } = computeRange(key);
    state.range = { key, start, end };
    $('#quick-range').value = key;
    $('#range-start').value = start || '';
    $('#range-end').value = end || '';
    renderAll();
  });
  $('#refresh-btn').addEventListener('click', () => {
    $('#refresh-btn').classList.add('is-spinning');
    fetchData().finally(() => setTimeout(() => $('#refresh-btn').classList.remove('is-spinning'), 400));
  });

  buildQuickRangeOptions(2026, 1);
  const defaultKey = 'yesterday';
  const initial = computeRange(defaultKey);
  state.range = { key: defaultKey, ...initial };
  $('#quick-range').value = defaultKey;
  $('#range-start').value = initial.start || '';
  $('#range-end').value = initial.end || '';

  fetchData();
  setInterval(fetchData, 60000);
})();

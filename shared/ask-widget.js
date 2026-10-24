// "Ask" widget — a free, no-backend-call Q&A box that answers by matching the typed question to
// whatever KPI tiles (.kpi-label / .kpi-value) are already rendered on the current page. This is
// deliberately NOT an LLM: it never leaves the browser, costs nothing to run, and can only answer
// questions about figures that are already on screen for whatever date range/filter is currently
// selected — it has no reasoning, no comparison across pages, and no memory between questions.
(function () {
  // A few common synonyms so "spend"/"spent", "lead"/"leads" etc. all match the same tile without
  // needing an exact label match. Keys are words a person might type; values are extra words to
  // treat as present in the question when that key appears.
  const SYNONYMS = {
    spend: ['spent', 'ad spend', 'adspend'],
    spent: ['spend', 'ad spend', 'adspend'],
    cost: ['cpl', 'cpc'],
    lead: ['leads'],
    leads: ['lead'],
    case: ['cases'],
    cases: ['case'],
    revenue: ['rev'],
    profit: ['margin'],
    qmva: ['qmvas'],
    budget: ['left'],
  };
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'whats', "what's", 'how', 'much',
    'many', 'my', 'our', 'me', 'please', 'show', 'tell', 'of', 'for', 'to', 'in', 'on', 'at',
    'this', 'that', 'it', "it's", 'its', 'do', 'does', 'did', 'can', 'you', 'i', 'we', 'right',
    'now', 'currently', 'current',
  ]);

  function tokenize(s) {
    return (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9%$/ ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !STOPWORDS.has(w));
  }
  function expand(tokens) {
    const out = new Set(tokens);
    tokens.forEach((t) => { (SYNONYMS[t] || []).forEach((s) => s.split(' ').forEach((w) => out.add(w))); });
    return out;
  }

  function collectTiles() {
    return Array.from(document.querySelectorAll('.kpi')).map((el) => {
      const label = (el.querySelector('.kpi-label') || {}).textContent || '';
      const valueEl = el.querySelector('.kpi-value');
      const value = (valueEl || {}).textContent || '';
      const sub = (el.querySelector('.kpi-sub') || {}).textContent || '';
      return { label: label.trim(), value: value.trim(), sub: sub.trim(), el };
    }).filter((t) => t.label && t.value);
  }

  function scoreTile(queryWords, tile) {
    const labelWords = expand(tokenize(tile.label));
    let score = 0;
    queryWords.forEach((w) => { if (labelWords.has(w)) score += 1; });
    return score;
  }

  function answer(question) {
    const tiles = collectTiles();
    if (!tiles.length) return { text: "This page doesn't have any figures loaded yet — try again once it's finished loading.", tiles: [] };
    const queryWords = expand(tokenize(question));
    if (!queryWords.size) return { text: 'Ask about a specific number, e.g. "what\'s profit?" or "total leads".', tiles: [] };
    const scored = tiles.map((t) => ({ t, score: scoreTile(queryWords, t) })).filter((r) => r.score > 0);
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 3);
    if (!top.length) {
      const sample = tiles.slice(0, 6).map((t) => t.label).join(', ');
      return { text: "Couldn't match that to a figure on this page. Try asking about: " + sample + (tiles.length > 6 ? ', …' : '.'), tiles: [] };
    }
    return { text: null, tiles: top.map((r) => r.t) };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Restricted to mark@loudrmedia.com only, per request — everyone else never sees the button at
  // all (not just hidden via CSS; it's never mounted).
  fetch('/api/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((me) => {
    if (!me || me.name !== 'Mark') return;
    mount();
  }).catch(() => {});

  function mount() {
  const btn = document.createElement('button');
  btn.className = 'ask-widget-btn';
  btn.type = 'button';
  btn.title = 'Ask about the numbers on this page';
  btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  const panel = document.createElement('div');
  panel.className = 'ask-widget-panel';
  panel.hidden = true;
  panel.innerHTML =
    '<div class="ask-widget-head">Ask about this page<button type="button" class="ask-widget-close" aria-label="Close">&times;</button></div>' +
    '<p class="ask-widget-note">Answers come from the figures already shown on this page, for whatever filter/date range is currently selected. Not AI — just keyword matching, free to run.</p>' +
    '<form class="ask-widget-form"><input type="text" class="ask-widget-input" placeholder="e.g. what\'s profit this week?" autocomplete="off"><button type="submit">Ask</button></form>' +
    '<div class="ask-widget-answer"></div>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  function open() { panel.hidden = false; btn.classList.add('is-active'); panel.querySelector('.ask-widget-input').focus(); }
  function close() { panel.hidden = true; btn.classList.remove('is-active'); }
  btn.addEventListener('click', () => (panel.hidden ? open() : close()));
  panel.querySelector('.ask-widget-close').addEventListener('click', close);

  panel.querySelector('.ask-widget-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = panel.querySelector('.ask-widget-input');
    const q = input.value.trim();
    if (!q) return;
    const result = answer(q);
    const out = panel.querySelector('.ask-widget-answer');
    if (result.text) {
      out.innerHTML = '<p class="ask-widget-miss">' + escapeHtml(result.text) + '</p>';
    } else {
      out.innerHTML = result.tiles.map((t) =>
        '<div class="ask-widget-result"><div class="ask-widget-result-label">' + escapeHtml(t.label) + '</div>' +
        '<div class="ask-widget-result-value">' + escapeHtml(t.value) + '</div>' +
        (t.sub ? '<div class="ask-widget-result-sub">' + escapeHtml(t.sub) + '</div>' : '') + '</div>'
      ).join('');
    }
  });
  }
})();

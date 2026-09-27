(function () {
  const $ = (sel) => document.querySelector(sel);
  const pct = (n) => (isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '0') + '%';

  // Which client this is comes from the URL path (/sasooness/, /km/, /bryan/) — the server
  // already scoped the login to exactly one of these, so this only ever reads the one it's for.
  const scope = location.pathname.split('/')[1];
  const TITLES = { sasooness: 'Sasooness', km: 'KM Law Firm PLLC', bryan: 'Bryan Rodriguez' };

  const state = { leads: [], search: '', range: { key: 'all', start: null, end: null }, program: null };
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
        const m = /^(\d{4})-(\d{2})$/.exec(key);
        if (m) { const y = Number(m[1]), mo = Number(m[2]); return { start: toISO(startOfMonth(y, mo)), end: toISO(endOfMonth(y, mo)) }; }
        return { start: null, end: null };
      }
    }
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
      const r = await fetch('/' + scope + '-api/data', { cache: 'no-store' });
      if (!r.ok) throw new Error('bad status');
      const d = await r.json();
      state.leads = d.leads || [];
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

  function render() {
    $('#client-title').textContent = TITLES[scope] || 'Your Dashboard';
    $('#range-label').textContent = rangeLabel();
    renderSegmentTabs();

    const inDateRange = state.leads.filter((l) => inRange(l.date) && (!state.program || l.program === state.program));
    $('#lead-count').textContent = inDateRange.length.toLocaleString('en-US');

    const total = inDateRange.length;
    const signed = inDateRange.filter((l) => l.status === 'Signed').length;
    const conversionRate = total ? Math.round((signed / total) * 1000) / 10 : 0;
    $('#kpi-row').innerHTML = [
      ['Total Leads', total.toLocaleString('en-US'), ''],
      ['Signed', signed.toLocaleString('en-US'), 'of ' + total.toLocaleString('en-US') + ' leads'],
      ['Conversion Rate', pct(conversionRate), 'signed ÷ leads'],
    ].map(([label, value, sub]) =>
      '<div class="kpi"><div class="kpi-label">' + escapeHtml(label) + '</div>' +
      '<div class="kpi-value num">' + value + '</div>' +
      (sub ? '<div class="kpi-sub">' + escapeHtml(sub) + '</div>' : '') + '</div>'
    ).join('');

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
  $('#range-clear').addEventListener('click', () => setRange('all', null, null));

  fetchData();
  setInterval(fetchData, 30000);
})();

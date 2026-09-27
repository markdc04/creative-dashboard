(function () {
  const $ = (sel) => document.querySelector(sel);
  const pct = (n) => (isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '0') + '%';

  // Which client this is comes from the URL path (/sasooness/, /km/, /bryan/) — the server
  // already scoped the login to exactly one of these, so this only ever reads the one it's for.
  const scope = location.pathname.split('/')[1];
  const TITLES = { sasooness: 'Sasooness', km: 'KM Law Firm PLLC', bryan: 'Bryan Rodriguez' };

  const state = { leads: [], totals: { total: 0, signed: 0, conversionRate: 0 }, search: '' };

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

  async function fetchData() {
    try {
      const r = await fetch('/' + scope + '-api/data', { cache: 'no-store' });
      if (!r.ok) throw new Error('bad status');
      const d = await r.json();
      state.leads = d.leads || [];
      state.totals = d.totals || state.totals;
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

  function render() {
    $('#client-title').textContent = TITLES[scope] || 'Your Dashboard';
    $('#lead-count').textContent = state.leads.length.toLocaleString('en-US');
    const t = state.totals;
    $('#kpi-row').innerHTML = [
      ['Total Leads', t.total.toLocaleString('en-US'), ''],
      ['Signed', t.signed.toLocaleString('en-US'), 'of ' + t.total.toLocaleString('en-US') + ' leads'],
      ['Conversion Rate', pct(t.conversionRate), 'signed ÷ leads'],
    ].map(([label, value, sub]) =>
      '<div class="kpi"><div class="kpi-label">' + escapeHtml(label) + '</div>' +
      '<div class="kpi-value num">' + value + '</div>' +
      (sub ? '<div class="kpi-sub">' + escapeHtml(sub) + '</div>' : '') + '</div>'
    ).join('');

    const q = state.search.trim().toLowerCase();
    const rows = state.leads
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

  fetchData();
  setInterval(fetchData, 30000);
})();

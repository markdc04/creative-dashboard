(function () {
  const $ = (sel) => document.querySelector(sel);
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const pct = (n) => (isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '0') + '%';

  const state = { leads: [], googleDaily: [], metaDaily: [], search: '', statusFilter: 'all' };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function statusClass(status) {
    const s = (status || '').toLowerCase();
    if (s.includes('sign') || s === 'client') return 'status-pill--signed';
    if (s.includes('reject')) return 'status-pill--rejected';
    return 'status-pill--other';
  }

  async function fetchData() {
    try {
      const r = await fetch('/sasooness-api/data', { cache: 'no-store' });
      const d = await r.json();
      state.leads = d.leads || [];
      state.googleDaily = d.googleDaily || [];
      state.metaDaily = d.metaDaily || [];
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

  function matchesSearch(lead) {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    return [lead.name, lead.email, lead.phone].some((v) => (v || '').toLowerCase().includes(q));
  }

  function statusGroups() {
    const groups = new Map();
    for (const l of state.leads) {
      const key = l.status || '(blank)';
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    return [...groups.entries()].sort((a, b) => b[1] - a[1]);
  }

  function renderKpis() {
    const total = state.leads.length;
    const signed = state.leads.filter((l) => statusClass(l.status) === 'status-pill--signed').length;
    const rejected = state.leads.filter((l) => statusClass(l.status) === 'status-pill--rejected').length;
    const googleSpend = state.googleDaily.reduce((a, r) => a + r.spend, 0);
    const metaSpend = state.metaDaily.reduce((a, r) => a + r.spend, 0);
    const totalSpend = googleSpend + metaSpend;
    const cpl = total > 0 ? totalSpend / total : 0;

    const tiles = [
      ['Total Leads', total.toLocaleString('en-US'), ''],
      ['Signed Up', signed.toLocaleString('en-US'), total ? pct((signed / total) * 100) + ' of leads' : ''],
      ['Rejected', rejected.toLocaleString('en-US'), total ? pct((rejected / total) * 100) + ' of leads' : ''],
      ['Google Spend', money(googleSpend), ''],
      ['Meta Spend', money(metaSpend), ''],
      ['Cost / Lead', money(cpl), money(totalSpend) + ' total spend'],
    ];
    $('#kpi-row').innerHTML = tiles.map(([label, value, sub]) =>
      '<div class="kpi"><div class="kpi-label">' + escapeHtml(label) + '</div>' +
      '<div class="kpi-value num">' + value + '</div>' +
      (sub ? '<div class="kpi-sub">' + escapeHtml(sub) + '</div>' : '') + '</div>'
    ).join('');
  }

  function renderChips() {
    const groups = statusGroups();
    const chips = ['<button class="chip' + (state.statusFilter === 'all' ? ' is-active' : '') + '" data-status="all">All<span class="n">' + state.leads.length + '</span></button>']
      .concat(groups.map(([status, count]) =>
        '<button class="chip' + (state.statusFilter === status ? ' is-active' : '') + '" data-status="' + escapeHtml(status) + '">' + escapeHtml(status) + '<span class="n">' + count + '</span></button>'
      ));
    $('#status-chips').innerHTML = chips.join('');
    $('#status-chips').querySelectorAll('.chip').forEach((btn) => {
      btn.addEventListener('click', () => { state.statusFilter = btn.dataset.status; render(); });
    });
  }

  function renderLeads() {
    const rows = state.leads
      .filter((l) => (state.statusFilter === 'all' || (l.status || '(blank)') === state.statusFilter) && matchesSearch(l))
      .sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));

    $('#lead-count').textContent = state.leads.length.toLocaleString('en-US');
    $('#leads-empty').hidden = rows.length > 0;
    $('#leads-body').innerHTML = rows.map((l) => (
      '<tr>' +
        '<td><div class="name-cell">' + escapeHtml(l.name || '(no name)') + '</div><div class="email-cell">' + escapeHtml(l.email) + (l.phone ? ' &middot; ' + escapeHtml(l.phone) : '') + '</div></td>' +
        '<td><span class="status-pill ' + statusClass(l.status) + '">' + escapeHtml(l.status || '—') + '</span>' + (l.subStatus ? '<div class="kpi-sub" style="margin-top:4px">' + escapeHtml(l.subStatus) + '</div>' : '') + '</td>' +
        '<td>' + escapeHtml(l.caseType || '—') + '</td>' +
        '<td>' + escapeHtml(l.createdDate || '—') + '</td>' +
        '<td>' + escapeHtml(l.signedUpDate || '—') + '</td>' +
        '<td>' + escapeHtml(l.state || '—') + '</td>' +
        '<td>' + escapeHtml(l.severity || '—') + '</td>' +
        '<td>' + escapeHtml(l.marketingSource || '—') + '</td>' +
        '<td><span class="source-tag">' + (l.source === 'crm' ? 'CRM' : 'Intake') + '</span></td>' +
      '</tr>'
    )).join('');
  }

  function renderSpend() {
    const byDate = new Map();
    for (const r of state.googleDaily) {
      if (!byDate.has(r.date)) byDate.set(r.date, { google: 0, meta: 0 });
      byDate.get(r.date).google += r.spend;
    }
    for (const r of state.metaDaily) {
      if (!byDate.has(r.date)) byDate.set(r.date, { google: 0, meta: 0 });
      byDate.get(r.date).meta += r.spend;
    }
    const rows = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    $('#spend-sub').textContent = rows.length ? rows.length + ' days tracked' : '';
    $('#spend-empty').hidden = rows.length > 0;
    $('#spend-body').innerHTML = rows.map(([date, v]) => (
      '<tr><td>' + escapeHtml(date) + '</td><td class="num">' + money(v.google) + '</td><td class="num">' + money(v.meta) + '</td><td class="num" style="font-weight:700">' + money(v.google + v.meta) + '</td></tr>'
    )).join('');
  }

  function render() {
    renderKpis();
    renderChips();
    renderLeads();
    renderSpend();
  }

  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('#refresh-btn').addEventListener('click', () => {
    $('#refresh-btn').classList.add('is-spinning');
    fetchData().finally(() => setTimeout(() => $('#refresh-btn').classList.remove('is-spinning'), 400));
  });

  fetchData();
  setInterval(fetchData, 30000);
})();

(function () {
  const $ = (sel) => document.querySelector(sel);

  // ---- quick-range dropdown — same preset math as every other dashboard here ----
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
      case 'all': return { start: null, end: null };
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

  const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
  const int = (n) => (n || 0).toLocaleString('en-US');
  const dash = '—';
  const sum = (rows, field) => (rows || []).reduce((s, r) => s + (r[field] || 0), 0);
  const inRange = (date, from, to) => (!date || ((!from || date >= from) && (!to || date <= to)));
  const filterByDate = (rows, field, from, to) => (rows || []).filter((r) => inRange(r[field], from, to));

  // Sasooness's own exact definition (sasooness.js / sasooness-public/app.js) — a lead counts as
  // signed if its Status OR SubStatus says so (a referred-out lead can still sign elsewhere, e.g.
  // Status="Referred" + SubStatus="Signed Up").
  const sasoonessSigned = (l) => ['status', 'subStatus'].some((f) => { const v = (l[f] || '').trim(); return v === 'Signed Up' || v === 'Client'; });
  const bryanSigned = (l) => l.status === 'Signed';
  const BRYAN_PRICE_PER_LEAD = 350; // bryan-public/app.js's PRICE_PER_LEAD — keep in sync.
  const BRYAN_FEE_BY_MONTH = { '2026-08': 1250, '2026-09': 1250, '2026-10': 1250 }; // bryan-public/app.js's MARKETING_FEE_BY_MONTH — keep in sync.
  const KM_FEE_PER_LEAD = 35; // falls back to this if /km-api/data's settings.feePerLead is missing.

  const state = { range: { from: '', to: '' } };

  const CLIENTS = [
    {
      key: 'sasooness', name: 'Sasooness Law Group, APC', sub: 'PI — Auto / MVA', href: '/sasooness/', initials: 'SL',
      url: '/sasooness-api/data', type: 'legal',
      metrics: (d, range) => {
        const leads = filterByDate(d.leads, 'createdDate', range.from, range.to);
        const spend = sum(filterByDate(d.googleDaily, 'date', range.from, range.to), 'spend')
          + sum(filterByDate(d.metaDaily, 'date', range.from, range.to), 'spend')
          + sum(filterByDate(d.walker && d.walker.spendDaily, 'date', range.from, range.to), 'spend');
        const signed = leads.filter(sasoonessSigned).length;
        return {
          totalLeads: leads.length, cpl: leads.length ? spend / leads.length : 0, signed,
          cpc: signed ? spend / signed : 0, cpcLabel: 'CPC (no fee)',
          cpcNote: 'Sasooness bills marketing fee on a per-program contract schedule (different rates/dates for OG vs. Agency/AZ) — too contract-specific to safely duplicate here. See the Sasooness dashboard for the fee-inclusive number.',
        };
      },
    },
    {
      key: 'km', name: 'KM Law Firm PLLC', sub: 'PI — Auto / MVA', href: '/km/', initials: 'KM',
      url: '/km-api/data', type: 'legal',
      metrics: (d, range) => {
        const leadsDaily = filterByDate(d.leadsDaily, 'date', range.from, range.to);
        const cases = filterByDate(d.cases, 'conversionDate', range.from, range.to); // cases ARE the signed-case list already
        const totalLeads = sum(leadsDaily, 'leads');
        const spend = sum(filterByDate(d.googleDaily, 'date', range.from, range.to), 'spend')
          + sum(filterByDate(d.metaDaily, 'date', range.from, range.to), 'spend');
        const signed = cases.length;
        const feePerLead = (d.settings && d.settings.feePerLead) || KM_FEE_PER_LEAD;
        const fee = totalLeads * feePerLead;
        return {
          totalLeads, cpl: totalLeads ? spend / totalLeads : 0, signed,
          cpc: signed ? (spend + fee) / signed : 0, cpcLabel: 'CPC + Fee',
        };
      },
    },
    {
      key: 'bryan', name: 'Bryan Rodriguez', sub: 'Agency', href: '/bryan/', initials: 'BR',
      url: '/bryan-api/data', type: 'legal',
      metrics: (d, range) => {
        const leads = filterByDate(d.leads, 'createdDate', range.from, range.to);
        const spend = sum(filterByDate(d.walker && d.walker.spendDaily, 'date', range.from, range.to), 'spend');
        const signed = leads.filter(bryanSigned).length;
        const billable = leads.filter((l) => l.billable !== false).length;
        const revenue = billable * BRYAN_PRICE_PER_LEAD;
        const feeMonths = new Set(leads.map((l) => (l.createdDate || '').slice(0, 7)).filter((m) => BRYAN_FEE_BY_MONTH[m] != null));
        const fee = [...feeMonths].reduce((s, m) => s + BRYAN_FEE_BY_MONTH[m], 0);
        return {
          totalLeads: leads.length, cpl: leads.length ? spend / leads.length : 0, signed,
          cpc: signed ? (revenue + fee) / signed : 0, cpcLabel: 'CPC + Fee',
        };
      },
    },
    {
      key: 'walker', name: 'Walker PPL / Agency', sub: 'Pay Per Lead', href: '/walker/', initials: 'WA',
      url: '/walker-api/data?tab=ca-nw', type: 'ppl',
      metrics: (d) => {
        const rows = d.rows || [];
        const revenue = sum(rows, 'revenue');
        const adSpent = sum(rows, 'totalSpent');
        const profit = sum(rows, 'profit');
        const qmva = sum(rows, 'currentQmva');
        const cpqmva = qmva ? adSpent / qmva : 0;
        return { revenue, adSpent, profit, qmva, cpqmva };
      },
    },
    {
      key: 'b2b', name: 'Loudr Media B2B', sub: 'Sales Pipeline', href: '/b2b/', initials: 'B2',
      url: '/b2b-api/data', type: 'pipeline',
      metrics: (d, range) => {
        const leadsDaily = filterByDate(d.leadsDaily, 'date', range.from, range.to);
        const adSpendDaily = filterByDate(d.adSpendDaily, 'date', range.from, range.to);
        const totalLeads = sum(leadsDaily, 'leads');
        const spend = sum(adSpendDaily, 'spend');
        return { totalLeads, spend, cpl: totalLeads ? spend / totalLeads : 0 };
      },
    },
  ];

  function legalCardBody(c, m) {
    return (
      '<div class="client-metrics">' +
        '<div class="client-metric"><div class="client-metric-label">Total Leads</div><div class="client-metric-value">' + int(m.totalLeads) + '</div></div>' +
        '<div class="client-metric"><div class="client-metric-label">CPL</div><div class="client-metric-value">' + (m.cpl ? money(m.cpl) : dash) + '</div></div>' +
        '<div class="client-metric client-metric--highlight"><div class="client-metric-label">Signed Cases</div><div class="client-metric-value">' + int(m.signed) + '</div></div>' +
        '<div class="client-metric"><div class="client-metric-label">' + (m.cpcLabel || 'CPC') + '</div><div class="client-metric-value">' + (m.signed ? money(m.cpc) : dash) + '</div></div>' +
      '</div>' +
      (m.cpcNote ? '<p class="client-card-note">' + m.cpcNote + '</p>' : '')
    );
  }

  function pplCardBody(m) {
    return (
      '<div class="client-metrics client-metrics--5">' +
        '<div class="client-metric"><div class="client-metric-label">Revenue</div><div class="client-metric-value">' + money(m.revenue) + '</div></div>' +
        '<div class="client-metric"><div class="client-metric-label">Ad Spent</div><div class="client-metric-value">' + money(m.adSpent) + '</div></div>' +
        '<div class="client-metric client-metric--highlight"><div class="client-metric-label">Profit</div><div class="client-metric-value' + (m.profit < 0 ? ' loss' : ' profit') + '">' + money(m.profit) + '</div></div>' +
        '<div class="client-metric"><div class="client-metric-label">QMVA</div><div class="client-metric-value">' + int(m.qmva) + '</div></div>' +
        '<div class="client-metric"><div class="client-metric-label">CPQMVA</div><div class="client-metric-value">' + (m.qmva ? money(m.cpqmva) : dash) + '</div></div>' +
      '</div>' +
      '<p class="client-card-note">Lifetime totals — this card isn’t affected by the date range above yet.</p>'
    );
  }

  function pipelineCardBody(m) {
    return (
      '<div class="client-metrics">' +
        '<div class="client-metric"><div class="client-metric-label">Total Leads</div><div class="client-metric-value">' + int(m.totalLeads) + '</div></div>' +
        '<div class="client-metric"><div class="client-metric-label">Ad Spend</div><div class="client-metric-value">' + money(m.spend) + '</div></div>' +
        '<div class="client-metric client-metric--highlight"><div class="client-metric-label">Cost / Lead</div><div class="client-metric-value">' + (m.cpl ? money(m.cpl) : dash) + '</div></div>' +
      '</div>'
    );
  }

  function cardShell(c) {
    return (
      '<div class="client-card" id="card-' + c.key + '">' +
        '<div class="client-card-head">' +
          '<div class="client-id">' +
            '<div class="client-badge">' + c.initials + '</div>' +
            '<div><p class="client-name">' + c.name + '</p><p class="client-sub">' + c.sub + '</p></div>' +
          '</div>' +
          '<span class="client-status client-status--loading" id="status-' + c.key + '">Loading…</span>' +
        '</div>' +
        '<div id="body-' + c.key + '"></div>' +
        '<div class="client-card-foot"><a class="client-open-btn" href="' + c.href + '">Open dashboard →</a></div>' +
      '</div>'
    );
  }

  const bodyRenderers = { legal: legalCardBody, ppl: pplCardBody, pipeline: pipelineCardBody };

  async function loadOne(c) {
    try {
      const res = await fetch(c.url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const m = c.metrics(data, state.range);
      $('#body-' + c.key).innerHTML = bodyRenderers[c.type](c, m);
      const statusEl = $('#status-' + c.key);
      statusEl.textContent = 'Live';
      statusEl.className = 'client-status';
    } catch (err) {
      const statusEl = $('#status-' + c.key);
      statusEl.textContent = 'Unavailable';
      statusEl.className = 'client-status client-status--error';
    }
  }

  function load() {
    $('#client-grid').innerHTML = CLIENTS.map(cardShell).join('');
    return Promise.all(CLIENTS.map(loadOne));
  }

  $('#refresh-btn').addEventListener('click', () => {
    $('#refresh-btn').classList.add('is-spinning');
    load().finally(() => setTimeout(() => $('#refresh-btn').classList.remove('is-spinning'), 400));
  });
  $('#quick-range').addEventListener('change', (e) => {
    const { start, end } = computeRange(e.target.value);
    state.range = { from: start || '', to: end || '' };
    $('#range-from').value = start || '';
    $('#range-to').value = end || '';
    load();
  });
  function applyCustomRange() {
    state.range = { from: $('#range-from').value || '', to: $('#range-to').value || '' };
    $('#quick-range').value = '';
    load();
  }
  $('#range-from').addEventListener('change', applyCustomRange);
  $('#range-to').addEventListener('change', applyCustomRange);
  $('#range-clear').addEventListener('click', () => {
    state.range = { from: '', to: '' };
    $('#range-from').value = ''; $('#range-to').value = '';
    $('#quick-range').value = 'all';
    load();
  });

  buildQuickRangeOptions(2026, 1);
  $('#quick-range').value = 'all';

  load();
})();

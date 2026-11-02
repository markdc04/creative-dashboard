(function () {
  const $ = (sel) => document.querySelector(sel);
  const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
  const int = (n) => (n || 0).toLocaleString('en-US');
  const dash = '—';

  // Each client's dashboard tracks a different shape of data (cases vs. leads, Google+Meta vs.
  // Walker agency spend, daily tab rows vs. a flat array) — this page doesn't re-derive new
  // numbers, it just totals up the same leads/spend fields each client's own dashboard already
  // shows, lifetime, so a summary card here always matches what you'd see on that dashboard.
  const sum = (rows, field) => (rows || []).reduce((s, r) => s + (r[field] || 0), 0);

  const CLIENTS = [
    {
      key: 'sasooness', name: 'Sasooness Law Group, APC', sub: 'PI — Auto / MVA', href: '/sasooness/', initials: 'SL',
      url: '/sasooness-api/data',
      metrics: (d) => {
        const leads = (d.leads || []).length;
        const spend = sum(d.googleDaily, 'spend') + sum(d.metaDaily, 'spend') + sum(d.walker && d.walker.spendDaily, 'spend');
        return { leads, spend };
      },
    },
    {
      key: 'km', name: 'KM Law Firm PLLC', sub: 'PI — Auto / MVA', href: '/km/', initials: 'KM',
      url: '/km-api/data',
      metrics: (d) => {
        const leads = (d.cases || []).length;
        const spend = sum(d.googleDaily, 'spend') + sum(d.metaDaily, 'spend');
        return { leads, spend };
      },
    },
    {
      key: 'bryan', name: 'Bryan Rodriguez', sub: 'Agency', href: '/bryan/', initials: 'BR',
      url: '/bryan-api/data',
      metrics: (d) => {
        const leads = (d.leads || []).length;
        const spend = sum(d.walker && d.walker.spendDaily, 'spend');
        return { leads, spend };
      },
    },
    {
      key: 'walker', name: 'Walker PPL / Agency', sub: 'Pay Per Lead', href: '/walker/', initials: 'WA',
      url: '/walker-api/data?tab=ca-nw',
      metrics: (d) => {
        const rows = d.rows || [];
        const leads = sum(rows, 'totalLeads');
        const spend = sum(rows, 'totalSpent');
        return { leads, spend };
      },
    },
  ];

  function cardHtml(c) {
    return (
      '<div class="client-card" id="card-' + c.key + '">' +
        '<div class="client-card-head">' +
          '<div class="client-id">' +
            '<div class="client-badge">' + c.initials + '</div>' +
            '<div><p class="client-name">' + c.name + '</p><p class="client-sub">' + c.sub + '</p></div>' +
          '</div>' +
          '<span class="client-status client-status--loading" id="status-' + c.key + '">Loading…</span>' +
        '</div>' +
        '<div class="client-metrics">' +
          '<div class="client-metric"><div class="client-metric-label">Total Leads</div><div class="client-metric-value" id="leads-' + c.key + '">' + dash + '</div></div>' +
          '<div class="client-metric"><div class="client-metric-label">Ad Spend</div><div class="client-metric-value" id="spend-' + c.key + '">' + dash + '</div></div>' +
          '<div class="client-metric"><div class="client-metric-label">Cost / Lead</div><div class="client-metric-value" id="cpl-' + c.key + '">' + dash + '</div></div>' +
        '</div>' +
        '<div class="client-card-foot"><a class="client-open-btn" href="' + c.href + '">Open dashboard →</a></div>' +
      '</div>'
    );
  }

  function renderSummary(totals) {
    const cpl = totals.leads ? totals.spend / totals.leads : 0;
    $('#summary-kpis').innerHTML = [
      ['Total Leads (All Clients)', int(totals.leads)],
      ['Total Ad Spend', money(totals.spend)],
      ['Blended Cost / Lead', totals.leads ? money(cpl) : dash],
      ['Clients Tracked', String(CLIENTS.length)],
    ].map(([label, value]) =>
      '<div class="kpi"><div class="kpi-label">' + label + '</div><div class="kpi-value num">' + value + '</div></div>'
    ).join('');
  }

  async function load() {
    $('#client-grid').innerHTML = CLIENTS.map(cardHtml).join('');
    const totals = { leads: 0, spend: 0 };
    await Promise.all(CLIENTS.map(async (c) => {
      try {
        const res = await fetch(c.url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const { leads, spend } = c.metrics(data);
        totals.leads += leads;
        totals.spend += spend;
        $('#leads-' + c.key).textContent = int(leads);
        $('#spend-' + c.key).textContent = money(spend);
        $('#cpl-' + c.key).textContent = leads ? money(spend / leads) : dash;
        const statusEl = $('#status-' + c.key);
        statusEl.textContent = 'Live';
        statusEl.className = 'client-status';
      } catch (err) {
        const statusEl = $('#status-' + c.key);
        statusEl.textContent = 'Unavailable';
        statusEl.className = 'client-status client-status--error';
      }
    }));
    renderSummary(totals);
  }

  $('#refresh-btn').addEventListener('click', () => {
    $('#refresh-btn').classList.add('is-spinning');
    load().finally(() => setTimeout(() => $('#refresh-btn').classList.remove('is-spinning'), 400));
  });

  load();
})();

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

  // Sasooness's own exact definition (sasooness.js / sasooness-public/app.js) — Status alone,
  // never SubStatus (confirmed against the live Lead Tracker sheet, 2026-11-04).
  // Matches sasooness-public/app.js's isSignedCase — Signed Up Date present, not Status alone
  // (Status can say "Referred" with SubStatus "Signed Up" and still have a real signed date).
  const sasoonessSigned = (l) => !!(l.signedUpDate && String(l.signedUpDate).trim());
  const bryanSigned = (l) => l.status === 'Signed';
  const BRYAN_PRICE_PER_LEAD = 350; // bryan-public/app.js's PRICE_PER_LEAD — keep in sync.
  const BRYAN_FEE_BY_MONTH = { '2026-09': 1250, '2026-10': 1250 }; // bryan-public/app.js's MARKETING_FEE_BY_MONTH — keep in sync.
  // August isn't a flat fee — Bryan's real August contract is a flat $20,000, of which the
  // $350/lead revenue is just an accounting split; the "fee" is whatever's left over. See
  // bryan-public/app.js's AUGUST_RETAINER comment — keep in sync.
  const BRYAN_AUGUST_RETAINER = 20000;
  const KM_FEE_PER_LEAD = 35; // falls back to this if /km-api/data's settings.feePerLead is missing.

  const state = { range: { from: '', to: '' } };

  const CLIENTS = [
    {
      key: 'sasooness', name: 'Sasooness Law Group, APC', href: '/sasooness/', initials: 'SL',
      url: '/sasooness-api/data', type: 'legal',
      metrics: (d, range) => {
        const leads = filterByDate(d.leads, 'createdDate', range.from, range.to);
        const spend = sum(filterByDate(d.googleDaily, 'date', range.from, range.to), 'spend')
          + sum(filterByDate(d.metaDaily, 'date', range.from, range.to), 'spend')
          + sum(filterByDate(d.walker && d.walker.spendDaily, 'date', range.from, range.to), 'spend');
        // Signed cases are counted by SIGNED UP DATE, not created date — a lead created outside
        // the range can still have signed inside it, and vice versa.
        const signed = filterByDate(d.leads, 'signedUpDate', range.from, range.to).filter(sasoonessSigned).length;
        return {
          totalLeads: leads.length, cpl: leads.length ? spend / leads.length : 0, signed,
          cpc: signed ? spend / signed : 0, cpcLabel: 'CPC (no fee)',
          cpcNote: 'Sasooness bills marketing fee on a per-program contract schedule (different rates/dates for OG vs. Agency/AZ) — too contract-specific to safely duplicate here. See the Sasooness dashboard for the fee-inclusive number.',
        };
      },
    },
    {
      key: 'km', name: 'KM Law Firm PLLC', href: '/km/', initials: 'KM',
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
      key: 'bryan', name: 'Bryan Rodriguez', href: '/bryan/', initials: 'BR',
      url: '/bryan-api/data', type: 'legal',
      metrics: (d, range) => {
        const leads = filterByDate(d.leads, 'createdDate', range.from, range.to);
        const spend = sum(filterByDate(d.walker && d.walker.spendDaily, 'date', range.from, range.to), 'spend');
        const signed = leads.filter(bryanSigned).length;
        const billable = leads.filter((l) => l.billable !== false).length;
        const revenue = billable * BRYAN_PRICE_PER_LEAD;
        const feeMonths = new Set(leads.map((l) => (l.createdDate || '').slice(0, 7)).filter((m) => m === '2026-08' || BRYAN_FEE_BY_MONTH[m] != null));
        const fee = [...feeMonths].reduce((s, m) => {
          if (m === '2026-08') {
            const augRevenue = leads.filter((l) => (l.createdDate || '').slice(0, 7) === '2026-08' && l.billable !== false).length * BRYAN_PRICE_PER_LEAD;
            return s + (BRYAN_AUGUST_RETAINER - augRevenue);
          }
          return s + BRYAN_FEE_BY_MONTH[m];
        }, 0);
        return {
          totalLeads: leads.length, cpl: leads.length ? spend / leads.length : 0, signed,
          cpc: signed ? (revenue + fee) / signed : 0, cpcLabel: 'CPC + Fee',
        };
      },
    },
    {
      key: 'walker', name: 'Walker PPL / Agency', href: '/walker/', initials: 'WA',
      url: '/walker-api/data?tab=ca-nw', type: 'ppl',
      // Walker isn't background-polled like the other four (see walker.js's own comments — its
      // live fetch was the single biggest lever behind a past out-of-memory crash, which is why
      // it was pulled off the background timer and made on-demand per request instead). Auto-
      // fetching it here on every Clients page load reintroduces that same expensive hit for
      // everyone, every time, so it's loaded on click instead.
      lazy: true,
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
      key: 'b2b', name: 'Loudr Media B2B', href: '/b2b/', initials: 'B2',
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

  function pplCardBody(c, m) {
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

  function pipelineCardBody(c, m) {
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
            '<p class="client-name">' + c.name + '</p>' +
          '</div>' +
          '<span class="client-status client-status--loading" id="status-' + c.key + '">' + (c.lazy ? 'Not loaded' : 'Loading…') + '</span>' +
        '</div>' +
        '<div id="body-' + c.key + '">' + (c.lazy ? lazyBody(c) : '') + '</div>' +
        '<div class="client-card-foot"><a class="client-open-btn" href="' + c.href + '">Open dashboard →</a></div>' +
      '</div>'
    );
  }

  function lazyBody(c) {
    return (
      '<p class="client-card-note">This one isn’t cached in the background (see the Walker dashboard) — loading it live can take a while.</p>' +
      '<button class="client-open-btn" id="load-' + c.key + '" type="button">Load stats</button>'
    );
  }

  const bodyRenderers = { legal: legalCardBody, ppl: pplCardBody, pipeline: pipelineCardBody };

  // Raw per-client payloads, kept around so the Fulfillment table below can recompute lifetime
  // (all-time) totals independently of whatever date range is picked above for the cards.
  const dataCache = {};

  async function loadOne(c) {
    const statusEl = $('#status-' + c.key);
    statusEl.textContent = 'Loading…';
    statusEl.className = 'client-status client-status--loading';
    try {
      const res = await fetch(c.url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      dataCache[c.key] = data;
      const m = c.metrics(data, state.range);
      $('#body-' + c.key).innerHTML = bodyRenderers[c.type](c, m);
      statusEl.textContent = 'Live';
      statusEl.className = 'client-status';
    } catch (err) {
      statusEl.textContent = 'Unavailable';
      statusEl.className = 'client-status client-status--error';
    }
    renderFulfillment();
  }

  function load() {
    $('#client-grid').innerHTML = CLIENTS.map(cardShell).join('');
    CLIENTS.filter((c) => c.lazy).forEach((c) => {
      $('#load-' + c.key).addEventListener('click', () => loadOne(c));
    });
    return Promise.all(CLIENTS.filter((c) => !c.lazy).map(loadOne));
  }

  // ---------------- Lead Fulfillment (ordered vs. delivered, per client) ----------------
  // Nothing in any sheet tracks a prepaid/ordered lead count — every client here is billed
  // against ad spend (CPL) or a flat per-lead rate, open-ended. "Ordered" has no live source, so
  // it's a plain editable number saved in this browser (localStorage), while "Delivered" is
  // computed live from the same data the cards above use, just always at the ALL-TIME range
  // regardless of what's picked in the date bar — Jeremiah's question was "how many so far",
  // not "how many this week".
  const ALL_TIME = { from: '', to: '' };
  function orderedKey(rowKey) { return 'loudr_order_' + rowKey; }
  function getOrdered(rowKey) {
    try { const v = Number(localStorage.getItem(orderedKey(rowKey))); return Number.isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; }
  }
  function setOrdered(rowKey, value) {
    try {
      if (value > 0) localStorage.setItem(orderedKey(rowKey), String(value));
      else localStorage.removeItem(orderedKey(rowKey));
    } catch (e) { /* ignore — private window / blocked storage */ }
  }

  // One row per billing bucket, not per card — Sasooness splits into Agency (AZ, billed at CPL)
  // and PPL (WA, billed at a flat $425/lead), since those have different prices and the point of
  // this table is "price per lead", singular, per row.
  const FULFILLMENT_ROWS = [
    {
      key: 'sasooness-agency', name: 'Sasooness — Agency (AZ)', trackedIn: 'Lead Tracker sheet + Walker Lead Prosper (shared)',
      compute: () => {
        const d = dataCache.sasooness; if (!d) return null;
        const leads = (d.leads || []).filter((l) => l.channel !== 'Lead Prosper WA');
        const spend = sum(d.googleDaily, 'spend') + sum(d.metaDaily, 'spend') + sum(d.walker && d.walker.spendDaily, 'spend');
        return { delivered: leads.length, pricePerLead: leads.length ? spend / leads.length : 0, priceIsCpl: true };
      },
    },
    {
      key: 'sasooness-ppl', name: 'Sasooness — PPL (WA)', trackedIn: 'Lead Prosper WA (shared Walker campaign)',
      compute: () => {
        const d = dataCache.sasooness; if (!d) return null;
        const leads = (d.leads || []).filter((l) => l.channel === 'Lead Prosper WA');
        return { delivered: leads.length, pricePerLead: 425, priceIsCpl: false };
      },
    },
    {
      key: 'bryan', name: 'Bryan Rodriguez', trackedIn: 'Lead Tracker sheet + Walker Lead Prosper (shared)',
      compute: () => {
        const d = dataCache.bryan; if (!d) return null;
        return { delivered: (d.leads || []).length, pricePerLead: BRYAN_PRICE_PER_LEAD, priceIsCpl: false };
      },
    },
    {
      key: 'km', name: 'KM Law Firm PLLC', trackedIn: 'Own Google/Meta spend sheet + lead sheet',
      compute: () => {
        const d = dataCache.km; if (!d) return null;
        const totalLeads = sum(d.leadsDaily, 'leads');
        const spend = sum(d.googleDaily, 'spend') + sum(d.metaDaily, 'spend');
        return { delivered: totalLeads, pricePerLead: totalLeads ? spend / totalLeads : 0, priceIsCpl: true };
      },
    },
    {
      key: 'b2b', name: 'Loudr Media B2B (aggregate)', trackedIn: 'GHL (leads) + Meta (ad spend) — no per-end-client split today',
      compute: () => {
        const d = dataCache.b2b; if (!d) return null;
        const totalLeads = sum(d.leadsDaily, 'leads');
        const spend = sum(d.adSpendDaily, 'spend');
        return { delivered: totalLeads, pricePerLead: totalLeads ? spend / totalLeads : 0, priceIsCpl: true };
      },
    },
  ];

  function renderFulfillment() {
    const body = $('#fulfillment-body');
    if (!body) return;
    body.innerHTML = FULFILLMENT_ROWS.map((row) => {
      const r = row.compute();
      const ordered = getOrdered(row.key);
      const delivered = r ? r.delivered : null;
      const remaining = ordered && delivered != null ? ordered - delivered : null;
      const priceCell = r ? money(r.pricePerLead) + (r.priceIsCpl ? ' <span class="source-tag">CPL</span>' : '') : dash;
      return (
        '<tr data-row="' + row.key + '">' +
        '<td>' + row.name + '</td>' +
        '<td class="th-num">' + priceCell + '</td>' +
        '<td class="th-num num">' + (delivered != null ? int(delivered) : dash) + '</td>' +
        '<td class="th-num"><input type="number" min="0" step="1" class="ordered-input" data-row="' + row.key + '" value="' + (ordered || '') + '" placeholder="&mdash;"></td>' +
        '<td class="th-num num' + (remaining != null && remaining < 0 ? ' loss' : '') + '">' + (remaining != null ? int(remaining) : dash) + '</td>' +
        '<td>' + row.trackedIn + '</td>' +
        '</tr>'
      );
    }).join('');
    body.querySelectorAll('.ordered-input').forEach((inp) => {
      inp.addEventListener('change', () => {
        setOrdered(inp.dataset.row, Number(inp.value) || 0);
        renderFulfillment();
      });
    });
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

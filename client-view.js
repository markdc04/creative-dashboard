// What a `role: 'client'` session gets back from a client dashboard's data API, instead of the
// full internal payload an admin/creative session gets from the same endpoint. Deliberately
// conservative for now (name/date/status only, no dollars, no campaign or vendor names) — the
// exact fields each client is allowed to see still needs sign-off from the team; adjust here once
// that's settled rather than in each client's own module.

// Each internal module spells "signed" differently (Bryan: "Signed"; Sasooness: "Signed Up" or
// "Client") — normalized to the single literal "Signed" here so the client page's own logic never
// needs to know which source a lead came from.
const SIGNED_VALUES = new Set(['signed', 'signed up', 'client']);
function isSignedStatus(status) { return SIGNED_VALUES.has((status || '').trim().toLowerCase()); }

// Sasooness's own two-model split, per the client: OG (Main Landing Page) and Agency (Lead
// Prosper AZ) are both the AZ side of the business and count together as "Agency" here; Pay Per
// Lead is WA only (Lead Prosper WA). So every lead gets exactly one of these two, unlike the
// internal dashboard's three-way OG/Agency/PPL split.
function programOf(channel) {
  return channel === 'Lead Prosper WA' ? 'ppl' : 'agency';
}

// A lead referred out can still be a real signed case if its SubStatus says so (Sasooness: 41
// with Status "Signed Up" + 9 with Status "Referred"/SubStatus "Signed Up" = 50 real signed
// cases) — checked here too so the client's own view doesn't undercount what the admin view now
// correctly counts.
function isSignedCase(l) { return isSignedStatus(l.status) || isSignedStatus(l.subStatus); }

function simplifyLeads(leads, financials) {
  const rows = (leads || []).map((l) => ({
    name: l.name || '', date: l.createdDate || '', status: isSignedCase(l) ? 'Signed' : (l.status || ''),
    program: programOf(l.channel),
    reason: (l.status || '').toLowerCase().includes('reject') ? ((l.subStatus || '').trim() || '(no reason given)') : '',
  }));
  const total = rows.length;
  const signed = rows.filter((r) => r.status === 'Signed').length;
  return {
    leads: rows,
    totals: { total, signed, conversionRate: total ? Math.round((signed / total) * 1000) / 10 : 0 },
    financials: financials || null,
    updatedAt: Date.now(),
  };
}

// Sasooness's Agency ad-spend + marketing fee, for the client's own "Total Cost" / "Cost Per
// Case" tiles — the contract's own numbers, nothing about vendors or campaigns. A day's combined
// spend is the Main Landing Page's own campaign spend that day plus Sasooness's share of Walker's
// shared Lead Prosper AZ spend that day (same day-by-day deduction the admin view uses); the fee
// schedule itself is exposed as-is since it's the client's own contract terms.
function sasoonessFinancials(data) {
  const dailySpend = new Map();
  for (const r of data.campaignSpend || []) dailySpend.set(r.date, (dailySpend.get(r.date) || 0) + r.spend);
  const sent = new Map(); // campaignId|date -> count of AZ leads sent that day
  for (const l of data.leads || []) {
    const o = l.origin;
    if (!o || !o.campaignId || !l.createdDate) continue;
    const key = o.campaignId + '|' + l.createdDate;
    sent.set(key, (sent.get(key) || 0) + 1);
  }
  const walker = data.walker || {};
  for (const [key, n] of sent) {
    const [campaignId, date] = key.split('|');
    const spend = (walker.spendDaily || []).filter((r) => r.campaignId === campaignId && r.date === date).reduce((a, r) => a + r.spend, 0);
    const walkerLeads = (walker.leadsDaily || []).filter((r) => r.campaignId === campaignId && r.date === date).reduce((a, r) => a + r.leads, 0);
    if (walkerLeads > 0) dailySpend.set(date, (dailySpend.get(date) || 0) + (spend / walkerLeads) * n);
  }
  return {
    dailySpend: [...dailySpend.entries()].map(([date, spend]) => ({ date, spend: Math.round(spend * 100) / 100 })),
    schedule: (data.settings && data.settings.schedule) || [],
  };
}

// KM's "cases" are already-converted leads (no funnel/status) — normalized to the same
// {leads, totals} shape as simplifyLeads (every case reads as Signed) so one client-facing page
// can render either client's data without knowing which internal module it came from.
function simplifyCases(cases) {
  const rows = (cases || []).map((c) => ({ name: c.name || '', date: c.conversionDate || c.intakeDate || '', status: 'Signed' }));
  return {
    leads: rows,
    totals: { total: rows.length, signed: rows.length, conversionRate: 100 },
    updatedAt: Date.now(),
  };
}

module.exports = { simplifyLeads, simplifyCases, sasoonessFinancials };

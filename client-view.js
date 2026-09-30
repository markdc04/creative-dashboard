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

function simplifyLeads(leads) {
  const rows = (leads || []).map((l) => ({ name: l.name || '', date: l.createdDate || '', status: isSignedCase(l) ? 'Signed' : (l.status || ''), program: programOf(l.channel) }));
  const total = rows.length;
  const signed = rows.filter((r) => r.status === 'Signed').length;
  return {
    leads: rows,
    totals: { total, signed, conversionRate: total ? Math.round((signed / total) * 1000) / 10 : 0 },
    updatedAt: Date.now(),
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

module.exports = { simplifyLeads, simplifyCases };

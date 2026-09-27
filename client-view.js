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

// Sasooness runs leads through three channels internally (OG, Agency via Lead Prosper AZ, PPL via
// Lead Prosper WA); the client only asked to switch between the Agency and PPL views specifically,
// so those two carry through as `program` and everything else (OG, the bulk of their volume) is
// left unset — the client page treats unset as "no program filter applies to this lead."
function programOf(channel) {
  if (channel === 'Lead Prosper AZ') return 'agency';
  if (channel === 'Lead Prosper WA') return 'ppl';
  return null;
}

function simplifyLeads(leads) {
  const rows = (leads || []).map((l) => ({ name: l.name || '', date: l.createdDate || '', status: isSignedStatus(l.status) ? 'Signed' : (l.status || ''), program: programOf(l.channel) }));
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

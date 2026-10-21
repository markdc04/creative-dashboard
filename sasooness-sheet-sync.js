// Writes a live snapshot of the Sasooness dashboard's headline numbers + lead tables out to a
// Google Sheet, for anyone who'd rather glance at a spreadsheet than open the dashboard. Mirrors
// the core metrics from sasooness-public/app.js's renderKpis (Total Leads, Signed, Conversion
// Rate, Rejected, Revenue, Ad Spend, Profit) for both programs (PPL and Agency), all-time/
// unfiltered since a static sheet has no date-range picker. Deliberately leaves out the Agency
// contract's monthly fee/budget-tranche proration (contractForRange/windowSpend in app.js) — that
// logic is calendar-schedule-dependent and date-range-sensitive in a way that doesn't map cleanly
// onto a single always-current snapshot; the live dashboard remains the source of truth for that.
const { writeSheetTab } = require('./sheet-writer');

const SPREADSHEET_ID = '1PCSysjKer16YHJOvLMiG8flEu4ymVjja0dxFHEYB0J0';
const PPL_PRICE_PER_LEAD = 425;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

function isSignedStatus(s) { return /^(signed|retained|active client)$/i.test((s || '').trim()); }
function isSignedCase(l) { return isSignedStatus(l.status) || isSignedStatus(l.subStatus); }
function programOf(l) { return l.channel === 'Lead Prosper AZ' || l.channel === 'Lead Prosper WA' ? 'agency' : (l.program || (l.channel === 'OG' ? 'ppl' : 'agency')); }
function money(n) { return '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pct(n) { return (Math.round(n * 10) / 10) + '%'; }

// Same day-by-day partner deduction as partnerDeduction() in sasooness-public/app.js.
function partnerDeduction(leads, walker) {
  const sent = new Map();
  for (const l of leads) {
    const o = l.origin;
    if (!o || !o.campaignId || !l.createdDate) continue;
    const key = o.campaignId + '|' + l.createdDate;
    if (!sent.has(key)) sent.set(key, { campaignId: o.campaignId, date: l.createdDate, n: 0 });
    sent.get(key).n++;
  }
  let total = 0;
  for (const x of sent.values()) {
    const spend = walker.spendDaily.filter((r) => r.campaignId === x.campaignId && r.date === x.date).reduce((a, r) => a + r.spend, 0);
    const walkerLeads = walker.leadsDaily.filter((r) => r.campaignId === x.campaignId && r.date === x.date).reduce((a, r) => a + r.leads, 0);
    const cpl = walkerLeads > 0 ? spend / walkerLeads : 0;
    total += x.n * cpl;
  }
  return total;
}

function buildSummaryRows(leads, program, data) {
  const total = leads.length;
  const signed = leads.filter(isSignedCase).length;
  const rejected = leads.filter((l) => /rejected/i.test(l.status || '')).length;
  const conversionRate = total > 0 ? (signed / total) * 100 : 0;
  const rows = [['Metric', 'Value', 'Detail']];
  rows.push(['Total Leads', total, '']);
  rows.push(['Signed Cases', signed, total ? `of ${total} leads` : '']);
  rows.push(['Conversion Rate', pct(conversionRate), 'signed ÷ leads']);
  rows.push(['Rejected', rejected, total ? pct((rejected / total) * 100) + ' of leads' : '']);

  if (program === 'ppl') {
    const adSpent = partnerDeduction(leads, data.walker);
    const revenue = PPL_PRICE_PER_LEAD * total;
    const profit = revenue - adSpent;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
    const cpl = total > 0 && adSpent > 0 ? adSpent / total : 0;
    const costPerCase = signed > 0 && adSpent > 0 ? adSpent / signed : 0;
    rows.push(['Revenue', money(revenue), `$${PPL_PRICE_PER_LEAD} × ${total} leads`]);
    rows.push(['Ad Spend', adSpent ? money(adSpent) : '—', "already spent in Walker's campaign on these leads"]);
    rows.push(['Profit', money(profit), `${pct(margin)} margin · revenue − ad spend`]);
    rows.push(['CPL (Cost / Lead)', cpl ? money(cpl) : '—', 'ad spend ÷ leads']);
    rows.push(['Cost / Case', costPerCase ? money(costPerCase) : '—', 'ad spend ÷ signed cases']);
  } else {
    // Own-ad spend (Google/Meta campaigns) is account-wide, not attributable to one program's
    // leads individually — same assumption app.js's renderKpis makes for the Agency tiles.
    const ownSpend = data.campaignSpend.reduce((a, r) => a + r.spend, 0);
    const partnerSpend = partnerDeduction(leads, data.walker);
    const totalSpend = ownSpend + partnerSpend;
    const cpl = total > 0 ? totalSpend / total : 0;
    const costPerCase = signed > 0 ? totalSpend / signed : 0;
    rows.push(['Ad Spend', money(totalSpend), `${money(ownSpend)} own ads + ${money(partnerSpend)} Lead Prosper`]);
    rows.push(['Cost / Lead', cpl ? money(cpl) : '—', 'ad spend ÷ leads']);
    rows.push(['Cost / Case', costPerCase ? money(costPerCase) : '—', 'ad spend ÷ signed cases']);
    rows.push(['', '', '']);
    rows.push(['Marketing fee / Ad budget left', 'See live dashboard', 'contract-schedule math, not mirrored here']);
  }
  rows.push(['', '', '']);
  rows.push(['Last updated', new Date().toISOString(), '']);
  return rows;
}

function buildLeadsRows(leads) {
  const rows = [['Date', 'Name', 'Email', 'Phone', 'Status', 'Campaign', 'Channel']];
  leads
    .slice()
    .sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''))
    .forEach((l) => {
      rows.push([l.createdDate || '', l.name || '', l.email || '', l.phone || '', l.status || '', l.campaign || '', l.channel || '']);
    });
  return rows;
}

let lastSyncAt = 0;
let inFlight = null;
async function syncSasoonessSheet(data) {
  if (Date.now() - lastSyncAt < SYNC_INTERVAL_MS) return;
  if (inFlight) return inFlight;
  lastSyncAt = Date.now();
  inFlight = (async () => {
    const pplLeads = data.leads.filter((l) => programOf(l) === 'ppl');
    const agencyLeads = data.leads.filter((l) => programOf(l) === 'agency');
    await Promise.all([
      writeSheetTab(SPREADSHEET_ID, 'PPL Summary', buildSummaryRows(pplLeads, 'ppl', data)),
      writeSheetTab(SPREADSHEET_ID, 'PPL Leads', buildLeadsRows(pplLeads)),
      writeSheetTab(SPREADSHEET_ID, 'Agency Summary', buildSummaryRows(agencyLeads, 'agency', data)),
      writeSheetTab(SPREADSHEET_ID, 'Agency Leads', buildLeadsRows(agencyLeads)),
    ]);
  })().catch((err) => {
    console.error(`[${new Date().toISOString()}] sasooness sheet sync failed:`, err.message);
  }).finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = { syncSasoonessSheet, SPREADSHEET_ID };

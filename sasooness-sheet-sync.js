// Writes a live snapshot of the Sasooness dashboard out to a Google Sheet, for anyone who'd
// rather glance at a spreadsheet than open the dashboard. Mirrors the core metrics from
// sasooness-public/app.js's renderKpis (Total Leads, Signed, Conversion Rate, Rejected, Revenue,
// Ad Spend, Profit) for both programs (PPL and Agency), plus a week-by-week trend tab (with an
// embedded line chart) and a per-lead detail tab carrying the converting ad/campaign — the same
// fields the dashboard's own lead table shows. Deliberately leaves out the Agency contract's
// monthly fee/budget-tranche proration (contractForRange/windowSpend in app.js) — that logic is
// calendar-schedule-dependent and date-range-sensitive in a way that doesn't map cleanly onto a
// single always-current snapshot; the live dashboard remains the source of truth for that.
const { writeSheetTab, upsertLineChart, setBasicFilter } = require('./sheet-writer');

const SPREADSHEET_ID = '1PCSysjKer16YHJOvLMiG8flEu4ymVjja0dxFHEYB0J0';
const SHEET_IDS = {
  'PPL Summary': 150714352,
  'PPL Lead Details': 838305441,
  'Agency Summary': 55477001,
  'Agency Lead Details': 1251385546,
  'PPL Weekly Trends': 1763630289,
  'Agency Weekly Trends': 813782328,
};
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

// Lead Details — same columns the dashboard's own lead table shows, including the converting ad.
function buildLeadDetailRows(leads) {
  const rows = [['Date', 'Name', 'Email', 'Phone', 'Status', 'Campaign', 'Converting Ad', 'Contact Source', 'Channel']];
  leads
    .slice()
    .sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''))
    .forEach((l) => {
      const o = l.origin || {};
      rows.push([
        l.createdDate || '', l.name || '', l.email || '', l.phone || '', l.status || '',
        o.campaignName || l.campaign || '', o.adName || '', o.contactSource || '', l.channel || '',
      ]);
    });
  return rows;
}

// Monday-start week-of-month, same numbering as Walker's weekOfMonthRange: the days before a
// month's first Monday still belong to "Week 1" rather than spilling into the prior month.
function weekOfMonth(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  const year = d.getFullYear(), month = d.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const dow = firstOfMonth.getDay();
  const daysToFirstMonday = dow === 1 ? 0 : (8 - dow) % 7;
  const weekIndex = Math.floor((d.getDate() - 1 - (daysToFirstMonday === 0 ? 0 : -(7 - daysToFirstMonday))) / 7);
  const monthLabel = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return { key: `${year}-${String(month + 1).padStart(2, '0')}-W${weekIndex + 1}`, label: `${monthLabel} — Week ${weekIndex + 1}`, sortKey: year * 100 + month, weekIndex };
}

function buildWeeklyTrendsRows(leads, program, data) {
  const buckets = new Map();
  for (const l of leads) {
    const w = weekOfMonth(l.createdDate);
    if (!w) continue;
    if (!buckets.has(w.key)) buckets.set(w.key, { ...w, leads: [] });
    buckets.get(w.key).leads.push(l);
  }
  const weeks = [...buckets.values()].sort((a, b) => a.sortKey - b.sortKey || a.weekIndex - b.weekIndex);

  if (program === 'ppl') {
    const rows = [['Week', 'Total Leads', 'Signed', 'Conversion Rate', 'Ad Spend', 'Revenue', 'Profit']];
    weeks.forEach((w) => {
      const total = w.leads.length;
      const signed = w.leads.filter(isSignedCase).length;
      const adSpend = partnerDeduction(w.leads, data.walker);
      const revenue = PPL_PRICE_PER_LEAD * total;
      rows.push([w.label, total, signed, total ? Math.round((signed / total) * 1000) / 10 : 0, Math.round(adSpend * 100) / 100, revenue, Math.round((revenue - adSpend) * 100) / 100]);
    });
    return rows;
  }
  const rows = [['Week', 'Total Leads', 'Signed', 'Conversion Rate', 'Ad Spend']];
  weeks.forEach((w) => {
    const total = w.leads.length;
    const signed = w.leads.filter(isSignedCase).length;
    // Own-ad spend isn't attributable to a specific week's leads (account-wide, not per-lead) —
    // only the Walker/Lead Prosper partner deduction is split by week here.
    const adSpend = partnerDeduction(w.leads, data.walker);
    rows.push([w.label, total, signed, total ? Math.round((signed / total) * 1000) / 10 : 0, Math.round(adSpend * 100) / 100]);
  });
  return rows;
}

async function syncTrendsTab(sheetTitle, rows, leftCols, rightCols) {
  await writeSheetTab(SPREADSHEET_ID, sheetTitle, rows);
  if (rows.length > 1) {
    await upsertLineChart(SPREADSHEET_ID, {
      sheetId: SHEET_IDS[sheetTitle],
      title: sheetTitle,
      rowCount: rows.length,
      startCol: 0,
      leftSeriesCols: leftCols,
      rightSeriesCols: rightCols,
    }).catch((err) => console.error(`[${new Date().toISOString()}] chart upsert failed (${sheetTitle}):`, err.message));
  }
}

async function syncLeadDetailTab(sheetTitle, rows) {
  await writeSheetTab(SPREADSHEET_ID, sheetTitle, rows);
  await setBasicFilter(SPREADSHEET_ID, SHEET_IDS[sheetTitle], rows.length, rows[0].length)
    .catch((err) => console.error(`[${new Date().toISOString()}] filter set failed (${sheetTitle}):`, err.message));
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
      writeSheetTab(SPREADSHEET_ID, 'Agency Summary', buildSummaryRows(agencyLeads, 'agency', data)),
      syncLeadDetailTab('PPL Lead Details', buildLeadDetailRows(pplLeads)),
      syncLeadDetailTab('Agency Lead Details', buildLeadDetailRows(agencyLeads)),
      // Weekly Trends columns: Week(0), Total Leads(1), Signed(2), Conversion Rate(3), Ad Spend(4)[, Revenue(5), Profit(6)]
      syncTrendsTab('PPL Weekly Trends', buildWeeklyTrendsRows(pplLeads, 'ppl', data), [1, 2], [4, 5, 6]),
      syncTrendsTab('Agency Weekly Trends', buildWeeklyTrendsRows(agencyLeads, 'agency', data), [1, 2], [4]),
    ]);
  })().catch((err) => {
    console.error(`[${new Date().toISOString()}] sasooness sheet sync failed:`, err.message);
  }).finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = { syncSasoonessSheet, SPREADSHEET_ID };

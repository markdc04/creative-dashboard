// Sasooness Law Group, APC — a client-specific view combining their leads (from two separate
// CRM export sheets) with their ad spend (Google, filtered out of the main tracker's already-
// fetched spend sheet; Meta, its own sheet shared with several other clients' campaigns).
const { csvUrl, fetchText, parseCSV, toISODate } = require('./csv-utils');
const { metaDailyFor } = require('./meta-spend');

// Raw lead intake log — the simpler of the two sheets (Date/Name/Email/Phone/Lead Status).
const LEADS_A_DOC_ID = '1syy62rEp85sIQoM8D69C7btrs1TsXV_NeOb8QkUWJd8';
const LEADS_A_GID = '0';

// CRM-tracked leads with case management detail (Status/SubStatus/Case Type/Signed Up Date) —
// used as the primary record whenever a lead appears in both sheets.
const LEADS_B_DOC_ID = '1lQLiBZRZ93cgc1KVCFbgHT_EoCibGvjwOstkQ6runG8';
const LEADS_B_GID = '1001225302';

const CAMPAIGN_PATTERN = /sasoon/i;

let cache = { leads: [], googleDaily: [], metaDaily: [], updatedAt: null };

function normEmail(v) { return String(v || '').trim().toLowerCase(); }

function mergeLeads(rowsA, rowsB) {
  const byEmail = new Map();
  for (const r of rowsB) {
    const email = normEmail(r['Email']);
    if (!email) continue;
    byEmail.set(email, {
      email,
      name: r['Full Name'] || '',
      phone: r['Mobile Phone'] || '',
      createdDate: toISODate(r['Created Date']),
      signedUpDate: toISODate(r['Signed Up Date']),
      caseType: r['Case Type'] || '',
      status: r['Status'] || '',
      subStatus: r['SubStatus'] || '',
      state: r['State'] || '',
      caseLocation: r['State  Case Location'] || r['State Case Location'] || '',
      severity: r['Severity Level'] || '',
      caseGrade: r['Case Grade'] || '',
      marketingSource: r['Marketing Source'] || '',
      opportunityId: '',
      source: 'crm',
    });
  }
  let filledFromIntake = 0;
  for (const r of rowsA) {
    const email = normEmail(r['Email']);
    if (!email) continue;
    const existing = byEmail.get(email);
    if (existing) {
      if (!existing.opportunityId) existing.opportunityId = r['Opportunity ID (Lead Docket)'] || '';
      continue;
    }
    filledFromIntake++;
    byEmail.set(email, {
      email,
      name: r['Name'] || '',
      phone: r['Phone'] || '',
      createdDate: toISODate(r['Date']),
      signedUpDate: '',
      caseType: '',
      status: r['Lead Status'] || '',
      subStatus: r['Reason for Rejection'] || '',
      state: '',
      caseLocation: '',
      severity: '',
      caseGrade: '',
      marketingSource: '',
      opportunityId: r['Opportunity ID (Lead Docket)'] || '',
      source: 'intake',
    });
  }
  return { leads: [...byEmail.values()], filledFromIntake };
}

// Called by the main server's own poll with its already-fetched, already-joined per-day-per-ad
// rows — filtered down to Sasooness's Google campaigns and re-aggregated by day.
function updateGoogleSpend(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (r.platform !== 'GOOGLE' || !CAMPAIGN_PATTERN.test(r.campaignName || '')) continue;
    byDate.set(r.date, (byDate.get(r.date) || 0) + r.spend);
  }
  cache.googleDaily = [...byDate.entries()].map(([date, spend]) => ({ date, spend: Math.round(spend * 100) / 100 })).sort((a, b) => a.date < b.date ? -1 : 1);
  cache.updatedAt = Date.now();
}

async function fetchMetaDaily() { return metaDailyFor(CAMPAIGN_PATTERN); }

async function pollAll() {
  try {
    const [csvA, csvB, metaDaily] = await Promise.all([
      fetchText(csvUrl(LEADS_A_GID, LEADS_A_DOC_ID)),
      fetchText(csvUrl(LEADS_B_GID, LEADS_B_DOC_ID)),
      fetchMetaDaily(),
    ]);
    const rowsA = parseCSV(csvA);
    const rowsB = parseCSV(csvB);
    if (rowsA.length < 10 || rowsB.length < 10) {
      console.warn(`[${new Date().toISOString()}] Sasooness leads sheet looks broken (A=${rowsA.length}, B=${rowsB.length} rows) — keeping last known-good leads`);
    } else {
      const { leads } = mergeLeads(rowsA, rowsB);
      cache.leads = leads;
    }
    cache.metaDaily = metaDaily;
    cache.updatedAt = Date.now();
  } catch (err) {
    console.error('Sasooness poll error:', err.message);
  }
}

function getData() {
  return { leads: cache.leads, googleDaily: cache.googleDaily, metaDaily: cache.metaDaily, updatedAt: cache.updatedAt };
}

module.exports = { pollAll, updateGoogleSpend, getData };

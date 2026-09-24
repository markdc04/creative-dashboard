// Sasooness Law Group, APC — a client-specific view combining their leads (a CRM export plus
// three intake tabs, one per lead source) with their ad spend per campaign (Google, filtered out
// of the main tracker's already-fetched spend; Meta, from the shared export) and per-campaign
// lead counts (from the UTM tags on the ALL LEADS tab).
const { csvUrl, fetchText, parseCSV, toISODate } = require('./csv-utils');
const { metaDailyFor, metaCampaignDailyFor } = require('./meta-spend');

// Intake workbook — one tab per lead source:
//   OG              leads from the main landing page (the paid-ad campaigns)
//   Lead Prosper AZ leads bought via Walker Agency's AZ lead flow, some of which go to Sasooness
//   Lead Prosper WA Sasooness's pay-per-lead (PPL) model
const INTAKE_DOC_ID = '1syy62rEp85sIQoM8D69C7btrs1TsXV_NeOb8QkUWJd8';
const INTAKE_TABS = [
  { channel: 'OG', gid: '0' },
  { channel: 'Lead Prosper AZ', gid: '691201289' },
  { channel: 'Lead Prosper WA', gid: '541453763' },
];

// CRM-tracked leads with case management detail (Status/SubStatus/Case Type/Signed Up Date).
const LEADS_B_DOC_ID = '1lQLiBZRZ93cgc1KVCFbgHT_EoCibGvjwOstkQ6runG8';
const LEADS_B_GID = '1001225302';

// The workbook whose ALL LEADS tab tags every lead with the UTM campaign it came from.
const WORKBOOK_ID = '1rYN9P0oVlEwlxpk53ZqDDGIcZ9154bm-k709KUMIT_A';
const ALL_LEADS_GID = '1706081278';

// Loose on purpose: the same client is spelled "Sasooness" and "Sassooness" across campaigns.
const CAMPAIGN_PATTERN = /sas+oo?n/i;

// CRM marketing-source codes that identify a lead source. Every lead on the OG intake tab carries
// LS004 in the CRM, so a CRM lead with that code but no intake-tab match is still an OG lead.
const SOURCE_CODES = { LS004: 'OG' };

let cache = {
  leads: [], googleDaily: [], metaDaily: [], googleCampaignDaily: [], metaCampaignDaily: [],
  campaignByEmail: new Map(), updatedAt: null,
};

function normEmail(v) { return String(v || '').trim().toLowerCase(); }

function mergeLeads(intakeSets, rowsB) {
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
      channel: '',
      source: 'crm',
    });
  }
  for (const { channel, rows } of intakeSets) {
    for (const r of rows) {
      const email = normEmail(r['Email']);
      if (!email) continue;
      // A row marked "test" is a system test, not a real lead.
      if ((r['Reason for Rejection'] || '').trim().toLowerCase() === 'test') continue;
      const existing = byEmail.get(email);
      if (existing) {
        if (!existing.channel) existing.channel = channel;
        if (!existing.opportunityId) existing.opportunityId = r['Opportunity ID (Lead Docket)'] || '';
        continue;
      }
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
        channel,
        source: 'intake',
      });
    }
  }
  const leads = [...byEmail.values()];
  for (const l of leads) if (!l.channel && SOURCE_CODES[l.marketingSource]) l.channel = SOURCE_CODES[l.marketingSource];
  return leads;
}

// Called by the main server's own poll with its already-fetched, already-joined per-day-per-ad
// rows — filtered down to Sasooness's Google campaigns and re-aggregated by day and by campaign.
function updateGoogleSpend(rows) {
  const byDate = new Map();
  const byCampaign = new Map();
  for (const r of rows) {
    if (r.platform !== 'GOOGLE' || !CAMPAIGN_PATTERN.test(r.campaignName || '')) continue;
    byDate.set(r.date, (byDate.get(r.date) || 0) + r.spend);
    const key = r.campaignName + '|' + r.date;
    const cur = byCampaign.get(key) || { campaign: r.campaignName, campaignId: r.campaignId || '', date: r.date, spend: 0 };
    cur.spend += r.spend;
    byCampaign.set(key, cur);
  }
  const round = (n) => Math.round(n * 100) / 100;
  cache.googleDaily = [...byDate.entries()].map(([date, spend]) => ({ date, spend: round(spend) })).sort((a, b) => (a.date < b.date ? -1 : 1));
  cache.googleCampaignDaily = [...byCampaign.values()].map((r) => ({ ...r, spend: round(r.spend) }));
  cache.updatedAt = Date.now();
}

// The UTM campaign tag for each lead on the ALL LEADS tab, by email (earliest entry wins), so
// every lead in the merged list can be tied to the campaign that produced it.
function parseCampaignTags(csv) {
  const first = new Map();
  for (const r of parseCSV(csv)) {
    if (!CAMPAIGN_PATTERN.test(r['Sub account'] || '')) continue;
    const date = toISODate(r['Date']);
    const email = normEmail(r['Email']);
    if (!date || !email) continue;
    const cur = first.get(email);
    if (!cur || date < cur.date) first.set(email, { date, utm: (r['UTM Campaign'] || '').trim() });
  }
  return new Map([...first.entries()].map(([email, v]) => [email, v.utm]));
}

// UTM tags are a campaign ID for Google, and either the campaign name or ID for Meta. Resolve
// to the campaign's name; anything else non-empty keeps its own label, empty is unattributed.
function campaignResolver() {
  const names = new Map(); // lower-cased name -> name
  const ids = new Map(); // id -> name
  for (const r of [...cache.googleCampaignDaily, ...cache.metaCampaignDaily]) {
    names.set(r.campaign.toLowerCase(), r.campaign);
    if (r.campaignId) ids.set(r.campaignId, r.campaign);
  }
  return (utm) => (!utm ? '' : names.get(utm.toLowerCase()) || ids.get(utm) || utm);
}

async function pollAll() {
  try {
    const [intakeCsvs, csvB, allLeadsCsv, metaDaily, metaCampaignDaily] = await Promise.all([
      Promise.all(INTAKE_TABS.map((t) => fetchText(csvUrl(t.gid, INTAKE_DOC_ID)))),
      fetchText(csvUrl(LEADS_B_GID, LEADS_B_DOC_ID)),
      fetchText(csvUrl(ALL_LEADS_GID, WORKBOOK_ID)),
      metaDailyFor(CAMPAIGN_PATTERN),
      metaCampaignDailyFor(CAMPAIGN_PATTERN),
    ]);
    const intakeSets = INTAKE_TABS.map((t, i) => ({ channel: t.channel, rows: parseCSV(intakeCsvs[i]) }));
    const rowsB = parseCSV(csvB);
    if (intakeSets[0].rows.length < 10 || rowsB.length < 10) {
      console.warn(`[${new Date().toISOString()}] Sasooness leads sheet looks broken (OG=${intakeSets[0].rows.length}, CRM=${rowsB.length} rows) — keeping last known-good leads`);
    } else {
      cache.leads = mergeLeads(intakeSets, rowsB);
    }
    const campaignByEmail = parseCampaignTags(allLeadsCsv);
    if (campaignByEmail.size >= 30) cache.campaignByEmail = campaignByEmail;
    cache.metaDaily = metaDaily;
    cache.metaCampaignDaily = metaCampaignDaily;
    cache.updatedAt = Date.now();
  } catch (err) {
    console.error('Sasooness poll error:', err.message);
  }
}

function getData() {
  const campaignSpend = [
    ...cache.googleCampaignDaily.map((r) => ({ campaign: r.campaign, platform: 'Google', date: r.date, spend: r.spend })),
    ...cache.metaCampaignDaily.map((r) => ({ campaign: r.campaign, platform: 'Meta', date: r.date, spend: r.spend })),
  ];
  const resolve = campaignResolver();
  const leads = cache.leads.map((l) => ({ ...l, campaign: resolve(cache.campaignByEmail.get(l.email) || '') }));
  return {
    leads, googleDaily: cache.googleDaily, metaDaily: cache.metaDaily,
    campaignSpend, updatedAt: cache.updatedAt,
  };
}

module.exports = { pollAll, updateGoogleSpend, getData };

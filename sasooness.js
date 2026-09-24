// Sasooness Law Group, APC — a client-specific view combining their leads (a CRM export plus
// three intake tabs, one per lead source) with their ad spend per campaign (Google, filtered out
// of the main tracker's already-fetched spend; Meta, from the shared export) and per-campaign
// lead counts (from the UTM tags on the ALL LEADS tab).
const { csvUrl, fetchText, parseCSV, toISODate, phone10 } = require('./csv-utils');
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
  campaignTags: { byEmail: new Map(), byPhone: new Map() }, updatedAt: null,
};

function isSigned(status) { const s = (status || '').trim(); return s === 'Signed Up' || s === 'Client'; }
function normEmail(v) { return String(v || '').trim().toLowerCase(); }

// The same person often turns up under two emails (a work and a personal one) with one phone
// number, so people are matched on email OR phone. When two records are the same person the one
// with the most case detail is kept (a signed case beats a plain lead), and every email seen for
// them is remembered so their campaign tag can still be found.
function mergeLeads(intakeSets, rowsB) {
  const people = [];
  const byEmail = new Map();
  const byPhone = new Map();
  const rank = (l) => (isSigned(l.status) ? 2 : l.source === 'crm' ? 1 : 0);

  function place(lead) {
    const phone = phone10(lead.phone);
    const existing = (lead.email && byEmail.get(lead.email)) || (phone && byPhone.get(phone)) || null;
    if (!existing) {
      lead.emails = lead.email ? [lead.email] : [];
      people.push(lead);
      if (lead.email) byEmail.set(lead.email, lead);
      if (phone) byPhone.set(phone, lead);
      return lead;
    }
    // Same person: keep the richer record, but never lose the channel, IDs, emails or phone.
    const keep = rank(lead) > rank(existing) ? lead : existing;
    const other = keep === lead ? existing : lead;
    if (keep === lead) {
      lead.emails = existing.emails;
      people[people.indexOf(existing)] = lead;
    }
    if (lead.email && !keep.emails.includes(lead.email)) keep.emails.push(lead.email);
    if (!keep.channel) keep.channel = other.channel;
    if (!keep.opportunityId) keep.opportunityId = other.opportunityId;
    if (!keep.phone) keep.phone = other.phone;
    if (!keep.name || keep.name.toLowerCase() === 'no name') keep.name = other.name;
    if (!keep.email) keep.email = other.email;
    for (const e of keep.emails) byEmail.set(e, keep);
    const kp = phone10(keep.phone); if (kp) byPhone.set(kp, keep);
    if (phone) byPhone.set(phone, keep);
    return keep;
  }

  for (const r of rowsB) {
    const email = normEmail(r['Email']);
    if (!email && !phone10(r['Mobile Phone'])) continue;
    place({
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
      if (!email && !phone10(r['Phone'])) continue;
      // A row marked "test" is a system test, not a real lead.
      if ((r['Reason for Rejection'] || '').trim().toLowerCase() === 'test') continue;
      place({
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
  const leads = people;
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
  const byEmail = new Map();
  const byPhone = new Map();
  const seen = new Map(); // earliest date per key, so the earliest entry wins
  for (const r of parseCSV(csv)) {
    if (!CAMPAIGN_PATTERN.test(r['Sub account'] || '')) continue;
    const date = toISODate(r['Date']);
    const email = normEmail(r['Email']);
    const phone = phone10(r['Phone']);
    if (!date || (!email && !phone)) continue;
    const utm = (r['UTM Campaign'] || '').trim();
    if (email && (!seen.has('e' + email) || date < seen.get('e' + email))) { seen.set('e' + email, date); byEmail.set(email, utm); }
    if (phone && (!seen.has('p' + phone) || date < seen.get('p' + phone))) { seen.set('p' + phone, date); byPhone.set(phone, utm); }
  }
  return { byEmail, byPhone };
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
    const campaignTags = parseCampaignTags(allLeadsCsv);
    if (campaignTags.byEmail.size >= 30) cache.campaignTags = campaignTags;
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
  const tagFor = (l) => {
    for (const e of l.emails || [l.email]) { const t = cache.campaignTags.byEmail.get(e); if (t) return t; }
    return cache.campaignTags.byPhone.get(phone10(l.phone)) || '';
  };
  const leads = cache.leads.map(({ emails, ...l }) => ({ ...l, campaign: resolve(tagFor({ emails, email: l.email, phone: l.phone })) }));
  return {
    leads, googleDaily: cache.googleDaily, metaDaily: cache.metaDaily,
    campaignSpend, updatedAt: cache.updatedAt,
  };
}

module.exports = { pollAll, updateGoogleSpend, getData };

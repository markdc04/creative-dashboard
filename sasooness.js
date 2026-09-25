// Sasooness Law Group, APC — a client-specific view combining their leads (a CRM export plus
// three intake tabs, one per lead source) with their ad spend per campaign (Google, filtered out
// of the main tracker's already-fetched spend; Meta, from the shared export) and per-campaign
// lead counts (from the UTM tags on the ALL LEADS tab).
const { csvUrl, fetchText, parseCSV, parseCSVRows, num, toISODate, phone10 } = require('./csv-utils');
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
// The workbook's Sasooness tab holds the contract's monthly ad budget and marketing fee; the ALL
// CLIENT CASES tab lists Sasooness's signed cases, marking the ones that later dropped.
const SASOONESS_TAB_GID = '1617897274';
const ALL_CASES_GID = '722868032';

// Walker Agency's master lead log. Agency and PPL leads are Walker campaign leads that get passed
// on to Sasooness, so this is where each one's contact source, Google campaign and ad are recorded
// (UTM Campaign = Google campaign ID, UTM Term = Google ad ID). Read by tab name.
const WALKER_DOC_ID = '1vKenNfW_B8c_438CeF7LukFPNqzPjflJTFo9zB_3Knw';
const WALKER_LOG_TAB = 'Walker agency ppl 6 states';

// Loose on purpose: the same client is spelled "Sasooness" and "Sassooness" across campaigns.
const CAMPAIGN_PATTERN = /sas+oo?n/i;

// CRM marketing-source codes that identify a lead source. Every lead on the OG intake tab carries
// LS004 in the CRM, so a CRM lead with that code but no intake-tab match is still an OG lead.
const SOURCE_CODES = { LS004: 'OG' };

let cache = {
  leads: [], googleDaily: [], metaDaily: [], googleCampaignDaily: [], metaCampaignDaily: [],
  campaignTags: { byEmail: new Map(), byPhone: new Map() }, schedule: [], droppedEmails: new Set(), walkerLog: [], agencySpend: [], adNames: new Map(), campaignNames: new Map(), updatedAt: null,
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
  // Names for the IDs Walker's log carries, and Walker's own agency campaigns' daily spend.
  const adNames = new Map(), campaignNames = new Map(), agency = new Map();
  for (const r of rows) {
    if (r.platform !== 'GOOGLE') continue;
    if (r.adId && r.adName) adNames.set(String(r.adId), r.adName);
    if (r.campaignId && r.campaignName) campaignNames.set(String(r.campaignId), r.campaignName);
    if (/agency/i.test(r.campaignName || '') && r.campaignId) {
      const key = r.campaignId + '|' + r.date;
      agency.set(key, { campaignId: String(r.campaignId), date: r.date, spend: (agency.get(key)?.spend || 0) + r.spend });
    }
  }
  cache.adNames = adNames;
  cache.campaignNames = campaignNames;
  cache.agencySpend = [...agency.values()].map((r) => ({ ...r, spend: round(r.spend) }));
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
    const tag = { utm: (r['UTM Campaign'] || '').trim(), source: (r['Contact Source (survey)'] || '').trim(), term: (r['UTM Term'] || '').trim() };
    if (email && (!seen.has('e' + email) || date < seen.get('e' + email))) { seen.set('e' + email, date); byEmail.set(email, tag); }
    if (phone && (!seen.has('p' + phone) || date < seen.get('p' + phone))) { seen.set('p' + phone, date); byPhone.set(phone, tag); }
  }
  return { byEmail, byPhone };
}


// The Sasooness tab lists each month with its ad budget and marketing fee side by side:
//   Jan | $10,000.00 | $6,000.00   ...   May | $20,000.00 | $12,000.00
// so look for a month name followed by two dollar amounts. A month typed twice (the sheet has July
// twice) counts once, first entry wins. The sheet doesn't state a year; months run in order from
// the contract's start, so the year advances whenever the month number steps back.
const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
function parseSchedule(csv) {
  const seen = new Map(); // month number -> { budget, fee }
  const order = [];
  for (const row of parseCSVRows(csv)) {
    for (let c = 0; c < row.length - 2; c++) {
      const m = MONTHS[(row[c] || '').trim().toLowerCase()];
      if (!m || !/\$/.test(row[c + 1] || '') || !/\$/.test(row[c + 2] || '')) continue;
      const budget = num(row[c + 1]), fee = num(row[c + 2]);
      if (budget > 0 && fee >= 0 && !seen.has(m)) { seen.set(m, { budget, fee }); order.push(m); }
      break;
    }
  }
  let year = 2026, prev = 0;
  return order.map((m) => { if (m < prev) year++; prev = m; return { month: year + '-' + String(m).padStart(2, '0'), ...seen.get(m) }; });
}

// Signed cases that later dropped are marked DROPPED where the conversion date would be. The
// Sasooness block is columns J-S of ALL CLIENT CASES (other clients sit either side of it).
function parseDropped(csv) {
  const out = new Set();
  for (const r of parseCSVRows(csv).slice(2)) {
    const block = r.slice(9, 19);
    const email = normEmail(block[3]);
    if (email && /dropped/i.test(block[0] || '') && !toISODate(block[0])) out.add(email);
  }
  return out;
}

// One entry per row of Walker's lead log, reduced to what the origin tables need.
function parseWalkerLog(csv) {
  return parseCSV(csv).map((r) => ({
    date: toISODate(r['Date']),
    email: normEmail(r['Email']),
    phone: phone10(r['Phone']),
    source: (r['Contact Source'] || '').trim(),
    campaignId: (r['UTM Campaign'] || '').trim(),
    adId: (r['UTM Term'] || '').trim(),
    status: (r['Accurate Status'] || r['Status'] || '').trim(),
  })).filter((r) => r.date && (r.email || r.phone));
}

// Where an Agency/PPL lead came from: the earliest row for that person in Walker's log (the row
// that first brought them in from an ad).
function walkerOrigin(lead, byEmail, byPhone) {
  const hits = [];
  for (const e of lead.emails || [lead.email]) if (byEmail.has(e)) hits.push(...byEmail.get(e));
  const p = phone10(lead.phone);
  if (p && byPhone.has(p)) hits.push(...byPhone.get(p));
  if (!hits.length) return null;
  const first = hits.reduce((a, b) => (b.date < a.date ? b : a));
  return {
    walkerDate: first.date,
    contactSource: first.source,
    campaignId: first.campaignId,
    campaignName: cache.campaignNames.get(first.campaignId) || '',
    adId: first.adId,
    adName: cache.adNames.get(first.adId) || '',
    walkerStatus: first.status,
  };
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
    const [intakeCsvs, csvB, allLeadsCsv, tabCsv, casesCsv, walkerCsv, metaDaily, metaCampaignDaily] = await Promise.all([
      Promise.all(INTAKE_TABS.map((t) => fetchText(csvUrl(t.gid, INTAKE_DOC_ID)))),
      fetchText(csvUrl(LEADS_B_GID, LEADS_B_DOC_ID)),
      fetchText(csvUrl(ALL_LEADS_GID, WORKBOOK_ID)),
      fetchText(csvUrl(SASOONESS_TAB_GID, WORKBOOK_ID)),
      fetchText(csvUrl(ALL_CASES_GID, WORKBOOK_ID)),
      fetchText('https://docs.google.com/spreadsheets/d/' + WALKER_DOC_ID + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(WALKER_LOG_TAB)),
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
    const schedule = parseSchedule(tabCsv);
    if (schedule.length >= 3) cache.schedule = schedule; else console.warn(`[${new Date().toISOString()}] Sasooness fee/budget schedule not found (${schedule.length} months) — keeping last known-good`);
    const dropped = parseDropped(casesCsv);
    if (casesCsv.trimStart().startsWith('<')) console.warn(`[${new Date().toISOString()}] Sasooness signed-cases tab not readable — keeping last known-good dropped list`); else cache.droppedEmails = dropped;
    const walkerLog = parseWalkerLog(walkerCsv);
    if (walkerLog.length >= 100) cache.walkerLog = walkerLog; else console.warn(`[${new Date().toISOString()}] Walker lead log looks broken (${walkerLog.length} rows) — keeping last known-good`);
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
  const tagsFor = (l) => {
    for (const e of l.emails || [l.email]) { const t = cache.campaignTags.byEmail.get(e); if (t && t.utm) return t; }
    for (const e of l.emails || [l.email]) { const t = cache.campaignTags.byEmail.get(e); if (t) return t; }
    return cache.campaignTags.byPhone.get(phone10(l.phone)) || null;
  };
  // An OG lead's ad: Google tags carry the ad ID (resolved to its name); Meta tags carry the ad name.
  const ogOrigin = (tags, campaign) => ({
    contactSource: tags ? tags.source : '',
    campaignId: '',
    campaignName: campaign,
    adId: tags && /^\d{6,}$/.test(tags.term) ? tags.term : '',
    adName: tags ? (/^\d{6,}$/.test(tags.term) ? cache.adNames.get(tags.term) || '' : tags.term) : '',
  });
  // A signed case that later dropped is no longer a case, so it reads as Dropped everywhere.
  const wByEmail = new Map(), wByPhone = new Map();
  for (const w of cache.walkerLog) {
    if (w.email) (wByEmail.get(w.email) || wByEmail.set(w.email, []).get(w.email)).push(w);
    if (w.phone) (wByPhone.get(w.phone) || wByPhone.set(w.phone, []).get(w.phone)).push(w);
  }
  const leads = cache.leads.map(({ emails, ...l }) => {
    const dropped = isSigned(l.status) && (emails || [l.email]).some((e) => cache.droppedEmails.has(e));
    const partner = l.channel === 'Lead Prosper AZ' || l.channel === 'Lead Prosper WA';
    const tags = tagsFor({ emails, email: l.email, phone: l.phone });
    const campaign = resolve(tags ? tags.utm : '');
    return {
      ...l, status: dropped ? 'Dropped' : l.status, campaign,
      origin: partner ? walkerOrigin({ emails, email: l.email, phone: l.phone }, wByEmail, wByPhone) : ogOrigin(tags, campaign),
    };
  });

  // For the deduction table: for every Walker campaign an Agency/PPL lead came from, that
  // campaign's daily spend and daily lead counts (all leads, and qualified ones) from Walker's log.
  const usedCampaigns = new Set(leads.filter((l) => l.origin && l.origin.campaignId).map((l) => l.origin.campaignId));
  const leadsByDay = new Map();
  for (const w of cache.walkerLog) {
    if (!usedCampaigns.has(w.campaignId)) continue;
    const key = w.campaignId + '|' + w.date;
    const cur = leadsByDay.get(key) || { campaignId: w.campaignId, date: w.date, leads: 0, qualified: 0 };
    cur.leads++;
    if (/^qualified$/i.test(w.status)) cur.qualified++;
    leadsByDay.set(key, cur);
  }
  const walker = {
    campaigns: [...usedCampaigns].map((id) => ({ campaignId: id, name: cache.campaignNames.get(id) || id })),
    spendDaily: cache.agencySpend.filter((r) => usedCampaigns.has(r.campaignId)),
    leadsDaily: [...leadsByDay.values()],
  };
  return {
    leads, googleDaily: cache.googleDaily, metaDaily: cache.metaDaily,
    campaignSpend, walker, settings: { schedule: cache.schedule }, updatedAt: cache.updatedAt,
  };
}

module.exports = { pollAll, updateGoogleSpend, getData };

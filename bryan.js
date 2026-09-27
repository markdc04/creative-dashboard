// Bryan Rodriguez — a PPL-only client (no campaigns of his own; his leads are bought out of a
// shared pool of Loudr's own Texas Google campaigns, the same way Sasooness's Lead Prosper WA
// leads are). His own CRM sheet has no clean status column (just freeform call notes), and
// Walker's PPL delivery log has no email for most rows, so leads are joined to their source
// campaign by name + phone, cross-checked against the date, rather than by email like the other
// clients.
const { csvUrl, fetchText, parseCSV, num, toISODate, phone10 } = require('./csv-utils');

// Bryan's own lead CRM — Date, Name, Email, Phone, Lead Status (freeform notes), Reason for Rejection.
const CRM_DOC_ID = '1MUmkf6RxSv_9SC_drPRbExezLiePGoORQb2lulJFLaE';
const CRM_GID = '0';

// Walker's PPL delivery log ("Walker PPL" tab) — every lead Walker's shared Texas PPL campaigns
// produced, for every buyer, with the campaign/ad that produced it and Walker's own qualified flag.
const WALKER_DOC_ID = '1gjJLZH8O_xZ7AlIX0UXWMazZxF-qsk8aK-yYvwm_hJw';
const WALKER_GID = '1067474187';

const START_DATE = '2026-08-03'; // Bryan started on this date.

let cache = {
  leads: [], walkerLog: [], walkerLeadsDaily: [], spendDaily: [],
  campaignNames: new Map(), usedCampaignIds: new Set(), updatedAt: null,
};

function normName(v) { return String(v || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); }

// The CRM's "Lead Status" is call-log notes, not a clean status, so it's read for these two
// signals only; anything else stays as free text for the lead-details table.
function classifyStatus(note) {
  const s = (note || '').toLowerCase();
  if (/\bsign/.test(s)) return 'Signed';
  if (/reject|passed sol|represented by another attorney|already has an attorney/.test(s)) return 'Rejected';
  return note ? 'In Progress' : 'Awaiting Contact';
}

function parseLeads(csv) {
  return parseCSV(csv)
    .map((r) => {
      const note = (r['Lead Status'] || '').trim();
      return {
        name: (r['Name'] || '').trim(),
        email: (r['Email'] || '').trim().toLowerCase(),
        phone: (r['Phone'] || '').trim(),
        createdDate: toISODate(r['Date']),
        status: classifyStatus(note),
        note,
        reason: (r['Reason for Rejection'] || '').trim(),
      };
    })
    .filter((l) => l.createdDate && l.createdDate >= START_DATE && (l.name || l.email));
}

// One entry per Walker PPL log row, reduced to what the join and the daily counts need.
function parseWalkerLog(csv) {
  return parseCSV(csv)
    .map((r) => ({
      date: toISODate(r['Date']),
      name: normName(r['Name']),
      phone: phone10(r['Phone']),
      source: (r['Contact Source'] || '').trim(),
      campaignId: (r['UTM Campaign'] || '').trim(),
      adId: (r['UTM Content'] || '').trim(),
      qualified: /^qualified$/i.test((r['Qualified'] || r['Formulated Status'] || '').trim()),
    }))
    .filter((r) => r.date && r.name);
}

// Where a lead came from: matched by name within 3 days of the CRM date (verified against phone
// where both sides have one — 110 of 111 candidate matches agreed on phone during testing, so a
// name+date match without a phone to check is trusted too), earliest candidate wins ties.
function findOrigin(lead, byName) {
  const candidates = (byName.get(normName(lead.name)) || []).filter(
    (w) => Math.abs((new Date(w.date) - new Date(lead.createdDate)) / 86400000) <= 3
  );
  if (!candidates.length) return null;
  const phone = phone10(lead.phone);
  const byPhone = phone && candidates.find((w) => w.phone === phone);
  const w = byPhone || candidates.reduce((a, b) => (b.date < a.date ? b : a));
  return { campaignId: w.campaignId, campaignName: cache.campaignNames.get(w.campaignId) || '', contactSource: w.source, walkerDate: w.date };
}

// Called by the main server's own poll with its already-fetched, already-joined per-day-per-ad
// rows — filtered to whichever Google campaigns Bryan's leads have been traced to.
function updateGoogleSpend(rows) {
  const names = new Map();
  for (const r of rows) if (r.campaignId && r.campaignName) names.set(String(r.campaignId), r.campaignName);
  cache.campaignNames = names;
  const ids = cache.usedCampaignIds;
  const byKey = new Map();
  for (const r of rows) {
    if (r.platform !== 'GOOGLE' || !ids.has(String(r.campaignId))) continue;
    const key = r.campaignId + '|' + r.date;
    const cur = byKey.get(key) || { campaignId: String(r.campaignId), date: r.date, spend: 0 };
    cur.spend += r.spend;
    byKey.set(key, cur);
  }
  cache.spendDaily = [...byKey.values()].map((r) => ({ ...r, spend: Math.round(r.spend * 100) / 100 }));
  cache.updatedAt = Date.now();
}

async function pollAll() {
  try {
    const [crmCsv, walkerCsv] = await Promise.all([
      fetchText(csvUrl(CRM_GID, CRM_DOC_ID)),
      fetchText(csvUrl(WALKER_GID, WALKER_DOC_ID)),
    ]);
    const leads = parseLeads(crmCsv);
    if (leads.length < 20) { console.warn(`[${new Date().toISOString()}] Bryan CRM sheet looks broken (${leads.length} leads) — keeping last known-good`); return; }
    const walkerLog = parseWalkerLog(walkerCsv);
    if (walkerLog.length < 1000) { console.warn(`[${new Date().toISOString()}] Walker PPL log looks broken (${walkerLog.length} rows) — keeping last known-good`); return; }

    const byName = new Map();
    for (const w of walkerLog) { if (!byName.has(w.name)) byName.set(w.name, []); byName.get(w.name).push(w); }

    const usedCampaignIds = new Set();
    const withOrigin = leads.map((l) => {
      const origin = findOrigin(l, byName);
      if (origin && origin.campaignId) usedCampaignIds.add(origin.campaignId);
      return { ...l, origin };
    });

    const leadsByDay = new Map();
    for (const w of walkerLog) {
      if (!usedCampaignIds.has(w.campaignId)) continue;
      const key = w.campaignId + '|' + w.date;
      const cur = leadsByDay.get(key) || { campaignId: w.campaignId, date: w.date, leads: 0, qualified: 0 };
      cur.leads++;
      if (w.qualified) cur.qualified++;
      leadsByDay.set(key, cur);
    }

    cache.leads = withOrigin;
    cache.walkerLeadsDaily = [...leadsByDay.values()];
    cache.usedCampaignIds = usedCampaignIds;
    cache.updatedAt = Date.now();
  } catch (err) {
    console.error('Bryan poll error:', err.message);
  }
}

function getData() {
  const campaigns = [...cache.usedCampaignIds].map((id) => ({ campaignId: id, name: cache.campaignNames.get(id) || id }));
  return {
    leads: cache.leads, walker: { campaigns, leadsDaily: cache.walkerLeadsDaily, spendDaily: cache.spendDaily },
    updatedAt: cache.updatedAt,
  };
}

module.exports = { pollAll, updateGoogleSpend, getData };

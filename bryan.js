// Bryan Rodriguez — a PPL-only client (no campaigns of his own; his leads are bought out of a
// shared pool of Loudr's own Texas Google campaigns, the same way Sasooness's Lead Prosper WA
// leads are). His own CRM sheet has no clean status column (just freeform call notes), and
// Walker's PPL delivery log has no email for most rows, so leads are joined to their source
// campaign by name + phone, cross-checked against the date, rather than by email like the other
// clients.
const { csvUrl, fetchText, parseCSV, parseCSVRows, num, toISODate, phone10 } = require('./csv-utils');
const { readColumnColors } = require('./xlsx-lite');

// Bryan's own lead CRM — Date, Name, Email, Phone, Lead Status (freeform notes), Reason for Rejection.
const CRM_DOC_ID = '1MUmkf6RxSv_9SC_drPRbExezLiePGoORQb2lulJFLaE';
const CRM_GID = '0';

// Walker's PPL delivery log ("Walker PPL" tab) — every lead Walker's shared Texas PPL campaigns
// produced, for every buyer, with the campaign/ad that produced it and Walker's own qualified flag.
const WALKER_DOC_ID = '1gjJLZH8O_xZ7AlIX0UXWMazZxF-qsk8aK-yYvwm_hJw';
const WALKER_GID = '1067474187';

// Google Ads export with ad names, keyed by the same Ad ID the Walker log's UTM Term carries.
const AD_NAMES_DOC_ID = '1u0jJNfvnWZQsBaC6lmn0vhabtNuwI1yS0WchV2WYnAs';

const START_DATE = '2026-08-03'; // Bryan started on this date.

// Leads confirmed by hand (in GoHighLevel) to be genuinely organic — see the note in pollAll.
const ORGANIC_OVERRIDES = [{ name: 'Linda Parfait', createdDate: '2026-08-04' }];

let cache = {
  leads: [], walkerLog: [], walkerLeadsDaily: [], spendDaily: [],
  campaignNames: new Map(), adNames: new Map(), usedCampaignIds: new Set(), statusColorByRow: new Map(), updatedAt: null,
};

function normName(v) { return String(v || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); }

// The CRM's "Lead Status" is call-log notes, not a clean status column — but the team already
// color-codes that cell by hand (green = signed, red = rejected, black/default = still being
// worked), which the CSV/gviz exports Loudr otherwise reads from strip out entirely. Read from
// the sheet's .xlsx export instead, which does carry cell formatting. Text-keyword matching was
// tried first and undercounted real signings (a lead can say "PENDING CONTRACT" and be marked
// green) and missed real rejections with no "reject"-shaped wording at all — color is what the
// team actually means, text is not a reliable proxy for it.
function classifyByColor(color) {
  if (color === '34A853') return 'Signed';
  if (color === 'FF0000') return 'Rejected';
  return 'Reviewing';
}

// One-time historical correction, not a recurring rule: of the 70 leads delivered Aug 3-5 (his
// launch batch), the first 13 in the sheet were the tail end of a prior deal's balance, not new
// leads Bryan owes for; the 6 leads Aug 17-19 were free replacements for bad leads within that
// batch. Both still cost ad spend (they're real Walker deliveries) but carry no revenue.
// Free replacements for bad leads: not billed, and not charged ad spend either.
function isReplacement(date) {
  return (date >= '2026-08-17' && date <= '2026-08-19') || (date >= '2026-09-28' && date <= '2026-09-30');
}

function isBillable(date, indexWithinAug3to5) {
  if (isReplacement(date)) return false;
  if (date >= '2026-08-03' && date <= '2026-08-05') return indexWithinAug3to5 >= 13;
  return true;
}

// parseCSVRows (not the header-keyed parseCSV) so blank rows stay in place — the color map is
// keyed by actual sheet row number, and the header-keyed parser silently drops blank rows, which
// would throw every row after one off by one.
function parseLeads(csv, colorByRow) {
  const rows = parseCSVRows(csv);
  const headers = (rows[0] || []).map((h) => h.trim());
  const col = (name) => headers.indexOf(name);
  const iDate = col('Date'), iName = col('Name'), iEmail = col('Email'), iPhone = col('Phone'), iStatus = col('Lead Status'), iReason = col('Reason for Rejection');
  let aug3to5Seen = 0;
  return rows.slice(1)
    .map((r, idx) => {
      const sheetRow = idx + 2; // row 1 is the header
      const note = (r[iStatus] || '').trim();
      const createdDate = toISODate(r[iDate]);
      const augIdx = createdDate >= '2026-08-03' && createdDate <= '2026-08-05' ? aug3to5Seen++ : -1;
      return {
        name: (r[iName] || '').trim(),
        email: (r[iEmail] || '').trim().toLowerCase(),
        phone: (r[iPhone] || '').trim(),
        createdDate,
        status: classifyByColor(colorByRow.get(sheetRow) || null),
        note,
        reason: (r[iReason] || '').trim(),
        billable: createdDate ? isBillable(createdDate, augIdx) : true,
        replacement: isReplacement(createdDate),
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
      adId: (r['UTM Term'] || '').trim(),
      qualified: /^qualified$/i.test((r['Qualified'] || r['Formulated Status'] || '').trim()),
    }))
    .filter((r) => r.date && r.name);
}

// Where a lead came from: matched by name within 3 days of the CRM date (verified against phone
// where both sides have one — 110 of 111 candidate matches agreed on phone during testing, so a
// name+date match without a phone to check is trusted too), earliest candidate wins ties. Some
// CRM rows name a relative the lead is calling about (e.g. "Jace Peterson (son)") rather than the
// contact who actually submitted the form — those never match by name, so a same-day phone match
// against the whole log is tried next before giving up.
function findOrigin(lead, byName, byPhone) {
  const candidates = (byName.get(normName(lead.name)) || []).filter(
    (w) => Math.abs((new Date(w.date) - new Date(lead.createdDate)) / 86400000) <= 3
  );
  const phone = phone10(lead.phone);
  if (candidates.length) {
    const exactPhone = phone && candidates.find((w) => w.phone === phone);
    const w = exactPhone || candidates.reduce((a, b) => (b.date < a.date ? b : a));
    return { campaignId: w.campaignId, campaignName: cache.campaignNames.get(w.campaignId) || '', adId: w.adId, adName: cache.adNames.get(w.adId) || '', contactSource: w.source, walkerDate: w.date };
  }
  const phoneMatches = (phone && byPhone.get(phone) || []).filter(
    (w) => Math.abs((new Date(w.date) - new Date(lead.createdDate)) / 86400000) <= 3
  );
  if (!phoneMatches.length) return null;
  const w = phoneMatches.reduce((a, b) => (b.date < a.date ? b : a));
  return { campaignId: w.campaignId, campaignName: cache.campaignNames.get(w.campaignId) || '', adId: w.adId, adName: cache.adNames.get(w.adId) || '', contactSource: w.source, walkerDate: w.date };
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
    const [crmCsv, walkerCsv, colorByRow, adNamesCsv] = await Promise.all([
      fetchText(csvUrl(CRM_GID, CRM_DOC_ID)),
      fetchText(csvUrl(WALKER_GID, WALKER_DOC_ID)),
      readColumnColors(CRM_DOC_ID, 'E').catch((err) => {
        console.warn(`[${new Date().toISOString()}] Bryan status colors unreadable (${err.message}) — keeping last known-good statuses`);
        return cache.statusColorByRow || new Map();
      }),
      fetchText(csvUrl('0', AD_NAMES_DOC_ID)).catch(() => null),
    ]);
    cache.statusColorByRow = colorByRow;
    if (adNamesCsv) {
      const adNames = new Map();
      for (const r of parseCSV(adNamesCsv)) { const id = (r['Ad ID'] || '').trim(); if (id && r['Ad Name']) adNames.set(id, r['Ad Name']); }
      cache.adNames = adNames;
    }
    const leads = parseLeads(crmCsv, colorByRow);
    if (leads.length < 20) { console.warn(`[${new Date().toISOString()}] Bryan CRM sheet looks broken (${leads.length} leads) — keeping last known-good`); return; }
    const walkerLog = parseWalkerLog(walkerCsv);
    if (walkerLog.length < 1000) { console.warn(`[${new Date().toISOString()}] Walker PPL log looks broken (${walkerLog.length} rows) — keeping last known-good`); return; }

    const byName = new Map();
    const byPhone = new Map();
    for (const w of walkerLog) {
      if (!byName.has(w.name)) byName.set(w.name, []);
      byName.get(w.name).push(w);
      if (w.phone) { if (!byPhone.has(w.phone)) byPhone.set(w.phone, []); byPhone.get(w.phone).push(w); }
    }

    const usedCampaignIds = new Set();
    const withOrigin = leads.map((l) => {
      let origin = findOrigin(l, byName, byPhone);
      // Walker's log carries no UTM for this one lead (blank campaign fields), and her CRM
      // Contact Source alone doesn't say why. Checked directly in GoHighLevel: her first and
      // latest attribution source is Organic Search, with no campaign anywhere in her activity
      // log — a real $0-ad-spend lead, not a gap in the join. Labeled here so she shows up as her
      // own line in the campaign breakdown instead of falling into "not traced."
      if (origin && !origin.campaignId && ORGANIC_OVERRIDES.some((o) => o.name === l.name && o.createdDate === l.createdDate)) {
        origin = { ...origin, campaignName: 'Organic Search (verified in GHL)' };
      }
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

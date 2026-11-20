// Bryan Rodriguez — a PPL-only client (no campaigns of his own; his leads are bought out of a
// shared pool of Loudr's own Texas Google campaigns, the same way Sasooness's Lead Prosper WA
// leads are). His own CRM sheet has no clean status column (just freeform call notes), and
// Walker's PPL delivery log has no email for most rows, so leads are joined to their source
// campaign by name + phone, cross-checked against the date, rather than by email like the other
// clients.
const { pickOrigin } = require('./origin-match');
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

const START_DATE = '2026-08-03';
// One-time per-month billing caps: leads beyond the cap for that month (counted in sheet order)
// aren't billed, though they still cost ad spend like any other real delivery. Not a standing
// contract term — add an entry here whenever a month comes with its own agreed cap.
const MONTHLY_BILLED_CAP = { '2026-10': 25 };

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
// the sheet's .xlsx export instead, which does carry cell formatting. A green cell alone was
// overcounting signed leads, though, so it now also requires the note itself to actually say
// "signed" — green is necessary but not sufficient on its own.
function classifyByColor(color, note) {
  const n = note || '';
  // "trying to get this guy signed up" says "signed" but means the opposite of done — anything
  // phrased as still in progress ("trying to") doesn't count, even with the word present.
  if (color === '34A853' && /\bsigned\b/i.test(n) && !/trying to/i.test(n)) return 'Signed';
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

function isBillable(date, indexWithinAug3to5, indexWithinMonth) {
  if (isReplacement(date)) return false;
  if (date >= '2026-08-03' && date <= '2026-08-05') return indexWithinAug3to5 >= 13;
  const cap = MONTHLY_BILLED_CAP[date.slice(0, 7)];
  if (cap != null && indexWithinMonth >= cap) return false;
  return true;
}

// parseCSVRows (not the header-keyed parseCSV) so blank rows stay in place — the color map is
// keyed by actual sheet row number, and the header-keyed parser silently drops blank rows, which
// would throw every row after one off by one.
function parseLeads(csv, colorByRow) {
  const rows = parseCSVRows(csv);
  const headers = (rows[0] || []).map((h) => h.trim());
  const col = (name) => headers.indexOf(name);
  const iDate = col('Date'), iName = col('Name'), iEmail = col('Email'), iPhone = col('Phone'), iStatus = col('Lead Status'), iReason = col('Reason for Rejection'), iReplacement = col('Replacement');
  let aug3to5Seen = 0;
  const monthSeen = {}; // 'YYYY-MM' -> count of leads already seen this month, in sheet order
  const leads = rows.slice(1)
    .map((r, idx) => {
      const sheetRow = idx + 2; // row 1 is the header
      const note = (r[iStatus] || '').trim();
      const createdDate = toISODate(r[iDate]);
      const augIdx = createdDate >= '2026-08-03' && createdDate <= '2026-08-05' ? aug3to5Seen++ : -1;
      const month = createdDate ? createdDate.slice(0, 7) : null;
      const monthIdx = month ? monthSeen[month] || 0 : -1;
      if (month) monthSeen[month] = monthIdx + 1;
      const flagged = iReplacement >= 0 && /^(yes|y|true|x|1)$/i.test((r[iReplacement] || '').trim());
      return {
        name: (r[iName] || '').trim(),
        email: (r[iEmail] || '').trim().toLowerCase(),
        phone: (r[iPhone] || '').trim(),
        createdDate,
        status: classifyByColor(colorByRow.get(sheetRow) || null, note),
        note,
        reason: (r[iReason] || '').trim(),
        billable: createdDate ? isBillable(createdDate, augIdx, monthIdx) : true,
        replacement: flagged || isReplacement(createdDate),
      };
    })
    .filter((l) => l.createdDate && l.createdDate >= START_DATE && (l.name || l.email));
  return leads;
}

// One entry per Walker PPL log row, reduced to what the join and the daily counts need.
function parseWalkerLog(csv) {
  return parseCSV(csv)
    .map((r) => ({
      date: toISODate(r['Date']),
      name: normName(r['Name']),
      phone: phone10(r['Phone']),
      email: (r['Email'] || '').trim().toLowerCase(),
      source: (r['Contact Source'] || '').trim(),
      campaignId: (r['UTM Campaign'] || '').trim(),
      adId: (r['UTM Term'] || '').trim(),
      qualified: /^qualified$/i.test((r['Qualified'] || r['Formulated Status'] || '').trim()),
    }))
    .filter((r) => r.date && r.name);
}

// Where a lead came from: the Walker log row for that exact submission — email/phone/name within
// 3 days of the CRM date, same-day first, never a same-name row whose phone says it's someone else
// (see origin-match.js). Some CRM rows name a relative the lead is calling about ("Jace Peterson
// (son)") — those still match on phone.
function findOrigin(lead, walkerLog) {
  const w = pickOrigin(lead, walkerLog, { maxDays: 3 });
  if (!w) return null;
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

// How many of this client's leads were matched to each shared-campaign day (by the Walker log
// row's own date, the same day the campaign's lead total is counted on).
function matchedCounts(leads) {
  const m = new Map();
  for (const l of leads) {
    const o = l.origin;
    if (!o || !o.campaignId || !o.walkerDate) continue;
    const key = o.campaignId + '|' + o.walkerDate;
    m.set(key, (m.get(key) || 0) + 1);
  }
  return m;
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

    const usedCampaignIds = new Set();
    const withOrigin = leads.map((l) => {
      let origin = findOrigin(l, walkerLog);
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

    // The campaign's daily lead count covers every buyer (Walker, Bryan, Ruy), minus anything
    // marked TEST in Ruy's sheet (see ruy.js) — a test submission isn't a real lead.
    const ruyTests = require('./ruy').getTestKeys();
    const leadsByDay = new Map();
    for (const w of walkerLog) {
      if (!usedCampaignIds.has(w.campaignId)) continue;
      if ((w.email && ruyTests.has(w.date + '|' + w.email)) || (w.phone && ruyTests.has(w.date + '|' + w.phone))) continue;
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

function getMatchedCounts() { return matchedCounts(cache.leads); }

function getData() {
  const campaigns = [...cache.usedCampaignIds].map((id) => ({ campaignId: id, name: cache.campaignNames.get(id) || id }));
  // The shared campaign's daily lead total comes from Walker's PPL log, which logs every lead the
  // shared Texas campaigns produce no matter which buyer it went to — Bryan's and Ruy's leads are
  // rows in that log too (matched one-to-one above), so they're already inside the total and
  // adding their sheets on top would double-count them. The split per buyer is attached so the
  // dashboard can show it: Walker = total − Bryan − Ruy.
  const bryanCounts = require('./bryan').getMatchedCounts();
  const ruyCounts = require('./ruy').getMatchedCounts();
  const leadsDaily = cache.walkerLeadsDaily.map((d) => {
    const key = d.campaignId + '|' + d.date;
    const bryan = bryanCounts.get(key) || 0, ruy = ruyCounts.get(key) || 0;
    return { ...d, bryan, ruy, walker: Math.max(0, d.leads - bryan - ruy) };
  });
  return {
    leads: cache.leads, walker: { campaigns, leadsDaily, spendDaily: cache.spendDaily },
    updatedAt: cache.updatedAt,
  };
}

module.exports = { pollAll, updateGoogleSpend, getData, getMatchedCounts };

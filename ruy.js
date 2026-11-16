// Ruy Mireles Law Firm — a PPL client like Bryan. Neither runs campaigns of their own: their leads
// come out of the same shared Texas campaigns that Walker runs, and Walker's PPL delivery log
// ("Walker PPL" tab) records every lead those campaigns produce for all three buyers (Walker,
// Bryan and Ruy). Ruy's ad spend is his share of that: each day's campaign spend ÷ every lead the
// campaign produced that day (all three buyers) × the leads that went to Ruy that day — the same
// split bryan.js uses.
//
// Ruy's own sheet: Date, Name, Email, Phone, Lead Status, Notes. Rows marked TEST (in Notes, Lead
// Status or the name) are test submissions and aren't counted anywhere.
const { csvUrl, fetchText, parseCSV, toISODate, phone10 } = require('./csv-utils');

const CRM_DOC_ID = '10Krjcmnp9WBqxWneEoGHdsl974t6pKyXuspd56unQ0U';
const CRM_GID = '0';

const WALKER_DOC_ID = '1gjJLZH8O_xZ7AlIX0UXWMazZxF-qsk8aK-yYvwm_hJw';
const WALKER_GID = '1067474187';

// Google Ads export with ad names, keyed by the same Ad ID the Walker log's UTM Term carries.
const AD_NAMES_DOC_ID = '1u0jJNfvnWZQsBaC6lmn0vhabtNuwI1yS0WchV2WYnAs';

let cache = {
  leads: [], walkerLeadsDaily: [], spendDaily: [],
  campaignNames: new Map(), adNames: new Map(), usedCampaignIds: new Set(), testKeys: new Set(), updatedAt: null,
};

function normName(v) { return String(v || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); }
const isTest = (...vals) => vals.some((v) => /\btest\b/i.test(v || ''));

// "Lead Status" is typed by Ruy's team, not color-coded like Bryan's sheet — read it as text.
function classifyStatus(s) {
  if (/\bsign/i.test(s) && !/not signed|trying to/i.test(s)) return 'Signed';
  if (/reject|declin|not a case|no case|dead|bad lead/i.test(s)) return 'Rejected';
  return 'Reviewing';
}

function parseLeads(csv) {
  return parseCSV(csv)
    .map((r) => {
      const statusText = (r['Lead Status'] || '').trim();
      const note = (r['Notes'] || '').trim();
      return {
        name: (r['Name'] || '').trim(),
        email: (r['Email'] || '').trim().toLowerCase(),
        phone: (r['Phone'] || '').trim(),
        createdDate: toISODate(r['Date']),
        statusText,
        status: classifyStatus(statusText),
        note,
        test: isTest(note, statusText, r['Name']),
      };
    })
    .filter((l) => l.createdDate && (l.name || l.email));
}

function parseWalkerLog(csv) {
  return parseCSV(csv)
    .map((r) => ({
      date: toISODate(r['Date']),
      name: normName(r['Name']),
      email: (r['Email'] || '').trim().toLowerCase(),
      phone: phone10(r['Phone']),
      source: (r['Contact Source'] || '').trim(),
      campaignId: (r['UTM Campaign'] || '').trim(),
      adId: (r['UTM Term'] || '').trim(),
      qualified: /^qualified$/i.test((r['Qualified'] || r['Formulated Status'] || '').trim()),
      // Test submissions in Walker's log don't count toward the shared campaign's lead total either.
      test: isTest(r['Name'], r['Email']),
    }))
    .filter((r) => r.date && r.name);
}

// Where a lead came from in Walker's log: email first (Ruy's sheet and the log both carry it),
// then phone, then name — always within 3 days of Ruy's date, earliest match wins.
function findOrigin(lead, walkerLog) {
  const near = (w) => Math.abs((new Date(w.date) - new Date(lead.createdDate)) / 86400000) <= 3;
  const phone = phone10(lead.phone);
  const name = normName(lead.name);
  const w = [
    (x) => lead.email && x.email === lead.email,
    (x) => phone && x.phone === phone,
    (x) => name && x.name === name,
  ].map((test) => walkerLog.filter((x) => near(x) && test(x)))
    .find((m) => m.length)
    ?.reduce((a, b) => (b.date < a.date ? b : a));
  if (!w) return null;
  return { campaignId: w.campaignId, campaignName: cache.campaignNames.get(w.campaignId) || '', adId: w.adId, adName: cache.adNames.get(w.adId) || '', contactSource: w.source, walkerDate: w.date };
}

// Called by the main server's poll with its per-day-per-ad Google rows, filtered to whichever
// campaigns Ruy's leads have been traced to.
function updateGoogleSpend(rows) {
  const names = new Map();
  for (const r of rows) if (r.campaignId && r.campaignName) names.set(String(r.campaignId), r.campaignName);
  cache.campaignNames = names;
  for (const l of cache.leads) if (l.origin && l.origin.campaignId) l.origin.campaignName = names.get(l.origin.campaignId) || l.origin.campaignName;
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
    const [crmCsv, walkerCsv, adNamesCsv] = await Promise.all([
      fetchText(csvUrl(CRM_GID, CRM_DOC_ID)),
      fetchText(csvUrl(WALKER_GID, WALKER_DOC_ID)),
      fetchText(csvUrl('0', AD_NAMES_DOC_ID)).catch(() => null),
    ]);
    if (adNamesCsv) {
      const adNames = new Map();
      for (const r of parseCSV(adNamesCsv)) { const id = (r['Ad ID'] || '').trim(); if (id && r['Ad Name']) adNames.set(id, r['Ad Name']); }
      cache.adNames = adNames;
    }
    // A brand-new client sheet legitimately has only a few rows, so only a non-CSV response
    // (sharing turned off → an HTML login page) is treated as broken.
    if (!/^\s*Date,/i.test(crmCsv)) { console.warn(`[${new Date().toISOString()}] Ruy sheet looks broken — keeping last known-good`); return; }
    const allRows = parseLeads(crmCsv);
    const leads = allRows.filter((l) => !l.test);
    const walkerLog = parseWalkerLog(walkerCsv);
    // A test marked only in Ruy's sheet (Walker's log has no such flag) is dropped from the
    // shared campaign's lead count too, so it doesn't dilute the CPL.
    const testKeys = new Set();
    for (const t of allRows.filter((l) => l.test)) {
      const tPhone = phone10(t.phone);
      if (t.email) testKeys.add(t.createdDate + '|' + t.email);
      if (tPhone) testKeys.add(t.createdDate + '|' + tPhone);
      for (const w of walkerLog) {
        if (w.date !== t.createdDate) continue;
        if ((t.email && w.email === t.email) || (tPhone && w.phone === tPhone)) w.test = true;
      }
    }
    if (walkerLog.length < 1000) { console.warn(`[${new Date().toISOString()}] Walker PPL log looks broken (${walkerLog.length} rows) — keeping last known-good`); return; }

    const usedCampaignIds = new Set();
    const withOrigin = leads.map((l) => {
      const origin = findOrigin(l, walkerLog);
      if (origin && origin.campaignId) usedCampaignIds.add(origin.campaignId);
      return { ...l, origin };
    });

    // Every lead the shared campaigns produced that day, for any buyer — the CPL denominator.
    const leadsByDay = new Map();
    for (const w of walkerLog) {
      if (w.test || !usedCampaignIds.has(w.campaignId)) continue;
      const key = w.campaignId + '|' + w.date;
      const cur = leadsByDay.get(key) || { campaignId: w.campaignId, date: w.date, leads: 0, qualified: 0 };
      cur.leads++;
      if (w.qualified) cur.qualified++;
      leadsByDay.set(key, cur);
    }

    cache.leads = withOrigin;
    cache.walkerLeadsDaily = [...leadsByDay.values()];
    cache.usedCampaignIds = usedCampaignIds;
    cache.testKeys = testKeys;
    cache.updatedAt = Date.now();
  } catch (err) {
    console.error('Ruy poll error:', err.message);
  }
}

function getData() {
  const campaigns = [...cache.usedCampaignIds].map((id) => ({ campaignId: id, name: cache.campaignNames.get(id) || id }));
  return {
    leads: cache.leads, walker: { campaigns, leadsDaily: cache.walkerLeadsDaily, spendDaily: cache.spendDaily },
    updatedAt: cache.updatedAt,
  };
}

// Test rows from Ruy's sheet (date|email and date|phone10), so Bryan's dashboard can leave them
// out of the shared campaign's daily lead count too.
function getTestKeys() { return cache.testKeys; }

module.exports = { pollAll, updateGoogleSpend, getData, getTestKeys };

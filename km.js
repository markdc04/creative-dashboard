// KM Law Firm PLLC — leads and signed cases come from the "Getloud Active Client" workbook's ALL
// LEADS and ALL CLIENT CASES tabs (KM's own block/sub-account only); ad spend is the KM Law Meta
// campaign (shared Meta export) plus the Google campaign that includes KM, filtered out of the
// main tracker's already-fetched spend.
const { csvUrl, fetchText, parseCSVRows, parseCSV, num, toISODate } = require('./csv-utils');
const { metaDailyFor } = require('./meta-spend');

const WORKBOOK_ID = '1rYN9P0oVlEwlxpk53ZqDDGIcZ9154bm-k709KUMIT_A';
const ALL_LEADS_GID = '1706081278';
const ALL_CASES_GID = '722868032';
// KM Law tab: holds the per-lead marketing fee ("$/Lead") and the monthly "AD Budget".
const KM_TAB_GID = '0';

const CAMPAIGN_PATTERN = /\bKM\b/i;

let cache = { cases: [], leadsDaily: [], googleDaily: [], metaDaily: [], settings: { feePerLead: 35, monthlyAdBudget: 20000 }, updatedAt: null };
let adNames = new Map(); // adId -> ad name, learned from the main tracker's rows

function updateGoogleSpend(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (r.adId && r.adName) adNames.set(String(r.adId), r.adName);
    if (r.platform !== 'GOOGLE' || !CAMPAIGN_PATTERN.test(r.campaignName || '')) continue;
    byDate.set(r.date, (byDate.get(r.date) || 0) + r.spend);
  }
  cache.googleDaily = [...byDate.entries()].map(([date, spend]) => ({ date, spend: Math.round(spend * 100) / 100 })).sort((a, b) => (a.date < b.date ? -1 : 1));
  cache.updatedAt = Date.now();
}

// KM's block is the first eight columns of ALL CLIENT CASES (other clients sit to the right).
// The AD column holds either an ad ID or a plain ad name; IDs are resolved to names when known.
function parseCases(csv) {
  const byEmail = new Map();
  for (const r of parseCSVRows(csv).slice(2)) {
    const [intake, conversion, name, email, , , ad] = r;
    const key = (email || '').trim().toLowerCase();
    if (!key || !toISODate(conversion)) continue;
    const c = { name: (name || '').trim(), email: key, intakeDate: toISODate(intake), conversionDate: toISODate(conversion), ad: (ad || '').trim() };
    const prev = byEmail.get(key);
    if (!prev || c.conversionDate < prev.conversionDate) byEmail.set(key, c);
  }
  return [...byEmail.values()];
}

// Each figure sits directly under its label cell ("$/Lead" -> 35, "AD Budget" -> 20000), so find the
// label wherever it is rather than hard-coding a cell address that breaks when rows move.
function parseSettings(csv) {
  const rows = parseCSVRows(csv);
  const below = (label) => {
    for (let r = 0; r < rows.length - 1; r++) {
      const c = rows[r].findIndex((v) => (v || '').trim().toLowerCase() === label);
      if (c !== -1) { const n = num(rows[r + 1][c]); if (n > 0) return n; }
    }
    return null;
  };
  return { feePerLead: below('$/lead'), monthlyAdBudget: below('ad budget') };
}

// One lead per email (earliest date), reduced to per-day counts so no contact details reach the
// browser for the ~4,000 leads.
function parseLeadsDaily(csv) {
  const first = new Map();
  for (const r of parseCSV(csv)) {
    if ((r['Sub account'] || '').trim().toLowerCase() !== 'km law') continue;
    const date = toISODate(r['Date']);
    const key = (r['Email'] || '').trim().toLowerCase() || (r['GHL Contact ID'] || '');
    if (!date || !key) continue;
    if (!first.has(key) || date < first.get(key)) first.set(key, date);
  }
  const byDate = new Map();
  for (const date of first.values()) byDate.set(date, (byDate.get(date) || 0) + 1);
  return [...byDate.entries()].map(([date, leads]) => ({ date, leads })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function pollAll() {
  try {
    const [casesCsv, leadsCsv, kmTabCsv, metaDaily] = await Promise.all([
      fetchText(csvUrl(ALL_CASES_GID, WORKBOOK_ID)),
      fetchText(csvUrl(ALL_LEADS_GID, WORKBOOK_ID)),
      fetchText(csvUrl(KM_TAB_GID, WORKBOOK_ID)),
      metaDailyFor(CAMPAIGN_PATTERN),
    ]);
    const cases = parseCases(casesCsv);
    const leadsDaily = parseLeadsDaily(leadsCsv);
    // A broken export (sharing turned off, formula error) comes back tiny or as HTML — keep the
    // last good data rather than blanking the page.
    if (cases.length >= 20) cache.cases = cases; else console.warn(`[${new Date().toISOString()}] KM cases tab looks broken (${cases.length}) — keeping last known-good`);
    if (leadsDaily.length >= 30) cache.leadsDaily = leadsDaily; else console.warn(`[${new Date().toISOString()}] KM leads tab looks broken (${leadsDaily.length} days) — keeping last known-good`);
    const settings = parseSettings(kmTabCsv);
    cache.settings = { feePerLead: settings.feePerLead || cache.settings.feePerLead, monthlyAdBudget: settings.monthlyAdBudget || cache.settings.monthlyAdBudget };
    cache.metaDaily = metaDaily;
    cache.updatedAt = Date.now();
  } catch (err) {
    console.error('KM poll error:', err.message);
  }
}

function getData() {
  const cases = cache.cases.map((c) => ({ ...c, adName: adNames.get(c.ad) || c.ad }));
  return { cases, leadsDaily: cache.leadsDaily, googleDaily: cache.googleDaily, metaDaily: cache.metaDaily, settings: cache.settings, updatedAt: cache.updatedAt };
}

module.exports = { pollAll, updateGoogleSpend, getData };

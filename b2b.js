// B2B Dashboard — leads come from two sheets, merged by GHL Contact ID:
//   - "B2B Only" tab inside the shared "Getloud Active Client" workbook (same workbook KM Law
//     and Sasooness already read from) — 643+ rows, the more complete lead list, but has no
//     Stage/Status/State columns.
//   - The standalone "B2B Sales pipeline" sheet — fewer rows, but has Stage/Status/State/Firm
//     Name, which the user confirmed are important to keep showing.
// "B2B Only" is the base list; each lead is enriched with Stage/Status/State/Firm Name from the
// pipeline sheet when its GHL Contact ID is found there.
//
// Ad spend comes from the B2B block of the same shared Meta export every other dashboard here
// reads from (see meta-spend.js). Ad attribution joins by AD NAME (UTM Content <-> Ad Name), not
// by UTM Term/Ad ID — spot-checked ~100+ leads and UTM Term never matches a real Ad ID in the
// spend sheet (it looks like GHL captures a different Meta object ID into that field), while the
// ad name consistently does match, just sometimes under more than one Ad ID (A/B duplicates), so
// spend is summed across every Ad ID sharing that name.
const { csvUrl, fetchText, parseCSV, toISODate } = require('./csv-utils');
const { getB2BMetaRows } = require('./meta-spend');

const WORKBOOK_ID = '1rYN9P0oVlEwlxpk53ZqDDGIcZ9154bm-k709KUMIT_A';
const B2B_ONLY_GID = '825238244';
const PIPELINE_DOC_ID = '1sJod1nVa3bA6sQiQtVMhi2mWvmlQVNwAZZBQFLiJ2J0';
const PIPELINE_GID = '0';

let cache = { leads: [], leadsDaily: [], adSpendDaily: [], adSpendByAdName: [], updatedAt: null };

// Keyed by GHL Contact ID -> { firmName, stage, status, state }, only the fields "B2B Only"
// doesn't have.
function parsePipelineEnrichment(csv) {
  const byId = new Map();
  for (const r of parseCSV(csv)) {
    const id = (r['GHL Contact ID'] || '').trim();
    if (!id) continue;
    byId.set(id, {
      firmName: (r['Firm Name'] || '').trim(),
      stage: (r['Stage'] || '').trim(),
      status: (r['Status'] || '').trim(),
      state: (r['State'] || '').trim(),
    });
  }
  return byId;
}

// No email/phone kept here — the dashboard only needs counts, ad attribution, status, and
// cost-per-lead, not contact details.
function parseLeads(csv, enrichmentById) {
  const leads = [];
  for (const r of parseCSV(csv)) {
    const date = toISODate(r['Date']);
    if (!date) continue;
    const id = (r['GHL Contact ID'] || '').trim();
    const enrich = (id && enrichmentById.get(id)) || {};
    leads.push({
      date,
      name: (r['Name'] || '').trim(),
      firmName: enrich.firmName || (r['Law Firms'] || '').trim(),
      utmContent: (r['UTM Content'] || '').trim(), // the ad's name — this is what actually joins to spend
      utmCampaign: (r['UTM Campaign'] || '').trim(),
      source: (r['Contact Source (survey)'] || '').trim(),
      stage: enrich.stage || '',
      status: enrich.status || '',
      state: enrich.state || '',
    });
  }
  return leads;
}

function dailyCounts(leads) {
  const byDate = new Map();
  for (const l of leads) byDate.set(l.date, (byDate.get(l.date) || 0) + 1);
  return [...byDate.entries()].map(([date, leads]) => ({ date, leads })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function pollAll() {
  try {
    const [b2bOnlyCsv, pipelineCsv, metaRows] = await Promise.all([
      fetchText(csvUrl(B2B_ONLY_GID, WORKBOOK_ID)),
      fetchText(csvUrl(PIPELINE_GID, PIPELINE_DOC_ID)),
      getB2BMetaRows(),
    ]);
    const enrichmentById = parsePipelineEnrichment(pipelineCsv);
    const leads = parseLeads(b2bOnlyCsv, enrichmentById);
    // A broken export (sharing turned off, formula error) comes back tiny or as HTML — keep the
    // last good data rather than blanking the page.
    if (leads.length >= 20) cache.leads = leads;
    else console.warn(`[${new Date().toISOString()}] B2B Only tab looks broken (${leads.length}) — keeping last known-good`);

    cache.leadsDaily = dailyCounts(cache.leads);

    const spendByDate = new Map();
    const spendByAdName = new Map();
    for (const r of metaRows) {
      if (r.date && r.spend) spendByDate.set(r.date, (spendByDate.get(r.date) || 0) + r.spend);
      if (r.adName && r.spend) spendByAdName.set(r.adName, (spendByAdName.get(r.adName) || 0) + r.spend);
    }
    cache.adSpendDaily = [...spendByDate.entries()].map(([date, spend]) => ({ date, spend: Math.round(spend * 100) / 100 })).sort((a, b) => (a.date < b.date ? -1 : 1));
    cache.adSpendByAdName = [...spendByAdName.entries()].map(([adName, spend]) => ({ adName, spend: Math.round(spend * 100) / 100 }));
    cache.updatedAt = Date.now();
  } catch (err) {
    console.error('B2B poll error:', err.message);
  }
}

function getData() {
  return { leads: cache.leads, leadsDaily: cache.leadsDaily, adSpendDaily: cache.adSpendDaily, adSpendByAdName: cache.adSpendByAdName, updatedAt: cache.updatedAt };
}

module.exports = { pollAll, getData };

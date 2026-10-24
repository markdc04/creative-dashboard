// B2B Dashboard — leads come from the "B2B Sales pipeline" sheet (its own standalone workbook,
// one lead per row, no sub-account column since it's B2B-only); ad spend comes from the B2B block
// of the same shared Meta export every other dashboard here reads from (see meta-spend.js),
// joined to leads by UTM Term == Ad ID, the same join Walker's Agency Leads-by-Ad already uses.
const { csvUrl, fetchText, parseCSV, toISODate } = require('./csv-utils');
const { getB2BMetaRows } = require('./meta-spend');

const LEADS_DOC_ID = '1sJod1nVa3bA6sQiQtVMhi2mWvmlQVNwAZZBQFLiJ2J0';
const LEADS_GID = '0';

let cache = { leads: [], leadsDaily: [], adSpendDaily: [], adNameById: {}, adSpendByAd: [], updatedAt: null };

// No email/phone kept here — the dashboard only needs counts, ad attribution, and cost-per-lead,
// not contact details.
function parseLeads(csv) {
  const leads = [];
  for (const r of parseCSV(csv)) {
    const date = toISODate(r['Date']);
    if (!date) continue;
    leads.push({
      date,
      name: (r['Name'] || '').trim(),
      firmName: (r['Firm Name'] || '').trim(),
      utmTerm: (r['UTM Term'] || '').trim(),
      utmCampaign: (r['UTM Campaign'] || '').trim(),
      source: (r['Contact Source (survey)'] || '').trim(),
      stage: (r['Stage'] || '').trim(),
      status: (r['Status'] || '').trim(),
      state: (r['State'] || '').trim(),
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
    const [leadsCsv, metaRows] = await Promise.all([
      fetchText(csvUrl(LEADS_GID, LEADS_DOC_ID)),
      getB2BMetaRows(),
    ]);
    const leads = parseLeads(leadsCsv);
    // A broken export (sharing turned off, formula error) comes back tiny or as HTML — keep the
    // last good data rather than blanking the page.
    if (leads.length >= 5) cache.leads = leads;
    else console.warn(`[${new Date().toISOString()}] B2B leads tab looks broken (${leads.length}) — keeping last known-good`);

    cache.leadsDaily = dailyCounts(cache.leads);

    const spendByDate = new Map();
    const spendByAdId = new Map(); // adId -> { adName, spend }
    const adNameById = {};
    for (const r of metaRows) {
      if (r.date && r.spend) spendByDate.set(r.date, (spendByDate.get(r.date) || 0) + r.spend);
      if (r.adId && r.adName) {
        adNameById[r.adId] = r.adName;
        if (!spendByAdId.has(r.adId)) spendByAdId.set(r.adId, { adName: r.adName, spend: 0 });
        spendByAdId.get(r.adId).spend += r.spend;
      }
    }
    cache.adSpendDaily = [...spendByDate.entries()].map(([date, spend]) => ({ date, spend: Math.round(spend * 100) / 100 })).sort((a, b) => (a.date < b.date ? -1 : 1));
    cache.adNameById = adNameById;
    cache.adSpendByAd = [...spendByAdId.entries()].map(([adId, v]) => ({ adId, adName: v.adName, spend: Math.round(v.spend * 100) / 100 }));
    cache.updatedAt = Date.now();
  } catch (err) {
    console.error('B2B poll error:', err.message);
  }
}

function getData() {
  const leads = cache.leads.map((l) => ({ ...l, adName: cache.adNameById[l.utmTerm] || (l.utmTerm ? '(unmatched ad ID)' : '') }));
  return { leads, leadsDaily: cache.leadsDaily, adSpendDaily: cache.adSpendDaily, adSpendByAd: cache.adSpendByAd, updatedAt: cache.updatedAt };
}

module.exports = { pollAll, getData };

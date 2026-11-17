// B2B Dashboard — leads come from the "B2B GHL Synced" tab of the "B2B Sales pipeline" sheet,
// which is kept in sync with GoHighLevel. It is the source of truth: a lead removed there (tests,
// duplicates) drops off the dashboard on the next poll. Its Date column is a UTC timestamp, so
// it's converted to the Pacific calendar day (a 4:38 PM PT lead on 11/11 is 00:38Z on 11/12).
//
// Ad spend comes from two sources, combined into one set of totals: every Meta row with "B2B" in
// its campaign name (see meta-spend.js) and every X/Twitter row with "B2B" in its campaign name
// (see x-spend.js). Ad attribution joins by AD NAME (UTM Content <-> Ad Name),
// not by UTM Term/Ad ID — spot-checked ~100+ leads and UTM Term never matches a real Ad ID in the
// spend sheet (it looks like GHL captures a different Meta object ID into that field), while the
// ad name consistently does match, just sometimes under more than one Ad ID (A/B duplicates), so
// spend is summed across every Ad ID sharing that name.
const { csvUrl, fetchText, parseCSV, toISODate } = require('./csv-utils');
const { getB2BMetaRows } = require('./meta-spend');
const { getB2BXRows } = require('./x-spend');

const PIPELINE_DOC_ID = '1sJod1nVa3bA6sQiQtVMhi2mWvmlQVNwAZZBQFLiJ2J0';
const PIPELINE_GID = '673977822'; // "B2B GHL Synced"

let cache = { leads: [], leadsDaily: [], adSpendDaily: [], adSpendByAdName: [], adSpendByAdNameDaily: [], ads: [], updatedAt: null };

const pacificDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
function leadDate(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const d = new Date(raw);
    if (!isNaN(d)) return pacificDay.format(d);
  }
  return toISODate(raw);
}

// No email/phone kept here — the dashboard only needs counts, ad attribution, status, and
// cost-per-lead, not contact details. One row per GHL Contact ID (the first one wins).
function parseLeads(csv) {
  const leads = [];
  const seenIds = new Set();
  for (const r of parseCSV(csv)) {
    const id = (r['GHL Contact ID'] || '').trim();
    if (id && seenIds.has(id)) continue;
    const date = leadDate(r['Date']);
    if (!date) continue;
    if (id) seenIds.add(id);
    leads.push({
      date,
      name: (r['Name'] || '').trim(),
      firmName: (r['Firm Name'] || '').trim(),
      utmContent: (r['UTM Content'] || '').trim(), // the ad's name — this is what actually joins to spend
      utmCampaign: (r['UTM Campaign'] || '').trim(),
      source: (r['Contact Source (survey)'] || '').trim(),
      stage: (r['Stage'] || '').trim(),
      status: (r['Status'] || '').trim(),
      state: (r['State'] || '').trim(),
      // Filled by hand in the sheet when a deal closes — Closed Deals/Revenue are dated by this,
      // not by when the lead came in.
      closeDate: leadDate(r['Close Date']) || null,
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
    const [pipelineCsv, metaRows, xRows] = await Promise.all([
      fetchText(csvUrl(PIPELINE_GID, PIPELINE_DOC_ID)),
      getB2BMetaRows(),
      getB2BXRows(),
    ]);
    const leads = parseLeads(pipelineCsv);
    // A broken export (sharing turned off, formula error) comes back tiny or as HTML — keep the
    // last good data rather than blanking the page.
    if (leads.length >= 20) cache.leads = leads;
    else console.warn(`[${new Date().toISOString()}] B2B leads look broken (${leads.length}) — keeping last known-good`);

    cache.leadsDaily = dailyCounts(cache.leads);

    const spendByDate = new Map();
    const spendByAdName = new Map();
    // Also kept per (ad name, date) — adSpendByAdName alone is a lifetime total, which doesn't
    // match the leads count once the dashboard's date range is narrowed, so "Which Ads Generated
    // Them" needs this to filter spend by the same range as the leads.
    const spendByAdNameDate = new Map();
    for (const r of [...metaRows, ...xRows]) {
      if (r.date && r.spend) spendByDate.set(r.date, (spendByDate.get(r.date) || 0) + r.spend);
      if (r.adName && r.spend) spendByAdName.set(r.adName, (spendByAdName.get(r.adName) || 0) + r.spend);
      if (r.adName && r.date && r.spend) {
        const key = r.adName + '|' + r.date;
        spendByAdNameDate.set(key, { adName: r.adName, date: r.date, spend: (spendByAdNameDate.get(key)?.spend || 0) + r.spend });
      }
    }
    // One ad name can run as several posts (different Ad IDs, or both Meta and X), each with its own
    // link — kept per (ad name, post, date) with spend, so the dashboard can show the post that
    // actually spent the most in the picked dates.
    const LINK_KEYS = ['instagramUrl', 'postUrl', 'tweetUrl', 'thumbUrl', 'mediaUrl'];
    const linkDaily = new Map();
    for (const r of [...metaRows, ...xRows]) {
      if (!r.adName || !r.date || !LINK_KEYS.some((k) => r[k])) continue;
      const post = r.instagramUrl || r.mediaUrl || r.postUrl || r.tweetUrl;
      const key = r.adName + '|' + post + '|' + r.date;
      const cur = linkDaily.get(key) || { adName: r.adName, date: r.date, platform: r.platform, spend: 0 };
      for (const k of LINK_KEYS) if (r[k]) cur[k] = r[k];
      cur.spend += r.spend || 0;
      linkDaily.set(key, cur);
    }
    cache.ads = [...linkDaily.values()].map((r) => ({ ...r, spend: Math.round(r.spend * 100) / 100 }));
    cache.adSpendDaily = [...spendByDate.entries()].map(([date, spend]) => ({ date, spend: Math.round(spend * 100) / 100 })).sort((a, b) => (a.date < b.date ? -1 : 1));
    cache.adSpendByAdName = [...spendByAdName.entries()].map(([adName, spend]) => ({ adName, spend: Math.round(spend * 100) / 100 }));
    cache.adSpendByAdNameDaily = [...spendByAdNameDate.values()].map((r) => ({ ...r, spend: Math.round(r.spend * 100) / 100 }));
    cache.updatedAt = Date.now();
  } catch (err) {
    console.error('B2B poll error:', err.message);
  }
}

function getData() {
  return {
    leads: cache.leads, leadsDaily: cache.leadsDaily, adSpendDaily: cache.adSpendDaily,
    adSpendByAdName: cache.adSpendByAdName, adSpendByAdNameDaily: cache.adSpendByAdNameDaily, ads: cache.ads, updatedAt: cache.updatedAt,
  };
}

module.exports = { pollAll, getData };

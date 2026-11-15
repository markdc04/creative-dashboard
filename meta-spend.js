// The shared Meta spend export (several clients' campaigns side by side). Fetched once and
// cached briefly so the Sasooness and KM Law modules don't each download the same big sheet.
const { csvUrl, fetchText, parseCSVRows, num, toISODate } = require('./csv-utils');

const META_DOC_ID = '1rYN9P0oVlEwlxpk53ZqDDGIcZ9154bm-k709KUMIT_A';
const META_GID = '1511968771';
const TTL_MS = 20000;

let cached = null; // { at, promise }
let cachedB2B = null; // { at, promise }

// Only the first block (columns A-G: Day, Campaign ID, Campaign Name, Ad ID, Ad Name, Amount
// Spent, Account Name) is ever read — the second block is a different client with identical
// header text, which is why this reads raw column positions rather than header-keyed objects.
async function getMetaRows() {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.promise;
  const promise = fetchText(csvUrl(META_GID, META_DOC_ID)).then((csv) =>
    parseCSVRows(csv).slice(2).map((row) => ({ date: toISODate(row[0]), campaign: row[2] || '', campaignId: (row[1] || '').trim(), adName: (row[4] || '').trim(), spend: num(row[5]) }))
  );
  cached = { at: Date.now(), promise };
  promise.catch(() => { cached = null; });
  return promise;
}

// Daily total of Meta spend across campaigns whose name matches `pattern`.
async function metaDailyFor(pattern) {
  const byDate = new Map();
  for (const r of await getMetaRows()) {
    if (!r.campaign || !pattern.test(r.campaign) || !r.date || !r.spend) continue;
    byDate.set(r.date, (byDate.get(r.date) || 0) + r.spend);
  }
  return [...byDate.entries()].map(([date, spend]) => ({ date, spend: Math.round(spend * 100) / 100 })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Same filter, but kept per campaign per day (with the campaign ID, which lead UTM tags use).
async function metaCampaignDailyFor(pattern) {
  const byKey = new Map();
  for (const r of await getMetaRows()) {
    if (!r.campaign || !pattern.test(r.campaign) || !r.date || !r.spend) continue;
    const key = r.campaign + '|' + r.date;
    const cur = byKey.get(key) || { campaign: r.campaign, campaignId: r.campaignId, date: r.date, spend: 0 };
    cur.spend += r.spend;
    byKey.set(key, cur);
  }
  return [...byKey.values()].map((r) => ({ ...r, spend: Math.round(r.spend * 100) / 100 }));
}

// A lead's UTM Term can be the ad's NAME rather than a numeric ID — and the same ad creative
// commonly runs under several different clients' campaigns, so a bare name lookup risks
// attributing a lead to the wrong client. Scoped here to `pattern`-matching campaigns only, and
// kept as every (campaign, date) the ad ran under so the caller can pick the one closest to the
// lead's own date rather than guessing.
async function metaAdCampaignsFor(pattern) {
  const byAdName = new Map();
  for (const r of await getMetaRows()) {
    if (!r.adName || !r.campaign || !pattern.test(r.campaign) || !r.date) continue;
    if (!byAdName.has(r.adName)) byAdName.set(r.adName, []);
    byAdName.get(r.adName).push({ campaign: r.campaign, date: r.date });
  }
  return byAdName;
}

// B2B ad spend actually lives in TWO separate blocks in this sheet:
//   - "B2B META DATA" at columns H-M (Day, Campaign ID, Campaign Name, Ad ID, Ad Name, Amount
//     Spent) — the original block this function read.
//   - "NEW BUSINESS PORTFOLIO META AD SPENT" at columns O-U (same 6 fields, plus an Account Name
//     at U mixing B2B and B2C rows together) — a newer block added later. Confirmed zero Ad ID
//     overlap between the two blocks (genuinely additional spend, not a duplicate), so both are
//     combined here, the second one filtered to Account Name === "B2B Loudr Media" only.
// Cached separately from getMetaRows() rather than reusing its cache, so a bug in one block's
// shape can never affect the other.
// Every row in any of the export's three blocks whose campaign name contains "B2B" — the user's
// rule for what counts as B2B ad spend. The two business-portfolio blocks also carry each ad's
// Instagram permalink and Facebook post link, used to preview the ad on the B2B dashboard.
async function getB2BMetaRows() {
  if (cachedB2B && Date.now() - cachedB2B.at < TTL_MS) return cachedB2B.promise;
  const promise = fetchText(csvUrl(META_GID, META_DOC_ID)).then((csv) => {
    const rows = parseCSVRows(csv).slice(2);
    const blocks = [
      { day: 0, campaignId: 1, campaign: 2, adId: 3, adName: 4, spend: 5 },
      { day: 7, campaignId: 8, campaign: 9, adId: 10, adName: 11, spend: 12, instagram: 13, post: 14 },
      { day: 16, campaignId: 17, campaign: 18, adId: 19, adName: 20, spend: 21, instagram: 23, post: 24 },
    ];
    const out = [];
    for (const row of rows) {
      for (const b of blocks) {
        const campaign = (row[b.campaign] || '').trim();
        if (!/b2b/i.test(campaign)) continue;
        out.push({
          platform: 'Meta', date: toISODate(row[b.day]), campaign, campaignId: (row[b.campaignId] || '').trim(),
          adId: (row[b.adId] || '').trim(), adName: (row[b.adName] || '').trim(), spend: num(row[b.spend]),
          instagramUrl: b.instagram != null ? (row[b.instagram] || '').trim() : '',
          postUrl: b.post != null ? (row[b.post] || '').trim() : '',
        });
      }
    }
    return out;
  });
  cachedB2B = { at: Date.now(), promise };
  promise.catch(() => { cachedB2B = null; });
  return promise;
}

module.exports = { metaDailyFor, metaCampaignDailyFor, metaAdCampaignsFor, getB2BMetaRows };

// The shared Meta spend export (several clients' campaigns side by side). Fetched once and
// cached briefly so the Sasooness and KM Law modules don't each download the same big sheet.
const { csvUrl, fetchText, parseCSVRows, num, toISODate } = require('./csv-utils');

const META_DOC_ID = '1rYN9P0oVlEwlxpk53ZqDDGIcZ9154bm-k709KUMIT_A';
const META_GID = '1511968771';
const TTL_MS = 20000;

let cached = null; // { at, promise }

// Only the first block (columns A-G: Day, Campaign ID, Campaign Name, Ad ID, Ad Name, Amount
// Spent, Account Name) is ever read — the second block is a different client with identical
// header text, which is why this reads raw column positions rather than header-keyed objects.
async function getMetaRows() {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.promise;
  const promise = fetchText(csvUrl(META_GID, META_DOC_ID)).then((csv) =>
    parseCSVRows(csv).slice(2).map((row) => ({ date: toISODate(row[0]), campaign: row[2] || '', spend: num(row[5]) }))
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

module.exports = { metaDailyFor };

// X (Twitter) ad spend for the B2B dashboard — lives in the "X AD SPENT" tab of the same shared
// "Getloud Active Client" workbook every other B2B/Meta source here reads from. That tab is itself
// an IMPORTRANGE from a separate source spreadsheet this account can't open directly, so this
// reads the already-imported copy, same as meta-spend.js does for Meta.
// Columns: Date, Account Name, Campaign, Campaign ID, Ad Group, Ad Name, Spend, Ad Preview URL.
// Account Name mixes two different clients ("Loudr Media" = B2B, "Auto Relief Assistance" =
// unrelated) sharing this one export, so rows are filtered to "Loudr Media" only.
const { csvUrl, fetchText, parseCSVRows, num, toISODate } = require('./csv-utils');

const X_DOC_ID = '1rYN9P0oVlEwlxpk53ZqDDGIcZ9154bm-k709KUMIT_A';
const X_GID = '1913542477';
const TTL_MS = 20000;

let cachedB2B = null; // { at, promise }

async function getB2BXRows() {
  if (cachedB2B && Date.now() - cachedB2B.at < TTL_MS) return cachedB2B.promise;
  const promise = fetchText(csvUrl(X_GID, X_DOC_ID)).then((csv) =>
    parseCSVRows(csv)
      .slice(1)
      .filter((row) => (row[1] || '').trim() === 'Loudr Media')
      .map((row) => ({ date: toISODate(row[0]), campaign: row[2] || '', campaignId: (row[3] || '').trim(), adName: (row[5] || '').trim(), spend: num(row[6]) }))
  );
  cachedB2B = { at: Date.now(), promise };
  promise.catch(() => { cachedB2B = null; });
  return promise;
}

module.exports = { getB2BXRows };

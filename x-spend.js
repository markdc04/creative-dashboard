// X (Twitter) ad spend for the B2B dashboard, from the X AD SPENT tab of the "GOOGLE AND META AD
// SPENT" workbook. Every row whose campaign name contains "B2B" counts (the user's rule for B2B
// spend). The tab also carries each ad's media (Card Media URL is the video/image file itself) and
// tweet link, used to preview the ad on the B2B dashboard.
// Columns: Date, Campaign Name, Ad Group Name, Ad Name, Spend, Campaign Currency, Campaign ID,
// Ad Group ID, Account Name, Tweet URL, Card Media Thumbnail URL, Card Media URL, ...
const { csvUrl, fetchText, parseCSVRows, num, toISODate } = require('./csv-utils');

const X_DOC_ID = '1u0jJNfvnWZQsBaC6lmn0vhabtNuwI1yS0WchV2WYnAs';
const X_GID = '1863615325';
const TTL_MS = 20000;

let cachedB2B = null; // { at, promise }

async function getB2BXRows() {
  if (cachedB2B && Date.now() - cachedB2B.at < TTL_MS) return cachedB2B.promise;
  const promise = fetchText(csvUrl(X_GID, X_DOC_ID)).then((csv) =>
    parseCSVRows(csv)
      .slice(1)
      .filter((row) => /b2b/i.test(row[1] || ''))
      .map((row) => ({
        platform: 'X', date: toISODate(row[0]), campaign: (row[1] || '').trim(), campaignId: (row[6] || '').trim(),
        adName: (row[3] || '').trim(), spend: num(row[4]),
        tweetUrl: (row[9] || '').trim(), thumbUrl: (row[10] || '').trim(), mediaUrl: (row[11] || '').trim(),
      }))
  );
  cachedB2B = { at: Date.now(), promise };
  promise.catch(() => { cachedB2B = null; });
  return promise;
}

module.exports = { getB2BXRows };

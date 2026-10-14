// Ported from /Users/markdelacruz/walker-dashboard/server.js (+ dashboard_sync.js) — the
// Walker PPL/Agency dashboard's data engine, trimmed of HTTP routing, sessions, Slack
// reporting and the admin panel. Logic is copied as close to verbatim as possible; see the
// original repo (github.com/markdc04/walker-dashboard) for the full app this came from.
const https = require('https');
const zlib = require('zlib');
const { computeCorrectedCampaigns, computeLateQmvaCorrelation, computeCampaignTrends } = require('./walker-dashboard_sync');
const { withRetry } = require('./walker-rate_limit');

// Dashboard workbook ("WALKER - AGENCY PROFIT DASHBOARD") — separate, independently-maintained
// source for Global PPL / NW & CA PPL. Not the same data or update cadence as the Live tabs below;
// do not merge or mirror the two.
const MAIN_DOC = '1-Wh4ilpfXqmCRdVwFqv2oBz_soAaFzg30SKHl7Qq3-0';
// "Agency Walker Ad Spend Tracker" — real ad spend with the 35% agency fee broken out per row.
const MEDIA_SPEND_DOC = '1hGkQPHBvoNraYgcIA0HW4tiQnOlDJjoQDMRgldbaEOA';
// "AGENCY Leads Import" — raw lead-level export (one row per lead) from the intake form/CRM.
// A standalone copy of the data (not the "LIST OF QMVA" workbook, which has unbounded IMPORTRANGE
// formulas elsewhere that make CSV export hang for every tab in that workbook).
const AGENCY_LEADS_DOC = '1HuftqD1-drJXzGFlbWnRQ3huyJwAIErM7DkY29UDj-E';
// "GOOGLE AND META AD SPENT" — the real, standalone source that LIST OF QMVA's "Google Ad Spent
// (Live)" tab just wraps in an IMPORTRANGE. Reading it directly here (rather than through LIST OF
// QMVA) is what actually makes it fast: this doc alone exports in ~1s, vs 15+ min through the
// heavy workbook (confirmed directly — same data, same columns, just without the weight).
const GOOGLE_AD_SPENT_DOC = '1u0jJNfvnWZQsBaC6lmn0vhabtNuwI1yS0WchV2WYnAs';
// "LIST OF QMVA" — the true source of lead/revenue data. Its CSV/gviz export hangs indefinitely
// (confirmed repeatedly — unbounded IMPORTRANGE chains elsewhere in the workbook make Google's
// export renderer choke on the whole file, even for a single tab). The Sheets API v4 values.get
// endpoint reads it fine though, so qmva-nw/ca/agency below go through that instead of CSV,
// authenticated as the account's own OAuth refresh token (OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN
// env vars — see scripts/get_refresh_token.js for how that token was minted). This replaces the
// old approach of an hourly Apps Script trigger copying these tabs into a separate "QMVA LIVE
// SNAPSHOT" spreadsheet for plain CSV export to reach — direct is faster and has no snapshot lag.
const LIST_OF_QMVA_DOC = '1x2pheLjtJbundc2EK24WM7rYwbGWzR_KH4TYrVaVbH4';
// "Walker QMVA Analysis" — a separate workbook the user manually checks against. Its "DATABASE PPL
// CA"/"DATABASE PPL NW" tabs carry the same per-lead Payout as Publisher Data CA/TX's Partner
// Commission (confirmed: 557/559 matched leads identical), but they're not interchangeable —
// found a real case (Ruby Pegross, 08-29-26) where Publisher Data showed $20 and this workbook
// had the correct $100. Per the user, Publisher Portal's own revenue can lag due to its recency/
// conversion timing. Not publicly CSV-exportable (requires sign-in), so read via the Sheets API
// like LIST_OF_QMVA_DOC above.
const QMVA_PAYOUT_DOC = '17o1K0HjIv2VK3IhjqIMnw74hPwU8iPZ7WCwlMcQF8nc';

let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry - 60000) {
    return Promise.resolve(cachedAccessToken);
  }
  const body = new URLSearchParams({
    client_id: process.env.OAUTH_CLIENT_ID,
    client_secret: process.env.OAUTH_CLIENT_SECRET,
    refresh_token: process.env.OAUTH_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!json.access_token) return reject(new Error('token refresh failed: ' + JSON.stringify(json)));
          cachedAccessToken = json.access_token;
          cachedAccessTokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
          resolve(cachedAccessToken);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('token request timed out')));
    req.end(body);
  });
}

function fetchSheetValuesOnce(docId, sheetName, range) {
  // Shares Google's 60-requests-per-minute-per-user quota with dashboard_sync.js/mirror_sync.js
  // (same account, same process) — see rate_limit.js's comment.
  return withRetry(() => getAccessToken().then((token) => new Promise((resolve, reject) => {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${docId}/values/${encodeURIComponent("'" + sheetName + "'!" + range)}`;
    const req = https.get(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    // LIST OF QMVA is heavy enough (unbounded IMPORTRANGE chains elsewhere in the workbook) that
    // even authenticated Sheets API reads regularly take 1-3 minutes per tab — confirmed via the
    // Apps Script Values.get approach this replaced, which saw the same slowness. 90s per attempt,
    // not longer: fetchSheetValuesViaApi retries this 3x, and a longer per-attempt timeout here
    // would let one hung connection burn the entire 5-minute pollMs budget by itself.
    req.setTimeout(90000, () => req.destroy(new Error('sheets api request timed out')));
  })));
}

// Fetches a sheet tab via the Sheets API v4 (not CSV export) and reshapes it into the same
// header-keyed row objects parseCSV() produces, so downstream normalize*Rows() functions don't
// need to know which fetch path was used.
//
// Google's backend genuinely struggles to serve this specific workbook sometimes — confirmed
// directly (a bare 5-row range request got zero response for 30s while every other Google
// endpoint answered instantly) — surfacing as either a 503 "service is currently unavailable" or
// a hung connection. Both are transient on Google's side, not something a code fix here can
// prevent, so retry a few times with backoff before giving up for this poll cycle; that's cheaper
// than waiting a full 5-minute pollMs cycle for the next attempt.
async function fetchSheetValuesViaApi(docId, sheetName, range) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * attempt));
    try {
      const text = await fetchSheetValuesOnce(docId, sheetName, range);
      const json = JSON.parse(text);
      if (json.error) throw new Error('Sheets API error: ' + JSON.stringify(json.error));
      const values = json.values || [];
      if (!values.length) return [];
      const headers = values[0].map((h) => (h || '').trim());
      return values.slice(1).map((r) => {
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = (r[idx] || '').toString().trim(); });
        obj.__col0 = (r[0] || '').toString().trim();
        return obj;
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const TABS = {
  // Read via the Sheets API (sheetName+apiRange), not CSV export (gid) — confirmed Google's CSV
  // export cache can get stuck serving stale data for these two tabs indefinitely after a bulk
  // API rewrite (dashboard_sync.js clears+rewrites thousands of rows here every cycle): the export
  // kept returning byte-identical stale content 15+ minutes and several cache-busting requests
  // after the underlying sheet was already correct, confirmed by reading the sheet directly via
  // the Sheets API. Other heavy/frequently-rewritten tabs in this file already avoid CSV export
  // for the same reason (see LIST_OF_QMVA_DOC tabs below) — this makes nw/ca consistent with that.
  // Virtual — no longer polled from the sheet directly. Populated by runLiveCampaigns() below,
  // which computes the exact same corrected rows dashboard_sync.js writes to these sheets, but
  // purely in memory from a read-only credential — see its comment for why. This is what makes
  // the dashboard update on its own, on Render, without a write-scoped credential or a manual
  // sync from a laptop.
  'nw':          { name: 'NW PPL',      virtual: true },
  'ca':          { name: 'CA PPL',      virtual: true },
  // Virtual — computed from nw+ca above by updateGlobalPpl() after every poll pass, instead of
  // reading the spreadsheet's own GLOBAL tab (gid 502521114). GLOBAL's formula —
  // =QUERY({'NW PPL CAMPAIGN'!A2:Y; 'CA PPL CAMPAIGN'!A3:Y}, "SELECT * WHERE Col1 IS NOT NULL")
  // — silently drops rows: QUERY infers each column's type from the whole column, and Column B
  // (blank on ordinary rows, carrying a lead's phone number on the Publisher-correction rows —
  // see refreshOne()'s comment in scripts/refresh_campaign_snapshot.js) gets inferred numeric,
  // so correction rows fail that inferred type and vanish, along with their revenue. Confirmed
  // directly: on a day with a real $6,395 in NW correction revenue, GLOBAL showed $0 for NW.
  // Combining nw+ca here in code reads the exact same rows the dashboard's own NW PPL/CA PPL
  // tabs show, so Global PPL can never again disagree with them.
  'ca-nw':       { name: 'CA/NW PPL',   virtual: true },
  // Virtual — no docId/gid, computed by computeLiveVertical() after every poll pass from the
  // qmva-*/ad-spend-*-live tabs below, and cached the same way as any other tab.
  'live-nw':     { name: 'Live NW',     virtual: true },
  'live-ca':     { name: 'Live CA',     virtual: true },
  'live-agency': { name: 'Live Agency', virtual: true },
  'media-spend': { name: 'Media Spend', docId: MEDIA_SPEND_DOC, gid: '896271249', type: 'media-spend' }, // Media Spend Tracker
  'agency-leads': { name: 'Agency Leads', docId: AGENCY_LEADS_DOC, gid: '0', type: 'agency-leads' },
  'google-ad-spent': { name: 'Google Ad Spent', docId: AGENCY_LEADS_DOC, gid: '1569735885', type: 'google-ad-spent' },
  // Per-lead QMVA exports (one row per qualified/unqualified lead) — feed computeLiveVertical().
  // NW uses "NW QMVA List" (not "Import NW QMVA"): the same-looking "Import" tab has no per-lead
  // Payout column at all, which made NW revenue always $0. "NW QMVA List" was empty the first
  // time it was checked this session (its formulas hadn't finished computing yet) and got wrongly
  // ruled out — it does have a real Payout column, same shape as CA/Agency's sources.
  // pollMs 5 min (not the default 60s): each fetch takes 1-3 min on its own against this heavy
  // doc, so polling every 60s would just pile up overlapping requests for no benefit.
  'qmva-nw':     { name: 'QMVA NW',     docId: LIST_OF_QMVA_DOC, sheetName: 'NW QMVA List',     apiRange: 'A1:S20000', type: 'qmva-import', vertical: 'nw',     pollMs: 300000 },
  'qmva-ca':     { name: 'QMVA CA',     docId: LIST_OF_QMVA_DOC, sheetName: 'CA QMVA List',     apiRange: 'A1:S20000', type: 'qmva-import', vertical: 'ca',     pollMs: 300000 },
  // Switched from LIST_OF_QMVA_DOC's "AGENCY QMVA List" (chronically slow/unreliable — a fetch
  // here regularly timed out past 90s) to QMVA_PAYOUT_DOC's "Agency QMVAs" tab, then that tab
  // itself disappeared/got renamed at some point (confirmed: not in the workbook's tab list any
  // more, causing every fetch to 400 "Unable to parse range" and the Agency Dashboard to show no
  // QMVA at all). "DATABASE AGENCY" has the exact same per-lead shape (Date/Consumer State/
  // Qualified Flag/Law Type Broad/Campaign/CAMPAIGN/AD/Payout all present, live current data).
  'qmva-agency': { name: 'QMVA Agency', docId: QMVA_PAYOUT_DOC, sheetName: 'DATABASE AGENCY', apiRange: 'A1:U50630', type: 'qmva-import', vertical: 'agency', pollMs: 300000 },
  // Per-ad-per-day spend (every ad running that day, whether or not it produced a lead) —
  // the "other ads running that day" the live QMVA lists don't carry on their own. Read directly
  // from each one's real source doc (see comments above) instead of through LIST OF QMVA's
  // IMPORTRANGE wrapper — same data, ~1s instead of 15+ min.
  'ad-spend-google-live': { name: 'Google Ad Spend Live', docId: GOOGLE_AD_SPENT_DOC, gid: '0',       type: 'ad-spend-live', platform: 'google' },
  'ad-spend-meta-live':   { name: 'Meta Ad Spend Live',   docId: MAIN_DOC,           gid: '727642936', type: 'ad-spend-live', platform: 'meta' },
  // Plain CSV reads of the tabs scripts/track_late_and_restored.js maintains — a Late QMVA is a
  // lead that was $0 and just converted for the first time; a Restored lead was nonzero, dropped
  // to $0, and just came back. Simple pass-through, not part of computeLiveVertical().
  'late-qmvas':     { name: 'Late QMVAs',     docId: MAIN_DOC, gid: '1342057110', type: 'raw-table' },
  'restored-leads': { name: 'Restored Leads', docId: MAIN_DOC, gid: '718243610',  type: 'raw-table' },
  // Campaign 2 (the short intake code like "LoudrNWCPA") for nw/ca/ca-nw was only ever being
  // filled in from qmva-nw/qmva-ca above, both sourced from the chronically slow/unreliable
  // LIST_OF_QMVA_DOC — confirmed those two tabs sit at 0 cached rows for long stretches, which
  // meant Campaign 2 was permanently empty. Import_NW/CA PPL QMVA carry the exact same
  // date+adName+campaign2 data but live in MAIN_DOC (not the flaky doc) and export in ~4s, so
  // enrichCampaigns() below now sources from these instead — same join key, reliable data.
  'import-nw': { name: 'Import NW QMVA', docId: MAIN_DOC, gid: '1547595825', type: 'import-qmva', vertical: 'nw' },
  'import-ca': { name: 'Import CA QMVA', docId: MAIN_DOC, gid: '768150244',  type: 'import-qmva', vertical: 'ca' },
  // Real per-lead detail (name, phone, actual commission) for the Global PPL "Lead Detail" tab —
  // nw/ca/ca-nw above are aggregated by date+ad+state, so this is the only tab with one row per
  // real lead. Same source refresh_campaign_snapshot.js already reads as ground truth.
  // 36,000+ rows, 26 columns in the raw sheet — trimmed to just the ones the Lead Detail table and
  // enrichPublisherLeadsCommission actually use (see normalizePublisherLeadsRows), not kept as a
  // raw-table pass-through: the full untrimmed shape was ~3x the memory for no benefit, and was
  // part of what pushed this process over its memory limit (see the OOM incident this fixed).
  'publisher-leads': { name: 'Publisher Leads', docId: MAIN_DOC, gid: '858250735', type: 'publisher-leads' },
  // Cross-check source for publisher-leads' commission — see QMVA_PAYOUT_DOC comment above.
  'qmva-payout-ca': { name: 'QMVA Payout CA', docId: QMVA_PAYOUT_DOC, sheetName: 'DATABASE PPL CA', apiRange: 'A1:T20000', type: 'qmva-payout', phoneCol: 'Phone Number', payoutCol: 'Payout' },
  'qmva-payout-nw': { name: 'QMVA Payout NW', docId: QMVA_PAYOUT_DOC, sheetName: 'DATABASE PPL NW', apiRange: 'A1:T20000', type: 'qmva-payout', phoneCol: 'Phone Number', payoutCol: 'Payout' },
};

// Per-vertical QMVA column layouts differ slightly between the three QMVA list tabs.
// campaign is the long per-ad-copy name (e.g. "PPL - TEXAS - YT - Long Form - 020926"); campaign2
// is the short intake code from the sheet's own separate "Campaign"/"Campaigns" column (e.g.
// "LoudrNWCPA", "LoudrNWDQ") — same idea, coarser grouping, and the two live in different columns.
const QMVA_FIELDS = {
  nw:     { state: 'Incident State',  ad: 'AD', campaign: 'CAMPAIGN', campaign2: 'Campaign',  payout: 'Payout' },
  ca:     { state: 'STATE',           ad: 'AD', campaign: 'Campaign', campaign2: 'Campaigns', payout: 'Payout' },
  agency: { state: 'Consumer State',  ad: 'AD', campaign: 'CAMPAIGN', campaign2: 'Campaign',  payout: 'Payout' },
};
// How each vertical's campaigns are identified inside the shared Google/Meta Ad Spend (Live)
// sheets — per the user: "if the campaign name does have LOUDRCA/PPL/WAGENCY, get all the ads
// running that day and the ad spend, so no revenue at all so negative profit."
const VERTICAL_CAMPAIGN_PATTERN = { nw: /PPL/i, ca: /LOUDRCA/i, agency: /WAGENCY/i };
// 60s instead of 8s — cuts how often server.js fetches Google's CSV export. Render's billing
// page shows the free-tier 5 GB/month cap was blown almost entirely by "Service-Initiated"
// bandwidth (5.32 of 7.13 GB) — i.e. these outbound fetches to Google, not traffic served to
// dashboard visitors ("HTTP Responses" was only 1.81 GB, which gzip below also now shrinks).
const POLL_MS = 60000;

let cache = {}; // key -> { rows, csvHash }

function csvUrl(docId, gid) {
  return `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${gid}`;
}

function fetchText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    // Google's CSV export honors Accept-Encoding — these CSVs are highly repetitive text, so
    // asking for gzip shrinks the "Service-Initiated" bandwidth that blew Render's free-tier cap
    // (these outbound fetches to Google, not traffic served to visitors, was 5.32 of the 7.13 GB
    // used against the 5 GB/month limit).
    const req = https.get(url, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchText(res.headers.location, redirects - 1));
      }
      const isGzip = (res.headers['content-encoding'] || '').includes('gzip');
      const stream = isGzip ? res.pipe(zlib.createGunzip()) : res;
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    // Google's export CDN occasionally hangs indefinitely on a redirected/large-sheet request —
    // without this, a stuck request never resolves or rejects, so its tab silently stops polling.
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
  });
}

// Minimal RFC4180-ish CSV parser (handles quoted fields with commas/newlines/escaped quotes)
// Shared RFC4180-ish tokenizer: splits raw CSV text into rows of raw string cells. Pulled out of
// parseCSV so parseCSVOnlyColumns (below) can reuse the exact same tokenizing without also paying
// for a full per-row object across every column — see that function's comment.
function tokenizeCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Minimal RFC4180-ish CSV parser (handles quoted fields with commas/newlines/escaped quotes)
function parseCSV(text) {
  const rows = tokenizeCSV(text);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => v && v.trim() !== ''))
    .map((r) => {
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = (r[idx] || '').trim(); });
      // Column A is always the date in these sheets — keep it by position too, so a renamed or
      // corrupted "Date" header cell (this has happened before) doesn't silently drop every row.
      obj.__col0 = (r[0] || '').trim();
      return obj;
    });
}

// Same CSV, but only ever materializes an object with the columns in `wantedHeaders` — for a
// 36,000-row/26-column sheet where only 9 columns are ever read downstream (publisher-leads), the
// full per-row object held all 26 columns' strings in memory for every row just to immediately
// throw away 17 of them; building the trimmed shape directly instead (never allocating the other
// 17 columns' worth of strings per row to begin with) was the single biggest lever for the heap
// pressure that caused the OOM crash this was added to fix.
function parseCSVOnlyColumns(text, wantedHeaders) {
  const rows = tokenizeCSV(text);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  const wantedIdx = headers.map((h, idx) => (wantedHeaders.has(h) ? idx : -1)).filter((idx) => idx !== -1);
  const wantedNames = wantedIdx.map((idx) => headers[idx]);
  return rows.slice(1)
    .filter((r) => r.some((v) => v && v.trim() !== ''))
    .map((r) => {
      const obj = {};
      for (let i = 0; i < wantedIdx.length; i++) obj[wantedNames[i]] = (r[wantedIdx[i]] || '').trim();
      return obj;
    });
}

function num(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[$,]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Google Ad Spent's "Day" column is ISO (YYYY-MM-DD) while every other sheet in this app uses
// M/D/YYYY — normalize so the shared parseDate()/date-filter code on the frontend works unchanged.
function isoToMDY(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  if (!m) return v || '';
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

// The QMVA import tabs use zero-padded M/D/YYYY ("08/23/2026") while Google/Meta Ad Spent use
// unpadded ("8/23/2026") — computeLiveVertical joins by date+adId, so these must match exactly.
function stripDatePadding(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v || '');
  if (!m) return v || '';
  return `${Number(m[1])}/${Number(m[2])}/${m[3]}`;
}

const NW_CA_HEADER = [
  'Date', 'Accepted Total Leads', 'Total Leads', 'CPL', 'Youtube Ad Spent', 'Facebook Ad Spent',
  'Total Amount Spent', 'Youtube QMVA', 'Other QMVA', 'Phone QMVA', 'Current QMVA', 'Revenue',
  'Profit', 'STATE', 'Ad Name', '.', 'State', 'Campaign', 'CAMPAIGN ID',
];
function computedRowsToObjects(rows) {
  return rows.map((row) => {
    const obj = {};
    NW_CA_HEADER.forEach((h, i) => { obj[h] = row[i] == null ? '' : String(row[i]); });
    obj.__col0 = obj['Date'];
    return obj;
  });
}

function normalizeRows(raw) {
  return raw.map((r) => ({
    date: r['Date'] || r.__col0 || '',
    totalLeads: num(r['Total Leads']),
    acceptedLeads: num(r['Accepted Total Leads'] || r['Approved Leads']),
    totalSpent: num(r['Total Amount Spent']),
    facebookSpent: num(r['Facebook Ad Spent']),
    youtubeSpent: num(r['Youtube Ad Spent']),
    currentQmva: num(r['Current QMVA']),
    youtubeQmva: num(r['Youtube QMVA']),
    revenue: num(r['Revenue'] || r['Pay Out = Revenue']),
    profit: num(r['Profit']),
    state: (r['State'] && r['State'].trim()) || r['STATE'] || '',
    adName: r['Ad Name'] || '',
    campaign: r['Campaign'] || '',
    campaign2: '',
  })).filter((r) => r.date);
}

// Import_NW/CA PPL QMVA column layouts differ (same idea as QMVA_FIELDS above, different sheets):
// NW: campaign2 (short code) is column "Campaign", campaign (long ad-copy name) is "CAMPAIGN".
// CA: campaign2 is "Campaigns", campaign is "Campaign". Ad name is "AD" in both.
const IMPORT_QMVA_FIELDS = {
  nw: { campaign2: 'Campaign', campaign: 'CAMPAIGN' },
  ca: { campaign2: 'Campaigns', campaign: 'Campaign' },
};
function normalizePhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function normalizeQmvaPayoutRows(raw, phoneCol, payoutCol) {
  return raw.map((r) => ({
    phone: normalizePhone(r[phoneCol]),
    payout: num(r[payoutCol]),
  })).filter((r) => r.phone && r.payout);
}

function normalizeImportQmvaRows(raw, vertical) {
  const f = IMPORT_QMVA_FIELDS[vertical];
  return raw.map((r) => ({
    date: r['Date'] || r.__col0 || '',
    adName: r['AD'] || '',
    campaign: r[f.campaign] || '',
    campaign2: r[f.campaign2] || '',
  })).filter((r) => r.date && r.adName);
}

// "Media Spend Tracker": Vendor, Media Source, State, Date, Daily Spend ($), Agency Fee ($),
// Agency Fee (%), Total ($). Mapped onto the same row shape the PPL sheets use (totalSpent,
// state, adName, etc.) so it plugs straight into the existing date-filter/summary-table code,
// plus two extra fields (agencyFee, totalWithFee) for the real fee-inclusive spend figure.
function normalizeMediaSpendRows(raw) {
  return raw.map((r) => ({
    date: r['Date'] || r.__col0 || '',
    totalLeads: 0,
    acceptedLeads: 0,
    totalSpent: num(r['Daily Spend ($)']),
    facebookSpent: 0,
    youtubeSpent: 0,
    currentQmva: 0,
    youtubeQmva: 0,
    revenue: 0,
    profit: 0,
    state: r['State'] || '',
    adName: [r['Vendor'], r['Media Source']].filter(Boolean).join(' - '),
    agencyFee: num(r['Agency Fee ($)']),
    totalWithFee: num(r['Total ($)']),
  })).filter((r) => r.date);
}

// "AGENCY Leads Import": one row per lead (Date, Name, Email, Contact Source, ...). Contact Source
// carries the state in a "(XX Google)" suffix, e.g. "Agency 9. (W1) - Walker (NV Google)". Each
// row counts as exactly one lead — mapped onto the shared row shape so it plugs into the existing
// date-filter code, with totalLeads: 1 per row for a simple sum-based count.
const STATE_FROM_SOURCE = /\(([A-Z]{2})\s+Google\)/;
function normalizeAgencyLeadsRows(raw) {
  return raw.map((r) => {
    const m = STATE_FROM_SOURCE.exec(r['Contact Source'] || '');
    return {
      date: r['Date'] || r.__col0 || '',
      totalLeads: 1,
      acceptedLeads: 0,
      totalSpent: 0,
      facebookSpent: 0,
      youtubeSpent: 0,
      currentQmva: 0,
      youtubeQmva: 0,
      revenue: 0,
      profit: 0,
      state: m ? m[1] : '',
      adName: r['Contact Source'] || '',
      // UTM Term is the join key back to the Google Ad Spent sheet's "Ad ID" column.
      utmTerm: r['UTM Term'] || '',
    };
  }).filter((r) => r.date);
}

// "Google Ad Spent (Live)": one row per ad per day (Day, Campaign Name, Ad Group Name, Ad Name,
// Cost (Spend), Ad ID, ...). Ad ID is the join key matching a lead's UTM Term.
function normalizeGoogleAdSpentRows(raw) {
  return raw.map((r) => ({
    date: isoToMDY(r['Day'] || r.__col0 || ''),
    totalLeads: 0,
    acceptedLeads: 0,
    totalSpent: num(r['Cost (Spend)']),
    facebookSpent: 0,
    youtubeSpent: 0,
    currentQmva: 0,
    youtubeQmva: 0,
    revenue: 0,
    profit: 0,
    state: '',
    adName: r['Ad Name'] || '',
    adId: r['Ad ID'] || '',
    campaignName: r['Campaign Name'] || '',
  })).filter((r) => r.date);
}

// "Import NW/CA/Agency QMVA": one row per lead (Date, [state field], Qualified Flag, ..., AD,
// AD ID, [Payout for CA/Agency; NW has no per-lead payout column]).
// A handful of rows in the QMVA source are column-shifted (e.g. a summary/header row like
// "CAMPAIGN NAME" / "TOTAL NON MVA" landing in the data), which puts a non-date string — or
// nothing at all — in the Date column. Require an actual M/D/YYYY-shaped value.
const VALID_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

function normalizeQmvaRows(raw, vertical) {
  const f = QMVA_FIELDS[vertical];
  return raw.map((r) => ({
    date: stripDatePadding(r['Date'] || r.__col0 || ''),
    state: (r[f.state] && r[f.state].trim()) || '',
    adId: r['AD ID'] || '',
    adName: r[f.ad] || '',
    campaign: r[f.campaign] || '',
    campaign2: r[f.campaign2] || '',
    qualified: /^yes$/i.test((r['Qualified Flag'] || '').trim()),
    lawType: (r['Law Type Broad'] || '').trim(),
    payout: f.payout ? num(r[f.payout]) : 0,
  })).filter((r) => VALID_DATE.test(r.date));
}

// "Google/Meta Ad Spend (Live)": one row per ad per day, every ad that ran — whether or not it
// produced a lead. Day is ISO (YYYY-MM-DD) on both, like Google Ad Spent elsewhere in this file.
function normalizeAdSpendLiveRows(raw, platform) {
  return raw.map((r) => ({
    date: isoToMDY(r['Day'] || r.__col0 || ''),
    campaignName: r['Campaign Name'] || '',
    adName: r['Ad Name'] || '',
    adId: r['Ad ID'] || '',
    spend: num(platform === 'google' ? r['Cost (Spend)'] : r['Amount Spent']),
  })).filter((r) => VALID_DATE.test(r.date));
}

// Same campaign whitelist the Lead Detail table itself filters to (see LEAD_DETAIL_CA/NW in
// walker-public/app.js) — everything outside it (Agency traffic, LoudrDupe, anything else) is
// never shown there, so there's no reason to carry it in memory either. Applied at the CAMPAIGN
// level only, never by commission: a lead can start at $0 and get boosted to its real payout later
// by enrichPublisherLeadsCommission, so filtering out $0 rows here would wrongly discard the very
// candidates that enrichment still needs to find.
const PUBLISHER_LEADS_CAMPAIGNS = new Set([
  'Loudr', 'LoudrDQ', 'LoudrSPCA', 'LoudrSP_DQ', 'Loudr - IB SP', 'Loudr - IB CA', 'LoudrCA - IB SP',
  'LoudrNWCPA', 'LoudrNWDQ', 'Loudr - IB NW TX', 'LoudrNWCPA - IB', 'Loudr - IB NW GA', 'LoudrNWCPA_SP',
  'LoudrNWCPA - IB SP', 'LoudrNW', 'Loudr - IB Catchall',
]);
// Fed to parseCSVOnlyColumns so the CSV parse itself never builds the other 17 columns per row.
const PUBLISHER_LEADS_WANTED_COLUMNS = new Set([
  'Date', 'First Name', 'Last Name', 'Consumer Phone', 'Consumer Phone(Primary)',
  'Incident State', 'Campaign', 'Partner Commission', 'Qualified',
]);
// Same key names as the raw sheet (enrichPublisherLeadsCommission and the Lead Detail table both
// read these by name) — just the 9 of 26 columns anything downstream actually touches, and only
// the campaigns the Lead Detail table can ever show (cuts ~36,000 raw rows down to a few thousand
// — this file alone, at full width, was a meaningful share of the OOM crash this was added to fix).
function normalizePublisherLeadsRows(raw) {
  return raw
    .filter((r) => PUBLISHER_LEADS_CAMPAIGNS.has(r['Campaign']))
    .map((r) => ({
      Date: r['Date'] || '',
      'First Name': r['First Name'] || '',
      'Last Name': r['Last Name'] || '',
      'Consumer Phone': r['Consumer Phone'] || '',
      'Consumer Phone(Primary)': r['Consumer Phone(Primary)'] || '',
      'Incident State': r['Incident State'] || '',
      Campaign: r['Campaign'] || '',
      'Partner Commission': r['Partner Commission'] || '',
      Qualified: r['Qualified'] || '',
    }));
}

// Builds LIVE NW/CA/AGENCY by joining, per (date, ad): lead counts + revenue from the QMVA
// import, with spend from Google/Meta Ad Spend (Live) filtered to this vertical's campaigns.
// An ad that spent money but produced no lead that day still gets a row — $0 revenue, negative
// profit — exactly like the original Sheets formula's VSTACK of the two branches did, just
// computed in JS instead of an in-sheet array formula Google's backend can't finish in time.
// Real campaign identifiers (e.g. "LOUDRCA - YT - LF - New Vids Ron - 062226") look nothing like
// this — a handful of rows in the QMVA source are column-shifted and leak a dollar amount or bare
// number into the Campaign field instead. Never surface those as filter options.
const GARBAGE_CAMPAIGN = /^[\s$0-9,.\-]*$/;


function computeLiveVertical(vertical) {
  const qmvaRows = (cache['qmva-' + vertical] && cache['qmva-' + vertical].rows) || [];
  const googleRows = (cache['ad-spend-google-live'] && cache['ad-spend-google-live'].rows) || [];
  const metaRows = (cache['ad-spend-meta-live'] && cache['ad-spend-meta-live'].rows) || [];
  const pattern = VERTICAL_CAMPAIGN_PATTERN[vertical];

  const byKey = new Map();
  function entryFor(date, adKey, adName, state, campaign, campaign2) {
    const k = date + '|' + (adKey || adName || '');
    let e = byKey.get(k);
    if (!e) {
      e = { date, adName: adName || '', state: state || '', campaign: campaign || '', campaign2: campaign2 || '',
        totalLeads: 0, acceptedLeads: 0, revenue: 0, totalSpent: 0, youtubeSpent: 0, facebookSpent: 0 };
      byKey.set(k, e);
    }
    if (!e.adName && adName) e.adName = adName;
    if (!e.state && state) e.state = state;
    if (!e.campaign && campaign) e.campaign = campaign;
    if (!e.campaign2 && campaign2) e.campaign2 = campaign2;
    return e;
  }

  // Campaign comes only from the QMVA lead source (the real "LOUDRCA/LOUDRNW/LOUDRSP/..." names
  // tracked at intake) — not from Google/Meta's own "Campaign Name" column, which is a long,
  // per-ad-copy platform string, not the campaign identifier the user actually wants to filter by.
  // Campaign 2 is the short intake code from that same QMVA sheet's separate Campaign/Campaigns
  // column (e.g. "LoudrNWCPA", "LoudrNWDQ") — a coarser grouping the user also wants to filter by.
  qmvaRows.forEach((r) => {
    const campaign = r.campaign && !GARBAGE_CAMPAIGN.test(r.campaign) ? r.campaign : '';
    const campaign2 = r.campaign2 && !GARBAGE_CAMPAIGN.test(r.campaign2) ? r.campaign2 : '';
    const e = entryFor(r.date, r.adId, r.adName, r.state, campaign, campaign2);
    e.totalLeads += 1;
    // Agency's QMVA count only counts MVA leads (per the user, checked against column D "Law
    // Type Broad" in Agency QMVAs) — NW/CA aren't restricted this way, only agency.
    const countsAsQmva = vertical === 'agency' ? r.lawType === 'MVA' : true;
    if (r.qualified && countsAsQmva) e.acceptedLeads += 1;
    e.revenue += r.payout;
  });
  googleRows.forEach((r) => {
    if (!pattern.test(r.campaignName)) return;
    const e = entryFor(r.date, r.adId, r.adName, '', '', '');
    e.totalSpent += r.spend;
    e.youtubeSpent += r.spend;
  });
  metaRows.forEach((r) => {
    if (!pattern.test(r.campaignName)) return;
    const e = entryFor(r.date, r.adId, r.adName, '', '', '');
    e.totalSpent += r.spend;
    e.facebookSpent += r.spend;
  });

  return Array.from(byKey.values()).map((e) => ({
    date: e.date,
    totalLeads: e.totalLeads,
    acceptedLeads: e.acceptedLeads,
    totalSpent: e.totalSpent,
    facebookSpent: e.facebookSpent,
    youtubeSpent: e.youtubeSpent,
    currentQmva: e.acceptedLeads,
    youtubeQmva: 0,
    revenue: e.revenue,
    profit: e.revenue - e.totalSpent,
    state: e.state,
    adName: e.adName,
    campaign: e.campaign,
    campaign2: e.campaign2,
  }));
}

function updateLiveVertical(vertical) {
  const key = 'live-' + vertical;
  const rows = computeLiveVertical(vertical);
  const prev = cache[key];
  const hash = rows.length + ':' + rows.reduce((s, r) => s + r.totalSpent + r.revenue, 0);
  if (!prev || prev.hash !== hash) {
    cache[key] = { rows, hash, updatedAt: Date.now() };
    broadcast(key);
    console.log(`[${new Date().toISOString()}] ${key}: ${rows.length} rows (joined)`);
  }
}

// Builds the virtual 'ca-nw' (Global PPL) tab straight from the already-polled/deduped nw+ca
// caches, instead of the spreadsheet's own GLOBAL formula tab — see the 'ca-nw' TABS comment.
function updateGlobalPpl() {
  const nwRows = (cache['nw'] && cache['nw'].rows) || [];
  const caRows = (cache['ca'] && cache['ca'].rows) || [];
  if (!cache['nw'] && !cache['ca']) return;
  const rows = [...nwRows, ...caRows];
  const prev = cache['ca-nw'];
  const hash = rows.length + ':' + rows.reduce((s, r) => s + r.totalSpent + r.revenue, 0);
  if (!prev || prev.hash !== hash) {
    cache['ca-nw'] = { rows, hash, updatedAt: Date.now() };
    broadcast('ca-nw');
    console.log(`[${new Date().toISOString()}] ca-nw: ${rows.length} rows (joined from nw+ca)`);
  }
}

// Global PPL / NW & CA PPL (ca-nw/nw/ca) read MAIN_DOC directly, whose own "Campaign" column is
// just the coarse "CALIFORNIA"/"NATIONWIDE" grouping — not the real Loudr campaign codes
// (LOUDRCA/LOUDRNW/LOUDRIB/etc.) the user actually wants to filter by. Those live in the QMVA
// import tabs instead (same per-lead Campaign field computeLiveVertical uses), keyed by ad name,
// so build a date+adName -> real campaign lookup from qmva-nw/qmva-ca and use it to overwrite the
// coarse value wherever a match exists, per tab, in place.
function enrichCampaigns() {
  const lookup = new Map();
  const lookup2 = new Map();
  // import-nw/import-ca (Import_NW/CA PPL QMVA, in MAIN_DOC) are the reliable source — qmva-nw/
  // qmva-ca below are read from LIST_OF_QMVA_DOC, which has a long history of going empty for
  // extended stretches (confirmed: sat at 0 cached rows), silently leaving Campaign 2 blank
  // everywhere. Both are kept in the lookup pass — import-*/qmva-* fill in whatever the other
  // one is missing for a given date+adName, never overwriting an entry already found.
  ['import-nw', 'import-ca', 'qmva-nw', 'qmva-ca'].forEach((key) => {
    const rows = (cache[key] && cache[key].rows) || [];
    rows.forEach((r) => {
      if (!r.date || !r.adName) return;
      const k = r.date + '|' + r.adName;
      if (r.campaign && !GARBAGE_CAMPAIGN.test(r.campaign) && !lookup.has(k)) lookup.set(k, r.campaign);
      if (r.campaign2 && !GARBAGE_CAMPAIGN.test(r.campaign2) && !lookup2.has(k)) lookup2.set(k, r.campaign2);
    });
  });
  if (!lookup.size && !lookup2.size) return;
  ['nw', 'ca', 'ca-nw'].forEach((key) => {
    const entry = cache[key];
    if (!entry) return;
    entry.rows.forEach((r) => {
      const k = r.date + '|' + r.adName;
      const real = lookup.get(k);
      if (real) r.campaign = real;
      const real2 = lookup2.get(k);
      if (real2) r.campaign2 = real2;
    });
  });
}

// Publisher Data CA/TX's Partner Commission can lag the real payout (per the user: Publisher
// Portal's own revenue is sometimes wrong because of its recency/conversion timing) — confirmed
// with a real case (Ruby Pegross, 08-29-26: Publisher Data showed $20, QMVA_PAYOUT_DOC had the
// correct $100). Take the higher of the two per phone number, same never-undercount approach as
// refresh_campaign_snapshot.js's getPublisherLeads().
function enrichPublisherLeadsCommission() {
  const payoutByPhone = new Map();
  ['qmva-payout-ca', 'qmva-payout-nw'].forEach((key) => {
    const rows = (cache[key] && cache[key].rows) || [];
    rows.forEach((r) => {
      if (!r.phone) return;
      payoutByPhone.set(r.phone, Math.max(payoutByPhone.get(r.phone) || 0, r.payout));
    });
  });
  if (!payoutByPhone.size) return;
  const entry = cache['publisher-leads'];
  if (!entry) return;
  entry.rows.forEach((r) => {
    // Publisher Data can carry a disqualified duplicate row ($0, Qualified: No) alongside the
    // real qualified row for the same phone/date — boosting the $0 duplicate too double-counts
    // revenue the real row already contributes. Only correct a Qualified row.
    if (String(r['Qualified'] || '').trim().toLowerCase() !== 'yes') return;
    const phone = normalizePhone(r['Consumer Phone'] || r['Consumer Phone(Primary)']);
    const payout = phone && payoutByPhone.get(phone);
    if (!payout) return;
    const current = num(r['Partner Commission']);
    if (payout > current) r['Partner Commission'] = String(payout);
  });
}

// Some sheets (LIVE AGENCY in particular) contain exact-duplicate rows — same date/state/ad/every
// column — which silently double-counts sums like Current QMVA. Collapse identical rows to one;
// a real second lead on the same day/state/ad would still differ in at least one other column.

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const key = JSON.stringify(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Heavy computed tabs (LIVE AGENCY's VSTACK/QUERY formula chain) occasionally export mid-
// recalculation and every cell comes back as the literal string "#N/A" instead of real data.
// Drop those rows outright rather than let them masquerade as a (garbage) row of real data.
const ERROR_TOKEN = /^#(N\/A|REF!|ERROR!|VALUE!|DIV\/0!|NAME\?|NULL!)$/;
// LIVE AGENCY's formula also has a second failure mode: its VSTACK falls back to a literal
// {DATE(1900,1,1), 0, 0, ...} sentinel row when every one of its 5 source branches (Google Ad
// Spent, Meta Ad Spent, FB Data TX x2, LIVE IMPORT AGENCY QMVA) returns nothing — a real lead
// would never have this date, so treat it the same as an error row.
const SENTINEL_DATE = /^1\/1\/1900$/;
function dropErrorRows(rows) {
  return rows.filter((r) =>
    !ERROR_TOKEN.test(r.date) && !ERROR_TOKEN.test(r.state) && !ERROR_TOKEN.test(r.adName) &&
    !SENTINEL_DATE.test(r.date));
}

function broadcast() {} // no SSE in this port — the frontend just polls getData() periodically
function broadcastHeartbeat() {}

async function pollTab(key) {
  const { docId, gid, type, sheetName, apiRange } = TABS[key];
  try {
    const raw = sheetName
      ? await fetchSheetValuesViaApi(docId, sheetName, apiRange)
      : type === 'publisher-leads'
        ? parseCSVOnlyColumns(await fetchText(csvUrl(docId, gid)), PUBLISHER_LEADS_WANTED_COLUMNS)
        : parseCSV(await fetchText(csvUrl(docId, gid)));
    const normalized = type === 'media-spend' ? normalizeMediaSpendRows(raw)
      : type === 'agency-leads' ? normalizeAgencyLeadsRows(raw)
      : type === 'google-ad-spent' ? normalizeGoogleAdSpentRows(raw)
      : type === 'qmva-import' ? normalizeQmvaRows(raw, TABS[key].vertical)
      : type === 'ad-spend-live' ? normalizeAdSpendLiveRows(raw, TABS[key].platform)
      : type === 'raw-table' ? raw // pass the sheet's own columns through unchanged
      : type === 'publisher-leads' ? normalizePublisherLeadsRows(raw)
      : type === 'import-qmva' ? normalizeImportQmvaRows(raw, TABS[key].vertical)
      : type === 'qmva-payout' ? normalizeQmvaPayoutRows(raw, TABS[key].phoneCol, TABS[key].payoutCol)
      : normalizeRows(raw);
    const withoutErrors = dropErrorRows(normalized);
    // Only the plain PPL/LIVE tabs (normalizeRows) are known to contain genuine exact-duplicate
    // rows. agency-leads strips out per-lead identifiers (Name/Email/Phone) during normalization,
    // so two different real leads on the same day/state/ad can land on an identical row shape —
    // deduping those would wrongly discard real leads, not fix a data bug.
    const rows = type ? withoutErrors : dedupeRows(withoutErrors);
    const prev = cache[key];
    // The sheet was mid-recalculation and returned nothing usable — keep serving the last good
    // cache (or stay empty on first boot) rather than publish a blank/broken tab; the next 8s
    // poll retries.
    if (!rows.length && normalized.length > 0) {
      console.warn(`[${new Date().toISOString()}] ${key}: fetch returned only error rows (#N/A etc.) — keeping previous cache`);
      return;
    }
    const hash = rows.length + ':' + JSON.stringify(raw).length;
    // Google's CSV export occasionally serves a truncated/interstitial response instead of the
    // real sheet (transient — the next 8s poll usually gets the full data). Guard against
    // publishing an obviously-truncated fetch over a good cached copy, which would otherwise
    // flash wrong numbers to the frontend.
    if (prev && prev.rows.length > 5 && rows.length < prev.rows.length * 0.5) {
      console.warn(`[${new Date().toISOString()}] ${key}: ignoring suspiciously short fetch (${rows.length} rows vs cached ${prev.rows.length})`);
      return;
    }
    if (!prev || prev.hash !== hash) {
      cache[key] = { rows, hash, updatedAt: Date.now() };
      broadcast(key);
      console.log(`[${new Date().toISOString()}] ${key}: ${rows.length} rows (updated)`);
    }
  } catch (err) {
    console.error(`poll error for ${key}:`, err.message);
  }
}

let lastPolled = {};

// Returns the in-flight/just-finished promise so on-demand callers (ensureTab, below) can await
// completion instead of racing it — the original app only ever fired this from a timer and never
// needed to await it itself.
function pollAllTabs() {
  const now = Date.now();
  const toPoll = Object.keys(TABS).filter((key) => {
    if (TABS[key].virtual) return false;
    const interval = TABS[key].pollMs || POLL_MS;
    return now - (lastPolled[key] || 0) >= interval;
  });
  toPoll.forEach((key) => { lastPolled[key] = now; });
  // Without this catch, one tab's rejected fetch became an unhandled promise rejection — which
  // newer Node versions terminate the whole process on by default, silently taking down every
  // other timer (including runSync's) with it until Render noticed and restarted the dyno.
  const p = Promise.all(toPoll.map((key) => pollTab(key))).then(() => {
    ['nw', 'ca', 'agency'].forEach(updateLiveVertical);
    updateGlobalPpl();
    enrichCampaigns();
    enrichPublisherLeadsCommission();
  }).catch((err) => {
    console.error(`[${new Date().toISOString()}] pollAll failed:`, err.message);
  });
  // Fires every pollAll pass regardless of whether any tab's data actually changed, so the
  // frontend's "checked Xs ago" indicator reflects real polling activity, not just updates.
  broadcastHeartbeat();
  return p;
}

// Populates cache['nw']/cache['ca'] directly from computeCorrectedCampaigns() (dashboard_sync.js)
// instead of pollTab reading the NW/CA PPL CAMPAIGN sheets — those sheets only ever reflect the
// last write-capable sync run (a laptop, or a Render deploy with a write-scoped credential). This
// runs against a plain READ-ONLY credential and serves the same corrected numbers straight from
// memory, so the dashboard stays live with nobody running a manual sync. Own timer, own stuck-lock
// guard, same cadence as the correction sync above (which keeps writing too, for scripts/tools
// that still read the sheet directly, e.g. mirror_sync.js's consolidated workbook).
const LIVE_INTERVAL_MS = 5 * 60 * 1000;
const LIVE_STALE_MS = LIVE_INTERVAL_MS * 3;
let liveInProgress = false;
let liveStartedAt = 0;
const liveStatus = {
  lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null,
  lastError: null, lastErrorAt: null, lastResult: null, totalRuns: 0,
};
function setComputedCache(key, computedRows) {
  const raw = computedRowsToObjects(computedRows);
  // No dedupeRows here, unlike pollTab: dedupeRows exists to guard against a stale CSV/API export
  // literally repeating a row (a Google-side export glitch), not to apply to our own computed
  // output. computeCorrectedCampaigns' correction rows carry one row per real lead but drop the
  // phone number in normalizeRows' shape, so two DIFFERENT leads with the same date/ad/state/
  // amount (extremely common — many commissions cluster on round numbers like $1,300/$2,340)
  // normalize to byte-identical objects and dedupeRows was silently discarding one of them as a
  // "duplicate." Confirmed live: this was dropping $736,233 of real revenue (394 NW + 185 CA rows)
  // — exactly the gap between the dashboard's $6.89M and the sheet's real $7.63M.
  const rows = dropErrorRows(normalizeRows(raw));
  const hash = rows.length + ':' + JSON.stringify(raw).length;
  const prev = cache[key];
  if (!prev || prev.hash !== hash) {
    cache[key] = { rows, hash, updatedAt: Date.now() };
    broadcast(key);
    console.log(`[${new Date().toISOString()}] ${key}: ${rows.length} rows (computed live, read-only)`);
  }
}
async function runLive() {
  if (liveInProgress) {
    if (Date.now() - liveStartedAt < LIVE_STALE_MS) return;
    console.error(`[${new Date().toISOString()}] runLiveCampaigns: prior run still "in progress" after ${Math.round((Date.now() - liveStartedAt) / 60000)} min — treating as stuck and clearing the lock`);
  }
  liveInProgress = true;
  liveStartedAt = Date.now();
  liveStatus.lastStartedAt = new Date(liveStartedAt).toISOString();
  liveStatus.totalRuns++;
  try {
    const { nw, ca } = await computeCorrectedCampaigns(getAccessToken);
    setComputedCache('nw', nw);
    setComputedCache('ca', ca);
    updateLiveVertical('nw');
    updateLiveVertical('ca');
    updateGlobalPpl();
    enrichCampaigns();
    enrichPublisherLeadsCommission();
    liveStatus.lastSuccessAt = new Date().toISOString();
    liveStatus.lastResult = { nw: nw.length, ca: ca.length };
    console.log(`[${new Date().toISOString()}] runLiveCampaigns: NW ${nw.length} rows, CA ${ca.length} rows`);
  } catch (err) {
    console.error('runLiveCampaigns failed:', err.message);
    liveStatus.lastError = err.message;
    liveStatus.lastErrorAt = new Date().toISOString();
  } finally {
    liveInProgress = false;
    liveStatus.lastFinishedAt = new Date().toISOString();
  }
}

// On-demand data loading (added after the always-on background polling + full computeCorrectedCampaigns
// recompute, held in memory across every tab at once, pushed this process over its 512MB heap limit
// in production and crash-looped the whole shared server — see the incident this was added to fix).
// Nothing here polls on a timer any more: a request for a given tab fetches/recomputes only what
// that tab actually needs, with the same staleness windows as before, so the data is only ever
// resident in memory while someone is actually looking at the Walker page.
let lastLiveRunAt = 0;
async function ensureLiveFresh() {
  if (cache['ca-nw'] && Date.now() - lastLiveRunAt < LIVE_INTERVAL_MS) return;
  lastLiveRunAt = Date.now();
  await runLive();
}
const LIVE_VERTICAL_DEPS = {
  nw: ['qmva-nw', 'ad-spend-google-live', 'ad-spend-meta-live'],
  ca: ['qmva-ca', 'ad-spend-google-live', 'ad-spend-meta-live'],
  agency: ['qmva-agency', 'ad-spend-google-live', 'ad-spend-meta-live'],
};
async function ensurePlainTab(key) {
  const now = Date.now();
  const interval = (TABS[key] && TABS[key].pollMs) || POLL_MS;
  if (cache[key] && now - (lastPolled[key] || 0) < interval) return;
  lastPolled[key] = now;
  await pollTab(key);
}
async function ensureTab(key) {
  if (key === 'ca-nw' || key === 'nw' || key === 'ca') {
    await ensureLiveFresh();
    return;
  }
  if (key.startsWith('live-')) {
    const vertical = key.slice(5);
    const deps = LIVE_VERTICAL_DEPS[vertical] || [];
    await Promise.all(deps.map(ensurePlainTab));
    updateLiveVertical(vertical);
    enrichCampaigns();
    enrichPublisherLeadsCommission();
    return;
  }
  if (TABS[key] && !TABS[key].virtual) {
    await ensurePlainTab(key);
    // Origin/campaign enrichment and the publisher-commission cross-check both read straight off
    // already-cached tabs (no network), so it's cheap to keep them current after any plain fetch.
    enrichCampaigns();
    enrichPublisherLeadsCommission();
  }
}

// Weekly ad spend vs late-QMVA revenue (see computeLateQmvaCorrelation's comment) — a lower-
// traffic analytical view, so computed lazily on request instead of its own polling interval, with
// a 5-minute cache so repeated page loads don't re-read every source tab each time.
const LATE_CORRELATION_TTL_MS = 5 * 60 * 1000;
let lateCorrelationCache = { weeks: null, updatedAt: 0 };
let lateCorrelationInFlight = null;
function getLateQmvaCorrelation() {
  if (lateCorrelationCache.weeks && Date.now() - lateCorrelationCache.updatedAt < LATE_CORRELATION_TTL_MS) {
    return Promise.resolve(lateCorrelationCache.weeks);
  }
  if (lateCorrelationInFlight) return lateCorrelationInFlight;
  lateCorrelationInFlight = computeLateQmvaCorrelation(getAccessToken)
    .then((weeks) => {
      lateCorrelationCache = { weeks, updatedAt: Date.now() };
      lateCorrelationInFlight = null;
      return weeks;
    })
    .catch((err) => {
      lateCorrelationInFlight = null;
      if (lateCorrelationCache.weeks) return lateCorrelationCache.weeks; // serve stale over an error
      throw err;
    });
  return lateCorrelationInFlight;
}

// Daily campaign-trends table (see computeCampaignTrends' comment) — same lazy-on-request,
// 5-minute-cached pattern as the late-QMVA correlation view above.
const CAMPAIGN_TRENDS_TTL_MS = 5 * 60 * 1000;
let campaignTrendsCache = { days: null, updatedAt: 0 };
let campaignTrendsInFlight = null;
function getCampaignTrends() {
  if (campaignTrendsCache.days && Date.now() - campaignTrendsCache.updatedAt < CAMPAIGN_TRENDS_TTL_MS) {
    return Promise.resolve(campaignTrendsCache.days);
  }
  if (campaignTrendsInFlight) return campaignTrendsInFlight;
  campaignTrendsInFlight = computeCampaignTrends(getAccessToken)
    .then((days) => {
      campaignTrendsCache = { days, updatedAt: Date.now() };
      campaignTrendsInFlight = null;
      return days;
    })
    .catch((err) => {
      campaignTrendsInFlight = null;
      if (campaignTrendsCache.days) return campaignTrendsCache.days;
      throw err;
    });
  return campaignTrendsInFlight;
}

module.exports = {
  ensureTab,
  getData: (key) => (cache[key] ? cache[key].rows : []),
  getUpdatedAt: (key) => (cache[key] ? cache[key].updatedAt : null),
  getLateQmvaCorrelation,
  getCampaignTrends,
};

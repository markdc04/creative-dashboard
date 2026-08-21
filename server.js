const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DOC_ID = '1YkpQh4hR96iMtvd_bvtrT0fN0zCaLQNKl3pa6Tix8BA';

// Daily-granular source tabs. Google/Meta give per-day spend per ad; CA/NW QMVA give per-lead
// revenue ("Payout") per ad. Joined by Ad ID into a compact per-day-per-ad fact table below.
//
// IMPORTANT: CA/NW QMVA are lead-level sheets and also contain personal data (name, email,
// phone). Only three columns are ever read from them — Date, AD ID, Payout — and only those
// three fields are kept in memory; every other column (including all PII) is dropped the
// instant a row is parsed and is never written to a variable, logged, or sent to the client.
const SOURCES = {
  googleSpend: { gid: '1803672839', kind: 'spend', platform: 'GOOGLE', dayField: 'Day', adIdField: 'Ad ID', amountField: 'Cost (Spend)', nameField: 'Ad Name', campaignField: 'Campaign Name' },
  caRevenue:   { gid: '1896619489', kind: 'revenue', dayField: 'Date', adIdField: 'AD ID', amountField: 'Payout' },
  nwRevenue:   { gid: '1741267253', kind: 'revenue', dayField: 'Date', adIdField: 'AD ID', amountField: 'Payout' },
};

// Creative asset/metadata lookup by Ad ID: YouTube URL, landing page URL, Frame.io URL, file name.
const CREATIVE_META_GID = '1768337683';

// "Creative Tracker 1" — a pre-joined, one-row-per-Ad-ID master sheet with genuinely accurate
// all-time QMVA/Leads/Accepted Leads/Cost Per Lead columns (unlike our own row-counting attempt
// against the raw CA/NW QMVA payout sheets, which only ever logs already-accepted leads and
// therefore can't distinguish submitted vs. accepted). These are all-time totals only — there's
// no daily breakdown available — so the client only surfaces them when no date filter is active.
const CREATIVE_TRACKER_GID = '623888576';

const POLL_MS = 30000;
const PORT = process.env.PORT || 4174;

let cache = { rows: [], updatedAt: null, hash: null };
let clients = []; // SSE response objects
let lastGoodAssets = {}; // adId -> asset/metadata object, kept across polls where the metadata
                          // sheet comes back broken (e.g. a formula error) so a temporary sheet
                          // outage doesn't wipe out already-known Hook Type/Actor/Writer/Editor data
let lastGoodLeadStats = {}; // adId -> { leads, qmva }, same staleness-guard as lastGoodAssets

function csvUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${DOC_ID}/export?format=csv&gid=${gid}`;
}

function fetchText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchText(res.headers.location, redirects - 1));
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
  });
}

// Minimal RFC4180-ish CSV parser (handles quoted fields with commas/newlines/escaped quotes).
function parseCSV(text) {
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
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => v && v.trim() !== ''))
    .map((r) => {
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = (r[idx] || '').trim(); });
      return obj;
    });
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function isDateLike(v) {
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s);
}

function num(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[$,%]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Google's Day column is ISO (YYYY-MM-DD); Meta/QMVA use M/D/YYYY. Normalize everything to
// ISO so the frontend's date-range math never has to guess a format.
function toISODate(v) {
  if (!v) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
  if (mdy) return `${mdy[3]}-${String(mdy[1]).padStart(2, '0')}-${String(mdy[2]).padStart(2, '0')}`;
  return '';
}

async function fetchSource(key) {
  const cfg = SOURCES[key];
  const text = await fetchText(csvUrl(cfg.gid));
  return parseCSV(text);
}

async function pollAll() {
  try {
    const [googleRaw, caRaw, nwRaw, metaCsv, trackerCsv] = await Promise.all([
      fetchSource('googleSpend'),
      fetchSource('caRevenue'),
      fetchSource('nwRevenue'),
      fetchText(csvUrl(CREATIVE_META_GID)),
      fetchText(csvUrl(CREATIVE_TRACKER_GID)),
    ]);
    const creativeMetaRaw = parseCSV(metaCsv);
    const creativeTrackerRaw = parseCSV(trackerCsv);

    const adMeta = {}; // adId -> { adName, campaignName, platform }
    const assets = {}; // adId -> { youtubeUrl, landingPageUrl, frameIoUrl, fileName, videoTitle }
    const daily = {}; // `${date}|${adId}` -> { date, adId, spend, revenue }

    const bump = (date, adId, field, amount) => {
      if (!date || !adId || !amount) return;
      const key = date + '|' + adId;
      if (!daily[key]) daily[key] = { date, adId, spend: 0, revenue: 0 };
      daily[key][field] += amount;
    };

    for (const r of googleRaw) {
      const cfg = SOURCES.googleSpend;
      const adId = (r[cfg.adIdField] || '').trim();
      const date = toISODate(r[cfg.dayField]);
      if (!adId || !date) continue;
      if (!adMeta[adId]) {
        adMeta[adId] = {
          adName: r[cfg.nameField] || adId,
          campaignName: r[cfg.campaignField] || '',
          platform: cfg.platform,
        };
      }
      bump(date, adId, 'spend', num(r[cfg.amountField]));
    }

    // Sheet10 has duplicate rows per Ad ID (one per campaign it ran under); many of those
    // duplicates are missing Hook Type/Actor/Writer/Editor. Merge field-by-field across all
    // rows for an Ad ID instead of taking just the first row, so a populated value from any
    // row wins rather than an early blank duplicate shadowing it.
    for (const r of creativeMetaRaw) {
      const adId = (r['adId'] || '').trim();
      if (!adId) continue;
      if (!assets[adId]) {
        assets[adId] = {
          youtubeUrl: '', landingPageUrl: '', frameIoUrl: '', fileName: '', videoTitle: '',
          hookType: '', actor: '', writer: '', editor: '', dateUploaded: '',
        };
      }
      const a = assets[adId];
      if (!a.youtubeUrl && r['youtubeUrl']) a.youtubeUrl = r['youtubeUrl'];
      if (!a.landingPageUrl && r['LandingpageUrl']) a.landingPageUrl = r['LandingpageUrl'];
      if (!a.frameIoUrl && r['frame.ioLink']) a.frameIoUrl = r['frame.ioLink'];
      if (!a.fileName && r['fileName']) a.fileName = r['fileName'];
      if (!a.videoTitle && r['videoTitle']) a.videoTitle = r['videoTitle'];
      // Some rows have a date typed into "Hook Type" by mistake (belongs in Date Uploaded) —
      // treat date-shaped values as blank so a stray date never shows as a hook type.
      if (!a.hookType && r['Hook Type'] && !isDateLike(r['Hook Type'])) a.hookType = r['Hook Type'];
      if (!a.actor && r['Actor']) a.actor = r['Actor'];
      if (!a.writer && r['Writer']) a.writer = r['Writer'];
      if (!a.editor && r['Editor']) a.editor = r['Editor'];
      if (!a.dateUploaded && r['Date Uploaded']) a.dateUploaded = r['Date Uploaded'];
    }

    // The metadata sheet occasionally comes back broken (e.g. a formula error like #VALUE!
    // collapses its whole CSV export to a single line) — a suspiciously low row count means
    // that happened, so fall back to the last known-good metadata instead of blanking
    // everyone's Hook Type/Actor/Writer/Editor/fileName out.
    let effectiveAssets = assets;
    if (creativeMetaRaw.length < 100) {
      console.warn(`[${new Date().toISOString()}] creative metadata sheet looks broken (${creativeMetaRaw.length} rows) — reusing last known-good metadata`);
      effectiveAssets = lastGoodAssets;
    } else {
      lastGoodAssets = assets;
    }

    // Revenue sheets: read ONLY Date, AD ID, Payout. Every other field on `r` (name, email,
    // phone, incident details, ...) is discarded here and never touched again.
    for (const raw of [caRaw, nwRaw]) {
      for (const r of raw) {
        const adId = (r['AD ID'] || '').trim();
        const date = toISODate(r['Date']);
        const payout = num(r['Payout']);
        if (!adId || !date || !payout) continue;
        bump(date, adId, 'revenue', payout);
      }
    }

    // Creative Tracker 1's own Leads/QMVA columns are genuinely accurate (unlike counting rows
    // in the raw CA/NW sheets, which only ever logs already-accepted leads). All-time totals
    // only — same broken-sheet fallback pattern as the metadata merge above.
    const leadStats = {}; // adId -> { leads, qmva }
    for (const r of creativeTrackerRaw) {
      const adId = (r['Ad ID'] || '').trim();
      if (!adId) continue;
      leadStats[adId] = { leads: num(r['Leads']), qmva: num(r['QMVA']) };
    }
    let effectiveLeadStats = leadStats;
    if (creativeTrackerRaw.length < 100) {
      console.warn(`[${new Date().toISOString()}] creative tracker sheet looks broken (${creativeTrackerRaw.length} rows) — reusing last known-good lead stats`);
      effectiveLeadStats = lastGoodLeadStats;
    } else {
      lastGoodLeadStats = leadStats;
    }

    const rows = Object.values(daily).map((d) => {
      const meta = adMeta[d.adId] || { adName: 'Ad ' + d.adId, campaignName: '', platform: 'UNKNOWN' };
      const asset = effectiveAssets[d.adId] || {};
      const lead = effectiveLeadStats[d.adId] || {};
      return {
        date: d.date,
        adId: d.adId,
        adName: meta.adName,
        campaignName: meta.campaignName,
        platform: meta.platform,
        spend: Math.round(d.spend * 100) / 100,
        revenue: Math.round(d.revenue * 100) / 100,
        leadsAllTime: lead.leads || 0,
        qmvaAllTime: lead.qmva || 0,
        youtubeUrl: asset.youtubeUrl || '',
        landingPageUrl: asset.landingPageUrl || '',
        frameIoUrl: asset.frameIoUrl || '',
        fileName: asset.fileName || '',
        hookType: asset.hookType || '',
        actor: asset.actor || '',
        writer: asset.writer || '',
        editor: asset.editor || '',
        dateUploaded: asset.dateUploaded || '',
      };
    });

    // Include a fingerprint of the metadata fields too — spend/revenue totals alone don't
    // change when someone only fills in Hook Type/Actor/Writer/Editor/Date Uploaded, so a
    // hash based on money alone would never notice a metadata-only edit and go stale forever.
    const metaFingerprint = fnv1a(rows.map((r) => r.fileName + '|' + r.hookType + '|' + r.actor + '|' + r.writer + '|' + r.editor + '|' + r.dateUploaded + '|' + r.leadsAllTime + '|' + r.qmvaAllTime).join('~'));
    const hash = rows.length + ':' + rows.reduce((a, r) => a + r.spend + r.revenue, 0).toFixed(2) + ':' + metaFingerprint;
    if (cache.rows.length > 20 && rows.length < cache.rows.length * 0.5) {
      console.warn(`[${new Date().toISOString()}] ignoring suspiciously short fetch (${rows.length} rows vs cached ${cache.rows.length})`);
      return;
    }
    if (cache.hash !== hash) {
      cache = { rows, hash, updatedAt: Date.now() };
      broadcast();
      console.log(`[${new Date().toISOString()}] updated: ${rows.length} day/ad rows`);
    }
  } catch (err) {
    console.error('poll error:', err.message);
  }
}

function broadcast() {
  const payload = `event: update\ndata: ${JSON.stringify({ updatedAt: cache.updatedAt })}\n\n`;
  clients.forEach((res) => res.write(payload));
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ rows: cache.rows, updatedAt: cache.updatedAt }));
    return;
  }

  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    pollAll().finally(() => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ rows: cache.rows, updatedAt: cache.updatedAt }));
    });
    return;
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('\n');
    clients.push(res);
    req.on('close', () => { clients = clients.filter((c) => c !== res); });
    return;
  }

  let filePath = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

pollAll();
setInterval(pollAll, POLL_MS);

server.listen(PORT, () => {
  console.log(`Creative Dashboard running at http://localhost:${PORT}`);
});

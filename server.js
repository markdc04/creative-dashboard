const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const { csvUrl: sharedCsvUrl, fetchText, parseCSV, num, toISODate } = require('./csv-utils');
const sasooness = require('./sasooness');

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

// A separate "Creative Credit Survey" spreadsheet (Nichole's crediting tool) — a second,
// independent source for Editor/Copy Writer/Actor/Hook Type, keyed by the creative's file name
// rather than Ad ID. Used only to fill in whatever the primary metadata sheet is still missing
// for a given fileName, never to overwrite a value the primary sheet already has.
const EXTRA_CREDITS_DOC_ID = '1m_2QOFms0_17c0KNNA_YTM0WtS9wFyy8bt4hNuhdBno';
const EXTRA_CREDITS_GID = '0';

const POLL_MS = 30000;
const PORT = process.env.PORT || 4174;

let cache = { rows: [], updatedAt: null, hash: null };

// Who's logged in and when — a simple visit log, persisted to a local JSON file so it survives
// a server restart (not a deploy, since the disk resets then, but good enough for "who's been
// on recently"), kept as real history rather than trimmed to a short recent window. Capped
// to the most recent 5000 entries just as a sanity ceiling.
const VISIT_LOG_PATH = path.join(__dirname, 'visit-log.json');
let visitLog = [];
try { visitLog = JSON.parse(fs.readFileSync(VISIT_LOG_PATH, 'utf8')); } catch (err) { visitLog = []; }
function recordVisit(name) {
  visitLog.push({ name, at: Date.now() });
  if (visitLog.length > 5000) visitLog = visitLog.slice(-5000);
  fs.writeFile(VISIT_LOG_PATH, JSON.stringify(visitLog), () => {});
}
let clients = []; // SSE response objects
let lastGoodAssets = {}; // adId -> asset/metadata object, kept across polls where the metadata
                          // sheet comes back broken (e.g. a formula error) so a temporary sheet
                          // outage doesn't wipe out already-known Hook Type/Actor/Writer/Editor data
let lastGoodLeadStats = {}; // adId -> { leads, qmva }, same staleness-guard as lastGoodAssets

function csvUrl(gid, docId = DOC_ID) {
  return sharedCsvUrl(gid, docId);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// The same person gets typed with inconsistent casing across rows/sheets ("zeke", "Zeke",
// "ZEKE" all show up) which otherwise splits them into separate Actor/Writer/Editor entries.
// Normalize to one canonical Title Case form so they always merge into a single person.
function normalizeName(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function isDateLike(v) {
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s);
}

async function fetchSource(key) {
  const cfg = SOURCES[key];
  const text = await fetchText(csvUrl(cfg.gid));
  return parseCSV(text);
}

async function pollAll() {
  try {
    const [googleRaw, caRaw, nwRaw, metaCsv, trackerCsv, extraCreditsCsv] = await Promise.all([
      fetchSource('googleSpend'),
      fetchSource('caRevenue'),
      fetchSource('nwRevenue'),
      fetchText(csvUrl(CREATIVE_META_GID)),
      fetchText(csvUrl(CREATIVE_TRACKER_GID)),
      fetchText(csvUrl(EXTRA_CREDITS_GID, EXTRA_CREDITS_DOC_ID)),
    ]);
    const creativeMetaRaw = parseCSV(metaCsv);
    const creativeTrackerRaw = parseCSV(trackerCsv);
    const extraCreditsRaw = parseCSV(extraCreditsCsv);

    // Merge the extra credit-survey rows by fileName ("Frame file name" there) — first
    // non-blank value per field wins across duplicate rows for the same file, same pattern as
    // the primary metadata merge below.
    const extraCreditsByFileName = {};
    for (const r of extraCreditsRaw) {
      const fileName = (r['Frame file name'] || '').trim();
      if (!fileName) continue;
      if (!extraCreditsByFileName[fileName]) {
        extraCreditsByFileName[fileName] = { actor: '', writer: '', editor: '', hookType: '', displayName: '' };
      }
      const c = extraCreditsByFileName[fileName];
      if (!c.actor && r['ACTOR']) c.actor = normalizeName(r['ACTOR']);
      if (!c.writer && r['COPY WRITERS']) c.writer = normalizeName(r['COPY WRITERS']);
      if (!c.editor && r['EDITOR']) c.editor = normalizeName(r['EDITOR']);
      if (!c.hookType && r['HOOK_TYPE'] && !isDateLike(r['HOOK_TYPE'])) c.hookType = r['HOOK_TYPE'];
      // "naming convention" holds the agreed full display name for this creative — use it
      // verbatim (whole string, all {...} segments) rather than just its first part.
      if (!c.displayName && r['naming convention'] && r['naming convention'].trim()) {
        c.displayName = r['naming convention'].trim();
      }
    }

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
          hookType: '', actor: '', writer: '', editor: '', dateUploaded: '', displayName: '',
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
      if (!a.actor && r['Actor']) a.actor = normalizeName(r['Actor']);
      if (!a.writer && r['Writer']) a.writer = normalizeName(r['Writer']);
      if (!a.editor && r['Editor']) a.editor = normalizeName(r['Editor']);
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

    // Fill in whatever the primary sheet is still missing (Actor/Writer/Editor/Hook Type) from
    // the extra credit-survey source, joined by fileName — never overwrites a value the
    // primary sheet already supplied.
    if (extraCreditsRaw.length) {
      for (const adId in effectiveAssets) {
        const a = effectiveAssets[adId];
        const extra = a.fileName && extraCreditsByFileName[a.fileName.trim()];
        if (!extra) continue;
        if (!a.actor && extra.actor) a.actor = extra.actor;
        if (!a.writer && extra.writer) a.writer = extra.writer;
        if (!a.editor && extra.editor) a.editor = extra.editor;
        if (!a.hookType && extra.hookType) a.hookType = extra.hookType;
        if (!a.displayName && extra.displayName) a.displayName = extra.displayName;
      }
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
        displayName: asset.displayName || '',
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
    const metaFingerprint = fnv1a(rows.map((r) => r.fileName + '|' + r.displayName + '|' + r.hookType + '|' + r.actor + '|' + r.writer + '|' + r.editor + '|' + r.dateUploaded + '|' + r.leadsAllTime + '|' + r.qmvaAllTime).join('~'));
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
    // Sasooness's Google spend is a filter over this same already-fetched sheet — no separate
    // request for it.
    sasooness.updateGoogleSpend(rows);
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

// YouTube's oEmbed endpoint doesn't include view count, and pulling it in requires either a
// paid Data API key or scraping the public watch page's embedded JSON — we do the latter here,
// with an in-memory cache (1 hour) since it's a network fetch per video, not something to redo
// on every panel open.
const viewCountCache = new Map(); // ytId -> { views, at }
const VIEW_CACHE_MS = 60 * 60 * 1000;

async function fetchViewCount(ytId) {
  const cached = viewCountCache.get(ytId);
  if (cached && Date.now() - cached.at < VIEW_CACHE_MS) return cached.views;
  // Datacenter IPs (like Render's) commonly get served an EU cookie-consent interstitial
  // instead of the real watch page, which has no videoDetails at all — the CONSENT cookie
  // bypasses that.
  const html = await fetchText(`https://www.youtube.com/watch?v=${ytId}`, 5, {
    'Cookie': 'CONSENT=YES+1',
    'Accept-Language': 'en-US,en;q=0.9',
  });
  // The page also embeds viewCount for unrelated sidebar/recommended videos, so scope the
  // search to the "videoDetails" block (unique, describes only the video being watched).
  const idx = html.indexOf('"videoDetails"');
  const m = idx === -1 ? null : /"viewCount":"(\d+)"/.exec(html.slice(idx, idx + 3000));
  const views = m ? Number(m[1]) : null;
  if (views == null) {
    console.warn(`[${new Date().toISOString()}] view count lookup failed for ${ytId} — page length ${html.length}, has videoDetails: ${idx !== -1}`);
  }
  viewCountCache.set(ytId, { views, at: Date.now() });
  return views;
}

// Only these dashboard files are readable without a login (the login page borrows its look from them).
const PUBLIC_ASSETS = new Set(['/dashboard/style.css', '/dashboard/logo-loudr.png', '/dashboard/favicon.svg']);
const LEADERBOARD_API = new Set(['/api/data', '/api/views', '/api/refresh', '/api/events']);
const LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');

function clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || ''; }
function esc(v) { return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeNext(n) { return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/dashboard/'; }
function sessionCookie(req, value, maxAgeSec) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}
function sendLogin(res, { username = '', next = '/dashboard/', error = '' } = {}) {
  const html = LOGIN_HTML.replace('__USERNAME__', esc(username)).replace('__NEXT__', esc(next))
    .replace('__ERRHIDDEN__', error ? '' : 'hidden').replace('__ERRMSG__', esc(error));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // The site opens on the no-financials leaderboard, which (with its data feed under /lb-api/)
  // stays open. The dashboard (/dashboard/) and the full data API (/api/) need a login.
  let publicZone = false;
  if (url.pathname.startsWith('/lb-api/')) {
    const apiPath = '/api/' + url.pathname.slice('/lb-api/'.length);
    if (!LEADERBOARD_API.has(apiPath)) { res.writeHead(404); res.end('Not found'); return; }
    url.pathname = apiPath;
    publicZone = true;
  }

  if (url.pathname === '/login' && req.method === 'GET') {
    sendLogin(res, { next: safeNext(url.searchParams.get('next')), username: url.searchParams.get('u') || '', error: url.searchParams.get('error') === '1' ? 'Incorrect username or password.' : url.searchParams.get('error') === 'locked' ? 'Too many attempts. Try again in 15 minutes.' : '' });
    return;
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const username = form.get('username') || '';
      const next = safeNext(form.get('next'));
      const ip = clientIp(req);
      if (auth.isLocked(ip)) { res.writeHead(302, { Location: '/login?error=locked' }); res.end(); return; }
      const name = auth.verifyLogin(username, form.get('password'));
      if (!name) {
        auth.noteFailure(ip);
        res.writeHead(302, { Location: '/login?error=1&u=' + encodeURIComponent(username.slice(0, 40)) + '&next=' + encodeURIComponent(next) });
        res.end();
        return;
      }
      auth.clearFailures(ip);
      recordVisit(name);
      res.writeHead(302, { 'Set-Cookie': sessionCookie(req, auth.makeSession(name), Math.floor(auth.SESSION_MS / 1000)), Location: next });
      res.end();
    });
    return;
  }

  if (url.pathname === '/logout') {
    res.writeHead(302, { 'Set-Cookie': sessionCookie(req, '', 0), Location: '/' });
    res.end();
    return;
  }

  const sessionName = auth.readSession(req.headers.cookie);
  const needsLogin = url.pathname.startsWith('/api/') || url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/') || url.pathname === '/sasooness-api/data' || url.pathname === '/sasooness' || url.pathname.startsWith('/sasooness/');
  if (!publicZone && !sessionName && needsLogin && !PUBLIC_ASSETS.has(url.pathname)) {
    if (url.pathname.startsWith('/api/') || url.pathname === '/sasooness-api/data') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'login required' }));
    } else {
      res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(url.pathname === '/dashboard' ? '/dashboard/' : url.pathname) });
      res.end();
    }
    return;
  }

  if (url.pathname === '/api/me') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ name: sessionName }));
    return;
  }

  if (url.pathname === '/api/visits') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ visits: [...visitLog].reverse() }));
    return;
  }

  if (url.pathname === '/api/views') {
    const ytId = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{6,}$/.test(ytId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid id' }));
      return;
    }
    fetchViewCount(ytId)
      .then((views) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ views }));
      })
      .catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ views: null }));
      });
    return;
  }

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

  if (url.pathname === '/sasooness-api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sasooness.getData()));
    return;
  }

  // One process serves everything: the leaderboard at the site root, the dashboard under
  // /dashboard/ (login enforced above), and the shared side-panel files under /shared/.
  let root = 'leaderboard-public';
  let rel = url.pathname;
  if (rel === '/leaderboard' || rel === '/leaderboard/') { res.writeHead(301, { Location: '/' }); res.end(); return; }
  if (rel === '/dashboard') { res.writeHead(301, { Location: '/dashboard/' }); res.end(); return; }
  if (rel === '/sasooness') { res.writeHead(301, { Location: '/sasooness/' }); res.end(); return; }
  if (rel.startsWith('/dashboard/')) { root = 'public'; rel = rel.slice('/dashboard'.length); }
  else if (rel.startsWith('/sasooness/')) { root = 'sasooness-public'; rel = rel.slice('/sasooness'.length); }
  else if (rel.startsWith('/shared/')) { root = 'shared'; rel = rel.slice('/shared'.length); }
  const rootDir = path.join(__dirname, root);
  let filePath = path.join(rootDir, rel === '/' ? 'index.html' : rel);
  if (!filePath.startsWith(rootDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

pollAll();
setInterval(pollAll, POLL_MS);
sasooness.pollAll();
setInterval(sasooness.pollAll, POLL_MS);

server.listen(PORT, () => {
  console.log(`Creative Dashboard running at http://localhost:${PORT}`);
});

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// "Ad_Creative_Tracker" workbook — "Creative Tracker 1" tab holds the live, formula-computed
// Ad ID / Ad Name / Campaign / Platform / Spend / Revenue / Profit table.
const DOC_ID = '1YkpQh4hR96iMtvd_bvtrT0fN0zCaLQNKl3pa6Tix8BA';
const GID = '623888576';

const POLL_MS = 15000;
const PORT = process.env.PORT || 4174;

let cache = { rows: [], updatedAt: null, hash: null };
let clients = []; // SSE response objects

// Direct CSV export works for any sheet shared "Anyone with the link can view" — no auth needed.
function csvUrl(docId, gid) {
  return `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${gid}`;
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
    // Google's export CDN occasionally hangs indefinitely on a large/redirected request — without
    // this, a stuck request never resolves or rejects, so the poll loop silently stops.
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
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

function num(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[$,%]/g, ''));
  return isNaN(n) ? 0 : n;
}

function normalizeRows(raw) {
  return raw
    .map((r) => ({
      adId: r['Ad ID'] || '',
      adName: r['Ad Name'] || '',
      campaignId: r['Campaign ID'] || '',
      campaignName: r['Campaign Name'] || '',
      platform: (r['Platform'] || '').toUpperCase(),
      spend: num(r['Spend ($)']),
      revenue: num(r['Revenue ($)']),
      qmva: num(r['QMVA']),
      leads: num(r['Leads']),
      acceptedLeads: num(r['Accepted Leads']),
      costPerLead: num(r['Cost Per Lead']),
      costPerAccept: num(r['Cost Per Accept']),
      ctr: num(r['CTR %']),
      cpqmva: num(r['CPQMVA']),
      profit: num(r['Profit']),
    }))
    .filter((r) => r.adId);
}

async function poll() {
  try {
    const text = await fetchText(csvUrl(DOC_ID, GID));
    const raw = parseCSV(text);
    const rows = normalizeRows(raw);
    const hash = rows.length + ':' + text.length;
    // Guard against a transient truncated/interstitial response from Google's export CDN
    // flashing wrong (near-empty) numbers to the frontend over a good cached copy.
    if (cache.rows.length > 5 && rows.length < cache.rows.length * 0.5) {
      console.warn(`[${new Date().toISOString()}] ignoring suspiciously short fetch (${rows.length} rows vs cached ${cache.rows.length})`);
      return;
    }
    if (cache.hash !== hash) {
      cache = { rows, hash, updatedAt: Date.now() };
      broadcast();
      console.log(`[${new Date().toISOString()}] updated: ${rows.length} rows`);
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

poll();
setInterval(poll, POLL_MS);

server.listen(PORT, () => {
  console.log(`Creative Dashboard running at http://localhost:${PORT}`);
});

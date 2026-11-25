// All Clients Overview — reads ONLY the Loudr Media "Client Profitability" Google Sheet and turns
// it into one cross-client view: profit tiles (yesterday / week to date / month to date), MTD
// margin, status counts, data freshness, the Walker Agency media balance, and a client table
// grouped by state.
//
// Rules (from the page spec, claude-prompt-all-clients-overview.md):
// - Colours are never recomputed here: per-metric colours are the Summary cells' own background
//   colours, the overall status is Summary's "STATUS (worst metric)" column, and cutoffs come from
//   the Settings tab. Missing data/targets are grey, never 0 or green.
// - No bank cash, AR, or account numbers: Summary's cash/days-to-pay columns and its header notes
//   (which name bank feeds) are never read into the payload.
// - Headers are read by name; the few the sheet leaves blank fall back to a fixed column and are
//   reported in `warnings` so the sheet owner can label them.
// - Dates in raw_current are Pacific.
//
// Reads use the dashboard's read-only Sheets credential (OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN).
const https = require('https');

const SHEET_ID = '1FHWXf3ki-Lkl3RV8zZTm-vpQ6swh2i5qrqRIbX506PM';
const POLL_MS = 5 * 60 * 1000;
// Walker Agency media balance comes from an agency tracker that doesn't exist yet. Set both to
// connect it, e.g. OVERVIEW_AGENCY_TRACKER_ID=<sheet id>, OVERVIEW_AGENCY_TRACKER_RANGE='Tracker'!B2
// (the range's first cell must hold the balance left before the next Walker invoice).
const AGENCY_TRACKER_ID = process.env.OVERVIEW_AGENCY_TRACKER_ID || '';
const AGENCY_TRACKER_RANGE = process.env.OVERVIEW_AGENCY_TRACKER_RANGE || '';

// State codes in Summary column "State" -> group label. Blank = inactive/unmapped (hidden).
const STATE_LABELS = {
  CA: 'California', NW: 'Nationwide', Multi: 'Multi-state (AZ, GA, NV, SC, UT, WA)', AZ: 'Arizona',
  WA: 'Washington', PA: 'Pennsylvania', TX: 'Texas', National: 'National',
};
const STATE_ORDER = ['CA', 'NW', 'Multi', 'AZ', 'WA', 'PA', 'TX', 'National'];

// Each client's existing dashboard page.
function clientHref(name) {
  if (/^walker/i.test(name)) return '/walker/';
  if (/sasooness/i.test(name)) return '/sasooness/';
  if (/^km/i.test(name)) return '/km/';
  if (/bryan/i.test(name)) return '/bryan/';
  if (/ruy/i.test(name)) return '/ruy/';
  if (/^b2b/i.test(name)) return '/b2b/';
  return null;
}

// --- Google auth + reads ---------------------------------------------------------------------
let token = null, tokenExpiry = 0;
function getAccessToken() {
  if (token && Date.now() < tokenExpiry - 60000) return Promise.resolve(token);
  const body = new URLSearchParams({
    client_id: process.env.OAUTH_CLIENT_ID, client_secret: process.env.OAUTH_CLIENT_SECRET,
    refresh_token: process.env.OAUTH_REFRESH_TOKEN, grant_type: 'refresh_token',
  }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!json.access_token) return reject(new Error('token refresh failed'));
          token = json.access_token; tokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
          resolve(token);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('token request timed out')));
    req.end(body);
  });
}

function getJson(url) {
  return getAccessToken().then((t) => new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Authorization: 'Bearer ' + t } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode >= 400) return reject(new Error('sheets ' + res.statusCode + ': ' + ((json.error && json.error.message) || '')));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('sheets request timed out')));
  }));
}

function batchValues(id, ranges) {
  const q = ranges.map((r) => 'ranges=' + encodeURIComponent(r)).join('&');
  return getJson(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${q}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`)
    .then((j) => (j.valueRanges || []).map((v) => v.values || []));
}

// Summary cells with their displayed text and background colour, for the per-metric colours.
function summaryGrid() {
  const fields = 'sheets.data.startRow,sheets.data.rowData.values.formattedValue,sheets.data.rowData.values.effectiveFormat.backgroundColor';
  return getJson(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?ranges=${encodeURIComponent("'Summary'!A1:Z60")}&fields=${encodeURIComponent(fields)}`)
    .then((j) => {
      const data = (((j.sheets || [])[0] || {}).data || [])[0] || {};
      return (data.rowData || []).map((r) => (r.values || []).map((c) => ({ text: c.formattedValue || '', bg: (c.effectiveFormat || {}).backgroundColor || null })));
    });
}

// --- helpers ---------------------------------------------------------------------------------
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim();
  if (/missing|n\/a|^see /i.test(s)) return null;
  const m = s.replace(/[$,\s]/g, '').match(/^\(?(-?\d+(?:\.\d+)?)\)?(%)?$/);
  if (!m) return null;
  let n = Number(m[1]);
  if (/^\(.*\)$/.test(s.replace(/[$,\s]/g, ''))) n = -n;
  return m[2] ? n / 100 : n;
}
function isoDate(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  return '';
}
// Background colour -> red/orange/green/grey. Reads the colour the sheet already painted; it
// doesn't decide anything about the metric itself. White/no fill = no colour (null).
function colourName(bg) {
  if (!bg) return null;
  const r = bg.red || 0, g = bg.green || 0, b = bg.blue || 0;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max > 0.97 && min > 0.97) return null; // white / unfilled
  if (max - min < 0.08) return 'grey';
  let h;
  const d = max - min;
  if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  if (h < 20 || h >= 330) return 'red';
  if (h < 55) return 'orange';
  if (h < 170) return 'green';
  return null; // blue/purple fills are headers, not statuses
}
function statusWord(s) {
  const t = norm(s);
  if (t === 'red') return 'red';
  if (t === 'orange') return 'orange';
  if (t === 'green') return 'green';
  return 'grey';
}
// Finds a column by header text: exact match first, then a regex.
function findCol(headers, ...tests) {
  const h = headers.map(norm);
  for (const t of tests) {
    const i = typeof t === 'string' ? h.indexOf(norm(t)) : h.findIndex((x) => t.test(x));
    if (i >= 0) return i;
  }
  return -1;
}

// Pacific "today" and friends, as YYYY-MM-DD.
function pacificParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return { date: g('year') + '-' + g('month') + '-' + g('day'), hour: Number(g('hour')) % 24, minute: Number(g('minute')) };
}
function addDaysIso(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(iso) {
  const dow = new Date(iso + 'T12:00:00Z').getUTCDay();
  return addDaysIso(iso, dow === 0 ? -6 : 1 - dow);
}
// Pacific wall-clock time -> epoch ms (handles PST/PDT by probing the offset that day).
function pacificToEpoch(iso, hh, mm) {
  const guess = Date.parse(iso + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00Z');
  const p = pacificParts(new Date(guess));
  const shown = Date.parse(p.date + 'T' + String(p.hour).padStart(2, '0') + ':' + String(p.minute).padStart(2, '0') + ':00Z');
  return guess + (guess - shown);
}

// --- parsing ---------------------------------------------------------------------------------
function parseSettings(rows, warnings) {
  const val = (re) => {
    const r = rows.find((x) => re.test(norm(x[0])));
    return r ? num(r[1]) : null;
  };
  const settings = {
    orangeBand: val(/^orange band/),
    maxReplacement: val(/^max replacement/),
    orangeReplacement: val(/^orange replacement/),
    targets: [],
  };
  if (settings.orangeBand == null) warnings.push('Settings: "Orange band" value not found (B2).');
  if (settings.maxReplacement == null) warnings.push('Settings: "Max replacement rate" value not found (B3).');
  if (settings.orangeReplacement == null) warnings.push('Settings: "Orange replacement threshold" value not found (B4).');
  const hi = rows.findIndex((r) => norm(r[0]) === 'client' && norm(r[1]) === 'state' && r.some((c) => norm(c) === 'target_cost_per_case'));
  if (hi < 0) { warnings.push('Settings: client targets table (client | state | target_cost_per_case …) not found.'); return settings; }
  const h = rows[hi];
  const c = { client: 0, state: findCol(h, 'state'), target: findCol(h, 'target_cost_per_case'), ppl: findCol(h, 'price_per_lead'), ppc: findCol(h, 'price_per_case'), notes: findCol(h, 'notes') };
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !String(r[0] || '').trim()) break;
    settings.targets.push({
      client: String(r[0]).trim(), state: String(r[c.state] || '').trim(),
      targetCostPerCase: num(r[c.target]), pricePerLead: num(r[c.ppl]), pricePerCase: num(r[c.ppc]),
      notes: c.notes >= 0 ? String(r[c.notes] || '') : '',
    });
  }
  return settings;
}

// Summary: header row is the one whose first cell is "Client". Columns J/K/L (MTD revenue, cost,
// profit) have no header text in the sheet, so they're taken by position and flagged.
function parseSummary(grid, warnings) {
  const hi = grid.findIndex((r) => norm((r[0] || {}).text) === 'client');
  if (hi < 0) { warnings.push('Summary: header row ("Client" in column A) not found.'); return { rows: [], dataThrough: '', periodStart: '' }; }
  const headers = grid[hi].map((c) => c.text);
  const col = {
    client: 0,
    dealType: findCol(headers, 'deal type'),
    leadsSent: findCol(headers, /^leads sent/),
    pricePerLead: findCol(headers, 'price per lead'),
    costPerLead: findCol(headers, 'cost per lead'),
    costPerCase: findCol(headers, /^cost per case/),
    profitPerLead: findCol(headers, 'profit per lead mtd'),
    target: findCol(headers, /^kpi: target cost per case/),
    replacement: findCol(headers, /^replacement rate/),
    status: findCol(headers, /^status/),
    statusNote: findCol(headers, 'status note'),
    key: findCol(headers, 'raw_daily client key'),
    state: findCol(headers, 'state'),
    revenue: findCol(headers, /^revenue mtd$/, /^revenue$/),
    cost: findCol(headers, /^cost mtd$/, /^cost$/),
    profit: findCol(headers, /^profit mtd$/, /^profit$/),
  };
  // Fallbacks for the unlabelled money columns (J, K, L).
  if (col.revenue < 0) { col.revenue = 9; warnings.push('Summary: column J has no header — read as Revenue MTD. Please label it "Revenue MTD".'); }
  if (col.cost < 0) { col.cost = 10; warnings.push('Summary: column K has no header — read as Cost MTD. Please label it "Cost MTD".'); }
  if (col.profit < 0) { col.profit = 11; warnings.push('Summary: column L has no header — read as Profit MTD. Please label it "Profit MTD".'); }
  for (const [k, v] of Object.entries(col)) if (v < 0) warnings.push('Summary: column "' + k + '" not found by header.');
  const cell = (r, i) => (i >= 0 && r[i]) || { text: '', bg: null };
  const label = (r) => String(cell(r, 0).text || '');
  const findLabel = (re) => { const r = grid.find((x) => re.test(norm((x[0] || {}).text))); return r ? (r[1] || {}).text || '' : ''; };
  const rows = [];
  for (let i = hi + 1; i < grid.length; i++) {
    const r = grid[i];
    const name = label(r).trim();
    if (!name) continue;
    if (/^total/i.test(name)) break;
    const metric = (k) => {
      const c = cell(r, col[k]);
      const missing = !String(c.text).trim() || /missing|n\/a/i.test(c.text);
      // Grey whenever the value is missing, whatever the fill says — never 0 or green.
      return { text: c.text, value: num(c.text), colour: missing ? 'grey' : colourName(c.bg) };
    };
    rows.push({
      sheetRow: i + 1, client: name, dealType: cell(r, col.dealType).text,
      key: cell(r, col.key).text || name, state: String(cell(r, col.state).text || '').trim(),
      status: statusWord(cell(r, col.status).text), statusText: cell(r, col.status).text, statusNote: cell(r, col.statusNote).text,
      revenue: metric('revenue'), cost: metric('cost'), profit: metric('profit'),
      leadsSent: metric('leadsSent'), pricePerLead: metric('pricePerLead'), costPerLead: metric('costPerLead'),
      costPerCase: metric('costPerCase'), profitPerLead: metric('profitPerLead'), target: metric('target'),
      replacement: metric('replacement'),
    });
  }
  return { rows, dataThrough: isoDate(findLabel(/^data through/)), periodStart: isoDate(findLabel(/^period start/)) };
}

// raw_current: one row per date + client + source + platform. Column A (date) and column I
// (spend) have no header text, so they fall back to position and are flagged.
function parseRaw(rows, warnings) {
  if (!rows.length) { warnings.push('raw_current: tab is empty.'); return []; }
  const h = rows[0].map((x) => String(x == null ? '' : x));
  const c = {
    date: findCol(h, 'date'), client: findCol(h, 'client'), dealType: findCol(h, 'deal_type'), source: findCol(h, 'source'),
    sent: findCol(h, 'leads_sent'), accepted: findCol(h, 'leads_accepted'), returned: findCol(h, 'leads_returned'),
    price: findCol(h, 'price_per_lead'), spend: findCol(h, 'spend', 'ad_spend'), platform: findCol(h, 'ad_platform'),
    signed: findCol(h, 'signed_cases'), revenue: findCol(h, 'revenue_reported'), notes: findCol(h, 'notes'), loadedAt: findCol(h, 'loaded_at'),
  };
  if (c.date < 0) { c.date = 0; warnings.push('raw_current: column A has no header — read as the date. Please label it "date".'); }
  if (c.spend < 0) { c.spend = c.platform > 0 ? c.platform - 1 : 8; warnings.push('raw_current: the spend column (I) has no header — read by position. Please label it "spend".'); }
  for (const [k, v] of Object.entries(c)) if (v < 0) warnings.push('raw_current: column "' + k + '" not found by header.');
  const out = [];
  for (const r of rows.slice(1)) {
    const date = isoDate(r[c.date]);
    const client = String(r[c.client] || '').trim();
    if (!date || !client) continue;
    out.push({
      date, client, dealType: String(r[c.dealType] || ''), source: String(r[c.source] || ''), platform: String(r[c.platform] || ''),
      sent: num(r[c.sent]) || 0, accepted: num(r[c.accepted]) || 0, returned: num(r[c.returned]) || 0,
      price: num(r[c.price]), spend: num(r[c.spend]) || 0, revenue: num(r[c.revenue]), signed: num(r[c.signed]) || 0,
      loadedAt: String(r[c.loadedAt] || ''),
    });
  }
  return out;
}

function parsePacks(rows, warnings) {
  const hi = rows.findIndex((r) => r.some((x) => norm(x) === 'pack size'));
  if (hi < 0) { warnings.push('from_mark_ppl: header row (with "Pack size") not found.'); return []; }
  const h = rows[hi].map((x) => String(x || ''));
  const c = {
    client: findCol(h, 'client'), state: findCol(h, 'state'), packSize: findCol(h, 'pack size'), delivered: findCol(h, 'leads delivered'),
    remaining: findCol(h, 'leads remaining'), pctDelivered: findCol(h, '% delivered'), pace: findCol(h, 'pace'),
    flag: findCol(h, /flag/),
  };
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const client = String(r[c.client] || '').trim();
    if (!client || /^no real client rows/i.test(client)) continue;
    out.push({
      client, state: String(r[c.state] || '').trim(), packSize: num(r[c.packSize]), delivered: num(r[c.delivered]),
      remaining: num(r[c.remaining]), pctDelivered: num(r[c.pctDelivered]), pace: c.pace >= 0 ? String(r[c.pace] || '') : '',
      flag: c.flag >= 0 ? String(r[c.flag] || '') : '',
    });
  }
  return out;
}

// --- daily profit from raw_current -----------------------------------------------------------
// Revenue per day comes from raw_current itself where it's reported (Walker portal rows); for
// the other deal types it follows each deal's written terms, the same terms the sheet's Summary
// uses (listed in its notes / the Settings targets notes):
//   agency  (Walker Agency): revenue = WAGENCY spend x 1.35   -> profit = 35% fee
//   hybrid  (Sasooness AZ):  revenue = media / 0.65           ($75,000 round covers $48,750 media)
//   retainer (KM Law):       revenue = media x 1.35           ($20,000 media + $7,000 fee)
//   pay-per-lead:            revenue = leads sent x price per lead (raw row, else Settings, else Summary)
// Clients with no revenue terms (B2B) are cost only.
function revenueRule(client, dealType) {
  const t = norm(dealType), c = norm(client);
  if (/walker (ca|nw)/.test(c) || t === 'performance') return 'reported';
  if (t === 'agency' || /walker agency/.test(c)) return 'agency';
  if (t === 'hybrid') return 'hybrid';
  if (/^km/.test(c)) return 'retainer';
  if (/pay-per-lead|ppl/.test(t)) return 'ppl';
  return 'none';
}
const RULE_TEXT = {
  reported: 'Revenue = Walker portal (revenue_reported)', agency: 'Revenue = WAGENCY spend × 1.35 (35% fee)',
  hybrid: 'Revenue = media ÷ 0.65 ($75K round = $48,750 media)', retainer: 'Revenue = media × 1.35 ($20K media + $7K fee)',
  ppl: 'Revenue = leads sent × (Summary Revenue MTD ÷ leads sent MTD)', none: 'No client revenue (cost only)',
};
function groupOf(client) {
  const c = norm(client);
  if (c === 'walker ca' || c === 'walker nw') return 'walkerPpl';
  if (c === 'walker agency') return 'walkerAgency';
  return 'other';
}

function buildDaily(raw, summaryRows, settings, window) {
  // Pay-per-lead price: the sheet prices these on its Revenue & Payments tab (batch prices in
  // date order, own-campaign leads, etc.), so rather than re-deriving that, each lead is valued at
  // Summary's Revenue MTD ÷ raw_current leads sent over Summary's own MTD window. MTD then matches
  // Summary exactly, and days/weeks split it by leads. Settings price_per_lead is the fallback.
  const summaryFor = (client) => summaryRows.find((x) => norm(x.key) === norm(client) || norm(x.client) === norm(client));
  const impliedPrice = new Map();
  for (const s of summaryRows) {
    if (s.revenue.value == null) continue;
    const sent = raw.filter((r) => norm(r.client) === norm(s.key) && r.date >= window.start && r.date <= window.end).reduce((a, r) => a + r.sent, 0);
    if (sent > 0) impliedPrice.set(norm(s.key), s.revenue.value / sent);
  }
  const priceFor = (client) => {
    if (impliedPrice.has(norm(client))) return impliedPrice.get(norm(client));
    const t = settings.targets.find((x) => norm(x.client) === norm(client));
    return t && t.pricePerLead != null ? t.pricePerLead : null;
  };
  const stateFor = (client) => { const s = summaryFor(client); return s ? s.state : ''; };
  return raw.map((r) => {
    const rule = revenueRule(r.client, r.dealType);
    let revenue = 0, revenueMissing = false;
    if (rule === 'reported') revenue = r.revenue || 0;
    else if (rule === 'agency') revenue = r.spend * 1.35;
    else if (rule === 'hybrid') revenue = r.spend / 0.65;
    else if (rule === 'retainer') revenue = r.spend * 1.35;
    else if (rule === 'ppl') {
      const price = priceFor(r.client);
      if (r.sent && price == null) revenueMissing = true;
      revenue = r.sent * (price || 0);
    }
    return { ...r, rule, ruleText: RULE_TEXT[rule], revenue, cost: r.spend, profit: revenue - r.spend, revenueMissing, group: groupOf(r.client), state: stateFor(r.client) };
  });
}

function sumRows(rows) {
  const t = { revenue: 0, cost: 0, profit: 0, sent: 0, accepted: 0, revenueMissing: false };
  for (const r of rows) { t.revenue += r.revenue; t.cost += r.cost; t.profit += r.profit; t.sent += r.sent; t.accepted += r.accepted; if (r.revenueMissing) t.revenueMissing = true; }
  t.margin = t.revenue > 0 ? t.profit / t.revenue : null;
  return t;
}

// --- freshness -------------------------------------------------------------------------------
// Red: any source's latest load is more than 24h old. Orange: the most recent 10:15 AM PT run
// hasn't restated yesterday (no raw_current loaded_at after it). Otherwise green.
function freshness(raw, now = Date.now()) {
  const bySource = new Map();
  for (const r of raw) {
    const t = Date.parse(r.loadedAt);
    if (!isFinite(t)) continue;
    const k = r.source || '(none)';
    if (!bySource.has(k) || t > bySource.get(k)) bySource.set(k, t);
  }
  const sources = [...bySource.entries()].map(([source, t]) => ({ source, loadedAt: new Date(t).toISOString(), ageHours: (now - t) / 3600000 }))
    .sort((a, b) => b.ageHours - a.ageHours);
  const latest = sources.length ? Math.max(...sources.map((s) => Date.parse(s.loadedAt))) : null;
  const p = pacificParts(new Date(now));
  const todayRun = pacificToEpoch(p.date, 10, 15);
  const lastRun = now >= todayRun ? todayRun : pacificToEpoch(addDaysIso(p.date, -1), 10, 15);
  let colour = 'green', reason = '';
  const stale = sources.filter((s) => s.ageHours > 24);
  if (!sources.length) { colour = 'red'; reason = 'No loaded_at timestamps in raw_current.'; }
  else if (stale.length) { colour = 'red'; reason = stale.map((s) => s.source).join(', ') + ' more than 24h old'; }
  else if (latest < lastRun) { colour = 'orange'; reason = 'Yesterday not restated since the ' + new Date(lastRun).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT run'; }
  return { colour, reason, latest: latest ? new Date(latest).toISOString() : null, lastRun: new Date(lastRun).toISOString(), sources };
}

// --- agency tracker --------------------------------------------------------------------------
async function agencyBalance() {
  if (!AGENCY_TRACKER_ID || !AGENCY_TRACKER_RANGE) return { connected: false };
  try {
    const [vals] = await (async () => {
      const id = AGENCY_TRACKER_ID;
      return batchValues(id, [AGENCY_TRACKER_RANGE]);
    })();
    const v = num(((vals || [])[0] || [])[0]);
    return v == null ? { connected: true, value: null, error: 'Range is empty or not a number' } : { connected: true, value: v };
  } catch (err) {
    return { connected: true, value: null, error: err.message };
  }
}

// --- build -----------------------------------------------------------------------------------
function build({ grid, settingsRows, rawRows, packRows }, nowMs = Date.now()) {
  const warnings = [];
  const settings = parseSettings(settingsRows, warnings);
  const summary = parseSummary(grid, warnings);
  const raw = parseRaw(rawRows, warnings);
  const packs = parsePacks(packRows, warnings);
  const today = pacificParts(new Date(nowMs)).date;
  const yesterday = addDaysIso(today, -1);
  const mtdStart = summary.periodStart || yesterday.slice(0, 8) + '01';
  const mtdEnd = summary.dataThrough || yesterday;
  const daily = buildDaily(raw, summary.rows, settings, { start: mtdStart, end: mtdEnd });
  const periods = {
    yesterday: { label: 'Yesterday', start: yesterday, end: yesterday },
    wtd: { label: 'Week to date', start: mondayOf(yesterday), end: yesterday },
    mtd: { label: 'Month to date', start: yesterday.slice(0, 8) + '01', end: yesterday },
  };
  const profit = {};
  for (const [k, p] of Object.entries(periods)) {
    const rows = daily.filter((r) => r.date >= p.start && r.date <= p.end);
    const g = (name) => sumRows(rows.filter((r) => r.group === name));
    const byState = {};
    for (const r of rows) (byState[r.state || '—'] = byState[r.state || '—'] || []).push(r);
    profit[k] = {
      ...p, walkerPpl: g('walkerPpl'), walkerAgency: g('walkerAgency'), other: g('other'), total: sumRows(rows),
      byState: Object.entries(byState).map(([state, rs]) => ({ state, label: STATE_LABELS[state] || state, ...sumRows(rs) }))
        .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)),
      lastDataDate: rows.reduce((m, r) => (r.date > m ? r.date : m), ''),
    };
  }

  // Client table: Summary rows with a state (blank = inactive/unmapped, hidden).
  const statusCounts = { red: 0, orange: 0, green: 0, grey: 0 };
  const clients = summary.rows.filter((r) => r.state && !/^unmapped/i.test(r.client)).map((r) => {
    statusCounts[r.status]++;
    const t = settings.targets.find((x) => norm(x.client) === norm(r.key) && norm(x.state) === norm(r.state))
      || settings.targets.find((x) => norm(x.client) === norm(r.key));
    const rawMtd = daily.filter((d) => norm(d.client) === norm(r.key) && d.date >= mtdStart && d.date <= mtdEnd);
    const isWalker = /walker/i.test(r.dealType) || /^walker/i.test(r.client);
    const pack = packs.find((p) => norm(p.client) === norm(r.key) && (!p.state || norm(p.state) === norm(r.state)))
      || packs.find((p) => norm(r.client).startsWith(norm(p.client)));
    const isPack = /ppl|pack|pay-per-lead/i.test(r.dealType) && !isWalker;
    const revenue = r.revenue.value, profitV = r.profit.value;
    return {
      ...r, targetCell: r.target, href: clientHref(r.client), isWalker, isPack,
      caseLabel: isWalker ? 'Cost per QMVA' : isPack ? 'Cost per signed case' : 'Cost per case',
      margin: revenue && profitV != null ? profitV / revenue : null,
      target: { costPerCase: t ? t.targetCostPerCase : null, pricePerLead: t ? t.pricePerLead : null, pricePerCase: t ? t.pricePerCase : null, notes: t ? t.notes : '' },
      leads: { sent: rawMtd.reduce((a, d) => a + d.sent, 0), accepted: rawMtd.reduce((a, d) => a + d.accepted, 0), hasRaw: rawMtd.length > 0 },
      pack: isPack ? (pack || null) : undefined,
    };
  });
  const groups = STATE_ORDER.concat([...new Set(clients.map((c) => c.state))].filter((s) => !STATE_ORDER.includes(s)))
    .map((state) => {
      const rows = clients.filter((c) => c.state === state);
      if (!rows.length) return null;
      const s = (k) => rows.reduce((a, c) => a + (c[k].value || 0), 0);
      const revenue = s('revenue'), cost = s('cost'), profitV = s('profit');
      return {
        state, label: STATE_LABELS[state] || state, clients: rows,
        subtotal: { incomplete: rows.some((c) => c.profit.value == null || c.revenue.value == null), revenue, cost, profit: profitV, margin: revenue ? profitV / revenue : null, sent: rows.reduce((a, c) => a + c.leads.sent, 0), accepted: rows.reduce((a, c) => a + c.leads.accepted, 0) },
      };
    }).filter(Boolean);

  // Checks: each client row vs raw_current over Summary's own MTD window, and the MTD tile vs
  // Summary's total over the same window.
  const checks = [];
  const tol = (a, b) => Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.005);
  for (const c of clients) {
    const rows = daily.filter((d) => norm(d.client) === norm(c.key) && d.date >= mtdStart && d.date <= mtdEnd);
    const t = sumRows(rows);
    for (const [k, label] of [['revenue', 'Revenue MTD'], ['cost', 'Cost MTD'], ['profit', 'Profit MTD']]) {
      const sheet = c[k].value;
      if (sheet == null) continue;
      if (!tol(t[k], sheet)) checks.push({ client: c.client, state: c.state, metric: label, summary: sheet, raw: Math.round(t[k] * 100) / 100, diff: Math.round((t[k] - sheet) * 100) / 100 });
    }
  }
  const summaryTotal = summary.rows.filter((r) => r.state).reduce((a, r) => a + (r.profit.value || 0), 0);
  const rawTotal = sumRows(daily.filter((d) => d.date >= mtdStart && d.date <= mtdEnd && summary.rows.some((s) => s.state && norm(s.key) === norm(d.client)))).profit;
  if (!tol(rawTotal, summaryTotal)) checks.push({ client: 'All active clients', state: '', metric: 'Profit MTD', summary: summaryTotal, raw: Math.round(rawTotal * 100) / 100, diff: Math.round((rawTotal - summaryTotal) * 100) / 100 });

  // Click-through rows: client → day → source, Pacific dates. Only what the page needs.
  const detail = daily.filter((d) => d.date >= addDaysIso(today, -62)).map((d) => ({
    date: d.date, client: d.client, state: d.state, group: d.group, source: d.source, platform: d.platform,
    sent: d.sent, accepted: d.accepted, returned: d.returned, cost: round2(d.cost), revenue: round2(d.revenue), profit: round2(d.profit),
    rule: d.ruleText, revenueMissing: d.revenueMissing, loadedAt: d.loadedAt,
  }));

  const mtd = profit.mtd;
  return {
    generatedAt: new Date(nowMs).toISOString(), today, yesterday,
    summaryWindow: { start: mtdStart, end: mtdEnd },
    settings: { orangeBand: settings.orangeBand, maxReplacement: settings.maxReplacement, orangeReplacement: settings.orangeReplacement },
    profit, margin: { ...mtd.total, start: mtd.start, end: mtd.end },
    statusCounts, freshness: freshness(raw, nowMs), groups, checks, warnings, detail,
  };
}
const round2 = (n) => Math.round(n * 100) / 100;

// --- polling ---------------------------------------------------------------------------------
let cache = null, lastError = null, polling = false, rawForFreshness = [];
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const [grid, values, agency] = await Promise.all([
      summaryGrid(),
      batchValues(SHEET_ID, ["'Settings'!A1:H80", "'raw_current'!A1:N6000", "'from_mark_ppl'!A1:Z300"]),
      agencyBalance(),
    ]);
    const [settingsRows, rawRows, packRows] = values;
    cache = { ...build({ grid, settingsRows, rawRows, packRows }), agency };
    rawForFreshness = parseRaw(rawRows, []);
    lastError = null;
  } catch (err) {
    lastError = err.message;
    console.error('overview poll error:', err.message);
  } finally {
    polling = false;
  }
}
function start() { poll(); setInterval(poll, POLL_MS); }
function getData() {
  if (!cache) return { loading: !lastError, error: lastError };
  // Freshness depends on the clock, so it's re-evaluated per request rather than per poll.
  return { ...cache, freshness: freshness(rawForFreshness), error: lastError };
}

module.exports = { start, poll, getData, build, freshness, colourName, _internal: { parseSummary, parseSettings, parseRaw, parsePacks } };

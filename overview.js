// All Clients Overview — reads ONLY the Loudr Media "Client Profitability" Google Sheet and turns
// it into one cross-client view: profit tiles (yesterday / week to date / month to date), MTD
// margin, status counts, data freshness, the Walker Agency media balance, and a client table
// grouped by state.
//
// Rules (from the page spec, claude-prompt-all-clients-overview.md):
// - One date range for the whole page; every money figure is summed from raw_current over it, so
//   tiles, state chips and the table tie out. Colour cutoffs come from the Settings tab. Status is
//   red when a client loses money, grey when replacement / cost per case / target is missing,
//   otherwise the worst metric colour. Missing data is grey "No data", never 0 or green.
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
  // J/K/L carry no header text; they're Revenue / Cost / Profit MTD (the TOTAL row's note says
  // "All-in (revenue J20 - all cost K20)"). build() confirms L = J - K on every row before using them.
  const unlabelledMoney = col.revenue < 0 || col.cost < 0 || col.profit < 0;
  if (col.revenue < 0) col.revenue = 9;
  if (col.cost < 0) col.cost = 10;
  if (col.profit < 0) col.profit = 11;
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
  return { rows, unlabelledMoney, dataThrough: isoDate(findLabel(/^data through/)), periodStart: isoDate(findLabel(/^period start/)) };
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
      sent: num(r[c.sent]) || 0, accepted: num(r[c.accepted]) || 0, returned: num(r[c.returned]), // null = not reported
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
    flag: findCol(h, /flag/), refundRate: findCol(h, 'refund rate'), refundsApproved: findCol(h, 'refunds approved'),
  };
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const client = String(r[c.client] || '').trim();
    if (!client || /^no real client rows/i.test(client)) continue;
    out.push({
      client, state: String(r[c.state] || '').trim(), packSize: num(r[c.packSize]), delivered: num(r[c.delivered]),
      remaining: num(r[c.remaining]), pctDelivered: num(r[c.pctDelivered]), pace: c.pace >= 0 ? String(r[c.pace] || '') : '',
      flag: c.flag >= 0 ? String(r[c.flag] || '') : '',
      refundRate: c.refundRate >= 0 ? num(r[c.refundRate]) : null, refundsApproved: c.refundsApproved >= 0 ? num(r[c.refundsApproved]) : null,
    });
  }
  return out;
}

// --- daily profit from raw_current -----------------------------------------------------------
// Every money figure on the page (tiles, state chips, table, subtotals) is summed from these daily
// rows over ONE date range, so they always tie out. Revenue per day follows each deal's terms, the
// same terms the sheet's Summary uses:
//   reported (Walker CA/NW): revenue_reported from the Walker portal
//   agency  (Walker Agency): revenue = WAGENCY spend x 1.35   -> profit = 35% fee
//   hybrid  (Sasooness AZ):  revenue = media / 0.65           ($75,000 round covers $48,750 media)
//   retainer (KM Law):       revenue = media x 1.35           ($20,000 media + $7,000 fee)
//   pay-per-lead:            revenue = leads sent x price per lead
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
  ppl: 'Revenue = leads sent × price per lead', none: 'No client revenue (cost only)',
};
function groupOf(client) {
  const c = norm(client);
  if (c === 'walker ca' || c === 'walker nw') return 'walkerPpl';
  if (c === 'walker agency') return 'walkerAgency';
  return 'other';
}

// Names as the sidebar shows them, so the table and the sidebar agree. The second part says which
// line of business the row is (one client can have several rows).
function displayName(key, sheetName) {
  const k = norm(key);
  if (k === 'walker ca') return { name: 'Walker PPL / Agency', line: 'PPL · California' };
  if (k === 'walker nw') return { name: 'Walker PPL / Agency', line: 'PPL · Nationwide' };
  if (k === 'walker agency') return { name: 'Walker PPL / Agency', line: 'Agency (35% fee)' };
  if (k === 'sasooness az') return { name: 'Sasooness Law Group, APC', line: 'Hybrid · Arizona' };
  if (k === 'sasooness wa') return { name: 'Sasooness Law Group, APC', line: 'PPL · Washington' };
  if (/^km/.test(k)) return { name: 'KM Law Firm PLLC', line: 'Retainer' };
  if (/bryan/.test(k)) return { name: 'Bryan Rodriguez', line: 'PPL' };
  if (/ruy/.test(k)) return { name: 'Ruy Mireles Law Firm', line: 'PPL' };
  if (/^b2b/.test(k)) return { name: 'B2B Dashboard', line: 'Loudr demand-gen (cost only)' };
  return { name: sheetName || key, line: '' };
}

function buildDaily(raw, summaryRows, settings, window) {
  // Pay-per-lead price: the sheet prices these on its Revenue & Payments tab (batch prices in date
  // order, etc.), so each lead is valued at Summary's Revenue MTD ÷ raw_current leads sent over
  // Summary's own window. Summary's MTD then matches exactly. Settings price_per_lead is the fallback.
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
    const s = summaryFor(r.client);
    return { ...r, rule, ruleText: RULE_TEXT[rule], revenue, cost: r.spend, profit: revenue - r.spend, revenueMissing, group: groupOf(r.client), state: s && s.state ? s.state : 'Unmapped' };
  });
}

function sumRows(rows) {
  const t = { revenue: 0, cost: 0, profit: 0, sent: 0, accepted: 0, revenueMissing: false };
  for (const r of rows) { t.revenue += r.revenue; t.cost += r.cost; t.profit += r.profit; t.sent += r.sent; t.accepted += r.accepted; if (r.revenueMissing) t.revenueMissing = true; }
  t.margin = t.revenue > 0 ? t.profit / t.revenue : null;
  return t;
}

// --- freshness -------------------------------------------------------------------------------
// Red: any source's latest load is more than 24h old, or Summary is more than a day behind.
// Orange: the most recent 10:15 AM PT run hasn't restated yesterday. Otherwise green.
function ageText(h) { return h >= 48 ? (h / 24).toFixed(1) + ' days' : Math.round(h) + 'h'; }
function freshness(raw, now = Date.now(), summaryThrough = '') {
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
  const yesterday = addDaysIso(p.date, -1);
  const summaryDaysBehind = summaryThrough ? Math.round((Date.parse(yesterday) - Date.parse(summaryThrough)) / 86400000) : null;
  const stale = sources.filter((s) => s.ageHours > 24).map((s) => ({ source: s.source, age: ageText(s.ageHours) }));
  if (summaryDaysBehind != null && summaryDaysBehind > 1) stale.unshift({ source: 'Summary tab', age: 'through ' + Number(summaryThrough.slice(5, 7)) + '/' + Number(summaryThrough.slice(8, 10)) + ' (' + summaryDaysBehind + ' days behind)' });
  let colour = 'green', reason = '';
  if (!sources.length) { colour = 'red'; reason = 'No loaded_at timestamps in raw_current'; }
  else if (stale.length) { colour = 'red'; reason = stale.map((s) => s.source + ' ' + s.age + (/^through/.test(s.age) ? '' : ' old')).join(' · '); }
  else if (latest < lastRun) { colour = 'orange'; reason = 'Yesterday not restated since the ' + new Date(lastRun).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT run'; }
  return { colour, reason, stale, summaryThrough, latest: latest ? new Date(latest).toISOString() : null, lastRun: new Date(lastRun).toISOString(), sources };
}

// --- agency tracker --------------------------------------------------------------------------
async function agencyBalance() {
  if (!AGENCY_TRACKER_ID || !AGENCY_TRACKER_RANGE) return { connected: false };
  try {
    const [vals] = await batchValues(AGENCY_TRACKER_ID, [AGENCY_TRACKER_RANGE]);
    const v = num(((vals || [])[0] || [])[0]);
    return v == null ? { connected: true, value: null, error: 'Range is empty or not a number' } : { connected: true, value: v };
  } catch (err) {
    return { connected: true, value: null, error: err.message };
  }
}

// --- per-client metrics + status -------------------------------------------------------------
// A Summary cell reading "n/a…" means the metric doesn't apply to that deal (e.g. replacement for
// an agency fee). Anything else that isn't a number is missing data.
const notApplicable = (m) => /^n\/a/i.test(String((m && m.text) || '').trim());

function clientRow(r, rows, ctx) {
  const { settings, band, isSummaryRange, hasLeadSource, pack } = ctx;
  const t = sumRows(rows);
  const dn = displayName(r.key, r.client);
  const isWalker = /^walker/i.test(r.key);
  const rule = revenueRule(r.key, r.dealType);
  const tSet = settings.targets.find((x) => norm(x.client) === norm(r.key) && norm(x.state) === norm(r.state))
    || settings.targets.find((x) => norm(x.client) === norm(r.key));

  // Profit / margin
  const margin = t.revenue > 0 ? t.profit / t.revenue : null;
  const profitColour = t.profit < 0 ? 'red' : margin == null ? 'grey' : margin < band ? 'orange' : 'green';

  // Leads (only for clients whose leads are loaded into raw_current)
  const leads = hasLeadSource ? { sent: t.sent, accepted: t.accepted } : null;

  // Cost / profit per lead and price per lead, over the same range
  const cplApplies = !notApplicable(r.costPerLead);
  const costPerLead = cplApplies && leads && t.sent > 0 ? t.cost / t.sent : null;
  const pricePerLead = cplApplies && leads && t.sent > 0 && (rule === 'ppl' || rule === 'reported') && t.revenue > 0 ? t.revenue / t.sent : null;
  const cplColour = costPerLead == null || pricePerLead == null ? 'grey'
    : costPerLead > pricePerLead ? 'red' : costPerLead > pricePerLead * (1 - band) ? 'orange' : 'green';
  const pplApplies = !notApplicable(r.profitPerLead);
  const profitPerLead = pplApplies && leads && t.sent > 0 ? t.profit / t.sent : null;

  // Replacement rate, first source that has a value: Summary column T ("Replacement rate MTD
  // (returned / sent)", month to date only), raw_current leads_returned ÷ leads_sent, then Mark's
  // tracker (from_mark_ppl "Refund rate"). Settings B4: orange at or above; B3: red above.
  const replApplies = !notApplicable(r.replacement);
  const retRows = rows.filter((x) => x.returned != null);
  let replacement = null, replSource = '';
  if (replApplies && isSummaryRange && r.replacement.value != null) { replacement = r.replacement.value; replSource = 'Summary column T'; }
  else if (replApplies && retRows.length && t.sent > 0) { replacement = retRows.reduce((a, x) => a + x.returned, 0) / t.sent; replSource = 'raw_current leads_returned ÷ leads_sent'; }
  else if (replApplies && pack && pack.refundRate != null) { replacement = pack.refundRate; replSource = 'from_mark_ppl Refund rate'; }
  const replColour = replacement == null ? 'grey'
    : replacement > (settings.maxReplacement ?? 0.2) ? 'red' : replacement >= (settings.orangeReplacement ?? 0.15) ? 'orange' : 'green';

  // Cost per case: the QMVA / signed-case counts only exist on Summary, so the value is Summary's,
  // shown only when the page range is Summary's own range.
  const caseApplies = !notApplicable(r.costPerCase);
  const costPerCase = caseApplies && isSummaryRange ? r.costPerCase.value : null;
  const targetApplies = !notApplicable(r.target);
  const target = tSet && tSet.targetCostPerCase != null ? tSet.targetCostPerCase : (targetApplies ? r.target.value : null);
  const pricePerCase = tSet && tSet.pricePerCase != null ? tSet.pricePerCase : null; // Settings price_per_case
  const caseColour = costPerCase == null || target == null ? 'grey'
    : costPerCase > target ? 'red' : costPerCase > target * (1 - band) ? 'orange' : 'green';

  // Status starts from Summary's own "STATUS (worst metric)" (column U) — not recalculated here.
  // Two overrides so it can never show green on missing data: grey if replacement, cost per case
  // or target is missing; red (Off Track) whenever the client is losing money.
  const missing = [];
  if (replApplies && replacement == null) missing.push('replacement rate');
  if (caseApplies && costPerCase == null) missing.push(isWalker ? 'cost per QMVA' : 'cost per signed case');
  if (targetApplies && target == null) missing.push('target');
  if (!rows.length) missing.push('no rows in range');
  let status, statusNote;
  if (t.profit < 0) { status = 'red'; statusNote = 'Losing money in this range'; }
  else if (missing.length) { status = 'grey'; statusNote = 'Missing: ' + missing.join(', '); }
  else { status = r.status; statusNote = r.status === 'grey' ? 'No status on Summary' : ''; }

  return {
    key: r.key, sheetName: r.client, name: dn.name, line: dn.line, state: r.state, dealType: r.dealType, href: clientHref(r.key),
    status, statusNote, revenue: t.revenue, cost: t.cost, profit: t.profit, margin, profitColour, revenueMissing: t.revenueMissing,
    leads, costPerLead, pricePerLead, cplColour, cplApplies, profitPerLead, pplApplies,
    replacement, replColour, replApplies, replSource, replNote: replApplies && replacement == null ? (r.replacement.text || 'Returns not reported') : '',
    caseLabel: isWalker ? 'Cost per QMVA' : 'Cost per signed case', costPerCase, caseApplies, caseColour, target, targetApplies, pricePerCase,
    caseNote: caseApplies && costPerCase == null ? (isSummaryRange ? (r.costPerCase.text || 'No data') : 'Counts only on Summary (month to date)') : '',
    targetNote: targetApplies && target == null ? (r.target.text || 'No target set') : '',
    isPack: (rule === 'ppl' && !isWalker) || !!pack, rows: rows.length,
  };
}

// --- build -----------------------------------------------------------------------------------
// One date range for the whole page. RANGE_END decides where it stops:
//   'summary' (default): Summary's "Data through" date — the only tab with QMVA / signed-case
//                        counts, so every column can be filled for the same days.
//   'raw':               the latest date in raw_current (fresher; cost per case goes grey).
const RANGE_END = (process.env.OVERVIEW_RANGE_END || 'summary').toLowerCase();

function build({ grid, settingsRows, rawRows, packRows }, nowMs = Date.now()) {
  const warnings = [];
  const settings = parseSettings(settingsRows, warnings);
  const summary = parseSummary(grid, warnings);
  const raw = parseRaw(rawRows, warnings);
  const packs = parsePacks(packRows, warnings);
  const band = settings.orangeBand != null ? settings.orangeBand : 0.15;
  const today = pacificParts(new Date(nowMs)).date;
  const yesterday = addDaysIso(today, -1);
  const rawLatest = raw.reduce((m, r) => (r.date > m && r.date <= yesterday ? r.date : m), '');
  const end = (RANGE_END === 'raw' ? rawLatest : summary.dataThrough) || rawLatest || yesterday;
  const summaryWindow = { start: summary.periodStart || end.slice(0, 8) + '01', end: summary.dataThrough || end };
  const daily = buildDaily(raw, summary.rows, settings, summaryWindow);

  // J/K/L are read by position; make sure they really are revenue / cost / profit.
  if (summary.unlabelledMoney) {
    const bad = summary.rows.filter((r) => r.revenue.value != null && r.cost.value != null && r.profit.value != null && Math.abs(r.revenue.value - r.cost.value - r.profit.value) > 2);
    if (bad.length) warnings.push('Summary J/K/L do not read as revenue/cost/profit on: ' + bad.map((r) => r.client).join(', '));
  }

  const active = summary.rows.filter((r) => r.state && !/^unmapped/i.test(r.client));
  // Hidden: Summary rows with a blank State (column X) — inactive, paused or catch-all.
  const hidden = summary.rows.filter((r) => !r.state || /^unmapped/i.test(r.client)).map((r) => ({ client: r.client, row: r.sheetRow, why: r.statusNote || 'No state on Summary' }));
  const activeKeys = new Set(active.map((r) => norm(r.key)));
  const hasLeadSource = (key) => raw.some((x) => norm(x.client) === norm(key) && (/lead prosper/i.test(x.source) || x.sent > 0));
  const unmappedKeys = [...new Set(daily.filter((d) => !activeKeys.has(norm(d.client))).map((d) => d.client))];

  const periodDefs = {
    yesterday: { label: 'Latest day', start: end, end },
    wtd: { label: 'Week to date', start: mondayOf(end), end },
    mtd: { label: 'Month to date', start: end.slice(0, 8) + '01', end },
  };
  const periods = {};
  for (const [k, p] of Object.entries(periodDefs)) {
    const inRange = (d) => d.date >= p.start && d.date <= p.end;
    const isSummaryRange = p.start === summaryWindow.start && p.end === summaryWindow.end;
    const clients = active.map((r) => {
      const rows = daily.filter((d) => inRange(d) && norm(d.client) === norm(r.key));
      const pack = packs.find((x) => norm(x.client) === norm(r.key) && (!x.state || norm(x.state) === norm(r.state)))
        || packs.find((x) => norm(r.client).startsWith(norm(x.client)) && (!x.state || norm(x.state) === norm(r.state))) || null;
      const c = clientRow(r, rows, { settings, band, isSummaryRange, hasLeadSource: hasLeadSource(r.key), pack });
      if (c.isPack) c.pack = pack ? { delivered: pack.delivered, packSize: pack.packSize, remaining: pack.remaining, pace: pack.pace, flag: pack.flag } : null;
      return c;
    });
    // Raw rows for clients not on Summary still count, in their own "Unmapped" group, so the
    // tiles and the table always add up to the same total.
    for (const key of unmappedKeys) {
      const rows = daily.filter((d) => inRange(d) && d.client === key);
      if (!rows.length) continue;
      const t = sumRows(rows);
      clients.push({ key, sheetName: key, name: key, line: 'Not on Summary', state: 'Unmapped', status: t.profit < 0 ? 'red' : 'grey', statusNote: 'Client not on the Summary tab', revenue: t.revenue, cost: t.cost, profit: t.profit, margin: t.margin, profitColour: t.profit < 0 ? 'red' : 'grey', leads: t.sent ? { sent: t.sent, accepted: t.accepted } : null, caseLabel: 'Cost per signed case', rows: rows.length });
    }
    const order = STATE_ORDER.concat([...new Set(clients.map((c) => c.state))].filter((s) => !STATE_ORDER.includes(s)));
    const groups = order.map((state) => {
      const cs = clients.filter((c) => c.state === state);
      if (!cs.length) return null;
      const revenue = cs.reduce((a, c) => a + c.revenue, 0), cost = cs.reduce((a, c) => a + c.cost, 0), profit = cs.reduce((a, c) => a + c.profit, 0);
      const withLeads = cs.filter((c) => c.leads);
      return {
        state, label: STATE_LABELS[state] || state, clients: cs,
        subtotal: { revenue, cost, profit, margin: revenue > 0 ? profit / revenue : null, incomplete: cs.some((c) => c.revenueMissing),
          leads: withLeads.length ? { sent: withLeads.reduce((a, c) => a + c.leads.sent, 0), accepted: withLeads.reduce((a, c) => a + c.leads.accepted, 0) } : null },
      };
    }).filter(Boolean);
    const tot = (f) => clients.filter(f).reduce((a, c) => ({ revenue: a.revenue + c.revenue, cost: a.cost + c.cost, profit: a.profit + c.profit }), { revenue: 0, cost: 0, profit: 0 });
    const withMargin = (x) => ({ ...x, margin: x.revenue > 0 ? x.profit / x.revenue : null });
    const statusCounts = { red: 0, orange: 0, green: 0, grey: 0 };
    for (const c of clients) statusCounts[c.status]++;
    periods[k] = {
      ...p, isSummaryRange,
      walkerPpl: withMargin(tot((c) => groupOf(c.key) === 'walkerPpl')), walkerAgency: withMargin(tot((c) => groupOf(c.key) === 'walkerAgency')),
      other: withMargin(tot((c) => groupOf(c.key) === 'other')), total: withMargin(tot(() => true)),
      byState: groups.map((g) => ({ state: g.state, label: g.label, profit: g.subtotal.profit })),
      groups, statusCounts,
    };
  }

  // Checks: Summary J/K/L vs raw_current over Summary's own window.
  const checks = [];
  const tol = (a, b) => Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.005);
  for (const r of active) {
    const t = sumRows(daily.filter((d) => norm(d.client) === norm(r.key) && d.date >= summaryWindow.start && d.date <= summaryWindow.end));
    for (const [k, label] of [['revenue', 'Revenue'], ['cost', 'Cost'], ['profit', 'Profit']]) {
      const sheet = r[k].value;
      if (sheet == null) continue;
      if (!tol(t[k], sheet)) checks.push({ client: displayName(r.key, r.client).name + (displayName(r.key, r.client).line ? ' (' + displayName(r.key, r.client).line + ')' : ''), metric: label, summary: sheet, raw: round2(t[k]), diff: round2(t[k] - sheet) });
    }
  }

  // Click-through rows: client → day → source, Pacific dates.
  const detail = daily.filter((d) => d.date >= addDaysIso(today, -62)).map((d) => {
    const dn = displayName(d.client, d.client);
    return {
      date: d.date, client: d.client, name: dn.name + (dn.line ? ' · ' + dn.line : ''), state: d.state, group: d.group, source: d.source, platform: d.platform,
      sent: d.sent, accepted: d.accepted, returned: d.returned, cost: round2(d.cost), revenue: round2(d.revenue), profit: round2(d.profit),
      rule: d.ruleText, revenueMissing: d.revenueMissing, loadedAt: d.loadedAt,
    };
  });

  if (warnings.length) console.warn('overview sheet notes:', warnings.join(' | '));
  return {
    generatedAt: new Date(nowMs).toISOString(), today, yesterday,
    range: { start: periodDefs.mtd.start, end, basis: RANGE_END === 'raw' ? 'raw_current' : 'Summary' },
    summaryWindow, rawLatest,
    settings: { orangeBand: band, maxReplacement: settings.maxReplacement, orangeReplacement: settings.orangeReplacement },
    periods, freshness: freshness(raw, nowMs, summary.dataThrough), checks, detail, hidden,
  };
}
const round2 = (n) => Math.round(n * 100) / 100;

// --- polling ---------------------------------------------------------------------------------
let cache = null, lastError = null, polling = false, rawForFreshness = [], summaryThrough = '';
let lastGoodAt = null, failingSince = null;
// A dropped connection to Google (TLS reset, socket hang-up, timeout) is usually gone a second
// later, so a read is retried up to 3 times before the poll counts as failed.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function readSheet() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await Promise.all([
        summaryGrid(),
        batchValues(SHEET_ID, ["'Settings'!A1:H80", "'raw_current'!A1:N6000", "'from_mark_ppl'!A1:Z300"]),
        agencyBalance(),
      ]);
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn('overview read attempt ' + attempt + ' failed, retrying:', err.message);
      await sleep(attempt * 3000);
    }
  }
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const [grid, values, agency] = await readSheet();
    const [settingsRows, rawRows, packRows] = values;
    cache = { ...build({ grid, settingsRows, rawRows, packRows }), agency };
    rawForFreshness = parseRaw(rawRows, []);
    summaryThrough = cache.freshness.summaryThrough;
    lastError = null; lastGoodAt = Date.now(); failingSince = null;
  } catch (err) {
    lastError = err.message;
    if (!failingSince) failingSince = Date.now();
    console.error('overview poll error:', err.message);
  } finally {
    polling = false;
  }
}
function start() { poll(); setInterval(poll, POLL_MS); }
function getData() {
  if (!cache) return { loading: !lastError, error: lastError };
  // Freshness depends on the clock, so it's re-evaluated per request rather than per poll.
  // Only surface a read failure once reads have kept failing for 15 minutes (3 polls); a single
  // blip just means the page keeps showing the last good read, which is what it does anyway.
  const failing = lastError && failingSince && Date.now() - failingSince >= 15 * 60 * 1000;
  return { ...cache, freshness: freshness(rawForFreshness, Date.now(), summaryThrough), error: failing ? lastError : null, lastGoodAt: lastGoodAt ? new Date(lastGoodAt).toISOString() : null };
}

module.exports = { start, poll, getData, build, freshness, colourName, _internal: { parseSummary, parseSettings, parseRaw, parsePacks } };

// Server-side port of scripts/refresh_campaign_snapshot.js + scripts/track_late_and_restored.js —
// runs inside server.js itself on a setInterval instead of depending on Apps Script (proved
// unreliable: paste corruption, and its trigger silently reverted a bugfix here once already) or
// a scheduled task on this laptop (only runs while this machine is on). server.js already runs
// 24/7 on Render independent of any laptop, so folding the correction logic in here is the one
// automation path that's both always-on and lives in code this project's own git history tracks.
//
// Needs a write-scoped access token (spreadsheets, not spreadsheets.readonly) — see getAccessToken
// in server.js and the OAUTH_REFRESH_TOKEN value deployed on Render.

const { withRetry } = require('./walker-rate_limit');

const MAIN_DOC = '1-Wh4ilpfXqmCRdVwFqv2oBz_soAaFzg30SKHl7Qq3-0';
// The user's own compiled workbook ("NEW REAL TIME WALKER PORTAL" tabs, re-gathered via
// IMPORTRANGE) — confirmed its "Publisher Data CA/TX" tab uses the exact same IMPORTRANGE formula
// as MAIN_DOC's own tab of the same name (both pull "Copy of PUBLISHER REPORT" from
// 1eS-22SJ5oUYyrjlJZCWBcmuGYgynO417EvLx896Tah0), and every other tab used below matches the
// column layout this code already expects. Per the user: use this one document as the live
// source going forward instead of reading Publisher Data / DATABASE PPL / Real Time Publisher
// Portal / the webhook from four separate spreadsheets. One caveat worth knowing: IMPORTRANGE
// only recalculates on Google's own schedule, not on every read, so this can occasionally lag the
// true source by a few minutes in a way direct API reads of the originals never did.
const LIVE_SOURCE_DOC = '1500g7cuyitT9Xmn85TkMoWXs9XYBoDOBs1cvz5Na36w';
const PUBLISHER_DOC = LIVE_SOURCE_DOC;
const QMVA_PAYOUT_DOC = LIVE_SOURCE_DOC;
// The webhook conversion log — a near-instant record as leads convert. Publisher Data CA/TX (the
// correction pipeline's usual ground truth) can lag this by hours to days for very recent dates —
// confirmed directly: Sep 8 showed $6,240/4 leads in Publisher Data while this sheet already had
// $15,565/12 qualified leads for the same day. Used to top up recent dates so "today"/"yesterday"
// numbers don't sit wrong for hours waiting on Publisher Data to catch up. Read via LIVE_SOURCE_DOC's
// own "QMVA Webhook" tab (an IMPORTRANGE of the same underlying webhook log) rather than the
// original webhook spreadsheet directly, per the user's move to one consolidated live source.
const WEBHOOK_DOC = LIVE_SOURCE_DOC;
const WEBHOOK_SHEET = 'QMVA Webhook';
const INVOICE_DOC = '1ffi371ow2ZJ2PfTGGzdhuSct6MZbR0L8njf5fT3oiyI';
const INVOICE_SHEET = 'GLOBAL INVOICE AND PROFIT';
const SNAPSHOT_SHEET = 'QMVA Watch (Claude)';
const LATE_SHEET = 'Late QMVAs (Claude)';
const RESTORED_SHEET = 'Restored Leads (Claude)';
// Per-date/vertical high-water mark: once a date's revenue is corrected to some value, it can
// only go UP from then on (a genuine new Late QMVA landing), never down. Per the user: once a
// QMVA is paid, it's paid — if Publisher Data later shows that same lead disqualified/reversed,
// that's real, but it must not retroactively shrink revenue for a date already reported on.
// Confirmed this was happening: Aug 31 dropped by exactly $2,340 (one QMVA's worth) between two
// runs with no corresponding Late QMVA/Restored entry, because a previously-qualified lead had
// simply gone back to $0 in Publisher Data and the correction logic dutifully matched the new,
// lower reality.
const FLOOR_SHEET = 'Revenue Floor (Claude)';
const DASHBOARD_URL = 'https://walker-dashboard.onrender.com';
const LOGIN_NAME = 'Mark';
const LOGIN_PIN = '2002';

async function getValues(token, sheet, range, docId = MAIN_DOC) {
  return withRetry(async () => {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${docId}/values/${encodeURIComponent("'" + sheet + "'!" + range)}`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const json = await res.json();
    if (json.error) throw new Error(`read ${sheet} failed: ` + JSON.stringify(json.error));
    return json.values || [];
  });
}

async function clearRange(token, sheet, range, docId = MAIN_DOC) {
  return withRetry(async () => {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${docId}/values/${encodeURIComponent("'" + sheet + "'!" + range)}:clear`;
    await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  });
}

async function writeValues(token, sheet, range, values, docId = MAIN_DOC) {
  return withRetry(async () => {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${docId}/values/${encodeURIComponent("'" + sheet + "'!" + range)}?valueInputOption=USER_ENTERED`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    return res.json();
  });
}

async function appendValues(token, sheet, values, docId = MAIN_DOC) {
  if (!values.length) return;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${docId}/values/${encodeURIComponent("'" + sheet + "'!A:K")}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  return res.json();
}

function parseMoney(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Render runs its servers in UTC, not Pacific — a raw `new Date()` can already show the next
// calendar day while it's still mid-afternoon in Pacific time, which silently shifted every
// "today"/"yesterday" computation in this file by a full day. Per the user: rely on Pacific time
// (America/Los_Angeles, DST-aware) for what day it actually is. daysOffset is subtracted from
// today (0 = today, 1 = yesterday), both in Pacific time.
function pacificDateKey(daysOffset = 0) {
  const now = new Date(Date.now() - daysOffset * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('month')}/${get('day')}/${get('year')}`;
}

function normPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

function normPublisherDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${Number(m[1])}/${Number(m[2])}/${m[3]}`;
  m = s.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (m) return `${Number(m[1])}/${Number(m[2])}/20${m[3]}`;
  return null;
}

// See refresh_campaign_snapshot.js's sanitizeRow comment — COPY/COPY OF's own Revenue formula
// occasionally produces impossible multi-billion-dollar values for unmatched leads.
const REVENUE_SANITY_CEILING = 100000;

// COPY/COPY OF (the live source tabs this code only ever reads) carry ~80 rows whose Date cell is
// a raw spreadsheet serial number ("46180" = 2026-06-07) instead of "M/D/YYYY" — a number-formatted
// cell upstream that can't be edited from here. Confirmed live: 79 such rows (Apr 20 - Jul 8) hold
// $80,619 of ad spend and ~415 leads that vanished from every date-range view (no date matched)
// while still counting in all-time totals, and the paid-period invoice clamp then topped spend up
// again for the same money. Convert to the normal M/D/YYYY key wherever a sheet date is read.
function normSheetDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (/^\d{5}$/.test(s)) {
    const n = Number(s);
    if (n > 30000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
    }
  }
  return s;
}

function sanitizeRow(input) {
  const row = /^\d{5}$/.test(String(input[0] == null ? '' : input[0]).trim()) ? [normSheetDate(input[0]), ...input.slice(1)] : input;
  const revenue = Number(String(row[11] || '0').replace(/[$,]/g, ''));
  if (revenue > REVENUE_SANITY_CEILING) {
    const fixed = [...row];
    const spend = Number(String(row[6] || '0').replace(/[$,]/g, ''));
    fixed[11] = '$0.00';
    fixed[12] = `-$${spend.toFixed(2)}`;
    return fixed;
  }
  return row;
}

const CA_CAMPAIGNS = new Set(['Loudr', 'LoudrDQ', 'LoudrSPCA', 'LoudrSP_DQ', 'Loudr - IB SP', 'Loudr - IB CA', 'LoudrCA - IB SP']);
const NW_CAMPAIGNS = new Set(['LoudrNWCPA', 'LoudrNWDQ', 'Loudr - IB NW TX', 'LoudrNWCPA - IB', 'Loudr - IB NW GA', 'LoudrNWCPA_SP', 'LoudrNWCPA - IB SP', 'LoudrNW', 'Loudr - IB Catchall']);

async function getImportLeadsByPhone(token) {
  const byPhone = {};
  for (const row of await getValues(token, 'Import_CA PPL QMVA', 'A2:S50000')) {
    const phone = normPhone(row[18]);
    if (!phone) continue;
    (byPhone[phone] ||= []).push({ date: row[0], state: row[1], ad: row[15] });
  }
  for (const row of await getValues(token, 'Import_NW PPL QMVA', 'A2:S50000')) {
    const phone = normPhone(row[14]);
    if (!phone) continue;
    (byPhone[phone] ||= []).push({ date: row[0], state: row[1], ad: row[12] });
  }
  return byPhone;
}

// Tracks each phone's Date column too, not just the payout — DATABASE PPL CA/NW's Date is when
// the QMVA payout doc itself confirmed the lead (its own processing/qualification date), which can
// legitimately differ from whatever date Publisher Data (or the webhook) has on file. Confirmed:
// Alvin Jones's only Publisher Data row is dated 9/3 and marked disqualified, while DATABASE PPL NW
// has him Qualified=Yes/$1,300 dated 9/14 — and the "Real Time Publisher Portal" tab (the actual
// live publisher-facing view) agrees with the 9/14 date. Used below to re-date a top-up to the
// payout doc's own date instead of silently leaving it on Publisher Data's (possibly stale) date.
// The invoice sheet's own "Late QMVAs" tab groups rows by "Invoice Time Period" — each group is a
// literal list of the leads that make up one period's manually-entered Late QMVA Invoice figure,
// each with its own real conversion date. Used so a period's revenue top-up lands on the actual
// days those leads converted instead of one lump sum dumped on the period's end date. Confirmed:
// the 57-lead, $52,432 group backing Aug 31 - Sep 6's Late QMVA Invoice spans dates from 4/12
// through 8/30 — dumping all of it on 9/6 alone was making that single day look wildly inflated.
async function getInvoiceLateQmvaBatches(token) {
  const rows = (await getValues(token, 'Late QMVAs', 'A5:T3000', INVOICE_DOC)) || [];
  const batches = {};
  for (const row of rows) {
    const label = row[3];
    if (!label) continue;
    const date = normPublisherDate(row[4]);
    const commission = parseMoney(row[11]);
    if (!date || !commission) continue;
    const batch = (batches[label] ||= { leads: [], total: 0 });
    batch.leads.push({ date, commission });
    batch.total += commission;
  }
  return batches;
}

async function getQmvaPayouts(token) {
  const byPhone = {};
  const consider = (phone, payout, date, vertical) => {
    if (!phone || !payout) return;
    const prev = byPhone[phone];
    if (!prev || payout > prev.payout) byPhone[phone] = { payout, date, vertical };
  };
  for (const row of await getValues(token, 'DATABASE PPL CA', 'A2:T20000', QMVA_PAYOUT_DOC)) {
    consider(normPhone(row[18]), parseMoney(row[11]), normPublisherDate(row[0]), 'CA');
  }
  for (const row of await getValues(token, 'DATABASE PPL NW', 'A2:T20000', QMVA_PAYOUT_DOC)) {
    consider(normPhone(row[14]), parseMoney(row[17]), normPublisherDate(row[0]), 'NW');
  }
  return byPhone;
}

// "MM/DD/YY hh:mm AM/PM" (Walker Leads Convert's timestamp format) -> "M/D/YYYY", matching
// normPublisherDate's output so webhook leads line up with Publisher Data leads on the same date
// key.
function normWebhookDate(raw) {
  const m = String(raw || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{2})/);
  if (!m) return null;
  return `${Number(m[1])}/${Number(m[2])}/20${m[3]}`;
}

async function getWebhookLeads(token) {
  const rows = await getValues(token, WEBHOOK_SHEET, 'A2:T30000', WEBHOOK_DOC);
  const leads = { CA: [], NW: [] };
  for (const row of rows) {
    const campaign = row[4]; // "src" column — row[12] is a numeric campaign ID, not the code
    const vertical = CA_CAMPAIGNS.has(campaign) ? 'CA' : NW_CAMPAIGNS.has(campaign) ? 'NW' : null;
    if (!vertical) continue;
    const date = normWebhookDate(row[0]);
    if (!date) continue;
    const qualified = String(row[7] || '').trim().toUpperCase() === 'Y';
    const commission = qualified ? parseMoney(row[3]) : 0;
    if (commission === 0) continue;
    const phone = normPhone(row[2]);
    leads[vertical].push({ date, state: '', phone, commission });
  }
  return leads;
}

// Live disqualification check for webhook-sourced leads specifically — a phone with no row
// anywhere in Publisher Data has no other way to ever be reversed once the webhook's initial
// "qualified" snapshot gets stale. "Real Time Publisher Portal" (a separate tab in the QMVA payout
// doc) keeps its own Qualified column current after the fact — confirmed: Zhongmin Liu (9/15,
// $2,340) was Qualified=Y in the webhook at conversion time, but this tab later flipped him to
// Qualified=No, with no row for him in Publisher Data to catch that reversal any other way. Last
// row per phone wins (the tab is a live, append-style feed, so a later row is a fresher status).
async function getRealTimePublisherPortal(token) {
  const rows = (await getValues(token, 'Real Time Publisher Portal', 'A2:T20000', QMVA_PAYOUT_DOC)) || [];
  const status = {};
  const amounts = {};
  const dates = new Set();
  // Publisher Data trails by about a day, so the portal (already live in the source workbook) is
  // the source for the last three Pacific days: any qualified lead there that Publisher Data has no
  // row for yet gets counted on its own date.
  const recentKeys = new Set([pacificDateKey(0), pacificDateKey(1), pacificDateKey(2)]);
  const todayLeads = { CA: [], NW: [] };
  for (const row of rows) {
    // A malformed phone (e.g. 9 digits) must not drop a qualified lead: fall back to name as its key.
    const phone = normPhone(row[10]) || `name:${String(row[5] || '')}${String(row[6] || '')}`.replace(/\s+/g, '').toLowerCase();
    if (phone === 'name:') continue;
    // A lead counts as qualified whenever it carries a real payout commission — the Qualified
    // column itself is not the source of truth (confirmed per the user: a "No" row still carries
    // its real commission and must still count; only Loudr_NWA, filtered downstream via
    // CA_CAMPAIGNS/NW_CAMPAIGNS, is excluded).
    const qFlag = String(row[2] || '').trim().toLowerCase();
    const amt = parseMoney(row[9]);
    const hasPayout = amt > 0 && amt <= MAX_LEAD_COMMISSION;
    const qualified = hasPayout;
    dates.add(normPublisherDate(row[0]));
    // A real payout always counts, even under a "No" row (a stale commission cell the portal never
    // cleared) — only an explicit "No" with NO payout left is a genuine, still-blocking
    // disqualification for other sources' stale amounts downstream (status[phone] === false checks).
    if (hasPayout) status[phone] = true;
    else if (qFlag === 'no') status[phone] = false;
    if (qualified) amounts[`${phone}|${normPublisherDate(row[0])}`] = amt;
    const leadDate = normPublisherDate(row[0]);
    if (!qualified || !recentKeys.has(leadDate)) continue;
    const campaign = row[7];
    const vertical = CA_CAMPAIGNS.has(campaign) ? 'CA' : NW_CAMPAIGNS.has(campaign) ? 'NW' : null;
    const commission = parseMoney(row[9]);
    if (!vertical || !commission || commission > MAX_LEAD_COMMISSION) continue;
    todayLeads[vertical].push({ date: leadDate, state: row[1] || '', phone, commission });
  }
  return { status, amounts, dates, todayLeads };
}

const MAX_LEAD_COMMISSION = 10000;

async function getPublisherLeads(token, qmvaPayouts, rtpp) {
  const rows = await getValues(token, 'Publisher Data CA/TX', 'A2:V30000', PUBLISHER_DOC);
  const totals = { CA: {}, NW: {} };
  const counts = { CA: {}, NW: {} };
  const leads = { CA: [], NW: [] };
  // Every phone Publisher Data has ANY row for — qualified or not, $0 or not, any vertical. Not
  // scoped to only the rows that passed the qualified+nonzero filter below: a lead the webhook
  // caught at conversion time can later be disqualified/reversed back to $0 in Publisher Data, and
  // that phone must still block the webhook's now-stale amount — Publisher Data is the live source
  // of truth on qualification status, the webhook is only a snapshot of the moment it converted.
  // Confirmed this was live-double-counting reversed leads before this fix.
  const allPublisherPhones = new Set();
  const phoneHasQualifiedRow = new Set();
  for (const row of rows) {
    const p1 = normPhone(row[5]), p2 = normPhone(row[6]);
    if (p1) allPublisherPhones.add(p1);
    if (p2) allPublisherPhones.add(p2);
    if (String(row[8] || '').trim().toLowerCase() === 'yes') {
      if (p1) phoneHasQualifiedRow.add(p1);
      if (p2) phoneHasQualifiedRow.add(p2);
    }
  }
  const countedPhones = new Set();
  for (const row of rows) {
    const campaign = row[16];
    if (campaign === 'Loudr_NWA' || campaign === 'Loudr NWA - IB' || campaign === 'LoudrDupe') continue;
    const rowDate = normPublisherDate(row[0]);
    if (!rowDate) continue;
    const vertical = CA_CAMPAIGNS.has(campaign) ? 'CA' : NW_CAMPAIGNS.has(campaign) ? 'NW' : null;
    if (!vertical) continue;
    const phone = normPhone(row[5]) || normPhone(row[6]);
    const qualified = String(row[8] || '').trim().toLowerCase() === 'yes';
    // The Real Time Publisher Portal is the final word: if it says this phone is NOT qualified, no
    // Publisher Data commission (even a stale nonzero one on a disqualified row) may count.
    if (phone && rtpp.status[phone] === false) continue;
    // A phone the portal has never heard of, on a date the portal covers, whose only support is a
    // non-qualified Publisher row topped up from the payout doc: the portal is final, so it doesn't count.
    if (phone && !qualified && rtpp.status[phone] === undefined && rtpp.dates.has(rowDate)) continue;
    // The publisher export has shipped absurd commissions (e.g. $238,680 for a $2,340 lead); anything
    // over the cap is treated as unusable and the payout doc's own figure takes over.
    const ownRaw = parseMoney(row[7]);
    const own = ownRaw > MAX_LEAD_COMMISSION ? 0 : ownRaw;
    // Publisher Data can carry TWO rows for the same phone/date: a disqualified duplicate ($0,
    // Qualified: No) alongside the real qualified row with the actual commission (confirmed: Amir
    // Tahvildaran, Franklin Ford, Garrett Hunter all have this pattern) — topping up the duplicate
    // too would double-count. But when a phone has NO qualified row anywhere (this IS the only
    // row), Publisher Data just hasn't caught up yet, and the QMVA payout doc (DATABASE PPL CA/NW)
    // can already be Qualified=Yes with a real Payout — confirmed: Sumaya Ahmed (9/13) was
    // Qualified=Yes/$392 there but Qualified=No/$0 here, with no other row for her phone, and the
    // old qualified-gated code silently dropped her $392. So: top up whenever this row is qualified,
    // or whenever it's the phone's only row at all.
    const eligible = qualified || (phone && !phoneHasQualifiedRow.has(phone));
    const payoutDoc = phone && qmvaPayouts[phone];
    // The portal's own amount is final when it has this phone qualified (e.g. a $250 DQ lead must not
    // be lifted to another source's $1,300).
    // DATABASE PPL CA/NW is the source of truth for adjusted leads (e.g. a wrongly converted lead the
    // portal still shows at $250 but DATABASE corrected to $1,300 — Richard Velasquez), so its amount
    // wins when it has this phone qualified on this same date; then the portal's own amount; then the
    // old higher-of-Publisher/payout rule.
    const dbAmount = payoutDoc && payoutDoc.date === rowDate ? payoutDoc.payout : 0;
    const rtppAmount = phone && rtpp.amounts[`${phone}|${rowDate}`];
    // Only fall through to the payout doc's amount (a DIFFERENT date's conversion, e.g. an earlier
    // real lead for the same repeat-caller phone) when neither the DATABASE match nor the portal
    // already gave us a real number for THIS row's own date — otherwise a genuinely separate older
    // lead's revenue gets misdated onto the payout doc's newer date while keeping its own (wrong)
    // amount. Confirmed: Melinda Lucht's real 7/9 lead ($1,405, matched by the portal on 7/9) was
    // getting its date silently moved to 9/27 just because DATABASE's newer 9/27 lead ($1,685) for
    // the same phone happened to be bigger — duplicating her onto 9/27 at the wrong amount.
    const usedPayoutDocFallback = eligible && !dbAmount && !rtppAmount && payoutDoc && payoutDoc.payout > own;
    const commission = eligible
      ? (dbAmount || rtppAmount || Math.max(own, (payoutDoc && payoutDoc.payout) || 0))
      : own;
    if (commission === 0) continue;
    // When the payout doc's own confirmed amount is what's actually driving this commission (i.e.
    // nothing else already confirmed THIS row's own date) and it carries a different date, attribute
    // the revenue to ITS date instead of Publisher Data's — Publisher Data's date can be stale for a
    // lead the payout doc has already moved on from. Confirmed: Alvin Jones's only Publisher Data
    // row sits on 9/3 (disqualified there), but DATABASE PPL NW confirms him Qualified=Yes/$1,300
    // dated 9/14, which the "Real Time Publisher Portal" view agrees with — his revenue belongs on
    // 9/14, not 9/3.
    const date = (usedPayoutDocFallback && payoutDoc.date) ? payoutDoc.date : rowDate;
    const state = row[15] || row[21] || '';
    totals[vertical][date] = (totals[vertical][date] || 0) + commission;
    counts[vertical][date] = (counts[vertical][date] || 0) + 1;
    leads[vertical].push({ date, state, phone, commission });
    if (phone) countedPhones.add(phone);
  }

  // TODAY ONLY (Pacific): Publisher Data and DATABASE PPL CA/NW trail by about a day, so today's
  // revenue exists nowhere in them yet — confirmed live: today already had $5,837 of PPL revenue in
  // "Real Time Publisher Portal" (plus one webhook lead not in it yet) while the dashboard showed $0.
  // The portal is the live source for today (it carries its own Qualified flag, so a same-day
  // reversal drops out on the next sync); the webhook then fills in only what the portal doesn't
  // have yet. Previous days never get webhook-only revenue: by then Publisher Data / the payout doc
  // are the confirmed sources, and a webhook-only lead can be reversed with nothing here able to
  // notice (Zhongmin Liu, 9/15, $2,340). Per the user: webhook/live revenue for today's date only.
  const todayKey = pacificDateKey(0);
  for (const vertical of ['CA', 'NW']) {
    for (const lead of rtpp.todayLeads[vertical]) {
      // The portal says qualified: count it unless Publisher Data already counted this phone (a
      // Publisher row that is still Qualified=No/$0 must not hide a lead the portal has confirmed).
      if (countedPhones.has(lead.phone)) continue;
      if (rtpp.status[lead.phone] === false) continue;
      const dbLead = qmvaPayouts[lead.phone];
      if (dbLead && dbLead.date === lead.date && dbLead.payout > 0) lead.commission = dbLead.payout;
      totals[vertical][lead.date] = (totals[vertical][lead.date] || 0) + lead.commission;
      counts[vertical][lead.date] = (counts[vertical][lead.date] || 0) + 1;
      leads[vertical].push(lead);
      allPublisherPhones.add(lead.phone);
    }
  }

  // Webhook top-up — today's date only, for leads neither Publisher Data nor the portal has yet.

  const webhookLeads = await getWebhookLeads(token);
  for (const vertical of ['CA', 'NW']) {
    for (const lead of webhookLeads[vertical]) {
      if (lead.date !== todayKey) continue;
      if (lead.phone && allPublisherPhones.has(lead.phone)) continue;
      // Real Time Publisher Portal explicitly says this phone is disqualified now, overriding the
      // webhook's stale "qualified" snapshot — see getRealTimePublisherPortal's comment.
      if (lead.phone && rtpp.status[lead.phone] === false) continue;
      // The payout doc (DATABASE PPL CA/NW) is the higher-priority "Publisher Portal" source — if
      // it already has this phone confirmed with an amount/date, prefer its date+amount over the
      // webhook's own snapshot. Confirmed: Frederica Edwards has no Publisher Data row at all; the
      // webhook has her dated 9/15, but DATABASE PPL NW confirms her Qualified=Yes/$1,300 dated
      // 9/14 (matching "Real Time Publisher Portal") — her revenue belongs on 9/14.
      const payoutDoc = lead.phone && qmvaPayouts[lead.phone];
      const date = (payoutDoc && payoutDoc.date) ? payoutDoc.date : lead.date;
      const commission = Math.max(lead.commission, (payoutDoc && payoutDoc.payout) || 0);
      totals[vertical][date] = (totals[vertical][date] || 0) + commission;
      counts[vertical][date] = (counts[vertical][date] || 0) + 1;
      leads[vertical].push({ ...lead, date, commission });
      if (lead.phone) allPublisherPhones.add(lead.phone);
    }
  }

  // Last resort: a phone confirmed Qualified=Yes with a real Payout in DATABASE PPL CA/NW but with
  // NO row anywhere in Publisher Data and NO webhook entry either — genuinely falls through both
  // of the checks above, since each only tops up or fills in around an existing anchor. Confirmed:
  // Homer Curry and Tracy Young (9/15, $1,300 each) are Qualified=Yes in DATABASE PPL NW but don't
  // exist in Publisher Data CA/TX or the webhook at all — without this, their revenue is simply
  // never counted anywhere.
  for (const [phone, payoutDoc] of Object.entries(qmvaPayouts)) {
    if (allPublisherPhones.has(phone)) continue;
    if (!payoutDoc.vertical || !payoutDoc.date || !payoutDoc.payout) continue;
    // Same Real Time Publisher Portal override as the webhook path above — a phone with no
    // Publisher Data row can only ever be reversed through this check. Confirmed: Zhongmin Liu is
    // Qualified=Yes in DATABASE PPL CA too, so without this check here specifically, he'd slip
    // back in through this fallback even after being correctly skipped in the webhook loop above.
    if (rtpp.status[phone] === false) continue;
    if (rtpp.status[phone] === undefined && rtpp.dates.has(payoutDoc.date)) continue; // portal covers this date and never listed the phone
    const vertical = payoutDoc.vertical;
    totals[vertical][payoutDoc.date] = (totals[vertical][payoutDoc.date] || 0) + payoutDoc.payout;
    counts[vertical][payoutDoc.date] = (counts[vertical][payoutDoc.date] || 0) + 1;
    leads[vertical].push({ date: payoutDoc.date, state: '', phone, commission: payoutDoc.payout });
    allPublisherPhones.add(phone);
  }

  return { totals, counts, leads };
}

function copyRevenueByDate(values) {
  const totals = {};
  const counts = {};
  for (const row of values) {
    const date = row[0];
    if (!date) continue;
    counts[date] = (counts[date] || 0) + (Number(row[10]) || 0);
    totals[date] = (totals[date] || 0) + parseMoney(row[11]);
  }
  return { totals, counts };
}

// The invoice clamp below needs each date's TRUE current total, not just Publisher Data's
// contribution — a date where Publisher Data has zero leads is left with COPY/COPY OF's own
// native (unreplaced) revenue untouched (see refreshOne's comment), and that revenue was
// invisible to computeRevenueAdjustments, which only ever summed publisher.totals. Confirmed
// this was double-counting: Feb 9-15 has zero real Publisher Data leads, so COPY's own native
// $9,900 sat untouched — and the clamp, seeing $0 from Publisher Data, added its own $9,900 on
// top, landing the week at $19,800 (exactly double the $9,900 invoice) instead of matching it.
// Mirrors refreshOne's own replace-or-leave-native decision exactly, so this always reflects
// what actually ends up written to the sheet.
function computeEffectiveTotals(publisher, copyTotalsByVertical) {
  const effective = { CA: {}, NW: {} };
  for (const vertical of ['CA', 'NW']) {
    const pubTotals = publisher.totals[vertical];
    const pubCounts = publisher.counts[vertical];
    const copy = copyTotalsByVertical[vertical];
    const dates = new Set([...Object.keys(pubTotals), ...Object.keys(copy.totals)]);
    for (const date of dates) {
      const revenueGap = (pubTotals[date] || 0) - (copy.totals[date] || 0);
      const countGap = (pubCounts[date] || 0) - (copy.counts[date] || 0);
      const replaced = pubTotals[date] && (Math.abs(revenueGap) > 1 || countGap !== 0);
      effective[vertical][date] = replaced ? pubTotals[date] : (copy.totals[date] || 0);
    }
  }
  return effective;
}

// NW spend comes from COPY's formula over the main doc's own "Google Ad Spent" tab, whose feed can
// go stale/#REF!. The live source's "Google AD Spent" tab is the current record, so for any date
// where COPY shows no NW spend at all, fill it from there (Texas PPL campaigns only).
async function getLiveGoogleSpendByDate(token, matches) {
  const rows = (await getValues(token, 'Google AD Spent', 'A2:I20000', LIVE_SOURCE_DOC)) || [];
  const byDate = {};
  for (const row of rows) {
    const m = String(row[0] || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) continue;
    const campaign = String(row[1] || '').toUpperCase();
    if (!matches(campaign)) continue;
    const date = `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
    byDate[date] = (byDate[date] || 0) + parseMoney(row[4]);
  }
  return byDate;
}

// Both take already-fetched COPY/COPY OF rows instead of re-reading the sheet — refreshOne,
// computeLateQmvaCorrelation and computeCampaignTrends all need spend-by-date derived from the
// exact same COPY/COPY OF rows they (or a sibling call) already fetch for revenue, so every caller
// reads each of COPY/COPY OF exactly once per run and reuses it, instead of the same sheet being
// re-fetched 3 separate times (revenue, youtube spend, total spend) — confirmed this was most of
// a sync run's wall-clock time once the shared rate limiter made redundant reads costly.
function youtubeSpendByDateFromRows(rows) {
  const byDate = {};
  for (const row of rows) {
    const date = normSheetDate(row[0]);
    if (!date) continue;
    byDate[date] = (byDate[date] || 0) + parseMoney(row[4]);
  }
  return byDate;
}

function spendByDateFromRows(rows) {
  const byDate = {};
  for (const row of rows) {
    const date = normSheetDate(row[0]);
    if (!date) continue;
    byDate[date] = (byDate[date] || 0) + parseMoney(row[6]);
  }
  return byDate;
}

// Same idea as reconcileWithInvoice, but for the Ad Spent side — the live dashboard's spend can
// run either higher or lower than what the Invoice sheet actually recorded for a period (ad
// platform sync timing), and profit needs both sides to match the invoice to reconcile exactly,
// not just revenue. Unlike revenue this is a two-way adjustment (can be negative, pulling spend
// down), split CA/NW proportionally to each vertical's current spend share for that period, then
// spread across the period's own dates weighted by that date's live Google Ad Spend (weightByDate
// — the "Google AD Spent" live-source file, same one getLiveGoogleSpendByDate reads) instead of
// dumped as one lump sum on the period's end date. Confirmed the old end-date-lump behavior was
// misleading rather than wrong in aggregate: a single 2-week PAID period (March 1-15) swung the
// dashboard's single-day 3/15 view to -$116,575.05 ad spend, even though the period total it was
// reconciling to was correct — any single calendar day can absorb a multi-week correction when
// you happen to filter down to it.
function computeSpendAdjustments(spendByDate, periods, weightByDate = {}) {
  const adjustments = { CA: {}, NW: {} };
  for (const period of periods) {
    let caSum = 0, nwSum = 0;
    for (const vertical of ['CA', 'NW']) {
      for (const date of Object.keys(spendByDate[vertical])) {
        const t = dateKeyToTuple(date);
        if (!t || !dateLte(period.start, t) || !dateLte(t, period.end)) continue;
        if (vertical === 'CA') caSum += spendByDate.CA[date];
        else nwSum += spendByDate.NW[date];
      }
    }
    const currentTotal = caSum + nwSum;
    const diff = period.invoiceAdSpend - currentTotal;
    if (Math.abs(diff) < 1) continue;
    const caShare = currentTotal > 0 ? caSum / currentTotal : 0.5;
    const verticalDiff = { CA: diff * caShare, NW: diff * (1 - caShare) };

    for (const vertical of ['CA', 'NW']) {
      const vDiff = verticalDiff[vertical];
      if (Math.abs(vDiff) < 0.01) continue;
      const weights = weightByDate[vertical] || {};
      const datesInPeriod = [];
      let weightSum = 0;
      for (const date of Object.keys(weights)) {
        const t = dateKeyToTuple(date);
        if (!t || !dateLte(period.start, t) || !dateLte(t, period.end)) continue;
        const w = weights[date] || 0;
        if (w <= 0) continue;
        datesInPeriod.push(date);
        weightSum += w;
      }
      if (!datesInPeriod.length) {
        // No Google Ad Spend weight data at all for this period/vertical — fall back to the old
        // end-date lump rather than silently dropping the adjustment.
        const endKey = `${period.end[1]}/${period.end[2]}/${period.end[0]}`;
        adjustments[vertical][endKey] = (adjustments[vertical][endKey] || 0) + vDiff;
        continue;
      }
      for (const date of datesInPeriod) {
        adjustments[vertical][date] = (adjustments[vertical][date] || 0) + vDiff * (weights[date] / weightSum);
      }
    }
  }
  return adjustments;
}

const BRYAN_WEEKS = [
  { week: '8/3-8/5', total: 11529.80, leads: { '8/3/2026': 29, '8/4/2026': 27, '8/5/2026': 14 } },
  { week: '8/17-8/19', total: 1017.89, leads: { '8/17/2026': 2, '8/18/2026': 2, '8/19/2026': 2 } },
  { week: '8/31-9/6', total: 176.21, leads: { '9/1/2026': 1 } },
  { week: '9/7-9/13', total: 1834.08, leads: { '9/9/2026': 2, '9/10/2026': 2, '9/11/2026': 2, '9/12/2026': 2, '9/13/2026': 2 } },
  { week: '9/14-9/20', total: 2337.42, leads: { '9/14/2026': 2, '9/15/2026': 2, '9/16/2026': 2, '9/17/2026': 2, '9/18/2026': 2, '9/19/2026': 2, '9/20/2026': 2 } },
];
// Bryan's ad spend is deducted per Bryan lead (CPL = week total / lead count) on each lead's own date.
const BRYAN_AD_SPEND = BRYAN_WEEKS.flatMap((w) => {
  const n = Object.values(w.leads).reduce((a, b) => a + b, 0);
  return Object.entries(w.leads).map(([date, c]) => ({ week: w.week, date, amount: Math.round((w.total * c / n) * 100) / 100 }));
});

async function refreshOne(token, which, publisher, importByPhone, revenueAdjustments, spendAdjustments, spendFill = null, write = true, rawValues = null) {
  const srcSheet = which === 'NW' ? 'COPY' : 'COPY OF';
  const dstSheet = which === 'NW' ? 'NW PPL CAMPAIGN' : 'CA PPL CAMPAIGN';

  // COPY/COPY OF are live formula sheets this code never writes to, but they can still be read
  // mid-recalculation (a transient Google Sheets state, same class of issue as the CSV-export
  // staleness this file already works around elsewhere) — confirmed directly: a read returned
  // 1,525 rows for COPY when the destination sheet already had 3,093 rows from the prior run,
  // and blindly writing that through wiped most of the sheet's revenue and nearly all its spend.
  // Refuse to propagate a source read that's implausibly smaller than what's already published;
  // the stale-but-real existing data stays in place instead.
  // rawValues, when passed in, is refreshCampaignSnapshots' own already-fetched COPY/COPY OF read
  // — reused here instead of fetching the same sheet a second time in the same run.
  const [resolvedRawValues, prevDstValues] = await Promise.all([
    rawValues ? Promise.resolve(rawValues) : getValues(token, srcSheet, 'A2:S10000'),
    getValues(token, dstSheet, 'A2:S10000'),
  ]);
  rawValues = resolvedRawValues;
  if (prevDstValues.length > 20 && rawValues.length < prevDstValues.length * 0.15) {
    console.error(`[${which}] refusing refresh: ${srcSheet} read only ${rawValues.length} rows vs ${dstSheet}'s existing ${prevDstValues.length} — likely a mid-recalculation read, not real data loss`);
    return { dates: 0, rows: prevDstValues.length, skipped: true, computedRows: prevDstValues };
  }

  const values = rawValues.map(sanitizeRow);

  // Compares the full union of dates from both sources and replaces on any mismatch either way —
  // COPY/COPY OF's own revenue formula both under- AND over-counts vs Publisher Data ground truth
  // (confirmed: sheet-wide it was ~$3.1M/46% too high before this symmetric check existed).
  const copy = copyRevenueByDate(values);
  const pubTotals = publisher.totals[which];
  const pubCounts = publisher.counts[which];
  const pubLeads = publisher.leads[which];
  // Only ever replaces a date Publisher Data actually has leads for (pubTotals[date] > 0) — a date
  // where COPY/COPY OF has native revenue but Publisher Data has NONE at all (pubTotals[date] is
  // 0/undefined) is left untouched instead of zeroed, since there'd be nothing to replace it with.
  // Confirmed this destroyed real data: the very first invoiced week (Feb 9-15, $9,900 real
  // revenue) got wiped to $0 because Publisher Data has no matching leads for those early dates,
  // and the old code zeroed COPY's only copy of that revenue anyway with no correction to restore it.
  const datesNeedingReplacement = new Set();
  for (const date of Object.keys(pubTotals)) {
    if (!pubTotals[date]) continue;
    const revenueGap = pubTotals[date] - (copy.totals[date] || 0);
    const countGap = (pubCounts[date] || 0) - (copy.counts[date] || 0);
    if (Math.abs(revenueGap) > 1 || countGap !== 0) datesNeedingReplacement.add(date);
  }

  const zeroedValues = values.map((row) => {
    if (!datesNeedingReplacement.has(row[0])) return row;
    const fixed = [...row];
    const spend = parseMoney(row[6]);
    fixed[10] = '0';
    fixed[11] = '$0.00';
    fixed[12] = `-$${spend.toFixed(2)}`;
    return fixed;
  });

  const correctionRows = [];
  for (const date of datesNeedingReplacement) {
    const leadsForDate = pubLeads.filter((l) => l.date === date);
    for (const lead of leadsForDate) {
      const matches = importByPhone[lead.phone];
      const ad = matches?.[0]?.ad || '(unmatched - ad unknown)';
      const state = lead.state || matches?.[0]?.state || '';
      correctionRows.push([
        date, `'${lead.phone || ''}`, '', '', '$0.00', '$0.00', '$0.00', '0', '0', '0', '1',
        `$${lead.commission.toFixed(2)}`, `$${lead.commission.toFixed(2)}`, state, ad,
      ]);
    }
  }

  // One combined revenue+spend adjustment row per date reconciling this PAID period to exactly
  // what the Invoice sheet recorded — see computeRevenueAdjustments/computeSpendAdjustments. Both
  // can be positive or negative; merged into one row (not two) so profit comes out exactly right
  // even when both sides need adjusting for the same date.
  const adjustmentDates = new Set([...Object.keys(revenueAdjustments || {}), ...Object.keys(spendAdjustments || {})]);
  for (const date of adjustmentDates) {
    const revAdj = revenueAdjustments?.[date] || 0;
    const spendAdj = spendAdjustments?.[date] || 0;
    if (Math.abs(revAdj) < 1 && Math.abs(spendAdj) < 1) continue;
    const fmt = (n) => (n >= 0 ? `$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`);
    correctionRows.push([
      date, '', '', '', '$0.00', '$0.00', fmt(spendAdj), '0', '0', '0', '0',
      fmt(revAdj), fmt(revAdj - spendAdj), '', '(period reconciliation)',
    ]);
  }

  // Bryan's ad spend (Texas YT campaigns) is not ours: deducted from CA/TX ad spend and added to
  // profit, dated to each week's end date. Added after the invoice clamp so it isn't re-clamped.
  for (const [date, amount] of Object.entries(spendFill || {})) {
    correctionRows.push([
      date, '', '', '', `$${amount.toFixed(2)}`, '$0.00', `$${amount.toFixed(2)}`, '0', '0', '0', '0',
      '$0.00', `-$${amount.toFixed(2)}`, '', '(Google spend from live source)',
    ]);
  }
  if (which === 'CA') {
    for (const b of BRYAN_AD_SPEND) {
      correctionRows.push([
        b.date, '', '', '', '$0.00', '$0.00', `-$${b.amount.toFixed(2)}`, '0', '0', '0', '0',
        '$0.00', `$${b.amount.toFixed(2)}`, '', `(Bryan ad spend ${b.week})`,
      ]);
    }
  }

  const allRows = [...zeroedValues, ...correctionRows];
  // write = false (the server's live read-only serving path — see computeCorrectedCampaigns)
  // computes the exact same corrected rows but never writes them anywhere: they're served to the
  // frontend straight from memory instead, so no Google write scope is needed at all.
  if (write) {
    // Write the new data BEFORE clearing anything, and only clear the leftover tail rows after a
    // successful write — not clear-then-write. Confirmed the old order causes real data loss: this
    // sheet was found completely empty (0 rows) after a write apparently failed partway, since a
    // throw between the clear and the write leaves the sheet blank with no way to recover except a
    // manual re-run. Writing first means any mid-run failure leaves the previous (stale but real)
    // data in place instead of nothing.
    const CHUNK = 3000;
    for (let i = 0; i < allRows.length; i += CHUNK) {
      const chunk = allRows.slice(i, i + CHUNK);
      const r = await writeValues(token, dstSheet, `A${i + 2}`, chunk);
      if (r.error) throw new Error(`[${which}] write failed: ` + JSON.stringify(r.error));
    }
    // Trim whatever's left over past the new data (e.g. yesterday's write was longer than today's) —
    // only now, after the new data is already safely written.
    await clearRange(token, dstSheet, `A${allRows.length + 2}:S`);
  }
  return { dates: datesNeedingReplacement.size, rows: allRows.length, computedRows: allRows };
}

async function getRevenueFloor(token) {
  const rows = (await getValues(token, FLOOR_SHEET, 'A2:D50000')) || [];
  const floor = { CA: {}, NW: {} };
  for (const row of rows) {
    const date = row[0], vertical = row[1];
    if (!date || (vertical !== 'CA' && vertical !== 'NW')) continue;
    floor[vertical][date] = { revenue: parseMoney(row[2]), count: Number(row[3]) || 0 };
  }
  return floor;
}

async function saveRevenueFloor(token, floor) {
  const rows = [];
  for (const vertical of ['CA', 'NW']) {
    for (const date of Object.keys(floor[vertical])) {
      const f = floor[vertical][date];
      if (!f.revenue) continue;
      rows.push([date, vertical, f.revenue.toFixed(2), f.count]);
    }
  }
  for (let i = 0; i < rows.length; i += 5000) {
    await writeValues(token, FLOOR_SHEET, `A${i + 2}`, rows.slice(i, i + 5000));
  }
  await clearRange(token, FLOOR_SHEET, `A${rows.length + 2}:D50000`);
}

// Tops up publisher.totals/counts/leads for any date whose already-established floor exceeds what
// this run actually computed — protects previously-reported revenue from a later disqualification/
// reversal in Publisher Data. Adds one synthetic lead per shortfall so refreshOne's normal
// correction-row machinery writes it through like any other lead.
// Per the user: once a period is actually invoiced/PAID, a later reversal must never shrink it
// (that's what the floor top-up below is for). But the CURRENT, not-yet-invoiced period is the
// opposite — a restored/reversed lead there should show up as a real decrease, not get padded
// back up, since nothing has been billed yet and the live number should just be accurate. So the
// floor is only applied to dates that fall inside an already-PAID period; everything else
// (the in-progress week, and any date past the last invoiced period) is left alone.
function applyRevenueFloor(publisher, floor, paidPeriods) {
  const isPaidDate = (dateKey) => {
    const t = dateKeyToTuple(dateKey);
    if (!t) return false;
    return paidPeriods.some((p) => dateLte(p.start, t) && dateLte(t, p.end));
  };
  for (const vertical of ['CA', 'NW']) {
    for (const date of Object.keys(floor[vertical])) {
      if (!isPaidDate(date)) continue;
      const flooredRevenue = floor[vertical][date].revenue;
      const currentLeads = publisher.leads[vertical].filter((l) => l.date === date);
      const currentSum = currentLeads.reduce((s, l) => s + l.commission, 0);
      if (flooredRevenue > currentSum + 0.01) {
        const gap = flooredRevenue - currentSum;
        publisher.leads[vertical].push({ date, state: '', phone: null, commission: gap, floorTopUp: true });
        publisher.totals[vertical][date] = currentSum + gap;
        publisher.counts[vertical][date] = Math.max(publisher.counts[vertical][date] || 0, currentLeads.length + 1);
      }
    }
  }
}

// The Invoice sheet's per-period Invoice Amount is the one number that can never decay — it's
// what actually got billed and paid, unlike Publisher Data which keeps reflecting live portal
// status. Confirmed directly: summed across every period Feb 9 - Sep 6, it's $1,807,448.20,
// matching the user's own reconciliation exactly, while the live dashboard for the same span had
// drifted down to $1,750,649.25 — a $56,798.95 gap purely from reversals accumulated before this
// floor mechanism existed to catch them. Used below to top up any period whose live total has
// fallen short of what was actually invoiced for it.
async function getInvoicePeriods(token) {
  const rows = (await getValues(token, INVOICE_SHEET, 'A2:L60', INVOICE_DOC)) || [];
  const periods = [];
  for (const row of rows) {
    if (!row[0]) continue;
    if (String(row[0]).trim() === 'Start Date') break; // stacked per-vertical sub-tables below the main one repeat the same periods
    const start = parseAnyDate(row[0]);
    const end = parseAnyDate(row[1]);
    // "Late QMVA Invoice" (col E) is a separate bonus-revenue column on top of "Invoice Amount" —
    // confirmed the sheet's own Profit column always equals Invoice Amount + Late QMVA Invoice -
    // Ad Spent exactly (e.g. July 1-5: $145,184 + $21,625 - $105,449.92 = $61,359.08). Missing this
    // column understated every period with a late-QMVA line by exactly that amount.
    const lateQmvaInvoice = parseMoney(row[4]);
    const invoiceAmount = parseMoney(row[3]) + lateQmvaInvoice;
    const invoiceAdSpend = parseMoney(row[7]);
    const status = String(row[9] || '').trim().toUpperCase();
    if (start && end && invoiceAmount) periods.push({ start, end, invoiceAmount, invoiceBase: parseMoney(row[3]), invoiceAdSpend, status, lateQmvaInvoice });
  }
  return periods;
}

function dateKeyToTuple(dateKey) {
  const m = String(dateKey).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return [Number(m[3]), Number(m[1]), Number(m[2])];
}

// Once a period is PAID, the Invoice sheet's amount is a FLOOR, not an exact clamp — top up if
// live revenue has fallen short (a reversal since it was invoiced), but never pull it back down
// when live revenue is now HIGHER than what's on the invoice. That "higher" case is exactly a
// brand-new Late QMVA the invoice sheet hasn't been updated for yet (its Late QMVA Invoice column
// is a manual entry that lags detection) — pulling the period back down to the old invoice number
// would silently erase that new late QMVA's profit instead of letting it add on top. Confirmed
// this was happening: 2 new late QMVAs landing on Aug 29 (inside the already-PAID Aug 24-30
// period) were being fully absorbed by a previous two-way-clamp version of this function, so the
// period's profit never moved even though real new revenue had shown up. Per the user: once paid,
// the only change that should ever apply is a late QMVA ADDING to profit, never a reversal
// removing it — so this only ever adds, matching applyRevenueFloor's same one-directional rule for
// not-yet-paid periods.
async function getPendingLateLeads(token) {
  const rows = (await getValues(token, 'Late QMVAs (Claude)', 'A2:K3000')) || [];
  const out = [];
  for (const row of rows) {
    if (row[7]) continue; // already in an invoice's Late QMVA batch
    const date = normPublisherDate(String(row[1] || '').replace(/^'/, ''));
    const commission = parseMoney(row[6]);
    if (date && commission && commission <= MAX_LEAD_COMMISSION) out.push({ date, commission });
  }
  return out;
}

function computeRevenueAdjustments(publisher, paidPeriods, lateQmvaBatches, effectiveTotals) {
  const adjustments = { CA: {}, NW: {} };
  const add = (vertical, date, amount) => {
    adjustments[vertical][date] = (adjustments[vertical][date] || 0) + amount;
  };
  // The invoice is the final word for a PAID period, in both directions: target = base Invoice
  // Amount + every late-QMVA lead dated inside the period (already invoiced in any later batch, or
  // detected but not yet invoiced). Late-QMVA revenue lives on each lead's own date, never lumped
  // on the invoice's period.
  // Only batches billed as a period's separate "Late QMVA Invoice" amount are extra revenue; other
  // batches on the tab are already inside their period's base Invoice Amount.
  const billedTotals = paidPeriods.map((p) => p.lateQmvaInvoice).filter((v) => v > 0);
  const invoicedLate = Object.values(lateQmvaBatches || {})
    .filter((b) => billedTotals.some((v) => Math.abs(b.total - v) < 1))
    .flatMap((b) => b.leads);
  const allLate = invoicedLate;
  for (const period of paidPeriods) {
    let caSum = 0, nwSum = 0;
    for (const vertical of ['CA', 'NW']) {
      for (const date of Object.keys(effectiveTotals[vertical])) {
        const t = dateKeyToTuple(date);
        if (!t || !dateLte(period.start, t) || !dateLte(t, period.end)) continue;
        if (vertical === 'CA') caSum += effectiveTotals.CA[date];
        else nwSum += effectiveTotals.NW[date];
      }
    }
    const currentTotal = caSum + nwSum;
    const lateInPeriod = allLate.filter((l) => {
      const t = dateKeyToTuple(l.date);
      return t && dateLte(period.start, t) && dateLte(t, period.end);
    });
    const lateSum = lateInPeriod.reduce((s, l) => s + l.commission, 0);
    // A billed late amount with no itemized batch on the Late QMVAs tab stays on the period end date.
    const unitemizedLate = period.lateQmvaInvoice > 0 && !Object.values(lateQmvaBatches || {}).some((b) => Math.abs(b.total - period.lateQmvaInvoice) < 1) ? period.lateQmvaInvoice : 0;
    const diff = period.invoiceBase + unitemizedLate + lateSum - currentTotal;
    if (Math.abs(diff) < 1) continue;
    const caShare = currentTotal > 0 ? caSum / currentTotal : 0.5;
    const endKey = `${period.end[1]}/${period.end[2]}/${period.end[0]}`;

    let onLeadDates = 0;
    if (diff > 0 && lateSum > 0) {
      onLeadDates = Math.min(diff, lateSum);
      for (const lead of lateInPeriod) {
        const share = onLeadDates * (lead.commission / lateSum);
        add('CA', lead.date, share * caShare);
        add('NW', lead.date, share * (1 - caShare));
      }
    }
    const rest = diff - onLeadDates;
    if (Math.abs(rest) >= 0.005) {
      add('CA', endKey, rest * caShare);
      add('NW', endKey, rest * (1 - caShare));
    }
  }
  return adjustments;
}

async function refreshCampaignSnapshots(token, opts = {}) {
  const write = opts.write !== false;
  if (write) await ensureSheetExists(token, FLOOR_SHEET, ['Date', 'Vertical', 'Revenue', 'Count'], 20000);
  const [qmvaPayouts, importByPhone, floor, invoicePeriods, lateQmvaBatches, rtpp] = await Promise.all([
    getQmvaPayouts(token), getImportLeadsByPhone(token), write ? getRevenueFloor(token) : Promise.resolve({ CA: {}, NW: {} }), getInvoicePeriods(token),
    getInvoiceLateQmvaBatches(token), getRealTimePublisherPortal(token),
  ]);
  // Every read below is independent of every other one — publisher (needs only
  // qmvaPayouts/rtpp, already resolved above), COPY/COPY OF's own rows (read ONCE here and reused
  // for revenue, youtube spend, AND total spend below, and passed into refreshOne instead of it
  // re-reading the same sheet a third time), and the live Google spend fallback. Running them
  // together instead of one after another was most of a sync run's wall-clock time once the
  // shared rate limiter (rate_limit.js) made every redundant read directly cost queue time.
  const [publisher, nwCopyValues, caCopyValues, nwLive, caLive] = await Promise.all([
    getPublisherLeads(token, qmvaPayouts, rtpp),
    getValues(token, 'COPY', 'A2:S10000'),
    getValues(token, 'COPY OF', 'A2:S10000'),
    getLiveGoogleSpendByDate(token, (c) => c.includes('PPL') && c.includes('TEXAS')),
    getLiveGoogleSpendByDate(token, (c) => c.includes('LOUDRCA')),
  ]);
  // The date-level floor is now DISABLED for PAID periods — computeRevenueAdjustments below
  // already guarantees the period's TOTAL matches the invoice exactly, distributed across the
  // invoice's own real per-lead dates (see its comment), and does so fresh from live data every
  // run instead of carrying forward a stored "high-water mark". The floor's stored mark turned out
  // to accumulate stale corrections from before that mechanism existed and never self-corrects
  // (only ever rises) — confirmed live: NW 3/15/2026's floor had calcified at $65,580 (vs. a normal
  // per-day range of a few thousand) from early buggy runs, and every sync since kept re-injecting
  // it as a single fake $65,580 "lead" with no phone. A not-yet-invoiced week was never
  // floor-protected either way, so this leaves nothing relying on the floor mechanism.
  const paidPeriods = invoicePeriods.filter((p) => p.status === 'PAID');

  const nwSanitized = nwCopyValues.map(sanitizeRow);
  const caSanitized = caCopyValues.map(sanitizeRow);
  const copyTotalsByVertical = {
    NW: copyRevenueByDate(nwSanitized),
    CA: copyRevenueByDate(caSanitized),
  };
  const effectiveTotals = computeEffectiveTotals(publisher, copyTotalsByVertical);

  const revenueAdjustments = computeRevenueAdjustments(publisher, paidPeriods, lateQmvaBatches, effectiveTotals);

  const nwSpendByDate = spendByDateFromRows(nwSanitized);
  const caSpendByDate = spendByDateFromRows(caSanitized);
  const nwYt = youtubeSpendByDateFromRows(nwSanitized);
  const caYt = youtubeSpendByDateFromRows(caSanitized);
  const fillMissing = (live, ytByDate, spendByDate) => {
    const fill = {};
    for (const [date, amount] of Object.entries(live)) {
      if (amount >= 1 && (ytByDate[date] || 0) < 1) {
        fill[date] = amount;
        spendByDate[date] = (spendByDate[date] || 0) + amount;
      }
    }
    return fill;
  };
  const nwSpendFill = fillMissing(nwLive, nwYt, nwSpendByDate);
  const caSpendFill = fillMissing(caLive, caYt, caSpendByDate);
  const spendAdjustments = computeSpendAdjustments({ NW: nwSpendByDate, CA: caSpendByDate }, paidPeriods, { NW: nwLive, CA: caLive });

  // NW and CA are fully independent from here — same rate limiter, so running them together
  // doesn't cost extra quota, just wall-clock time.
  const [nw, ca] = await Promise.all([
    refreshOne(token, 'NW', publisher, importByPhone, revenueAdjustments.NW, spendAdjustments.NW, nwSpendFill, write, nwCopyValues),
    refreshOne(token, 'CA', publisher, importByPhone, revenueAdjustments.CA, spendAdjustments.CA, caSpendFill, write, caCopyValues),
  ]);

  // Raise the floor to whatever was actually established this run (never lower it) — next run's
  // reversal, if any, will be caught and topped back up against this new high-water mark. Only
  // recorded for dates already inside a PAID period; a not-yet-invoiced date has no locked number
  // yet, so there's nothing to protect and no floor should be building up for it.
  if (write) {
    for (const vertical of ['CA', 'NW']) {
      for (const date of Object.keys(publisher.totals[vertical])) {
        const t = dateKeyToTuple(date);
        if (!t || !paidPeriods.some((p) => dateLte(p.start, t) && dateLte(t, p.end))) continue;
        const revenue = publisher.totals[vertical][date];
        if (!revenue) continue;
        const prev = floor[vertical][date];
        if (!prev || revenue > prev.revenue) {
          floor[vertical][date] = { revenue, count: publisher.counts[vertical][date] || 0 };
        }
      }
    }
    await saveRevenueFloor(token, floor);
  }

  return { nw, ca };
}

// Computes the exact same corrected NW/CA campaign rows refreshCampaignSnapshots writes to the
// sheet, but purely in memory — no write scope needed at all. This is what lets the dashboard
// stay live on a read-only Google credential: the server calls this on its own interval and
// serves the result straight from memory (see server.js's runLiveCampaigns), instead of relying
// on a write-capable sync (dashboard_sync's runSync, run manually from a laptop) to have already
// pushed the corrected numbers into the sheet for it to read back.
async function computeCorrectedCampaigns(getAccessToken) {
  const token = await getAccessToken();
  const { nw, ca } = await refreshCampaignSnapshots(token, { write: false });
  return { nw: nw.computedRows, ca: ca.computedRows };
}

// ---------- track_late_and_restored.js port ----------

function parseAnyDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  let m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    if (mi >= 0) return [Number(m[3]), mi + 1, Number(m[2])];
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return [Number(m[3]), Number(m[1]), Number(m[2])];
  m = s.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (m) return [2000 + Number(m[3]), Number(m[1]), Number(m[2])];
  return null;
}

function dateLte(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] <= b[2];
}

async function getInvoicedPeriods(token) {
  const rows = (await getValues(token, INVOICE_SHEET, 'A1:J40', INVOICE_DOC)) || [];
  const periods = [];
  for (const row of rows) {
    const status = String(row[9] || '').trim().toUpperCase();
    if (status !== 'PAID') continue;
    const start = parseAnyDate(row[0]);
    const end = parseAnyDate(row[1]);
    if (start && end) periods.push({ start, end });
  }
  return periods;
}

// The invoice sheet's own "Late QMVAs" tab is the authoritative record of which late-converting
// leads have actually been batched into an invoiced period's Late QMVA Invoice figure (e.g. the
// $52,432 added for Aug 31 - Sep 6) — keyed by phone, value is that batch's own "Invoice Time
// Period" label. Used to stop listing a lead as "still needs to be paid" once it's actually been
// paid; confirmed 53 of 63 "No Invoice Date" entries here were already sitting in that $52,432
// batch with no way for the dashboard to know it.
async function getInvoiceLateQmvaPhones(token) {
  const rows = (await getValues(token, 'Late QMVAs', 'A5:T3000', INVOICE_DOC)) || [];
  const byPhone = {};
  for (const row of rows) {
    const phone = normPhone(row[9]) || normPhone(row[10]);
    const period = row[3];
    if (!phone || !period) continue;
    byPhone[phone] = period;
  }
  return byPhone;
}

function isInvoiced(dateRaw, periods) {
  const d = parseAnyDate(dateRaw);
  if (!d) return false;
  return periods.some((p) => dateLte(p.start, d) && dateLte(d, p.end));
}

async function ensureSheetExists(token, title, headerRow, targetRowCount = 50000) {
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${MAIN_DOC}?fields=sheets.properties`;
  const metaRes = await fetch(metaUrl, { headers: { Authorization: 'Bearer ' + token } });
  const meta = await metaRes.json();
  const sheet = meta.sheets.find((s) => s.properties.title === title);
  if (sheet) {
    const rowCount = sheet.properties.gridProperties.rowCount;
    if (rowCount < targetRowCount * 0.9) {
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${MAIN_DOC}:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            updateSheetProperties: {
              properties: { sheetId: sheet.properties.sheetId, gridProperties: { rowCount: targetRowCount, columnCount: sheet.properties.gridProperties.columnCount } },
              fields: 'gridProperties.rowCount',
            },
          }],
        }),
      });
    }
    return;
  }
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${MAIN_DOC}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  await writeValues(token, title, 'A1', [headerRow]);
}

function todayStamp() {
  const [m, d, y] = pacificDateKey(0).split('/');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

async function trackLateAndRestored(token) {
  const LEAD_HEADER = ['Detected On', 'Original Date', 'Call ID', 'Name', 'Phone', 'Campaign', 'Commission', 'Invoice Period', 'Was $0 As Of', 'Converted By', 'Reason'];
  // All independent of each other — no read here depends on another's result — except
  // snapshotRows, which must wait for its own ensureSheetExists (only matters on a truly first
  // run, where the sheet doesn't exist yet).
  const [snapshotRowsRaw, , , invoicedPeriods, invoiceLateQmvaPhones, current] = await Promise.all([
    ensureSheetExists(token, SNAPSHOT_SHEET, ['Call ID', 'Last Commission', 'Ever Nonzero', 'Last Checked', 'Last Seen At $0'])
      .then(() => getValues(token, SNAPSHOT_SHEET, 'A2:E200000')),
    ensureSheetExists(token, LATE_SHEET, LEAD_HEADER, 3000),
    ensureSheetExists(token, RESTORED_SHEET, LEAD_HEADER, 3000),
    getInvoicedPeriods(token),
    getInvoiceLateQmvaPhones(token),
    getValues(token, 'Publisher Data CA/TX', 'A2:Q30000', PUBLISHER_DOC),
  ]);
  const snapshotRows = snapshotRowsRaw || [];
  const snapshot = {};
  for (const row of snapshotRows) {
    const [callId, lastCommission, everNonzero, , lastZeroDate] = row;
    if (!callId) continue;
    snapshot[callId] = {
      lastCommission: parseMoney(lastCommission),
      everNonzero: everNonzero === 'TRUE' || everNonzero === true,
      lastZeroDate: lastZeroDate || '',
    };
  }
  const isFirstRun = snapshotRows.length === 0;

  const byCallId = new Map();
  for (const row of current) {
    const callId = row[2];
    if (!callId) continue;
    byCallId.set(callId, row);
  }

  const today = todayStamp();
  const lateRows = [];
  const restoredRows = [];
  const newSnapshot = {};

  for (const row of byCallId.values()) {
    const [date, , callId, , , phone, , commissionRaw, , , , first, last, , , , campaign] = row;
    if (campaign === 'Loudr_NWA' || campaign === 'Loudr NWA - IB' || campaign === 'LoudrDupe') continue;
    // Same absurd-commission guard as getPublisherLeads/getPendingLateLeads — the publisher export
    // has shipped values like $238,680 for a real $2,340 lead, which must not get logged as a real
    // late-QMVA conversion.
    const commissionRawParsed = parseMoney(commissionRaw);
    const commission = commissionRawParsed > MAX_LEAD_COMMISSION ? 0 : commissionRawParsed;
    const prev = snapshot[callId];
    const name = `${first || ''} ${last || ''}`.trim();

    if (!isFirstRun && prev && prev.lastCommission === 0 && commission > 0) {
      const zeroDate = `'${prev.lastZeroDate || date}`;
      const invoicePeriod = (phone && invoiceLateQmvaPhones[normPhone(phone)]) || '';
      const entry = [`'${today}`, `'${date}`, callId, name, phone || '', campaign || '', `$${commission.toFixed(2)}`, invoicePeriod, zeroDate, `'${today}`];
      if (isInvoiced(date, invoicedPeriods)) {
        lateRows.push([...entry, prev.everNonzero ? 'restored after invoicing' : 'first conversion after invoicing']);
      } else if (prev.everNonzero) {
        restoredRows.push([...entry, 'dropped to $0, now restored']);
      }
    }

    newSnapshot[callId] = {
      lastCommission: commission,
      everNonzero: (prev?.everNonzero || false) || commission > 0,
      lastZeroDate: commission === 0 ? today : (prev?.lastZeroDate || ''),
    };
  }

  // Backfill Invoice Period on EXISTING late-QMVA rows too, not just newly-detected ones — a lead
  // detected weeks ago with no Invoice Period yet can get batched into an invoice's Late QMVA
  // Invoice figure later, and nothing else ever revisits that old row to mark it paid. Confirmed:
  // 53 of the 63 "No Invoice Date" rows here were already sitting in the $52,432 Aug 31 - Sep 6
  // batch. Rewrite the whole sheet (write-before-clear, same reasoning as refreshOne).
  const existingLateRows = (await getValues(token, LATE_SHEET, 'A2:K3000')) || [];
  const backfilledLateRows = existingLateRows.map((row) => {
    if (row[7]) return row; // Invoice Period already set
    const phone = normPhone(row[4]);
    const period = phone && invoiceLateQmvaPhones[phone];
    if (!period) return row;
    const fixed = [...row];
    fixed[7] = period;
    return fixed;
  });
  const allLateRows = [...backfilledLateRows, ...lateRows];
  if (allLateRows.length) {
    const CHUNK = 3000;
    for (let i = 0; i < allLateRows.length; i += CHUNK) {
      await writeValues(token, LATE_SHEET, `A${i + 2}`, allLateRows.slice(i, i + CHUNK));
    }
    await clearRange(token, LATE_SHEET, `A${allLateRows.length + 2}:K3000`);
  }
  if (restoredRows.length) await appendValues(token, RESTORED_SHEET, restoredRows);

  // Write first, clear the leftover tail after — see refreshOne's comment for why: a throw
  // between clear and write leaves the sheet empty with no way to recover but a manual re-run.
  const snapshotOut = Object.entries(newSnapshot).map(([callId, s]) => [callId, s.lastCommission.toFixed(2), s.everNonzero ? 'TRUE' : 'FALSE', `'${today}`, s.lastZeroDate ? `'${s.lastZeroDate}` : '']);
  const CHUNK = 5000;
  for (let i = 0; i < snapshotOut.length; i += CHUNK) {
    await writeValues(token, SNAPSHOT_SHEET, `A${i + 2}`, snapshotOut.slice(i, i + CHUNK));
  }
  await clearRange(token, SNAPSHOT_SHEET, `A${snapshotOut.length + 2}:E200000`);
  return { late: lateRows.length, restored: restoredRows.length, tracked: snapshotOut.length };
}

// getAccessToken: async () => string — a write-scoped (spreadsheets, not spreadsheets.readonly)
// OAuth access token. onDashboardRefresh: optional async () => void, called after a successful
// sync so the caller can re-poll its own in-memory cache immediately instead of waiting.
async function runDashboardSync(getAccessToken, onDashboardRefresh) {
  const token = await getAccessToken();
  // Independent of each other (trackLateAndRestored's own writes target the Late QMVAs/Restored/
  // snapshot tracking sheets, not the NW/CA PPL CAMPAIGN sheets refreshCampaignSnapshots writes)
  // — run together instead of one after the other, same reasoning as everywhere else in this file.
  const [snapshot, tracking] = await Promise.all([
    refreshCampaignSnapshots(token),
    trackLateAndRestored(token),
  ]);
  if (onDashboardRefresh) await onDashboardRefresh();
  return { snapshot, tracking };
}

// Monday of the week `[y, m, d]` falls in, as a "M/D/YYYY" key — the bucket unit for the
// spend-vs-late-QMVA correlation below (matches the dashboard's own Mon-Sun week presets).
function mondayKeyOf(dateKey) {
  const t = dateKeyToTuple(dateKey);
  if (!t) return null;
  const d = new Date(t[0], t[1] - 1, t[2]);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - diffToMonday);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// Per the user (Brandon's ClickUp task, 2026-08-21): does spending more actually buy
// proportionally more late-arriving QMVAs, or does the late-QMVA share of revenue stay roughly
// flat regardless of spend? Buckets both real ad spend and late-QMVA revenue by the WEEK THE LEAD
// ITSELF CAME IN (its own original date, not the later week it got invoiced in — see
// getInvoiceLateQmvaBatches'/getPendingLateLeads' date fields), so each week's late-QMVA % is
// answerable against that same week's spend, not a mix of weeks.
async function computeLateQmvaCorrelation(getAccessToken) {
  const token = await getAccessToken();
  const [lateQmvaBatches, pendingLate, nwCopyValues, caCopyValues, nwLive, caLive] = await Promise.all([
    getInvoiceLateQmvaBatches(token), getPendingLateLeads(token),
    getValues(token, 'COPY', 'A2:S10000'), getValues(token, 'COPY OF', 'A2:S10000'),
    getLiveGoogleSpendByDate(token, (c) => c.includes('PPL') && c.includes('TEXAS')),
    getLiveGoogleSpendByDate(token, (c) => c.includes('LOUDRCA')),
  ]);
  // COPY/COPY OF read once and reused for both spend figures, not fetched twice — same reasoning
  // as refreshCampaignSnapshots.
  const nwSpendByDate = spendByDateFromRows(nwCopyValues);
  const caSpendByDate = spendByDateFromRows(caCopyValues);
  const nwYt = youtubeSpendByDateFromRows(nwCopyValues);
  const caYt = youtubeSpendByDateFromRows(caCopyValues);
  // Same "fill missing days from the live source" logic refreshCampaignSnapshots uses for the
  // dashboard's own spend figures, so this view's spend numbers never disagree with the dashboard's.
  for (const [live, ytByDate, spendByDate] of [[nwLive, nwYt, nwSpendByDate], [caLive, caYt, caSpendByDate]]) {
    for (const [date, amount] of Object.entries(live)) {
      if (amount >= 1 && (ytByDate[date] || 0) < 1) spendByDate[date] = (spendByDate[date] || 0) + amount;
    }
  }

  const weeks = {};
  const bucket = (key) => (weeks[key] ||= { weekStart: key, spend: 0, lateRevenue: 0, lateCount: 0 });
  for (const date of new Set([...Object.keys(nwSpendByDate), ...Object.keys(caSpendByDate)])) {
    const key = mondayKeyOf(date);
    if (!key) continue;
    bucket(key).spend += (nwSpendByDate[date] || 0) + (caSpendByDate[date] || 0);
  }
  const allLate = [...Object.values(lateQmvaBatches || {}).flatMap((b) => b.leads), ...(pendingLate || [])];
  for (const lead of allLate) {
    const key = mondayKeyOf(lead.date);
    if (!key) continue;
    const b = bucket(key);
    b.lateRevenue += lead.commission;
    b.lateCount += 1;
  }

  return Object.values(weeks)
    .filter((w) => w.spend > 0 || w.lateRevenue > 0)
    .map((w) => ({ ...w, lateRevenuePctOfSpend: w.spend > 0 ? (w.lateRevenue / w.spend) * 100 : null }))
    .sort((a, b) => {
      const ta = dateKeyToTuple(a.weekStart), tb = dateKeyToTuple(b.weekStart);
      return ta[0] - tb[0] || ta[1] - tb[1] || ta[2] - tb[2];
    });
}

// Total/Accepted lead counts per day, combined CA+NW — from the leads-import tabs' own
// "Response Status" column (ACCEPTED / ACCEPTED - BRYAN / DUPLICATED / etc.), per the user:
// "Accepted" lives in the leads import tabs, not Publisher Data CA/TX.
async function getLeadsImportCounts(token) {
  const counts = { CA: {}, NW: {} };
  for (const [sheet, vertical] of [['Walker CA Leads Import', 'CA'], ['Walker NW Leads Import', 'NW']]) {
    const rows = (await getValues(token, sheet, 'A2:X60000', LIVE_SOURCE_DOC)) || [];
    for (const row of rows) {
      const date = normPublisherDate(row[0]);
      if (!date) continue;
      const status = String(row[11] || '').trim();
      const bucket = (counts[vertical][date] ||= { total: 0, accepted: 0 });
      bucket.total += 1;
      if (/^ACCEPTED/i.test(status)) bucket.accepted += 1;
    }
  }
  return counts;
}

// Law Type Broad (Publisher Data CA/TX, keyed by phone+date) and per-phone Recency (DATABASE PPL
// CA/NW) — only used by the campaign-trends view below, kept separate from getPublisherLeads' own
// revenue logic so this never risks touching how revenue/QMVA counts are computed anywhere else.
// Keyed by phone+date rather than phone alone: a repeat-caller phone can have a real MVA lead on
// one date and a real non-MVA lead (Premise, WC, etc.) on another — keying by phone alone let
// whichever row the sheet happened to return last for that phone silently overwrite the other
// date's law type, misclassifying that other date's QMVA count.
async function getLeadLookups(token) {
  const lawTypeByDateKey = {};
  for (const row of (await getValues(token, 'Publisher Data CA/TX', 'A2:V40000', PUBLISHER_DOC)) || []) {
    const phone = normPhone(row[5]) || normPhone(row[6]);
    const date = normPublisherDate(row[0]);
    if (phone && date && row[9]) lawTypeByDateKey[`${phone}|${date}`] = row[9];
  }
  const recencyByPhone = {};
  for (const [sheet, phoneCol, recencyCol] of [['DATABASE PPL CA', 18, 10], ['DATABASE PPL NW', 14, 16]]) {
    for (const row of (await getValues(token, sheet, 'A2:T20000', QMVA_PAYOUT_DOC)) || []) {
      const phone = normPhone(row[phoneCol]);
      const recency = Number(row[recencyCol]);
      if (phone && Number.isFinite(recency)) recencyByPhone[phone] = recency;
    }
  }
  return { lawTypeByDateKey, recencyByPhone };
}

// Daily campaign-trends table (Total Spend/Leads/CPL/Accepted/QMVA/NON MVA/Recency/Payout/Profit/
// Revenue per QMVA, combined CA+NW) — per the user's ClickUp task "Create Dashboard or graphics to
// identify campaign trends": help the media buying team see performance patterns and cost
// inflections day to day. Read-only, same pattern as computeLateQmvaCorrelation.
async function computeCampaignTrends(getAccessToken) {
  const token = await getAccessToken();
  const [qmvaPayouts, rtpp, leadCounts, lookups, nwCopyValues, caCopyValues, nwLive, caLive] = await Promise.all([
    getQmvaPayouts(token), getRealTimePublisherPortal(token), getLeadsImportCounts(token), getLeadLookups(token),
    getValues(token, 'COPY', 'A2:S10000'), getValues(token, 'COPY OF', 'A2:S10000'),
    getLiveGoogleSpendByDate(token, (c) => c.includes('PPL') && c.includes('TEXAS')),
    getLiveGoogleSpendByDate(token, (c) => c.includes('LOUDRCA')),
  ]);
  const publisher = await getPublisherLeads(token, qmvaPayouts, rtpp);
  const { lawTypeByDateKey, recencyByPhone } = lookups;

  // COPY/COPY OF read once and reused for both spend figures, not fetched twice.
  const nwSpendByDate = spendByDateFromRows(nwCopyValues);
  const caSpendByDate = spendByDateFromRows(caCopyValues);
  const nwYt = youtubeSpendByDateFromRows(nwCopyValues);
  const caYt = youtubeSpendByDateFromRows(caCopyValues);
  for (const [live, ytByDate, spendByDate] of [[nwLive, nwYt, nwSpendByDate], [caLive, caYt, caSpendByDate]]) {
    for (const [date, amount] of Object.entries(live)) {
      if (amount >= 1 && (ytByDate[date] || 0) < 1) spendByDate[date] = (spendByDate[date] || 0) + amount;
    }
  }

  // Bucketed per date AND per vertical (CA/NW) so the frontend can filter to one vertical or show
  // both combined without a second round trip. qmvaCount only ever counts a lead whose looked-up
  // Law Type (Broad) is literally "MVA" — every other lead, including one with no law-type match
  // at all, lands in nonMvaCount instead. Per the user: "make sure it counts only the MVA for
  // QMVA and the rest are non mva for the LAW TYPE BROAD" — no default-to-MVA fallback for an
  // unmatched phone, unlike the prior version of this function.
  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const spendByDateByVertical = { NW: nwSpendByDate, CA: caSpendByDate };
  const days = {};
  const bucket = (key, vertical) => {
    const d = (days[key] ||= { date: key, CA: null, NW: null });
    return (d[vertical] ||= {
      spend: 0, totalLeads: 0, acceptedLeads: 0, qmvaCount: 0, nonMvaCount: 0, payout: 0,
      recencyValues: [],
    });
  };
  for (const vertical of ['CA', 'NW']) {
    for (const [date, spend] of Object.entries(spendByDateByVertical[vertical])) {
      bucket(date, vertical).spend += spend;
    }
    for (const [date, c] of Object.entries(leadCounts[vertical] || {})) {
      const b = bucket(date, vertical);
      b.totalLeads += c.total;
      b.acceptedLeads += c.accepted;
    }
    for (const lead of publisher.leads[vertical]) {
      const b = bucket(lead.date, vertical);
      const lawType = lead.phone && lawTypeByDateKey[`${lead.phone}|${lead.date}`];
      // A known, non-MVA law type always counts as non-MVA. No match at all means Publisher Data
      // hasn't caught up to this lead's own date yet (it trails live data by about a day — same
      // lag documented on getPublisherLeads/getRealTimePublisherPortal) — there's nothing there to
      // say it's anything other than MVA, so it still defaults to qmvaCount rather than being
      // misclassified as non-MVA just because the lookup hasn't arrived yet.
      if (lawType && lawType.trim().toUpperCase() !== 'MVA') b.nonMvaCount += 1;
      else b.qmvaCount += 1;
      b.payout += lead.commission;
      const recency = lead.phone && recencyByPhone[lead.phone];
      if (Number.isFinite(recency)) b.recencyValues.push(recency);
    }
  }

  const metrics = (b) => ({
    spend: b.spend,
    totalLeads: b.totalLeads,
    cpl: b.totalLeads > 0 ? b.spend / b.totalLeads : null,
    acceptedLeads: b.acceptedLeads,
    qmvaCount: b.qmvaCount,
    nonMvaCount: b.nonMvaCount,
    costPerAcceptedLead: b.acceptedLeads > 0 ? b.spend / b.acceptedLeads : null,
    acceptedLeadsPct: b.totalLeads > 0 ? (b.acceptedLeads / b.totalLeads) * 100 : null,
    conversionRate: b.acceptedLeads > 0 ? (b.qmvaCount / b.acceptedLeads) * 100 : null,
    recency: median(b.recencyValues),
    payout: b.payout,
    profit: b.payout - b.spend,
    revenuePerQmva: b.qmvaCount > 0 ? b.payout / b.qmvaCount : null,
  });
  const empty = { spend: 0, totalLeads: 0, acceptedLeads: 0, qmvaCount: 0, nonMvaCount: 0, payout: 0, recencyValues: [] };
  const combine = (a, b) => ({
    spend: a.spend + b.spend,
    totalLeads: a.totalLeads + b.totalLeads,
    acceptedLeads: a.acceptedLeads + b.acceptedLeads,
    qmvaCount: a.qmvaCount + b.qmvaCount,
    nonMvaCount: a.nonMvaCount + b.nonMvaCount,
    payout: a.payout + b.payout,
    recencyValues: [...a.recencyValues, ...b.recencyValues],
  });

  return Object.values(days)
    .map((d) => {
      const ca = d.CA || empty, nw = d.NW || empty;
      return { date: d.date, CA: metrics(ca), NW: metrics(nw), combined: metrics(combine(ca, nw)) };
    })
    .filter((d) => d.combined.spend > 0 || d.combined.totalLeads > 0)
    .sort((a, b) => {
      const ta = dateKeyToTuple(a.date), tb = dateKeyToTuple(b.date);
      return ta[0] - tb[0] || ta[1] - tb[1] || ta[2] - tb[2];
    });
}

module.exports = { runDashboardSync, computeCorrectedCampaigns, computeLateQmvaCorrelation, computeCampaignTrends };

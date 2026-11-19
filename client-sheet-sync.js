// "View in Spreadsheet" for Bryan, Ruy, KM and B2B — a live, formatted Google Sheet per dashboard,
// rewritten every few minutes from the same data the dashboard reads (same rules as each page's
// KPI tiles: see bryan-public/ruy-public/km-public/b2b-public app.js). Each spreadsheet gets:
//   Overview  — the headline numbers for This Month, Last Month and All Time, color-coded
//   Monthly   — one row per month plus a trend chart
//   Leads     — every lead (or case) with color-coded status and a filter row
//   Ads       — B2B only: each ad's leads, qualified leads and spend this month
// Formatting (colors, widths, charts, conditional rules) is laid down once per server start and is
// idempotent — old charts/rules are removed first, so restarts never stack duplicates.
const { writeSheetTab, batchUpdate, getSpreadsheet } = require('./sheet-writer');

const SYNC_INTERVAL_MS = 5 * 60 * 1000;

// ---------- shared helpers ----------
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => (Math.round(n * 10) / 10) + '%';
const dash = '—';
const r2 = (n) => Math.round(n * 100) / 100;
function pacificToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
function monthKeys() {
  const today = pacificToday();
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const key = (yy, mm) => yy + '-' + String(mm).padStart(2, '0');
  return { thisMonth: key(y, m), lastMonth: m === 1 ? key(y - 1, 12) : key(y, m - 1) };
}
const monthLabel = (k) => new Date(k + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const monthsBetween = (first, last) => {
  const out = [];
  let [y, m] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) { out.push(y + '-' + String(m).padStart(2, '0')); m++; if (m > 12) { m = 1; y++; } }
  return out;
};
const updatedStamp = () => 'Last updated ' + new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' }) + ' PT · refreshes automatically every 5 minutes';

// Shared-campaign ad spend (Bryan/Ruy): each lead is charged its campaign-day's spend ÷ every lead
// that campaign produced that day — same as dailyDeduction() in bryan-public/ruy-public app.js.
function sharedDeduction(leads, walker, skip) {
  const sent = new Map();
  for (const l of leads) {
    const o = l.origin;
    if (!o || !o.campaignId || !l.createdDate || (skip && skip(l))) continue;
    const key = o.campaignId + '|' + (o.walkerDate || l.createdDate);
    sent.set(key, (sent.get(key) || 0) + 1);
  }
  let total = 0;
  for (const [key, n] of sent) {
    const [campaignId, date] = key.split('|');
    const spend = walker.spendDaily.filter((r) => r.campaignId === campaignId && r.date === date).reduce((a, r) => a + r.spend, 0);
    const dayLeads = walker.leadsDaily.filter((r) => r.campaignId === campaignId && r.date === date).reduce((a, r) => a + (r.leads || 0), 0);
    const all = Math.max(dayLeads, n);
    total += all > 0 ? n * (spend / all) : 0;
  }
  return total;
}

// ---------- Bryan ----------
const BRYAN = { price: 350, feeByMonth: { '2026-09': 1250, '2026-10': 1250 }, augRetainer: 20000 };
const bryanSkip = (l) => l.replacement || ['2026-10-07', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-18', '2026-10-19'].includes(l.createdDate);
function bryanMetrics(leads, walker) {
  const total = leads.length;
  const signed = leads.filter((l) => l.status === 'Signed').length;
  const rejected = leads.filter((l) => l.status === 'Rejected').length;
  const spend = sharedDeduction(leads, walker, bryanSkip);
  const billable = leads.filter((l) => l.billable !== false).length;
  const revenue = billable * BRYAN.price;
  const months = new Set(leads.map((l) => l.createdDate.slice(0, 7)));
  let fee = 0;
  for (const m of months) {
    if (m === '2026-08') fee += BRYAN.augRetainer - leads.filter((l) => l.createdDate.slice(0, 7) === m && l.billable !== false).length * BRYAN.price;
    else fee += BRYAN.feeByMonth[m] || 0;
  }
  const profit = revenue + fee - spend;
  return { total, signed, rejected, spend, revenue, fee, profit };
}
function bryanSheets(data) {
  const leads = data.leads || [];
  const byMonth = (k) => leads.filter((l) => l.createdDate.slice(0, 7) === k);
  const cols = (m) => [
    ['Total Leads', m.total],
    ['Signed Cases', m.signed],
    ['Conversion Rate', m.total ? pct((m.signed / m.total) * 100) : dash],
    ['Rejected', m.rejected],
    ['Ad Spend', money(m.spend)],
    ['Cost / Lead', m.total && m.spend ? money(m.spend / m.total) : dash],
    ['Cost / Case', m.signed && m.spend ? money(m.spend / m.signed) : dash],
    ['Revenue', money(m.revenue)],
    ['Marketing Fee', m.fee ? money(m.fee) : dash],
    ['Profit', money(m.profit)],
    ['Client CPC', m.signed ? money((m.revenue + m.fee) / m.signed) : dash],
  ];
  const notes = {
    'Ad Spend': "Bryan's share of the shared Texas campaigns", 'Revenue': '$350 × billable leads', 'Marketing Fee': 'monthly contract fee',
    'Profit': 'revenue + fee − ad spend', 'Client CPC': 'what Bryan pays per case · revenue + fee ÷ signed', 'Conversion Rate': 'signed ÷ leads',
  };
  const monthly = leads.length ? monthsBetween(leads.map((l) => l.createdDate).sort()[0].slice(0, 7), monthKeys().thisMonth) : [];
  return {
    title: 'Bryan Rodriguez — Dashboard',
    overview: overviewRows((k) => cols(bryanMetrics(k === 'all' ? leads : byMonth(k), data.walker)), notes),
    monthly: {
      header: ['Month', 'Leads', 'Signed', 'Conversion %', 'Ad Spend', 'Revenue', 'Marketing Fee', 'Profit', 'Cost / Case'],
      rows: monthly.map((k) => { const m = bryanMetrics(byMonth(k), data.walker); return [monthLabel(k), m.total, m.signed, m.total ? r2((m.signed / m.total) * 100) : 0, r2(m.spend), m.revenue, r2(m.fee), r2(m.profit), m.signed ? r2(m.spend / m.signed) : 0]; }),
      left: [1, 2], right: [4, 5, 7], money: [4, 5, 6, 7, 8],
    },
    leads: {
      header: ['Date', 'Name', 'Email', 'Phone', 'Status', 'Billable', 'Campaign', 'Ad', 'Contact Source', 'Note'],
      rows: leads.slice().sort((a, b) => b.createdDate.localeCompare(a.createdDate)).map((l) => {
        const o = l.origin || {};
        return [l.createdDate, l.name, l.email, l.phone, l.status, l.billable === false ? 'No' : 'Yes', o.campaignName || '', o.adName || '', o.contactSource || '', l.note || l.reason || ''];
      }),
      statusCol: 4,
    },
  };
}

// ---------- Ruy ----------
const RUY = { price: 500, prepaid: 25000, target: 50 };
function ruyMetrics(leads, walker) {
  const total = leads.length;
  const signed = leads.filter((l) => l.status === 'Signed').length;
  const rejected = leads.filter((l) => l.status === 'Rejected').length;
  const spend = sharedDeduction(leads, walker);
  const revenue = Math.min(total, RUY.target) * RUY.price;
  return { total, signed, rejected, spend, revenue, profit: revenue - spend };
}
function ruySheets(data) {
  const leads = data.leads || [];
  const byMonth = (k) => leads.filter((l) => l.createdDate.slice(0, 7) === k);
  const budgetLeft = Math.max(0, RUY.prepaid - Math.min(leads.length, RUY.target) * RUY.price);
  const cols = (m) => [
    ['Total Leads', m.total],
    ['Signed Cases', m.signed],
    ['Conversion Rate', m.total ? pct((m.signed / m.total) * 100) : dash],
    ['Rejected', m.rejected],
    ['Ad Spend', money(m.spend)],
    ['Cost / Lead', m.total && m.spend ? money(m.spend / m.total) : dash],
    ['Cost / Case', m.signed && m.spend ? money(m.spend / m.signed) : dash],
    ['Revenue', money(m.revenue)],
    ['Profit', money(m.profit)],
    ['Client CPC', m.signed ? money(m.revenue / m.signed) : dash],
    ['Budget Left', money(budgetLeft)],
  ];
  const notes = {
    'Ad Spend': "Ruy's share of the shared Texas campaigns", 'Revenue': '$500 × leads (up to the 50 paid for)', 'Profit': 'revenue − ad spend',
    'Client CPC': 'what Ruy pays per case · revenue ÷ signed', 'Budget Left': '$25,000 prepaid − $500 × leads delivered (whole contract)', 'Conversion Rate': 'signed ÷ leads',
  };
  const monthly = leads.length ? monthsBetween(leads.map((l) => l.createdDate).sort()[0].slice(0, 7), monthKeys().thisMonth) : [];
  return {
    title: 'Ruy Mireles Law Firm — Dashboard',
    overview: overviewRows((k) => cols(ruyMetrics(k === 'all' ? leads : byMonth(k), data.walker)), notes),
    monthly: {
      header: ['Month', 'Leads', 'Signed', 'Conversion %', 'Ad Spend', 'Revenue', 'Profit', 'Cost / Case'],
      rows: monthly.map((k) => { const m = ruyMetrics(byMonth(k), data.walker); return [monthLabel(k), m.total, m.signed, m.total ? r2((m.signed / m.total) * 100) : 0, r2(m.spend), m.revenue, r2(m.profit), m.signed ? r2(m.spend / m.signed) : 0]; }),
      left: [1, 2], right: [4, 5, 6], money: [4, 5, 6, 7],
    },
    leads: {
      header: ['Date', 'Name', 'Email', 'Phone', 'Status', 'Lead Status (sheet)', 'Campaign', 'Ad', 'Contact Source', 'Notes'],
      rows: leads.slice().sort((a, b) => b.createdDate.localeCompare(a.createdDate)).map((l) => {
        const o = l.origin || {};
        return [l.createdDate, l.name, l.email, l.phone, l.status, l.statusText || '', o.campaignName || '', o.adName || '', o.contactSource || '', l.note || ''];
      }),
      statusCol: 4,
    },
  };
}

// ---------- KM ----------
function kmSheets(data) {
  const s = data.settings || { feePerLead: 35, monthlyAdBudget: 20000 };
  const cases = (data.cases || []).filter((c) => c.conversionDate && c.conversionDate >= '2026-01-01');
  const leadsDaily = (data.leadsDaily || []).filter((r) => r.date >= '2026-01-01');
  const spend = [
    ...(data.googleDaily || []).map((x) => ({ date: x.date, platform: 'Google', spend: x.spend })),
    ...(data.metaDaily || []).map((x) => ({ date: x.date, platform: 'Meta', spend: x.spend })),
  ].filter((r) => r.date >= '2026-01-01');
  const inK = (d, k) => k === 'all' || (d || '').slice(0, 7) === k;
  const today = pacificToday();
  const budgetFor = (k) => {
    // The monthly ad budget prorated per day, through today for the current month.
    const days = (from, to) => { let t = 0; for (let d = new Date(from + 'T00:00:00'), e = new Date(to + 'T00:00:00'); d <= e; d.setDate(d.getDate() + 1)) t += s.monthlyAdBudget / new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); return t; };
    const first = spend.map((r) => r.date).sort()[0];
    if (!first) return 0;
    if (k === 'all') return days(first, today);
    const start = k + '-01', endD = new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)), 0);
    const end = k + '-' + String(endD.getDate()).padStart(2, '0');
    return days(start < first ? first : start, end > today ? today : end);
  };
  const metrics = (k) => {
    const leads = leadsDaily.filter((r) => inK(r.date, k)).reduce((a, r) => a + r.leads, 0);
    const signed = cases.filter((c) => inK(c.conversionDate, k)).length;
    const g = spend.filter((r) => r.platform === 'Google' && inK(r.date, k)).reduce((a, r) => a + r.spend, 0);
    const m = spend.filter((r) => r.platform === 'Meta' && inK(r.date, k)).reduce((a, r) => a + r.spend, 0);
    const fee = leads * s.feePerLead;
    return { leads, signed, google: g, meta: m, spend: g + m, fee, budget: budgetFor(k) };
  };
  const cols = (m) => [
    ['Total Leads', m.leads],
    ['Signed Cases', m.signed],
    ['Conversion Rate', m.leads ? pct((m.signed / m.leads) * 100) : dash],
    ['Ad Spend', money(m.spend)],
    ['Google Spend', money(m.google)],
    ['Meta Spend', money(m.meta)],
    ['Cost / Lead', m.leads ? money(m.spend / m.leads) : dash],
    ['Marketing Fee', money(m.fee)],
    ['Total Cost', money(m.spend + m.fee)],
    ['Ad Budget', money(m.budget)],
    ['Budget Left', money(m.budget - m.spend)],
    ['CPC (Cost / Case)', m.signed ? money(m.spend / m.signed) : dash],
    ['Client CPC', m.signed ? money((m.spend + m.fee) / m.signed) : dash],
  ];
  const notes = {
    'Marketing Fee': '$' + s.feePerLead + ' × leads', 'Total Cost': 'ad spend + marketing fee', 'Ad Budget': '$' + s.monthlyAdBudget.toLocaleString('en-US') + '/month, prorated by day',
    'Client CPC': 'what KM pays per case · ad spend + fee ÷ signed', 'Signed Cases': 'by conversion date', 'Conversion Rate': 'signed ÷ leads',
  };
  const first = [leadsDaily[0] && leadsDaily[0].date, spend.map((r) => r.date).sort()[0]].filter(Boolean).sort()[0];
  const months = first ? monthsBetween(first.slice(0, 7), monthKeys().thisMonth) : [];
  return {
    title: 'KM Law Firm PLLC — Dashboard',
    overview: overviewRows((k) => cols(metrics(k)), notes, '2026 onward'),
    monthly: {
      header: ['Month', 'Leads', 'Signed', 'Conversion %', 'Ad Spend', 'Marketing Fee', 'Total Cost', 'Cost / Case'],
      rows: months.map((k) => { const m = metrics(k); return [monthLabel(k), m.leads, m.signed, m.leads ? r2((m.signed / m.leads) * 100) : 0, r2(m.spend), r2(m.fee), r2(m.spend + m.fee), m.signed ? r2(m.spend / m.signed) : 0]; }),
      left: [1, 2], right: [4, 6], money: [4, 5, 6, 7],
    },
    leads: {
      title: 'Signed Cases',
      header: ['Conversion Date', 'Intake Date', 'Name', 'Email', 'Ad', 'Status'],
      rows: cases.slice().sort((a, b) => b.conversionDate.localeCompare(a.conversionDate)).map((c) => [c.conversionDate, c.intakeDate || '', c.name, c.email && c.email.includes('@') ? c.email : '', c.adName || c.ad || '', 'Signed']),
      statusCol: 5,
    },
  };
}

// ---------- B2B ----------
const B2B_DEAL_VALUES = { 'ruy mireles': 25000 }; // same list as b2b-public/app.js
const isQualified = (l) => /^qualified$/i.test(l.status || '');
const isWon = (l) => /^won\b/i.test(l.stage || '');
function b2bSheets(data) {
  const leads = data.leads || [];
  const inK = (d, k) => k === 'all' || (d || '').slice(0, 7) === k;
  const metrics = (k) => {
    const ls = leads.filter((l) => inK(l.date, k));
    const spend = (data.adSpendDaily || []).filter((r) => inK(r.date, k)).reduce((a, r) => a + r.spend, 0);
    const qualified = ls.filter(isQualified).length;
    const won = leads.filter((l) => isWon(l) && inK(l.closeDate || l.date, k));
    const revenue = won.reduce((a, l) => a + (B2B_DEAL_VALUES[(l.name || '').trim().toLowerCase()] || 0), 0);
    return { leads: ls.length, spend, qualified, won, revenue };
  };
  const cols = (m) => [
    ['Leads', m.leads],
    ['Ad Spent', money(m.spend)],
    ['CPL', m.leads ? money(m.spend / m.leads) : dash],
    ['Qualified Leads', m.qualified],
    ['Cost / Qualified Lead', m.qualified ? money(m.spend / m.qualified) : dash],
    ['Closed Deals', m.won.length],
    ['Revenue', money(m.revenue)],
    ['Closed With', m.won.map((l) => l.firmName || l.name).join(', ') || dash],
  ];
  const notes = { 'Qualified Leads': 'Status “Qualified”', 'Closed Deals': 'stage “Won (Payment Received)”, by Close Date', 'Revenue': 'value of the closed deals' };
  const first = [leads.map((l) => l.date).sort()[0], (data.adSpendDaily || []).map((r) => r.date).sort()[0]].filter(Boolean).sort()[0];
  const months = first ? monthsBetween(first.slice(0, 7), monthKeys().thisMonth) : [];
  // Ads this month: leads/qualified by UTM Content (the ad name), spend by ad name.
  const { thisMonth } = monthKeys();
  const adMap = new Map();
  const ad = (n) => { if (!adMap.has(n)) adMap.set(n, { leads: 0, qualified: 0, won: 0, spend: 0 }); return adMap.get(n); };
  for (const l of leads) if (inK(l.date, thisMonth) && l.utmContent) { const a = ad(l.utmContent); a.leads++; if (isQualified(l)) a.qualified++; if (isWon(l)) a.won++; }
  for (const r of data.adSpendByAdNameDaily || []) if (inK(r.date, thisMonth)) ad(r.adName).spend += r.spend;
  const adRows = [...adMap.entries()].filter(([, a]) => a.leads || a.spend).sort((a, b) => b[1].leads - a[1].leads || b[1].spend - a[1].spend)
    .map(([n, a]) => [n, a.leads, a.qualified, a.won, r2(a.spend), a.leads ? r2(a.spend / a.leads) : 0, a.qualified ? r2(a.spend / a.qualified) : 0]);
  return {
    title: 'B2B Report',
    overview: overviewRows((k) => cols(metrics(k)), notes),
    monthly: {
      header: ['Month', 'Leads', 'Qualified', 'Closed Deals', 'Ad Spent', 'CPL', 'Cost / Qualified', 'Revenue'],
      rows: months.map((k) => { const m = metrics(k); return [monthLabel(k), m.leads, m.qualified, m.won.length, r2(m.spend), m.leads ? r2(m.spend / m.leads) : 0, m.qualified ? r2(m.spend / m.qualified) : 0, m.revenue]; }),
      left: [1, 2], right: [4], money: [4, 5, 6, 7], pctCol: false,
    },
    leads: {
      header: ['Date', 'Name', 'Firm', 'State', 'Contact Source', 'Ad', 'Stage', 'Status', 'Close Date'],
      rows: leads.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((l) => [l.date, l.name, l.firmName || '', l.state || '', l.source || '', l.utmContent || '', l.stage || '', l.status || '', l.closeDate || '']),
      statusCol: 7, stageCol: 6,
    },
    ads: {
      title: 'Ads (This Month)',
      header: ['Ad Name', 'Leads', 'Qualified', 'Closed', 'Spend', 'Cost / Lead', 'Cost / Qualified'],
      rows: adRows, money: [4, 5, 6],
    },
  };
}

// Overview block: title, timestamp, then Metric | This Month | Last Month | All Time | Notes.
function overviewRows(colsFor, notes, allLabel) {
  const { thisMonth, lastMonth } = monthKeys();
  const a = colsFor(thisMonth), b = colsFor(lastMonth), c = colsFor('all');
  return {
    header: ['Metric', 'This Month (' + monthLabel(thisMonth) + ')', 'Last Month (' + monthLabel(lastMonth) + ')', 'All Time' + (allLabel ? ' (' + allLabel + ')' : ''), 'How it’s calculated'],
    rows: a.map(([label, v], i) => [label, v, b[i][1], c[i][1], notes[label] || '']),
  };
}

// ---------- writing + formatting ----------
const COLORS = {
  ink: { red: 0.07, green: 0.07, blue: 0.08 }, gold: { red: 0.973, green: 0.741, blue: 0.008 }, white: { red: 1, green: 1, blue: 1 },
  band: { red: 0.976, green: 0.969, blue: 0.937 }, label: { red: 0.95, green: 0.93, blue: 0.85 },
  greenBg: { red: 0.85, green: 0.95, blue: 0.87 }, greenText: { red: 0.05, green: 0.45, blue: 0.2 },
  redBg: { red: 0.99, green: 0.88, blue: 0.87 }, redText: { red: 0.72, green: 0.11, blue: 0.11 },
  amberBg: { red: 1, green: 0.95, blue: 0.8 }, amberText: { red: 0.6, green: 0.4, blue: 0 },
  blueBg: { red: 0.87, green: 0.92, blue: 0.99 }, blueText: { red: 0.1, green: 0.3, blue: 0.7 },
};
const OVERVIEW_TOP = 3; // rows 1-3: title, timestamp, blank — table header on row 4

async function writeAll(id, sheets) {
  const tabs = [['Overview'], ['Monthly'], [sheets.leads.title || 'Leads']];
  if (sheets.ads) tabs.push([sheets.ads.title]);
  await Promise.all([
    writeSheetTab(id, 'Overview', [[sheets.title], [updatedStamp()], [''], sheets.overview.header, ...sheets.overview.rows]),
    writeSheetTab(id, 'Monthly', [sheets.monthly.header, ...sheets.monthly.rows]),
    writeSheetTab(id, sheets.leads.title || 'Leads', [sheets.leads.header, ...sheets.leads.rows]),
    sheets.ads ? writeSheetTab(id, sheets.ads.title, [sheets.ads.header, ...sheets.ads.rows]) : null,
  ]);
}

// Creates any missing tabs, then (re)applies all formatting. Safe to run repeatedly.
async function setupFormatting(id, sheets) {
  const wanted = ['Overview', 'Monthly', sheets.leads.title || 'Leads'].concat(sheets.ads ? [sheets.ads.title] : []);
  let meta = await getSpreadsheet(id, 'sheets(properties(sheetId,title),charts(chartId),conditionalFormats,bandedRanges(bandedRangeId))');
  const have = new Set(meta.sheets.map((s) => s.properties.title));
  const add = wanted.filter((t) => !have.has(t)).map((title) => ({ addSheet: { properties: { title } } }));
  if (add.length) await batchUpdate(id, add);
  meta = await getSpreadsheet(id, 'sheets(properties(sheetId,title),charts(chartId),conditionalFormats,bandedRanges(bandedRangeId))');
  // Drop the blank default tab once ours exist, and put ours first in order.
  const reqs = [];
  for (const s of meta.sheets) {
    const t = s.properties.title;
    if (!wanted.includes(t) && /^Sheet\d+$/.test(t)) reqs.push({ deleteSheet: { sheetId: s.properties.sheetId } });
    for (const c of s.charts || []) reqs.push({ deleteEmbeddedObject: { objectId: c.chartId } });
    for (const b of s.bandedRanges || []) reqs.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
    for (let i = (s.conditionalFormats || []).length - 1; i >= 0; i--) reqs.push({ deleteConditionalFormatRule: { sheetId: s.properties.sheetId, index: i } });
  }
  if (reqs.length) await batchUpdate(id, reqs);
  const sid = Object.fromEntries(meta.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
  const range = (sheetId, r0, r1, c0, c1) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
  const cellFmt = (rng, fmt, fields) => ({ repeatCell: { range: rng, cell: { userEnteredFormat: fmt }, fields: 'userEnteredFormat(' + fields + ')' } });
  const header = (sheetId, cols) => cellFmt(range(sheetId, 0, 1, 0, cols), { backgroundColor: COLORS.ink, textFormat: { foregroundColor: COLORS.gold, bold: true }, verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' }, 'backgroundColor,textFormat,verticalAlignment,wrapStrategy');
  const widths = (sheetId, list) => list.map((px, i) => ({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } }));
  const freeze = (sheetId, rows, cols) => ({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: rows, frozenColumnCount: cols || 0 } }, fields: 'gridProperties(frozenRowCount,frozenColumnCount)' } });
  const band = (sheetId, r0, r1, cols) => ({ addBanding: { bandedRange: { range: range(sheetId, r0, r1, 0, cols), rowProperties: { firstBandColor: COLORS.white, secondBandColor: COLORS.band } } } });
  const textRule = (rng, text, bg, fg, type) => ({ addConditionalFormatRule: { index: 0, rule: { ranges: [rng], booleanRule: { condition: { type: type || 'TEXT_CONTAINS', values: [{ userEnteredValue: text }] }, format: { backgroundColor: bg, textFormat: { foregroundColor: fg, bold: true } } } } } });
  const formulaRule = (rng, formula, bg, fg) => ({ addConditionalFormatRule: { index: 0, rule: { ranges: [rng], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] }, format: { backgroundColor: bg, textFormat: { foregroundColor: fg, bold: true } } } } } });
  const moneyCols = (sheetId, cols, rows) => cols.map((c) => cellFmt(range(sheetId, 1, rows, c, c + 1), { numberFormat: { type: 'CURRENCY', pattern: '$#,##0.00' } }, 'numberFormat'));

  const f = [];
  // Overview
  const ov = sid.Overview, ovRows = OVERVIEW_TOP + 1 + sheets.overview.rows.length;
  f.push(cellFmt(range(ov, 0, 1, 0, 5), { backgroundColor: COLORS.ink, textFormat: { foregroundColor: COLORS.gold, bold: true, fontSize: 18 } }, 'backgroundColor,textFormat'));
  f.push(cellFmt(range(ov, 1, 2, 0, 5), { backgroundColor: COLORS.ink, textFormat: { foregroundColor: COLORS.white, italic: true, fontSize: 9 } }, 'backgroundColor,textFormat'));
  f.push(cellFmt(range(ov, OVERVIEW_TOP, OVERVIEW_TOP + 1, 0, 5), { backgroundColor: COLORS.gold, textFormat: { foregroundColor: COLORS.ink, bold: true }, horizontalAlignment: 'CENTER', wrapStrategy: 'WRAP' }, 'backgroundColor,textFormat,horizontalAlignment,wrapStrategy'));
  f.push(cellFmt(range(ov, OVERVIEW_TOP + 1, ovRows, 0, 1), { backgroundColor: COLORS.label, textFormat: { bold: true } }, 'backgroundColor,textFormat'));
  f.push(cellFmt(range(ov, OVERVIEW_TOP + 1, ovRows, 1, 4), { horizontalAlignment: 'RIGHT', textFormat: { fontSize: 12, bold: true } }, 'horizontalAlignment,textFormat'));
  f.push(cellFmt(range(ov, OVERVIEW_TOP + 1, ovRows, 4, 5), { textFormat: { foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 }, italic: true, fontSize: 9 }, wrapStrategy: 'WRAP' }, 'textFormat,wrapStrategy'));
  f.push(...widths(ov, [190, 190, 190, 190, 340]));
  f.push(freeze(ov, OVERVIEW_TOP + 1, 1));
  // Highlight rows: profit/revenue green (red if negative), signed/closed/qualified green, budget left amber.
  const ovVals = range(ov, OVERVIEW_TOP + 1, ovRows, 1, 4);
  const rowRef = '$A' + (OVERVIEW_TOP + 2);
  f.push(formulaRule(ovVals, '=OR(' + rowRef + '="Profit",' + rowRef + '="Revenue",' + rowRef + '="Signed Cases",' + rowRef + '="Closed Deals",' + rowRef + '="Qualified Leads")', COLORS.greenBg, COLORS.greenText));
  f.push(formulaRule(ovVals, '=OR(' + rowRef + '="Ad Spend",' + rowRef + '="Ad Spent",' + rowRef + '="Total Cost")', COLORS.blueBg, COLORS.blueText));
  f.push(formulaRule(ovVals, '=OR(' + rowRef + '="Budget Left",' + rowRef + '="Client CPC",' + rowRef + '="Marketing Fee")', COLORS.amberBg, COLORS.amberText));
  // Added last so it wins (index 0 = highest priority): a negative Profit turns red.
  f.push(formulaRule(ovVals, '=AND(' + rowRef + '="Profit",VALUE(SUBSTITUTE(SUBSTITUTE(B' + (OVERVIEW_TOP + 2) + ',"$",""),",",""))<0)', COLORS.redBg, COLORS.redText));

  // Monthly
  const mo = sid.Monthly, mCols = sheets.monthly.header.length, mRows = 1 + sheets.monthly.rows.length;
  f.push(header(mo, mCols), freeze(mo, 1, 1), band(mo, 1, Math.max(mRows, 2), mCols));
  f.push(...widths(mo, [160].concat(Array(mCols - 1).fill(120))));
  f.push(...moneyCols(mo, sheets.monthly.money, Math.max(mRows, 2)));
  // Column 3 is Conversion % on the client sheets; B2B's column 3 is a plain count (Closed Deals).
  f.push(cellFmt(range(mo, 1, Math.max(mRows, 2), 3, 4), { numberFormat: sheets.monthly.pctCol === false ? { type: 'NUMBER', pattern: '0' } : { type: 'NUMBER', pattern: '0.0"%"' } }, 'numberFormat'));
  if (sheets.monthly.rows.length) {
    const src = (c) => ({ sourceRange: { sources: [range(mo, 0, mRows, c, c + 1)] } });
    f.push({ addChart: { chart: { spec: {
      title: 'Monthly trend', basicChart: {
        chartType: 'COMBO', legendPosition: 'BOTTOM_LEGEND', headerCount: 1,
        axis: [{ position: 'BOTTOM_AXIS' }, { position: 'LEFT_AXIS', title: 'Leads / signed' }, { position: 'RIGHT_AXIS', title: '$' }],
        domains: [{ domain: src(0) }],
        series: sheets.monthly.left.map((c) => ({ series: src(c), targetAxis: 'LEFT_AXIS', type: 'COLUMN' }))
          .concat(sheets.monthly.right.map((c) => ({ series: src(c), targetAxis: 'RIGHT_AXIS', type: 'LINE' }))),
      } }, position: { overlayPosition: { anchorCell: { sheetId: mo, rowIndex: Math.max(mRows, 2) + 1, columnIndex: 0 }, widthPixels: 900, heightPixels: 380 } } } } });
  }

  // Leads
  const ld = sid[sheets.leads.title || 'Leads'], lCols = sheets.leads.header.length, lRows = 1 + sheets.leads.rows.length;
  f.push(header(ld, lCols), freeze(ld, 1, 2));
  f.push(...widths(ld, sheets.leads.header.map((h) => (/name|email|campaign|ad$|source|firm|note/i.test(h) ? 220 : 120))));
  f.push({ setBasicFilter: { filter: { range: range(ld, 0, Math.max(lRows, 2), 0, lCols) } } });
  const statusRng = range(ld, 1, 5000, sheets.leads.statusCol, sheets.leads.statusCol + 1);
  f.push(textRule(statusRng, 'Signed', COLORS.greenBg, COLORS.greenText));
  f.push(textRule(statusRng, 'Qualified', COLORS.greenBg, COLORS.greenText, 'TEXT_EQ'));
  f.push(textRule(statusRng, 'Reject', COLORS.redBg, COLORS.redText));
  f.push(textRule(statusRng, 'Not Qualified', COLORS.redBg, COLORS.redText));
  f.push(textRule(statusRng, 'Reviewing', COLORS.amberBg, COLORS.amberText));
  if (sheets.leads.stageCol != null) {
    const stageRng = range(ld, 1, 5000, sheets.leads.stageCol, sheets.leads.stageCol + 1);
    f.push(textRule(stageRng, 'Won', COLORS.greenBg, COLORS.greenText));
    f.push(textRule(stageRng, 'Not Qualified', COLORS.redBg, COLORS.redText));
    f.push(textRule(stageRng, 'Lost', COLORS.redBg, COLORS.redText));
    f.push(textRule(stageRng, 'Contract', COLORS.blueBg, COLORS.blueText));
  }
  // Ads (B2B)
  if (sheets.ads) {
    const ad = sid[sheets.ads.title], aCols = sheets.ads.header.length, aRows = 1 + sheets.ads.rows.length;
    f.push(header(ad, aCols), freeze(ad, 1, 1), band(ad, 1, Math.max(aRows, 2), aCols));
    f.push(...widths(ad, [260].concat(Array(aCols - 1).fill(120))));
    f.push(...moneyCols(ad, sheets.ads.money, Math.max(aRows, 2)));
  }
  // Tab order + colors
  wanted.forEach((t, i) => f.push({ updateSheetProperties: { properties: { sheetId: sid[t], index: i, tabColorStyle: { rgbColor: i === 0 ? COLORS.gold : COLORS.ink } }, fields: 'index,tabColorStyle' } }));
  await batchUpdate(id, f);
}

const CLIENTS = [
  { key: 'bryan', id: '1EYuVvcJqJvwjkRDrjk0dIv9rpDc-LQ01dqDFOH-beo8', data: () => require('./bryan').getData(), build: bryanSheets, ready: (d) => (d.leads || []).length > 0 && (d.walker.spendDaily || []).length > 0 },
  { key: 'ruy', id: '13GsHkDIIP8KBmoWvgqzCFhGo09ZFohU3pR2QX2cdU2I', data: () => require('./ruy').getData(), build: ruySheets, ready: (d) => (d.leads || []).length > 0 && (d.walker.spendDaily || []).length > 0 },
  { key: 'km', id: '14WHijGl1dASxM8Dnhl5x1y0jBqDKZOaVeYCduPdlEMk', data: () => require('./km').getData(), build: kmSheets, ready: (d) => (d.cases || []).length > 0 && (d.googleDaily || []).length > 0 },
  { key: 'b2b', id: '1g00CRGRSYLECWMXltoLd75Ys2I8jSFYRii9S0-qK4fk', data: () => require('./b2b').getData(), build: b2bSheets, ready: (d) => (d.leads || []).length > 0 },
];
const SHEET_URLS = Object.fromEntries(CLIENTS.map((c) => [c.key, 'https://docs.google.com/spreadsheets/d/' + c.id + '/edit']));

const lastSync = new Map(), formatted = new Map(), inFlight = new Map();
async function syncOne(c) {
  if (inFlight.get(c.key) || Date.now() - (lastSync.get(c.key) || 0) < SYNC_INTERVAL_MS) return;
  const data = c.data();
  if (!c.ready(data)) return; // first poll hasn't landed yet
  lastSync.set(c.key, Date.now());
  inFlight.set(c.key, true);
  try {
    const sheets = c.build(data);
    // Tabs must exist before values can be written, so the first run formats first; after that
    // formatting is refreshed once an hour (row counts grow, charts need the new range).
    const needFormat = Date.now() - (formatted.get(c.key) || 0) > 60 * 60 * 1000;
    if (needFormat && !formatted.get(c.key)) await setupFormatting(c.id, sheets);
    await writeAll(c.id, sheets);
    if (needFormat) { if (formatted.get(c.key)) await setupFormatting(c.id, sheets); formatted.set(c.key, Date.now()); }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ${c.key} sheet sync failed:`, err.message);
  } finally { inFlight.set(c.key, false); }
}
function syncClientSheets() { return Promise.all(CLIENTS.map(syncOne)); }

module.exports = { syncClientSheets, SHEET_URLS, _build: { bryanSheets, ruySheets, kmSheets, b2bSheets } };

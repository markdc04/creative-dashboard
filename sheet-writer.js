// Shared helper for writing a dashboard's live numbers out to a Google Sheet ("View in
// Spreadsheet" button) — separate from the various *.js data modules, which only ever read.
// Uses its own write-scoped OAuth credential (OAUTH_WRITE_CLIENT_ID/SECRET/REFRESH_TOKEN — a
// different refresh token than OAUTH_REFRESH_TOKEN, minted with the `spreadsheets` write scope,
// not just spreadsheets.readonly) so a bug here can never touch the read-only credential every
// other dashboard depends on.
const https = require('https');

let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

function getWriteAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry - 60000) {
    return Promise.resolve(cachedAccessToken);
  }
  const body = new URLSearchParams({
    client_id: process.env.OAUTH_WRITE_CLIENT_ID,
    client_secret: process.env.OAUTH_WRITE_CLIENT_SECRET,
    refresh_token: process.env.OAUTH_WRITE_REFRESH_TOKEN,
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
          if (!json.access_token) return reject(new Error('write token refresh failed: ' + JSON.stringify(json)));
          cachedAccessToken = json.access_token;
          cachedAccessTokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
          resolve(cachedAccessToken);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('write token request timed out')));
    req.end(body);
  });
}

function sheetsRequest(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = https.request(`https://sheets.googleapis.com${path}`, {
      method,
      headers: Object.assign(
        { Authorization: `Bearer ${token}` },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 300) return reject(new Error(`sheets API ${method} ${path} -> ${res.statusCode}: ${text}`));
        try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('sheets write request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

// Replaces a tab's entire contents with `rows` (array of arrays — first row is normally a
// header). Clears first so a shrinking row/column count never leaves stale cells behind.
async function writeSheetTab(spreadsheetId, sheetTitle, rows) {
  const token = await getWriteAccessToken();
  const range = `'${sheetTitle}'!A1:ZZ10000`;
  await sheetsRequest('POST', `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`, token);
  if (!rows.length) return;
  await sheetsRequest(
    'PUT',
    `/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${sheetTitle}'!A1`)}?valueInputOption=USER_ENTERED`,
    token,
    { values: rows }
  );
}

// A raw batchUpdate call (requests array per the Sheets API's Request schema) for anything
// writeSheetTab can't do — adding/positioning an embedded chart, setting a basic filter, resizing
// columns, etc.
async function batchUpdate(spreadsheetId, requests) {
  if (!requests.length) return;
  const token = await getWriteAccessToken();
  return sheetsRequest('POST', `/v4/spreadsheets/${spreadsheetId}:batchUpdate`, token, { requests });
}

// Adds (or replaces, if chartId is given) an embedded line chart reading from a tab's own data —
// sheetId is the tab's numeric sheet ID (not its title), rowCount/colCount describe the data
// range including its header row. leftSeriesCols/rightSeriesCols are 0-based column indexes (col
// 0 is the X-axis labels) assigned to the left/right Y-axis, so count metrics and dollar metrics
// can share one chart at very different scales.
async function upsertLineChart(spreadsheetId, { sheetId, chartId, title, rowCount, startCol, leftSeriesCols, rightSeriesCols, anchorRow = 0, anchorCol = 10 }) {
  const domain = { domain: { sourceRange: { sources: [{ sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: startCol, endColumnIndex: startCol + 1 }] } } };
  const seriesFor = (cols, axis) => cols.map((col) => ({
    series: { sourceRange: { sources: [{ sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: col, endColumnIndex: col + 1 }] } },
    targetAxis: axis,
  }));
  const chartSpec = {
    title,
    basicChart: {
      chartType: 'LINE',
      legendPosition: 'BOTTOM_LEGEND',
      axis: [{ position: 'BOTTOM_AXIS' }, { position: 'LEFT_AXIS' }, { position: 'RIGHT_AXIS' }],
      domains: [domain],
      series: [...seriesFor(leftSeriesCols, 'LEFT_AXIS'), ...seriesFor(rightSeriesCols, 'RIGHT_AXIS')],
      headerCount: 1,
    },
  };
  const position = { overlayPosition: { anchorCell: { sheetId, rowIndex: anchorRow, columnIndex: anchorCol }, widthPixels: 760, heightPixels: 360 } };
  const request = chartId
    ? { updateChartSpec: { chartId, spec: chartSpec } }
    : { addChart: { chart: { spec: chartSpec, position } } };
  return batchUpdate(spreadsheetId, [request]);
}

// A plain header-row filter (Data > Create a filter equivalent) over a tab's full written range,
// so a column's own dropdown arrow lets a viewer filter/sort it directly in Sheets.
async function setBasicFilter(spreadsheetId, sheetId, rowCount, colCount) {
  return batchUpdate(spreadsheetId, [{
    setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: colCount } } },
  }]);
}

module.exports = { writeSheetTab, batchUpdate, upsertLineChart, setBasicFilter };

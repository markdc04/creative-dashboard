// One-time local tool to mint a write-scoped Google OAuth refresh token for the Sasooness sheet
// sync (sheet-writer.js's OAUTH_WRITE_CLIENT_ID/SECRET/REFRESH_TOKEN). Reuses the SAME OAuth
// client every other dashboard module already uses for read-only access (OAUTH_CLIENT_ID/SECRET
// in Render) — this only mints a SECOND, separately-scoped refresh token from that client, with
// the `spreadsheets` (read/write) scope instead of `spreadsheets.readonly`. That keeps the two
// credentials isolated (a bug in the write path can never touch the read-only token) without
// needing a whole new Google Cloud OAuth client.
//
// Run locally (never on the server, never paste secrets into chat):
//   OAUTH_CLIENT_ID=... OAUTH_CLIENT_SECRET=... node scripts/get_write_refresh_token.js
// (Get those two values from Render → loudrdash → Environment → the eye icon next to
// OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET — the existing read-only ones, reused here.)
//
// This opens a tiny local server, prints a Google consent URL to visit, and once you approve it
// (as whichever Google account should own write access to the Sasooness Dashboard spreadsheet),
// prints the new refresh token. Paste that into Render's OAUTH_WRITE_REFRESH_TOKEN yourself —
// also add OAUTH_WRITE_CLIENT_ID and OAUTH_WRITE_CLIENT_SECRET in Render, set to the SAME values
// as OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET (sheet-writer.js expects its own env var names, even
// though they're the same underlying OAuth client).
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET (the existing read-only ones from Render) before running this.');
  process.exit(1);
}

function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code,
    grant_type: 'authorization_code', redirect_uri: REDIRECT_URI,
  }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) {
    res.end(`Google returned an error: ${error}. Check the terminal and try again.`);
    console.error('Authorization failed:', error);
    server.close();
    return;
  }
  if (!code) { res.end('Waiting for authorization...'); return; }
  res.end('Done — you can close this tab and go back to the terminal.');
  server.close();
  try {
    const json = await exchangeCodeForToken(code);
    if (!json.refresh_token) {
      console.error('No refresh_token in response (if you\'ve authorized this client before, Google may skip issuing a new one — revoke prior access at https://myaccount.google.com/permissions and try again):', json);
      process.exit(1);
    }
    console.log('\nSuccess. In Render, add these three environment variables to loudrdash:\n');
    console.log('  OAUTH_WRITE_CLIENT_ID =', CLIENT_ID);
    console.log('  OAUTH_WRITE_CLIENT_SECRET = <same as OAUTH_CLIENT_SECRET>');
    console.log('  OAUTH_WRITE_REFRESH_TOKEN =', json.refresh_token);
    console.log('\nThen redeploy (or it\'ll pick it up on the next auto-deploy).');
  } catch (e) {
    console.error('Token exchange failed:', e.message);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent',
  }).toString();
  console.log('\nOpen this URL, sign in with the Google account that should own write access to the\nSasooness Dashboard spreadsheet, and approve it:\n');
  console.log(authUrl + '\n');
  console.log('Waiting for you to finish in the browser...');
});

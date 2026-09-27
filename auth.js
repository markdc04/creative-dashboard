const crypto = require('crypto');

// Every account has a role that decides what it can reach (checked in server.js):
//   'admin'    - everything: leaderboard, creative dashboard, and every client dashboard in full.
//   'creative' - leaderboard + creative dashboard only, no client financial dashboards.
//   'client'   - one client dashboard only (named by `scope`), served the limited client-safe
//                view (no ad spend, no internal campaign/vendor terminology) rather than the
//                internal one admins see at the same URL.
// Usernames are the person's name lowercased with spaces removed ("Jay Pro" -> "jaypro").
// Passwords are stored only as salted scrypt hashes — never in plain text.
const USERS = {
  'jaypro': { name: 'Jay Pro', role: 'admin', hash: '4add571d11b758c13c23136d502e5bad$d604c825afab5ba004e1985ccd03a6461a1e88b9247d7cb917a69ac44fc04957' },
  'brandon': { name: 'Brandon', role: 'admin', hash: 'ca442f3d65cfae8ad3493575a0bb966a$6edc2982acbf3b48c6d5efa644a3aec78a28c62fa4cb275327a66d9704cf731b' },
  'nichole': { name: 'Nichole', role: 'admin', hash: '44cf15a4b6e85eb4654766dad9d959af$9c0d350e594b73e425ff4a26942abbb68b9aac3e95e46538a0197dde88635ada' },
  'alexander': { name: 'Alexander', role: 'admin', hash: '505f58959f0d3075adec831e82150c6d$85ba5a11c7f68e54928cf666da58086f4b63d46f3ddab776fe9805cc9e832862' },
  'christian': { name: 'Christian', role: 'admin', hash: '17372bb3a74d228eeb698dda3e8ba6c0$92754c3cc30fd2bc0e67a47b0c17f7eda0f15e09962d4f03da9954ad5063400a' },
  'zeke': { name: 'Zeke', role: 'admin', hash: 'fcd0dea93211b6b2eada65a8663efe81$f90cb52864ff800e70b35d0cb2fa3af2ef3c247083e9294ac41cf40cbe022294' },
  'rouise': { name: 'Rouise', role: 'admin', hash: '50a79d175085a7e48bf842aa4ec0f490$4b545ee6d806049dec66051142561ae281273a4eb90b36dee72cbdfb9a1171b8' },
  'dominic': { name: 'Dominic', role: 'admin', hash: '24e3e17289dc70a0688192725bbceb39$08ebe479d8ef83d52d4770a7d1e9f89295ada1de040e7e747fa60650a84be7db' },
  'jim': { name: 'Jim', role: 'admin', hash: '8e77818111729ef803e59eba2ccdc40e$7507ae49ccf9378ec69da02f68cd8667da547f992a50d02d0f242fe98f59ef41' },
  'rommel': { name: 'Rommel', role: 'admin', hash: '7808e4830281b18a65598db255e0125a$f5d57fd59e65e13688c95bd78d7b2461c6401fa30277ac39edd26bb05e957f16' },
  'mark': { name: 'Mark', role: 'admin', hash: '89073efa0abb669f9867255aca206b7d$44f95cadbd4269b3b35743ae59590c63bebe8f5298fda3824e9c3050efb94397' },
  // Shared internal creative-team login — leaderboard + creative dashboard only.
  'creatives@loudrmedia.com': { name: 'Creative Team', role: 'creative', hash: '2d712cd8a0a2c30f6fa4088ecf7b4553$036b9268c505db38c5c830b7f71fcbbef52635bc4c7581951846574bc45c4af8' },
  // Client logins — each scoped to exactly one client dashboard, served the limited client view.
  'sasooness@loudrmedia.com': { name: 'Sasooness', role: 'client', scope: 'sasooness', hash: '4679006432a64871638c130aa0a60d01$3878d1fbce67889e751c4c8719374674e5f64ff35b251be312b5cdf5e8cdb504' },
  'km@loudrmedia.com': { name: 'KM Law', role: 'client', scope: 'km', hash: 'bb760d027cb9469b71a59a5dcdb70dfa$c402b63da28ad34e0ecad1b08f786f3d978644712a8e3d9de25dd482ce81ce6c' },
  'bryan@loudrmedia.com': { name: 'Bryan Rodriguez', role: 'client', scope: 'bryan', hash: '1fa8e41615daeaba491b5e6f812d936b$4353ae00349043431d0dcc32c772340307187bd640f76d9a1a019e47a5ae703f' },
};

// Work emails log into the same accounts as the first names.
const EMAILS = { 'brandon@loudrmedia.com': 'brandon', 'jaypro@loudrmedia.com': 'jaypro', 'mark@loudrmedia.com': 'mark', 'alexander@loudrmedia.com': 'alexander' };
for (const [email, key] of Object.entries(EMAILS)) USERS[email] = USERS[key];

// Nichole's work email has its own password (her first-name login keeps the PIN above).
USERS['nichole@loudrmedia.com'] = { name: 'Nichole', role: 'admin', hash: '08ae6184ee540e895fad37d7d90bff23$be3eacdf771e9d8052bc8be30bd6c76f51a817cfa46f6b591b554aa385130ee5' };

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function normalizeUsername(u) { return String(u || '').toLowerCase().replace(/\s+/g, ''); }

function verifyLogin(username, password) {
  const user = USERS[normalizeUsername(username)];
  // Hash even for unknown users so response time doesn't reveal which usernames exist.
  const [salt, hash] = (user ? user.hash : '00$' + '0'.repeat(64)).split('$');
  const attempt = crypto.scryptSync(String(password || ''), salt, 32);
  const ok = crypto.timingSafeEqual(attempt, Buffer.from(hash, 'hex'));
  return user && ok ? { name: user.name, role: user.role || 'admin', scope: user.scope || null } : null;
}

function sign(payload) { return crypto.createHmac('sha256', SECRET).update(payload).digest('hex'); }

function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({ n: user.name, r: user.role, s: user.scope, e: Date.now() + SESSION_MS })).toString('base64url');
  return payload + '.' + sign(payload);
}

function readSession(cookieHeader) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(cookieHeader || '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { n, r, s, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return e > Date.now() ? { name: n, role: r || 'admin', scope: s || null } : null;
  } catch (err) { return null; }
}

// Max 8 failed logins per IP per 15 minutes — PINs are short, so this is what stops guessing.
const failures = new Map(); // ip -> [timestamps]
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
function isLocked(ip) {
  const recent = (failures.get(ip) || []).filter((t) => Date.now() - t < WINDOW_MS);
  failures.set(ip, recent);
  return recent.length >= MAX_FAILS;
}
function noteFailure(ip) { failures.set(ip, [...(failures.get(ip) || []), Date.now()]); }
function clearFailures(ip) { failures.delete(ip); }

module.exports = { verifyLogin, makeSession, readSession, isLocked, noteFailure, clearFailures, SESSION_MS };

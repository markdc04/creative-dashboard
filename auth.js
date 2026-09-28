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
  'alexander': { name: 'Alexander', role: 'admin', hash: 'bbd947259681161154dea49e4fdf12e2$8256b5ea6a5cf9fcd5db9c37e82b46e69e2f6a0cff1007eec1c82486cb09c94e' },
  'christian': { name: 'Christian', role: 'admin', hash: 'c340227add1d7c9fd296d086e04ff0be$43f6c271c90b0f9c8d9d00c09ea8b9d156a68b0c14ffab0ac63e924a3a4d7faf' },
  'zeke': { name: 'Zeke', role: 'admin', hash: 'fcd0dea93211b6b2eada65a8663efe81$f90cb52864ff800e70b35d0cb2fa3af2ef3c247083e9294ac41cf40cbe022294' },
  'rouise': { name: 'Rouise', role: 'admin', hash: '50a79d175085a7e48bf842aa4ec0f490$4b545ee6d806049dec66051142561ae281273a4eb90b36dee72cbdfb9a1171b8' },
  'dominic': { name: 'Dominic', role: 'admin', hash: '24e3e17289dc70a0688192725bbceb39$08ebe479d8ef83d52d4770a7d1e9f89295ada1de040e7e747fa60650a84be7db' },
  'jim': { name: 'Jim', role: 'admin', hash: '8e77818111729ef803e59eba2ccdc40e$7507ae49ccf9378ec69da02f68cd8667da547f992a50d02d0f242fe98f59ef41' },
  'rommel': { name: 'Rommel', role: 'admin', hash: '7808e4830281b18a65598db255e0125a$f5d57fd59e65e13688c95bd78d7b2461c6401fa30277ac39edd26bb05e957f16' },
  'mark': { name: 'Mark', role: 'admin', hash: '89073efa0abb669f9867255aca206b7d$44f95cadbd4269b3b35743ae59590c63bebe8f5298fda3824e9c3050efb94397' },
  // Client logins — each scoped to exactly one dashboard. "leaderboard" is a virtual scope: the
  // creative team's shared login, treated the same as a client account but pointed at the
  // leaderboard (its own already-internal-safe page) instead of a client-public view.
  'creatives@loudrmedia.com': { name: 'Creative Team', role: 'client', scope: 'leaderboard', hash: '7cb210e0adc0d170a11bf5a744819547$362ce966696ebc68503e4f7f93ee9a3c2c1d94ac029d6cf9efe3ed36c0d30924' },
  'sasooness@loudrmedia.com': { name: 'Sasooness', role: 'client', scope: 'sasooness', hash: 'ee940c626b8990a04239f13734c61651$039b9f1d5733b123d0653b66a0752a63dbfa0cb77be21cf1d0b4f0f07cfede3a' },
  'km@loudrmedia.com': { name: 'KM Law', role: 'client', scope: 'km', hash: '1a38deddffac52aa1c302dd5349ed235$99c97d54f375428d57af3c77a2f27bfcc4ba1d130e5de2465eb75e74ecc234f4' },
  'bryan@loudrmedia.com': { name: 'Bryan Rodriguez', role: 'client', scope: 'bryan', hash: '3e545fd7e677ed179c4e550a80422354$646f64e3f0467a4525356aec6c1f0b0b034e4d589674adba366d6cbe82bf0283' },
};

// Work emails log into the same accounts as the first names.
const EMAILS = { 'brandon@loudrmedia.com': 'brandon', 'jaypro@loudrmedia.com': 'jaypro', 'mark@loudrmedia.com': 'mark', 'alexander@loudrmedia.com': 'alexander', 'christian@loudrmedia.com': 'christian' };
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

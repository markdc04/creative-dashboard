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
  'jaypro': { name: 'Jay Pro', role: 'admin', hash: 'a26ee6f3598c9d9f5244d5c2cdd6ff13$5706e650a71d3a80b569dca990e0c011996931e64ec28d3fd5ad56e506721bc5' },
  'brandon': { name: 'Brandon', role: 'admin', hash: '496d7429e6ff53512d4f5e662209290d$bb708f120d8c326800e98333086566e73ef981981a373b50e8c1141a94e1a900' },
  'nichole': { name: 'Nichole', role: 'admin', hash: '46a15057753413aa8cc285c06863d06c$c58cfda8519131e07ba5ac16c895e8fbfa9204554d4c60ba28f0beb54782be47' },
  'alexander': { name: 'Alexander', role: 'admin', hash: 'bbd947259681161154dea49e4fdf12e2$8256b5ea6a5cf9fcd5db9c37e82b46e69e2f6a0cff1007eec1c82486cb09c94e' },
  'christian': { name: 'Christian', role: 'admin', hash: '40ef3eebed2c9acae2e85c0dc3f74481$922da03305826b8c55595b335c61ecd26497dce55bb09de9ffe70465603448db' },
  'zeke': { name: 'Zeke', role: 'admin', hash: '3af14ca169ff676e7d646ebbdc07f310$b78582bba88441fbecf409bdbafd0f1a1f6804695097a01e8536238652ad7540' },
  'rouise': { name: 'Rouise', role: 'admin', hash: '4125cde80ff489c5bcd4ded6455618e2$a2ab0905a8ee7e529c611a03b466a68631150f41aaba061d3cfcceee18e5d930' },
  'dominic': { name: 'Dominic', role: 'admin', hash: 'c955d9312abe66412196cb67442ab48c$a59abcdf9455ebeddc35b71b8545ddd4687cf8860aac4a664c321e8f4a55367d' },
  'jim': { name: 'Jim', role: 'admin', hash: '794ace95fd6d55cf8e34d480b0c99032$dbc1d8d3407114bda103a8e69fd61030c2e7ad90cb6053ece36f1a784603c8f6' },
  'rommel': { name: 'Rommel', role: 'admin', hash: '5b15e578ac6f9ab671cdbf3e22cffd7e$1265a2a2a5a80b9a31e24c729772091bc75a2b5bbb2db464558a8fcf3c6b8208' },
  'mark': { name: 'Mark', role: 'admin', hash: '9061b79503ebb6b600343e654bc3721b$e9e54d9bc992ae6d5ea7605d97d0f47f41434b3636535ffeb5b9c2ec43988823' },
  // Client logins — each scoped to exactly one dashboard. "leaderboard" is a virtual scope: the
  // creative team's shared login, treated the same as a client account but pointed at the
  // leaderboard (its own already-internal-safe page) instead of a client-public view.
  'creatives@loudrmedia.com': { name: 'Creative Team', role: 'client', scope: 'leaderboard', hash: '37d6ca2ee27b7e4a2105f7eebdeb1ae6$000a6c8e9eb3c082f3a3b6461282dfa4bd1bbdfc99bf12ab692c630b50083c04' },
  'sasooness@loudrmedia.com': { name: 'Sasooness', role: 'client', scope: 'sasooness', hash: 'ee940c626b8990a04239f13734c61651$039b9f1d5733b123d0653b66a0752a63dbfa0cb77be21cf1d0b4f0f07cfede3a' },
  'km@loudrmedia.com': { name: 'KM Law', role: 'client', scope: 'km', hash: '1a38deddffac52aa1c302dd5349ed235$99c97d54f375428d57af3c77a2f27bfcc4ba1d130e5de2465eb75e74ecc234f4' },
  'bryan@loudrmedia.com': { name: 'Bryan Rodriguez', role: 'client', scope: 'bryan', hash: '3e545fd7e677ed179c4e550a80422354$646f64e3f0467a4525356aec6c1f0b0b034e4d589674adba366d6cbe82bf0283' },
};

// Work emails log into the same accounts as the first names.
const EMAILS = { 'brandon@loudrmedia.com': 'brandon', 'jaypro@loudrmedia.com': 'jaypro', 'mark@loudrmedia.com': 'mark', 'alexander@loudrmedia.com': 'alexander', 'christian@loudrmedia.com': 'christian', 'jimboy@loudrmedia.com': 'jim' };
for (const [email, key] of Object.entries(EMAILS)) USERS[email] = USERS[key];

// Nichole's work email has its own password (her first-name login keeps the PIN above).
USERS['nichole@loudrmedia.com'] = { name: 'Nichole', role: 'admin', hash: '5b7064f6874ca0917f1f376e0b3f5cc5$6eed395b60236d39c4fefec679740a057e4f338f292a3e6da3ef6551a6d56689' };
USERS['nik@cmosolutionsgroup.com'] = { name: 'Nik', role: 'admin', hash: 'ab082950d3f12adfd063731f014e7e3d$5062de0e3cb28972f00ea56684c82bc979da208eeea6a46d1c579ed719b25070' };

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

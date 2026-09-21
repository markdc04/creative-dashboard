const crypto = require('crypto');

// Usernames are the person's name lowercased with spaces removed ("Jay Pro" -> "jaypro").
// Passwords are stored only as salted scrypt hashes — never in plain text.
const USERS = {
  'jaypro': { name: 'Jay Pro', hash: '4add571d11b758c13c23136d502e5bad$d604c825afab5ba004e1985ccd03a6461a1e88b9247d7cb917a69ac44fc04957' },
  'brandon': { name: 'Brandon', hash: 'ca442f3d65cfae8ad3493575a0bb966a$6edc2982acbf3b48c6d5efa644a3aec78a28c62fa4cb275327a66d9704cf731b' },
  'nichole': { name: 'Nichole', hash: '4f58e9147af730e85069ae17bab58940$bc1fafa9038167f59778c5b6115633c2d088efec445339cb70a8331a989e6813' },
  'alexander': { name: 'Alexander', hash: '505f58959f0d3075adec831e82150c6d$85ba5a11c7f68e54928cf666da58086f4b63d46f3ddab776fe9805cc9e832862' },
  'christian': { name: 'Christian', hash: '17372bb3a74d228eeb698dda3e8ba6c0$92754c3cc30fd2bc0e67a47b0c17f7eda0f15e09962d4f03da9954ad5063400a' },
  'zeke': { name: 'Zeke', hash: 'fcd0dea93211b6b2eada65a8663efe81$f90cb52864ff800e70b35d0cb2fa3af2ef3c247083e9294ac41cf40cbe022294' },
  'rouise': { name: 'Rouise', hash: '50a79d175085a7e48bf842aa4ec0f490$4b545ee6d806049dec66051142561ae281273a4eb90b36dee72cbdfb9a1171b8' },
  'dominic': { name: 'Dominic', hash: '24e3e17289dc70a0688192725bbceb39$08ebe479d8ef83d52d4770a7d1e9f89295ada1de040e7e747fa60650a84be7db' },
  'jim': { name: 'Jim', hash: '8e77818111729ef803e59eba2ccdc40e$7507ae49ccf9378ec69da02f68cd8667da547f992a50d02d0f242fe98f59ef41' },
  'rommel': { name: 'Rommel', hash: '7808e4830281b18a65598db255e0125a$f5d57fd59e65e13688c95bd78d7b2461c6401fa30277ac39edd26bb05e957f16' },
  'mark': { name: 'Mark', hash: '89073efa0abb669f9867255aca206b7d$44f95cadbd4269b3b35743ae59590c63bebe8f5298fda3824e9c3050efb94397' },
};

// Work emails log into the same accounts as the first names.
const EMAILS = { 'brandon@loudrmedia.com': 'brandon', 'jaypro@loudrmedia.com': 'jaypro', 'mark@loudrmedia.com': 'mark', 'alexander@loudrmedia.com': 'alexander' };
for (const [email, key] of Object.entries(EMAILS)) USERS[email] = USERS[key];

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function normalizeUsername(u) { return String(u || '').toLowerCase().replace(/\s+/g, ''); }

function verifyLogin(username, password) {
  const user = USERS[normalizeUsername(username)];
  // Hash even for unknown users so response time doesn't reveal which usernames exist.
  const [salt, hash] = (user ? user.hash : '00$' + '0'.repeat(64)).split('$');
  const attempt = crypto.scryptSync(String(password || ''), salt, 32);
  const ok = crypto.timingSafeEqual(attempt, Buffer.from(hash, 'hex'));
  return user && ok ? user.name : null;
}

function sign(payload) { return crypto.createHmac('sha256', SECRET).update(payload).digest('hex'); }

function makeSession(name) {
  const payload = Buffer.from(JSON.stringify({ n: name, e: Date.now() + SESSION_MS })).toString('base64url');
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
    const { n, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return e > Date.now() ? n : null;
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

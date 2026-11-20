// Picks the one row in a shared-campaign lead log (Walker's) that a client's lead actually came
// from, so the lead's campaign + ad are the ones of that exact form submission. Used by Bryan, Ruy
// and Sasooness so all three attribute the same way.
//
// Rules, in order:
//  1. Identity: an email or phone match is a real match. A name-only match counts only when it
//     doesn't contradict the lead — a row whose phone (or email) differs from the lead's, when
//     both sides have one, is a different person with the same name and is thrown out.
//  2. Date: a submission logged on/before the day the client got the lead beats one logged after
//     (a resubmission after delivery isn't where it came from); among those, the closest day wins,
//     so a same-day submission beats an older one from the same person.
//  3. Ties: a stronger identity match (email/phone over name), then the primary log over a
//     backup tab (`backup: true`), then the earliest row.
const { phone10 } = require('./csv-utils');

const normName = (v) => String(v || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const days = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

function pickOrigin(lead, rows, { maxDays = Infinity } = {}) {
  const email = (lead.emails && lead.emails.length ? lead.emails : [lead.email]).map((e) => (e || '').trim().toLowerCase()).filter(Boolean);
  const phone = phone10(lead.phone);
  const name = normName(lead.name);
  let best = null, bestScore = null;
  for (const w of rows) {
    if (!w.date) continue;
    const gap = days(w.date, lead.createdDate);
    if (Math.abs(gap) > maxDays) continue;
    const emailHit = !!(w.email && email.includes(w.email));
    const phoneHit = !!(phone && w.phone && w.phone === phone);
    const nameHit = !!(name && w.name && w.name === name);
    if (!emailHit && !phoneHit && !nameHit) continue;
    // Name-only: drop it if the row's contact details contradict the lead's.
    if (!emailHit && !phoneHit) {
      if (phone && w.phone && w.phone !== phone) continue;
      if (email.length && w.email && !email.includes(w.email)) continue;
    }
    const score = [
      gap > 0 ? 1 : 0,                        // on/before the client's date first (a lead can't
                                              // come from a form filled after it was delivered)
      Math.abs(gap),                          // then the closest day — same day wins
      emailHit || phoneHit ? 0 : 1,           // then email/phone over name
      w.backup ? 1 : 0,                       // then the primary log over a backup tab
      w.date,                                 // then earliest
    ];
    if (!bestScore || less(score, bestScore)) { best = w; bestScore = score; }
  }
  return best;
}
function less(a, b) {
  for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; }
  return false;
}

module.exports = { pickOrigin, normName };

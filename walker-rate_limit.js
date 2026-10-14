// Shared rate limiter for the Google Sheets API, required by dashboard_sync.js, mirror_sync.js,
// and server.js so all three — running in the same Node process, authenticated as the same
// account — draw from ONE process-wide queue instead of firing independently. Without this,
// dashboard_sync's runSync, mirror_sync's runMirror, server.js's runLiveCampaigns/pollAll, and the
// on-demand campaign-trends/late-qmva-correlation endpoints regularly collided and blew past
// Google's 60-requests-per-minute-per-user quota, causing 429s that served stale or partial data
// (confirmed live: a lead that had just confirmed was missing from a dashboard read for several
// minutes because that read got serialized behind a quota wait with no visibility into it).
//
// Node's module cache means every `require('./rate_limit')` in this process resolves to the same
// singleton instance below, so the counters here are shared across every caller automatically.

const MAX_PER_MINUTE = 55; // headroom under Google's 60/min cap, shared across every caller
const WINDOW_MS = 60000;
let timestamps = [];
const queue = [];
let draining = false;

function prune() {
  const cutoff = Date.now() - WINDOW_MS;
  while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    prune();
    if (timestamps.length >= MAX_PER_MINUTE) {
      const waitMs = WINDOW_MS - (Date.now() - timestamps[0]) + 50;
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 50)));
      continue;
    }
    const { fn, resolve, reject } = queue.shift();
    timestamps.push(Date.now());
    // Fire the call and move straight on to the next queued item — only the RATE of starting new
    // calls is throttled (<= MAX_PER_MINUTE new dispatches per rolling minute), not how long each
    // call takes to finish. Awaiting each call here before dispatching the next would serialize
    // every request behind the one before it regardless of how many the caller intended to run
    // concurrently via Promise.all — confirmed this was exactly what happened: a Promise.all of
    // ~10 independent reads was taking as long as 10 full network round-trips in sequence instead
    // of running together, turning a ~2 minute sync into 10+ minutes with no error at all.
    fn().then(resolve, reject);
  }
  draining = false;
}

function throttledCall(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}

// One retry on a 429/RESOURCE_EXHAUSTED, after waiting out a full fresh window — covers the case
// where Google's own quota window doesn't line up with ours, or another process (e.g. a manual
// local sync run against the same account) ate into the same quota from outside this queue.
async function withRetry(fn) {
  try {
    return await throttledCall(fn);
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429') || msg.includes('Quota exceeded')) {
      await new Promise((r) => setTimeout(r, WINDOW_MS));
      return throttledCall(fn);
    }
    throw err;
  }
}

module.exports = { withRetry };

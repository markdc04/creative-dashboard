// Persists admin-chosen KPI tile orderings per dashboard/program, e.g. { sasooness: { agency:
// ['Signed Cases', 'Total Leads', ...], ppl: [...] } }. A flat JSON file is plenty — this changes
// rarely and only ever from one admin account (see server.js's /api/layout route).
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'layout-settings.json');

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (err) { return {}; }
}

function get(board, program) {
  const all = readAll();
  return (all[board] && all[board][program]) || null;
}

function set(board, program, order) {
  const all = readAll();
  if (!all[board]) all[board] = {};
  all[board][program] = order;
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

module.exports = { get, set };

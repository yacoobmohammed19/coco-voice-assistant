// Scheduled callbacks: "Coco, call me back in 20 minutes". At the due time the phone gets an urgent
// ntfy push that opens Coco's incoming-call screen. Persisted so a server restart doesn't lose them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('./config');
const notify = require('./notify');

const FILE = path.join(DATA, 'rings.json');
let rings = [];
let cfgRef = null;
let hooks = {};
const timers = new Map();

function persist() {
  try { fs.writeFileSync(FILE, JSON.stringify(rings.slice(-100), null, 2)); } catch { /* best effort */ }
}

async function fire(r) {
  timers.delete(r.id);
  if (r.firedAt) return;
  r.firedAt = Date.now();
  persist();
  // Prefer a real phone call; fall back to the push if the phone isn't set up or the call fails.
  if (hooks.call) {
    try { if (await hooks.call(r)) return; } catch (e) { console.error('[rings] phone call failed:', e.message); }
  }
  const url = cfgRef.publicUrl ? `${cfgRef.publicUrl}/?ring=${r.id}` : undefined;
  await notify.push(cfgRef, { title: 'Coco is calling', message: 'Tap to answer', url });
}

function arm(r) {
  const delay = Math.max(0, r.at - Date.now());
  if (delay > 2 ** 31 - 1) return; // >24 days, not supported
  timers.set(r.id, setTimeout(() => fire(r), delay));
}

function init(cfg, h = {}) {
  cfgRef = cfg;
  hooks = h;
  try { rings = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { rings = []; }
  // Re-arm anything still pending; skip ones more than 10 minutes overdue (stale after downtime).
  for (const r of rings) if (!r.firedAt && r.at > Date.now() - 10 * 60_000) arm(r);
}

function schedule(seconds, reason) {
  const r = { id: 'r-' + crypto.randomBytes(3).toString('hex'), at: Date.now() + seconds * 1000, reason: String(reason).slice(0, 300), createdAt: Date.now() };
  rings.push(r);
  persist();
  arm(r);
  return r;
}

function get(id) { return rings.find((r) => r.id === id); }

module.exports = { init, schedule, get };

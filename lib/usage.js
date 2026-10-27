// Daily usage counters ($DATA/usage.json): makes Gemini spend visible on /health and lets Live calls be
// capped per day. Days are SAST; only the last 14 are kept.
const fs = require('fs');
const path = require('path');
const { DATA } = require('./config');

const FILE = path.join(DATA, 'usage.json');
let data = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } })();

const day = () => new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);

function add(name, n = 1) {
  if (!n) return;
  const d = day();
  const t = data[d] || (data[d] = {});
  t[name] = Math.round(((t[name] || 0) + n) * 100) / 100;
  for (const k of Object.keys(data).sort().slice(0, -14)) delete data[k];
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data, null, 1)); } catch { /* counters are best-effort */ }
}

const today = () => data[day()] || {};

// Minutes of Gemini Live left today (Infinity when no cap). Live audio is the biggest line on the bill.
const liveLeft = (cfg) => (cfg.liveDailyMinutes > 0 ? cfg.liveDailyMinutes - (today().liveMinutes || 0) : Infinity);

module.exports = { add, today, liveLeft };

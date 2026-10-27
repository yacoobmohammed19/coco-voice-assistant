// Daily usage counters ($DATA/usage.json): makes Gemini spend visible on /health and enforces the Live
// budget. Days are SAST; the last 14 are kept, plus a running total for the budget period.
const fs = require('fs');
const path = require('path');
const { DATA } = require('./config');

const FILE = path.join(DATA, 'usage.json');
let data = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } })();

const day = () => new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
const round = (n) => Math.round(n * 10000) / 10000;

function save() {
  for (const k of Object.keys(data).filter((k) => /^\d{4}-/.test(k)).sort().slice(0, -14)) delete data[k];
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(data, null, 1)); } catch { /* counters are best-effort */ }
}

function add(name, n = 1) {
  if (!n) return;
  const t = data[day()] || (data[day()] = {});
  t[name] = round((t[name] || 0) + n);
  save();
}

const today = () => data[day()] || {};

// USD per million tokens. Live audio is billed far above text; override with livePrices in config when
// Google's price list changes.
const PRICES = { audioIn: 3, textIn: 0.5, audioOut: 12, textOut: 2 };
const byModality = (details, mod) => (details || []).filter((d) => d.modality === mod).reduce((s, d) => s + (d.tokenCount || 0), 0);

// One Live usageMetadata message -> USD. Without a modality breakdown everything counts as audio (dearer, so safe).
function liveCost(cfg, m) {
  const p = { ...PRICES, ...(cfg.livePrices || {}) };
  const inAll = (m.promptTokenCount || 0) + (m.toolUsePromptTokenCount || 0);
  const outAll = m.responseTokenCount ?? Math.max(0, (m.totalTokenCount || 0) - (m.promptTokenCount || 0));
  const inAudio = m.promptTokensDetails ? byModality(m.promptTokensDetails, 'AUDIO') : inAll;
  const outAudio = m.responseTokensDetails ? byModality(m.responseTokensDetails, 'AUDIO') : outAll;
  const usd = inAudio * p.audioIn + (inAll - inAudio) * p.textIn + outAudio * p.audioOut + (outAll - outAudio + (m.thoughtsTokenCount || 0)) * p.textOut;
  return usd / 1e6;
}

// Spend so far in the current budget period (resets when geminiBudgetUntil changes).
function total(cfg) {
  if (!data.total || data.total.until !== cfg.geminiBudgetUntil) data.total = { until: cfg.geminiBudgetUntil, usd: 0 };
  return data.total;
}

function addLive(cfg, meta) {
  const usd = liveCost(cfg, meta || {});
  if (!usd) return 0;
  total(cfg).usd = round(total(cfg).usd + usd);
  add('liveUsd', usd);
  return usd;
}

// USD Coco may still spend on Live today: what's left of the budget spread evenly over the days left,
// so quiet days roll over. Infinity when no budget is set.
function liveUsdLeft(cfg) {
  if (!(cfg.geminiBudgetUsd > 0)) return Infinity;
  const left = cfg.geminiBudgetUsd - total(cfg).usd;
  const spentToday = today().liveUsd || 0;
  const days = Math.max(1, Math.round((Date.parse(cfg.geminiBudgetUntil) - Date.parse(day())) / 86400_000) + 1);
  return Math.min(left, (left + spentToday) / days - spentToday);
}

// Minutes of Live left today under liveDailyMinutes (Infinity when no cap).
const liveLeft = (cfg) => (cfg.liveDailyMinutes > 0 ? cfg.liveDailyMinutes - (today().liveMinutes || 0) : Infinity);
const liveOk = (cfg) => liveLeft(cfg) >= 1 && liveUsdLeft(cfg) > 0.005;

const summary = (cfg) => ({ ...today(), budget: cfg.geminiBudgetUsd > 0 ? { usd: cfg.geminiBudgetUsd, until: cfg.geminiBudgetUntil, spent: total(cfg).usd, leftToday: round(Math.max(0, liveUsdLeft(cfg))) } : null });

module.exports = { add, today, addLive, liveLeft, liveUsdLeft, liveOk, summary, liveCost };

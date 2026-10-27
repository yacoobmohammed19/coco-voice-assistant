// Coco changing itself (owner's request on Telegram, 2026-10-27: "change config, add tools, install stuff
// without me at the PC"). Three pieces:
// - settings: a short allowlist of non-secret config keys Coco may set directly (set_config action).
// - secrets: "/key <name> <value>" on Telegram, handled in code so the value never reaches a model or a log.
// - code/tool changes: an admin job edits the repo, then restart() checks it and restarts; a boot guard rolls
//   back to the last good commit if the new code won't stay up.
// Only depends on node built-ins so it still works when the rest of the code is broken.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.COCO_VOICE_DATA || path.join(os.homedir(), '.coco-voice');
const CONFIG_FILE = path.join(DATA, 'config.json');
const MARK = path.join(DATA, 'update.json');       // { good, reason, boots, at } while an update is on probation
const NOTICE = path.join(DATA, 'send-once.md');    // server.js sends this to Telegram once it's connected

// A fixed identity so commits and rebases work even if git on the PC was never configured.
const git = (...args) => execFileSync('git', ['-c', 'user.name=Coco', '-c', 'user.email=coco@localhost', ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120_000 }).trim();
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };
const notice = (text) => { try { fs.appendFileSync(NOTICE, (fs.existsSync(NOTICE) ? '\n\n' : '') + text); } catch {} };

// ── Settings ──
const num = (min, max) => (v) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`must be a number from ${min} to ${max}`); return n; };
const oneOf = (...xs) => (v) => { if (!xs.includes(v)) throw new Error(`must be one of ${xs.join(', ')}`); return v; };
const str = (re) => (v) => { if (typeof v !== 'string' || !re.test(v)) throw new Error('not a valid value'); return v; };
const bool = (v) => { if (typeof v === 'boolean') return v; if (/^(true|on|yes)$/i.test(v)) return true; if (/^(false|off|no)$/i.test(v)) return false; throw new Error('must be true or false'); };
const MODEL = str(/^[\w.\-[\]]{2,60}$/);
const SETTINGS = {
  chatBrain: oneOf('claude', 'gemini'), talkModel: MODEL, jobModel: MODEL, quickJobModel: MODEL, jobEffort: oneOf('low', 'medium', 'high', 'xhigh', 'max'),
  jobTimeoutMin: num(5, 240), maxConcurrentJobs: num(1, 5),
  geminiBudgetUsd: num(0, 1000), geminiBudgetUntil: str(/^\d{4}-\d{2}-\d{2}$/), liveMaxMinutes: num(1, 60), liveDailyMinutes: num(0, 600),
  liveRecentChars: num(0, 30000), geminiPaidForAll: bool, geminiChatModel: MODEL, geminiTextModel: MODEL, geminiTtsModel: MODEL, embedModel: MODEL,
  quietHours: (v) => { const a = typeof v === 'string' ? v.split(/[^\d]+/).filter(Boolean).map(Number) : v; if (!Array.isArray(a) || a.length !== 2 || a.some((h) => !(h >= 0 && h <= 23))) throw new Error('give two hours, e.g. [22, 7]'); return a; },
  memoryHour: num(0, 23), selftestHour: num(0, 23), callOnJobDone: bool, waSweepMinutes: num(0, 1440), socialSweepMinutes: num(0, 1440),
};
const SECRETS = ['geminiApiKey', 'geminiFreeApiKey', 'groqApiKey', 'anthropicApiKey', 'claudeOAuthToken'];

// Writes the raw config.json (config.save() would drop keys it has no default for) and updates the live cfg.
function setConfig(cfg, key, value) {
  const check = SETTINGS[key];
  if (!check) return { error: `${key} can't be changed from chat. Settable: ${Object.keys(SETTINGS).join(', ')}. Anything else needs an admin job.` };
  let v;
  try { v = check(value); } catch (e) { return { error: `${key} ${e.message}` }; }
  const raw = readJson(CONFIG_FILE, {});
  const old = raw[key] ?? cfg[key];
  raw[key] = v;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
  cfg[key] = v;
  return { ok: true, key, old, value: v };
}
const showConfig = (cfg) => Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, cfg[k]]));

// "/key groqApiKey gsk_..." -> saved, and the message is deleted from the chat. Returns the reply or null.
function keyCommand(cfg, text) {
  const m = String(text).match(/^\s*\/key\s+(\w+)\s+(\S+)\s*$/);
  if (!m) return /^\s*\/key\b/.test(text) ? `Use: /key <name> <value>. Names: ${SECRETS.join(', ')}` : null;
  if (!SECRETS.includes(m[1])) return `Unknown key name. Use one of: ${SECRETS.join(', ')}`;
  const raw = readJson(CONFIG_FILE, {});
  raw[m[1]] = m[2];
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
  cfg[m[1]] = m[2];
  return `Saved ${m[1]} (…${m[2].slice(-4)}). I've deleted your message so the key isn't left in the chat.`;
}

// ── Code changes and restarts ──
// Remember the commit to fall back to before an admin job or update touches the repo.
function snapshot() {
  try {
    const good = git('rev-parse', 'HEAD');
    fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.bak');
    return good;
  } catch (e) { console.error('[selfupdate] snapshot failed:', e.message); return null; }
}

function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Problems that must never ship: syntax errors, a public bind, an unreadable config.
function check() {
  const bad = [];
  for (const f of jsFiles(ROOT)) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe', windowsHide: true }); } catch (e) { bad.push(`${path.relative(ROOT, f)}: ${String(e.stderr || e.message).split('\n').find((l) => /Error/.test(l)) || 'syntax error'}`); }
  }
  const raw = readJson(CONFIG_FILE, null);
  if (!raw) bad.push('config.json is not valid JSON');
  else if (raw.host && !['127.0.0.1', 'localhost'].includes(raw.host)) bad.push(`config host is ${raw.host}; Coco must only listen on 127.0.0.1`);
  return bad;
}

function rollback(good, why) {
  try { git('reset', '--hard', good); } catch (e) { console.error('[selfupdate] git reset failed:', e.message); }
  try { if (fs.existsSync(CONFIG_FILE + '.bak') && !readJson(CONFIG_FILE, null)) fs.copyFileSync(CONFIG_FILE + '.bak', CONFIG_FILE); } catch {}
  try { fs.unlinkSync(MARK); } catch {}
  notice(`⚠️ Update rolled back to ${good.slice(0, 7)}: ${why}`);
}

// An admin job may leave edits uncommitted; commit them so a rollback has a clean point to return from.
function commitAll(message) {
  try {
    if (!git('status', '--porcelain')) return false;
    git('add', '-A');
    git('commit', '-m', message);
    return true;
  } catch (e) { console.error('[selfupdate] commit failed:', e.message); return false; }
}

// Check the new code, then exit so start.ps1 starts it (within 5 s). waitFor() lets running jobs finish first.
async function restart(good, reason, { force = false, waitFor = () => false, say = () => {} } = {}) {
  const bad = check();
  if (bad.length) {
    if (good) rollback(good, bad.join('; ').slice(0, 600));
    return { ok: false, problems: bad };
  }
  const head = git('rev-parse', 'HEAD');
  if (good && head === good && !force) return { ok: true, unchanged: true };
  for (let i = 0; i < 60 && waitFor(); i++) await new Promise((r) => setTimeout(r, 30_000));
  if (good && head !== good) fs.writeFileSync(MARK, JSON.stringify({ good, head, reason, boots: 0, at: new Date().toISOString() }));
  say(`Restarting to apply: ${reason}. Back in a few seconds.`);
  setTimeout(() => process.exit(0), 3000);
  return { ok: true, restarting: true };
}

// Pull the latest code from GitHub (keeps any local admin commits on top), install changed deps, restart.
async function update(cfg, opts) {
  const good = snapshot();
  const before = good;
  try {
    git('fetch', 'origin', 'main');
    git('pull', '--rebase', '--autostash', 'origin', 'main');
  } catch (e) {
    try { git('rebase', '--abort'); } catch {}
    return { ok: false, problems: [`git pull failed: ${e.message.split('\n')[0]}`] };
  }
  const changed = git('diff', '--name-only', before, 'HEAD').split('\n').filter(Boolean);
  if (!changed.length) return { ok: true, unchanged: true };
  try {
    if (changed.some((f) => f.startsWith('whatsapp/package'))) execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev'], { cwd: path.join(ROOT, 'whatsapp'), stdio: 'pipe', shell: process.platform === 'win32', timeout: 600_000 });
    if (changed.some((f) => /^telegram\/requirements/.test(f))) execFileSync(cfg.pythonExe || 'python', ['-m', 'pip', 'install', '-r', path.join(ROOT, 'telegram', 'requirements.txt')], { stdio: 'pipe', timeout: 600_000 });
  } catch (e) { return { ok: false, problems: [`dependency install failed: ${e.message.split('\n')[0]}`] }; }
  return restart(good, `update ${before.slice(0, 7)} → ${git('rev-parse', '--short', 'HEAD')} (${changed.length} files)`, { ...opts, force: true });
}

// Call FIRST in server.js. While an update is on probation, count boots; if it keeps crashing, roll back.
function bootGuard() {
  const m = readJson(MARK, null);
  if (!m) return;
  m.boots = (m.boots || 0) + 1;
  if (m.boots > 3) {
    rollback(m.good, `the new code (${String(m.head).slice(0, 7)}) crashed ${m.boots - 1} times on start`);
    process.exit(1);
  }
  fs.writeFileSync(MARK, JSON.stringify(m)); // probation() clears it once Coco stays up
}

// Called once the server is listening: two minutes up means the update is good.
function probation() {
  const m = readJson(MARK, null);
  if (!m) return;
  setTimeout(() => {
    try { fs.unlinkSync(MARK); } catch {}
    notice(`✅ Update is live (${String(m.head).slice(0, 7)}): ${m.reason}`);
  }, 120_000).unref();
}

module.exports = { commitAll, setConfig, showConfig, keyCommand, snapshot, restart, update, bootGuard, probation, SETTINGS, SECRETS, git };

// Daily self-test: exercises each piece Coco depends on, end to end, and reports ONLY failures
// (Telegram, queued if it's down, plus a push). Result is kept for /health and the morning check.
const fs = require('fs');
const path = require('path');
const { DATA } = require('./config');

const FILE = path.join(DATA, 'selftest.json');
let lastResult = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } })();

async function check(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Date.now() - t, detail: detail || '' };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t, detail: String(e.message || e).slice(0, 300) };
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

async function run(cfg, d) {
  const checks = await Promise.all([
    check('Gemini chat brain', async () => {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiChatModel}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': cfg.geminiApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }),
        signal: AbortSignal.timeout(30000),
      });
      must(res.ok, `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
    }),
    check('Voice calls (Gemini Live token)', async () => { must(await d.live.mintToken(cfg, cfg.persona), 'no token'); }),
    check('Claude worker login', async () => {
      const res = await d.claude.run(cfg, ['--model', 'haiku', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence'], 'Reply with the single word: ok', { cwd: DATA, timeoutMs: 90_000 });
      must(!d.claude.authProblem(res), 'Claude CLI is logged out: jobs will fail until it is logged in again');
      must(res.json && !res.json.is_error, (res.json?.result || res.stderr || 'CLI failed').slice(0, 200));
    }),
    check('Vault search', async () => {
      const hits = await d.vault.smartSearch(cfg, 'CocoCorp websites clients', 3);
      must(hits.length, 'no results');
      const s = d.semantic.stats();
      must(s.passages > 0, 'meaning-search index is empty');
      must(Date.now() - s.builtAt < 6 * 3600_000 || s.building, 'meaning-search index is stale (no refresh in 6h)');
      return `${s.passages} passages`;
    }),
    check('Telegram', async () => { must(d.telegram.healthy(), 'not connected'); if (d.telegram.queued()) return `${d.telegram.queued()} queued`; }),
    check('WhatsApp', async () => { const s = await d.waStatus(); must(s.connected, s.note || s.error || 'not connected'); }),
    check('Memory', async () => {
      const last = d.memory.lastRun();
      must(!last || Date.now() - Date.parse(last) < 50 * 3600_000, `nightly memory pass hasn't run since ${last}`);
    }),
    check('Disk & logs', async () => {
      const st = fs.statfsSync(DATA);
      const freeGb = (st.bavail * st.bsize) / 1e9;
      must(freeGb > 5, `only ${freeGb.toFixed(1)} GB free on the PC`);
      const log = path.join(DATA, 'server.log');
      const mb = fs.existsSync(log) ? fs.statSync(log).size / 1e6 : 0;
      must(mb < 60, `server.log is ${mb.toFixed(0)} MB`);
      return `${freeGb.toFixed(0)} GB free`;
    }),
  ]);
  lastResult = { at: new Date().toISOString(), ok: checks.every((c) => c.ok), checks };
  try { fs.writeFileSync(FILE, JSON.stringify(lastResult, null, 1)); } catch {}
  console.log(`[selftest] ${lastResult.ok ? 'all passed' : 'FAILED: ' + checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join('; ')}`);
  return lastResult;
}

const last = () => (lastResult ? { at: lastResult.at, ok: lastResult.ok, failed: lastResult.checks.filter((c) => !c.ok).map((c) => c.name) } : null);

module.exports = { run, last };

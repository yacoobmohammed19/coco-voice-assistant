// One conversational turn: transcript in -> {say, action} out.
// Uses the Anthropic API if a key is configured (fast), else the Claude Code CLI on your subscription (free),
// or Gemini when chatBrain is 'gemini'.
const fs = require('fs');
const path = require('path');
const { DATA } = require('./config');
const claude = require('./claude');
const gemini = require('./gemini');

const PROMPT_FILE = path.join(__dirname, 'brain-prompt.md');
const API_MODELS = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };

function renderTranscript(history, context) {
  const lines = history.slice(-24).map((m) => `${m.role === 'user' ? 'OWNER' : m.role === 'tool' ? 'SYSTEM' : 'COCO'}: ${m.text}`);
  const now = new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Right now it is ${now} (South African time). Any greeting must match the time of day.\n\n${context ? `Context:\n${context}\n\n` : ''}Call transcript so far:\n${lines.join('\n')}\n\nRespond as Coco with the JSON object only.`;
}

// The model should answer with ONE JSON object, but sometimes sends an array, two objects back to back,
// or wraps it in a code fence. Take the first complete object that has "say"; never show raw JSON to him.
function objects(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k < s.length; k++) {
      const c = s[k];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { out.push(s.slice(i, k + 1)); i = k; break; }
    }
  }
  return out;
}
function parse(text) {
  const s = String(text || '');
  const pick = (j) => (j && typeof j.say === 'string' ? { say: j.say, action: j.action || null } : null);
  try {
    const j = JSON.parse(s.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const r = Array.isArray(j) ? j.map(pick).find(Boolean) : pick(j);
    if (r) return r;
  } catch { /* fall through */ }
  for (const o of objects(s)) {
    try { const r = pick(JSON.parse(o)); if (r) return r; } catch { /* next */ }
  }
  // Last resort: pull out just the "say" text; never send JSON fragments to him.
  const m = s.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) { try { return { say: JSON.parse(`"${m[1]}"`), action: null }; } catch { return { say: m[1], action: null }; } }
  return { say: /[{}]/.test(s) ? "Sorry, I lost my train of thought. Say that again?" : s.trim().slice(0, 400), action: null };
}

async function viaApi(cfg, system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': cfg.anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: API_MODELS[cfg.talkModel] || cfg.talkModel,
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.content.map((c) => c.text || '').join('');
}

async function viaCli(cfg, user) {
  const res = await claude.run(cfg, [
    '--model', cfg.talkModel,
    '--output-format', 'json',
    '--system-prompt-file', PROMPT_FILE,
    '--tools', '',
    '--strict-mcp-config',
    '--no-session-persistence',
  ], user, { cwd: DATA, timeoutMs: 60_000 });
  if (claude.authProblem(res) || !res.json || res.json.is_error) {
    const err = new Error(res.json?.result || res.stderr || 'claude CLI failed');
    err.auth = claude.authProblem(res);
    throw err;
  }
  return res.json?.result ?? res.stdout;
}

// Conversational turns on Gemini: faster than the CLI but billed per token (free-tier key first, see lib/gemini.js).
async function viaGemini(cfg, system, user, think = false) {
  try {
    const j = await gemini.call(cfg, `models/${cfg.geminiChatModel}:generateContent`, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.6, responseMimeType: 'application/json', ...(think ? {} : { thinkingConfig: { thinkingBudget: 0 } }) },
    }, { what: 'chat', timeoutMs: 45000 });
    return gemini.text(j);
  } catch (e) {
    if (e.status === 400 && !think) return viaGemini(cfg, system, user, true);
    throw e;
  }
}

// Claude on the subscription by default (no per-token bill); Gemini is the backup if Claude fails, and the
// other way round when chatBrain is 'gemini'.
async function turn(cfg, history, context) {
  const system = fs.readFileSync(PROMPT_FILE, 'utf8');
  const user = renderTranscript(history, context);
  const viaClaude = () => (cfg.anthropicApiKey ? viaApi(cfg, system, user) : viaCli(cfg, user));
  const order = cfg.chatBrain === 'gemini' ? ['gemini', 'claude'] : ['claude', 'gemini'];
  let firstErr;
  for (const b of order) {
    if (b === 'gemini' && !gemini.hasKey(cfg)) continue;
    try { return parse(await (b === 'gemini' ? viaGemini(cfg, system, user) : viaClaude())); } catch (e) {
      console.error(`[brain] ${b} failed:`, e.message);
      firstErr = firstErr || e;
    }
  }
  throw firstErr;
}

module.exports = { turn, parse };

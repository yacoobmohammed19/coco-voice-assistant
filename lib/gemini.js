// Gemini REST calls for everything except voice calls. The billed key (geminiApiKey) is kept for Gemini
// Live only; background work (embeddings, voice notes, TTS, backup chat) uses the free-tier key
// (geminiFreeApiKey, from a Google project WITHOUT billing) and simply fails when its quota is used up.
// geminiPaidForAll: true lets it fall back to the billed key instead.
const usage = require('./usage');

const API = 'https://generativelanguage.googleapis.com/v1beta';
const keysFor = (cfg) => [cfg.geminiFreeApiKey, cfg.geminiPaidForAll && cfg.geminiApiKey].filter(Boolean);
const hasKey = (cfg) => keysFor(cfg).length > 0;

async function call(cfg, endpoint, body, { what = 'gemini', timeoutMs = 30000 } = {}) {
  const keys = keysFor(cfg);
  if (!keys.length) throw new Error('no free-tier Gemini key (geminiFreeApiKey)');
  let res, i = 0;
  for (; i < keys.length; i++) {
    res = await fetch(`${API}/${endpoint}`, {
      method: 'POST',
      headers: { 'x-goog-api-key': keys[i], 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 429 || i === keys.length - 1) break;
  }
  const paid = keys[i] === cfg.geminiApiKey;
  if (!res.ok) {
    const err = new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  usage.add(`${what}${paid ? 'Paid' : 'Free'}Calls`);
  if (paid) usage.add(`${what}PaidTokens`, j.usageMetadata?.totalTokenCount || 0);
  return j;
}

const text = (j) => ((j.candidates || [])[0]?.content?.parts || []).map((p) => p.text || '').join('');

module.exports = { call, text, hasKey, keysFor, API };

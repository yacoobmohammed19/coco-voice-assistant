// Gemini REST calls for background work. Tries the free-tier key (geminiFreeApiKey, a key from a Google
// project WITHOUT billing) first and only spends on the billed key when the free quota is used up (429).
// Token counts go to lib/usage.js so the spend is visible.
const usage = require('./usage');

const API = 'https://generativelanguage.googleapis.com/v1beta';
const hasKey = (cfg) => !!(cfg.geminiApiKey || cfg.geminiFreeApiKey);

async function call(cfg, endpoint, body, { what = 'gemini', free = true, timeoutMs = 30000 } = {}) {
  const keys = [free && cfg.geminiFreeApiKey, cfg.geminiApiKey].filter(Boolean);
  if (!keys.length) throw new Error('no Gemini key');
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

module.exports = { call, text, hasKey, API };

// Voice out. Primary: Gemini TTS (natural studio voices, steerable delivery) when a Gemini key is set.
// Backup: Microsoft Edge neural voices (free but throttles). Common phrases are cached on disk, so
// greetings and "one sec" fillers cost nothing after the first time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('./config');
const edge = require('./tts-edge');
const usage = require('./usage');

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const CACHE_DIR = path.join(DATA, 'tts-cache');
const CASUAL = 'relaxed, natural and conversational, like talking to a close colleague on a phone call; easy pacing, not announcer-like';

// Persona -> Gemini voice + delivery style, and the Edge voice used if Gemini is unavailable.
const PERSONAS = {
  jarvis: { gender: 'male', label: 'Jarvis: refined British AI butler', gemini: 'Algieba', lang: 'en-GB', style: 'Speak exactly like JARVIS from Iron Man: a refined British Received Pronunciation gentleman, calm, measured and softly spoken, precise diction, with a faintly amused dry wit. Same steady voice, pitch and pace every time.', edge: 'en-GB-RyanNeural' },
  friday: { gender: 'female', label: 'Friday: warm Irish female', gemini: 'Sulafat', style: `${CASUAL}; warm and quick; Irish accent`, edge: 'en-IE-EmilyNeural' },
  mate: { gender: 'male', label: 'Mate: easygoing South African male', gemini: 'Zubenelgenubi', style: `${CASUAL}; easygoing; South African accent`, edge: 'en-ZA-LukeNeural' },
  nova: { gender: 'female', label: 'Nova: bright, friendly female', gemini: 'Aoede', style: `${CASUAL}; breezy and upbeat`, edge: 'en-US-AvaMultilingualNeural' },
  atlas: { gender: 'male', label: 'Atlas: deep, confident male', gemini: 'Charon', style: `${CASUAL}; confident and grounded`, edge: 'en-US-AndrewMultilingualNeural' },
  kai: { gender: 'male', label: 'Kai: upbeat, energetic male', gemini: 'Puck', style: `${CASUAL}; upbeat and energetic`, edge: 'en-GB-ThomasNeural' },
};

// Names the voices mispronounce.
function prep(text) {
  return String(text).replace(/\bCocoCorp\b/gi, 'Coco Corp').trim().slice(0, 1500);
}

async function geminiSynth(cfg, text, p, key) {
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.geminiTtsModel,
      input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: p.style }] }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: p.gemini }] },
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const err = new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  const audio = (j.steps || []).filter((s) => s.type === 'model_output')
    .flatMap((s) => s.content || []).filter((c) => c.type === 'audio' && c.data).pop();
  if (!audio) throw new Error('gemini returned no audio');
  return { audio: Buffer.from(audio.data, 'base64'), type: audio.mime_type || audio.mimeType || 'audio/wav' };
}

// After a quota/auth error, give Gemini a rest instead of failing every request.
let geminiPausedUntil = 0;

function cacheFile(engine, voice, text) {
  const h = crypto.createHash('sha1').update(`${engine}|${voice}|${text}`).digest('hex');
  return path.join(CACHE_DIR, h);
}
function readCache(f) {
  try { return { audio: fs.readFileSync(f), type: fs.readFileSync(f + '.type', 'utf8') }; } catch { return null; }
}
function writeCache(f, out) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(f, out.audio); fs.writeFileSync(f + '.type', out.type); } catch { /* best effort */ }
}

// ONE voice, always: Coco only ever speaks in the persona's Gemini voice. If that voice can't be made
// (retried once), this throws and the caller shows text instead. It never falls back to a different
// voice, because the owner wants the voice identical every time. (tts-edge.js is only used when no
// Gemini key is configured at all.)
async function synthesize(cfg, rawText, personaKey = 'jarvis', { cache = false } = {}) {
  const p = PERSONAS[personaKey] || PERSONAS.jarvis;
  const text = prep(rawText);
  if (!cfg.geminiApiKey) {
    return { audio: await edge.synthesize(text, null, { voiceId: p.edge }), type: 'audio/mpeg' };
  }
  const f = cacheFile('gemini', p.gemini + p.style, text);
  if (cache) { const hit = readCache(f); if (hit) return hit; }
  if (Date.now() < geminiPausedUntil) throw new Error('voice service paused after an error');

  // Free-tier key first (its small TTS quota still covers short replies), billed key when it's used up.
  let out, lastErr;
  const keys = [cfg.geminiFreeApiKey, cfg.geminiApiKey].filter(Boolean);
  for (let attempt = 0; attempt < keys.length + 1 && !out; attempt++) {
    const key = keys[Math.min(attempt, keys.length - 1)];
    try {
      out = await geminiSynth(cfg, text, p, key);
      usage.add(key === cfg.geminiApiKey ? 'ttsPaidChars' : 'ttsFreeChars', text.length);
    } catch (e) {
      lastErr = e;
      if (key !== cfg.geminiApiKey) continue;
      if ([401, 403, 429].includes(e.status)) { geminiPausedUntil = Date.now() + 2 * 60_000; break; }
    }
  }
  if (!out) { console.error('[tts] voice unavailable:', lastErr && lastErr.message); throw lastErr || new Error('voice unavailable'); }
  if (cache) writeCache(f, out);
  return out;
}

function voices() { return Object.entries(PERSONAS).map(([key, p]) => ({ key, label: p.label, gender: p.gender })); }

module.exports = { synthesize, voices, PERSONAS };

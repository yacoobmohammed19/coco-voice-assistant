// Voice note -> text. Groq's free Whisper tier first when a key is set (Telegram voice notes are OGG/Opus,
// which it accepts), else a fast Gemini model (free-tier key first, see lib/gemini.js).
const gemini = require('./gemini');

async function viaGroq(cfg, audio, mime) {
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), 'voice.ogg');
  form.append('model', cfg.groqSttModel || 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.groqApiKey}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return String((await res.json()).text || '').trim();
}

async function transcribe(cfg, audio, mime = 'audio/ogg') {
  if (cfg.groqApiKey) {
    try { return await viaGroq(cfg, audio, mime); } catch (e) { console.error('[transcribe] groq failed, using Gemini:', e.message); }
  }
  const j = await gemini.call(cfg, `models/${cfg.geminiTextModel}:generateContent`, {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: mime, data: Buffer.from(audio).toString('base64') } },
      { text: 'Transcribe this voice note exactly, in the language spoken (usually South African English). Output only the transcript, no commentary. If there is no speech, output nothing.' },
    ] }],
    generationConfig: { temperature: 0 },
  }, { what: 'transcribe', timeoutMs: 30000 });
  return gemini.text(j).trim();
}

module.exports = { transcribe };

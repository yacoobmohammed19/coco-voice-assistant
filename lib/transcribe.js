// Voice note -> text with a fast Gemini model (Telegram voice notes arrive as OGG/Opus).
async function transcribe(cfg, audio, mime = 'audio/ogg') {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiTextModel}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': cfg.geminiApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [
        { inline_data: { mime_type: mime, data: Buffer.from(audio).toString('base64') } },
        { text: 'Transcribe this voice note exactly, in the language spoken (usually South African English). Output only the transcript, no commentary. If there is no speech, output nothing.' },
      ] }],
      generationConfig: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`transcribe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return ((j.candidates || [])[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

module.exports = { transcribe };

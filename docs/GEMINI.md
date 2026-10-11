# Gemini API configuration

Coco uses one Gemini API key (`geminiApiKey` in config) for six jobs. All calls go to
`https://generativelanguage.googleapis.com/v1beta` with header `x-goog-api-key` (or `?key=` on the server WS).

| Use | Model (config key → default) | Endpoint | Code |
|---|---|---|---|
| Realtime voice calls | `models/gemini-3.8-live` (constant `MODEL`) | WebSocket `BidiGenerateContent` / `BidiGenerateContentConstrained` | `lib/live.js`, `public/live.js`, `lib/callbridge.js` |
| Ephemeral tokens for the phone | — | `POST /v1beta/auth_tokens` | `lib/live.js` `mintToken()` |
| Chat brain (Telegram/classic) | `geminiChatModel` → `gemini-flash-latest` | `models/{m}:generateContent` | `lib/brain.js` |
| Nightly memory pass, self-test | `geminiChatModel` | `generateContent` | `lib/memory.js`, `lib/selftest.js` |
| Voice-note transcription | `geminiTextModel` → `gemini-flash-lite-latest` | `generateContent` (inline audio) | `lib/transcribe.js` |
| Text-to-speech (classic mode) | `geminiTtsModel` → `gemini-3.8-flash-lite-tts` | `POST /v1beta/interactions` | `lib/tts.js` |
| Semantic search | `embedModel` → `gemini-embedding-001` (768 dims) | `embedContent` / `batchEmbedContents` | `lib/semantic.js` |

Model names change often. If a call fails with 404, list what your key can use and update the constant or
config key:

## Verify models

```powershell
node -e "const c=require('./lib/config').load();fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key='+c.geminiApiKey).then(r=>r.json()).then(j=>j.models.map(m=>m.name+'  '+(m.supportedGenerationMethods||[]).join(',')).filter(s=>/live|tts|flash|embedding/.test(s)).forEach(s=>console.log(s)))"
```

Look for a model supporting `bidiGenerateContent` (Live), one with TTS, a flash model and an embedding model.

## Billing and privacy

- Enable billing on the key's Google Cloud project. On the free tier Google may use prompts and audio to
  improve products, and Live/TTS rate limits are very low.
- The key never leaves the PC: the phone only ever receives a **single-use ephemeral token**.

## Gemini Live session setup (`setupFor()` in lib/live.js)

```js
{
  model: 'models/gemini-3.8-live',
  generationConfig: {
    responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Algieba' } }, languageCode: 'en-GB' },
  },
  systemInstruction: { parts: [{ text: live-prompt.md + memory/rules/loops + last 2 days of conversation }] },
  tools: [{ functionDeclarations: [ lookup_vault, start_job, confirm_job, cancel_job, job_status, call_me_back,
           whatsapp, remind_me, do_not_call, send_link, send_file, remember, end_call ] }],
  inputAudioTranscription: {},          // transcripts of the owner -> call log + YES check
  outputAudioTranscription: {},         // transcripts of Coco -> call log
  realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 700 } },
}
```

`{{PERSONA}}` and `{{DATE}}` in `lib/live-prompt.md` are replaced with the persona style and the current
SAST date/time so greetings fit the time of day.

## Ephemeral tokens (browser path)

The phone must not hold the API key, and must not be able to change Coco's prompt or tools. So the server
mints a token with the **whole setup locked in**:

```http
POST https://generativelanguage.googleapis.com/v1beta/auth_tokens
x-goog-api-key: <server key>
Content-Type: application/json

{
  "uses": 1,
  "expireTime": "<now + 30 min>",            // max call length
  "newSessionExpireTime": "<now + 60 s>",    // must connect within a minute
  "bidiGenerateContentSetup": { ...setupFor(...) }
}
```

Response `{ "name": "auth_tokens/…" }`. The phone connects to:

```
wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=<name>
```

Lessons learned:

- Use `bidiGenerateContentSetup`. The REST endpoint rejects `liveConnectConstraints` (that's an SDK field).
- The constrained endpoint ignores any `setup` the client sends that conflicts with the locked one; the
  client just sends `{setup:{model}}` and waits for `setupComplete`.
- Server-side calls (Telegram/Twilio) skip tokens and connect to the unconstrained `BidiGenerateContent`
  with `?key=`.

## Voices

One persona is used everywhere (`persona` in config, `voiceLocked: true`). Mapping in `lib/tts.js`:

| Persona | Gemini voice | Language | Notes |
|---|---|---|---|
| jarvis (default) | Algieba | en-GB | calm, measured, dry wit |
| friday | Sulafat | — | warm |
| mate | Zubenelgenubi | — | relaxed |
| nova | Aoede | — | bright |
| atlas | Charon | — | deep |
| kai | Puck | — | upbeat |

Do not prompt the model to perform accents: the Live voice drifts between accents and sounds like different
people. Describe manner (calm, concise) instead, and set `languageCode`.

TTS (classic mode) uses the `/interactions` API with the same voice name and a style instruction; short
phrases are cached in `$DATA/tts-cache/`. `lib/tts-edge.js` (Microsoft Edge Read Aloud) exists as a dormant
fallback only — it throttles an IP within minutes and changes the voice, so it is not used when
`voiceLocked` is true.

## Chat brain settings

`lib/brain.js` calls `generateContent` with `thinkingConfig.thinkingBudget: 0` (2–3 s replies instead of
~4.5 s) and asks for a JSON `{say, action}` object. `brain.parse` tolerates arrays, back-to-back objects and
code fences so raw JSON never reaches the user. Set `chatBrain: "claude"` to use Claude instead.

## Network gotcha

Every Coco process calls `net.setDefaultAutoSelectFamilyAttemptTimeout(2500)`. Node's 250 ms default
"happy eyeballs" timeout made every Gemini request fail on a slow line and silently forced the Claude
fallback.

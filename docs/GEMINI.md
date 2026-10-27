# Gemini API configuration

Coco uses two Gemini keys: the billed `geminiApiKey` for **Live voice calls only**, and `geminiFreeApiKey` (a
project without billing) for everything else in the table. Without the free key those features degrade
(phone voice instead of Gemini TTS, keyword-only search, Groq-only voice notes) rather than spend money. All calls go to
`https://generativelanguage.googleapis.com/v1beta` with header `x-goog-api-key` (or `?key=` on the server WS).

| Use | Model (config key → default) | Endpoint | Code |
|---|---|---|---|
| Realtime voice calls | `models/gemini-3.8-live` (constant `MODEL`) | WebSocket `BidiGenerateContent` / `BidiGenerateContentConstrained` | `lib/live.js`, `public/live.js`, `lib/callbridge.js` |
| Ephemeral tokens for the phone | — | `POST /v1beta/auth_tokens` | `lib/live.js` `mintToken()` |
| Chat brain (only when `chatBrain: "gemini"`, else fallback) | `geminiChatModel` → `gemini-flash-latest` | `models/{m}:generateContent` | `lib/brain.js` |
| Nightly memory pass, self-test (same rule) | `geminiChatModel` | `generateContent` | `lib/memory.js`, `lib/selftest.js` |
| Voice-note transcription (after Groq, if set) | `geminiTextModel` → `gemini-flash-lite-latest` | `generateContent` (inline audio) | `lib/transcribe.js` |
| Text-to-speech (classic mode) | `geminiTtsModel` → `gemini-3.8-flash-lite-tts` | `POST /v1beta/interactions` | `lib/tts.js` |
| Semantic search | `embedModel` → `gemini-embedding-001` (768 dims) | `embedContent` / `batchEmbedContents` | `lib/semantic.js` |

Model names change often. If a call fails with 404, list what your key can use and update the constant or
config key:

## Verify models

```powershell
node -e "const c=require('./lib/config').load();fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key='+c.geminiApiKey).then(r=>r.json()).then(j=>j.models.map(m=>m.name+'  '+(m.supportedGenerationMethods||[]).join(',')).filter(s=>/live|tts|flash|embedding/.test(s)).forEach(s=>console.log(s)))"
```

Look for a model supporting `bidiGenerateContent` (Live), one with TTS, a flash model and an embedding model.

## Keeping the bill down

Where the money goes, biggest first: Gemini Live calls (audio billed every second both ways, and the whole
prompt re-billed each turn), then chat turns, TTS, transcription, embeddings.

| Lever | Default | Effect |
|---|---|---|
| `chatBrain: "claude"`, `talkModel: "sonnet"` | on | Telegram chat, classic mode and the nightly memory pass run on the Claude subscription. Gemini (free key) only if Claude fails. Jobs were already Claude (Sonnet for lookups, Opus for real work) |
| Billed key = Live only | on | Embeddings, transcription, TTS and backup chat use `geminiFreeApiKey` only. `geminiPaidForAll: true` lets them fall back to the billed key. Free-tier data may be used by Google to improve products |
| `groqApiKey` | empty | Voice notes go to Groq's free Whisper tier first |
| `geminiBudgetUsd` / `geminiBudgetUntil` | 10 / `2026-12-31` | Dollar budget for Live, spread evenly over the days left (quiet days roll over). Cost is computed from Gemini's own token counts (`usageMetadata`) at `livePrices`. When today's share is spent, Coco says goodbye within a minute, the app falls back to classic mode, Telegram calls are refused with a text, and job results arrive as messages instead of rings |
| `liveMaxMinutes` | 15 | Per-call cap; Coco is told to wrap up a minute before |
| `liveDailyMinutes` | 0 | Optional extra cap in minutes per day |
| `liveRecentChars` | 6000 | Less history in the Live prompt (was 16000) |
| `contextWindowCompression` | 16k → 8k tokens | Long calls drop their oldest turns instead of re-billing them |

`GET /health` shows today's counters (`usage`): `liveMinutes`, `liveUsd`, free calls per feature, and the
budget (spent, left today). Each call's estimated cost is written to the call log. History for 14 days is
in `$DATA/usage.json`. Default `livePrices` (USD per 1M tokens): audio in 3, text in 0.5, audio out 12, text
out 2. Compare the estimate with the Google billing page after a few days and adjust `livePrices` if it's off. Also set a budget alert on the Google Cloud
project (Billing → Budgets & alerts).

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
code fences so raw JSON never reaches the user. It is only used when `chatBrain` is `"gemini"` (or as the
fallback when the Claude CLI fails).

## Network gotcha

Every Coco process calls `net.setDefaultAutoSelectFamilyAttemptTimeout(2500)`. Node's 250 ms default
"happy eyeballs" timeout made every Gemini request fail on a slow line and silently forced the Claude
fallback.

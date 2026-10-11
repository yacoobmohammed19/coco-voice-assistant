# Live call audio: WebSocket piping and bridging

Every live call ends up as a **Gemini Live bidirectional WebSocket** carrying raw PCM. What differs per
channel is who holds that WebSocket and how audio gets to it.

| Channel | Transport to Coco | Who opens the Gemini WS | Audio in → Gemini | Gemini → audio out |
|---|---|---|---|---|
| PWA (Live mode) | none: the phone talks **directly** to Gemini | the browser (ephemeral token) | 16 kHz PCM16 mono | 24 kHz PCM16 mono |
| Telegram call | Telegram P2P call (NTgCalls, WebRTC-based) → Python helper → local WS | the server (`lib/callbridge.js`) | 48 kHz → 16 kHz in helper | 24 kHz → 48 kHz in helper |
| Twilio number | Twilio Media Streams WS (via Tailscale Funnel) | the server (`lib/callbridge.js`) | 8 kHz μ-law → 16 kHz PCM (`lib/audio.js`) | 24 kHz PCM → 8 kHz μ-law |

> **On WebRTC:** Coco's own code does not implement WebRTC. The browser path uses a plain WebSocket
> straight to Gemini (lowest latency, no media server needed). Telegram's calls are WebRTC under the hood,
> but py-tgcalls/NTgCalls handles that and exposes raw 48 kHz PCM frames to the helper. If you need a
> browser-to-server WebRTC leg (e.g. for echo cancellation on desktop), terminate it in a media server and
> feed the PCM into `callbridge.bridge()` with a codec object, exactly like the Telegram path does.

## 1. Browser ↔ Gemini (public/live.js)

```
mic ─getUserMedia({echoCancellation,noiseSuppression,autoGainControl})
    └─ AudioWorklet 'pcm-capture' (public/pcm-worklet.js)
         resamples device rate (often 48 kHz) → 16 kHz, Float32 → Int16, posts 1600-sample (100 ms) chunks
    └─ echo guard: while Coco's audio is playing (+300 ms), chunks with RMS < 0.09 are zeroed
    └─ ws.send({ realtimeInput: { audio: { data: base64(pcm), mimeType: 'audio/pcm;rate=16000' } } })

Gemini → serverContent.modelTurn.parts[].inlineData (audio/pcm;rate=24000, base64)
    └─ decoded to Float32, AudioBuffer at 24 kHz, scheduled back-to-back (nextTime) on an AudioContext
serverContent.interrupted → stop all queued sources (barge-in)
serverContent.inputTranscription / outputTranscription → POST /api/live/log (call transcript)
toolCall → POST /api/live/tool { callId, name, args, heard } → toolResponse back on the WS
```

Sequence:

1. `POST /api/live/start` → server mints the ephemeral token (docs/GEMINI.md) and returns
   `{ token, wsUrl, model, kickoff, callId }`.
2. Browser opens `wss://…BidiGenerateContentConstrained?access_token=<token>` and sends `{setup:{model}}`.
3. On `setupComplete`: start the worklet, then send the kickoff as `clientContent` so Coco speaks first.
4. Mute = worklet `port.postMessage({muted:true})` (sends zeros, keeps the session alive).
5. `end_call` tool → wait for playback to finish → close.

Wake lock and a ringback tone are handled in `public/app.js`.

## 2. Shared server-side bridge (lib/callbridge.js)

Carrier-agnostic: anything that can speak this JSON-over-WebSocket protocol (Twilio's own format) gets a
full Coco call with tools, transcripts and policy.

```
carrier → Coco                               Coco → carrier
{event:'start', start:{streamSid, ...}}      {event:'media', streamSid, media:{payload}}
{event:'media', media:{payload: b64}}        {event:'clear', streamSid}        // barge-in: flush playback
{event:'mark',  mark:{name}}                 {event:'mark',  streamSid, mark:{name}}  // "tell me when played"
{event:'stop'}
```

`bridge(sock, { cfg, hooks, codec, resolveStart, label })`:

- `resolveStart(startMsg)` authenticates the stream (single-use ref / token, shared secret) and returns
  `{ kickoff, direction }`, or `null` to reject (close 1008).
- Opens `wss://…BidiGenerateContent?key=…`, sends `{setup: live.setupFor(persona, recentConversation, memory)}`,
  then the kickoff turn on `setupComplete`.
- `codec.decode(buf)` → 16 kHz PCM16 for Gemini; `codec.encode(pcm24k, rate)` → array of base64 payloads
  for the carrier.
- Gemini `interrupted` → `clear` to the carrier. `end_call` → after the final `turnComplete`, send a `mark`
  and hang up only when the carrier confirms the goodbye has played (6 s fallback).
- Transcription fragments are buffered per speaker and flushed to the call log on speaker change, tool call
  or turn end.

## 3. Telegram path (telegram/coco_tg.py ↔ lib/telegram.js)

```
Owner's Telegram ──P2P call──► coco_tg.py (py-tgcalls / NTgCalls, logged in as Coco)
                                 │ StreamFrames: 48 kHz PCM16 mono, 10 ms
                                 │ audioop.ratecv 48k→16k, batched ≥1280 bytes (~40 ms)
                                 ▼
                    ws://127.0.0.1:8789/tg/stream   (start carries {ref, secret})
                                 ▼
                      lib/telegram.js onStream → callbridge.bridge(codec = pcm passthrough)
                                 ▼
                         Gemini Live (server WS)
reverse: 24 kHz PCM payloads (1920-byte slices) → helper → ratecv 24k→48k → buffer
         → pump_out() sends exactly one 10 ms frame every 10 ms (silence when empty) via send_frame()
         → marks are acknowledged when that many bytes have actually been sent
```

Control channel `ws://127.0.0.1:8789/tg/control` (JSON): helper → `auth{secret}`, `health{ok}` every 30 s,
`status`, `missed`, `chat|voice|file|files`; server → `ok`, `call{ref}`, `reply{id,text,html}`, `send`,
`send_file`. Outbound call: server creates a single-use `ref` (2 min expiry) → `call{ref}` → helper rings
the owner and opens `/tg/stream` with that ref. Inbound call: only the owner's Telegram user id is answered,
with `ref:'inbound'`.

## 4. Twilio path (lib/phone.js) — optional, dormant by default

- `POST` webhooks from Twilio are signature-checked (`X-Twilio-Signature`, HMAC-SHA1 with the auth token).
- Inbound: only `ownerNumber` caller ID is accepted, then a keypad PIN (`<Gather>`), then TwiML
  `<Connect><Stream url="wss://<phonePublicUrl>/…"><Parameter name="t" value="<single-use token>"/>`; the
  token arrives in the stream's `start.customParameters` and is checked by `resolveStart`.
- Outbound: REST `Calls.json` with the same TwiML.
- Media WS on `127.0.0.1:8788`, served by the zero-dependency `lib/wsserver.js` (RFC 6455: text/binary
  frames, fragmentation, ping/pong, close, 16 MB cap).
- Codec (`lib/audio.js`): μ-law 8 kHz ↔ PCM16 via lookup table; ×2 linear-interpolation upsample to 16 kHz;
  box-filter decimation 24 kHz → 8 kHz.
- Requires a public HTTPS URL for 8788: `tailscale funnel --bg --https=8443 8788`, then `phonePublicUrl`.
  Cost made this path a dormant option (≈ R1/min SA number, ≈ R7/min US number to SA mobiles); Telegram
  calls are free.

## Sample-rate cheat sheet

| Leg | Format |
|---|---|
| Gemini Live input | PCM16 LE mono 16 kHz, `audio/pcm;rate=16000` |
| Gemini Live output | PCM16 LE mono 24 kHz (rate parsed from `mimeType`) |
| Telegram (NTgCalls) | PCM16 LE mono 48 kHz, 10 ms frames (960 bytes) |
| Twilio Media Streams | G.711 μ-law 8 kHz mono, base64 |

## Tuning knobs

| Knob | Where | Default |
|---|---|---|
| End-of-speech silence | `realtimeInputConfig.automaticActivityDetection.silenceDurationMs` (lib/live.js) | 700 ms |
| Echo-guard threshold | `rms < 0.09` (public/live.js) | 0.09 |
| Worklet chunk | `new Int16Array(1600)` (public/pcm-worklet.js) | 100 ms |
| Telegram uplink batch | `len(self.in_buf) >= 1280` (coco_tg.py) | 40 ms |
| Max call length | `expireTime` in `mintToken()` | 30 min |

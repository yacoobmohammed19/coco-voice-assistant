# Architecture

## One-paragraph summary

A single Node process (`server.js`, zero npm dependencies) runs on an always-on Windows PC and binds only to
`127.0.0.1`. The owner reaches it three ways: a PWA over Tailscale Serve, Telegram (chat + real calls through
a Python sidecar logged in as Coco's own Telegram account), and optionally a Twilio phone number. Realtime
voice is **Gemini Live**; text chat is **Gemini Flash** (Claude fallback). Anything that is real work becomes
a **background job**: a headless `claude -p` run with the owner's MCP servers, a deny-list permission policy,
and a fixed delivery contract (vault result note + short text message + files). Results come back as a
Telegram message or call, an ntfy push, and one daily digest email.

## Component diagram

```
                        ┌────────────────────────── Owner's devices ───────────────────────────┐
                        │  PWA (public/)            Telegram app             Phone (PSTN)       │
                        └────┬───────────────────────────┬────────────────────────┬────────────┘
             HTTPS (tailnet) │                Telegram P2P call / chat     Twilio (optional)
                             ▼                           ▼                        ▼
                    Tailscale Serve :443        telegram/coco_tg.py       Tailscale Funnel :8443
                             │                 (py-tgcalls + Telethon)            │
                             ▼                   ws://127.0.0.1:8789              ▼
 ┌───────────────────────── server.js  (127.0.0.1:8787) ─────────────────────────────────────────┐
 │ HTTP API + static PWA        lib/auth.js (PIN, session cookie, lockout)                       │
 │ /api/live/start ─ lib/live.js ─ mint ephemeral Gemini token (setup locked)                    │
 │ /api/live/tool  ─ tool relay (lookup_vault, start_job, confirm_job, remind_me, …)             │
 │ /api/talk       ─ lib/brain.js (Gemini Flash chat brain / Claude fallback)                    │
 │ lib/telegram.js ─ control + stream WebSockets for the Telegram helper (lib/wsserver.js)       │
 │ lib/phone.js    ─ Twilio Media Streams on 127.0.0.1:8788 (dormant unless configured)          │
 │ lib/callbridge.js ─ server-side Gemini Live session for Telegram/Twilio calls                 │
 │ lib/jobs.js + lib/claude.js ─ job queue → `claude -p` with MCP config + deny lists            │
 │ lib/vault.js + lib/semantic.js ─ keyword + embedding search, call transcripts                 │
 │ lib/memory.js ─ nightly memory/rules/open-loops pass   lib/digest.js ─ 20:00 daily email      │
 │ lib/rings.js, reminders, do-not-call, watchdog, heartbeat, lib/selftest.js                    │
 └───────┬──────────────────────────────┬─────────────────────────────────┬─────────────────────┘
         │ spawns                       │ spawns                          │ spawns per job
         ▼                              ▼                                 ▼
 telegram/coco_tg.py           whatsapp/bridge.js (:8790)        claude -p  (+ MCP servers:
 (venv python)                 Baileys linked device             vault, email, CRM, Drive,
                               → vault mirror + local API        whatsapp/mcp.js, social/mcp.js …)
```

## Ports

| Port | Bound to | Who talks to it |
|---|---|---|
| 8787 | 127.0.0.1 | Tailscale Serve → PWA; `/health` for watchdog |
| 8788 | 127.0.0.1 | Twilio Media Streams via Tailscale Funnel :8443 (only when Twilio is set up) |
| 8789 | 127.0.0.1 | Telegram helper: `/tg/control` and `/tg/stream` WebSockets, shared `sidecarSecret` |
| 8790 | 127.0.0.1 | WhatsApp bridge local API (`x-coco-secret` header) used by server and `whatsapp/mcp.js` |

Nothing listens on a public interface. Tailscale Serve exposes 8787 only inside the tailnet.

## The three conversation paths

| Path | Speech in | Brain | Speech out | Latency |
|---|---|---|---|---|
| **App call, Live mode** (default) | mic → AudioWorklet 16 kHz PCM → WebSocket **directly to Gemini** | Gemini Live | Gemini Live 24 kHz PCM | ~1 s greeting, ~3 s with a lookup |
| **Telegram / Twilio call** | carrier audio → server → Gemini Live (server-side WS) | Gemini Live | back through server → carrier | similar |
| **App classic mode / Telegram chat** | browser speech recognition, or typed text, or voice note (Gemini transcription) | `lib/brain.js`: Gemini Flash (thinkingBudget 0), Claude fallback | Gemini TTS (`lib/tts.js`), cached | 2–3 s |

Details of audio formats and the WebSocket protocols: [AUDIO-BRIDGING.md](AUDIO-BRIDGING.md).

## Tool calls during a live call

Gemini Live has function declarations (`lib/live.js` `TOOLS`): `lookup_vault`, `start_job`, `confirm_job`,
`cancel_job`, `job_status`, `call_me_back`, `whatsapp`, `remind_me`, `do_not_call`, `send_link`, `send_file`,
`remember`, `end_call`.

- In the **browser** path, Gemini sends `toolCall` to the phone; `public/live.js` POSTs it to
  `/api/live/tool`; the server executes it and the phone returns the `toolResponse` to Gemini.
- In the **server** path (`lib/callbridge.js`), the server receives `toolCall` directly and calls the same
  handler (`hooks.tool`).

The server — not the model — enforces policy: risky briefs are forced to the confirm tier, `confirm_job`
requires a YES-regex match on the owner's last transcribed words in the same call, do-not-call is enforced in
code.

## Background job lifecycle

```
start_job(title, brief, tier)
  → jobs.create(): RISKY regex may force tier=confirm → status queued | awaiting_confirm
  → execute(): claude -p --model … --mcp-config $DATA/mcp.json [mcp-extra] --permission-mode bypassPermissions
               --disallowedTools ALWAYS_DENY [+ SAFE_DENY]     (prompt = jobPrompt(): task + memory + rules + delivery contract)
  → worker writes vault note 00-Inbox/voice-jobs/<date>-<id>.md, files into $DATA/outbox/<id>/
  → final message (1–3 sentences + PRIORITY line) → j.summary
  → onDone: Telegram text (+ outbox files) · ring outside quiet hours if worth it · ntfy fallback
  → 20:00: lib/digest.js folds every job note into one email
```

Full detail: [BACKGROUND-JOBS.md](BACKGROUND-JOBS.md).

## Memory model

| Layer | Where | Refresh | Used by |
|---|---|---|---|
| Call/chat transcripts | `$VAULT/00-Inbox/calls/YYYY-MM-DD-calls.md` | live | everything below |
| Recent conversation | last 2 days of transcripts (16k chars, 8k for chat) | per turn | Live setup, chat turns |
| Long-term memory | `20-Areas/Coco/memory.md` | nightly at `memoryHour` (Gemini pass over new lines) | calls, chat, jobs |
| Standing rules | `20-Areas/Coco/rules.md` | `remember` tool + nightly pass | calls, chat, jobs |
| Open loops | `$DATA/loops.json` | nightly | morning nudge, digest "Needs you" |
| Semantic index | `$DATA/semantic/` (gemini-embedding-001, 768 d) | hourly | `vault.smartSearch` (keyword + meaning×1.5) |

## Scheduled loops inside server.js

| Interval | What |
|---|---|
| 5 s | `send-once.md` → Telegram |
| 30 s | due reminders → Telegram |
| 60 s | watchdog (sidecars), content/report/daily ticks |
| 5 min | heartbeat ping (`heartbeatUrl`) |
| 1 h | semantic index refresh |
| 2 h (07–21) | WhatsApp sweep routine job (`waSweepMinutes`) |
| 3 h | social comment sweep (`socialSweepMinutes`) |
| daily | 07:00 self-test, 20:00 digest, 23:00 memory pass (SAST) |

## Files on disk

```
$REPO/                 code (this repo)
$DATA = ~/.coco-voice/
  config.json          all settings + secrets
  jobs.json            job queue/history          job-logs/<id>.log   raw CLI output
  mcp.json             MCP servers for jobs (snapshot of desktop config, or hand-written)
  mcp-extra.json       whatsapp + social MCP (written by server at start)
  mcp-extra-send.json  same, with COCO_ALLOW_SEND=1 (owner-requested jobs only)
  outbox/<job-id>/     files a job produced → sent to Telegram
  telegram.session, telegram.json     Telegram helper login + owner id
  whatsapp/            Baileys auth + message store
  semantic/, tts-cache/, reminders.json, rings.json, dnd.json, loops.json, memory-state.json,
  tg-queue.json, selftest.json, server.log (rotated 10 MB), watchdog.log
$VAULT/
  00-Inbox/calls/      transcripts        00-Inbox/voice-jobs/  job result notes
  00-Inbox/telegram/   files sent on Telegram
  20-Areas/Coco/       memory.md, rules.md          20-Areas/WhatsApp/  chat mirror
```

## Process supervision

1. `start.ps1` loops `node server.js` (5 s back-off) and rotates `server.log`.
2. `server.js` restarts the Telegram helper and WhatsApp bridge when they exit; a 60 s watchdog tree-kills
   them after 3 / 5 minutes disconnected and alerts at 10 / 15 minutes.
3. The helper exits itself after 2 minutes disconnected and when its parent PID dies (`COCO_PARENT_PID`).
4. Scheduled task `CocoVoiceWatchdog` (every 5 min) restarts the `CocoVoice` task and kills a frozen server
   after two failed `/health` checks.
5. Optional external dead-man's switch via `heartbeatUrl`.

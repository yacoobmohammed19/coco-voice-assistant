# Coco Voice Assistant

A private, self-hosted voice assistant you can **call** — from a phone web app, a real Telegram call, or (optionally) a real phone number — that answers from your notes, and hands real work (code, deploys, documents, CRM updates, research) to **Claude Code running headless on your own PC**, then calls or messages you back when it's done.

This repository packages the complete working system built for CocoCorp, with personal data removed, plus the documentation needed to rebuild it end-to-end. The setup guide is written so that **Claude Code can execute it step by step**.

```
 You (iPhone / Android)
   │  ① PWA over Tailscale  ② Telegram call/chat  ③ phone number (Twilio, optional)
   ▼
 coco-voice server (Node, zero deps, 127.0.0.1:8787 on your PC)
   ├── Realtime voice:  Gemini Live (speech-in/speech-out, interruptions, tool calls)
   ├── Chat brain:      Gemini Flash (fallback: Claude)
   ├── Lookups:         Obsidian vault keyword + semantic search (Gemini embeddings)
   ├── Background jobs: headless `claude -p` (Opus/Sonnet) + your MCP servers
   ├── Memory:          nightly long-term memory, standing rules, open loops
   ├── Sidecars:        Telegram helper (Python, py-tgcalls) · WhatsApp bridge (Baileys)
   └── Callbacks:       Telegram message/call · ntfy push · daily digest email
```

## What it does

- **Talk to it like a person.** Gemini Live gives ~1 s first response, natural interruptions and one locked voice persona.
- **It does the work.** "Update the hero text on the client site and deploy it" becomes a Claude Code job with your MCP tools, a permission policy enforced in code, and a written result note.
- **It calls you back.** Finished jobs ring your phone on Telegram (free, rings through CallKit) or send a short text-style message; a daily digest email lists everything.
- **It remembers.** Every call and chat is transcribed into the vault; a nightly pass rewrites long-term memory, standing rules and open loops, which feed every call, chat and job.
- **It stays private.** Everything binds to `127.0.0.1`; only your own devices reach it via Tailscale. Secrets live outside the vault.

## Quick start

**With Claude Code (recommended):** clone the repo, open it in Claude Code and say:

> Set up Coco by following docs/SETUP-CLAUDE-CODE.md. Stop and ask me whenever a step needs a human (logins, API keys, PINs).

**By hand:**

```powershell
git clone https://github.com/yacoobmohammed19/coco-voice-assistant.git
cd coco-voice-assistant
node setup.js                    # PIN, secrets, ntfy topic, Tailscale URL
node setup.js --gemini-key       # paste your Gemini API key
claude setup-token; node setup.js --claude-token
tailscale serve --bg 8787
node server.js                   # or: powershell -File install-autostart.ps1
```

Then open your `https://<pc>.<tailnet>.ts.net` URL on your phone, enter the PIN and **Add to Home Screen**.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/SETUP-CLAUDE-CODE.md](docs/SETUP-CLAUDE-CODE.md) | The full install runbook, phase by phase, with verification checks. Written for Claude Code to execute. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, ports, files on disk, scheduled loops. |
| [docs/GEMINI.md](docs/GEMINI.md) | Every Gemini model/endpoint used, Live session setup, ephemeral tokens, voices, cost notes. |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every `config.json` key and environment variable, with defaults. |
| [docs/AUDIO-BRIDGING.md](docs/AUDIO-BRIDGING.md) | Live call audio: browser WebSocket ↔ Gemini, Telegram ↔ server ↔ Gemini, Twilio Media Streams, codecs and sample rates. |
| [docs/BACKGROUND-JOBS.md](docs/BACKGROUND-JOBS.md) | How voice requests become headless Claude Code jobs: tiers, deny lists, MCP config, outbox, callbacks. |
| [docs/TOOLING.md](docs/TOOLING.md) | Tailscale, ntfy, Telegram helper, WhatsApp bridge, social module, MCP servers, watchdogs. |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model and every protection layer. |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Known failure modes and fixes. |

## Requirements

| Need | Version / note |
|---|---|
| Windows 10/11 PC that stays on | Scripts are PowerShell; the Node core is cross-platform |
| Node.js | **22+** (uses global `fetch` and `WebSocket`); tested on 24 |
| Claude Code CLI | Recent build that supports your chosen job model; logged in (subscription or API key) |
| Gemini API key | aistudio.google.com/apikey (enable billing so data isn't used for training) |
| Tailscale | Free personal plan, on PC + phone |
| Python 3.11 | Only for the Telegram calling helper (dedicated venv) |
| ntfy app | Optional push fallback |

## Repository layout

```
server.js              HTTP API, static PWA, schedulers, watchdog, job callbacks
setup.js               one-time setup (PIN, secrets, Gemini/Claude/Twilio credentials)
lib/                   core modules (see docs/ARCHITECTURE.md)
public/                the phone app (PWA): index.html, app.js, live.js, pcm-worklet.js
telegram/              Python helper: Telegram calls + chat as Coco's own account
whatsapp/              WhatsApp linked-device bridge + MCP server (read/search/stage/send)
social/                optional Facebook Page + Instagram automation (Meta Graph API) + MCP
tools/                 drive-folder-list.js (lists link-shared Google Drive folders)
start.ps1              crash-restart loop + log rotation
install-autostart.ps1  scheduled task "CocoVoice" (at logon)
install-watchdog.ps1   scheduled task "CocoVoiceWatchdog" (every 5 min)
examples/              config.example.json, mcp.example.json
```

## Personalising

The prompts were written for one owner and one business. Before going live, edit:

- `lib/live-prompt.md` and `lib/brain-prompt.md` — the line starting "The owner runs a small business…", persona and house rules.
- `lib/memory.js` (`PASS_PROMPT`) and `lib/jobs.js` (`jobPrompt`) — business context and delivery rules for workers.
- `lib/tts.js` / `lib/live.js` — voice personas (`PERSONAS`, `LIVE_STYLE`).
- `social/` — branding is CocoCorp's; rebrand or leave unconfigured.

Timezone is Africa/Johannesburg (SAST) throughout; search for `Africa/Johannesburg` to change it. Phone numbers default to the +27 country code in `e164()` helpers.

## Status

Production use since October 2026 on a single Windows PC. No tests suite; `lib/selftest.js` runs a daily live self-check and `/health` reports component status.

🤖 Packaged with [Claude Code](https://claude.com/claude-code)

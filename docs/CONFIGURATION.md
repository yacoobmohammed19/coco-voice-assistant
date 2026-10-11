# Configuration and environment variables

All settings and secrets live in **one JSON file**: `%USERPROFILE%\.coco-voice\config.json`
(`$COCO_VOICE_DATA/config.json` if that env var is set). It is outside the repo and outside the vault on
purpose. `lib/config.js` merges it over `DEFAULTS`. A starter file is in `examples/config.example.json`.

> `config.save()` (used by `setup.js` and `/api/prefs`) writes **only keys present in `DEFAULTS`**. Keys
> marked *(extra)* below must be added by editing the JSON by hand; they are read but never re-saved.

## Environment variables

| Variable | Read by | Purpose |
|---|---|---|
| `COCO_VOICE_DATA` | config.js, coco_tg.py | Override the data folder (default `~/.coco-voice`) |
| `ANTHROPIC_API_KEY` | config.js | Used as `anthropicApiKey` if config doesn't set one |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude CLI | Set by `lib/claude.js` from `claudeOAuthToken` for every job |
| `APPDATA` | claude.js, config.js | Locates the Claude desktop MCP config and npm-installed `claude.exe` |
| `COCO_PARENT_PID` | coco_tg.py, bridge.js | Set by the server; sidecars exit when the parent dies |
| `WA_PHONE` | whatsapp/bridge.js | Number to request a WhatsApp pairing code for (else `waNumber` / `ownerNumber`) |
| `COCO_ALLOW_SEND` | whatsapp/mcp.js | `1` exposes `whatsapp_send` (only in `mcp-extra-send.json`) |
| `COCO_SOCIAL_DELETE` | social/mcp.js | `1` exposes `social_delete_post` |

## config.json keys

### Server and access

| Key | Default | Notes |
|---|---|---|
| `port` / `host` | `8787` / `127.0.0.1` | Never bind publicly |
| `publicUrl` | `""` | `https://<pc>.<tailnet>.ts.net`, detected by `setup.js`; also used for Host/Origin allow-list |
| `pinHash`, `pinSalt` | — | scrypt; set by `setup.js` / `--reset-pin` |
| `sessionSecret` | generated | HMAC for session cookies; regenerate = log out everywhere |
| `sessionHours` | `12` | Session lifetime |
| `sidecarSecret` | generated | Shared secret for the Telegram helper and WhatsApp bridge |
| `ntfyServer` / `ntfyTopic` | `https://ntfy.sh` / random | Push fallback; topic is a 128-bit secret |
| `heartbeatUrl` | `""` | healthchecks.io ping URL (5 min; `/fail` if Telegram down 10+ min) |

### Vault and memory

| Key | Default | Notes |
|---|---|---|
| `vaultPath` | parent of the repo | **Set this** for a standalone clone |
| `callLogDir` | `00-Inbox/calls` | Daily transcripts |
| `jobOutputDir` | `00-Inbox/voice-jobs` | Job result notes |
| `memoryNote` / `rulesNote` | `20-Areas/Coco/memory.md` / `rules.md` | Long-term memory and standing rules |
| `memoryHour` | `23` | SAST hour of the nightly memory pass |
| `selftestHour` | `7` | SAST hour of the daily self-test |
| `embedModel` | `gemini-embedding-001` | Semantic index |

### Models

| Key | Default | Notes |
|---|---|---|
| `geminiApiKey` | `""` | Required for Live calls, TTS, chat brain, transcription, embeddings |
| `geminiChatModel` | `gemini-flash-latest` | Chat brain + memory pass |
| `geminiTextModel` | `gemini-flash-lite-latest` | Voice-note transcription |
| `geminiTtsModel` | `gemini-3.8-flash-lite-tts` | Classic-mode voice |
| `chatBrain` | `gemini` | `gemini` or `claude` |
| `talkModel` | `haiku` | Claude model for the Claude chat fallback |
| `anthropicApiKey` | `""` | Optional: Claude chat fallback via API (~1 s) instead of CLI |
| `claudeOAuthToken` | `""` | From `claude setup-token`; keeps headless jobs logged in |
| `claudeExe` | auto | Found at `~/.local/bin/claude.exe` or npm global; else `claude` on PATH |
| `jobModel` / `jobEffort` | `claude-opus-5-5` / `medium` | Code, figures, confirm-tier jobs |
| `quickJobModel` | `sonnet` | Lookups/research jobs |
| `jobTimeoutMin` | `45` | Per job |
| `maxConcurrentJobs` | `2` | Parallel jobs |

### Voice

| Key | Default | Notes |
|---|---|---|
| `persona` | `jarvis` | One of `jarvis, friday, mate, nova, atlas, kai` (lib/tts.js) |
| `voiceLocked` | `true` | Persona can't be changed from the app; no different-voice fallbacks |
| `quietHours` | `[22, 7]` | Finished jobs message instead of ringing between these SAST hours |
| `callOnJobDone` *(extra)* | `true` | `false` = never ring for finished jobs |

### Telegram

| Key | Default | Notes |
|---|---|---|
| `tgApiId`, `tgApiHash` | `""` | From my.telegram.org (Coco's account); written by `coco_tg.py login` |
| `tgPort` | `8789` | Local-only helper link |
| `pythonExe` | `python` | Point at the dedicated venv's `python.exe` |
| `ownerNumber` | `""` | Owner's mobile, E.164; used to find the owner on Telegram/WhatsApp/Twilio |

### WhatsApp *(extra keys)*

| Key | Default | Notes |
|---|---|---|
| `whatsapp` | on if `whatsapp/node_modules` exists | `false` disables the bridge |
| `waPort` | `8790` | Local API |
| `waNumber` | `ownerNumber` | Number to link |
| `waSweepMinutes` | `120` | WhatsApp sweep routine interval |

### Social *(extra keys)*

| Key | Default | Notes |
|---|---|---|
| `socialSweepMinutes` | `180` | Comment sweep interval |
| `socialReportHour` | `20` | Digest/report hour (SAST) |

Social credentials themselves live in `$DATA/social.json` (written by `social/setup.js`).

### Twilio (optional, dormant)

| Key | Default | Notes |
|---|---|---|
| `twilioSid`, `twilioToken`, `twilioNumber` | `""` | `node setup.js --twilio` |
| `phonePort` | `8788` | Local media-stream port |
| `phonePublicUrl` | `""` | Funnel URL, e.g. `https://<pc>.<tailnet>.ts.net:8443` |

## Other state files in `$DATA`

| File | Purpose |
|---|---|
| `mcp.json` | MCP servers for jobs |
| `mcp-extra.json`, `mcp-extra-send.json` | Written by server: WhatsApp + social MCP servers |
| `jobs.json`, `job-logs/` | Job queue and raw logs |
| `outbox/<job>/` | Job deliverables → Telegram |
| `telegram.session`, `telegram.json` | Telegram login, owner id |
| `whatsapp/` | Baileys auth + message store |
| `reminders.json`, `rings.json`, `dnd.json`, `loops.json`, `memory-state.json` | Scheduler and memory state |
| `tg-queue.json` | Telegram messages held while offline (48 h) |
| `send-once.md` | Drop a file here: it is sent to Telegram once, then deleted |
| `semantic/`, `tts-cache/` | Caches |
| `server.log` (+ `.1–.3`), `watchdog.log` | Logs |

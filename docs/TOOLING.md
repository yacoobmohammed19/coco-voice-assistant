# Tooling setup

## Tailscale (private access)

- Install on the PC and phone, same account.
- `tailscale serve --bg 8787` → HTTPS `https://<pc>.<tailnet>.ts.net` → `http://127.0.0.1:8787`, tailnet only.
- `tailscale serve status` to check; `tailscale serve reset` to undo.
- **Funnel** (public internet) is only for the optional Twilio leg: `tailscale funnel --bg --https=8443 8788`.
  Keep it off otherwise (`tailscale funnel reset`).

## ntfy (push fallback)

Free, no account. `setup.js` generates a random topic; the app's *Alerts* panel shows it. Pushes carry only a
short title, never content. Used when Telegram is unavailable or during quiet hours.

## Claude Code CLI

- Install natively (`~/.local/bin/claude.exe`). Keep it current: older builds can't run newer models.
- `claude setup-token` → `node setup.js --claude-token` for a long-lived headless login.
- Jobs inherit claude.ai connectors from the CLI login plus the MCP servers in `$DATA/mcp.json`.

## Telegram helper (`telegram/`)

- Python 3.11 venv at `~/.coco-voice/venv` (`pythonExe` in config). Requirements:
  `py-tgcalls[telethon]>=3,<4`, `websockets>=12`.
- Coco needs **its own** Telegram account (separate number). The owner's account is resolved at login and
  stored as `ownerId`; every other user is ignored (no replies, no read receipts).
- Login: `python telegram/coco_tg.py login` (interactive). Service: started by the server
  (`coco_tg.py run`).
- Features: real calls both ways (CallKit ring on iPhone), text chat, voice notes (Gemini transcription),
  files and albums (saved to `00-Inbox/telegram/`), `release <code>` / `pending` commands, 30 s health
  heartbeat.
- On Windows the helper exits via `TerminateProcess`: `os._exit` can hang with NTgCalls threads alive and
  leave a zombie that looks connected.

## WhatsApp bridge (`whatsapp/`)

- `npm install` in `whatsapp/` (Baileys 7, pino). Must identify as `Browsers.windows("Chrome")`; the
  "Desktop" browser identities fail with error 428.
- Links by **pairing code** (sent to Telegram). Re-link: tell Coco "relink WhatsApp" (wipes WA auth and
  sends a new code).
- Stores messages in `$DATA/whatsapp`, mirrors each chat to `$VAULT/20-Areas/WhatsApp/<chat>/<YYYY-MM>.md`
  (regenerated from the store, so the mirror can be rebuilt).
- Local API on `127.0.0.1:8790` (`x-coco-secret`). MCP tools: `whatsapp_status`, `whatsapp_list_chats`,
  `whatsapp_read_chat`, `whatsapp_search`, `whatsapp_since`, `whatsapp_stage_message`, and (send-enabled
  config only) `whatsapp_send`.
- Routine "WhatsApp sweep" job every `waSweepMinutes` between 07:00 and 21:00: drafts replies (release
  codes), sets follow-up reminders, updates vault/CRM, reports only when something needs the owner.

## Social module (`social/`) — optional

Meta Graph API client for one Facebook Page + Instagram business account: post, schedule, comments,
insights, an every-second-day content calendar (`social/content.js status | horizon | import <plan.json>`),
a comment-sweep routine and a daily branded PDF report (rendered with headless Edge). Setup steps:
`social/README.md`. Branding in `report.js` is CocoCorp's; change it before use.

## Google Drive folder lister (`tools/drive-folder-list.js`)

Lists every file in a link-shared Drive folder recursively without login (via the embedded folder view), with
view and image links; `--csv` / `--json` outputs. Exists because the Drive API only "sees" link-shared files
the user has opened. Job prompts tell workers to use it first.

## MCP servers

See [BACKGROUND-JOBS.md](BACKGROUND-JOBS.md#mcp-servers-for-jobs) and `examples/mcp.example.json`. The two
built-in ones (`whatsapp/mcp.js`, `social/mcp.js`) are zero-dependency stdio JSON-RPC servers and are
registered automatically.

## Windows scheduled tasks

| Task | Installed by | Runs |
|---|---|---|
| `CocoVoice` | `install-autostart.ps1` | at logon: `start.ps1` (restart loop, log rotation) |
| `CocoVoiceWatchdog` | `install-watchdog.ps1` | every 5 min, hidden via `watchdog-hidden.vbs` (generated): restarts/kills a dead or frozen server |

Remove with `Unregister-ScheduledTask -TaskName <name> -Confirm:$false`.

> Data lives in `~/.coco-voice`, not `%LOCALAPPDATA%`: the Claude desktop app virtualises AppData, so a
> scheduled task would see a different, empty folder.

## Health and self-test

- `GET http://127.0.0.1:8787/health` → `{ ok, telegram, whatsapp, uptime, queued, selftest }`.
- `lib/selftest.js` (daily at `selftestHour`) exercises Gemini, Claude CLI, vault, Telegram and more, and
  reports **only failures** to Telegram (queued if Telegram is down) plus ntfy.

# Setup runbook (for Claude Code)

This runbook installs Coco end-to-end on a Windows PC. It is written for **Claude Code to execute**: every
phase has commands, a **Verify** check, and **HUMAN** markers where the person must act (logins, codes,
pasting secrets into an interactive prompt). Claude Code: run the commands yourself, stop at each HUMAN step,
tell the user exactly what to do, wait for "done", then verify.

Conventions used below:

- `$REPO` = the folder this repo is cloned into (e.g. `C:\Users\<you>\src\coco-voice-assistant`).
- `$DATA` = `%USERPROFILE%\.coco-voice` (override with env `COCO_VOICE_DATA`). Secrets, state, logs live here.
- `$VAULT` = the Obsidian vault (any folder of Markdown notes) Coco reads and writes.
- Use PowerShell unless a step says otherwise.

Phases 0–5 give you a working assistant (phone app + Gemini Live + background jobs). Phases 6–10 add the
"lives in Telegram/WhatsApp" experience and resilience. Do them in order.

---

## Phase 0 — Prerequisites

```powershell
node --version            # must be v22 or newer (global fetch + WebSocket)
git --version
claude --version          # Claude Code CLI
```

If missing:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
irm https://claude.ai/install.ps1 | iex     # Claude Code native installer -> %USERPROFILE%\.local\bin\claude.exe
winget install Tailscale.Tailscale
winget install Python.Python.3.11           # only needed for Phase 6 (Telegram)
```

**Verify:** all four version commands print a version. Node major ≥ 22.

---

## Phase 1 — Clone and choose the vault

```powershell
git clone https://github.com/yacoobmohammed19/coco-voice-assistant.git $REPO
New-Item -ItemType Directory -Force "$env:USERPROFILE\.coco-voice" | Out-Null
```

**HUMAN:** ask the user for the absolute path of their Obsidian vault (or create a new empty folder for one).

Create the folders Coco writes to (safe if they already exist):

```powershell
$VAULT = '<path the user gave>'
'00-Inbox\calls','00-Inbox\voice-jobs','00-Inbox\telegram','20-Areas\Coco' | % { New-Item -ItemType Directory -Force (Join-Path $VAULT $_) | Out-Null }
```

> `vaultPath` defaults to the **parent folder of the repo** (the original install lived inside the vault).
> For a standalone clone you must set it explicitly in Phase 2.

**Verify:** `Test-Path "$VAULT\00-Inbox\voice-jobs"` is `True`.

---

## Phase 2 — Core configuration (`setup.js`)

```powershell
cd $REPO
node setup.js
```

**HUMAN:** the script asks for a **PIN** (6–12 digits). The user types it; never ask them to tell you the PIN.

`setup.js` generates `sessionSecret`, `sidecarSecret`, a random `ntfyTopic`, stores the scrypt PIN hash, and
writes `$DATA\config.json`. Now set the vault path (and owner number for Telegram/WhatsApp later) by editing
the JSON — do not overwrite the other keys:

```powershell
$f = "$env:USERPROFILE\.coco-voice\config.json"
$c = Get-Content $f -Raw | ConvertFrom-Json
$c | Add-Member -Force vaultPath $VAULT
$c | Add-Member -Force ownerNumber '+27XXXXXXXXX'   # HUMAN: the owner's mobile, E.164
$c | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $f
```

Note: `setup.js` / `config.save()` only persist keys listed in `DEFAULTS` (lib/config.js). Extra keys such as
`waNumber`, `whatsapp`, `waSweepMinutes` must be added by editing `config.json` directly as above; `load()`
merges everything.

**Verify:** `Get-Content $f | ConvertFrom-Json | Select vaultPath, ntfyTopic, pinHash` shows all three non-empty.

---

## Phase 3 — Gemini API key

**HUMAN:** the user creates a key at https://aistudio.google.com/apikey (enable billing on the Google Cloud
project behind it: free-tier traffic may be used for training, and Live/TTS quotas are tiny on free tier).

```powershell
node setup.js --gemini-key      # HUMAN pastes the key into the prompt
```

**Verify** (reads the key from config without printing it):

```powershell
node -e "const c=require('./lib/config').load();fetch('https://generativelanguage.googleapis.com/v1beta/models?key='+c.geminiApiKey).then(r=>console.log('gemini',r.status))"
```

Expect `gemini 200`. Then check the specific models exist for this key: see docs/GEMINI.md → "Verify models".
If a model name in `lib/config.js` / `lib/live.js` is not listed, change it to the closest current one.

---

## Phase 4 — Claude Code for background jobs

The server runs `claude -p` headless. It needs a login that doesn't expire mid-job.

```powershell
claude setup-token              # HUMAN: completes the browser login; prints a long-lived token
node setup.js --claude-token    # HUMAN pastes that token
```

(Alternatively set `anthropicApiKey` with `node setup.js --api-key sk-ant-...`; this also makes the Claude
chat fallback ~1 s.)

MCP servers for jobs: the server copies the Claude **desktop app's** `claude_desktop_config.json` into
`$DATA\mcp.json` whenever it can read it. If you don't use the desktop app, create `$DATA\mcp.json` from
`examples/mcp.example.json` and list the MCP servers jobs should have (vault, email, CRM…). See
docs/BACKGROUND-JOBS.md.

**Verify:**

```powershell
"Reply with the single word OK" | & (node -e "console.log(require('./lib/config').load().claudeExe)") -p --output-format json --model sonnet
```

Expect JSON with `"result":"OK"` and `"is_error":false`.

---

## Phase 5 — Run it, expose it privately, install the phone app

```powershell
cd $REPO
Start-Process node -ArgumentList server.js -NoNewWindow   # first manual run
Invoke-RestMethod http://127.0.0.1:8787/health
```

**Verify:** `/health` returns `ok: True`. Then stop that process (Ctrl+C / `Stop-Process`) and install the
autostart task, which runs `start.ps1` (crash-restart loop + log rotation):

```powershell
powershell -ExecutionPolicy Bypass -File install-autostart.ps1
```

Tailscale (private HTTPS to the phone):

1. **HUMAN:** sign in to Tailscale on the PC and on the phone with the same account.
2. Run:
   ```powershell
   tailscale serve --bg 8787
   node setup.js          # re-run: detects https://<pc>.<tailnet>.ts.net and saves publicUrl
   Stop-ScheduledTask CocoVoice; Start-ScheduledTask CocoVoice
   ```
3. **HUMAN:** on the phone open the `publicUrl` (Safari on iPhone, Chrome on Android), enter the PIN,
   *Add to Home Screen*, allow the microphone, tap **Call**.

**Verify:** `tailscale serve status` shows `https:// … -> http://127.0.0.1:8787`; the phone call connects
and Coco greets within ~1–2 s; `$VAULT\00-Inbox\calls\<today>-calls.md` gets transcript lines.

Optional ntfy push: **HUMAN** installs the ntfy app and subscribes to the topic shown under *Alerts* in the
Coco app (or `ntfyServer/ntfyTopic` from config).

At this point you have a complete system: talk → lookups → jobs → callbacks. Ask Coco on a call:
"start a quick job: list the five newest notes in my inbox". A job appears in `$DATA\jobs.json` and a result
note in `00-Inbox\voice-jobs\`.

---

## Phase 6 — Telegram (free real calls + chat home)  *(recommended)*

Coco gets **its own Telegram account** (a second SIM / number). Calls from that account ring the owner's
phone like a normal call (CallKit on iPhone). Chat and voice notes go through the same brain.

```powershell
py -3.11 -m venv "$env:USERPROFILE\.coco-voice\venv"
& "$env:USERPROFILE\.coco-voice\venv\Scripts\pip.exe" install -r "$REPO\telegram\requirements.txt"
$c = Get-Content $f -Raw | ConvertFrom-Json
$c | Add-Member -Force pythonExe "$env:USERPROFILE\.coco-voice\venv\Scripts\python.exe"
$c | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $f
```

Use a dedicated venv: py-tgcalls pulls native NTgCalls binaries and `audioop` (stdlib only up to Python 3.12).

**HUMAN** (interactive, in a visible window):

```powershell
& "$env:USERPROFILE\.coco-voice\venv\Scripts\python.exe" "$REPO\telegram\coco_tg.py" login
```

They log in at https://my.telegram.org with **Coco's** number, create an app, paste `api_id` / `api_hash`,
then type the login code Telegram sends. The script resolves the owner's Telegram user id (or asks the owner
to send `coco` to Coco's account) and writes `$DATA\telegram.json` + `telegram.session`.

Restart Coco. The server spawns the helper automatically when `tgApiId` and the session file exist.

**Verify:** `/health` shows `telegram: True`; the owner messages Coco's Telegram "hi" and gets a reply;
in the Coco app settings press the test-call button → the owner's Telegram rings.

---

## Phase 7 — WhatsApp bridge  *(optional)*

Linked-device bridge (Baileys). It mirrors chats into `$VAULT\20-Areas\WhatsApp\` and gives jobs read/search
and staged-send tools.

```powershell
cd "$REPO\whatsapp"; npm install; cd $REPO
Stop-ScheduledTask CocoVoice; Start-ScheduledTask CocoVoice
```

The server starts `whatsapp/bridge.js` once `whatsapp/node_modules` exists (set `"whatsapp": false` in
config to disable). On first run it requests a **pairing code** for `waNumber` (or `ownerNumber`) and sends it
to Telegram (also in `$DATA\whatsapp\pairing-code.txt`).

**HUMAN:** WhatsApp → Settings → Linked devices → Link a device → *Link with phone number instead* → enter
the code.

**Verify:** `/health` shows `whatsapp: True`.

---

## Phase 8 — Social media module  *(optional)*

Follow `social/README.md` (Meta developer app, Graph API Explorer token, `node social/setup.js`). Leave it
unconfigured if you don't want Facebook/Instagram automation; the MCP tools then return "not connected".

---

## Phase 9 — Watchdog and heartbeat

```powershell
powershell -ExecutionPolicy Bypass -File install-watchdog.ps1
```

This registers `CocoVoiceWatchdog` (every 5 min, hidden): restarts the `CocoVoice` task if its loop is gone
and kills a frozen server after 2 failed `/health` checks.

Optional dead-man's switch: **HUMAN** creates a check at https://healthchecks.io (5-minute period), then set
`heartbeatUrl` in config to its ping URL.

**Verify:** `Get-ScheduledTask CocoVoice, CocoVoiceWatchdog | Select TaskName, State` shows both registered.

---

## Phase 10 — Personalise

Edit (then restart):

- `lib/live-prompt.md`, `lib/brain-prompt.md` — the business line, persona and rules.
- `lib/jobs.js` → `jobPrompt()` — what workers must deliver and where (result note path, outbox, daily email).
- `lib/tts.js` `PERSONAS` + `lib/live.js` `LIVE_STYLE` — voice choice. Set `persona` in config; `voiceLocked: true` keeps it fixed.
- `quietHours`, `memoryHour`, `selftestHour`, `socialReportHour` in config.

**Final verification checklist**

| Check | How |
|---|---|
| Server healthy | `Invoke-RestMethod http://127.0.0.1:8787/health` |
| Phone app call | PWA → Call → greeting in ≤ 2 s |
| Vault lookup | ask "what's in my inbox folder?" |
| Background job | ask for a small job; result note appears in `00-Inbox/voice-jobs` |
| Callback | job finish → Telegram message/ring (or ntfy push) |
| Memory | after 23:00 SAST, `20-Areas/Coco/memory.md` updates |
| Self-test | 07:00 SAST, `/health` → `selftest.ok` |

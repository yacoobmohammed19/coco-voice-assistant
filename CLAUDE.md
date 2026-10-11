# Instructions for Claude Code

This repo is the Coco voice assistant. If you were asked to install or set it up, follow
`docs/SETUP-CLAUDE-CODE.md` exactly, phase by phase, and run each phase's **Verify** step before moving on.

Rules while setting up:

- Never print, commit or paste secrets. All secrets go into `%USERPROFILE%\.coco-voice\config.json`
  (or `$COCO_VOICE_DATA/config.json`), never into this repo.
- Steps marked **HUMAN** need the person at the keyboard (logins, OTP codes, choosing a PIN, pasting API keys
  into an interactive prompt). Stop, tell them exactly what to do, and wait.
- Do not bind anything to `0.0.0.0` and do not enable Tailscale Funnel unless the user explicitly sets up
  Twilio phone calls (docs/TOOLING.md).
- The core server has zero npm dependencies. Only `whatsapp/` needs `npm install`; only `telegram/` needs pip
  (in a dedicated venv).
- Code style: CommonJS, no build step, short comments explaining *why*. Match it.

When changing the code later: restart with `Stop-ScheduledTask CocoVoice; Start-ScheduledTask CocoVoice`
(or kill the node process: `start.ps1` restarts it within 5 s) and check `GET http://127.0.0.1:8787/health`.

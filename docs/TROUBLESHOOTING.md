# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Server won't start, `EADDRINUSE` in `server.log` | A stale `node server.js` holds 8787 | `Get-NetTCPConnection -LocalPort 8787` → stop that PID; `start.ps1` restarts |
| Jobs fail "not signed in to Claude" | CLI login expired | `claude setup-token` → `node setup.js --claude-token` |
| Jobs have no vault/email/CRM tools | Service can't see the desktop app's MCP config | Write `$DATA/mcp.json` by hand (examples/mcp.example.json) |
| Job "runs" for hours, queue stuck | MCP children holding pipes; old builds without tree-kill | Current `lib/claude.js` tree-kills on timeout/cancel; lower `jobTimeoutMin` |
| Job can't use the configured model | Old Claude CLI | Update Claude Code |
| Every chat reply comes from the Claude fallback / Gemini timeouts | Node 250 ms happy-eyeballs timeout on a slow line | Ensure `setDefaultAutoSelectFamilyAttemptTimeout(2500)` is at the top of each entry file |
| Live call: `token 400` | Wrong token body | Use `bidiGenerateContentSetup` (not `liveConnectConstraints`) |
| Live call: 404 / model not found | Model renamed | List models (docs/GEMINI.md) and update `MODEL` / config |
| Voice changes accent mid-call | Prompt asks for an accent | Describe manner, not accent; set `languageCode` |
| Coco hears itself on speakerphone | Echo | Raise the RMS threshold in `public/live.js`, or use earphones |
| `/health` telegram false, helper "connected" | Zombie helper | Watchdog kills after 3 min; helper uses TerminateProcess on Windows |
| Telegram calls don't ring | Helper not logged in / not owner id | Re-run `coco_tg.py login`; check `telegram.json` `ownerId` |
| WhatsApp error 428 on link | Wrong browser identity | Keep `Browsers.windows("Chrome")` in bridge.js |
| WhatsApp disconnected | Session revoked | Tell Coco "relink WhatsApp" and enter the new pairing code |
| Raw JSON shown in Telegram | Model returned odd JSON | `brain.parse` handles arrays/fences; check for prompt edits that broke the format |
| Scheduled task sees empty data folder | AppData virtualisation | Keep data in `~/.coco-voice`, not `%LOCALAPPDATA%` |
| Polluted global Python | pip into the wrong interpreter | Always use the dedicated venv (`pythonExe`) |

Logs: `~/.coco-voice/server.log` (all components, prefixed `[tg]`, `[wa]`, `[jobs]`, `[live]`…),
`job-logs/<id>.log`, `watchdog.log`.

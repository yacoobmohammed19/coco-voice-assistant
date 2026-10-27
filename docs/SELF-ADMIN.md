# Changing Coco from Telegram

The owner can change Coco without being at the PC. Code: `lib/selfupdate.js`, admin jobs in `lib/jobs.js`.

| Ask on Telegram (or a call) | What happens |
|---|---|
| "Set the call limit to 20 minutes", "switch chat to haiku" | `set_config`: one key from the allowlist (`SETTINGS` in lib/selfupdate.js), type-checked, written to config.json, live at once. "What are your settings?" shows them |
| `/key groqApiKey gsk_…` | Saved to config.json by code (never seen by a model or written to a log), and the message is deleted from the chat. Names: `geminiApiKey`, `geminiFreeApiKey`, `groqApiKey`, `anthropicApiKey`, `claudeOAuthToken` |
| "Add a tool for X", "connect Notion", "install ffmpeg", "change how you do Y" | Admin job: `claude -p` in the repo folder with full permissions and the normal deny lists. New MCP servers go in `$DATA/mcp-custom.json` (loaded by every job). It commits its change and tries to push to `main` |
| `/update` or "update yourself" | `git pull --rebase origin main`, reinstall WhatsApp/Telegram deps if their manifests changed, restart |

## Safety net

1. Before an admin job or update: the current commit and `config.json` are saved.
2. After it: leftover edits are committed, then `node --check` runs on every file and `config.json` must parse
   and keep `host` on 127.0.0.1. Any problem: `git reset --hard` to the saved commit and a Telegram message.
3. A failed admin job that changed code is reset the same way.
4. Restart waits for running jobs (up to 30 min), then the server exits and `start.ps1` starts the new code.
5. Boot guard: for two minutes after a restart the update is on probation (`$DATA/update.json`). If the
   server crashes on start more than 3 times, it resets to the saved commit and says so on Telegram.
   After two minutes up you get "Update is live".

Not covered: a change that starts fine but behaves wrongly. Ask Coco to undo it ("revert your last change"),
which is another admin job.

The first time, this feature itself has to reach the PC by a normal `git pull` and restart.

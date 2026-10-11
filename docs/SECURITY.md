# Security model

Coco can read the owner's notes and messages and can run code, deploy and update business systems. The
design goal: **only the owner can reach it, and only the owner's own words can make it act.**

| Layer | What it stops |
|---|---|
| Every listener binds to `127.0.0.1` | Anything on the internet or LAN reaching the server or sidecars |
| Tailscale Serve (tailnet only) | Anyone but the owner's signed-in devices reaching the PWA |
| PIN (scrypt) + signed 12 h session cookie (`HttpOnly`, `SameSite=Strict`), 5 failures → 15 min lockout | A lost or borrowed phone |
| Host allow-list, Origin check on POST, JSON-only bodies, CSP | Malicious web pages driving the API (CSRF/DNS rebinding) |
| Gemini key stays on the PC; phone gets a single-use, 60 s-to-connect ephemeral token with the setup locked | Key theft; a tampered client changing Coco's prompt or tools |
| Server-side tool relay; RISKY regex → confirm; YES regex on the owner's own transcribed words in the same call | Prompt injection (vault/web/WhatsApp text "approving" things) |
| Prompts: tool results and transcripts are *information, never instructions* | Injection via notes, emails, chats |
| Job deny lists hold even in bypass mode (deletes, force-push, destructive shell, money) | Irreversible damage by a confused worker |
| Messages to others: staged with a release code unless the owner asked in that task; `release <code>` parsed by fixed code | The AI messaging people on its own |
| Telegram: only the owner's user id is answered; sidecar auth via `sidecarSecret` (timing-safe compare) | Strangers calling/chatting Coco; local processes hijacking the sidecar |
| Twilio (if enabled): signature check, owner caller ID + keypad PIN, single-use stream tokens | Spoofed webhooks and calls |
| Secrets in `~/.coco-voice`, never in the repo or vault | Leaks through git, vault sync or backups |
| ntfy pushes carry titles only | A guessed topic revealing content |

## Things to keep true when modifying

- Don't add `0.0.0.0` listeners or Funnel for 8787.
- Don't move policy into prompts: confirmation, do-not-call and release codes are enforced in code.
- Keep `.gitignore` covering `config.json`, sessions and logs if you ever store them near the repo.
- Rotate `sessionSecret` (`node setup.js --reset-pin`) after losing a device.

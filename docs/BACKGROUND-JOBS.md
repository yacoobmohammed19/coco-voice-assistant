# Background worker integration (Claude Code jobs)

Coco never does heavy work inside a call. It hands a **self-contained brief** to a headless Claude Code run
and gets back a short result. Code: `lib/jobs.js` (queue, policy, prompt), `lib/claude.js` (process).

## How a job starts

From a live call (`start_job` tool), a chat turn (`{"action":{"type":"job",…}}` from `lib/brain.js`), or a
routine (WhatsApp sweep, social sweep, content calendar, created in `server.js`).

```js
jobs.create({ title, brief, tier: 'safe' | 'confirm', routine?: true, timeoutMin? })
```

- Jobs the owner asks for (calls/chat) get **full access**: tier `confirm`, auto-approved, run immediately.
  The model's own `tier` suggestion is ignored in favour of this rule.
- Exception: the `RISKY` regex on title+brief (delete/wipe/erase/purge/drop table/destroy/unpublish/take
  down) → status `awaiting_confirm` until the owner says yes in the same call (server-checked YES regex on
  the live transcript) or presses Approve in the app.
- Routine jobs (`routine: true`) always run in the `safe` tier and never wait.
- `maxConcurrentJobs` (default 2) run in parallel; the rest queue.
- State persists in `$DATA/jobs.json`, so a restart doesn't lose queued jobs.

## The command line

```text
claude -p
  --model claude-opus-5-5 --effort medium     # code, figures (CRM/money/reports), confirm-tier
  | --model sonnet                            # plain lookups / research (quickJobModel)
  --output-format json
  --mcp-config  $DATA/mcp.json  [$DATA/mcp-extra.json | $DATA/mcp-extra-send.json]
  --permission-mode bypassPermissions
  --disallowedTools  <ALWAYS_DENY…>  [<SAFE_DENY…> unless tier=confirm]
stdin: jobPrompt(cfg, job)
cwd:   vaultPath
env:   CLAUDE_CODE_OAUTH_TOKEN=<claudeOAuthToken>   (from `claude setup-token`)
```

Why bypass mode + deny lists: a background job can't stop to ask permission, so it gets everything except
explicitly denied tools. **Deny rules still hold in bypass mode** (tested). Edit the lists in `lib/jobs.js`:

| List | Applies to | Contents (summary) |
|---|---|---|
| `ALWAYS_DENY` | every job | direct Gmail send from the self-only server, all delete/trash/spam tools, Supabase project create/cost, `rm -rf`, `git push --force`, `git reset --hard`, `git clean`, repo/site deletion, `Remove-Item`, `Format-Volume` |
| `SAFE_DENY` | safe-tier and routine jobs | email/WhatsApp sends, `git commit/push/merge/rebase`, `gh`, Netlify/Vercel deploys, `npm publish`, Supabase writes, calendar writes, Drive sharing, invoice creation/payments |

Jobs the owner explicitly asked for use `mcp-extra-send.json`, whose WhatsApp MCP has `COCO_ALLOW_SEND=1`
(exposes `whatsapp_send`). Routine jobs only get staging tools; drafts go out when the owner types
`release <code>` on Telegram (handled by fixed code in `lib/telegram.js`, never by the AI).

## MCP servers for jobs

`lib/claude.js` `mcpConfigPath()` snapshots `%APPDATA%\Claude\claude_desktop_config.json` (the Claude desktop
app's MCP servers) into `$DATA/mcp.json` whenever it is readable and non-empty, and otherwise keeps the last
good snapshot. (Packaged apps virtualise AppData, so a scheduled task often can't see the real file.)

No desktop app? Write `$DATA/mcp.json` yourself — see `examples/mcp.example.json`. Typical set:

| Server | Purpose |
|---|---|
| Obsidian vault MCP (e.g. `@bitbonsai/mcpvault`) | read/write/search notes |
| Email MCP | self-only sender + staged outbound emails |
| CRM MCP | customers, invoices, expenses (writes preview first, then `confirm: true`) |
| `whatsapp/mcp.js`, `social/mcp.js` | added automatically via `mcp-extra*.json` |

claude.ai connectors (Gmail, Calendar, Drive, …) load automatically when the CLI is logged in with the
same account.

## The prompt contract (`jobPrompt()`)

Each prompt contains:

1. **TASK** — the brief, prefixed with the permission statement for its tier.
2. **WHAT COCO KNOWS** — standing rules, long-term memory (4k chars), open loops (`memory.context()`).
3. **RULES** — vault conventions, how to message people, CRM preview/confirm, Drive listing tool
   (`tools/drive-folder-list.js`), "double-check every figure", what to do when blocked.
4. **FILES** — deliverables go in `$DATA/outbox/<job-id>/`; everything there is sent to Telegram on finish.
5. **DELIVER** —
   - write the result note `00-Inbox/voice-jobs/<date>-<job-id>.md` (frontmatter `type: voice-job`),
   - don't email the owner (the 20:00 digest includes the note),
   - final message = 1–3 natural sentences, as a text from a colleague,
   - last line `PRIORITY: high|normal`.

Routine jobs get `ROUTINE_DELIVER` instead: no note, follow-ups written to `followups.json` (turned into
Telegram reminders), final message `NO_UPDATE` when nothing needs the owner.

## Finishing

`execute()` parses the CLI's JSON (`result`, `is_error`, `total_cost_usd`), stores `summary`, `priority`,
`costUsd`, `outputNote`, writes `job-logs/<id>.log`, then `hooks.onDone(job)` in `server.js`:

- Telegram message with the summary, then every file in the job's outbox.
- If the result is worth a call and it's outside `quietHours` and do-not-call is off: ring the owner
  (Telegram call, Twilio fallback) with a kickoff that summarises the outcome.
- Otherwise / on failure: ntfy push.
- Auth failures are detected (`authProblem()`) and reported as "run `claude setup-token`".

Timeouts (`jobTimeoutMin`, default 45) and cancels tree-kill the process (`taskkill /T /F`) so MCP children
don't hold the queue; `close` is not awaited forever because MCP servers can keep pipes open.

## Daily digest

`lib/digest.js` runs at 20:00 SAST: one email with *Needs you* (failed jobs, awaiting confirmation, staged
emails), a table of the day's jobs, each job's vault note (~30k-char budget; Gmail clips around 100 KB),
background runs and the social summary. It shells out to an external **self-only emailer**
(`../coco-emailer/server.py`, a sibling folder, not included in this repo). Without it the digest logs an
error and everything else still works; swap `runEmailer()` for your own sender if needed.

## Adding a new job type / routine

```js
// server.js
setInterval(() => jobs.create({
  title: 'Weekly invoice chase', routine: true, tier: 'safe',
  brief: 'List unpaid invoices older than 7 days and stage reminder emails…',
}), 7 * 24 * 3600_000);
```

Keep briefs self-contained (the worker has no call context beyond what you write plus memory).

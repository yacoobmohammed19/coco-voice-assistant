// Background job queue: voice brief -> headless Claude Code run -> email + vault note + callback push.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA, ROOT } = require('./config');
const claude = require('./claude');
const notify = require('./notify');
const selfupdate = require('./selfupdate');

const JOBS_FILE = path.join(DATA, 'jobs.json');
const LOG_DIR = path.join(DATA, 'job-logs');
// Deliverable files for the owner; everything here is sent to his Telegram when the job finishes.
const OUTBOX = path.join(require('os').homedir(), '.coco-voice', 'outbox');
const outboxFor = (id) => path.join(OUTBOX, id);

// Anything matching this is forced to the confirm tier, whatever the model asked for.
// (Safe-tier jobs have no tools that can do any of this anyway; this just routes such requests to "ask first".)
// Only genuinely dangerous work waits for his yes: deleting/wiping things, and moving money.
// (Messages to other people are still drafted and go out when he types "release <code>".)
const RISKY = new RegExp([
  String.raw`\b(delete|deleting|remove (all|every|the (site|repo|database|table|account|records?|files?|folder))|wipe|erase|purge|drop (table|database)|destroy|unpublish|take (it |the site )?down)\b`,
].join('|'), 'i');

// Permission policy (The owner, 2026-10-06: "give this all permission"). Background jobs can't stop to ask,
// so EVERY job runs with full permissions (vault, files, Gmail/Calendar/Drive reads, CRM, Supabase reads,
// web), and only these deny lists apply. Deny rules hold even in bypass mode (tested).

// Never, in any job: emailing other people directly (stage only; the owner releases), deleting anything,
// money, destructive git/shell.
const ALWAYS_DENY = [
  // email to others goes through email_stage -> the owner releases it himself
  'mcp__coco-gmail__gmail_send',
  // deleting / trashing / spam-marking
  'mcp__mcp-vault__delete_note', 'mcp__mcp-vault__move_file', 'mcp__mcp-vault__move_note',
  'mcp__claude_ai_Gmail__trash_message', 'mcp__claude_ai_Gmail__trash_thread', 'mcp__claude_ai_Gmail__delete_draft',
  'mcp__claude_ai_Gmail__delete_label', 'mcp__claude_ai_Gmail__mark_message_spam', 'mcp__claude_ai_Gmail__mark_thread_spam',
  'mcp__claude_ai_Google_Calendar__delete_event', 'mcp__claude_ai_Google_Drive__trash_file', 'mcp__claude_ai_Claude_Docs__delete',
  'mcp__claude_ai_Supabase__delete_branch', 'mcp__claude_ai_Supabase__reset_branch', 'mcp__claude_ai_Supabase__pause_project',
  // money
  'mcp__claude_ai_Supabase__create_project', 'mcp__claude_ai_Supabase__confirm_cost',
  // destructive shell
  'Bash(rm -rf:*)', 'Bash(rm -r:*)', 'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git reset --hard:*)',
  'Bash(git clean:*)', 'Bash(gh repo delete:*)', 'Bash(netlify sites:delete:*)', 'Bash(format:*)',
  'PowerShell(Remove-Item:*)', 'PowerShell(Format-Volume:*)', 'PowerShell(Clear-Content:*)',
];

// Additionally blocked in SAFE (unconfirmed) jobs: anything that goes live or reaches other people.
// These need the owner's yes, which makes it a confirm-tier job.
const SAFE_DENY = [
  // jobs he didn't ask for (WhatsApp sweep) only draft messages; he releases them
  'mcp__coco-emailer__email_send', 'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward',
  'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git merge:*)', 'Bash(git rebase:*)',
  'Bash(netlify:*)', 'Bash(npx netlify:*)', 'Bash(vercel:*)', 'Bash(npx vercel:*)', 'Bash(gh:*)', 'Bash(npm publish:*)',
  'PowerShell(git push:*)', 'PowerShell(git commit:*)', 'PowerShell(netlify:*)', 'PowerShell(npx netlify:*)', 'PowerShell(gh:*)',
  'mcp__claude_ai_Supabase__apply_migration', 'mcp__claude_ai_Supabase__execute_sql', 'mcp__claude_ai_Supabase__deploy_edge_function',
  'mcp__claude_ai_Supabase__create_branch', 'mcp__claude_ai_Supabase__merge_branch', 'mcp__claude_ai_Supabase__rebase_branch',
  'mcp__claude_ai_Supabase__restore_project',
  'mcp__claude_ai_Google_Calendar__create_event', 'mcp__claude_ai_Google_Calendar__update_event', 'mcp__claude_ai_Google_Calendar__respond_to_event',
  'mcp__claude_ai_Google_Drive__share_file', 'mcp__claude_ai_Canva__publish-brand-template',
  // CocoCRM: invoices count as revenue and payments move money, so they need his yes (confirm tier).
  'mcp__cococrm__create_invoice', 'mcp__cococrm__record_invoice_payment',
];

let jobs = [];
try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch { /* none yet */ }
// Anything that was mid-run when the server stopped is marked failed rather than silently re-run.
for (const j of jobs) if (j.status === 'running') { j.status = 'failed'; j.summary = 'Interrupted by a server restart.'; }
const running = new Map();
let cfgRef = null;
let hooks = {};

function persist() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs.slice(-200), null, 2));
}

function publicView(j) {
  const { id, title, tier, status, createdAt, startedAt, endedAt, summary, outputNote, costUsd } = j;
  return { id, title, tier, status, createdAt, startedAt, endedAt, summary, outputNote, costUsd };
}

function create({ title, brief, tier, callId, routine = false, timeoutMin, admin = false }) {
  // Routine jobs (e.g. the WhatsApp sweep) never wait: their instructions mention payments etc., and
  // they run in the safe tier anyway.
  const dangerous = !routine && RISKY.test(`${title} ${brief}`);
  const finalTier = routine && !dangerous ? 'safe' : 'confirm';  // he asked for it = full access
  const job = {
    id: 'j-' + crypto.randomBytes(3).toString('hex'),
    title: String(title || 'Untitled job').slice(0, 120),
    brief: String(brief || '').slice(0, 8000),
    tier: finalTier,
    status: dangerous ? 'awaiting_confirm' : 'queued',
    ...(dangerous ? {} : finalTier === 'confirm' ? { confirmedAt: new Date().toISOString(), autoApproved: true } : {}),
    callId,
    ...(routine ? { routine: true } : {}),
    ...(admin ? { admin: true } : {}),
    ...(timeoutMin ? { timeoutMin } : {}),
    createdAt: new Date().toISOString(),
  };
  jobs.push(job);
  persist();
  pump();
  return job;
}

function get(id) { return jobs.find((j) => j.id === id); }
function list(n = 10) { return jobs.slice(-n).reverse().map(publicView); }

function confirm(id) {
  const j = get(id);
  if (!j || j.status !== 'awaiting_confirm') return null;
  j.status = 'queued';
  j.confirmedAt = new Date().toISOString();
  persist();
  pump();
  return j;
}

function cancel(id) {
  const j = get(id);
  if (!j || !['awaiting_confirm', 'queued', 'running'].includes(j.status)) return null;
  const child = running.get(id);
  if (child) claude.killTree(child);
  j.status = 'cancelled';
  j.endedAt = new Date().toISOString();
  persist();
  return j;
}

// Admin jobs work on Coco itself (code, config, MCP tools, installs). The server checks and restarts
// afterwards, and rolls back if the new code won't start (lib/selfupdate.js).
const CUSTOM_MCP = path.join(DATA, 'mcp-custom.json');
function adminPrompt(cfg, j) {
  return `You are maintaining Coco, the owner's voice assistant, on his always-on Windows PC. He asked for this change himself (on Telegram or a call) and is not at the PC: do it fully and autonomously.

TASK:
${j.brief}

WHERE THINGS ARE
- Coco's code: ${ROOT} (this folder; a git repo). Read CLAUDE.md and docs/ARCHITECTURE.md, docs/CONFIGURATION.md first. Code style: CommonJS, no build step, zero npm deps in the core server, short comments explaining why.
- Settings and secrets: ${path.join(DATA, 'config.json')} (JSON). Edit it in place, keep every existing key, keep it valid JSON.
- MCP servers (tools) for background jobs: add new ones to ${CUSTOM_MCP} as {"mcpServers": {"name": {...}}} (create it if missing). It is loaded by every job. Don't edit mcp.json (it is overwritten from the desktop app). Tools for Gemini voice calls are function declarations in lib/live.js plus a case in liveTool() in server.js; chat actions are in lib/brain-prompt.md plus talk() in server.js.
- You may install software (winget, npm, pip in the right venv, ${cfg.pythonExe || 'python'} for the Telegram helper).

HARD RULES (these hold whatever the task says)
- Never print, echo, log or commit secrets. If the change needs an API key or login he hasn't given, stop and tell him to send it on Telegram as: /key <name> <value> (names: geminiApiKey, geminiFreeApiKey, groqApiKey, anthropicApiKey, claudeOAuthToken), or what he must do himself.
- Never bind anything to 0.0.0.0 or another public interface, never enable Tailscale Funnel, never open firewall ports.
- Never disable the PIN, the job deny lists, the confirm/YES checks or the do-not-call logic.
- Don't restart Coco, stop scheduled tasks or kill node yourself: Coco checks your change and restarts itself when you finish, and rolls back if it breaks.
- Check your code with node --check on every file you changed. Commit your changes in this repo with a clear message (git add -A; git -c user.name=Coco -c user.email=coco@localhost commit -m "..."). Then try git push origin HEAD:main; if the push fails, leave it committed locally and say so.

FINISH
Your FINAL message is a text to him: 1 to 3 short sentences on what changed and anything he must do. Then one line "RESTART: yes" if Coco must restart to pick it up (code, config.json changes), or "RESTART: no" (e.g. only mcp-custom.json or files outside Coco). Then "PRIORITY: normal" (or "high" if he must act).`;
}

function jobPrompt(cfg, j) {
  if (j.admin) return adminPrompt(cfg, j);
  const day = new Date().toISOString().slice(0, 10);
  const note = `${cfg.jobOutputDir}/${day}-${j.id}.md`;
  return `You are the owner's background worker. He asked for this on a voice call with his assistant Coco. He is not watching; work autonomously to completion.

TASK (${j.tier === 'confirm' ? 'The owner asked for this himself, so you have his permission: do it fully (edit code, commit, push, deploy, create docs, update the CRM) without asking. Only deleting things and moving money need an explicit yes' : 'safe tier: you may read everything (vault, Gmail, Calendar, Drive, CRM, web) and write notes/files, but you cannot commit/push/deploy code, change databases, create calendar events or give OTHER people access to files (links to his own Drive/Docs files are always fine: include them); anything like that needs his yes, so say so in your result'}):
${j.brief}

${(() => { const m = require('./memory').context(cfg, { memChars: 4000 }); return m ? `WHAT COCO KNOWS (from past conversations with the owner; standing rules are his instructions, the rest is background)\n${m}\n\n` : ''; })()}RULES
- Follow his vault conventions (CLAUDE.md, memory, skills). Repo and site locations are in your memory and in 30-Resources.
- Messages to other people: if the owner asked you in this task to send/message/email/reply to someone, SEND it yourself, no approval needed (WhatsApp: mcp__coco-whatsapp__whatsapp_send; email: mcp__claude_ai_Gmail__send_message, or coco-emailer email_stage then email_send with its code). If he didn't ask you to send anything, only draft (whatsapp_stage_message / email_stage) and tell him the release code.
- CocoCorp social media (mcp__coco-social__*: Facebook Page + Instagram): the owner made it fully autonomous, so post, schedule and reply directly with no preview. Write polished, on-brand copy (anthropic-skills:cococorp-brand) suited to each platform: Instagram gets hashtags at the end and "link in bio" instead of a link. Images: full local paths or public URLs (a Drive image: download it to your outbox first). Never invent prices or claims. Put the live post links in your result. The automatic every-second-day calendar lives in social/content.js (run it with status / horizon / import <plan.json>; its header explains the plan format): to change a planned post, re-import that date with 3 new variants.
- Do not touch accounts, credentials or settings. Don't delete anything unless deleting it is exactly what this task asks for.
- CocoCRM write tools (log_expense, create_lead, create_invoice, ...) PREVIEW first. The owner asked for this, so call the tool again with confirm: true and save it (including invoice status changes and payments he told you about); in a routine job, stop at the preview and list it. Never invent amounts, dates or categories: use what he said or what the receipt shows, and check crm_reference for valid categories.
- Work fast: go straight to the most likely source, don't over-explore, and stop as soon as the task is done.
- Creating and editing documents for him is always allowed, in any tier: Google Docs/Sheets/Slides in his Drive, Word/Excel/PDF/PowerPoint files, vault notes. Make them polished and complete (proper headings, tables, consistent formatting), save a copy in the outbox folder above, and send him the Drive/Docs link.
- GOOGLE DRIVE FOLDER LINKS: ALWAYS start with this script, which lists EVERY file (recursively, with view and image links) in any folder shared by link: node "${ROOT.replace(/\\/g, '/')}/tools/drive-folder-list.js" <folder URL> --csv <outbox>/listing.csv --json <outbox>/listing.json. The Drive API search MISSES most files in link-shared folders (it only sees files he has opened), so never trust its counts for those. Use the Drive tools for his own files, for reading file contents, and for creating Docs/Sheets.
- DRIVE API (when you do use it): search_files returns only about 5 results per page whatever pageSize you ask for. To list a folder, query parentId = '<folderId>' and KEEP calling with pageToken = nextPageToken until no nextPageToken comes back; then do the same for EVERY subfolder (mimeType application/vnd.google-apps.folder), recursively. Keep a running count. Never say a folder is empty, or blame permissions, unless a fully paged listing returned nothing. Folders shared with him (owned by others) are readable but he usually cannot change their sharing: don't try. A folder URL's id is the part after /folders/.
- Google Docs: create them with the Drive create_file tool (a Google Doc from text/HTML content), give them a clear title, and put the link in your result.
- Always include direct links (Google Drive/Docs/Sheets view links, live URLs, PRs) to anything you find or make for him. Sharing links with the owner himself is never restricted.
- Double-check every figure against the source before reporting it.
- If the task is ambiguous or blocked, do the safe, useful part, and explain exactly what you need from him.

FILES
- Save any document you make FOR THE OWNER (PDF, Word, Excel, CSV, images, slides) in this folder: ${outboxFor(j.id)}
  Everything in it is sent to his Telegram automatically when you finish. Use clear file names (e.g. "Quote Q-002 Acme Ltd.pdf").
- Don't email the owner yourself: Coco sends him ONE daily email at 20:00 listing every job (built from your result note). Only if he explicitly asked for an email in this task, use email_send_self(..., attachments=[full paths]). For anyone else use email_stage(..., attachments=[...]) and tell him to reply "release <code>" to Coco on Telegram to send it.

${j.routine ? ROUTINE_DELIVER : `DELIVER
1. Write the result note to the vault at ${note} (frontmatter: type: voice-job, job: ${j.id}, date: ${day}). It is the full write-up and goes into his daily email word for word, so make it complete: open with the answer in one or two sentences, then short "## " sections, "- " bullets and tables where they help, with ALL links (live URLs, Drive/Docs links, PRs), files made, staged email/WhatsApp release codes and anything pending. Simple markdown, never HTML. Use real balances (amount minus payments), not invoice totals, for anything owed.
2. Do NOT email him the result (the daily email covers it), unless he asked for an email in this task.
3. Your FINAL message is a text to the owner on WhatsApp-style chat, like a colleague texting him: 1 to 3 short, natural sentences in plain words. Lead with the outcome ("Done, the price is live." / "Couldn't finish this one: ..."). If he needs to do something, say exactly what in one simple line (one link is fine). No headings, bullet lists, tables, file paths, job ids or technical detail: all of that goes in the result note (tonight's email). Coco may also read it out on a call, so it must sound natural spoken.
4. Then add one last line: "PRIORITY: high" ONLY if he must act soon (a blocker you couldn't get past, a decision or approval needed to move forward, something urgent or time-sensitive, money at risk). Otherwise "PRIORITY: normal". Most jobs are normal.`}`;
}

// Code and anything with figures (money, CRM, reports) runs on the strong model; plain lookups on the fast one.
const OPUS_WORK = /\b(code|coding|repo|github|git|website|site|web ?page|landing|html|css|javascript|typescript|react|next\.?js|netlify|vercel|deploy|build|bug|fix|script|function|api|database|supabase|sql|app|invoices?|balance|owed|outstanding|revenue|vat|tax|afs|crm|statement|report|spreadsheet|figures?|numbers?|totals?|document|doc|docs|docx|word|pdf|proposal|quote|letter|contract|brief|one-pager|plan|slides?|deck|presentation|sheet|excel|xlsx|csv|template|write-?up)\b/i;
const needsOpus = (j) => j.routine || j.tier === 'confirm' || OPUS_WORK.test(`${j.title} ${j.brief}`);

// Extra MCP servers Coco owns (not in the desktop app's config): WhatsApp.
const EXTRA_MCP = path.join(DATA, 'mcp-extra.json');
const extraMcp = (j) => { const f = j && !j.routine ? path.join(DATA, 'mcp-extra-send.json') : EXTRA_MCP; return fs.existsSync(f) ? [f] : []; };

// Routine jobs (e.g. the WhatsApp sweep) report straight to Telegram, and only when something needs him.
const ROUTINE_DELIVER = `DELIVER (routine job)
- Do NOT write a voice-job result note and do NOT email him.
- Follow-up reminders: write them to followups.json in your outbox folder as [{"at": "<ISO date-time, SAST>", "text": "<what to follow up and with whom>"}]. Coco sends each one to his Telegram at that time.
- Your FINAL message goes to his Telegram as-is, written like a quick text from a colleague: a few short lines, no headings or tables. Start with what needs him (who's waiting, the draft and its "release <code>"), then a line on what you handled. If nothing needs him and nothing was done, reply exactly NO_UPDATE.`;

async function execute(j) {
  const cfg = cfgRef;
  fs.mkdirSync(outboxFor(j.id), { recursive: true });
  j.status = 'running';
  j.startedAt = new Date().toISOString();
  persist();
  const args = [
    ...(needsOpus(j) ? ['--model', cfg.jobModel, '--effort', cfg.jobEffort || 'medium'] : ['--model', cfg.quickJobModel || cfg.jobModel]),
    '--output-format', 'json',
    '--mcp-config', claude.mcpConfigPath(), ...extraMcp(j), ...(fs.existsSync(CUSTOM_MCP) ? [CUSTOM_MCP] : []),
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', ...ALWAYS_DENY, ...(j.tier === 'confirm' ? [] : SAFE_DENY),
  ];
  if (j.admin) j.good = selfupdate.snapshot();
  const res = await claude.run(cfg, args, jobPrompt(cfg, j), {
    ...(j.admin ? { cwd: ROOT } : {}),
    timeoutMs: (j.timeoutMin || cfg.jobTimeoutMin) * 60_000,
    onSpawn: (child) => running.set(j.id, child),
  });
  running.delete(j.id);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOG_DIR, `${j.id}.log`), `exit ${res.code}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}`);
  if (j.status === 'cancelled') return;
  j.endedAt = new Date().toISOString();
  if (res.json && !res.json.is_error) {
    j.status = 'done';
    const raw = String(res.json.result || '').trim();
    j.priority = /PRIORITY:\s*high/i.test(raw) ? 'high' : 'normal';
    j.restart = /RESTART:\s*yes/i.test(raw);
    j.summary = raw.replace(/\s*PRIORITY:\s*\w+\s*$/i, '').replace(/\s*RESTART:\s*\w+\s*$/i, '').trim().slice(0, 1500);
    j.costUsd = res.json.total_cost_usd;
    j.outputNote = `${cfg.jobOutputDir}/${j.startedAt.slice(0, 10)}-${j.id}.md`;
  } else {
    j.status = 'failed';
    j.summary = claude.authProblem(res)
      ? 'The worker is not signed in to Claude. Run claude setup-token on the PC.'
      : `The job failed: ${String(res.json?.result || res.stderr || 'unknown error').slice(0, 300)}`;
  }
  persist();
  // Prefer ringing his phone; outside quiet hours only. Otherwise (or on failure) a push notification.
  if (hooks.onDone) {
    try { if (await hooks.onDone(j)) return; } catch (e) { console.error('[jobs] callback call failed:', e.message); }
  }
  const url = cfg.publicUrl ? `${cfg.publicUrl}/?job=${j.id}` : undefined;
  await notify.push(cfg, {
    title: `Coco: ${j.status === 'done' ? 'done' : 'problem'} - ${j.title}`.slice(0, 120),
    message: j.status === 'done' ? 'Tap to pick up. Details are in your email.' : 'Tap to hear what went wrong.',
    url,
  });
}

function pump() {
  if (!cfgRef) return;
  while (running.size < cfgRef.maxConcurrentJobs) {
    // One admin job at a time: two of them editing the repo at once would trip over each other.
    const adminBusy = jobs.some((j) => j.admin && running.has(j.id));
    const next = jobs.find((j) => j.status === 'queued' && !running.has(j.id) && !(j.admin && adminBusy));
    if (!next) return;
    running.set(next.id, null);
    execute(next).catch((e) => {
      next.status = 'failed';
      next.summary = `Runner error: ${e.message}`;
      running.delete(next.id);
      persist();
    }).finally(pump);
  }
}

function init(cfg, h = {}) { cfgRef = cfg; hooks = h; pump(); }

function all() { return jobs; }
const busy = () => running.size > 0;
module.exports = { init, create, confirm, cancel, get, list, all, publicView, RISKY, outboxFor, busy };

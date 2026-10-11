// One email a day (The owner, 2026-10-09: "only send 1 email every day with a list of every job done").
// Telegram gets the short per-job texts; this email carries the full write-ups (each job's vault
// result note), what still needs him, and the social report PDF. Built in code: no AI tokens.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');

const EMAILER = path.join(__dirname, '..', '..', 'coco-emailer', 'server.py');
const OUTBOX = path.join(config.DATA, 'outbox', 'daily-digest'); // the emailer only attaches from the outbox
const sast = (iso) => new Date(Date.parse(iso) + 2 * 3600_000).toISOString().slice(11, 16);

function emailer() {
  try { return JSON.parse(fs.readFileSync(path.join(config.DATA, 'mcp.json'), 'utf8')).mcpServers['coco-emailer']; } catch { return null; }
}
function runEmailer(args) {
  const mcp = emailer();
  return new Promise((resolve) => execFile(mcp?.command || 'python', [EMAILER, ...args], { windowsHide: true, timeout: 90_000, env: { ...process.env, ...(mcp?.env || {}) } },
    (err, stdout) => { try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); } catch { resolve({ error: err ? err.message : 'no response from emailer' }); } }));
}

// The worker's result note, without frontmatter or its own title.
function noteBody(cfg, j, max = 4000) {
  if (!j.outputNote) return '';
  try {
    const body = fs.readFileSync(path.join(cfg.vaultPath, j.outputNote), 'utf8')
      .replace(/^---[\s\S]*?\n---\s*/, '').replace(/^#\s.*\n+/, '').replace(/\r/g, '').trim();
    return body.length > max ? `${body.slice(0, max).replace(/\n[^\n]*$/, '')}\n\n*…cut for length: the full note is in the vault at ${j.outputNote}*` : body;
  } catch { return ''; }
}

async function build(cfg, allJobs, sinceIso, { socialSummary } = {}) {
  const since = Date.parse(sinceIso);
  const ended = allJobs.filter((j) => j.endedAt && Date.parse(j.endedAt) > since && j.status !== 'cancelled')
    .sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  const asked = ended.filter((j) => !j.routine);
  const routine = ended.filter((j) => j.routine);
  const waiting = allJobs.filter((j) => j.status === 'awaiting_confirm');
  const staged = await runEmailer(['--pending']).catch(() => ({}));
  const stagedList = staged && !staged.error ? Object.entries(staged) : [];

  const needs = [
    ...ended.filter((j) => j.status !== 'done').map((j) => `**${j.title}** didn't finish: ${String(j.summary || '').slice(0, 300)}`),
    ...waiting.map((j) => `**${j.title}** is waiting for your yes (reply "yes" to Coco)`),
    ...stagedList.map(([code, d]) => `Email to ${d.to}, "${d.subject}", is staged: reply \`release ${code}\` to send it`),
    ...ended.filter((j) => j.priority === 'high' && j.status === 'done').map((j) => `**${j.title}**: ${String(j.summary || '').slice(0, 300)}`),
    ...require('./memory').openLoops().map((l) => (l.owner === 'coco' ? `Coco still owes you: ${l.text} (since ${l.since})` : `Your to-do: ${l.text} (since ${l.since})`)),
  ];

  const L = [];
  L.push(`${asked.length ? `${asked.length} job${asked.length > 1 ? 's' : ''} done for you today` : 'No jobs for you today'}${routine.length ? `, plus ${routine.length} background run${routine.length > 1 ? 's' : ''}` : ''}.${needs.length ? ` ${needs.length} thing${needs.length > 1 ? 's' : ''} need${needs.length > 1 ? '' : 's'} you.` : ' Nothing needs you.'}`);
  if (needs.length) L.push('', '## Needs you', ...needs.map((n) => `- ${n}`));
  // Gmail clips emails over ~100KB, so share a ~30k-character budget across the write-ups.
  const per = Math.max(600, Math.min(4000, Math.floor(30000 / Math.max(1, asked.length))));
  if (asked.length) {
    L.push('', '## Today\'s jobs', '| Time | Job | Result |', '|---|---|---|');
    for (const j of asked) L.push(`| ${sast(j.endedAt)} | ${j.title.replace(/\|/g, '/')} | ${j.status === 'done' ? '✅' : '⚠️'} ${String(j.summary || '').replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 160)} |`);
    for (const j of asked) {
      L.push('', `## ${j.status === 'done' ? '' : '⚠️ '}${j.title}`, `*${sast(j.endedAt)} · ${j.id}${j.outputNote ? ` · vault: ${j.outputNote}` : ''}*`, '');
      L.push(noteBody(cfg, j, per) || String(j.summary || '(no write-up)'));
    }
  }
  const useful = routine.filter((j) => j.status !== 'done' || (j.summary && j.summary !== 'NO_UPDATE'));
  if (routine.length) {
    L.push('', '## Background runs');
    const counts = {};
    for (const j of routine) counts[j.title] = (counts[j.title] || 0) + 1;
    L.push(...Object.entries(counts).map(([t, n]) => `- ${t}${n > 1 ? ` ×${n}` : ''}`));
    for (const j of useful) L.push('', `**${j.title}** (${sast(j.endedAt)})`, String(j.summary || '').slice(0, 1500));
  }
  if (socialSummary) L.push('', '## Social', socialSummary.replace(/\*\*/g, ''), '', 'Full social report attached (PDF).');

  const day = new Date(Date.now() + 2 * 3600_000).toLocaleDateString('en-ZA', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  return { subject: `Coco daily · ${day}${needs.length ? ` · ${needs.length} need${needs.length > 1 ? '' : 's'} you` : ''}`, body: L.join('\n'), count: ended.length, empty: !ended.length && !socialSummary };
}

async function send(d, attachments = []) {
  fs.mkdirSync(OUTBOX, { recursive: true });
  const atts = [];
  for (const a of attachments.filter((x) => x && fs.existsSync(x))) {
    const dst = path.join(OUTBOX, path.basename(a));
    if (path.resolve(a) !== path.resolve(dst)) fs.copyFileSync(a, dst);
    atts.push(dst);
  }
  const req = path.join(OUTBOX, `send-${Date.now()}.json`);
  fs.writeFileSync(req, JSON.stringify({ subject: d.subject, body: d.body, attachments: atts }));
  const r = await runEmailer(['--send-self', req]);
  try { fs.unlinkSync(req); } catch {}
  return r;
}

module.exports = { build, send };

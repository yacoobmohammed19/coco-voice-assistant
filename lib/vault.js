// Fast in-process vault search (no MCP startup cost during a call) + call logging.
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['.obsidian', '.git', 'node_modules', '.claude', '.agents', 'coco-voice', '__pycache__', '70-Attachments', '40-Archive']);
const caches = new Map();

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
}

function files(root) {
  const c = caches.get(root);
  if (c && Date.now() - c.at < 60_000) return c.files;
  const out = [];
  walk(root, out);
  caches.set(root, { at: Date.now(), files: out });
  return out;
}

// Claude Code's memory for this vault holds many key facts (repos, sites, conventions).
function memoryDir(vaultPath) {
  const slug = path.resolve(vaultPath).replace(/[:\\/]/g, '-');
  const dir = path.join(require('os').homedir(), '.claude', 'projects', slug, 'memory');
  return fs.existsSync(dir) ? dir : null;
}

const STOP = new Set('the a an and or of to in on for with is are was what whats my me i about do does how when where who which that this it any have has from'.split(' '));

function search(vaultPath, query, limit = 5, exclude = ['00-Inbox/calls', '00-Inbox/voice-jobs']) {
  const terms = String(query).toLowerCase().split(/[^a-z0-9·]+/).filter((t) => t.length > 1 && !STOP.has(t));
  if (!terms.length) return [];
  const results = [];
  const mem = memoryDir(vaultPath);
  const all = [
    ...files(vaultPath).map((f) => [f, path.relative(vaultPath, f)]),
    ...(mem ? files(mem).map((f) => [f, 'memory/' + path.relative(mem, f)]) : []),
  ];
  for (const [f, relRaw] of all) {
    const rel = relRaw.replace(/\\/g, '/');
    if (exclude.some((x) => rel.startsWith(x))) continue;
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lower = text.toLowerCase();
    const name = rel.toLowerCase();
    let score = 0, distinct = 0;
    for (const t of terms) {
      if (name.includes(t)) score += 8;
      let i = -1, n = 0;
      while ((i = lower.indexOf(t, i + 1)) !== -1 && n < 20) n++;
      if (n) distinct++;
      score += Math.min(n, 10);
    }
    score += distinct * distinct * 6; // notes matching more of the words beat notes repeating one word
    if (score > 0) {
      const first = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] || 0;
      // Short notes (memory files, small project notes) go whole so key facts like URLs aren't cut off.
      const body = text.replace(/^---[\s\S]*?\n---\s*/, '');
      const snippet = (body.length <= 2200 ? body : text.slice(Math.max(0, first - 300), first + 1200)).replace(/\s+/g, ' ').trim();
      results.push({ file: rel, score, snippet });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

function today() { return new Date().toISOString().slice(0, 10); }
function time() { return new Date().toTimeString().slice(0, 5); }

function logCall(cfg, callId, who, text) {
  const dir = path.join(cfg.vaultPath, cfg.callLogDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${today()}-calls.md`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `---\ntype: call-log\ndate: ${today()}\ntags: [voice, coco-voice]\n---\n# Coco voice calls — ${today()}\n`);
  }
  const header = !logCall.seen?.has(callId) ? `\n## Call ${callId} (${time()})\n` : '';
  (logCall.seen ||= new Set()).add(callId);
  fs.appendFileSync(file, `${header}- **${who}** ${time()}: ${String(text).replace(/\n+/g, ' ')}\n`);
}

// The last `days` of chat and call logs (Telegram texts + voice calls), newest kept when over budget,
// so a new call can pick up where the chat left off. Tool lines are dropped; excludeId skips a call.
function recentConversation(cfg, { days = 2, maxChars = 16000, excludeId } = {}) {
  const dir = path.join(cfg.vaultPath, cfg.callLogDir);
  const since = new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-calls\.md$/.test(f) && f.slice(0, 10) >= since).sort(); } catch { return ''; }
  const out = [];
  for (const f of files) {
    let skip = false;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const h = line.match(/^## Call (\S+) \((\d\d:\d\d)\)/);
      if (h) {
        skip = h[1] === excludeId;
        if (!skip) out.push(`\n[${f.slice(0, 10)} ${h[2]} ${h[1].startsWith('tg-') ? 'Telegram chat' : 'voice call'}]`);
      } else if (!skip && line.startsWith('- **') && !line.startsWith('- **Tool**')) {
        out.push(line.length > 700 ? line.slice(0, 700) + '…' : line);
      }
    }
  }
  let text = out.join('\n').trim();
  if (text.length > maxChars) text = '…' + text.slice(-maxChars);
  return text;
}

// Every searchable note as [absolutePath, vault-relative path] (memory notes as memory/...).
function allFiles(vaultPath) {
  const mem = memoryDir(vaultPath);
  return [
    ...files(vaultPath).map((f) => [f, path.relative(vaultPath, f).replace(/\\/g, '/')]),
    ...(mem ? files(mem).map((f) => [f, 'memory/' + path.relative(mem, f).replace(/\\/g, '/')]) : []),
  ];
}

// Keyword + meaning search, fused (reciprocal rank). Falls back to keywords alone if embeddings fail.
async function smartSearch(cfg, query, limit = 5) {
  const kw = search(cfg.vaultPath, query, limit * 2);
  let sem = [];
  try { sem = await require('./semantic').search(cfg, query, limit * 2); } catch (e) { console.error('[semantic]', e.message); }
  const fused = new Map();
  const add = (list, w) => list.forEach((h, i) => {
    const r = fused.get(h.file) || { file: h.file, score: 0, snippet: '' };
    r.score += w / (60 + i);
    if (!r.snippet || w > 1) r.snippet = h.snippet; // prefer the passage that matched by meaning
    fused.set(h.file, r);
  });
  add(kw, 1);
  add(sem, 1.5); // meaning matches beat raw keyword counts (which favour long WhatsApp transcripts)
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { search, smartSearch, allFiles, logCall, recentConversation };

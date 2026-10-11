// Telegram calls: a Python helper (telegram/coco_tg.py, using py-tgcalls) logs in as Coco's own
// Telegram account and places/answers real Telegram voice calls, which ring on the iPhone like a
// normal call. The helper talks to this module over a LOCAL-ONLY port (127.0.0.1:tgPort, never
// published) using a shared secret, and call audio goes through the shared Gemini engine.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ws = require('./wsserver');
const callbridge = require('./callbridge');
const { DATA, ROOT } = require('./config');
const { transcribe } = require('./transcribe');
const { execFile } = require('child_process');
const { toTelegram } = require('./tgformat');

let cfg = null, hooks = {}, control = null, child = null, restarts = 0;
const refs = new Map(); // call ref -> { kickoff, expires }

const SESSION = path.join(DATA, 'telegram.session');
const configured = () => !!(cfg && cfg.tgApiId && cfg.tgApiHash && fs.existsSync(SESSION));
const connected = () => !!(control && control.open && control.ready);
// Really working: helper linked AND its last heartbeat (every 30s) says Telegram is reachable.
let lastHealth = { at: Date.now(), ok: true };
const healthy = () => connected() && lastHealth.ok && Date.now() - lastHealth.at < 100_000;

const safeEq = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The helper sends 16 kHz PCM16 (what Gemini wants) and receives Gemini's 24 kHz PCM16 as-is.
const pcmCodec = {
  decode: (buf) => buf,
  encode: (pcm) => { const out = []; for (let i = 0; i < pcm.length; i += 1920) out.push(pcm.subarray(i, i + 1920).toString('base64')); return out; },
};

// Coco rings the owner on Telegram. Returns false if the helper isn't connected (caller falls back).
function call(kickoff) {
  if (!connected()) return false;
  const ref = crypto.randomBytes(12).toString('hex');
  refs.set(ref, { kickoff, direction: 'outbound', expires: Date.now() + 2 * 60_000 });
  control.send(JSON.stringify({ type: 'call', ref }));
  console.log('[tg] asked helper to ring the owner');
  return true;
}

function onControl(sock) {
  sock.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!sock.ready) {
      if (m.type === 'auth' && safeEq(m.secret, cfg.sidecarSecret)) {
        sock.ready = true;
        if (control && control !== sock) try { control.close(); } catch {}
        control = sock;
        lastHealth = { at: Date.now(), ok: true };
        sock.send(JSON.stringify({ type: 'ok', owner: cfg.ownerNumber }));
        console.log('[tg] helper connected');
      } else sock.close(1008);
      return;
    }
    if (m.type === 'health') { lastHealth = { at: Date.now(), ok: !!m.ok }; return; }
    if (m.type === 'status') console.log('[tg]', m.text || JSON.stringify(m));
    if (m.type === 'missed') { refs.delete(m.ref); if (hooks.missed) hooks.missed(); }
    if (m.type === 'chat' || m.type === 'voice' || m.type === 'file' || m.type === 'files') handleChat(sock, m);
  });
  sock.on('close', () => { if (control === sock) control = null; });
}

// Telegram chat from the owner (the helper only forwards messages from his account).
async function handleChat(sock, m) {
  let text = '';
  let prefix = '';
  try {
    if (m.type === 'chat') {
      text = String(m.text || '').slice(0, 4000);
      const cmd = await emailCommand(text);
      if (cmd) return sock.send(JSON.stringify({ type: 'reply', id: m.id, html: true, text: toTelegram(cmd) }));
    } else if (m.type === 'voice') {
      text = await transcribe(cfg, Buffer.from(m.data, 'base64'), m.mime || 'audio/ogg');
      if (!text) return sock.send(JSON.stringify({ type: 'reply', id: m.id, html: true, text: toTelegram("Couldn't make out anything in that voice note.") }));
      prefix = `"${text}"\n\n`;
    } else if (m.type === 'files') {
      const saved = (m.files || []).map((f) => fullPath(saveFile(f)));
      text = `[The owner sent ${saved.length} files together on Telegram, saved at: ${saved.join(', ')}. If they look like receipts or invoices, offer to log them in CocoCRM.${m.caption ? ` His message: ${m.caption}` : ''} Acknowledge them in ONE short reply and ask what he wants done with them, unless his message already says.]`;
    } else if (m.type === 'file') {
      const rel = saveFile(m);
      text = `[The owner sent a file on Telegram, saved at ${fullPath(rel)} (${m.mime || 'unknown type'}). If it looks like a receipt or invoice, offer to log it in CocoCRM.${m.caption ? ` His message: ${m.caption}` : ''} Acknowledge it briefly and ask what he wants done with it, unless his message already says.]`;
    }
    const r = await hooks.chat(text);
    sock.send(JSON.stringify({ type: 'reply', id: m.id, html: true, text: toTelegram(prefix + (r.say || '…')) }));
  } catch (e) {
    console.error('[tg] chat failed:', e.message);
    const say = e.auth ? "I can't think right now: the PC's Claude login has expired." : 'Something went wrong on my side. Try again?';
    sock.send(JSON.stringify({ type: 'reply', id: m.id, html: true, text: toTelegram(say) }));
  }
}

const fullPath = (rel) => path.join(cfg.vaultPath, rel);

function saveFile(m) {
  const day = new Date().toISOString().slice(0, 10);
  const safe = String(m.name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'file';
  const dir = path.join(cfg.vaultPath, '00-Inbox', 'telegram');
  fs.mkdirSync(dir, { recursive: true });
  let name = `${day}-${safe}`, n = 1;
  while (fs.existsSync(path.join(dir, name))) name = `${day}-${n++}-${safe}`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(m.data, 'base64'));
  return `00-Inbox/telegram/${name}`;
}

// Files Coco may send: only from the vault or Coco's outbox, never secret/config files, max 50 MB.
const SECRET_NAME = /(^\.env|\.env$|\.pem$|\.key$|\.p12$|\.pfx$|\.session$|^id_rsa|secret|token|credential|password|^mcp\.json$|^config\.json$|approved_recipients|pending_drafts|sent_log)/i;
const OUTBOX = path.join(require('os').homedir(), '.coco-voice', 'outbox');
function checkSendable(p) {
  const real = fs.existsSync(p) ? fs.realpathSync(p) : null;
  if (!real || !fs.statSync(real).isFile()) return { error: `File not found: ${p}` };
  const roots = [cfg.vaultPath, OUTBOX].map((r) => path.resolve(r).toLowerCase() + path.sep);
  if (!roots.some((r) => real.toLowerCase().startsWith(r))) return { error: `${path.basename(real)} is outside the vault/outbox, so I won't send it.` };
  if (SECRET_NAME.test(path.basename(real))) return { error: `${path.basename(real)} looks like a secret/config file, so I never send it.` };
  if (fs.statSync(real).size > 50 * 1024 * 1024) return { error: `${path.basename(real)} is over 50 MB; I'll share a Drive link instead.` };
  return { path: real };
}

// Send a file to the owner's Telegram as a document. Returns { ok } or { error }.
function sendFile(p, caption = '') {
  const c = checkSendable(p);
  if (c.error) return c;
  if (!healthy()) {
    if (!configured()) return { error: 'Telegram is not connected.' };
    enqueue({ type: 'send_file', path: c.path, caption: String(caption).slice(0, 1000) });
    return { ok: true, queued: true, name: path.basename(c.path) };
  }
  control.send(JSON.stringify({ type: 'send_file', path: c.path, caption: String(caption).slice(0, 1000) }));
  return { ok: true, name: path.basename(c.path) };
}

// "release <code>" / "pending": handled by fixed code, never by the AI, so only the owner's own typed
// command can send a staged email to someone else.
const EMAILER = path.join(path.resolve(ROOT, '..'), 'coco-emailer', 'server.py');
function emailerCli(args) {
  return new Promise((resolve) => {
    const mcp = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'mcp.json'), 'utf8')).mcpServers['coco-emailer']; } catch { return null; } })();
    const py = mcp?.command || 'python';
    execFile(py, [EMAILER, ...args], { windowsHide: true, timeout: 60_000, env: { ...process.env, ...(mcp?.env || {}) } }, (err, stdout) => {
      try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); } catch { resolve({ status: 'error', reason: err ? err.message : 'no response from emailer' }); }
    });
  });
}
// WhatsApp bridge (local only): release/pending staged WhatsApp drafts.
async function waApi(p, payload) {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.waPort || 8790}${p}`, { method: payload ? 'POST' : 'GET', headers: { 'x-coco-secret': cfg.sidecarSecret, 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(20000) });
    return await r.json();
  } catch { return { error: 'unknown or expired code' }; }
}
async function emailCommand(text) {
  const rel = text.match(/^\s*release\s+([0-9a-f]{8})\s*$/i);
  if (rel) {
    const w = await waApi('/release', { code: rel[1].toLowerCase() });
    if (w.sent) return `Sent ✓ on WhatsApp to ${w.to}.`;
    if (w.error && w.error !== 'unknown or expired code') return `Not sent: ${w.error}`;
    const r = await emailerCli(['--release', rel[1].toLowerCase()]);
    return r.sent ? `Sent ✓ "${r.subject}" to ${r.to}${r.attachments?.length ? ` with ${r.attachments.join(', ')}` : ''}.` : `Not sent: ${r.reason || r.status}`;
  }
  if (/^\s*pending( emails?)?\s*$/i.test(text)) {
    const r = await emailerCli(['--pending']);
    const wp = Object.entries((await waApi('/pending')) || {}).filter(([, d]) => d && d.to);
    const waText = wp.length ? '**WhatsApp drafts waiting for your release:**\n' + wp.map(([c, d]) => `• To ${d.to}: "${String(d.text).slice(0, 200)}"\n  reply: release ${c}`).join('\n') + '\n\n' : '';
    const items = Object.entries(r || {}).filter(([k]) => k !== 'error' && k !== 'status');
    if (waText && !items.length) return waText.trim();
    return waText + (items.length ? 'Emails waiting for your release:\n' + items.map(([c, d]) => `• ${d.subject} → ${d.to}${d.attachments?.length ? ` (+${d.attachments.join(', ')})` : ''}\n  reply: release ${c}`).join('\n') : (waText ? '' : 'No emails or WhatsApp drafts waiting for release.'));
  }
  return null;
}

// Delivery queue: anything Coco tries to send while Telegram is down (PC offline, helper restarting) is
// kept on disk and delivered, marked as late, once the link is healthy again. Items expire after 48h.
const QUEUE_FILE = path.join(DATA, 'tg-queue.json');
let queue = (() => { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; } })();
const saveQueue = () => { try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue)); } catch (e) { console.error('[tg] queue save failed:', e.message); } };
function enqueue(item) {
  queue.push({ ...item, at: Date.now() });
  if (queue.length > 200) queue = queue.slice(-200);
  saveQueue();
  console.log(`[tg] Telegram down: queued ${item.type} (${queue.length} waiting)`);
}
function flushQueue() {
  if (!queue.length || !healthy()) return;
  queue = queue.filter((q) => Date.now() - q.at < 48 * 3600_000);
  const items = queue.splice(0, queue.length);
  saveQueue();
  const when = (t) => new Date(t).toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit' });
  items.forEach((q, i) => setTimeout(() => {
    if (!healthy()) return enqueue(q); // dropped again mid-flush: keep it
    if (q.type === 'send') control.send(JSON.stringify({ type: 'send', html: true, text: toTelegram(`_(held while I was offline, from ${when(q.at)})_\n\n${q.text}`) }));
    else if (q.type === 'send_file') control.send(JSON.stringify({ type: 'send_file', path: q.path, caption: q.caption }));
  }, 1500 * i));
  console.log(`[tg] delivered ${items.length} queued item(s)`);
}
setInterval(flushQueue, 15_000).unref();

// Proactive message to the owner on Telegram (job results etc.). Returns false if it couldn't go out now
// (callers may also push via ntfy); the message itself is queued and delivered when Telegram is back.
function message(text) {
  const t = String(text).slice(0, 12000);
  if (!healthy()) { if (configured()) enqueue({ type: 'send', text: t }); return false; }
  control.send(JSON.stringify({ type: 'send', html: true, text: toTelegram(t) }));
  return true;
}

function onStream(sock) {
  callbridge.bridge(sock, {
    cfg, hooks, codec: pcmCodec, label: 'Telegram',
    resolveStart: (m) => {
      const s = m.start || {};
      if (!safeEq(s.secret, cfg.sidecarSecret)) return null;
      if (s.ref === 'inbound') return { kickoff: hooks.kickoff(), direction: 'inbound' };
      const info = refs.get(s.ref);
      refs.delete(s.ref);
      return info && info.expires > Date.now() ? info : null;
    },
  });
}

function startHelper() {
  if (!configured() || child) return;
  const script = path.join(ROOT, 'telegram', 'coco_tg.py');
  child = spawn(cfg.pythonExe || 'python', ['-u', script, 'run'], { cwd: path.dirname(script), windowsHide: true, env: { ...process.env, COCO_VOICE_DATA: DATA, COCO_PARENT_PID: String(process.pid) } });
  const pipe = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => console.log('[tg-helper]', l));
  child.stdout.on('data', pipe);
  child.stderr.on('data', pipe);
  child.on('exit', (code) => {
    child = null;
    control = null;
    const wait = Math.min(5 * 60_000, 5000 * 2 ** Math.min(restarts++, 6));
    console.error(`[tg] helper exited (${code}); restarting in ${Math.round(wait / 1000)}s`);
    setTimeout(startHelper, wait);
  });
  setTimeout(() => { if (connected()) restarts = 0; }, 60_000);
}

function start(config, h) {
  cfg = config;
  hooks = h;
  setInterval(() => { for (const [r, v] of refs) if (v.expires < Date.now()) refs.delete(r); }, 60_000).unref();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, sock) => {
    const p = req.url.split('?')[0];
    if (p !== '/tg/control' && p !== '/tg/stream') return sock.destroy();
    const s = ws.accept(req, sock);
    if (!s) return;
    if (p === '/tg/control') onControl(s); else onStream(s);
  });
  server.listen(cfg.tgPort, '127.0.0.1', () => {
    console.log(`Telegram link on 127.0.0.1:${cfg.tgPort} (${configured() ? 'starting helper' : 'not set up yet'})`);
    startHelper();
  });
}

process.on('exit', () => { try { child && child.kill(); } catch {} });

function restartHelper() {
  if (!child) return startHelper();
  const pid = child.pid;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else child.kill();
}

module.exports = { start, call, message, sendFile, configured, connected, healthy, restartHelper, OUTBOX, queued: () => queue.length };

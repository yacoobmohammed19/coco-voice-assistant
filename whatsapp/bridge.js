// Coco's WhatsApp bridge: links to the owner's WhatsApp as a linked device (like WhatsApp Web).
// - Stores every message locally (%USERPROFILE%\.coco-voice\whatsapp) and mirrors each chat into the
//   vault as monthly transcript notes (20-Areas/WhatsApp/<chat>/<YYYY-MM>.md).
// - Serves a LOCAL-ONLY API (127.0.0.1:waPort, shared secret) for Coco: chats, messages, search, staging.
// - Never sends on its own: a message is staged and only goes out when the owner types "release <code>"
//   on Telegram. It never marks chats read and doesn't show him online, so his phone behaves as before.
// Slow or flaky connections: give each connection attempt 2.5s (Node's default 250ms fails on a sluggish line).
require('net').setDefaultAutoSelectFamilyAttemptTimeout(2500);
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const config = require('../lib/config');

const cfg = config.load();
const DIR = path.join(config.DATA, 'whatsapp');
const MSG_DIR = path.join(DIR, 'msgs');
const VAULT_DIR = path.join(cfg.vaultPath, '20-Areas', 'WhatsApp');
const PORT = cfg.waPort || 8790;
fs.mkdirSync(MSG_DIR, { recursive: true });

// libsignal prints whole session objects (keys and all) on routine re-keying; they were most of server.log.
const SIGNAL_NOISE = /^(Closing (open )?session|Removing old closed session|Session already (closed|open)|Opening session|Migrating session|Decrypted message with closed session)/;
for (const k of ['log', 'info', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { if (typeof a[0] === 'string' && SIGNAL_NOISE.test(a[0])) return; orig(...a); };
}
const log = (...a) => console.log('[wa]', ...a);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.tmp', f); };

// ── Store ────────────────────────────────────────────────────────────────────
const names = readJson(path.join(DIR, 'names.json'), {});      // jid -> display name
const folders = readJson(path.join(DIR, 'folders.json'), {});  // jid -> vault folder name in use
const alt = readJson(path.join(DIR, 'alt.json'), {});          // lid jid <-> phone jid
let pending = readJson(path.join(DIR, 'pending.json'), {});    // code -> staged message
const chats = new Map();                                       // jid -> Map(id -> msg)
const dirty = new Set();                                       // jids to persist
const dirtyMonths = new Set();                                 // `${jid}|${YYYY-MM}` to re-render in the vault
const safe = (jid) => jid.replace(/[^\w.@-]/g, '_');

for (const f of fs.readdirSync(MSG_DIR)) {
  if (!f.endsWith('.json')) continue;
  const arr = readJson(path.join(MSG_DIR, f), []);
  if (arr.length) chats.set(arr[0].chat, new Map(arr.map((m) => [m.id, m])));
}
// Re-render every chat's vault notes on start, so names/folders are always current.
for (const [jid, map] of chats) for (const m of map.values()) dirtyMonths.add(`${jid}|${new Date(m.ts).toISOString().slice(0, 7)}`);

const isGroup = (jid) => jid.endsWith('@g.us');
// One chat per person: WhatsApp may use an internal @lid id or the phone-number id for the same chat.
const canon = (jid) => (jid && jid.endsWith('@lid') && /@s\.whatsapp\.net$/.test(alt[jid] || '') ? alt[jid] : jid);
function mergeAliases() {
  for (const jid of [...chats.keys()]) {
    const c = canon(jid);
    if (c === jid) continue;
    const into = chats.get(c) || new Map();
    for (const [id, m] of chats.get(jid)) { m.chat = c; into.set(id, m); dirtyMonths.add(`${c}|${new Date(m.ts).toISOString().slice(0, 7)}`); }
    chats.set(c, into); chats.delete(jid); dirty.add(c);
    try { fs.unlinkSync(path.join(MSG_DIR, safe(jid) + '.json')); } catch {}
    const old = folders[jid]; if (old) { try { fs.rmSync(path.join(VAULT_DIR, old), { recursive: true, force: true }); } catch {} delete folders[jid]; }
  }
}
const phoneOf = (jid) => { const p = (jid || '').match(/^(\d+)@s\.whatsapp\.net$/); return p ? '+' + p[1] : null; };
function nameOf(jid) {
  if (!jid) return '';
  if (names[jid]) return names[jid];
  if (alt[jid] && names[alt[jid]]) return names[alt[jid]];
  return phoneOf(jid) || phoneOf(alt[jid]) || jid.split('@')[0];
}
function setName(jid, name) {
  if (!jid || !name || names[jid] === name) return;
  names[jid] = name;
  namesDirty = true;
  for (const c of [jid, alt[jid]]) for (const m of chats.get(c)?.values() || []) dirtyMonths.add(`${c}|${new Date(m.ts).toISOString().slice(0, 7)}`);
}
let namesDirty = false;

function num(t) { if (t == null) return 0; if (typeof t === 'object') return Number(t.low ?? t.toNumber?.() ?? 0); return Number(t); }

function unwrap(m) {
  for (let i = 0; i < 5 && m; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message
      || m.viewOnceMessageV2Extension?.message || m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}
function textOf(raw) {
  const m = unwrap(raw);
  if (!m) return null;
  if (m.conversation) return { type: 'text', text: m.conversation };
  if (m.extendedTextMessage) return { type: 'text', text: m.extendedTextMessage.text || '' };
  if (m.imageMessage) return { type: 'image', text: `[photo]${m.imageMessage.caption ? ' ' + m.imageMessage.caption : ''}` };
  if (m.videoMessage) return { type: 'video', text: `[video]${m.videoMessage.caption ? ' ' + m.videoMessage.caption : ''}` };
  if (m.audioMessage) return { type: 'audio', text: m.audioMessage.ptt ? '[voice note]' : '[audio]' };
  if (m.documentMessage) return { type: 'document', text: `[document: ${m.documentMessage.fileName || 'file'}]${m.documentMessage.caption ? ' ' + m.documentMessage.caption : ''}` };
  if (m.stickerMessage) return { type: 'sticker', text: '[sticker]' };
  if (m.contactMessage) return { type: 'contact', text: `[contact: ${m.contactMessage.displayName || ''}]` };
  if (m.locationMessage) return { type: 'location', text: `[location${m.locationMessage.name ? ': ' + m.locationMessage.name : ''}]` };
  if (m.pollCreationMessage || m.pollCreationMessageV3) { const p = m.pollCreationMessage || m.pollCreationMessageV3; return { type: 'poll', text: `[poll: ${p.name}]` }; }
  if (m.reactionMessage) return { type: 'reaction', text: `[reacted ${m.reactionMessage.text || ''}]` };
  if (m.buttonsResponseMessage) return { type: 'text', text: m.buttonsResponseMessage.selectedDisplayText || '' };
  if (m.listResponseMessage) return { type: 'text', text: m.listResponseMessage.title || '' };
  return null; // protocol / key-distribution / system messages
}

function addMessage(wm) {
  const k = wm.key || {};
  let chat = k.remoteJid;
  if (!chat || chat === 'status@broadcast' || chat.endsWith('@newsletter') || chat.endsWith('@broadcast')) return false;
  if (k.remoteJidAlt) { alt[chat] = k.remoteJidAlt; alt[k.remoteJidAlt] = chat; }
  chat = canon(chat);
  const t = textOf(wm.message);
  if (!t || (t.type === 'text' && !t.text.trim())) return false;
  const fromJid = k.fromMe ? 'me' : (k.participant || chat);
  if (k.participantAlt && k.participant) { alt[k.participant] = k.participantAlt; alt[k.participantAlt] = k.participant; }
  if (!k.fromMe && wm.pushName) setName(fromJid, wm.pushName);
  const quoted = unwrap(wm.message)?.extendedTextMessage?.contextInfo?.quotedMessage;
  const msg = {
    id: k.id, chat, from: fromJid, fromMe: !!k.fromMe, ts: num(wm.messageTimestamp) * 1000,
    type: t.type, text: t.text, ...(quoted ? { quoted: (textOf(quoted)?.text || '').slice(0, 200) } : {}),
  };
  if (!msg.ts) msg.ts = Date.now();
  let map = chats.get(chat);
  if (!map) { map = new Map(); chats.set(chat, map); }
  const prev = map.get(msg.id);
  if (prev && prev.text === msg.text) return false;
  map.set(msg.id, msg);
  dirty.add(chat);
  dirtyMonths.add(`${chat}|${new Date(msg.ts).toISOString().slice(0, 7)}`);
  return true;
}

// ── Persistence + vault mirror ───────────────────────────────────────────────
const fileSafe = (s) => String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'chat';
function chatFolder(jid) {
  const label = fileSafe(nameOf(jid));
  const digits = (phoneOf(jid) || phoneOf(alt[jid]) || '').replace('+', '');
  return isGroup(jid) || !digits ? label : `${label} (${digits})`;
}
function renderMonth(jid, month) {
  const map = chats.get(jid);
  if (!map) return;
  const msgs = [...map.values()].filter((m) => new Date(m.ts).toISOString().slice(0, 7) === month).sort((a, b) => a.ts - b.ts);
  if (!msgs.length) return;
  const want = chatFolder(jid);
  if (folders[jid] && folders[jid] !== want && fs.existsSync(path.join(VAULT_DIR, folders[jid])) && !fs.existsSync(path.join(VAULT_DIR, want))) {
    try { fs.renameSync(path.join(VAULT_DIR, folders[jid]), path.join(VAULT_DIR, want)); } catch {}
  }
  folders[jid] = want;
  const dir = path.join(VAULT_DIR, want);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    '---', 'type: whatsapp-log', `chat: "${nameOf(jid).replace(/"/g, "'")}"`, `jid: ${jid}`,
    `kind: ${isGroup(jid) ? 'group' : 'direct'}`, `month: ${month}`, `messages: ${msgs.length}`, 'tags: [whatsapp]', '---', '',
    `# WhatsApp: ${nameOf(jid)} (${month})`, '',
  ];
  let day = '';
  for (const m of msgs) {
    const d = new Date(m.ts);
    const sast = new Date(d.toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' }));
    const dayStr = sast.toISOString().slice(0, 10);
    if (dayStr !== day) { day = dayStr; lines.push('', `## ${dayStr}`, ''); }
    const who = m.fromMe ? 'Owner' : nameOf(m.from);
    const hm = sast.toTimeString().slice(0, 5);
    const body = m.text.replace(/\r/g, '').replace(/\n/g, '\n  ');
    lines.push(`- **${hm} ${who}:** ${m.quoted ? `_(replying to "${m.quoted.replace(/\n/g, ' ').slice(0, 80)}")_ ` : ''}${body}`);
  }
  fs.writeFileSync(path.join(dir, `${month}.md`), lines.join('\n') + '\n');
}
function flush() {
  try {
    mergeAliases();
    for (const jid of dirty) writeJson(path.join(MSG_DIR, safe(jid) + '.json'), [...chats.get(jid).values()]);
    dirty.clear();
    if (namesDirty) { writeJson(path.join(DIR, 'names.json'), names); namesDirty = false; }
    writeJson(path.join(DIR, 'alt.json'), alt);
    for (const key of dirtyMonths) { const [jid, month] = key.split('|'); renderMonth(jid, month); }
    dirtyMonths.clear();
    writeJson(path.join(DIR, 'folders.json'), folders);
  } catch (e) { log('flush failed:', e.message); }
}
setInterval(flush, 20_000);

// ── WhatsApp connection ──────────────────────────────────────────────────────
let sock = null;
let status = { connected: false, me: null, since: null, note: 'starting' };
let pairingRequested = false;

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DIR, 'auth'));
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }),
    browser: Browsers.windows('Chrome'), syncFullHistory: true,
    markOnlineOnConnect: false, generateHighQualityLinkPreview: false,
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (u.qr && !state.creds.registered && !pairingRequested) {
      pairingRequested = true;
      const phone = String(process.env.WA_PHONE || cfg.waNumber || cfg.ownerNumber || '').replace(/\D/g, '');
      try {
        const code = await sock.requestPairingCode(phone);
        const pretty = code.match(/.{1,4}/g).join('-');
        status.note = `waiting for pairing code ${pretty}`;
        log(`PAIRING CODE for +${phone}: ${pretty}`);
        fs.writeFileSync(path.join(DIR, 'pairing-code.txt'), pretty);
        // Coco's server sends this file to the owner's Telegram.
        fs.writeFileSync(path.join(config.DATA, 'send-once.md'),
          `**📱 Link Coco to your WhatsApp**\n\nOn your phone: WhatsApp → Settings → Linked devices → Link a device → **Link with phone number instead**, then enter:\n\n**${pretty}**\n\nThe code expires in a few minutes.`);
      } catch (e) { log('pairing code failed:', e.message); pairingRequested = false; }
    }
    if (u.connection === 'open') {
      status = { connected: true, me: sock.user?.id, since: new Date().toISOString(), note: 'linked' };
      try { fs.unlinkSync(path.join(DIR, 'pairing-code.txt')); } catch {}
      log('connected as', sock.user?.id);
    }
    if (u.connection === 'close') {
      status.connected = false;
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        status.note = 'logged out: unlinked from the phone';
        log('logged out; delete the auth folder and relink to use WhatsApp again');
        return;
      }
      status.note = `reconnecting (${code || 'closed'})`;
      setTimeout(() => connect().catch((e) => log('reconnect failed:', e.message)), code === DisconnectReason.restartRequired ? 500 : 5000);
    }
  });

  sock.ev.on('messaging-history.set', ({ chats: cs = [], contacts = [], messages = [] }) => {
    for (const c of cs) if (c.name) setName(c.id, c.name);
    for (const c of contacts) setName(c.id, c.name || c.notify || c.verifiedName);
    let n = 0;
    for (const m of messages) if (addMessage(m)) n++;
    log(`history sync: ${n} messages, ${cs.length} chats`);
  });
  sock.ev.on('messages.upsert', ({ messages }) => { for (const m of messages) addMessage(m); });
  sock.ev.on('contacts.upsert', (cs) => { for (const c of cs) setName(c.id, c.name || c.notify || c.verifiedName); });
  sock.ev.on('contacts.update', (cs) => { for (const c of cs) setName(c.id, c.name || c.notify); });
  sock.ev.on('chats.upsert', (cs) => { for (const c of cs) if (c.name) setName(c.id, c.name); });
  sock.ev.on('groups.upsert', (gs) => { for (const g of gs) setName(g.id, g.subject); });
  sock.ev.on('groups.update', (gs) => { for (const g of gs) if (g.subject) setName(g.id, g.subject); });
}

// Group names we haven't seen yet: ask once, slowly.
const askedGroups = new Set();
setInterval(async () => {
  if (!status.connected) return;
  const g = [...chats.keys()].find((j) => isGroup(j) && !names[j] && !askedGroups.has(j));
  if (!g) return;
  askedGroups.add(g);
  try { const md = await sock.groupMetadata(g); if (md?.subject) { setName(g, md.subject); for (const k of chats.get(g)?.values() || []) dirtyMonths.add(`${g}|${new Date(k.ts).toISOString().slice(0, 7)}`); } } catch {}
}, 15_000);

// ── Lookup helpers ───────────────────────────────────────────────────────────
function chatList(q) {
  const list = [...chats.entries()].map(([jid, map]) => {
    const msgs = [...map.values()];
    const last = msgs.reduce((a, b) => (b.ts > a.ts ? b : a), msgs[0]);
    return { jid, name: nameOf(jid), phone: phoneOf(jid) || phoneOf(alt[jid]), group: isGroup(jid), messages: msgs.length, last: last && new Date(last.ts).toISOString(), lastText: last?.text.slice(0, 80) };
  }).sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  if (!q) return list;
  const s = q.toLowerCase().replace(/\s+/g, ' ');
  const digits = q.replace(/\D/g, '');
  return list.filter((c) => c.name.toLowerCase().includes(s) || (digits.length >= 6 && (c.phone || '').replace(/\D/g, '').endsWith(digits.slice(-9))));
}
function resolveChat(ref) {
  if (!ref) return null;
  if (chats.has(ref)) return ref;
  const c = chatList(String(ref))[0];
  return c ? c.jid : null;
}
const view = (m) => ({ time: new Date(m.ts).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }), from: m.fromMe ? 'Owner' : nameOf(m.from), text: m.text, ...(m.quoted ? { replying_to: m.quoted } : {}) });

// ── Local API ────────────────────────────────────────────────────────────────
const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const body = (req) => new Promise((r) => { let s = ''; req.on('data', (d) => { s += d; if (s.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (!safeEq(req.headers['x-coco-secret'], cfg.sidecarSecret)) return send(403, { error: 'forbidden' });
  const u = new URL(req.url, 'http://x');
  const q = Object.fromEntries(u.searchParams);
  try {
    if (u.pathname === '/status') return send(200, { ...status, chats: chats.size, messages: [...chats.values()].reduce((a, m) => a + m.size, 0), pending: Object.keys(pending).length });
    if (u.pathname === '/chats') return send(200, { chats: chatList(q.q).slice(0, Number(q.limit) || 40) });
    if (u.pathname === '/messages') {
      const jid = resolveChat(q.chat);
      if (!jid) return send(404, { error: `No chat matches "${q.chat}". Use /chats to find it.` });
      const since = q.since ? Date.parse(q.since) : 0;
      const msgs = [...chats.get(jid).values()].filter((m) => m.ts >= since).sort((a, b) => a.ts - b.ts);
      return send(200, { chat: nameOf(jid), jid, total: msgs.length, messages: msgs.slice(-(Number(q.limit) || 50)).map(view) });
    }
    if (u.pathname === '/since') { // everything since a time, grouped by chat (for the daily vault update)
      const since = Date.parse(q.since || '') || Date.now() - 24 * 3600_000;
      const out = [];
      for (const [jid, map] of chats) {
        const msgs = [...map.values()].filter((m) => m.ts >= since).sort((a, b) => a.ts - b.ts);
        if (msgs.length) out.push({ chat: nameOf(jid), jid, group: isGroup(jid), messages: msgs.slice(-(Number(q.per_chat) || 200)).map(view) });
      }
      out.sort((a, b) => b.messages.length - a.messages.length);
      return send(200, { since: new Date(since).toISOString(), chats: out });
    }
    if (u.pathname === '/search') {
      const s = String(q.q || '').toLowerCase();
      if (!s) return send(400, { error: 'q required' });
      const hits = [];
      for (const [jid, map] of chats) for (const m of map.values()) if (m.text.toLowerCase().includes(s)) hits.push({ chat: nameOf(jid), ...view(m), ts: m.ts });
      hits.sort((a, b) => b.ts - a.ts);
      return send(200, { results: hits.slice(0, Number(q.limit) || 30).map(({ ts, ...h }) => h) });
    }
    if (u.pathname === '/pending') return send(200, Object.fromEntries(Object.entries(pending).map(([c, p]) => [c, { to: p.name, text: p.text }])));
    if (u.pathname === '/stage' && req.method === 'POST') {
      const b = await body(req);
      const text = String(b.text || '').trim();
      if (!text) return send(400, { error: 'text required' });
      let jid = resolveChat(b.to);
      const digits = String(b.to || '').replace(/\D/g, '');
      if (!jid && digits.length >= 9) jid = `${digits.startsWith('0') ? '27' + digits.slice(1) : digits}@s.whatsapp.net`;
      if (!jid) return send(404, { error: `No WhatsApp chat matches "${b.to}". Give a chat name or phone number.` });
      const code = crypto.randomBytes(4).toString('hex');
      pending[code] = { jid, name: nameOf(jid), text: text.slice(0, 4000), at: Date.now() };
      writeJson(path.join(DIR, 'pending.json'), pending);
      return send(200, { staged: true, code, to: nameOf(jid), preview: text.slice(0, 500), how_to_send: `The owner replies "release ${code}" to Coco on Telegram. Nothing is sent before that.` });
    }
    if (u.pathname === '/send' && req.method === 'POST') { // only reachable by jobs the owner asked for
      const b = await body(req);
      const text = String(b.text || '').trim();
      if (!text) return send(400, { error: 'text required' });
      let jid = resolveChat(b.to);
      const digits = String(b.to || '').replace(/\D/g, '');
      if (!jid && digits.length >= 9) jid = `${digits.startsWith('0') ? '27' + digits.slice(1) : digits}@s.whatsapp.net`;
      if (!jid) return send(404, { error: `No WhatsApp chat matches "${b.to}". Give a chat name or phone number.` });
      if (!status.connected) return send(503, { error: 'WhatsApp is not connected right now' });
      await sock.sendMessage(jid, { text: text.slice(0, 4000) });
      log('sent message to', nameOf(jid));
      return send(200, { sent: true, to: nameOf(jid) });
    }
    if (u.pathname === '/release' && req.method === 'POST') {
      const { code } = await body(req);
      pending = Object.fromEntries(Object.entries(pending).filter(([, p]) => Date.now() - p.at < 24 * 3600_000));
      const p = pending[code];
      if (!p) return send(404, { error: 'unknown or expired code' });
      if (!status.connected) return send(503, { error: 'WhatsApp is not connected right now' });
      await sock.sendMessage(p.jid, { text: p.text });
      delete pending[code];
      writeJson(path.join(DIR, 'pending.json'), pending);
      log('sent staged message to', p.name);
      return send(200, { sent: true, to: p.name, text: p.text });
    }
    return send(404, { error: 'not found' });
  } catch (e) { return send(500, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => log(`API on 127.0.0.1:${PORT}`));

// Exit with Coco's server so a restart never leaves two linked sessions running.
const parent = Number(process.env.COCO_PARENT_PID || 0);
if (parent) setInterval(() => { try { process.kill(parent, 0); } catch { flush(); process.exit(0); } }, 5000);
process.on('SIGTERM', () => { flush(); process.exit(0); });

connect().catch((e) => { log('start failed:', e.message); process.exit(1); });

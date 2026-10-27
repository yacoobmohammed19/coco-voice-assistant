// Search the vault by meaning, not just keywords: every note is split into passages, each embedded with
// Gemini (gemini-embedding-001, 768 dims) and kept in ~/.coco-voice/semantic/. The index refreshes hourly,
// re-embedding only notes whose modified time changed. A query costs one embedding call (~0.3-0.7s).
const fs = require('fs');
const path = require('path');
const { DATA } = require('./config');
const gemini = require('./gemini');

const DIR = path.join(DATA, 'semantic');
const META = path.join(DIR, 'index.json');
const VECS = path.join(DIR, 'vectors.bin');
const DIMS = 768;
const CHUNK = 1400;          // characters per passage
const MAX_CHUNKS = 25;       // per note; huge logs are mostly repetition
// Not indexed: raw transcripts (the WhatsApp mirror has its own tool; call logs are in the prompt), job outputs, dumps.
const SKIP = ['20-Areas/WhatsApp', '00-Inbox/calls', '00-Inbox/voice-jobs', 'Staging - Iris Dump', 'brag-output', '.tmp-'];

let idx = null;              // { model, files: { rel: { mtime, n } }, chunks: [{ f, t }], vecs: Float32Array, builtAt }
let building = false;

function load() {
  if (idx) return idx;
  try {
    const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
    const buf = fs.readFileSync(VECS);
    const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (vecs.length === meta.chunks.length * DIMS) idx = { ...meta, vecs };
  } catch { /* none yet */ }
  return idx || (idx = { model: '', files: {}, chunks: [], vecs: new Float32Array(0), builtAt: 0 });
}

function save(state) {
  fs.mkdirSync(DIR, { recursive: true });
  const { vecs, ...meta } = state;
  fs.writeFileSync(VECS + '.tmp', Buffer.from(vecs.buffer, vecs.byteOffset, vecs.byteLength));
  fs.writeFileSync(META + '.tmp', JSON.stringify(meta));
  fs.renameSync(VECS + '.tmp', VECS);
  fs.renameSync(META + '.tmp', META);
}

function chunk(rel, text) {
  const body = text.replace(/^---[\s\S]*?\n---\s*/, '').replace(/\r/g, '').trim();
  if (!body) return [];
  const out = [];
  let cur = '';
  for (const para of body.split(/\n\s*\n/)) {
    if (cur && cur.length + para.length > CHUNK) { out.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + (para.length > CHUNK * 1.5 ? para.slice(0, CHUNK * 1.5) : para);
    if (out.length >= MAX_CHUNKS) break;
  }
  if (cur && out.length < MAX_CHUNKS) out.push(cur);
  return out.map((t) => t.replace(/\s+\n/g, '\n').trim());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function embed(cfg, texts, taskType) {
  const model = `models/${cfg.embedModel || 'gemini-embedding-001'}`;
  const body = { requests: texts.map((t) => ({ model, content: { parts: [{ text: t }] }, taskType, outputDimensionality: DIMS })) };
  for (let attempt = 0; ; attempt++) {
    try {
      const j = await gemini.call(cfg, `${model}:batchEmbedContents`, body, { what: 'embed', timeoutMs: taskType === 'RETRIEVAL_QUERY' ? 4000 : 60000 });
      return j.embeddings.map((e) => normalize(e.values));
    } catch (e) {
      if (e.status === 429 && taskType !== 'RETRIEVAL_QUERY' && attempt < 8) { await sleep(20000 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

// Bring the index up to date with the vault. Safe to call often: only changed notes are embedded.
async function refresh(cfg) {
  if (building || !gemini.hasKey(cfg)) return;
  building = true;
  const started = Date.now();
  try {
    const old = load();
    const model = cfg.embedModel || 'gemini-embedding-001';
    const sameModel = old.model === model;
    const files = require('./vault').allFiles(cfg.vaultPath).filter(([, rel]) => !SKIP.some((s) => rel.startsWith(s)));
    const keep = new Map(); // rel -> { start, n } in the old arrays
    if (sameModel) { let i = 0; for (const c of old.chunks) { const k = keep.get(c.f) || { start: i, n: 0 }; k.n++; keep.set(c.f, k); i++; } }

    const next = { model, files: {}, chunks: [], parts: [] };
    const todo = [];
    for (const [abs, rel] of files) {
      let mtime;
      try { mtime = fs.statSync(abs).mtimeMs; } catch { continue; }
      const prev = old.files[rel];
      const k = keep.get(rel);
      if (sameModel && prev && prev.mtime === mtime && (k || prev.n === 0)) {
        next.files[rel] = prev;
        if (k) { next.chunks.push(...old.chunks.slice(k.start, k.start + k.n)); next.parts.push(old.vecs.subarray(k.start * DIMS, (k.start + k.n) * DIMS)); }
      } else {
        todo.push([abs, rel, mtime]);
      }
    }
    // Embed changed/new notes in batches of 100 passages; save as we go so a restart keeps progress.
    let pending = [], pendingMeta = [], embedded = 0;
    const flush = async () => {
      if (!pending.length) return;
      const vecs = await embed(cfg, pending.map((p) => p.e), 'RETRIEVAL_DOCUMENT');
      pending.forEach((p, i) => { next.chunks.push({ f: p.f, t: p.t }); next.parts.push(vecs[i]); });
      for (const m of pendingMeta) next.files[m.rel] = { mtime: m.mtime, n: m.n };
      embedded += pending.length;
      pending = []; pendingMeta = [];
      if (embedded % 1000 < 100) commit(next);
      await sleep(600);
    };
    for (const [abs, rel, mtime] of todo) {
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const parts = chunk(rel, text);
      if (pending.length + parts.length > 100) await flush();
      for (const t of parts) pending.push({ f: rel, t, e: `${rel}\n\n${t}` });
      pendingMeta.push({ rel, mtime, n: parts.length });
    }
    await flush();
    commit(next, true);
    if (todo.length) console.log(`[semantic] index: ${idx.chunks.length} passages from ${Object.keys(idx.files).length} notes (${embedded} embedded in ${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (e) {
    console.error('[semantic] refresh failed:', e.message);
  } finally {
    building = false;
  }
}

function commit(next, final = false) {
  const vecs = new Float32Array(next.parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of next.parts) { vecs.set(p, o); o += p.length; }
  const state = { model: next.model, files: { ...next.files }, chunks: next.chunks.slice(), vecs, builtAt: final ? Date.now() : (idx?.builtAt || 0) };
  // Mid-build: save progress to disk only (a restart resumes from here); live search keeps the old index.
  save(state);
  if (final) idx = state;
}

async function search(cfg, query, limit = 8) {
  const state = load();
  if (!state.chunks.length || !gemini.hasKey(cfg) || !String(query).trim()) return [];
  const [q] = await embed(cfg, [String(query).slice(0, 2000)], 'RETRIEVAL_QUERY');
  const best = new Map(); // file -> { score, i }
  for (let i = 0; i < state.chunks.length; i++) {
    let s = 0;
    const off = i * DIMS;
    for (let d = 0; d < DIMS; d++) s += q[d] * state.vecs[off + d];
    const f = state.chunks[i].f;
    const b = best.get(f);
    if (!b || s > b.score) best.set(f, { score: s, i });
  }
  return [...best.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit)
    .filter(([, b]) => b.score > 0.55)
    .map(([file, b]) => ({ file, score: b.score, snippet: state.chunks[b.i].t.replace(/\s+/g, ' ').slice(0, 1600) }));
}

function stats() {
  const s = load();
  return { passages: s.chunks.length, notes: Object.keys(s.files).length, builtAt: s.builtAt, building };
}

module.exports = { refresh, search, stats };

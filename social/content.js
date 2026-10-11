// CocoCorp content engine: one post every second day, produced in a weekly batch so the daily
// posting costs no AI tokens at all.
//
//   Sunday 09:00   Coco asks the owner for the week's ideas (with suggestions)          [small job]
//   Sunday 17:00   one production job makes every slot until the next Monday:      [one big job]
//                  3 variants per slot (A primary, B and C in different formats)
//   each slot day  server publishes at 18:30: A → B → C → backup bank → alert       [no tokens]
//   day before     pre-flight check; an empty slot gets a small fill-in job
//
// State in ~/.coco-voice/content/: plan.json (slots), bank.json (evergreen backups), assets per slot.
// CLI for the production job:
//   node social/content.js horizon            slots it must fill (JSON)
//   node social/content.js import <file>      validate + merge a plan {slots:[...], bank:[...]}
//   node social/content.js status             what's planned / posted / in the bank
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../lib/config');

const DIR = path.join(config.DATA, 'content');
const PLAN = path.join(DIR, 'plan.json');
const BANK = path.join(DIR, 'bank.json');
const IDEAS = path.join(DIR, 'ideas.json');
const ANCHOR = '2026-10-10';          // first slot; then every second day
const POST_TIME = '18:30';            // SAST, when SA small-business owners scroll
const TZ = '+02:00';                  // South Africa has no daylight saving

fs.mkdirSync(DIR, { recursive: true });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1));
const plan = () => readJson(PLAN, { slots: [] });
const bank = () => readJson(BANK, []);

// ── Dates (all in SAST) ──
const sastDate = (t = Date.now()) => new Date(t + 2 * 3600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
const isSlotDay = (d) => dayDiff(ANCHOR, d) >= 0 && dayDiff(ANCHOR, d) % 2 === 0;
const slotAt = (d) => `${d}T${POST_TIME}:00${TZ}`;
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay(); // 0 = Sunday

// Slots a production run made today should fill: tomorrow up to the Monday after next Sunday,
// so a Sunday run covers Mon..Sun plus a one-slot overlap into the next week.
function horizon(today = sastDate()) {
  let end = addDays(today, 1);
  while (weekday(end) !== 0) end = addDays(end, 1);
  end = addDays(end, 1);
  const out = [];
  for (let d = addDays(today, 1); d <= end; d = addDays(d, 1)) if (isSlotDay(d)) out.push(d);
  return out;
}
const nextSlots = (n = 4, from = sastDate()) => { const out = []; for (let d = from; out.length < n; d = addDays(d, 1)) if (isSlotDay(d)) out.push(d); return out; };

// ── Validation: catch problems at production time, not at 18:30 ──
const IMG = /\.(jpe?g|png)$/i, VID = /\.(mp4|mov)$/i;
function probe(f) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', f], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const j = JSON.parse(out), s = j.streams?.[0] || {};
    return { w: s.width, h: s.height, codec: s.codec_name, dur: Number(j.format?.duration) || 0 };
  } catch { return null; }
}
function validateVariant(v) {
  const errs = [];
  const platforms = v.platforms?.length ? v.platforms : ['facebook', 'instagram'];
  const media = [].concat(v.media || []);
  if (!String(v.text || '').trim()) errs.push('no caption text');
  if (platforms.includes('instagram') && !media.length) errs.push('Instagram needs an image or video');
  if (media.length > 10) errs.push('more than 10 media items');
  for (const m of media) {
    if (/^https?:/i.test(m)) continue;
    if (!fs.existsSync(m)) { errs.push(`missing file ${m}`); continue; }
    if (!IMG.test(m) && !VID.test(m)) { errs.push(`unsupported type ${path.basename(m)} (use jpg/png/mp4)`); continue; }
    const p = probe(m);
    if (!p || !p.w) { errs.push(`unreadable media ${path.basename(m)}`); continue; }
    const r = p.w / p.h;
    if (VID.test(m)) {
      if (p.codec !== 'h264' && p.codec !== 'hevc') errs.push(`${path.basename(m)}: codec ${p.codec}, use h264`);
      if (p.dur < 3 || p.dur > 90) errs.push(`${path.basename(m)}: ${p.dur.toFixed(1)}s, Reels must be 3-90s`);
      if (media.length === 1 && Math.abs(r - 9 / 16) > 0.02) errs.push(`${path.basename(m)}: ${p.w}x${p.h}, Reels must be 9:16 (1080x1920)`);
    } else if (platforms.includes('instagram') && v.kind !== 'story' && (r < 0.79 || r > 1.92)) {
      errs.push(`${path.basename(m)}: ${p.w}x${p.h}, Instagram feed images must be between 4:5 and 1.91:1 (use 1080x1350)`);
    }
    if (fs.statSync(m).size > (VID.test(m) ? 300e6 : 8e6)) errs.push(`${path.basename(m)}: file too big`);
  }
  return errs;
}

// ── Import from the production job ──
function importPlan(file) {
  const input = readJson(file, null);
  if (!input) return { error: `Can't read ${file} as JSON.` };
  const p = plan(), report = { slots: [], bank: [] };
  for (const s of input.slots || []) {
    if (!isSlotDay(s.date)) { report.slots.push({ date: s.date, error: 'not a slot day', slot_days: nextSlots(5) }); continue; }
    const variants = (s.variants || []).map((v, i) => ({ label: v.label || 'ABC'[i] || String(i + 1), ...v, errors: validateVariant(v) }));
    const good = variants.filter((v) => !v.errors.length).length;
    const old = p.slots.find((x) => x.date === s.date);
    if (old?.status === 'posted') { report.slots.push({ date: s.date, error: 'already posted' }); continue; }
    const slot = { date: s.date, at: slotAt(s.date), theme: s.theme || '', status: good ? 'ready' : 'invalid', variants, importedAt: new Date().toISOString() };
    if (old) Object.assign(old, slot); else p.slots.push(slot);
    report.slots.push({ date: s.date, theme: slot.theme, valid_variants: good, of: variants.length, problems: variants.filter((v) => v.errors.length).map((v) => `${v.label}: ${v.errors.join('; ')}`) });
  }
  p.slots.sort((a, b) => a.date.localeCompare(b.date));
  writeJson(PLAN, p);
  if (input.bank?.length) {
    const b = bank();
    for (const item of input.bank) {
      const errors = validateVariant(item);
      if (errors.length) { report.bank.push({ label: item.label, problems: errors }); continue; }
      b.push({ id: `bk-${Math.random().toString(36).slice(2, 8)}`, used: false, added: new Date().toISOString(), ...item });
      report.bank.push({ label: item.label || item.text.slice(0, 40), ok: true });
    }
    writeJson(BANK, b);
  }
  report.bank_unused = bank().filter((x) => !x.used).length;
  report.still_empty = horizon().filter((d) => !plan().slots.some((s) => s.date === d && s.status === 'ready'));
  return report;
}

// ── Publish a due slot with fallbacks. publish = meta.publish. Never throws. ──
async function publishSlot(slot, publish) {
  let remaining = new Set(['facebook', 'instagram']);
  slot.attempts = [];
  const tryItem = async (v, src) => {
    const plats = (v.platforms?.length ? v.platforms : ['facebook', 'instagram']).filter((x) => remaining.has(x));
    if (!plats.length) return;
    const errs = validateVariant(v);
    if (errs.length) { slot.attempts.push({ src, skipped: errs.join('; ') }); return; }
    const res = await publish({ platforms: plats, text: v.text, ig_text: v.ig_text, link: v.link, media: v.media, kind: v.kind === 'reel' ? 'reel' : v.kind === 'story' ? 'story' : 'post' });
    for (const r of res) { slot.attempts.push({ src, ...r }); if (!r.error) remaining.delete(r.platform); }
    return res.some((r) => !r.error);
  };
  for (const v of slot.variants || []) { if (!remaining.size) break; await tryItem(v, `variant ${v.label}`); }
  // Backup bank: evergreen posts made ahead of time.
  if (remaining.size) {
    const b = bank();
    for (const item of b.filter((x) => !x.used)) {
      if (!remaining.size) break;
      if (await tryItem(item, `backup ${item.label || item.id}`)) { item.used = true; item.usedOn = slot.date; }
    }
    writeJson(BANK, b);
  }
  slot.status = remaining.size === 2 ? 'failed' : remaining.size ? 'partial' : 'posted';
  slot.postedAt = new Date().toISOString();
  slot.missing = [...remaining];
  return slot;
}

// Called every minute by server.js. Publishes a due slot (or an unplanned slot day from the bank).
async function runDue(publish) {
  const today = sastDate(), p = plan();
  if (!isSlotDay(today) || Date.now() < Date.parse(slotAt(today))) return null;
  let slot = p.slots.find((s) => s.date === today);
  if (slot && ['posted', 'partial', 'failed', 'publishing'].includes(slot.status)) return null;
  if (Date.now() > Date.parse(slotAt(today)) + 4 * 3600_000) return null; // PC was off all evening: skip, don't post at 3am
  if (!slot) { slot = { date: today, at: slotAt(today), theme: '(nothing planned: backup bank)', status: 'empty', variants: [] }; p.slots.push(slot); }
  slot.status = 'publishing';
  writeJson(PLAN, p);
  await publishSlot(slot, publish);
  writeJson(PLAN, p);
  return slot;
}

// Pre-flight for tomorrow's slot. Returns a problem string, or null when all is well.
function preflight(day = addDays(sastDate(), 1)) {
  if (!isSlotDay(day)) return null;
  const slot = plan().slots.find((s) => s.date === day);
  const backups = bank().filter((x) => !x.used && !validateVariant(x).length).length;
  if (!slot) return `Nothing is planned for ${day} yet${backups ? ` (I'd use one of ${backups} backup posts)` : ' and the backup bank is empty'}.`;
  const good = (slot.variants || []).filter((v) => !validateVariant(v).length).length;
  if (!good) return `None of the ${slot.variants.length} variants for ${day} is usable any more${backups ? `; ${backups} backups are ready` : ' and the backup bank is empty'}.`;
  return null;
}

function status() {
  const p = plan(), b = bank();
  return {
    post_time: `${POST_TIME} SAST, every second day`, next_slot_days: nextSlots(4),
    planned: p.slots.filter((s) => s.date >= sastDate()).map((s) => ({ date: s.date, theme: s.theme, status: s.status, variants: (s.variants || []).map((v) => `${v.label}: ${v.kind || 'post'} (${[].concat(v.media || []).length} media)`) })),
    recent: p.slots.filter((s) => s.date < sastDate() || s.status === 'posted').slice(-4).map((s) => ({ date: s.date, status: s.status, links: (s.attempts || []).filter((a) => a.url).map((a) => a.url) })),
    backup_bank: { unused: b.filter((x) => !x.used).length, items: b.filter((x) => !x.used).map((x) => x.label || x.text.slice(0, 50)) },
    ideas_this_week: ideas().map((i) => i.text),
  };
}

// ── the owner's ideas for the coming week ──
const weekKey = (d = sastDate()) => { let x = d; while (weekday(x) !== 0) x = addDays(x, -1); return x; }; // the Sunday that starts it
function ideas() { return readJson(IDEAS, []).filter((i) => i.week === weekKey()); }
function addIdeas(text) {
  const all = readJson(IDEAS, []).filter((i) => dayDiff(i.week, weekKey()) < 60);
  all.push({ week: weekKey(), at: new Date().toISOString(), text: String(text).slice(0, 4000) });
  writeJson(IDEAS, all);
  return ideas().length;
}

module.exports = { DIR, PLAN, BANK, publishSlot, horizon, nextSlots, isSlotDay, sastDate, addDays, weekday, validateVariant, importPlan, runDue, preflight, status, ideas, addIdeas, plan, bank, slotAt };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const out = cmd === 'horizon' ? { fill_these_dates: horizon().map((d) => ({ date: d, posts_at: slotAt(d), already: plan().slots.find((s) => s.date === d)?.status || 'empty' })), asset_folder: DIR }
    : cmd === 'import' ? importPlan(path.resolve(arg || ''))
    : cmd === 'status' ? status()
    : { usage: 'node social/content.js horizon | import <plan.json> | status' };
  console.log(JSON.stringify(out, null, 1));
}

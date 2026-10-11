// Daily social progress report for CocoCorp's Facebook Page + Instagram: what went out today, how it's
// doing, what's lined up next and the state of the content bank. Branded HTML template, printed to PDF
// with headless Edge. No AI tokens: server.js sends it to Telegram every evening (20:00 SAST).
//
//   node social/report.js [YYYY-MM-DD]     build the report for that day (default today) and print the paths
//
// Output: ~/.coco-voice/content/reports/<date>.html + .pdf, plus history.json (follower snapshots for the deltas).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const social = require('./meta');
const content = require('./content');

const OUT = path.join(content.DIR, 'reports');
// The PDF goes to Coco's outbox: the only place Telegram and the emailer may send files from.
const PDF_DIR = path.join(path.dirname(content.DIR), 'outbox', 'social-reports');
const HISTORY = path.join(OUT, 'history.json');
const VAULT_BANK = path.join(__dirname, '..', '..', '10-Projects', 'cococorp', 'social', 'content-bank.md');
const QUEUE = path.join(path.dirname(content.DIR), 'social-queue.json');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PDF_DIR, { recursive: true });

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sastDay = (iso) => content.sastDate(Date.parse(String(iso).replace(/\+0000$/, 'Z')));
const sastTime = (iso) => new Date(Date.parse(String(iso).replace(/\+0000$/, 'Z'))).toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit' });
const niceDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });
const firstLine = (s, n = 90) => { const l = String(s || '').split(/\r?\n/).find((x) => x.trim()) || ''; return l.length > n ? `${l.slice(0, n - 1)}…` : l; };
const absUrl = (u) => (u && u.startsWith('/') ? `https://www.facebook.com${u}` : u);
const safe = async (fn, dflt) => { try { return await fn(); } catch (e) { return { ...dflt, error: e.message }; } };

// ── Gather everything for one day ──
async function gather(date = content.sastDate()) {
  const live = social.configured();
  const c = live ? social.creds() : {};
  const dayStart = Math.floor(Date.parse(`${date}T00:00:00+02:00`) / 1000);
  const dayEnd = Math.min(dayStart + 86400, Math.floor(Date.now() / 1000));
  const d = { date, generatedAt: new Date().toISOString(), live, errors: [] };

  // Accounts + engagement on recent posts
  const fb = live ? await safe(() => social.api(c.pageId, { params: { fields: 'name,followers_count,fan_count' } }), {}) : {};
  const ig = live && c.igUserId ? await safe(() => social.api(c.igUserId, { params: { fields: 'username,followers_count,media_count' } }), {}) : {};
  const fbPosts = live ? await safe(() => social.recentPosts({ platform: 'facebook', limit: 15 }), []) : [];
  const igPosts = live && c.igUserId ? await safe(() => social.recentPosts({ platform: 'instagram', limit: 15 }), []) : [];
  for (const x of [fb, ig, fbPosts, igPosts]) if (x?.error) d.errors.push(x.error);
  const posts = [
    ...(Array.isArray(fbPosts) ? fbPosts : []).map((p) => ({ platform: 'facebook', time: p.time, text: p.message, url: absUrl(p.url), type: /\/reel\//.test(p.url || '') ? 'Reel' : 'Post', likes: p.reactions || 0, comments: p.comments || 0, shares: p.shares || 0 })),
    ...(Array.isArray(igPosts) ? igPosts : []).map((p) => ({ platform: 'instagram', time: p.timestamp, text: p.caption, url: p.permalink, type: p.media_type === 'VIDEO' ? 'Reel' : p.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Image', likes: p.like_count || 0, comments: p.comments_count || 0, shares: 0 })),
  ].sort((a, b) => Date.parse(b.time.replace(/\+0000$/, 'Z')) - Date.parse(a.time.replace(/\+0000$/, 'Z')));
  d.today = posts.filter((p) => sastDay(p.time) === date);
  d.recent = posts.filter((p) => sastDay(p.time) <= date).slice(0, 8);

  // Instagram account insights for the day (Meta renames these often, so failures are soft)
  d.igDay = {};
  if (live && c.igUserId) {
    const r = await safe(() => social.api(`${c.igUserId}/insights`, { params: { metric: 'reach,views,profile_views,accounts_engaged,total_interactions', period: 'day', metric_type: 'total_value', since: dayStart, until: Math.max(dayEnd, dayStart + 3600) } }), {});
    if (r.error) d.errors.push(`Instagram insights: ${r.error}`);
    for (const m of r.data || []) d.igDay[m.name] = m.total_value?.value ?? 0;
  }
  // Comments that came in today, and how many Coco answered
  const comments = live ? await safe(() => social.recentComments({ since: new Date(dayStart * 1000).toISOString() }), []) : [];
  d.comments = (Array.isArray(comments) ? comments : []).filter((x) => sastDay(x.time) === date);
  const log = (() => { try { return fs.readFileSync(path.join(path.dirname(content.DIR), 'social-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } })();
  d.replies = log.filter((x) => x.action === 'reply' && sastDay(x.at) === date).length;
  d.hidden = log.filter((x) => x.action === 'hide' && sastDay(x.at) === date).length;

  // Followers + deltas vs the previous snapshot
  const hist = readJson(HISTORY, {});
  if (fb.followers_count != null || ig.followers_count != null) hist[date] = { fb: fb.followers_count ?? fb.fan_count ?? null, ig: ig.followers_count ?? null, igMedia: ig.media_count ?? null };
  fs.writeFileSync(HISTORY, JSON.stringify(hist, null, 1));
  const prev = Object.keys(hist).filter((k) => k < date).sort().pop();
  d.followers = { fb: hist[date]?.fb ?? null, ig: hist[date]?.ig ?? null, igMedia: hist[date]?.igMedia ?? null, prevDate: prev || null, prev: prev ? hist[prev] : null };

  // Today's planned slot / queue results (incl. failures, which the post lists can't show)
  const plan = content.plan();
  const queue = readJson(QUEUE, []);
  d.slotToday = plan.slots.find((s) => s.date === date) || null;
  d.queueToday = queue.filter((q) => sastDay(q.at) === date && q.status !== 'cancelled');

  // Scheduled vs published, the last 7 days up to this day: every engine slot and queued post that was due,
  // what happened to it, and live posts that went out directly (outside the engine and queue).
  const from = content.addDays(date, -6), endMs = Math.min(dayEnd * 1000, Date.now());
  const due = [];
  for (const s of plan.slots.filter((x) => x.date >= from && x.date <= date && Date.parse(x.at) <= endMs)) {
    due.push({ at: s.at, route: 'Content engine', platforms: 'FB + IG', title: s.theme || '', status: s.status === 'ready' ? 'missed' : s.status, links: (s.attempts || []).filter((a) => a.url).map((a) => ({ platform: a.platform, url: absUrl(a.url) })), note: s.status === 'partial' ? `missed ${(s.missing || []).join(', ')}` : ((s.attempts || []).find((a) => a.url)?.src || '') });
  }
  for (const q of queue.filter((x) => x.status !== 'cancelled' && sastDay(x.at) >= from && sastDay(x.at) <= date && Date.parse(x.at) <= endMs)) {
    due.push({ at: q.at, route: 'Schedule queue', platforms: (q.platforms || ['facebook', 'instagram']).map((p) => (p === 'facebook' ? 'FB' : 'IG')).join(' + '), title: firstLine(q.text), status: q.status === 'queued' ? 'missed' : q.status, links: (q.results || []).filter((r) => r.url).map((r) => ({ platform: r.platform, url: absUrl(r.url) })), note: (q.results || []).map((r) => r.error).filter(Boolean).join('; ').slice(0, 120) });
  }
  const planned = due.flatMap((x) => x.links.map((l) => ({ platform: l.platform, at: Date.parse(x.at) })));
  for (const p of posts.filter((x) => sastDay(x.time) >= from && sastDay(x.time) <= date)) {
    const t = Date.parse(p.time.replace(/\+0000$/, 'Z'));
    if (planned.some((v) => v.platform === p.platform && Math.abs(v.at - t) < 6 * 3600_000)) continue;
    due.push({ at: new Date(t).toISOString(), route: 'Direct post', platforms: p.platform === 'facebook' ? 'FB' : 'IG', title: firstLine(p.text), status: 'posted', links: [{ platform: p.platform, url: p.url }], note: '' });
  }
  d.week = due.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  d.weekCounts = { posted: d.week.filter((x) => x.status === 'posted').length, partial: d.week.filter((x) => x.status === 'partial').length, failed: d.week.filter((x) => ['failed', 'missed', 'invalid'].includes(x.status)).length };

  // Lined up next: content-engine slots + the ad-hoc schedule queue, next 7 days
  const until = content.addDays(date, 7);
  const up = [];
  for (const s of plan.slots) {
    if (s.date < date || s.date > until || ['posted', 'partial', 'failed', 'publishing'].includes(s.status)) continue;
    const valid = (s.variants || []).filter((v) => !content.validateVariant(v).length);
    const a = valid[0] || s.variants?.[0] || {};
    up.push({ at: s.at, date: s.date, route: 'Content engine', platforms: 'FB + IG', format: a.kind || 'post', title: s.theme || firstLine(a.text), backups: `${valid.length}/${(s.variants || []).length} variants valid`, ok: valid.length > 0 });
  }
  const groups = {};
  for (const q of queue.filter((x) => x.status === 'queued' && sastDay(x.at) >= date && sastDay(x.at) <= until)) {
    const k = `${q.at}|${[].concat(q.media || []).join(',')}`;
    (groups[k] ||= []).push(q);
  }
  for (const g of Object.values(groups)) {
    const plats = [...new Set(g.flatMap((q) => q.platforms || ['facebook', 'instagram']))];
    up.push({ at: g[0].at, date: sastDay(g[0].at), route: 'Schedule queue', platforms: plats.map((p) => (p === 'facebook' ? 'FB' : 'IG')).join(' + '), format: g[0].kind || 'post', title: firstLine(g[0].text), backups: g.map((q) => q.id).join(', '), ok: true });
  }
  d.upcoming = up.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (let x = content.addDays(date, 1); x <= until; x = content.addDays(x, 1)) {
    if (content.isSlotDay(x) && !up.some((u) => u.date === x && u.route === 'Content engine')) d.upcoming.push({ at: content.slotAt(x), date: x, route: 'Content engine', platforms: 'FB + IG', format: '—', title: 'Nothing planned yet (backup bank would be used)', backups: '', ok: false, empty: true });
  }
  d.upcoming.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // Content bank: backup posts + the vault tracker and idea list
  const bank = content.bank();
  d.bank = { unused: bank.filter((x) => !x.used).length, used: bank.filter((x) => x.used).length, items: bank.filter((x) => !x.used).map((x) => x.label || firstLine(x.text, 60)) };
  const md = (() => { try { return fs.readFileSync(VAULT_BANK, 'utf8'); } catch { return ''; } })();
  const rows = md.split('\n').filter((l) => /^\|\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun|—)/.test(l)).map((l) => l.split('|').map((x) => x.trim()));
  d.tracker = { posted: rows.filter((r) => /✅/.test(r[5])).length, scheduled: rows.filter((r) => /⏳/.test(r[5])).length, excluded: rows.filter((r) => /🚫|excluded/i.test(r.join(' '))).length };
  d.ideas = { open: (md.match(/^- \[ \]/gm) || []).length, used: (md.match(/^- \[x\]/gim) || []).length, thisWeek: content.ideas().map((i) => i.text) };

  // Alerts: anything that needs a look
  d.alerts = [];
  const pf = content.preflight(content.addDays(date, 1));
  if (pf) d.alerts.push(pf);
  if (d.slotToday && ['failed', 'partial'].includes(d.slotToday.status)) d.alerts.push(`Today's engine post ${d.slotToday.status === 'failed' ? 'failed on both platforms' : `missed ${d.slotToday.missing?.join(', ')}`}.`);
  for (const q of d.queueToday.filter((x) => x.status === 'failed')) d.alerts.push(`Scheduled post ${q.id} (${(q.platforms || []).join('+')}) failed: ${(q.results || []).map((r) => r.error).filter(Boolean).join('; ').slice(0, 160)}`);
  for (const x of d.week.filter((w) => w.status === 'missed')) d.alerts.push(`${niceDay(sastDay(x.at))} ${sastTime(x.at)}: a post was due but never went out (${x.route}: ${firstLine(x.title, 50)}). Was the PC off?`);
  if (d.bank.unused < 2) d.alerts.push(`Backup bank is low: ${d.bank.unused} unused post${d.bank.unused === 1 ? '' : 's'} (a fill-in job tops it up if a slot breaks).`);
  if (d.upcoming.some((u) => u.empty)) d.alerts.push(`Unplanned slot day${d.upcoming.filter((u) => u.empty).length > 1 ? 's' : ''}: ${d.upcoming.filter((u) => u.empty).map((u) => niceDay(u.date)).join(', ')} (Sunday's production job fills these).`);
  if (!live) d.alerts.push('Meta is not connected, so live stats are missing.');
  for (const e of d.errors) d.alerts.push(`Meta API: ${String(e).slice(0, 160)}`);
  return d;
}

// ── HTML template ──
const MARK = '<svg viewBox="0 0 200 200" width="44" height="44" aria-label="CocoCorp"><circle cx="100" cy="100" r="98" fill="#fff"/><circle cx="100" cy="100" r="88" fill="none" stroke="#2563EB" stroke-width="18"/><path d="M133.2,60 A52,52 0 1,0 133.2,140" fill="none" stroke="#EC4899" stroke-width="24" stroke-linecap="round"/></svg>';
const delta = (now, before) => (now == null || before == null ? '' : now === before ? '<span class="d">no change</span>' : `<span class="d ${now > before ? 'up' : 'down'}">${now > before ? '+' : ''}${now - before}</span>`);
const pill = (p) => `<span class="pill ${p === 'facebook' || p === 'FB' ? 'fb' : 'ig'}">${p === 'facebook' ? 'Facebook' : p === 'instagram' ? 'Instagram' : esc(p)}</span>`;

function html(d) {
  const f = d.followers, pv = f.prev || {};
  const eng = d.today.reduce((n, p) => n + p.likes + p.comments + p.shares, 0);
  const kpis = [
    ['Posts today', d.today.length, `${d.today.filter((p) => p.platform === 'facebook').length} FB · ${d.today.filter((p) => p.platform === 'instagram').length} IG`],
    ['IG followers', f.ig ?? '—', delta(f.ig, pv.ig) || '&nbsp;'],
    ['FB followers', f.fb ?? '—', delta(f.fb, pv.fb) || '&nbsp;'],
    ['IG reach today', d.igDay.reach ?? '—', d.igDay.views != null ? `${d.igDay.views} views` : '&nbsp;'],
    ['Engagement today', eng, `${d.comments.length} comments · ${d.replies} replied`],
    ['Lined up (7 days)', d.upcoming.filter((u) => !u.empty).length, `${d.bank.unused} backups in bank`],
  ];
  const postRows = (list, empty) => (list.length ? list.map((p) => `<tr><td>${pill(p.platform)}</td><td>${esc(p.type)}</td><td class="t">${esc(firstLine(p.text, 80))}</td><td class="n">${sastDay(p.time) === d.date ? sastTime(p.time) : niceDay(sastDay(p.time))}</td><td class="n">${p.likes}</td><td class="n">${p.comments}</td><td class="n">${p.platform === 'facebook' ? p.shares : '—'}</td><td>${p.url ? `<a href="${esc(p.url)}">open</a>` : ''}</td></tr>`).join('') : `<tr><td colspan="8" class="empty">${empty}</td></tr>`);
  const upRows = d.upcoming.length ? d.upcoming.map((u) => `<tr class="${u.ok ? '' : 'warn'}"><td class="n">${niceDay(u.date)}<br><span class="muted">${sastTime(u.at)}</span></td><td>${u.platforms.split(' + ').map(pill).join(' ')}</td><td>${esc(u.format)}</td><td class="t">${esc(u.title)}</td><td class="muted small">${esc(u.route)}<br>${esc(u.backups)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">Nothing scheduled in the next 7 days.</td></tr>';
  const igm = Object.keys(d.igDay).length ? Object.entries({ reach: 'Accounts reached', views: 'Views', profile_views: 'Profile visits', accounts_engaged: 'Accounts engaged', total_interactions: 'Interactions' }).map(([k, l]) => `<div class="mini"><b>${d.igDay[k] ?? '—'}</b><span>${l}</span></div>`).join('') : '<p class="muted">Instagram insights unavailable today.</p>';
  const slot = d.slotToday;
  const slotLine = slot ? `<p><b>Content-engine slot:</b> ${esc(slot.theme || '')} · <span class="st ${esc(slot.status)}">${esc(slot.status)}</span>${(slot.attempts || []).filter((a) => a.url).map((a) => ` · <a href="${esc(absUrl(a.url))}">${esc(a.platform)}</a>`).join('')}</p>` : '';
  const qLine = d.queueToday.length ? `<p><b>Schedule queue:</b> ${d.queueToday.map((q) => `${esc((q.platforms || []).join('+'))} ${sastTime(q.at)} <span class="st ${esc(q.status)}">${esc(q.status)}</span>`).join(' · ')}</p>` : '';
  const comments = d.comments.length ? `<ul class="cm">${d.comments.slice(0, 8).map((x) => `<li>${pill(x.platform)} <b>${esc(x.from)}</b>: ${esc(firstLine(x.text, 110))} ${x.replied || x.replies ? '<span class="ok">✓ replied</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">No new comments today.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CocoCorp Social Report · ${niceDay(d.date)}</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--coco-pink:#EC4899;--coco-blue:#2563EB;--coco-black:#111113;--coco-charcoal:#2B2B30;--coco-ink:#1A1A1D;--coco-paper:#FBFAF8;--coco-mist:#F1EEEA;--coco-line:#E6E1DB;--coco-muted:#6B6B72;--coco-white:#FFFFFF;--coco-success:#138A5E;--font-display:"Bebas Neue","Oswald","Arial Narrow",sans-serif;--font-body:"Inter","Segoe UI",system-ui,sans-serif;--radius:14px}
*{box-sizing:border-box}body{margin:0;background:var(--coco-paper);color:var(--coco-charcoal);font:13px/1.5 var(--font-body);-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.wrap{max-width:960px;margin:0 auto;padding:28px 32px 40px}
header{display:flex;align-items:center;gap:14px;background:var(--coco-black);color:var(--coco-white);border-radius:var(--radius);padding:22px 26px;margin-bottom:22px}
header svg circle:first-child{fill:transparent}
header h1{font:400 34px/1 var(--font-display);letter-spacing:.02em;margin:0;color:var(--coco-white);text-transform:uppercase}header h1 span{color:var(--coco-pink)}
header .sub{margin-left:auto;text-align:right;font-size:12px;color:#c9c9cf}header .sub b{display:block;font:400 22px/1 var(--font-display);color:var(--coco-white);letter-spacing:.03em}
h2{font:400 22px/1 var(--font-display);letter-spacing:.03em;color:var(--coco-ink);text-transform:uppercase;margin:26px 0 10px;display:flex;align-items:center;gap:8px}h2:before{content:"";width:6px;height:18px;background:var(--coco-pink);border-radius:3px}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}.kpi{background:var(--coco-white);border:1px solid var(--coco-line);border-radius:var(--radius);padding:12px 12px 10px}
.kpi .l{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--coco-muted);font-weight:600}.kpi .v{font:400 34px/1.05 var(--font-display);color:var(--coco-ink);margin-top:4px}.kpi .s{font-size:11px;color:var(--coco-muted)}
.kpi:first-child .v{color:var(--coco-pink)}
.d{font-size:11px;color:var(--coco-muted)}.d.up{color:var(--coco-success);font-weight:600}.d.down{color:#B42318;font-weight:600}
.card{background:var(--coco-white);border:1px solid var(--coco-line);border-radius:var(--radius);padding:14px 16px}
table{width:100%;border-collapse:collapse;background:var(--coco-white);border:1px solid var(--coco-line);border-radius:var(--radius);overflow:hidden}
th{background:var(--coco-mist);text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--coco-muted);padding:8px 10px;font-weight:600}
td{padding:8px 10px;border-top:1px solid var(--coco-line);vertical-align:top}td.n{white-space:nowrap;font-variant-numeric:tabular-nums}td.t{color:var(--coco-ink)}tr.warn td{background:#FFF7F2}
.empty{color:var(--coco-muted);text-align:center;padding:14px}.muted{color:var(--coco-muted)}.small{font-size:11px}
.pill{display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;letter-spacing:.03em;white-space:nowrap}.pill.fb{background:#E8EFFE;color:var(--coco-blue)}.pill.ig{background:#FDE7F2;color:#BE185D}
.st{font-size:10.5px;font-weight:700;text-transform:uppercase;padding:1px 7px;border-radius:999px;background:var(--coco-mist)}.st.posted{color:var(--coco-success)}.st.failed,.st.partial{color:#B42318}.st.ready,.st.queued{color:var(--coco-blue)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.mini{display:inline-block;margin:0 18px 6px 0}.mini b{display:block;font:400 26px/1 var(--font-display);color:var(--coco-ink)}.mini span{font-size:11px;color:var(--coco-muted)}
.cm{margin:0;padding-left:0;list-style:none}.cm li{padding:5px 0;border-top:1px solid var(--coco-line)}.cm li:first-child{border-top:0}.ok{color:var(--coco-success);font-size:11px;font-weight:600}
.alerts{background:#FFF4F9;border:1px solid #F9C6DF;border-radius:var(--radius);padding:12px 16px}.alerts li{margin:3px 0}.allgood{background:#F0FAF5;border:1px solid #BFE5D2;border-radius:var(--radius);padding:12px 16px;color:var(--coco-success);font-weight:600}
.bankstats{display:flex;gap:22px;flex-wrap:wrap}
a{color:var(--coco-blue);text-decoration:none;font-weight:600}
footer{margin-top:26px;padding-top:12px;border-top:1px solid var(--coco-line);font-size:11px;color:var(--coco-muted);display:flex;justify-content:space-between}
@page{size:A4;margin:12mm}@media print{html,body{background:#fff}.wrap{padding:0;max-width:none}h2{break-after:avoid;page-break-after:avoid}.card,.kpi,tr,.alerts,.allgood{break-inside:avoid}table{break-inside:auto}thead{display:table-header-group}.kpi{background:var(--coco-paper)}}
@media(max-width:720px){.kpis{grid-template-columns:repeat(2,1fr)}.grid2{grid-template-columns:1fr}header .sub{display:none}}
</style></head><body><div class="wrap">
<header>${MARK}<h1><span>CocoCorp</span> Social Report</h1><div class="sub"><b>${niceDay(d.date)} ${d.date.slice(0, 4)}</b>Facebook Page + Instagram @cococorp.tech</div></header>

<section class="kpis">${kpis.map(([l, v, s]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</section>

<h2>Needs a look</h2>
${d.alerts.length ? `<ul class="alerts">${d.alerts.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '<div class="allgood">✓ All clear: today ran to plan and tomorrow is covered.</div>'}

<h2>Published today</h2>
${slotLine || qLine ? `<div class="card" style="margin-bottom:10px">${slotLine}${qLine}</div>` : ''}
<table><thead><tr><th>Platform</th><th>Type</th><th>Post</th><th>Time</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Link</th></tr></thead><tbody>${postRows(d.today, 'Nothing went out today.')}</tbody></table>

<h2>Engagement</h2>
<div class="grid2"><div class="card"><div class="muted small" style="margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Instagram today</div>${igm}</div>
<div class="card"><div class="muted small" style="margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Comments today · ${d.replies} replies sent${d.hidden ? ` · ${d.hidden} hidden` : ''}</div>${comments}</div></div>

<h2>Lined up next · 7 days</h2>
<table><thead><tr><th>When</th><th>Where</th><th>Format</th><th>Content</th><th>Route</th></tr></thead><tbody>${upRows}</tbody></table>

<h2>Scheduled vs published · last 7 days</h2>
<p class="small muted" style="margin:-4px 0 8px">${d.weekCounts.posted} published${d.weekCounts.partial ? ` · ${d.weekCounts.partial} partly published` : ''}${d.weekCounts.failed ? ` · ${d.weekCounts.failed} failed or missed` : ''} · ${d.upcoming.filter((u) => !u.empty).length} scheduled for the next 7 days (see Lined up next)</p>
<table><thead><tr><th>When</th><th>Where</th><th>Content</th><th>Route</th><th>Status</th><th>Live</th></tr></thead><tbody>${d.week.length ? d.week.map((x) => `<tr class="${x.status === 'posted' ? '' : 'warn'}"><td class="n">${niceDay(sastDay(x.at))}<br><span class="muted">${sastTime(x.at)}</span></td><td>${x.platforms.split(' + ').map(pill).join(' ')}</td><td class="t">${esc(x.title)}</td><td class="muted small">${esc(x.route)}${x.note ? `<br>${esc(x.note)}` : ''}</td><td><span class="st ${esc(x.status === 'missed' ? 'failed' : x.status)}">${esc(x.status === 'posted' ? 'published' : x.status)}</span></td><td>${x.links.map((l) => `<a href="${esc(l.url)}">${l.platform === 'facebook' ? 'FB' : 'IG'}</a>`).join(' · ')}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">Nothing was due in the last 7 days.</td></tr>'}</tbody></table>

<h2>Content bank</h2>
<div class="card"><div class="bankstats">
<div class="mini"><b>${d.bank.unused}</b><span>Backup posts ready</span></div>
<div class="mini"><b>${d.bank.used}</b><span>Backups used</span></div>
<div class="mini"><b>${d.tracker.posted}</b><span>Clients showcased</span></div>
<div class="mini"><b>${d.tracker.scheduled}</b><span>Showcases scheduled</span></div>
<div class="mini"><b>${d.ideas.open}</b><span>Open ideas</span></div>
<div class="mini"><b>${d.ideas.thisWeek.length}</b><span>Ideas this week</span></div></div>
${d.bank.items.length ? `<p class="small"><b>Ready backups:</b> ${d.bank.items.map(esc).join(' · ')}</p>` : ''}
${d.ideas.thisWeek.length ? `<p class="small"><b>This week's ideas:</b> ${d.ideas.thisWeek.map((i) => esc(firstLine(i, 80))).join(' · ')}</p>` : ''}</div>

<h2>Recent posts · performance</h2>
<table><thead><tr><th>Platform</th><th>Type</th><th>Post</th><th>Date</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Link</th></tr></thead><tbody>${postRows(d.recent, 'No posts yet.')}</tbody></table>

<footer><span>cococorp.tech</span><span>Generated ${new Date(d.generatedAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' })} by Coco</span></footer>
</div></body></html>`;
}

// Short plain-text version for the Telegram message that goes with the PDF.
function summary(d) {
  const fb = d.today.filter((p) => p.platform === 'facebook').length, ig = d.today.filter((p) => p.platform === 'instagram').length;
  const eng = d.today.reduce((n, p) => n + p.likes + p.comments + p.shares, 0);
  const next = d.upcoming.filter((u) => !u.empty).slice(0, 3).map((u) => `- ${niceDay(u.date)} ${sastTime(u.at)}: ${firstLine(u.title, 60)} (${u.platforms}, ${u.format})`);
  const f = d.followers, pv = f.prev || {};
  const dl = (a, b) => (a == null || b == null || a === b ? '' : ` (${a > b ? '+' : ''}${a - b})`);
  return [`📊 **CocoCorp social report, ${niceDay(d.date)}**`,
    d.today.length ? `Posted today: ${d.today.length} (${fb} FB, ${ig} IG), ${eng} engagements so far, ${d.comments.length} new comments, ${d.replies} replied.` : `Nothing went out today. ${d.comments.length} new comments, ${d.replies} replied.`,
    `Last 7 days: ${d.weekCounts.posted} published${d.weekCounts.failed ? `, ${d.weekCounts.failed} failed or missed` : ''}; ${d.upcoming.filter((u) => !u.empty).length} scheduled for the next 7 days.`,
    `Followers: IG ${f.ig ?? '?'}${dl(f.ig, pv.ig)}, FB ${f.fb ?? '?'}${dl(f.fb, pv.fb)}${d.igDay.reach != null ? ` · IG reach today ${d.igDay.reach}` : ''}.`,
    next.length ? `\n**Lined up next**\n${next.join('\n')}` : '\nNothing lined up in the next 7 days.',
    `\nContent bank: ${d.bank.unused} backups ready, ${d.ideas.open} open ideas.`,
    d.alerts.length ? `\n⚠️ ${d.alerts.join('\n⚠️ ')}` : '\n✅ All clear for tomorrow.'].join('\n');
}

// Build HTML + PDF for a day. Returns { html, pdf, summary, data }.
async function build(date = content.sastDate()) {
  const d = await gather(date);
  const htmlFile = path.join(OUT, `${date}.html`), pdfFile = path.join(PDF_DIR, `CocoCorp Social Report ${date}.pdf`);
  fs.writeFileSync(htmlFile, html(d));
  let pdf = null;
  if (EDGE) {
    try {
      execFileSync(EDGE, ['--headless', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=8000', `--print-to-pdf=${pdfFile}`, `file:///${htmlFile.replace(/\\/g, '/')}`], { windowsHide: true, timeout: 90000, stdio: 'ignore' });
      if (fs.existsSync(pdfFile) && fs.statSync(pdfFile).size > 1000) pdf = pdfFile;
    } catch (e) { console.error('[report] PDF failed:', e.message); }
  }
  return { html: htmlFile, pdf, summary: summary(d), data: d };
}

// Email the PDF to the owner's own inbox through coco-emailer's self-only CLI (it can't reach anyone else).
// The emailer only attaches files from the vault or Coco's outbox, so the PDF is copied there first.
function emailSelf(r) {
  return new Promise((resolve) => {
    try {
      const data = path.dirname(content.DIR);
      const dir = path.join(data, 'outbox', 'social-reports');
      fs.mkdirSync(dir, { recursive: true });
      const atts = r.pdf ? [path.join(dir, path.basename(r.pdf))] : [];
      if (r.pdf && path.resolve(r.pdf) !== path.resolve(atts[0])) fs.copyFileSync(r.pdf, atts[0]);
      const req = path.join(dir, `send-${r.data.date}.json`);
      fs.writeFileSync(req, JSON.stringify({ subject: `CocoCorp social report · ${niceDay(r.data.date)}`, body: `${r.summary.replace(/\*\*/g, '')}\n\nFull report attached (PDF).`, attachments: atts }));
      const mcp = (() => { try { return JSON.parse(fs.readFileSync(path.join(data, 'mcp.json'), 'utf8')).mcpServers['coco-emailer']; } catch { return null; } })();
      const script = path.join(__dirname, '..', '..', 'coco-emailer', 'server.py');
      require('child_process').execFile(mcp?.command || 'python', [script, '--send-self', req], { windowsHide: true, timeout: 90_000, env: { ...process.env, ...(mcp?.env || {}) } }, (err, stdout) => {
        try { fs.unlinkSync(req); } catch {}
        try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); } catch { resolve({ sent: false, reason: err ? err.message : 'no response from emailer' }); }
      });
    } catch (e) { resolve({ sent: false, reason: e.message }); }
  });
}

module.exports = { build, gather, html, summary, emailSelf, OUT, PDF_DIR };

if (require.main === module) {
  build(process.argv[2] || undefined).then((r) => { console.log(r.summary); console.log(`\nHTML: ${r.html}\nPDF:  ${r.pdf || '(not made)'}`); }).catch((e) => { console.error(e); process.exit(1); });
}

// Meta Graph API client for CocoCorp's Facebook Page + Instagram business account.
// Credentials live in ~/.coco-voice/social.json (written by social/setup.js), never in the vault.
// Page tokens derived from a long-lived user token don't expire, so this keeps working unattended.
require('net').setDefaultAutoSelectFamilyAttemptTimeout(2500);
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');

const SOCIAL_FILE = path.join(config.DATA, 'social.json');
const QUEUE_FILE = path.join(config.DATA, 'social-queue.json');
const LOG_FILE = path.join(config.DATA, 'social-log.jsonl');

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const creds = () => readJson(SOCIAL_FILE, {});
const configured = () => { const c = creds(); return !!(c.pageId && c.pageToken); };
const graph = () => `https://graph.facebook.com/${creds().graphVersion || 'v23.0'}`;

function log(entry) {
  try { fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}

// One Graph call. `body` is sent as a form (FormData when it holds a file Blob).
async function api(pathname, { method = 'GET', params = {}, body, token, base } = {}) {
  const c = creds();
  const url = new URL(`${base || graph()}/${String(pathname).replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', token || c.pageToken);
  let payload;
  if (body) {
    payload = new FormData();
    for (const [k, v] of Object.entries(body)) {
      if (v == null || v === '') continue;
      if (v instanceof Blob) payload.append(k, v, v.name || 'upload');
      else payload.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }
  const res = await fetch(url, { method, body: payload, signal: AbortSignal.timeout(120_000) });
  const out = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
  if (out.error) throw new Error(`Meta: ${out.error.message}${out.error.error_user_msg ? ` (${out.error.error_user_msg})` : ''}`);
  return out;
}

const isUrl = (s) => /^https?:\/\//i.test(String(s || ''));
function fileBlob(p) {
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).toLowerCase();
  const type = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime' }[ext] || 'application/octet-stream';
  const b = new Blob([buf], { type });
  b.name = path.basename(p);
  return b;
}
const isVideo = (s) => /\.(mp4|mov|m4v)(\?|$)/i.test(String(s));

// Instagram only accepts public image URLs. A local file goes up to the Page as an unpublished
// (hidden) photo first, and Instagram fetches it from Facebook's CDN.
async function publicImageUrl(src) {
  if (isUrl(src)) return src;
  const { id } = await api(`${creds().pageId}/photos`, { method: 'POST', body: { source: fileBlob(src), published: 'false', temporary: 'true' } });
  const { images } = await api(id, { params: { fields: 'images' } });
  return images[0].source;
}

// ── Facebook ──
async function postFacebook({ message, link, media = [] }) {
  const pageId = creds().pageId;
  media = [].concat(media || []).filter(Boolean);
  let out;
  if (media.length === 1 && isVideo(media[0])) {
    const body = { description: message || '', ...(isUrl(media[0]) ? { file_url: media[0] } : { source: fileBlob(media[0]) }) };
    out = await api(`${pageId}/videos`, { method: 'POST', body, base: graph().replace('graph.', 'graph-video.') });
  } else if (media.length === 1) {
    out = await api(`${pageId}/photos`, { method: 'POST', body: { caption: message || '', ...(isUrl(media[0]) ? { url: media[0] } : { source: fileBlob(media[0]) }) } });
  } else if (media.length > 1) {
    const ids = [];
    for (const m of media) ids.push((await api(`${pageId}/photos`, { method: 'POST', body: { published: 'false', ...(isUrl(m) ? { url: m } : { source: fileBlob(m) }) } })).id);
    const body = { message: message || '' };
    ids.forEach((id, i) => { body[`attached_media[${i}]`] = { media_fbid: id }; });
    out = await api(`${pageId}/feed`, { method: 'POST', body });
  } else {
    out = await api(`${pageId}/feed`, { method: 'POST', body: { message, link } });
  }
  const id = out.post_id || out.id;
  const info = await api(id, { params: { fields: 'permalink_url' } }).catch(() => ({}));
  return { platform: 'facebook', id, url: info.permalink_url || `https://www.facebook.com/${id}` };
}

// ── Instagram ──
async function waitForContainer(id) {
  for (let i = 0; i < 60; i++) {
    const { status_code: s, status } = await api(id, { params: { fields: 'status_code,status' } });
    if (s === 'FINISHED') return;
    if (s === 'ERROR' || s === 'EXPIRED') throw new Error(`Instagram couldn't process the media: ${status || s}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Instagram took too long processing the video.');
}

// Video container: public URL, or a local file through Instagram's resumable upload.
async function videoContainer(ig, src, fields) {
  if (isUrl(src)) return (await api(`${ig}/media`, { method: 'POST', body: { ...fields, video_url: src } })).id;
  const { id, uri } = await api(`${ig}/media`, { method: 'POST', body: { ...fields, upload_type: 'resumable' } });
  const buf = fs.readFileSync(src);
  const res = await fetch(uri, { method: 'POST', headers: { Authorization: `OAuth ${creds().pageToken}`, offset: '0', file_size: String(buf.length) }, body: buf, signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`Instagram video upload failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return id;
}

async function postInstagram({ caption, media = [], kind = 'post' }) {
  const ig = creds().igUserId;
  if (!ig) throw new Error('No Instagram business account is linked to the Page. Link it in Meta Business Suite, then rerun social/setup.js.');
  media = [].concat(media || []).filter(Boolean);
  if (!media.length) throw new Error('Instagram needs at least one image or video.');
  let creation;
  if (kind === 'story') {
    const m = media[0];
    creation = isVideo(m) ? await videoContainer(ig, m, { media_type: 'STORIES' }) : (await api(`${ig}/media`, { method: 'POST', body: { media_type: 'STORIES', image_url: await publicImageUrl(m) } })).id;
  } else if (media.length > 1) {
    if (media.length > 10) throw new Error('Instagram carousels take at most 10 items.');
    const children = [];
    for (const m of media) {
      children.push(isVideo(m)
        ? await videoContainer(ig, m, { media_type: 'VIDEO', is_carousel_item: 'true' })
        : (await api(`${ig}/media`, { method: 'POST', body: { image_url: await publicImageUrl(m), is_carousel_item: 'true' } })).id);
    }
    for (const c of children) await waitForContainer(c);
    creation = (await api(`${ig}/media`, { method: 'POST', body: { media_type: 'CAROUSEL', children: children.join(','), caption } })).id;
  } else if (isVideo(media[0]) || kind === 'reel') {
    creation = await videoContainer(ig, media[0], { media_type: 'REELS', caption, share_to_feed: 'true' });
  } else {
    creation = (await api(`${ig}/media`, { method: 'POST', body: { image_url: await publicImageUrl(media[0]), caption } })).id;
  }
  await waitForContainer(creation);
  const { id } = await api(`${ig}/media_publish`, { method: 'POST', body: { creation_id: creation } });
  const info = await api(id, { params: { fields: 'permalink' } }).catch(() => ({}));
  return { platform: 'instagram', id, url: info.permalink };
}

// Post to one or both. Each platform succeeds or fails on its own.
// ig_text: optional Instagram-specific caption (hashtags, "link in bio"); defaults to text + link.
async function publish({ platforms = ['facebook', 'instagram'], text, ig_text, link, media, kind }) {
  const results = [];
  for (const p of [].concat(platforms)) {
    try {
      const r = p === 'facebook'
        ? await postFacebook({ message: text, link, media: kind === 'story' ? [] : media })
        : await postInstagram({ caption: ig_text || [text, link].filter(Boolean).join('\n\n'), media, kind });
      log({ action: 'post', ...r, text: String(text || '').slice(0, 200) });
      results.push(r);
    } catch (e) {
      log({ action: 'post_failed', platform: p, error: e.message });
      results.push({ platform: p, error: e.message });
    }
  }
  return results;
}

// ── Reading ──
async function recentPosts({ platform = 'facebook', limit = 10 }) {
  const c = creds();
  if (platform === 'instagram') {
    const r = await api(`${c.igUserId}/media`, { params: { fields: 'id,caption,media_type,timestamp,permalink,like_count,comments_count', limit } });
    return r.data;
  }
  const r = await api(`${c.pageId}/posts`, { params: { fields: 'id,message,created_time,permalink_url,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)', limit } });
  return r.data.map((p) => ({ id: p.id, message: p.message, time: p.created_time, url: p.permalink_url, reactions: p.reactions?.summary?.total_count, comments: p.comments?.summary?.total_count, shares: p.shares?.count || 0 }));
}

// Comments on recent posts across both platforms, newest first; `since` filters to new ones.
async function recentComments({ platform, since, posts = 10 } = {}) {
  const c = creds();
  const sinceMs = since ? Date.parse(since) : 0;
  const out = [];
  if (platform !== 'instagram') {
    const r = await api(`${c.pageId}/posts`, { params: { fields: `id,message,permalink_url,comments.limit(50).order(reverse_chronological){id,from,message,created_time,is_hidden,comment_count}`, limit: posts } });
    for (const p of r.data) for (const cm of p.comments?.data || []) {
      if (cm.from?.id === c.pageId) continue; // our own replies
      out.push({ platform: 'facebook', comment_id: cm.id, from: cm.from?.name || 'someone', text: cm.message, time: cm.created_time, replies: cm.comment_count, hidden: cm.is_hidden, post_id: p.id, post: String(p.message || '').slice(0, 120), post_url: p.permalink_url });
    }
  }
  if (platform !== 'facebook' && c.igUserId) {
    const r = await api(`${c.igUserId}/media`, { params: { fields: 'id,caption,permalink,comments.limit(50){id,username,text,timestamp,hidden,replies{username}}', limit: posts } });
    for (const p of r.data) for (const cm of p.comments?.data || []) {
      if (cm.username && cm.username === c.igUsername) continue;
      out.push({ platform: 'instagram', comment_id: cm.id, from: cm.username, text: cm.text, time: cm.timestamp, replied: (cm.replies?.data || []).some((x) => x.username === c.igUsername), hidden: cm.hidden, post_id: p.id, post: String(p.caption || '').slice(0, 120), post_url: p.permalink });
    }
  }
  return out.filter((x) => !sinceMs || Date.parse(x.time) > sinceMs).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

async function replyComment({ platform, comment_id, text }) {
  const r = platform === 'instagram'
    ? await api(`${comment_id}/replies`, { method: 'POST', body: { message: text } })
    : await api(`${comment_id}/comments`, { method: 'POST', body: { message: text } });
  log({ action: 'reply', platform, comment_id, text: text.slice(0, 200) });
  return { ok: true, id: r.id };
}

async function hideComment({ platform, comment_id, hide = true }) {
  await api(comment_id, { method: 'POST', body: platform === 'instagram' ? { hide: String(hide) } : { is_hidden: String(hide) } });
  log({ action: hide ? 'hide' : 'unhide', platform, comment_id });
  return { ok: true };
}

async function deletePost({ id }) {
  await api(id, { method: 'DELETE' });
  log({ action: 'delete', id });
  return { ok: true };
}

// Account overview + per-post engagement. Extra Graph insight metrics can be asked for by name.
async function insights({ platform = 'both', metrics, period = 'day', days = 28 } = {}) {
  const c = creds();
  const out = {};
  const until = Math.floor(Date.now() / 1000), since = until - days * 86400;
  if (platform !== 'instagram') {
    out.facebook = await api(c.pageId, { params: { fields: 'name,followers_count,fan_count' } });
    out.facebook.recent_posts = await recentPosts({ platform: 'facebook', limit: 10 });
    if (metrics) out.facebook.metrics = await api(`${c.pageId}/insights`, { params: { metric: metrics, period, since, until } }).then((r) => r.data).catch((e) => ({ error: e.message }));
  }
  if (platform !== 'facebook' && c.igUserId) {
    out.instagram = await api(c.igUserId, { params: { fields: 'username,followers_count,follows_count,media_count' } });
    out.instagram.recent_posts = await recentPosts({ platform: 'instagram', limit: 10 });
    const m = metrics || 'reach,profile_views,accounts_engaged,total_interactions';
    out.instagram.metrics = await api(`${c.igUserId}/insights`, { params: { metric: m, period: 'day', metric_type: 'total_value', since: Math.max(since, until - 30 * 86400), until } }).then((r) => r.data.map((d) => ({ name: d.name, total: d.total_value?.value }))).catch((e) => ({ error: e.message }));
  }
  return out;
}

async function status() {
  if (!configured()) return { configured: false, note: 'Not connected yet: the owner runs node social/setup.js (steps in coco-voice/social/README.md).' };
  const c = creds();
  try {
    const page = await api(c.pageId, { params: { fields: 'name,followers_count,link' } });
    const ig = c.igUserId ? await api(c.igUserId, { params: { fields: 'username,followers_count' } }) : null;
    return { configured: true, facebook: page, instagram: ig || 'no Instagram account linked', queued: queue().filter((q) => q.status === 'queued').length };
  } catch (e) { return { configured: true, error: e.message }; }
}

// ── Schedule queue (Instagram's API can't schedule, so Coco's server publishes these on time) ──
const queue = () => readJson(QUEUE_FILE, []);
const saveQueue = (q) => fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 1));
function schedule(post) {
  const at = Date.parse(post.at);
  if (!at) throw new Error('`at` must be an ISO date-time, e.g. 2026-10-10T09:00:00+02:00');
  if (at < Date.now() - 60_000) throw new Error('That time is in the past.');
  for (const m of [].concat(post.media || [])) if (m && !isUrl(m) && !fs.existsSync(m)) throw new Error(`File not found: ${m}`);
  const q = queue();
  const item = { id: `sp-${Math.random().toString(36).slice(2, 8)}`, status: 'queued', created: new Date().toISOString(), ...post, at: new Date(at).toISOString() };
  q.push(item);
  saveQueue(q);
  return item;
}
function unschedule(id) {
  const q = queue(), item = q.find((x) => x.id === id && x.status === 'queued');
  if (!item) return { error: `No queued post ${id}.` };
  item.status = 'cancelled';
  saveQueue(q);
  return { ok: true };
}
// Called by server.js every minute. Returns the posts it published (for a Telegram note).
async function runDue() {
  if (!configured()) return [];
  const q = queue(), due = q.filter((x) => x.status === 'queued' && Date.parse(x.at) <= Date.now());
  const done = [];
  for (const item of due) {
    item.status = 'publishing';
    saveQueue(q);
    item.results = await publish(item);
    item.status = item.results.every((r) => r.error) ? 'failed' : 'posted';
    item.postedAt = new Date().toISOString();
    saveQueue(q);
    done.push(item);
  }
  return done;
}

module.exports = { configured, creds, api, publish, recentPosts, recentComments, replyComment, hideComment, deletePost, insights, status, queue, schedule, unschedule, runDue, SOCIAL_FILE };

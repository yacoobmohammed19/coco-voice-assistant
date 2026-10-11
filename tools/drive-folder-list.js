#!/usr/bin/env node
// List EVERY file in a Google Drive folder that is shared by link, recursively, without login.
// Google's Drive API search only returns files the user has opened or been shared directly, so it
// misses most of a link-shared folder. Drive's public "embedded folder view" lists everything.
//
// Usage: node drive-folder-list.js <folder URL or id> [--csv out.csv] [--json out.json]
// Prints a summary; --csv / --json write the full listing (path, name, id, type, view link, image link).
const fs = require('fs');

const arg = process.argv[2] || '';
const rootId = (arg.match(/folders\/([\w-]+)/) || arg.match(/[?&]id=([\w-]+)/) || [null, arg])[1];
if (!rootId) { console.error('Give a Drive folder URL or id.'); process.exit(1); }
const opt = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function listFolder(id) {
  const res = await fetch(`https://drive.google.com/embeddedfolderview?id=${id}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`folder ${id}: HTTP ${res.status} (not shared by link?)`);
  const html = await res.text();
  const items = [];
  // Each entry: <div class="flip-entry" id="entry-<id>"> ... <a href="..."> ... flip-entry-title">NAME<
  for (const m of html.matchAll(/id="entry-([\w-]+)"[\s\S]*?href="([^"]+)"[\s\S]*?flip-entry-title">([^<]*)</g)) {
    const [, fid, href, name] = m;
    items.push({ id: fid, name: decode(name), folder: /\/folders\//.test(href) });
  }
  return items;
}

(async () => {
  const out = [];
  const queue = [{ id: rootId, path: '' }];
  let folders = 0;
  while (queue.length) {
    const { id, path } = queue.shift();
    const items = await listFolder(id);
    for (const it of items) {
      if (it.folder) { folders++; queue.push({ id: it.id, path: `${path}/${it.name}` }); continue; }
      out.push({
        path: path || '/', name: it.name, id: it.id, type: (it.name.split('.').pop() || '').toLowerCase(),
        view: `https://drive.google.com/file/d/${it.id}/view`,
        image: `https://drive.google.com/thumbnail?id=${it.id}&sz=w1600`,
      });
    }
  }
  const num = (n) => { const m = n.match(/^(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : Infinity; };
  out.sort((a, b) => a.path.localeCompare(b.path) || num(a.name) - num(b.name) || a.name.localeCompare(b.name));

  const byPath = {};
  for (const f of out) byPath[f.path] = (byPath[f.path] || 0) + 1;
  console.log(`${out.length} files in ${folders + 1} folders`);
  for (const [p, n] of Object.entries(byPath)) console.log(`  ${p}: ${n}`);

  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(out, null, 2));
  if (opt('--csv')) {
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    fs.writeFileSync(opt('--csv'), ['path,name,id,type,view_link,image_link', ...out.map((f) => [f.path, f.name, f.id, f.type, f.view, f.image].map(q).join(','))].join('\n'));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

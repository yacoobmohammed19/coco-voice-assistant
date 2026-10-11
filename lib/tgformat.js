// Markdown (what jobs and notes are written in) -> Telegram-friendly HTML that reads well on a phone.
// Telegram can't show headings or tables, so: headings become bold lines, tables become one bullet card
// per row, bullets become "•", inline code becomes plain text, and bare local file paths are dropped
// (the files themselves are sent separately).
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  let t = esc(s);
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, txt, url) => `<a href="${url.replace(/"/g, '%22')}">${txt}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>');
  t = t.replace(/`([^`]+)`/g, '$1');
  return t;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const EMPTY = /^(—|-|–|n\/a|not set|none)?$/i;
const PATH_ONLY = /^\s*(?:[-*•]\s+)?`?(?:[A-Za-z]:\\|\/|~\/)[^\s`]*`?\s*$/;

function toTelegram(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Table: header row followed by a |---| separator.
    if (line.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = cells(lines[i]);
        const title = row.slice(0, Math.min(2, row.length)).filter((c) => !EMPTY.test(c)).map(inline).join(' · ');
        const rest = row.slice(2).map((c, k) => (EMPTY.test(c) ? null : `${esc(head[k + 2] || '')}: ${inline(c)}`)).filter(Boolean);
        out.push(`• <b>${title}</b>${rest.length ? `\n   ${rest.join('\n   ')}` : ''}`);
        i++;
      }
      i--;
      out.push('');
      continue;
    }
    if (PATH_ONLY.test(line)) continue;
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) { if (out.length && out[out.length - 1] !== '') out.push(''); out.push(`<b>${inline(h[1])}</b>`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push(''); continue; }
    const b = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (b) { out.push(`${b[1] ? '   ' : ''}• ${inline(b[2])}`); continue; }
    out.push(inline(line));
  }
  // Drop headings left with nothing under them (e.g. a "Files" section of paths) and extra blank lines.
  const text = out.join('\n').replace(/<b>[^<\n]*<\/b>\n*(?=<b>|$)/g, (m, off, all) => (/\n\s*$/.test(m) || off + m.length >= all.length ? '' : m));
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { toTelegram, esc };

// "Coco calls you back": urgent push via ntfy (free, no account). The topic is a long random
// secret; messages carry only a short title, never content — details go to email/vault.
const { execFile } = require('child_process');

function headers({ title, url, urgent }) {
  return {
    Title: title.replace(/[^\x20-\x7E]/g, ''),
    Priority: urgent ? '5' : '3',
    Tags: 'telephone_receiver',
    ...(url ? { Click: url, Actions: `view, Pick up, ${url}` } : {}),
  };
}

// Fallback for machines where node.exe can't reach ntfy but curl.exe (built into Windows) can.
function viaCurl(endpoint, h, body) {
  return new Promise((resolve) => {
    const args = ['-s', '-m', '15', '-o', 'NUL', '-w', '%{http_code}', '-d', body];
    for (const [k, v] of Object.entries(h)) args.push('-H', `${k}: ${v}`);
    args.push(endpoint);
    execFile('curl.exe', args, { windowsHide: true }, (err, out) => resolve(!err && String(out).trim() === '200'));
  });
}

async function push(cfg, { title, message, url, urgent = true }) {
  if (!cfg.ntfyTopic) return false;
  const endpoint = `${cfg.ntfyServer}/${cfg.ntfyTopic}`;
  const h = headers({ title, url, urgent });
  try {
    const res = await fetch(endpoint, { method: 'POST', headers: h, body: message, signal: AbortSignal.timeout(8000) });
    if (res.ok) return true;
  } catch { /* fall through to curl */ }
  const ok = await viaCurl(endpoint, h, message);
  if (!ok) console.error('[notify] push failed');
  return ok;
}

module.exports = { push };

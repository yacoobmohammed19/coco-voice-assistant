// One-time setup. Run:  node setup.js
// Options: --reset-pin  --twilio  --gemini-key  --gemini-free-key  --groq-key  --claude-token  --public-url <https://...>  --api-key <sk-ant-...>
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync } = require('child_process');
const config = require('./lib/config');
const auth = require('./lib/auth');

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a.trim()); }));
}

function tailscaleUrl() {
  for (const exe of ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']) {
    try {
      const s = JSON.parse(execFileSync(exe, ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      const dns = s.Self && s.Self.DNSName && s.Self.DNSName.replace(/\.$/, '');
      if (dns) return `https://${dns}`;
    } catch { /* not installed / not logged in */ }
  }
  return '';
}

(async () => {
  const cfg = config.load();

  if (!cfg.sessionSecret) cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
  if (!cfg.ntfyTopic) cfg.ntfyTopic = 'coco-' + crypto.randomBytes(16).toString('hex');
  if (!cfg.sidecarSecret) cfg.sidecarSecret = crypto.randomBytes(32).toString('hex');

  if (!cfg.pinHash || args.includes('--reset-pin') || arg('--pin')) {
    let pin = arg('--pin');
    while (!pin || !/^\d{6,12}$/.test(pin)) {
      pin = await ask('Choose a PIN for Coco (6-12 digits, not one you use elsewhere): ');
    }
    Object.assign(cfg, auth.makePin(pin));
    if (args.includes('--reset-pin') || arg('--pin')) cfg.sessionSecret = crypto.randomBytes(32).toString('hex'); // log out all devices
  }

  const pub = arg('--public-url') || tailscaleUrl();
  if (pub) cfg.publicUrl = pub.replace(/\/$/, '');
  if (arg('--api-key')) cfg.anthropicApiKey = arg('--api-key');
  if (args.includes('--gemini-key')) {
    const k = await ask('Paste your Gemini API key from aistudio.google.com/apikey (stays on this PC): ');
    if (k) cfg.geminiApiKey = k;
  }
  if (args.includes('--gemini-free-key')) {
    const k = await ask('Paste a Gemini key from a Google project WITHOUT billing (free tier, used first for background work): ');
    if (k) cfg.geminiFreeApiKey = k.trim();
  }
  if (args.includes('--groq-key')) {
    const k = await ask('Paste your Groq API key from console.groq.com/keys (free Whisper for voice notes): ');
    if (k) cfg.groqApiKey = k.trim();
  }
  if (args.includes('--twilio')) {
    console.log('\nFrom the Twilio console (console.twilio.com), Account Info box:');
    const sid = await ask('  Account SID (starts AC...): ');
    const tok = await ask('  Auth Token: ');
    const num = await ask("  Coco's Twilio phone number (e.g. +1 555 123 4567): ");
    const own = await ask(`  Your mobile number [${cfg.ownerNumber || ''}]: `);
    const e164 = (n) => { let d = String(n).replace(/[^\d+]/g, ''); if (d.startsWith('0')) d = '+27' + d.slice(1); if (!d.startsWith('+')) d = '+' + d; return d; };
    if (sid) cfg.twilioSid = sid.trim();
    if (tok) cfg.twilioToken = tok.trim();
    if (num) cfg.twilioNumber = e164(num);
    cfg.ownerNumber = e164(own || cfg.ownerNumber || '');
    if (cfg.publicUrl && !cfg.phonePublicUrl) cfg.phonePublicUrl = cfg.publicUrl + ':8443';
  }
  if (args.includes('--claude-token')) {
    const t = await ask('Paste the token printed by `claude setup-token` (input stays on this PC): ');
    if (t) cfg.claudeOAuthToken = t;
  }

  config.save(cfg);
  console.log('\nSaved', config.CONFIG_FILE);
  console.log('  Phone URL     :', cfg.publicUrl || '(none yet — install Tailscale, then re-run setup)');
  console.log('  Callback topic:', `${cfg.ntfyServer}/${cfg.ntfyTopic}  (subscribe in the ntfy app; keep secret)`);
  console.log('  Phone calls   :', cfg.twilioSid ? `Coco ${cfg.twilioNumber} -> you ${cfg.ownerNumber}` : 'not set up (node setup.js --twilio)');
  console.log('  Voice         :', cfg.geminiApiKey ? `Gemini TTS (${cfg.geminiTtsModel})` : 'Microsoft Edge voices (backup)');
  console.log('  Conversation  :', cfg.anthropicApiKey ? 'Anthropic API (fast)' : 'Claude Code CLI on your subscription');
})();

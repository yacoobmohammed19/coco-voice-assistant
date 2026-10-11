// Real phone calls via Twilio. Coco dials the owner's mobile (rings like any call) or he dials Coco's
// number; either way the audio is bridged to Gemini Live on this PC, with the same tools and rules.
//
// Exposure: only this module's tiny HTTP server (127.0.0.1:phonePort) is published to the internet,
// through Tailscale Funnel on :8443. It answers three paths and nothing else:
//   POST /twilio/voice   inbound call webhook (Twilio-signed, owner's caller ID only, then keypad PIN)
//   POST /twilio/pin     PIN check, then connect the audio stream
//   WS   /twilio/stream  audio stream, accepted only with a single-use token minted for that call
const http = require('http');
const crypto = require('crypto');
const ws = require('./wsserver');
const audio = require('./audio');
const auth = require('./auth');
const callbridge = require('./callbridge');
const { PERSONAS } = require('./tts');

let cfg = null, hooks = {};
const tokens = new Map(); // single-use stream tokens -> { kickoff, expires, direction }

const configured = () => !!(cfg && cfg.twilioSid && cfg.twilioToken && cfg.twilioNumber && cfg.ownerNumber && cfg.phonePublicUrl);
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sayVoice = () => (PERSONAS[cfg.persona] || PERSONAS.jarvis).gender === 'female' ? 'Polly.Amy' : 'Polly.Brian';

function mintToken(info) {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, { ...info, expires: Date.now() + 3 * 60_000 });
  return t;
}

function streamTwiml(token) {
  const url = cfg.phonePublicUrl.replace(/^https:/, 'wss:') + '/twilio/stream';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(url)}"><Parameter name="t" value="${token}"/></Stream></Connect></Response>`;
}

async function twilioApi(path, form) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilioSid}${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${cfg.twilioSid}:${cfg.twilioToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`twilio ${res.status}: ${body.message || JSON.stringify(body).slice(0, 200)}`);
  return body;
}

// Coco rings the owner. kickoff = what Coco should open with once he answers.
async function call(kickoff) {
  if (!configured()) throw new Error('phone not configured');
  const token = mintToken({ kickoff, direction: 'outbound' });
  const c = await twilioApi('/Calls.json', { To: cfg.ownerNumber, From: cfg.twilioNumber, Twiml: streamTwiml(token), Timeout: '30' });
  console.log('[phone] calling', cfg.ownerNumber, c.sid);
  return c.sid;
}

function validSignature(req, params) {
  const sig = req.headers['x-twilio-signature'];
  if (!sig) return false;
  const url = cfg.phonePublicUrl + req.url;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expect = crypto.createHmac('sha1', cfg.twilioToken).update(data).digest('base64');
  return sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
}

const normal = (n) => String(n || '').replace(/[^\d+]/g, '');

function readForm(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 32768) req.destroy(); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(d))));
  });
}

async function handleHttp(req, res) {
  const twiml = (body) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`); };
  if (req.method !== 'POST' || !['/twilio/voice', '/twilio/pin'].includes(req.url.split('?')[0])) { res.writeHead(404); return res.end(); }
  const params = await readForm(req);
  if (!configured() || !validSignature(req, params)) { res.writeHead(403); return res.end(); }

  // Only the owner's own number may call in, and caller ID can be faked, so a keypad PIN is required too.
  if (normal(params.From) !== normal(cfg.ownerNumber)) return twiml('<Reject/>');
  if (req.url.startsWith('/twilio/voice')) {
    return twiml(`<Gather input="dtmf" finishOnKey="#" timeout="10" action="/twilio/pin" method="POST"><Say voice="${sayVoice()}">Hey, it's Coco. Key in your PIN, then hash.</Say></Gather><Say voice="${sayVoice()}">No PIN, bye.</Say><Hangup/>`);
  }
  const r = auth.attempt(cfg, params.Digits || '');
  if (!r.ok) return twiml(`<Say voice="${sayVoice()}">${r.locked ? 'Too many wrong PINs. Try again later.' : "That PIN didn't work."}</Say><Hangup/>`);
  const token = mintToken({ kickoff: hooks.kickoff ? hooks.kickoff() : '[The owner just called you. Greet him casually.]', direction: 'inbound' });
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  return res.end(streamTwiml(token));
}

// Bridge one Twilio media stream to Gemini Live (shared engine in callbridge.js), mu-law 8 kHz.
const twilioCodec = {
  decode: (buf) => audio.mulaw8kToPcm16k(buf),
  encode: (pcm, rate) => { const mu = audio.pcmToMulaw8k(pcm, rate); const out = []; for (let i = 0; i < mu.length; i += 160) out.push(mu.subarray(i, i + 160).toString('base64')); return out; },
};
function bridge(tw) {
  callbridge.bridge(tw, {
    cfg, hooks, codec: twilioCodec, label: 'Phone',
    resolveStart: (m) => {
      const t = m.start && m.start.customParameters && m.start.customParameters.t;
      const info = t && tokens.get(t);
      tokens.delete(t);
      return info && info.expires > Date.now() ? info : null;
    },
  });
}

// Point Coco's Twilio number at this bridge so calling it reaches Coco (no manual console setup).
async function ensureInbound() {
  if (!configured()) return;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilioSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(cfg.twilioNumber)}`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.twilioSid}:${cfg.twilioToken}`).toString('base64') },
      signal: AbortSignal.timeout(15000),
    });
    const list = await res.json();
    const num = (list.incoming_phone_numbers || [])[0];
    if (!num) return console.error('[phone] Coco number not found on the Twilio account:', cfg.twilioNumber);
    const want = cfg.phonePublicUrl + '/twilio/voice';
    if (num.voice_url !== want) {
      await twilioApi(`/IncomingPhoneNumbers/${num.sid}.json`, { VoiceUrl: want, VoiceMethod: 'POST' });
      console.log('[phone] inbound calls now route to Coco');
    }
  } catch (e) {
    console.error('[phone] could not set up inbound calls:', e.message);
  }
}

function start(config, h) {
  cfg = config;
  hooks = h;
  ensureInbound();
  setInterval(() => { for (const [t, v] of tokens) if (v.expires < Date.now()) tokens.delete(t); }, 60_000).unref();
  const server = http.createServer((req, res) => handleHttp(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch {} }));
  server.on('upgrade', (req, sock) => {
    if (!configured() || req.url.split('?')[0] !== '/twilio/stream') return sock.destroy();
    const s = ws.accept(req, sock);
    if (s) bridge(s);
  });
  server.listen(cfg.phonePort, '127.0.0.1', () => console.log(`Phone bridge on 127.0.0.1:${cfg.phonePort}${configured() ? ` (Coco number ${cfg.twilioNumber} -> ${cfg.ownerNumber})` : ' (not configured yet)'}`));
}

module.exports = { start, call, configured };

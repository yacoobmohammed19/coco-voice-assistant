// PIN login -> signed session cookie. Lockout after repeated failures.
const crypto = require('crypto');

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}

function makePin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { pinSalt: salt, pinHash: hashPin(pin, salt) };
}

function checkPin(cfg, pin) {
  if (!cfg.pinHash || !cfg.pinSalt) return false;
  const a = Buffer.from(hashPin(pin, cfg.pinSalt), 'hex');
  const b = Buffer.from(cfg.pinHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(cfg, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', cfg.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(cfg, token) {
  if (!token || !cfg.sessionSecret) return null;
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', cfg.sessionSecret).update(body).digest('base64url');
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

// Global (not per-IP) lockout: behind Tailscale Serve every request arrives from localhost.
const lock = { fails: 0, until: 0 };
function attempt(cfg, pin) {
  const now = Date.now();
  if (now < lock.until) return { ok: false, locked: Math.ceil((lock.until - now) / 60000) };
  if (checkPin(cfg, pin)) { lock.fails = 0; return { ok: true }; }
  lock.fails += 1;
  if (lock.fails >= 5) { lock.until = now + 15 * 60 * 1000; lock.fails = 0; }
  return { ok: false };
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

module.exports = { makePin, attempt, sign, verify, readCookie };

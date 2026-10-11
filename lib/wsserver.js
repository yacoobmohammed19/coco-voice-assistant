// Minimal WebSocket server (RFC 6455): enough for Twilio Media Streams (text frames, ping/pong, close).
// Keeps Coco dependency-free.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.open = true;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('close', () => this.closed());
    sock.on('error', () => this.closed());
  }

  closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  parse() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 16 * 1024 * 1024) { this.close(1009); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(need);
      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { this.frame(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.frags.push(payload);
        if (fin) {
          const msg = Buffer.concat(this.frags);
          this.frags = [];
          this.emit('message', op === 0x2 ? msg : msg.toString('utf8'));
        }
      }
    }
  }

  frame(op, data) {
    if (!this.open) return;
    const len = data.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    try { this.sock.write(Buffer.concat([head, data])); } catch { this.closed(); }
  }

  send(text) { this.frame(0x1, Buffer.from(String(text), 'utf8')); }

  close(code = 1000) {
    if (!this.open) return;
    const b = Buffer.alloc(2); b.writeUInt16BE(code, 0);
    this.frame(0x8, b);
    try { this.sock.end(); } catch {}
    this.closed();
  }
}

// Completes the upgrade handshake on an http 'upgrade' event and returns a Socket.
function accept(req, sock) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.destroy(); return null; }
  const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
  sock.setNoDelay(true);
  return new Socket(sock);
}

module.exports = { accept };

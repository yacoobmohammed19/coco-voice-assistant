// Backup engine: Microsoft Edge Read Aloud neural voices (free, no account, but throttles quickly).
// Unofficial endpoint: if it ever stops working, the phone falls back to its built-in voice.
const crypto = require('crypto');

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM = '143.0.3650.75'; // must look like a current Edge; older versions get 403
const BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

const VOICES = {
  jarvis: { id: 'en-GB-RyanNeural', label: 'Jarvis: British male (Ryan)' },
  friday: { id: 'en-IE-EmilyNeural', label: 'Friday: Irish female (Emily)' },
  andrew: { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew: warm US male (most natural)' },
  ava: { id: 'en-US-AvaMultilingualNeural', label: 'Ava: warm US female (most natural)' },
  luke: { id: 'en-ZA-LukeNeural', label: 'Luke: South African male' },
  leah: { id: 'en-ZA-LeahNeural', label: 'Leah: South African female' },
  thomas: { id: 'en-GB-ThomasNeural', label: 'Thomas: British male, younger' },
  sonia: { id: 'en-GB-SoniaNeural', label: 'Sonia: British female' },
};

function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000) + 11644473600;
  ticks -= ticks % 300;
  const str = `${BigInt(ticks) * 10000000n}${TOKEN}`;
  return crypto.createHash('sha256').update(str, 'ascii').digest('hex').toUpperCase();
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const uuid = () => crypto.randomUUID().replace(/-/g, '');
const stamp = () => new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');

const prep = (text) => String(text).slice(0, 1500); // pronunciation fixes happen in tts.js

function synthesize(text, voiceKey = 'jarvis', { rate = '+4%', pitch = '+0Hz', voiceId } = {}) {
  const voice = voiceId || (VOICES[voiceKey] || VOICES.jarvis).id;
  const url = `${BASE}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM}&ConnectionId=${uuid()}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: {
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM.split('.')[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM.split('.')[0]}.0.0.0`,
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
      },
    });
    ws.binaryType = 'arraybuffer';
    const chunks = [];
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('tts timeout')); }, 6000);
    ws.onopen = () => {
      ws.send(`X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      ws.send(`X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n`
        + `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'>`
        + `<prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${esc(prep(text))}</prosody></voice></speak>`);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data.includes('Path:turn.end')) { clearTimeout(timer); ws.close(); resolve(Buffer.concat(chunks)); }
        return;
      }
      const buf = Buffer.from(ev.data);
      const headLen = buf.readUInt16BE(0);
      const head = buf.subarray(2, 2 + headLen).toString();
      if (head.includes('Path:audio')) chunks.push(buf.subarray(2 + headLen));
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('tts socket error: ' + (e.message || e.error?.message || 'unknown'))); };
    ws.onclose = (ev) => {
      clearTimeout(timer);
      if (chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`tts closed with no audio (code ${ev.code})`));
    };
  });
}

module.exports = { synthesize, VOICES };

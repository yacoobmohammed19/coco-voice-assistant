// Phone audio <-> Gemini audio. Twilio speaks 8 kHz G.711 mu-law; Gemini Live takes 16 kHz PCM16 in
// and gives 24 kHz PCM16 out.

const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  MULAW_DECODE[i] = sign ? -sample : sample;
}

function mulawEncodeSample(pcm) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (pcm >> 8) & 0x80;
  if (sign) pcm = -pcm;
  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// mu-law 8 kHz bytes -> PCM16LE 16 kHz bytes (linear interpolation upsample x2)
function mulaw8kToPcm16k(buf) {
  const n = buf.length;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const a = MULAW_DECODE[buf[i]];
    const b = i + 1 < n ? MULAW_DECODE[buf[i + 1]] : a;
    out.writeInt16LE(a, i * 4);
    out.writeInt16LE((a + b) >> 1, i * 4 + 2);
  }
  return out;
}

// PCM16LE at `rate` (24 kHz from Gemini) -> mu-law 8 kHz bytes (box-filter decimation)
function pcmToMulaw8k(buf, rate = 24000) {
  const step = rate / 8000;
  const samples = buf.length >> 1;
  const outLen = Math.floor(samples / step);
  const out = Buffer.alloc(outLen);
  for (let o = 0; o < outLen; o++) {
    const start = Math.floor(o * step), end = Math.min(samples, Math.floor((o + 1) * step));
    let sum = 0;
    for (let i = start; i < end; i++) sum += buf.readInt16LE(i * 2);
    out[o] = mulawEncodeSample(Math.round(sum / Math.max(1, end - start)));
  }
  return out;
}

module.exports = { mulaw8kToPcm16k, pcmToMulaw8k };

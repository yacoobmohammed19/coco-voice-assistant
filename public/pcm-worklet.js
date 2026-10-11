// Mic capture: resample whatever the device runs at (often 48 kHz) to 16 kHz 16-bit PCM for Gemini Live,
// posting ~100 ms chunks back to the page.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.muted = false;
    this.port.onmessage = (e) => { if (e.data && 'muted' in e.data) this.muted = e.data.muted; };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = this.pos;
    for (; i < ch.length; i += this.ratio) {
      const i0 = Math.floor(i);
      const f = i - i0;
      const a = ch[i0];
      const b = i0 + 1 < ch.length ? ch[i0 + 1] : a;
      let s = this.muted ? 0 : a + (b - a) * f;
      s = Math.max(-1, Math.min(1, s));
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.out.length) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(1600);
        this.n = 0;
      }
    }
    this.pos = i - ch.length;
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);

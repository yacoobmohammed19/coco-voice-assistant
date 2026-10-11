// Coco Live: a real-time voice call with Gemini Live. Mic audio streams up, Coco's voice streams back,
// you can interrupt any time. Tool calls (vault, jobs) are relayed to the Coco server on the PC, which
// enforces the rules. The PC hands this page a single-use token with Coco's setup locked in.
const CocoLive = (() => {
  let ws = null, ctx = null, stream = null, node = null, src = null;
  let callId = null, playing = [], nextTime = 0, muted = false, ending = false;
  let heard = '', saidBuf = '', heardBuf = '';
  let ui = {};

  const b64 = (buf) => {
    let s = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };

  function playPcm(base64, rate = 24000) {
    const bin = atob(base64);
    const n = bin.length >> 1;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      f[i] = v / 0x8000;
    }
    const buf = ctx.createBuffer(1, n, rate);
    buf.copyToChannel(f, 0);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(ctx.destination);
    nextTime = Math.max(nextTime, ctx.currentTime + 0.03);
    s.start(nextTime);
    nextTime += buf.duration;
    playing.push(s);
    s.onended = () => {
      playing = playing.filter((x) => x !== s);
      if (!playing.length) {
        ui.state(muted ? 'live' : 'listening');
        if (ending) hangup();
      }
    };
    ui.state('speaking');
  }

  function stopPlayback() {
    for (const s of playing) { try { s.stop(); } catch {} }
    playing = [];
    nextTime = 0;
  }

  function flushTranscripts() {
    if (heardBuf.trim()) { ui.add('You', heardBuf.trim()); log('you', heardBuf.trim()); heardBuf = ''; }
    if (saidBuf.trim()) { ui.add('Coco', saidBuf.trim()); log('coco', saidBuf.trim()); saidBuf = ''; }
  }

  function log(who, text) {
    fetch('/api/live/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId, who, text }) }).catch(() => {});
  }

  async function runTools(calls) {
    ui.state('thinking');
    flushTranscripts();
    const responses = [];
    for (const c of calls) {
      let out;
      try {
        const res = await fetch('/api/live/tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId, name: c.name, args: c.args || {}, heard }) });
        out = await res.json();
      } catch { out = { error: 'Could not reach the PC.' }; }
      if (c.name === 'end_call') ending = true;
      if (c.name === 'start_job' || c.name === 'confirm_job' || c.name === 'cancel_job') ui.jobs();
      responses.push({ id: c.id, name: c.name, response: out });
    }
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    if (ending && !playing.length) setTimeout(() => { if (!playing.length) hangup(); }, 4000);
  }

  function onMessage(m) {
    if (m.setupComplete) {
      ui.state('listening', 'Connected');
      return;
    }
    if (m.toolCall) return runTools(m.toolCall.functionCalls || []);
    if (m.goAway) ui.status('Call time is almost up. Hang up and call again to keep going.');
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.interrupted) { stopPlayback(); ui.state('listening'); }
    if (sc.inputTranscription && sc.inputTranscription.text) {
      if (saidBuf.trim()) { ui.add('Coco', saidBuf.trim()); log('coco', saidBuf.trim()); saidBuf = ''; }
      heardBuf += sc.inputTranscription.text;
      heard = heardBuf.trim() || heard;
      ui.status(heardBuf.trim());
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      if (heardBuf.trim()) { ui.add('You', heardBuf.trim()); log('you', heardBuf.trim()); heardBuf = ''; }
      saidBuf += sc.outputTranscription.text;
    }
    if (sc.modelTurn && sc.modelTurn.parts) {
      for (const p of sc.modelTurn.parts) {
        if (p.inlineData && p.inlineData.data && /audio/.test(p.inlineData.mimeType || 'audio')) {
          const rate = Number(((p.inlineData.mimeType || '').match(/rate=(\d+)/) || [])[1]) || 24000;
          playPcm(p.inlineData.data, rate);
        }
      }
    }
    if (sc.turnComplete) flushTranscripts();
  }

  async function start(opts) {
    ui = opts.ui;
    ending = false; muted = false; heard = ''; saidBuf = ''; heardBuf = '';
    // Audio context + mic must start inside the tap on iPhone.
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    ui.state('thinking', 'Connecting…');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    await ctx.audioWorklet.addModule('/pcm-worklet.js');

    const res = await fetch('/api/live/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persona: opts.persona, jobId: opts.jobId, ringId: opts.ringId }) });
    if (res.status === 401) throw new Error('login');
    const s = await res.json();
    if (!res.ok) throw new Error(s.error || 'could not start');
    callId = s.callId;
    if (opts.onJobs) opts.onJobs(s.jobs);

    ws = new WebSocket(`${s.wsUrl}?access_token=${encodeURIComponent(s.token)}`);
    ws.onopen = () => ws.send(JSON.stringify({ setup: { model: s.model } }));
    ws.onmessage = async (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : await ev.data.text();
      let m; try { m = JSON.parse(text); } catch { return; }
      if (m.setupComplete) {
        // start streaming the mic, then let Coco say hello
        src = ctx.createMediaStreamSource(stream);
        node = new AudioWorkletNode(ctx, 'pcm-capture');
        node.port.onmessage = (e) => {
          if (!ws || ws.readyState !== 1) return;
          // Echo guard: while Coco is talking through the speaker, its own voice leaks into the mic.
          // Send silence then, unless the chunk is loud enough to be the owner talking over Coco.
          const pcm = new Int16Array(e.data);
          if (playing.length || ctx.currentTime < nextTime + 0.3) {
            let sum = 0;
            for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
            const rms = Math.sqrt(sum / pcm.length) / 32768;
            if (rms < 0.09) pcm.fill(0);
          }
          ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(pcm.buffer), mimeType: 'audio/pcm;rate=16000' } } }));
        };
        src.connect(node);
        ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: s.kickoff }] }], turnComplete: true } }));
      }
      onMessage(m);
    };
    ws.onerror = () => ui.status('Connection problem.');
    ws.onclose = (e) => {
      const wasLive = !!callId;
      cleanup();
      if (wasLive) ui.ended(e.code === 1000 ? 'Call ended.' : `Call dropped (${e.reason || e.code}). Tap to call again.`);
    };
  }

  function setMuted(v) {
    muted = v;
    if (node) node.port.postMessage({ muted });
    ui.state(muted ? 'live' : 'listening', muted ? 'Muted. Tap the mark to unmute.' : undefined);
  }

  function cleanup() {
    flushTranscripts();
    stopPlayback();
    try { src && src.disconnect(); } catch {}
    try { node && node.disconnect(); } catch {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { ctx && ctx.close(); } catch {}
    ws = null; ctx = null; stream = null; node = null; src = null; callId = null;
  }

  function hangup() {
    const w = ws;
    if (w) { try { w.close(1000, 'bye'); } catch {} }
    else if (callId) { cleanup(); ui.ended('Call ended.'); }
  }

  function sendText(text) {
    if (!ws || ws.readyState !== 1) return false;
    heard = text;
    ui.add('You', text); log('you', text);
    stopPlayback();
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }));
    return true;
  }

  return { start, hangup, setMuted, sendText, isMuted: () => muted, active: () => !!callId };
})();

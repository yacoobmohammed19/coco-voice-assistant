// Coco Voice client: browser speech-to-text -> server -> browser text-to-speech, in a hands-free loop.
const $ = (id) => document.getElementById(id);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const params = new URLSearchParams(location.search);
let callbackJob = params.get('job');
let ringId = params.get('ring');

let callId = null, rec = null, state = 'idle', busy = false, silentRestarts = 0;
let liveAvailable = false;
let phoneInfo = null;
let callMode = (() => { try { return localStorage.getItem('coco_mode') || 'live'; } catch { return 'live'; } })();

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('login'); }
  return res.json();
}

// ---------- login ----------
function showLogin() { $('login').classList.remove('hidden'); $('stage').classList.add('hidden'); closeSettings(); }
async function showStage() {
  $('login').classList.add('hidden'); $('stage').classList.remove('hidden');
  const me = await api('/api/me');
  liveAvailable = !!me.live;
  $('modeSel').value = liveAvailable ? callMode : 'classic';
  $('modeSel').disabled = !liveAvailable;
  $('topic').textContent = me.ntfyTopic ? `${me.ntfyServer.replace('https://', '')}/${me.ntfyTopic}` : '(run setup)';
  if (me.persona) { voiceChoice = me.persona; store.set('coco_voice', voiceChoice); }
  voiceLocked = me.voiceLocked !== false;
  phoneInfo = me.phone;
  $('phoneInfo').textContent = phoneInfo ? (phoneInfo.via === 'Telegram' ? 'Coco rings you on Telegram, like a normal call. You can also call Coco on Telegram.' : `Coco calls you on ${phoneInfo.you} from ${phoneInfo.coco}.`) : 'Not connected yet: Coco can only reach you through the app and notifications.';
  $('btnPhoneMe').classList.toggle('hidden', !phoneInfo);
  $('presence').textContent = phoneInfo ? `Online · rings you on ${phoneInfo.via}` : liveAvailable ? 'Online · live calls' : 'Online';
  refreshJobs();
  if (callbackJob || ringId) showIncoming();
}

// ---------- incoming call (Coco calling you) ----------
async function showIncoming() {
  let why = '';
  try {
    if (ringId) why = (await api(`/api/ring/${ringId}`)).reason || '';
    else if (callbackJob) { const j = await api(`/api/jobs/${callbackJob}`); why = j.title ? `About: ${j.title}` : ''; }
  } catch {}
  $('incomingWhy').textContent = why;
  $('incoming').classList.remove('hidden');
}
function clearIncoming() {
  $('incoming').classList.add('hidden');
  history.replaceState(null, '', '/');
}
$('accept').onclick = () => {
  $('incoming').classList.add('hidden');
  beginCall(); // inside the tap, so audio + mic are allowed
};
$('decline').onclick = () => { callbackJob = null; ringId = null; clearIncoming(); };
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('unlock').disabled = true; $('loginErr').textContent = '';
  try {
    const r = await api('/api/login', { pin: $('pin').value });
    if (r.ok) { $('pin').blur(); await showStage(); } else $('loginErr').textContent = r.error || 'Wrong PIN';
  } catch (err) {
    $('loginErr').textContent = 'Could not reach Coco — is Tailscale on and the PC awake?';
  } finally {
    $('pin').value = ''; $('unlock').disabled = false;
  }
};
$('btnLogout').onclick = async () => { if (CocoLive.active()) CocoLive.hangup(); else hangup(); await api('/api/logout', {}); showLogin(); };
function openSettings() { $('settings').classList.remove('hidden'); $('sheetBg').classList.remove('hidden'); loadVoices(); }
function closeSettings() { $('settings').classList.add('hidden'); $('sheetBg').classList.add('hidden'); }
$('btnSettings').onclick = openSettings;
$('sheetBg').onclick = closeSettings;
$('btnPhoneMe').onclick = async () => {
  const r = await api('/api/phone/call', { reason: "This is the test call the owner asked for, to check that a real phone call works and sounds natural. Say hi and ask how you sound." });
  closeSettings();
  $('homeStatus').textContent = r.ok ? 'Calling your phone now… answer it like a normal call.' : (r.error || 'Could not place the call.');
};
$('btnRingMe').onclick = async () => {
  await api('/api/ring', { seconds: 30, reason: 'This is the test call you asked for from settings. Say hi and ask how it sounds.' });
  closeSettings();
  $('homeStatus').textContent = 'Coco will call you in 30 seconds. Lock your phone or switch apps to see it ring.';
};
$('modeSel').onchange = () => { callMode = $('modeSel').value; store.set('coco_mode', callMode); };
$('voiceSel').onchange = async () => {
  voiceChoice = $('voiceSel').value; store.set('coco_voice', voiceChoice); showVoiceNow();
  try { await api('/api/prefs', { persona: voiceChoice }); } catch {} // the PC uses this for phone calls too
};
$('voiceTest').onclick = () => {
  unlockAudio();
  speak("Hey, it's me. This is how I sound now. Pretty natural, right?").then(() => { if (!callId) setState('idle'); });
};

// ---------- voice out ----------
// Natural neural voices are synthesised on the PC (/api/tts) and played here. The phone's built-in
// voice is only a fallback if that fails.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
let voiceChoice = store.get('coco_voice') || 'jarvis';
if (!['jarvis', 'friday', 'mate', 'nova', 'atlas', 'kai'].includes(voiceChoice)) voiceChoice = 'jarvis';
let voiceList = null;
const player = new Audio();
player.playsInline = true;
let speakToken = 0;
const fillers = {};

async function loadVoices() {
  if (!voiceList) { try { const r = await api('/api/voices'); voiceList = r.voices; voiceEngine = r.engine; } catch { voiceList = []; } }
  if (!voiceList.some((v) => v.key === voiceChoice)) voiceChoice = 'jarvis';
  $('voiceSel').disabled = voiceLocked;
  const sel = $('voiceSel'); sel.innerHTML = '';
  for (const v of voiceList) sel.add(new Option(v.label, v.key));
  sel.value = voiceChoice;
  showVoiceNow();
}
let voiceEngine = '';
function showVoiceNow() {
  $('voiceNow').textContent = voiceLocked ? 'Locked to this voice everywhere: calls, Telegram and replies.'
    : voiceEngine === 'gemini' ? 'Natural Gemini studio voice.' : 'Natural Microsoft voice (Gemini not set up yet).';
}

// iOS only lets audio play after a tap; play a silent clip inside the tap to unlock the player for the call.
function silentWav() {
  const n = 800, b = new ArrayBuffer(44 + n), v = new DataView(b);
  const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
const SILENT = silentWav();
let voiceLocked = true;
function unlockAudio() {
  try { player.src = SILENT; player.play().catch(() => {}); } catch {}
  // iOS needs a real (non-empty) utterance inside the tap, or later fallback speech stays silent.
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {}
}

async function tts(text) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 16000);
  try {
    const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: voiceChoice }), signal: ctl.signal });
    if (!res.ok) throw new Error('tts ' + res.status);
    return URL.createObjectURL(await res.blob());
  } finally {
    clearTimeout(timer);
  }
}
function play(url, token) {
  return new Promise((resolve) => {
    if (token !== speakToken) return resolve(false);
    player.onended = () => resolve(true);
    player.onerror = () => resolve(false);
    player.src = url;
    player.play().catch(() => resolve(false));
  });
}
function stopSpeaking() {
  speakToken++;
  try { player.pause(); } catch {}
  try { speechSynthesis.cancel(); } catch {}
}

async function speak(text) {
  stopSpeaking();
  const token = ++speakToken;
  setState('speaking');
  // One request per reply: fewer calls keeps us well inside the voice service's limits.
  const url = await tts(text).catch(() => null);
  if (token !== speakToken) return;
  // Never switch to a different voice: if Jarvis can't speak right now, the reply stays as text.
  if (!url) { $('status').textContent = "Voice unavailable for a moment: reply shown as text."; return; }
  await play(url, token);
  URL.revokeObjectURL(url);
}

// Short human acknowledgements, pre-made per voice, played if a reply takes a moment.
const FILLERS = ['Mm-hm.', 'Okay, one sec.', 'Sure, give me a sec.', 'Right, let me check.', 'Got it, hang on.'];
function warmFillers() {
  if (fillers[voiceChoice]) return;
  fillers[voiceChoice] = FILLERS.map((f) => tts(f).catch(() => null));
}
async function playFiller() {
  const set = fillers[voiceChoice];
  if (!set) return;
  const url = await set[Math.floor(Math.random() * set.length)];
  if (!url || state !== 'thinking') return;
  await new Promise((resolve) => { player.onended = player.onerror = resolve; player.src = url; player.play().catch(resolve); });
}

const isLive = () => typeof CocoLive !== 'undefined' && CocoLive.active();
let timerInt = null, callStart = 0, wakeLock = null;
function syncCallUi() {
  const on = !!callId;
  if (on === document.body.classList.contains('oncall')) return;
  document.body.classList.toggle('oncall', on);
  if (on) {
    callStart = 0;
    $('timer').textContent = 'calling…';
    $('log').innerHTML = '';
    clearInterval(timerInt);
    timerInt = setInterval(() => {
      if (!callStart) return;
      const t = Math.floor((Date.now() - callStart) / 1000);
      $('timer').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    }, 500);
    try { navigator.wakeLock && navigator.wakeLock.request('screen').then((w) => { wakeLock = w; }).catch(() => {}); } catch {}
  } else {
    clearInterval(timerInt);
    stopRing();
    $('transcriptDrawer').classList.add('hidden'); $('typeDrawer').classList.add('hidden');
    $('btnTranscript').classList.remove('on'); $('btnType').classList.remove('on');
    setMuteUi(false);
    try { wakeLock && wakeLock.release(); } catch {}
    wakeLock = null;
  }
}
function setMuteUi(m) {
  $('btnMute').classList.toggle('on', m);
  $('muteIcon').setAttribute('href', m ? '#i-micoff' : '#i-mic');
  $('muteLabel').textContent = m ? 'Unmute' : 'Mute';
}

// Ringback tone while connecting, like a real outgoing call (UK-style double ring).
let ringCtx = null, ringTimer = null;
function startRing() {
  stopRing();
  try {
    ringCtx = new (window.AudioContext || window.webkitAudioContext)();
    const burst = () => {
      if (!ringCtx) return;
      const t = ringCtx.currentTime;
      const g = ringCtx.createGain(); g.gain.value = 0; g.connect(ringCtx.destination);
      for (const f of [400, 450]) { const o = ringCtx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(t); o.stop(t + 1.0); }
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.08, t + 0.02); g.gain.setValueAtTime(0.08, t + 0.4); g.gain.linearRampToValueAtTime(0, t + 0.42);
      g.gain.linearRampToValueAtTime(0.08, t + 0.62); g.gain.setValueAtTime(0.08, t + 1.0); g.gain.linearRampToValueAtTime(0, t + 1.02);
    };
    burst();
    ringTimer = setInterval(burst, 3000);
  } catch {}
}
function stopRing() {
  clearInterval(ringTimer); ringTimer = null;
  try { ringCtx && ringCtx.close(); } catch {}
  ringCtx = null;
}

function setState(s, label) {
  state = s;
  syncCallUi();
  if (callId && s !== 'thinking' && !callStart) { callStart = Date.now(); stopRing(); }
  $('orb').className = s;
  $('orbLabel').textContent = callId
    ? ({ listening: 'LISTENING', thinking: callStart ? 'THINKING' : '', speaking: 'SPEAKING', live: isLive() ? 'MUTED' : 'TAP TO TALK' }[s] || '')
    : '';
  const hints = isLive()
    ? { listening: 'Just talk, like a normal call', thinking: 'Working on it…', speaking: 'Talk any time to interrupt', live: 'Muted. Tap the mark to unmute.' }
    : { idle: 'Your assistant is standing by', listening: 'Go ahead, I\'m listening', thinking: 'Working on it…', speaking: 'Tap the mark to interrupt', live: 'Tap the mark to talk' };
  const text = label || hints[s] || '';
  if (callId) $('status').textContent = text; else $('homeStatus').textContent = label || '';
}

function addMsg(who, text) {
  const d = document.createElement('div');
  d.className = 'msg' + (who === 'You' ? ' you' : '');
  d.innerHTML = '<b></b><span></span>';
  d.querySelector('b').textContent = who; d.querySelector('span').textContent = text;
  $('log').appendChild(d); $('log').scrollTop = $('log').scrollHeight;
}

function listen() {
  if (!callId) return;
  if (!SR) { setState('live', 'Voice input not supported in this browser — type instead (use Chrome).'); return; }
  try { rec && rec.abort(); } catch {}
  rec = new SR();
  rec.lang = 'en-ZA';
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
    }
    $('status').textContent = interim || finalText || 'Listening…';
  };
  rec.onerror = (e) => { if (e.error === 'not-allowed') setState('live', 'Microphone blocked — allow mic access for this site.'); };
  rec.onend = () => {
    if (!callId || state !== 'listening') return;
    const t = finalText.trim();
    if (t) { silentRestarts = 0; send(t); }
    else if (++silentRestarts < 4) listen();
    else setState('live');
  };
  setState('listening');
  rec.start();
}

async function send(text) {
  if (busy) return;
  busy = true;
  addMsg('You', text);
  setState('thinking');
  let fillerDone = Promise.resolve();
  const fillerTimer = setTimeout(() => { fillerDone = playFiller(); }, 1300);
  try {
    const r = await api('/api/talk', { callId, text });
    clearTimeout(fillerTimer);
    await fillerDone;
    if (r.job || r.jobs) refreshJobs();
    addMsg('Coco', r.say);
    await speak(r.say);
    busy = false;
    if (r.hangup) return hangup();
    if (callId) listen();
  } catch (e) {
    clearTimeout(fillerTimer);
    busy = false;
    if (e.message !== 'login') { addMsg('Coco', 'Connection problem.'); setState('live'); }
  }
}

async function startCall() {
  unlockAudio(); // must happen inside the tap on iPhone
  warmFillers();
  $('log').innerHTML = '';
  callId = 'connecting';
  setState('thinking', '');
  startRing();
  const r = await api('/api/call/start', { jobId: callbackJob || undefined });
  callId = r.callId;
  if (callbackJob || ringId) { callbackJob = null; ringId = null; history.replaceState(null, '', '/'); }
  renderJobs(r.jobs);
  addMsg('Coco', r.say);
  await speak(r.say);
  listen();
}

function hangup() {
  callId = null;
  try { rec && rec.abort(); } catch {}
  stopSpeaking();
  setState('idle', 'Call ended.');
}

// ---------- live calls ----------
const liveUi = {
  state: (s, label) => setState(s, label),
  status: (t) => { $('status').textContent = t; },
  add: (who, text) => addMsg(who, text),
  jobs: () => refreshJobs(),
  ended: (msg) => { callId = null; setState('idle', msg); },
};
async function startLive() {
  stopSpeaking();
  callId = 'live';
  setState('thinking', '');
  startRing();
  const ctx = { jobId: callbackJob || undefined, ringId: ringId || undefined };
  callbackJob = null; ringId = null;
  history.replaceState(null, '', '/');
  try {
    await CocoLive.start({ persona: voiceChoice, ...ctx, onJobs: renderJobs, ui: liveUi });
  } catch (e) {
    callId = null;
    stopRing();
    if (e.message === 'login') return showLogin();
    if (e.name === 'NotAllowedError') return setState('idle', 'Microphone blocked: allow mic access for Coco, then try again.');
    setState('idle', 'Live call failed. Switch to Classic in Voice settings, or try again.');
  }
}

function beginCall() {
  if (callId) return;
  closeSettings();
  return liveAvailable && callMode === 'live' ? startLive() : startCall();
}
$('callBtn').onclick = () => beginCall();
$('msgBtn').onclick = async () => {
  await beginCall();
  $('typeDrawer').classList.remove('hidden'); $('btnType').classList.add('on');
  setTimeout(() => $('typed').focus(), 300);
};
function toggleMute() {
  if (CocoLive.active()) { CocoLive.setMuted(!CocoLive.isMuted()); setMuteUi(CocoLive.isMuted()); return; }
  // classic mode: mute = stop listening
  if (state === 'listening') { try { rec && rec.abort(); } catch {} setState('live'); setMuteUi(true); }
  else { setMuteUi(false); silentRestarts = 0; stopSpeaking(); listen(); }
}
$('btnMute').onclick = toggleMute;
$('btnType').onclick = () => {
  const show = $('typeDrawer').classList.toggle('hidden') === false;
  $('btnType').classList.toggle('on', show);
  $('transcriptDrawer').classList.add('hidden'); $('btnTranscript').classList.remove('on');
  if (show) setTimeout(() => $('typed').focus(), 100);
};
$('btnTranscript').onclick = () => {
  const show = $('transcriptDrawer').classList.toggle('hidden') === false;
  $('btnTranscript').classList.toggle('on', show);
  $('typeDrawer').classList.add('hidden'); $('btnType').classList.remove('on');
  if (show) $('log').scrollTop = $('log').scrollHeight;
};

$('orb').onclick = () => {
  if (!callId) return;
  if (CocoLive.active()) return toggleMute();
  if (state === 'speaking') { stopSpeaking(); return listen(); }
  if (state === 'live' || state === 'idle') { silentRestarts = 0; return listen(); }
  if (state === 'listening') { try { rec.stop(); } catch {} }
};
$('hangup').onclick = () => (CocoLive.active() ? CocoLive.hangup() : hangup());
$('typebar').onsubmit = async (e) => {
  e.preventDefault();
  const t = $('typed').value.trim(); if (!t) return;
  $('typed').value = '';
  if (CocoLive.active()) { CocoLive.sendText(t); return; }
  if (!callId) { await startCall(); }
  try { rec && rec.abort(); } catch {}
  stopSpeaking();
  state = 'thinking';
  send(t);
};

// ---------- jobs ----------
function renderJobs(list) {
  const box = $('jobs'); box.innerHTML = '';
  (list || []).forEach((j) => {
    const d = document.createElement('div'); d.className = 'job';
    d.innerHTML = '<div><span class="t"></span><span class="pill"></span></div><div class="s"></div>';
    d.querySelector('.t').textContent = j.title;
    const pill = d.querySelector('.pill'); pill.textContent = j.status.replace('_', ' '); pill.classList.add(j.status);
    d.querySelector('.s').textContent = j.summary || (j.tier === 'confirm' ? 'Needs your go-ahead (changes things).' : '');
    if (j.status === 'awaiting_confirm') {
      const acts = document.createElement('div'); acts.className = 'acts';
      const ok = document.createElement('button'); ok.className = 'ok'; ok.textContent = 'Approve';
      const no = document.createElement('button'); no.className = 'no'; no.textContent = 'Cancel';
      ok.onclick = async () => { await api(`/api/jobs/${j.id}/confirm`, {}); refreshJobs(); };
      no.onclick = async () => { await api(`/api/jobs/${j.id}/cancel`, {}); refreshJobs(); };
      acts.append(ok, no); d.appendChild(acts);
    }
    box.appendChild(d);
  });
  if (!box.children.length) box.innerHTML = '<div class="empty">No jobs yet. Ask Coco to do something.</div>';
}
async function refreshJobs() { try { renderJobs((await api('/api/jobs')).jobs.slice(0, 8)); } catch {} }
setInterval(() => { if (!$('stage').classList.contains('hidden')) refreshJobs(); }, 15000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
api('/api/me').then((r) => r.ok && showStage()).catch(() => {});

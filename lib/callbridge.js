// One live voice call bridged to Gemini Live on this PC: the same tools, rules and logging whether
// the audio comes from Twilio (phone network) or the Telegram helper. The carrier-specific part is
// just the audio codec, passed in as `codec`.
//
// Stream protocol (JSON text frames, Twilio-compatible):
//   in:  {event:'start', start:{streamSid, ...}} | {event:'media', media:{payload}} | {event:'mark', mark:{name}} | {event:'stop'}
//   out: {event:'media', streamSid, media:{payload}} | {event:'clear', streamSid} | {event:'mark', streamSid, mark:{name}}
const live = require('./live');
const usage = require('./usage');

function bridge(sock, { cfg, hooks, codec, resolveStart, label }) {
  let streamSid = null, gem = null, callId = null, heard = '', saidBuf = '', heardBuf = '', ending = false, markN = 0, done = false;
  let liveSince = 0, wrapTimer = null, capTimer = null, callUsd = 0, budgetOut = false;
  // Bill-relevant minutes are counted once, when the Gemini side closes.
  const countMinutes = () => {
    clearTimeout(wrapTimer); clearTimeout(capTimer);
    if (liveSince) {
      usage.add('liveMinutes', (Date.now() - liveSince) / 60_000); liveSince = 0;
      if (callId) hooks.log(callId, 'Call', `Gemini cost ~$${callUsd.toFixed(3)}`);
    }
  };
  const pendingMarks = new Set();

  const flush = () => {
    if (!callId) return;
    if (heardBuf.trim()) { hooks.log(callId, 'Owner', heardBuf.trim()); heardBuf = ''; }
    if (saidBuf.trim()) { hooks.log(callId, 'Coco', saidBuf.trim()); saidBuf = ''; }
  };
  const finish = () => {
    if (done) return;
    done = true;
    flush();
    try { gem && gem.close(); } catch {}
    try { sock.close(); } catch {}
    countMinutes();
  };
  const sendMark = (name) => { pendingMarks.add(name); sock.send(JSON.stringify({ event: 'mark', streamSid, mark: { name } })); };

  sock.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.event === 'start') {
      const info = resolveStart(m);
      if (!info) { console.error(`[${label}] stream rejected`); return sock.close(1008); }
      streamSid = (m.start && m.start.streamSid) || 'local';
      callId = hooks.newCall();
      hooks.log(callId, 'Call', `${label} call (${info.direction}) connected`);
      if (!usage.liveOk(cfg)) {
        hooks.log(callId, 'Call', 'Daily voice-call budget used up; call refused');
        if (hooks.notice) hooks.notice("Today's voice-call budget is used up, so I couldn't take the call. Text me here instead.");
        return finish();
      }
      const maxMin = Math.min(cfg.liveMaxMinutes || 30, usage.liveLeft(cfg));
      const wrapUp = () => { try { gem.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: '(System: the call time limit is in one minute. Finish the current point, say a short goodbye, then use end_call.)' }] }], turnComplete: true } })); } catch {} };
      gem = new WebSocket(`${live.SERVER_WS_URL}?key=${encodeURIComponent(cfg.geminiApiKey)}`);
      gem.onopen = () => {
        liveSince = Date.now();
        gem.send(JSON.stringify({ setup: live.setupFor(cfg.persona, hooks.recent && hooks.recent(callId), hooks.memory && hooks.memory()) }));
        // A minute before the cap Coco is told to wrap up; at the cap the call ends regardless.
        wrapTimer = setTimeout(wrapUp, Math.max(0, maxMin - 1) * 60_000);
        capTimer = setTimeout(() => { hooks.log(callId, 'Call', 'Call time limit reached'); finish(); }, maxMin * 60_000);
      };
      gem.onmessage = async (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : Buffer.from(await ev.data.arrayBuffer()).toString();
        let g; try { g = JSON.parse(text); } catch { return; }
        if (g.setupComplete) gem.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: info.kickoff }] }], turnComplete: true } }));
        if (g.toolCall) {
          flush();
          Promise.all((g.toolCall.functionCalls || []).map(async (c) => {
            if (c.name === 'end_call') ending = true;
            let response;
            try { response = await hooks.tool(callId, c.name, c.args || {}, heard); } catch (e) { response = { error: e.message }; }
            return { id: c.id, name: c.name, response };
          })).then((responses) => {
            try { gem.send(JSON.stringify({ toolResponse: { functionResponses: responses } })); } catch {}
            if (ending) setTimeout(() => { if (!pendingMarks.size) finish(); }, 6000);
          });
        }
        if (g.goAway) hooks.log(callId, 'Call', 'Gemini session ending soon');
        if (g.usageMetadata) {
          callUsd += usage.addLive(cfg, g.usageMetadata);
          // Today's share of the budget is spent: one minute to wrap up, then hang up.
          if (!budgetOut && !usage.liveOk(cfg)) {
            budgetOut = true;
            clearTimeout(wrapTimer); clearTimeout(capTimer);
            wrapUp();
            capTimer = setTimeout(() => { hooks.log(callId, 'Call', "Today's voice budget reached"); finish(); }, 60_000);
          }
        }
        const sc = g.serverContent;
        if (!sc) return;
        if (sc.interrupted) { sock.send(JSON.stringify({ event: 'clear', streamSid })); pendingMarks.clear(); }
        if (sc.inputTranscription && sc.inputTranscription.text) {
          if (saidBuf.trim()) { hooks.log(callId, 'Coco', saidBuf.trim()); saidBuf = ''; }
          heardBuf += sc.inputTranscription.text; heard = heardBuf.trim() || heard;
        }
        if (sc.outputTranscription && sc.outputTranscription.text) {
          if (heardBuf.trim()) { hooks.log(callId, 'Owner', heardBuf.trim()); heardBuf = ''; }
          saidBuf += sc.outputTranscription.text;
        }
        if (sc.modelTurn && sc.modelTurn.parts) {
          for (const p of sc.modelTurn.parts) {
            if (!p.inlineData || !p.inlineData.data) continue;
            const rate = Number(((p.inlineData.mimeType || '').match(/rate=(\d+)/) || [])[1]) || 24000;
            for (const payload of codec.encode(Buffer.from(p.inlineData.data, 'base64'), rate)) {
              sock.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
            }
          }
        }
        if (sc.turnComplete) { flush(); if (ending) sendMark(`end-${++markN}`); }
      };
      gem.onclose = (e) => { if (e.code !== 1000) console.error(`[${label}] gemini closed`, e.code, e.reason); countMinutes(); finish(); };
      gem.onerror = () => {};
    } else if (m.event === 'media' && gem && gem.readyState === 1) {
      const pcm = codec.decode(Buffer.from(m.media.payload, 'base64'));
      gem.send(JSON.stringify({ realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
    } else if (m.event === 'mark') {
      pendingMarks.delete(m.mark && m.mark.name);
      if (ending && !pendingMarks.size) finish(); // goodbye has finished playing
    } else if (m.event === 'stop') {
      finish();
    }
  });
  sock.on('close', () => {
    flush();
    try { gem && gem.close(); } catch {}
    countMinutes();
    if (callId) hooks.log(callId, 'Call', `${label} call ended`);
  });
}

module.exports = { bridge };

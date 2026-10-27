"""Coco's Telegram calling helper.

Logs in as COCO's own Telegram account and makes/answers real Telegram voice calls, which ring on
The owner's iPhone like a normal call (lock screen, swipe to answer). Call audio is streamed to the Coco
server on this PC (127.0.0.1 only), which runs the conversation with Gemini Live and Coco's tools.

  python coco_tg.py login   one-time: link Coco's Telegram account (you type the login code yourself)
  python coco_tg.py run     the service (Coco's server starts this automatically)
"""
import asyncio
import warnings
warnings.filterwarnings('ignore', category=DeprecationWarning)
import audioop  # stdlib on Python 3.11; used for resampling
import base64
import json
import os
import random
import sys
import time
from pathlib import Path

DATA = Path(os.environ.get('COCO_VOICE_DATA') or Path.home() / '.coco-voice')
CONFIG = DATA / 'config.json'
STATE = DATA / 'telegram.json'
SESSION = DATA / 'telegram'  # Telethon adds .session

TG_RATE = 48000          # Telegram side: 48 kHz mono PCM16
TO_COCO_RATE = 16000     # what Gemini listens to
FROM_COCO_RATE = 24000   # what Gemini speaks
FRAME_BYTES = TG_RATE * 2 // 100  # 10 ms


def load(path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default if default is not None else {}


def save_config(updates):
    cfg = load(CONFIG)
    cfg.update(updates)
    CONFIG.write_text(json.dumps(cfg, indent=2), encoding='utf-8')


def e164(n):
    d = ''.join(ch for ch in str(n) if ch.isdigit() or ch == '+')
    if d.startswith('0'):
        d = '+27' + d[1:]
    if not d.startswith('+'):
        d = '+' + d
    return d


# --------------------------------------------------------------------------- login
async def login():
    from telethon import TelegramClient, events
    from telethon.tl.functions.contacts import ImportContactsRequest
    from telethon.tl.types import InputPhoneContact

    cfg = load(CONFIG)
    print('\n=== Link Coco\'s Telegram account ===\n')
    print('1. On a browser, log in to https://my.telegram.org with COCO\'s number (not your personal one).')
    print('2. Click "API development tools", create an app (any name, e.g. "Coco"), and copy api_id and api_hash.\n')
    api_id = input(f"api_id [{cfg.get('tgApiId') or ''}]: ").strip() or cfg.get('tgApiId')
    api_hash = input(f"api_hash [{'saved' if cfg.get('tgApiHash') else ''}]: ").strip() or cfg.get('tgApiHash')
    coco_number = e164(input("Coco's Telegram number (E.164, e.g. +27...): ").strip())
    owner = e164(cfg.get('ownerNumber') or input("Your own mobile number (E.164): ").strip())
    save_config({'tgApiId': str(api_id), 'tgApiHash': api_hash})

    client = TelegramClient(str(SESSION), int(api_id), api_hash)
    print('\nTelegram will send a login code to Coco\'s Telegram app (or by SMS). Type it below.')
    await client.start(phone=coco_number)  # prompts for code (and 2FA password if set) in this window
    me = await client.get_me()
    print(f'\nLogged in as {me.first_name} ({coco_number}).')

    owner_id = None
    try:
        res = await client(ImportContactsRequest([InputPhoneContact(client_id=random.randrange(2**62), phone=owner, first_name='Owner', last_name='')]))
        if res.users:
            owner_id = res.users[0].id
    except Exception as e:  # privacy settings can block lookup by number
        print('Lookup by number failed:', e)
    if not owner_id:
        print(f'\nCould not find {owner} by number. From YOUR personal Telegram, send the word  coco  to Coco\'s account now...')
        got = asyncio.get_event_loop().create_future()

        @client.on(events.NewMessage(incoming=True, pattern=r'(?i)^\s*coco\s*$'))
        async def _(ev):
            if ev.is_private and not got.done():
                got.set_result(ev.sender_id)
        owner_id = await asyncio.wait_for(got, timeout=300)
    STATE.write_text(json.dumps({'ownerId': owner_id, 'cocoNumber': coco_number}), encoding='utf-8')
    print(f'Linked: Coco will ring your Telegram (user {owner_id}) and only accept calls from you.')
    await client.disconnect()


# --------------------------------------------------------------------------- service
class Call:
    """One live Telegram call bridged to the Coco server."""

    def __init__(self, svc, chat_id, ref):
        self.svc, self.chat_id, self.ref = svc, chat_id, ref
        self.ws = None
        self.out = bytearray()
        self.sent_total = 0
        self.queued_total = 0
        self.marks = []
        self.in_state = None
        self.out_state = None
        self.in_buf = bytearray()
        self.alive = True

    async def run(self):
        import websockets
        cfg = self.svc.cfg
        url = f"ws://127.0.0.1:{cfg.get('tgPort', 8789)}/tg/stream"
        async with websockets.connect(url, max_size=None) as ws:
            self.ws = ws
            await ws.send(json.dumps({'event': 'start', 'start': {'streamSid': f'tg-{self.chat_id}', 'ref': self.ref, 'secret': cfg['sidecarSecret']}}))
            sender = asyncio.create_task(self.pump_out())
            try:
                async for raw in ws:
                    m = json.loads(raw)
                    ev = m.get('event')
                    if ev == 'media':
                        pcm = base64.b64decode(m['media']['payload'])
                        up, self.out_state = audioop.ratecv(pcm, 2, 1, FROM_COCO_RATE, TG_RATE, self.out_state)
                        self.out += up
                        self.queued_total += len(up)
                    elif ev == 'clear':  # The owner interrupted: drop what Coco hadn't said yet
                        self.queued_total -= len(self.out)
                        self.out.clear()
                        self.marks.clear()
                    elif ev == 'mark':
                        self.marks.append((self.queued_total, m['mark']['name']))
            finally:
                self.alive = False
                sender.cancel()
        await self.svc.hangup(self)

    async def pump_out(self):
        """Feed Coco's voice to Telegram in real time, 10 ms at a time (silence when quiet)."""
        from pytgcalls.types import Device
        silence = bytes(FRAME_BYTES)
        nxt = time.monotonic()
        while self.alive:
            chunk = bytes(self.out[:FRAME_BYTES])
            del self.out[:FRAME_BYTES]
            if len(chunk) < FRAME_BYTES:
                chunk += silence[: FRAME_BYTES - len(chunk)]
            else:
                self.sent_total += FRAME_BYTES
            try:
                await self.svc.calls.send_frame(self.chat_id, Device.MICROPHONE, chunk)
            except Exception:
                pass
            while self.marks and self.sent_total >= self.marks[0][0]:
                _, name = self.marks.pop(0)
                try:
                    await self.ws.send(json.dumps({'event': 'mark', 'mark': {'name': name}}))
                except Exception:
                    pass
            nxt += 0.01
            await asyncio.sleep(max(0, nxt - time.monotonic()))

    async def incoming(self, frame):
        """The owner's voice from Telegram -> 16 kHz for Gemini, sent in ~40 ms pieces."""
        if not self.ws or not self.alive:
            return
        down, self.in_state = audioop.ratecv(frame, 2, 1, TG_RATE, TO_COCO_RATE, self.in_state)
        self.in_buf += down
        if len(self.in_buf) >= 1280:
            data = bytes(self.in_buf)
            self.in_buf.clear()
            try:
                await self.ws.send(json.dumps({'event': 'media', 'media': {'payload': base64.b64encode(data).decode()}}))
            except Exception:
                pass

    async def end(self):
        self.alive = False
        if self.ws:
            try:
                await self.ws.send(json.dumps({'event': 'stop'}))
                await self.ws.close()
            except Exception:
                pass


class Service:
    def __init__(self):
        self.cfg = load(CONFIG)
        self.state = load(STATE)
        self.owner_id = self.state.get('ownerId')
        self.call = None
        self.control = None
        self.client = None
        self.pending = {}  # chat message id -> future for Coco's reply
        self.albums = {}   # grouped_id -> list of messages (photos sent together)

    async def status(self, text):
        print(text, flush=True)
        if self.control:
            try:
                await self.control.send(json.dumps({'type': 'status', 'text': text}))
            except Exception:
                pass

    async def start_audio(self, chat_id, ring_seconds=None):
        from pytgcalls.types import ExternalMedia, MediaStream, RecordStream
        from pytgcalls.types.calls.call_config import CallConfig
        from pytgcalls.types.raw import AudioParameters
        params = AudioParameters(bitrate=TG_RATE, channels=1)
        stream = MediaStream(ExternalMedia.AUDIO, params, video_flags=MediaStream.Flags.IGNORE)
        config = CallConfig(timeout=ring_seconds) if ring_seconds else None
        await self.calls.play(chat_id, stream, config)  # outgoing: rings him; incoming: answers
        await self.calls.record(chat_id, RecordStream(True, params))

    async def place_call(self, ref):
        if self.call:
            return await self.status('busy: already on a call')
        if not self.owner_id:
            return await self.status('no owner linked; run: python coco_tg.py login')
        call = Call(self, self.owner_id, ref)
        self.call = call
        await self.status('ringing the owner on Telegram')
        try:
            await asyncio.wait_for(self.start_audio(self.owner_id, ring_seconds=45), timeout=75)
        except Exception as e:
            self.call = None
            await self.status(f'call not answered ({type(e).__name__}: {e})')
            if self.control:
                await self.control.send(json.dumps({'type': 'missed', 'ref': ref}))
            return
        await self.status('the owner answered')
        asyncio.create_task(call.run())

    async def hangup(self, call):
        if self.call is not call:
            return
        self.call = None
        try:
            await self.calls.leave_call(call.chat_id)
        except Exception:
            pass
        await self.status('call ended')

    async def control_loop(self):
        import websockets
        url = f"ws://127.0.0.1:{self.cfg.get('tgPort', 8789)}/tg/control"
        while True:
            try:
                async with websockets.connect(url) as ws:
                    await ws.send(json.dumps({'type': 'auth', 'secret': self.cfg['sidecarSecret']}))
                    self.control = ws
                    async for raw in ws:
                        m = json.loads(raw)
                        t = m.get('type')
                        if t == 'call':
                            asyncio.create_task(self.place_call(m['ref']))
                        elif t == 'reply':
                            fut = self.pending.get(m.get('id'))
                            if fut and not fut.done():
                                fut.set_result(m.get('text') or '')
                            # A message that carried a secret (/key ...): remove it from the chat for both sides.
                            if m.get('delete') and self.owner_id and str(m.get('id', '')).startswith('m'):
                                asyncio.create_task(self.client.delete_messages(self.owner_id, [int(m['id'][1:])], revoke=True))
                        elif t == 'send' and self.owner_id:
                            asyncio.create_task(self.send_text(m.get('text') or '', bool(m.get('html'))))
                        elif t == 'send_file' and self.owner_id:
                            asyncio.create_task(self.send_file(m.get('path'), m.get('caption') or ''))
            except Exception as e:
                print('control link down:', e, flush=True)
            self.control = None
            await asyncio.sleep(3)

    async def send_file(self, path, caption=''):
        # Node already checked the path (vault/outbox only, no secrets); send it as a document.
        try:
            await self.client.send_file(self.owner_id, path, caption=caption[:1000], force_document=True)
        except Exception as e:
            await self.status(f'could not send file {os.path.basename(str(path))}: {e}')

    async def send_text(self, text, html=False):
        await self.send_to(self.owner_id, text, html)

    async def send_to(self, chat, text, html=False):
        # Split on paragraph breaks so HTML tags are never cut in half; Telegram's limit is 4096.
        parts, cur = [], ''
        for para in text.split('\n\n'):
            if cur and len(cur) + len(para) + 2 > 3800:
                parts.append(cur); cur = ''
            cur = f'{cur}\n\n{para}' if cur else para
        if cur:
            parts.append(cur)
        for part in parts:
            for i in range(0, len(part), 4000):
                chunk = part[i:i + 4000]
                try:
                    await self.client.send_message(chat, chunk, link_preview=False, parse_mode='html' if html else None)
                except Exception:
                    if not html:
                        raise
                    import html as _h, re as _re
                    await self.client.send_message(chat, _h.unescape(_re.sub(r'<[^>]+>', '', chunk)), link_preview=False, parse_mode=None)

    async def on_chat(self, ev):
        """A Telegram message from the owner: forward to Coco, show 'typing', send the reply."""
        msg = ev.message
        if not self.control:
            return await ev.reply("My brain on the PC is offline right now (is it asleep?). Try again in a bit.")
        mid = f'm{msg.id}'
        fut = asyncio.get_running_loop().create_future()
        self.pending[mid] = fut
        text = ''
        try:
            async with self.client.action(ev.chat_id, 'typing'):
                if msg.voice or msg.video_note:
                    data = await msg.download_media(file=bytes)
                    payload = {'type': 'voice', 'id': mid, 'mime': (msg.file.mime_type if msg.file else 'audio/ogg'), 'data': base64.b64encode(data).decode()}
                elif msg.media and msg.file:
                    if msg.file.size and msg.file.size > 20 * 1024 * 1024:
                        return await ev.reply("That file's over 20 MB, too big for me. Drop it in Drive and send me the link?")
                    data = await msg.download_media(file=bytes)
                    name = msg.file.name or f'telegram-{msg.id}{msg.file.ext or ""}'
                    payload = {'type': 'file', 'id': mid, 'name': name, 'mime': msg.file.mime_type, 'caption': msg.raw_text or '', 'data': base64.b64encode(data).decode()}
                elif msg.raw_text:
                    payload = {'type': 'chat', 'id': mid, 'text': msg.raw_text}
                else:
                    return
                await self.control.send(json.dumps(payload))
                text = await asyncio.wait_for(fut, timeout=180)
        except asyncio.TimeoutError:
            text = 'Sorry, that took too long on my side. Try again?'
        except Exception as e:
            print('chat error:', e, flush=True)
            text = 'Something went wrong on my side. Try again?'
        finally:
            self.pending.pop(mid, None)
        if text:
            await self.send_to(ev.chat_id, text, True)

    async def on_album(self, events_):
        if not events_:
            return
        first = events_[0]
        if not self.control:
            return await first.reply("My brain on the PC is offline right now (is it asleep?). Try again in a bit.")
        mid = f'm{first.message.id}'
        fut = asyncio.get_running_loop().create_future()
        self.pending[mid] = fut
        text = ''
        try:
            async with self.client.action(first.chat_id, 'typing'):
                files = []
                caption = ' '.join(e.message.raw_text for e in events_ if e.message.raw_text)
                for e in events_:
                    m = e.message
                    if not (m.media and m.file) or (m.file.size and m.file.size > 20 * 1024 * 1024):
                        continue
                    data = await m.download_media(file=bytes)
                    files.append({'name': m.file.name or f'telegram-{m.id}{m.file.ext or ""}', 'mime': m.file.mime_type, 'data': base64.b64encode(data).decode()})
                await self.control.send(json.dumps({'type': 'files', 'id': mid, 'caption': caption, 'files': files}))
                text = await asyncio.wait_for(fut, timeout=180)
        except asyncio.TimeoutError:
            text = 'Sorry, that took too long on my side. Try again?'
        except Exception as e:
            print('album error:', e, flush=True)
            text = 'Something went wrong on my side. Try again?'
        finally:
            self.pending.pop(mid, None)
        if text:
            await self.send_to(first.chat_id, text, True)

    async def main(self):
        from telethon import TelegramClient
        from pytgcalls import PyTgCalls, filters as fl
        from pytgcalls.types import ChatUpdate, Device, Direction, StreamFrames

        if not (self.cfg.get('tgApiId') and self.cfg.get('tgApiHash')):
            sys.exit('Telegram not linked yet: python coco_tg.py login')
        from telethon import events
        client = TelegramClient(str(SESSION), int(self.cfg['tgApiId']), self.cfg['tgApiHash'])
        await client.connect()
        if not await client.is_user_authorized():
            sys.exit('Telegram session expired: python coco_tg.py login')
        self.client = client

        @client.on(events.NewMessage(incoming=True))
        async def on_message(ev):
            # Only the owner's private chat. Everyone else is ignored completely (no replies, no read receipts).
            if ev.is_private and self.owner_id and ev.sender_id == self.owner_id:
                gid = ev.message.grouped_id
                if not gid:
                    asyncio.create_task(self.on_chat(ev))
                elif gid not in self.albums:
                    # Photos sent together arrive as separate messages: gather them for a moment, then
                    # hand them to Coco as one batch so there's one reply, not one per photo.
                    self.albums[gid] = [ev]
                    async def flush(g=gid):
                        await asyncio.sleep(1.5)
                        await self.on_album(self.albums.pop(g, []))
                    asyncio.create_task(flush())
                else:
                    self.albums[gid].append(ev)
        self.calls = PyTgCalls(client)

        @self.calls.on_update(fl.stream_frame(Direction.INCOMING, Device.MICROPHONE))
        async def on_frames(_, update: StreamFrames):
            c = self.call
            if c and update.chat_id == c.chat_id:
                for f in update.frames:
                    await c.incoming(f.frame)

        @self.calls.on_update(fl.chat_update(ChatUpdate.Status.INCOMING_CALL))
        async def on_incoming(_, update: ChatUpdate):
            if update.chat_id != self.owner_id or self.call:
                await self.status(f'declined a call from {update.chat_id}')
                try:
                    await self.calls.leave_call(update.chat_id)
                except Exception:
                    pass
                return
            call = Call(self, update.chat_id, 'inbound')
            self.call = call
            await self.start_audio(update.chat_id)
            await self.status('answered a call from the owner')
            asyncio.create_task(call.run())

        @self.calls.on_update()
        async def on_any(_, update):
            # Hang-ups / busy / declined end the bridge.
            c = self.call
            if c and isinstance(update, ChatUpdate) and update.chat_id == c.chat_id:
                name = str(update.status).upper()
                if any(k in name for k in ('DISCARD', 'LEFT', 'BUSY', 'KICK', 'CLOSED')):
                    await c.end()
                    self.call = None

        # Relay-only audio: direct phone-to-PC (P2P) routes can reach "CONNECTED" but carry no sound
        # (every frame from the phone is pure silence), so the phone hangs up. Telegram's relay servers
        # give one known-good route. Set "tgAllowP2P": true in config.json to undo.
        self.calls._binding = RelayOnly(self.calls._binding, bool(self.cfg.get('tgAllowP2P')))
        await self.calls.start()
        me = await client.get_me()
        await self.status(f'ready as {me.first_name}; owner {self.owner_id}')

        async def watchdog():
            # Telethon can give up reconnecting and sit there dead. If Telegram has been unreachable
            # for 2 minutes, exit so Coco's server starts a fresh helper.
            down = 0
            while True:
                await asyncio.sleep(30)
                ok = client.is_connected()
                down = 0 if ok else down + 30
                # Heartbeat: tells Coco's server whether Telegram itself is reachable, not just this process.
                if self.control:
                    try:
                        await self.control.send(json.dumps({'type': 'health', 'ok': ok}))
                    except Exception:
                        pass
                if down >= 120:
                    print('Telegram connection lost for 2 minutes; restarting helper', flush=True)
                    hard_exit(3)
        asyncio.create_task(watchdog())
        await self.control_loop()


class RelayOnly:
    """Wraps the NTgCalls binding so calls use Telegram's relays, and logs what each call negotiated."""

    def __init__(self, binding, allow_p2p):
        self._b, self._allow = binding, allow_p2p

    def __getattr__(self, name):
        return getattr(self._b, name)

    def get_protocol(self):
        p = self._b.get_protocol()
        if not self._allow:
            p.udp_p2p = False
        return p

    async def connect_p2p(self, chat_id, servers, versions, p2p_allowed, custom_parameters):
        relays = sum(1 for s in servers if s.turn or s.peer_tag)
        use_p2p = bool(p2p_allowed and (self._allow or not relays))  # no relays offered: P2P is all there is
        print(f'call setup {chat_id}: versions {list(versions)}, {len(servers)} servers ({relays} relays), '
              f'p2p offered {p2p_allowed}, using {"p2p" if use_p2p else "relay only"}', flush=True)
        return await self._b.connect_p2p(chat_id, servers, versions, use_p2p, custom_parameters)


def hard_exit(code):
    # os._exit can hang on Windows while native call-library threads shut down; terminate outright.
    try:
        import ctypes
        k = ctypes.windll.kernel32
        k.TerminateProcess(k.GetCurrentProcess(), code)
    except Exception:
        pass
    os._exit(code)


def exit_with_parent():
    """Exit as soon as the Coco server that started us is gone, so a restart never leaves two
    helpers sharing one Telegram login."""
    import ctypes
    import threading
    pid = int(os.environ.get('COCO_PARENT_PID') or 0)
    if not pid:
        return
    def wait():
        h = ctypes.windll.kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not h:
            os._exit(0)
        ctypes.windll.kernel32.WaitForSingleObject(h, 0xFFFFFFFF)
        os._exit(0)
    threading.Thread(target=wait, daemon=True).start()


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'run'
    if mode == 'run':
        exit_with_parent()
    if mode == 'login':
        asyncio.run(login())
    else:
        asyncio.run(Service().main())

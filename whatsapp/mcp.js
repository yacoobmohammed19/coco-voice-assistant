// MCP server (stdio) giving Coco's worker WhatsApp access through the local bridge.
// Read, search and STAGE only: there is deliberately no send tool. A staged message goes out only
// when the owner replies "release <code>" to Coco on Telegram.
// Slow or flaky connections: give each connection attempt 2.5s (Node's default 250ms fails on a sluggish line).
require('net').setDefaultAutoSelectFamilyAttemptTimeout(2500);
const readline = require('readline');
const config = require('../lib/config');

const cfg = config.load();
const BASE = `http://127.0.0.1:${cfg.waPort || 8790}`;

async function api(pathname, params, method = 'GET', payload) {
  const url = new URL(pathname, BASE);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method, headers: { 'x-coco-secret': cfg.sidecarSecret, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(30000),
  }).catch(() => null);
  if (!res) return { error: 'The WhatsApp bridge is not running (Coco server down?).' };
  return res.json();
}

const S = (description) => ({ type: 'string', description });
const N = (description) => ({ type: 'number', description });
const TOOLS = [
  { name: 'whatsapp_status', description: "Is Coco linked to the owner's WhatsApp, and how many chats/messages are stored.", inputSchema: { type: 'object', properties: {} },
    run: () => api('/status') },
  { name: 'whatsapp_list_chats', description: 'List WhatsApp chats (most recent first), optionally filtered by name or phone number.', inputSchema: { type: 'object', properties: { query: S('Name or number to filter by (optional)'), limit: N('Max chats, default 40') } },
    run: (a) => api('/chats', { q: a.query, limit: a.limit }) },
  { name: 'whatsapp_read_chat', description: 'Read messages from one chat (by name, number or jid), oldest to newest.', inputSchema: { type: 'object', properties: { chat: S('Chat name, phone number or jid'), limit: N('Most recent N messages, default 50'), since: S('Only messages after this ISO date/time (optional)') }, required: ['chat'] },
    run: (a) => api('/messages', { chat: a.chat, limit: a.limit, since: a.since }) },
  { name: 'whatsapp_search', description: 'Search all WhatsApp messages for text (case-insensitive), newest first.', inputSchema: { type: 'object', properties: { query: S('Text to find'), limit: N('Max results, default 30') }, required: ['query'] },
    run: (a) => api('/search', { q: a.query, limit: a.limit }) },
  { name: 'whatsapp_since', description: 'All messages across all chats since a time, grouped by chat (for summaries and vault updates).', inputSchema: { type: 'object', properties: { since: S('ISO date/time; default the last 24 hours'), per_chat: N('Max messages per chat, default 200') } },
    run: (a) => api('/since', { since: a.since, per_chat: a.per_chat }) },
  { name: 'whatsapp_stage_message', description: "Draft a WhatsApp message for the owner to approve. It is NOT sent: you get a code, and it only goes out when the owner replies \"release <code>\" to Coco on Telegram. Always tell him the code.", inputSchema: { type: 'object', properties: { to: S('Chat name, phone number or jid'), text: S('The message text, written as the owner') }, required: ['to', 'text'] },
    run: (a) => api('/stage', null, 'POST', { to: a.to, text: a.text }) },
];

if (process.env.COCO_ALLOW_SEND === '1') {
  TOOLS.push({ name: 'whatsapp_send', description: 'Send a WhatsApp message as the owner, right now. Only use it when the owner asked you to send/message/reply to this person in this task.', inputSchema: { type: 'object', properties: { to: S('Chat name, phone number or jid'), text: S('The message, written as the owner') }, required: ['to', 'text'] },
    run: (a) => api('/send', null, 'POST', { to: a.to, text: a.text }) });
}
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined) return; // notifications
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'coco-whatsapp', version: '1.0.0' } } });
    }
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool' } });
      const out = await tool.run(params.arguments || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], isError: !!out?.error } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    return send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
  }
});

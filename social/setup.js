// One-time connection of CocoCorp's Facebook Page + Instagram to Coco.
//   node social/setup.js                      (asks for everything)
//   node social/setup.js --app-id X --app-secret Y --token Z [--page CocoCorp]
// Turns the short-lived Graph API Explorer token into a long-lived one, then takes the Page token
// from it (Page tokens made this way never expire) and finds the linked Instagram business account.
// Saves to ~/.coco-voice/social.json. The secret and tokens are never printed.
require('net').setDefaultAutoSelectFamilyAttemptTimeout(2500);
const fs = require('fs');
const readline = require('readline');
const { SOCIAL_FILE } = require('./meta');

const VERSION = 'v23.0';
const G = `https://graph.facebook.com/${VERSION}`;
const NEEDED = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement', 'pages_read_user_content', 'read_insights', 'business_management', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights'];

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

async function get(pathname, params) {
  const url = new URL(`${G}/${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const out = await (await fetch(url)).json();
  if (out.error) throw new Error(out.error.message);
  return out;
}

(async () => {
  const old = (() => { try { return JSON.parse(fs.readFileSync(SOCIAL_FILE, 'utf8')); } catch { return {}; } })();
  const appId = arg('app-id') || (await ask(`Meta App ID${old.appId ? ` [${old.appId}]` : ''}: `)) || old.appId;
  const appSecret = arg('app-secret') || (await ask('App Secret (App settings > Basic)' + (old.appSecret ? ' [keep saved]' : '') + ': ')) || old.appSecret;
  const shortToken = arg('token') || (await ask('User access token from Graph API Explorer: '));
  if (!appId || !appSecret || !shortToken) throw new Error('App ID, App Secret and a token are all needed.');

  const { access_token: userToken } = await get('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: shortToken });
  const dbg = (await get('debug_token', { input_token: userToken, access_token: `${appId}|${appSecret}` })).data;
  const missing = NEEDED.filter((p) => !(dbg.scopes || []).includes(p));
  if (missing.length) console.log(`\n⚠  The token is missing these permissions: ${missing.join(', ')}\n   Add them in Graph API Explorer and generate a new token, or some features won't work.\n`);

  const pages = (await get('me/accounts', { access_token: userToken, fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100' })).data;
  if (!pages.length) throw new Error('No Facebook Pages on this login. Make sure you ticked the CocoCorp Page when granting access.');
  const want = (arg('page') || '').toLowerCase();
  let page = pages.find((p) => want && p.name.toLowerCase().includes(want));
  if (!page && pages.length === 1) page = pages[0];
  if (!page) {
    pages.forEach((p, i) => console.log(`  ${i + 1}. ${p.name}${p.instagram_business_account ? ` (Instagram @${p.instagram_business_account.username})` : ''}`));
    page = pages[Number(await ask('Which Page is CocoCorp? Number: ')) - 1];
    if (!page) throw new Error('No Page picked.');
  }
  const pageDbg = (await get('debug_token', { input_token: page.access_token, access_token: `${appId}|${appSecret}` })).data;
  const ig = page.instagram_business_account;

  fs.writeFileSync(SOCIAL_FILE, JSON.stringify({
    graphVersion: VERSION, appId, appSecret,
    pageId: page.id, pageName: page.name, pageToken: page.access_token,
    igUserId: ig?.id || '', igUsername: ig?.username || '',
    connectedAt: new Date().toISOString(), tokenExpires: pageDbg.expires_at ? new Date(pageDbg.expires_at * 1000).toISOString() : 'never',
  }, null, 2));
  console.log(`\n✅ Connected Facebook Page "${page.name}"${ig ? ` and Instagram @${ig.username}` : ''}.`);
  console.log(`   Page token expires: ${pageDbg.expires_at ? new Date(pageDbg.expires_at * 1000).toString() : 'never'}`);
  if (!ig) console.log('⚠  No Instagram business account is linked to this Page. Switch Instagram to a Business/Creator account, link it to the Page (Meta Business Suite > Settings > Instagram), then run this again.');
  console.log(`   Saved to ${SOCIAL_FILE}. Coco picks it up on the next job; no restart needed.`);
  rl.close();
})().catch((e) => { console.error(`\n❌ ${e.message}`); rl.close(); process.exit(1); });

# coco-social: CocoCorp Facebook + Instagram for Coco

Coco's workers post, schedule, reply to comments and pull stats on the CocoCorp Facebook Page
and Instagram through Meta's official Graph API. It's free, with no third-party service.
The owner chose **fully autonomous** (2026-10-09): posts go out without a preview.

| File | What |
|---|---|
| `meta.js` | Graph API client: posts (text/link/photo/album/video), IG posts/carousels/reels/stories, comments, insights, schedule queue |
| `mcp.js` | MCP server `coco-social` loaded into every Coco job (via `~/.coco-voice/mcp-extra*.json`, written by server.js) |
| `setup.js` | One-time connection; writes `~/.coco-voice/social.json` (secret + non-expiring Page token) |

Runtime state in `~/.coco-voice/`: `social.json` (creds), `social-queue.json` (scheduled posts),
`social-log.jsonl` (every post/reply/hide/delete), `social-sweep.json` (last comment sweep).

server.js runs two background loops:
- **Every minute:** publishes due scheduled posts and messages the owner the links on Telegram.
- **Every 3 h, 08:00–21:00:** if there are new comments, a routine job replies, hides spam and logs leads to CRM.

Deleting a post is only possible in jobs the owner asked for (and "delete" jobs wait for his yes).

## One-time setup (about 10 minutes, the owner)

**Before you start:** Instagram must be a **Business or Creator** account linked to the CocoCorp
Facebook Page (Instagram app: Settings > Account type; then Meta Business Suite > Settings > Instagram account > Connect).

1. Go to https://developers.facebook.com/apps, click **Create app**, choose **Other**, then type **Business**, and name it "Coco Social".
   Attach it to the CocoCorp business portfolio if asked.
2. In the app dashboard, add the products **Facebook Login for Business** and **Instagram** (the "API setup with Facebook login" option).
   Leave the app in **Development** mode. As the app admin you can use every permission on your own
   Page with no App Review.
3. **App settings > Basic**: copy the **App ID** and **App Secret**.
4. Open https://developers.facebook.com/tools/explorer:
   - Meta App: "Coco Social". User or Page: **User Token**.
   - Add these permissions: `pages_show_list, pages_read_engagement, pages_manage_posts, pages_manage_engagement, pages_read_user_content, read_insights, business_management, instagram_basic, instagram_content_publish, instagram_manage_comments, instagram_manage_insights`
   - Click **Generate Access Token**, and when it asks, tick the CocoCorp Page **and** the Instagram account. Copy the token.
5. On the PC, run the command below and paste the three values when asked:
   ```
   node social/setup.js
   ```
   It should print `✅ Connected Facebook Page "…" and Instagram @…` with `Page token expires: never`.

No restart is needed. Test it by telling Coco something like "post on CocoCorp's socials: …".

If a token is ever revoked (e.g. after a Facebook password change), repeat steps 4–5.

## Daily progress report (`report.js`)

Every evening at 20:00 SAST (after the 18:30 post) the server builds a branded CocoCorp report and sends the PDF to Telegram (with a short summary as caption) and to the owner's own inbox via `coco-emailer --send-self`. No AI tokens.

Covers: posts published today (live from the Graph API, with likes/comments/shares and links), today's engine slot + queue results, a 7-day scheduled-vs-published table (every post that was due, its status and live links, plus direct posts), Instagram day insights (reach, views, profile visits, engaged, interactions), comments today and replies sent, everything lined up for the next 7 days (engine slots + `social-queue.json`), content bank (backups ready/used, showcase tracker and open ideas from the vault note), follower deltas (`content/reports/history.json`) and a "Needs a look" list (pre-flight problems, failures, low bank, unplanned slot days).

- Manual run: `node social/report.js [YYYY-MM-DD]` → `~/.coco-voice/content/reports/<date>.html`; the PDF goes to `~/.coco-voice/outbox/social-reports/CocoCorp Social Report <date>.pdf` (Telegram and the emailer only send from the outbox)
- Change the hour: `socialReportHour` in config.json (default 20). Sent once per day (`reportDay` in content/cycle.json).

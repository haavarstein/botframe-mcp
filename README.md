# BotFrame

A small MCP server for wall-frame push notifications. An agent can put a short message on the frame, take it down, and read what is showing. That is the whole server.

Inspired by Wes Bos's photo-frame-dashboard. No code from that project is included.


It does not start prints, change devices, or read a dashboard. Tokens, and anything you would not want on a wall, stay out of git.

## Run it

Node.js 18 or newer.

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 24
```

Put that value in `.env` as `FRAME_TOKEN`. It must be at least 16 characters. That token is for the kiosk: dismiss requires it.

Mint a per-source agent token (printed once; only the SHA-256 hash is stored, mode 600):

```bash
node scripts/mint-agent-token.mjs coder
chmod 600 config/agent-tokens.json
```

Then:

```bash
npm start
```

Open `http://127.0.0.1:8090/?token=<FRAME_TOKEN>` on the frame. The page checks `/api/alerts` every 10 seconds. A tap removes the alert.

The server listens on `127.0.0.1` until you set `FRAME_HOST`. Leave agent tokens empty and `POST /mcp` answers 404, so nothing can post.

## What the frame shows

| Level | On the frame |
| --- | --- |
| `whisper` | A slim line at the top. Ten minutes unless `ttl_s` says otherwise. |
| `nudge` | A card. It leaves after one minute unless `ttl_s` says otherwise. This is the default. |
| `urgent` | The same card, marked urgent. It stays until someone taps it or an agent dismisses it. `ttl_s` is ignored. |

Only the newest alert of each level is drawn. The message is cut to 140 characters. Links and line breaks are removed. Text that looks like a secret is rejected.

`GET /api/alerts` needs no token, because the frame reads it. The JSON is the text, the sender's display name, and the timing. It does not include the token.

```json
{
  "alerts": [
    {
      "id": "0123456789ab",
      "level": "nudge",
      "text": "Backup finished",
      "source": "Coder",
      "at": "2026-10-12T14:00:00.000Z",
      "remainingMs": 60000,
      "ttlMs": 60000
    }
  ]
}
```

`remainingMs` and `ttlMs` are `null` for urgent. Poll about every 10 seconds. On a tap, post `{"id":"..."}` to `/api/alerts/dismiss` with `Authorization: Bearer <FRAME_TOKEN>`.

## Connect an agent

Use a per-source token from `scripts/mint-agent-token.mjs`. Keep it in the environment. Do not paste it into a config file that you commit.

```json
{
  "mcpServers": {
    "alert-frame": {
      "type": "http",
      "url": "http://127.0.0.1:8090/mcp",
      "headers": {
        "Authorization": "Bearer ${FRAME_AGENT_TOKEN}"
      }
    }
  }
}
```

The server speaks streamable HTTP with JSON responses and no session. `POST /mcp` is the only MCP method.

| Tool | What it does |
| --- | --- |
| `frame_notify` | Shows an alert. `text` is required. `level` is `whisper`, `nudge`, or `urgent`. `source` is lowercase letters, digits, and dashes, up to 32 characters. `ttl_s` is 10 to 7200. `key` dedupes for 15 minutes. Returns the alert id. |
| `frame_dismiss` | Removes an alert. `id` is the 12 hex characters `frame_notify` returned. A per-source token may only dismiss its own alerts. |
| `frame_agent_status` | Heartbeat / status. `running` with no update is stale after 15 minutes and failed/offline after 60. |
| `frame_state` | The alerts on the frame now, plus status. |

A script can skip MCP and post the same alert:

```sh
curl -s -X POST http://127.0.0.1:8090/api/alerts \
  -H "authorization: Bearer ${FRAME_AGENT_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"text":"Backup finished","level":"nudge","source":"coder"}'
```

Or use the helper:

```sh
FRAME_URL=http://127.0.0.1:8090 FRAME_AGENT_TOKEN=... node scripts/frame-notify.mjs failed coder "CI red on main"
```

Each source can send 30 alerts a minute. Write endpoints also have a per-address cap. The extra request gets `429`.

## Policy

- **Urgent allowlist.** `AGENT_URGENT_SOURCES` (default `ops,daily,desk,watch`). Any other source that posts `urgent` is downgraded to `nudge`.
- **Quiet hours.** `AGENT_QUIET_HOURS=23:00-07:00` in `AGENT_QUIET_TZ`. Nudges wait until morning. Urgent is shown silent. Whisper is unchanged.
- **Dedupe.** Same source+key (or source+text) within 15 minutes updates the existing alert.

## On another machine

If the frame and the agent are not on this computer, set `FRAME_HOST=0.0.0.0` and put the server on an address the frame can reach. `GET /api/alerts` is open on that host, so only do this on a network you trust. Posts still need tokens. Prefer a tunnel; see [docs/cloudflare-tunnel.md](docs/cloudflare-tunnel.md).

## Do not publish

- `.env`, `FRAME_TOKEN`, `FRAME_AGENT_TOKEN`, `AGENT_EVENTS_TOKEN`
- `config/agent-tokens.json` and `data/alerts.json`
- message text you would not want on a public wall

## Credits

Inspired by Wes Bos's [photo-frame-dashboard](https://github.com/wesbos/photo-frame-dashboard) and his video [Jailbreaking a $50 photo frame](https://www.youtube.com/watch?v=ZLycoUMltNI). No code from that project is included.

## Disclaimer

Provided "as is", without warranty of any kind (see LICENSE). Not affiliated with or endorsed by Wes Bos, botframe.dev, or any bot or AI vendor. You are responsible for securing your deployment, tokens, and any alert data routed through it.

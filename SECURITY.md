# Security

BotFrame is a wall display. The frame is not a trusted device: it receives display data only (names, short lines, times). Tokens and raw records stay on the host.

Report a vulnerability through GitHub private security advisories on this repository: **Security** tab → **Report a vulnerability**. Private vulnerability reporting must be enabled in the repository settings (Settings → Code security → Private vulnerability reporting); otherwise that button is missing.

## Agent tokens

Each bot gets one token, bound to one source id (for example `coder` or `daily`). The host stores only the SHA-256 hex digest of that token in `config/agent-tokens.json` (file mode `600`, gitignored). The plaintext token is printed once at mint time and is never written to that file.

Mint a token on the host:

```sh
node scripts/mint-agent-token.mjs <source>
```

`<source>` must match `^[a-z0-9][a-z0-9-]{0,31}$` (lowercase letters, digits, and dashes, 1–32 characters, starting with a letter or digit). Anything else prints `usage: mint-agent-token.mjs <source>` and exits 1.

The script writes `{ "<source>": "<sha256 hex>" }` to `AGENT_SOURCE_TOKENS_FILE` if set, otherwise `config/agent-tokens.json`. Put the printed value on the bot as `FRAME_AGENT_TOKEN`. The tokens file is re-read on every authenticated request, so mint and revoke take effect immediately with no restart.

The same Bearer token authenticates `POST /api/agents/events`, `POST /api/alerts`, and `POST /mcp`. Token comparison uses `crypto.timingSafeEqual`.

On POSIX, the server refuses to start if the tokens file or `.env` exists and is not mode `600`.

## Frame token

`POST /api/alerts/dismiss` requires `FRAME_TOKEN` (at least 16 characters) as `Authorization: Bearer`. The kiosk page reads it from the `token` query string and sends it on a tap. If `FRAME_TOKEN` is unset, dismiss answers **404**. A mismatch answers **401**. MCP `frame_dismiss` uses the agent token instead.

## Source binding

A per-source token can only post as its own source. `authenticateAgent` returns `{ ok: true, source: "<id>" }` for a hash match. MCP `frame_notify` binds `source`, `frame_agent_status` binds `agent`, and `frame_dismiss` may only remove an alert whose `source` matches. HTTP `POST /api/alerts` binds `source`; `POST /api/agents/events` binds `agent`. A mismatch is HTTP 403 (`{ "error": "source" }` on the HTTP endpoints; MCP JSON-RPC error `-32003` `"source does not match token"`). If the field is omitted, the server fills in the bound id.

`scripts/frame-notify.mjs` treats HTTP 401 and 403 as a refusal and exits **1**. Posting as another source with that helper therefore fails with exit 1.

Secret-looking text is a different failure: `looksLikeSecret` refuses locally and the script exits **2** without sending the request. A missing URL (`FRAME_URL`, `--url`, or `url` in `--config`) is also exit **2**, with no request.

## Urgent allowlist

`urgent` covers the screen until someone taps it. Only sources on the allowlist keep that level. Configure it with `AGENT_URGENT_SOURCES`, a comma-separated list of source ids. The default is `ops,daily,desk,watch`. Any other source that posts `urgent` is downgraded to `nudge` (default 60s TTL). Empty `AGENT_URGENT_SOURCES` uses that default; a non-empty value replaces it.

## Secret filter

The HTTP and MCP servers reject alert `text` and `key` that look like secrets (HTTP **400**, MCP tool error). The helper script refuses the same shapes locally (exit 2, no request, tokens never printed). `looksLikeSecret` matches:

- OpenAI-style `sk-`
- GitHub `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`
- Slack `xox`
- AWS `AKIA` plus 8 or more uppercase alphanumerics
- JWT-shaped `eyJ….…`
- `password`, `passwd`, `secret`, `api_key` / `api-key`, or `token` followed by `=` or `:`
- `Bearer` plus a token
- PEM / OpenSSH / PGP private keys
- 32 or more hex characters
- 32 or more base64 characters
- 32 or more base64url characters with mixed case and a digit

Matching strings are also redacted before an alert is stored. Unknown JSON fields are rejected, not dropped: HTTP write endpoints answer **400**, and MCP tools return a tool error.

## Rate limits

| Path | Limit |
| --- | --- |
| `POST /api/alerts` | 60 requests per client address per 60-second **fixed window**, then HTTP 429 `{ "error": "slow down" }`; plus 30 alerts per source per 60-second window |
| `POST /mcp` | 120 requests per client address per 60-second fixed window, then HTTP 429 |
| `POST /api/alerts/dismiss` | 60 requests per client address per 60-second fixed window, then HTTP 429 |
| `POST /api/agents/events` | 120 requests per client address per 60-second fixed window, then HTTP 429; plus 120 events per agent id per 60-second window |
| MCP `frame_notify` | 30 alerts per source per 60-second fixed window, then a tool error |
| MCP `frame_agent_status` | 120 events per agent id per 60-second fixed window, then a tool error |

The window is not rolling. Across a window boundary a source can send up to about 2× the cap in a short span (the last requests of one window plus the first of the next).

Request bodies are also capped (`readJson` defaults to 1024 bytes; MCP allows 64 KiB). That is a size limit, not a rate limit.

## Quiet hours

Quiet hours use the host clock in `AGENT_QUIET_TZ`, else `DISPLAY_TZ`, else `TIMEZONE`, else `America/New_York`.

- `AGENT_QUIET_HOURS` — `HH:MM-HH:MM` (24-hour, for example `23:00-07:00`). When this matches, it sets both ends.
- `AGENT_QUIET_START` / `AGENT_QUIET_END` — fallbacks if `AGENT_QUIET_HOURS` is unset or malformed. Defaults `23:00` and `07:00`.

If start equals end, quiet hours are off. If start is later than end, the window wraps midnight.

During quiet hours:

- `nudge` is queued until the quiet end (`hiddenUntil`), then shown for its full TTL counted from quiet end
- `urgent` is shown with `silent: true`
- `whisper` is shown as usual

## Legacy `AGENT_EVENTS_TOKEN`

`AGENT_EVENTS_TOKEN` is a shared secret (at least 16 characters) that still authenticates as **any** source (`authenticateAgent` returns `{ ok: true, source: null }`). It is **off by default**. Prefer per-source hashes in `AGENT_SOURCE_TOKENS_FILE`.

If the legacy token is set together with any per-source token hashes, the server refuses to start.

If neither the legacy token nor any source hashes are configured, the agent write endpoints answer **404**.

### Migration

1. Mint a token per bot: `node scripts/mint-agent-token.mjs <source>`.
2. Put that plaintext token on the bot as `FRAME_AGENT_TOKEN`. Do not commit it.
3. Confirm a post from that bot succeeds (and that posting as another source fails with 403 / `frame-notify` exit 1).
4. Remove `AGENT_EVENTS_TOKEN` from `.env` if it was set.
5. Restart. The old shared secret then returns 401.

## Revocation

Delete the source's hash entry from `config/agent-tokens.json` (or the file named by `AGENT_SOURCE_TOKENS_FILE`). The next request re-reads the file, and the old plaintext then fails authentication (401). No restart. Rotate by minting again for the same source; mint overwrites that source's hash.

## Network bind

`FRAME_HOST` defaults to `127.0.0.1`, so the process listens only on loopback. Clients on the LAN reach it only if you set `FRAME_HOST=0.0.0.0`. If a Cloudflare tunnel is the only intended ingress, keep the default.

## Reporting a vulnerability

Use GitHub private security advisories: open the repository → **Security** → **Report a vulnerability**. Private vulnerability reporting must be enabled in the repository settings, or that flow is unavailable. Do not file a public issue for a token leak or an auth bypass.

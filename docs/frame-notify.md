# frame-notify

Bots post three desk events plus a heartbeat to BotFrame over MCP. The helper is `scripts/frame-notify.mjs` (Node 18+, no dependencies).

```sh
node scripts/frame-notify.mjs needs_input daily "Approve invoice 240"
node scripts/frame-notify.mjs failed coder "CI red on main" --key ci-main
node scripts/frame-notify.mjs finished desk "Brief ready"
node scripts/frame-notify.mjs heartbeat watch "ok"
```

| Event | Tool | Level / kind |
| --- | --- | --- |
| `needs_input` | `frame_notify` | `urgent` |
| `failed` | `frame_notify` | `nudge` |
| `finished` | `frame_notify` | `whisper`, `ttl_s` 7200 |
| `heartbeat` | `frame_agent_status` | `running` |

`--key` is a dedupe key. Same source+key within 15 minutes updates the existing alert.

## Settings

Environment, `--url`, or `--config` JSON `{ "url", "token", "client_id", "client_secret" }`:

| Name | Default |
| --- | --- |
| `FRAME_URL` | Required. No code default. Also `--url`, or `url` in `--config`. If unset, the script prints an error to stderr and exits 2 without sending. |
| `FRAME_AGENT_TOKEN` | (required) per-source token from `scripts/mint-agent-token.mjs`, or the legacy `AGENT_EVENTS_TOKEN` |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access service token id |
| `CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service token secret |

The script sends `Authorization: Bearer`, `CF-Access-Client-Id`, and `CF-Access-Client-Secret`, then JSON-RPC `tools/call` (and `initialize` if the server asks). It refuses text that looks like a secret (`sk-`, `ghp_`, `xox`, `AKIA`, JWT, `password=`, private keys, long hex/base64) and exits 2. Missing `FRAME_URL` (and no `--url` or `url` in `--config`) is also exit 2, with nothing sent. It never prints tokens.

## Mint a per-source token

On the host:

```sh
node scripts/mint-agent-token.mjs daily
```

That prints the token once and writes its SHA-256 hash to `config/agent-tokens.json` (mode 600, not committed). Put the token on the bot as `FRAME_AGENT_TOKEN`. A per-source token can only post as that source.

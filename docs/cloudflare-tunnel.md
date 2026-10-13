# Cloudflare tunnel

Expose BotFrame at `https://frame.example.com/` with Cloudflare Tunnel and Access. Replace placeholders before you run anything. Do not commit credentials, service tokens, or cloudflared credential JSON files.

## Create the tunnel

```sh
cloudflared tunnel login
cloudflared tunnel create alert-frame
cloudflared tunnel route dns alert-frame frame.example.com
```

`tunnel create` writes a credentials JSON under the cloudflared config directory. That file is a secret.

## cloudflared config

```yaml
tunnel: <tunnel-id>
credentials-file: <cloudflared-config-dir>/<tunnel-id>.json
ingress:
  - hostname: frame.example.com
    service: http://127.0.0.1:8090
  - service: http_status:404
```

The catch-all `http_status:404` must be last.

`FRAME_HOST` defaults to `127.0.0.1`, so loopback is the only local bind. That matches a tunnel as the only intended ingress. Set `FRAME_HOST=0.0.0.0` only if LAN clients must skip the tunnel.

## Cloudflare Access

1. Create a self-hosted Access application for `frame.example.com`.
2. Create a service token. Save the Client ID and Client Secret; Cloudflare shows the secret once.
3. Add a policy whose action is **Service Auth** and include that service token.

Bots send the service token as `CF-Access-Client-Id` and `CF-Access-Client-Secret`, plus `Authorization: Bearer <agent-token>` for BotFrame. See [SECURITY.md](../SECURITY.md) and [frame-notify.md](frame-notify.md).

## LaunchAgent example (macOS)

Save a LaunchAgent plist for cloudflared, for example `~/Library/LaunchAgents/com.example.cloudflared-alert-frame.plist`, with Label `com.example.cloudflared-alert-frame`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.cloudflared-alert-frame</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>tunnel</string>
    <string>run</string>
    <string>alert-frame</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/cloudflared-alert-frame.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/cloudflared-alert-frame.err</string>
</dict>
</plist>
```

Load and start it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.cloudflared-alert-frame.plist
launchctl kickstart -k gui/$(id -u)/com.example.cloudflared-alert-frame
```

## Verify

Without Access headers the edge should refuse the request (Cloudflare Access returns **403**):

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://frame.example.com/mcp
```

With Access and an agent token, JSON-RPC `initialize` or `tools/list` on `/mcp` should return **200**:

```sh
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://frame.example.com/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "CF-Access-Client-Id: <id>" \
  -H "CF-Access-Client-Secret: <secret>" \
  -H "Authorization: Bearer <agent-token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}'
```

`tools/list` uses the same URL and headers with `"method":"tools/list"`. Mint `<agent-token>` with `scripts/mint-agent-token.mjs`; never commit it.

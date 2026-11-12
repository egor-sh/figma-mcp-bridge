# figma-mcp-bridge

Connect **any** local MCP agent — Goose, Claude Desktop, Cursor, Codex, Cline,
OpenCode, ZCode, ... — to **Figma's remote MCP server**
(`https://mcp.figma.com/mcp`), even though Figma restricts OAuth access to a
private allowlist of partnered clients.

One bridge, one browser authorization — every agent on your machine reuses it.

```
your agent (stdio)  →  bin/figma-mcp-bridge.sh  →  mcp-remote  →  https://mcp.figma.com/mcp
                                                        ↑
                              ~/.mcp-auth/mcp-remote-v1/ (OAuth tokens, auto-refreshed)
```

## The problem

Figma's remote MCP server speaks standard MCP OAuth (RFC 9700), but its
dynamic client registration endpoint only accepts `client_name` values from an
internal allowlist (Claude Code, Codex, ...). Everything else gets a bare
`HTTP 403 Forbidden` — the browser authorization page never opens, so agents
outside the allowlist cannot connect at all.
[Figma runs a partner program](https://www.figma.com/mcp-catalog/) for client
names, but there is no self-service way to register your favorite agent.

## How this works

1. `scripts/figma-oauth-auth.mjs` performs the standards-based flow
   (OAuth discovery → dynamic client registration → authorization code + PKCE)
   **using an allowlisted client name**, and saves the tokens in
   [mcp-remote](https://github.com/geelen/mcp-remote)'s native on-disk store
   (`~/.mcp-auth/mcp-remote-v1/`).
2. `bin/figma-mcp-bridge.sh` runs mcp-remote as a local stdio↔HTTP bridge.
   mcp-remote reads the saved tokens, attaches them to every request, and
   **auto-refreshes** the access token with the refresh token — no re-login
   until Figma itself expires the grant.
3. Your agents connect to the bridge over plain stdio; no OAuth support is
   needed on their side.

## Install

Requirements: **Node.js ≥ 20**, npm. macOS/Linux (Windows: use WSL).

```bash
git clone https://github.com/egor-sh/figma-mcp-bridge.git
cd figma-mcp-bridge
./install.sh              # + `--with-goose` to also register the Goose extension
```

Then authorize once (a browser window opens, you approve access, done):

```bash
node scripts/figma-oauth-auth.mjs
```

Verify:

```bash
node scripts/verify.mjs
# [verify] initialize OK — Figma MCP Server 1.0.0
# [verify] tools/list OK — 48 tools available
```

## Wire your agents

Use `bin/figma-mcp-bridge.sh` as a **stdio** MCP server.

**Goose** (`~/.config/goose/config.yaml`):

```yaml
extensions:
  figma:
    enabled: true
    type: stdio
    name: figma
    cmd: /path/to/figma-mcp-bridge/bin/figma-mcp-bridge.sh
    timeout: 300
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "figma": { "command": "/path/to/figma-mcp-bridge/bin/figma-mcp-bridge.sh" }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`): same JSON shape as Claude Desktop.
**Anything else**: any client that can launch a stdio MCP server.

## CLI reference

| Script | Purpose |
|---|---|
| `scripts/figma-oauth-auth.mjs` | Full OAuth flow; writes tokens to the mcp-remote store. Flags: `--client-name "Codex"`, `--callback-port 3000`, `--callback-path /callback`, `--server-url`, `--scope mcp:connect` |
| `scripts/verify.mjs` | End-to-end check: launches the bridge, lists tools |
| `bin/figma-mcp-bridge.sh` | The bridge itself (what your agents run) |

The bridge pins the OAuth callback to `http://localhost:3000/callback` — the
redirect URI the credentials were registered with. Figma validates redirect
URIs strictly, so keep port/path consistent with the auth script defaults.

## Security notes

- Tokens are stored locally in `~/.mcp-auth/mcp-remote-v1/` (mcp-remote's
  standard location), file mode `0600`, directory mode `0700`. Nothing is sent
  anywhere except to Figma's OAuth endpoints and the Figma MCP server itself.
- The auth script validates the OAuth `state` parameter (CSRF protection) and
  verifies the fresh token against the MCP server before storing anything.
- Nothing sensitive is ever printed to the console — only metadata
  (client id, expiry), never full tokens.

## Troubleshooting

**`unable to get local issuer certificate` (Node TLS errors on macOS).**
Some VPN/CDN setups serve a chain Node's bundled roots don't cover. The bridge
and installer auto-set `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem` on macOS, which
adds the system trust anchors. Set it manually for other cases.

**`Port 3000 unavailable` during auth.** Something else listens on port 3000.
Free it (`lsof -i :3000`) or run auth with `--callback-port` / bridge with a
matching port — but then re-run auth so the redirect URI matches.

**Safari can't reach `localhost` after authorization.** The callback server
binds `0.0.0.0` (both IPv4 and IPv6), which fixes the usual Safari/`::1` case.
If it still fails, copy the authorization URL into Chrome.

**401 after months of use.** Figma expired the grant entirely. Re-run
`node scripts/figma-oauth-auth.mjs` — one browser click — and restart the agent.

## Credits

Built on ideas (and hard-won knowledge) from:

- [TWrecksz/Kimi-Code_Figma-MCP-OAuth-Helper](https://github.com/TWrecksz/Kimi-Code_Figma-MCP-OAuth-Helper) — zero-dependency OAuth helper pattern
- [sdaoudi/mcp-auth-helper](https://github.com/sdaoudi/mcp-auth-helper) — allowlist workaround for OpenCode
- [geelen/mcp-remote](https://github.com/geelen/mcp-remote) — the stdio↔remote bridge this tool packages

## Disclaimer

Unofficial community tool. Not affiliated with or endorsed by Figma. Figma can
change its allowlist or OAuth behavior at any time; if the workaround stops
working, check the referenced projects for updates.

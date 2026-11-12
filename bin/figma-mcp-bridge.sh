#!/usr/bin/env sh
# figma-mcp-bridge.sh — stdio bridge between a local MCP agent and Figma's
# remote MCP server (https://mcp.figma.com/mcp), powered by mcp-remote.
#
# Point your agent's stdio extension/command at this script. Credentials are
# read from ~/.mcp-auth/mcp-remote-v1/ (created by scripts/figma-oauth-auth.mjs).
#
# The callback port/path below MUST match the redirect_uri your OAuth client
# was registered with — http://localhost:3000/callback is what
# scripts/figma-oauth-auth.mjs registers by default.
set -eu

TOOL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# macOS: Node's bundled CA list can miss roots of the CDN chain serving
# mcp.figma.com (VPN/CDN dependent). Add the system bundle as extra anchors.
# If the environment already points at another bundle (e.g. a corporate MITM
# CA), merge both — a pre-existing bundle may not cover public CDN chains,
# and the system bundle may not cover corporate ones.
if [ "$(uname -s)" = "Darwin" ] && [ -f /etc/ssl/cert.pem ]; then
  if [ -z "${NODE_EXTRA_CA_CERTS:-}" ]; then
    export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem
  elif [ "$NODE_EXTRA_CA_CERTS" != "/etc/ssl/cert.pem" ] && [ -f "$NODE_EXTRA_CA_CERTS" ]; then
    MERGED_CA="${TMPDIR:-/tmp}/figma-mcp-bridge-ca-$$.pem"
    if cat "$NODE_EXTRA_CA_CERTS" /etc/ssl/cert.pem > "$MERGED_CA" 2>/dev/null; then
      export NODE_EXTRA_CA_CERTS="$MERGED_CA"
    fi
  fi
fi

exec node "$TOOL_DIR/node_modules/mcp-remote/dist/proxy.js" \
  https://mcp.figma.com/mcp \
  3000 \
  --callback-path /callback \
  --transport http-only \
  "$@"

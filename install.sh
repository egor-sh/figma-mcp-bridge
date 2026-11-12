#!/usr/bin/env sh
# install.sh — set up figma-mcp-bridge on this machine.
#
#   ./install.sh              install dependencies + print agent wiring hints
#   ./install.sh --with-goose also register the extension in Goose's config.yaml
#
# What it does:
#   1. checks Node.js >= 20
#   2. installs mcp-remote locally (npm)
#   3. makes scripts executable
#   4. optionally wires Goose (--with-goose)
#   5. tells you how to get credentials and wire other agents

set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$REPO_DIR"

WITH_GOOSE=false
for arg in "$@"; do
  case "$arg" in
    --with-goose) WITH_GOOSE=true ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# macOS + VPN/CDN setups: node may not trust the served TLS chain.
# Add the system bundle as extra anchors; merge with a pre-existing bundle
# (e.g. a corporate CA) so both corporate MITM and public CDN chains validate.
if [ "$(uname -s)" = "Darwin" ] && [ -f /etc/ssl/cert.pem ]; then
  if [ -z "${NODE_EXTRA_CA_CERTS:-}" ]; then
    export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem
  elif [ "$NODE_EXTRA_CA_CERTS" != "/etc/ssl/cert.pem" ] && [ -f "$NODE_EXTRA_CA_CERTS" ]; then
    MERGED_CA="${TMPDIR:-/tmp}/figma-mcp-bridge-ca-install-$$.pem"
    cat "$NODE_EXTRA_CA_CERTS" /etc/ssl/cert.pem > "$MERGED_CA" 2>/dev/null &&
      export NODE_EXTRA_CA_CERTS="$MERGED_CA"
  fi
fi

# --- 1. Node check ----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found on PATH. Install Node.js >= 20: https://nodejs.org" >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "error: Node.js >= 20 required, found $(node -v)" >&2
  exit 1
fi
echo "node $(node -v) — ok"

# --- 2. dependencies --------------------------------------------------------
echo "installing mcp-remote locally..."
if [ ! -d node_modules/mcp-remote ]; then
  npm install --no-fund --no-audit
else
  echo "already installed — skipping"
fi

# --- 3. permissions ---------------------------------------------------------
chmod +x bin/figma-mcp-bridge.sh
chmod +x scripts/*.mjs

BRIDGE="$REPO_DIR/bin/figma-mcp-bridge.sh"

# --- 4. Goose wiring --------------------------------------------------------
if [ "$WITH_GOOSE" = true ]; then
  GOOSE_CONFIG="$HOME/.config/goose/config.yaml"
  if [ ! -f "$GOOSE_CONFIG" ]; then
    echo "goose config not found at $GOOSE_CONFIG — skipping auto-wiring"
  else
    if python3 - "$GOOSE_CONFIG" "$BRIDGE" <<'PYEOF'
import sys, re, shutil, os

config_path, bridge_path = sys.argv[1], sys.argv[2]
text = open(config_path).read()
if re.search(r"(?m)^  figma:\s*$", text):
    print("goose config already has a figma extension — skipping")
    sys.exit(0)
m = re.search(r"(?m)^extensions:\s*$", text)
if not m:
    print("could not find the 'extensions:' section — add the figma block manually")
    sys.exit(1)
block = (
    "  figma:\n"
    "    enabled: true\n"
    "    type: stdio\n"
    "    name: figma\n"
    f"    cmd: {bridge_path}\n"
    "    timeout: 300\n"
)
insert_at = m.end()
shutil.copy(config_path, config_path + ".bak-figma-bridge")
open(config_path, "w").write(text[:insert_at] + "\n" + block + text[insert_at:])
print(f"goose config updated (backup: {config_path}.bak-figma-bridge)")
PYEOF
    then
      echo "goose: figma extension registered. Restart Goose / start a new session."
    else
      echo "goose auto-wiring failed — add this block under 'extensions:' in $GOOSE_CONFIG:"
      echo "  figma:"
      echo "    enabled: true"
      echo "    type: stdio"
      echo "    name: figma"
      echo "    cmd: $BRIDGE"
      echo "    timeout: 300"
    fi
  fi
fi

# --- 5. credentials + other agents -----------------------------------------
STORE="$HOME/.mcp-auth/mcp-remote-v1"
if ls "$STORE"/*_tokens.json >/dev/null 2>&1; then
  echo "credentials found in $STORE — you are ready to go"
else
  echo "no credentials yet. Authorize once:"
  echo "  node scripts/figma-oauth-auth.mjs"
fi

echo
echo "Wire your agents (use this command as the stdio server):"
echo "  $BRIDGE"
echo
echo "  Goose (config.yaml):        see above / --with-goose"
echo "  Claude Desktop (claude_desktop_config.json):"
echo '    {"mcpServers": {"figma": {"command": "'"$BRIDGE'"'}}}'
echo "  Cursor (mcp.json):          same JSON shape as Claude Desktop"
echo "  Generic:                    any client that supports stdio MCP servers"
echo
echo "Then verify: node scripts/verify.mjs"

#!/usr/bin/env node
// figma-oauth-auth.mjs — acquire OAuth tokens for Figma's remote MCP server
// and store them in mcp-remote's native credential store, so ANY local MCP
// agent (Goose, Claude Desktop, Cursor, Codex, Cline, ...) can connect
// through the mcp-remote bridge without its own browser flow.
//
// Why this exists: Figma's remote MCP server (https://mcp.figma.com/mcp)
// only accepts OAuth client registrations whose client_name is on a private
// allowlist of partnered clients. Dynamic client registration (RFC 7591)
// with any other name fails with HTTP 403 before the browser even opens.
// This script performs the exact same standards-based flow (discovery ->
// dynamic registration -> authorization code + PKCE) from outside the
// agent, using an allowlisted client name, and writes the resulting tokens
// to the on-disk store that mcp-remote reads on startup. mcp-remote then
// keeps the access token refreshed automatically.
//
// Zero dependencies: Node.js >= 18 (built-in fetch, crypto, http).
//
// Usage:
//   node scripts/figma-oauth-auth.mjs                 # default: Figma, client "Codex"
//   node scripts/figma-oauth-auth.mjs --client-name "Claude Code"
//   node scripts/figma-oauth-auth.mjs --server-url https://mcp.figma.com/mcp
//   node scripts/figma-oauth-auth.mjs --callback-port 3000 --callback-path /callback
//
// After a successful run, restart/reconnect your agent so it picks up the
// credentials via the bridge (see bin/figma-mcp-bridge.sh).

import {createHash, randomBytes} from "node:crypto";
import {createServer} from "node:http";
import {spawnSync} from "node:child_process";
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import process from "node:process";

// ---------------------------------------------------------------------------
// macOS TLS bootstrap: NODE_EXTRA_CA_CERTS is only read at Node startup, and
// a pre-existing value (e.g. a corporate CA bundle) may not cover the CDN
// chain serving the Figma endpoints. Merge whatever is set with the system
// bundle and re-exec this script with the combined file.
// ---------------------------------------------------------------------------

function reexecWithMergedCaBundleIfNeeded() {
  if (process.env.FIGMA_OAUTH_CA_MERGED === "1") return; // already re-executed once
  if (process.platform !== "darwin" || !existsSync("/etc/ssl/cert.pem")) return;
  const systemBundle = "/etc/ssl/cert.pem";
  const current = process.env.NODE_EXTRA_CA_CERTS;
  if (current === systemBundle) return;
  try {
    const parts = [];
    if (current && existsSync(current)) parts.push(readFileSync(current));
    parts.push(readFileSync(systemBundle));
    const merged = join(tmpdir(), `figma-oauth-auth-ca-${process.pid}.pem`);
    writeFileSync(merged, Buffer.concat(parts));
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {
        stdio: "inherit",
        env: {...process.env, NODE_EXTRA_CA_CERTS: merged, FIGMA_OAUTH_CA_MERGED: "1"},
      },
    );
    process.exit(result.status ?? 1);
  } catch {
    // cannot merge — proceed and let TLS errors surface naturally
  }
}
reexecWithMergedCaBundleIfNeeded();

// ---------------------------------------------------------------------------
// Configuration / CLI
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_URL = "https://mcp.figma.com/mcp";

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && i < process.argv.length - 1 ? process.argv[i + 1] : fallback;
}

const SERVER_URL = argValue("--server-url", DEFAULT_SERVER_URL);
const CLIENT_NAME = argValue("--client-name", "Codex");
const CALLBACK_PORT = Number(argValue("--callback-port", "3000"));
const CALLBACK_PATH = argValue("--callback-path", "/callback");
const SCOPE = argValue("--scope", "mcp:connect");
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

function log(...args) {
  console.log("[figma-auth]", ...args);
}

function die(message) {
  console.error("[figma-auth] Error:", message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Credential store — mcp-remote's native layout
// (~/.mcp-auth/mcp-remote-v1/<md5(serverUrl)>_tokens.json / _client_info.json).
// mcp-remote reads these on startup and refreshes tokens on its own.
// ---------------------------------------------------------------------------

const CONFIG_STORE_VERSION = 1;
const serverUrlHash = createHash("md5").update(SERVER_URL).digest("hex");
const storeDir = join(homedir(), ".mcp-auth", `mcp-remote-v${CONFIG_STORE_VERSION}`);
const tokensFile = join(storeDir, `${serverUrlHash}_tokens.json`);
const clientFile = join(storeDir, `${serverUrlHash}_client_info.json`);

// ---------------------------------------------------------------------------
// OAuth discovery (RFC 8414 + protected resource metadata)
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, {headers: {accept: "application/json"}});
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function discoverAuthorizationServer(serverUrl) {
  // 1. Probe the MCP endpoint: an unauthenticated POST must answer 401 with a
  //    WWW-Authenticate header pointing at the protected resource metadata.
  let resourceMetadataUrl = null;
  try {
    const probe = await fetch(serverUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: {name: "figma-mcp-bridge-probe", version: "1.0.0"},
        },
        id: 0,
      }),
    });
    const wwwAuth = probe.headers.get("www-authenticate");
    if (wwwAuth) {
      const match = /resource_metadata="([^"]+)"/.exec(wwwAuth);
      if (match) resourceMetadataUrl = match[1];
    }
  } catch {
    // fall through to well-known guessing below
  }

  // 2. Protected resource metadata -> first authorization server.
  let asUrl = null;
  let resource = null;
  const candidateResourceUrls = [
    resourceMetadataUrl,
    new URL("/.well-known/oauth-protected-resource", serverUrl).toString(),
  ].filter(Boolean);
  for (const url of [...new Set(candidateResourceUrls)]) {
    try {
      const meta = await fetchJson(url);
      resource = meta.resource ?? serverUrl;
      if (Array.isArray(meta.authorization_servers) && meta.authorization_servers.length > 0) {
        asUrl = meta.authorization_servers[0];
        break;
      }
    } catch {
      // try next candidate
    }
  }
  if (!asUrl) asUrl = new URL("/", serverUrl).toString(); // last resort: server origin
  if (!resource) resource = serverUrl;

  // 3. Authorization server metadata (endpoints).
  const asCandidates = [
    new URL("/.well-known/oauth-authorization-server", asUrl).toString(),
    new URL("/.well-known/openid-configuration", asUrl).toString(),
  ];
  let asMetadata = null;
  for (const url of asCandidates) {
    try {
      asMetadata = await fetchJson(url);
      break;
    } catch {
      // try next candidate
    }
  }
  if (!asMetadata) die(`Could not fetch authorization server metadata from ${asUrl}`);

  log(`Authorization server: ${asMetadata.issuer ?? asUrl}`);
  return {asMetadata, resource};
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

async function registerClient(asMetadata) {
  if (!asMetadata.registration_endpoint) {
    die("Authorization server does not expose a registration_endpoint.");
  }
  const body = {
    client_name: CLIENT_NAME,
    redirect_uris: [REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  const res = await fetch(asMetadata.registration_endpoint, {
    method: "POST",
    headers: {"content-type": "application/json", accept: "application/json"},
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    die(`Dynamic client registration failed: HTTP ${res.status} ${await res.text().catch(() => "")}` +
      `\n  (client_name "${CLIENT_NAME}" is probably not on the server's allowlist)`);
  }
  const info = await res.json();
  log(`Client registered: ${info.client_id} (as "${CLIENT_NAME}")`);
  return info;
}

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

function makePkce() {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return {verifier, challenge};
}

// ---------------------------------------------------------------------------
// Local callback server (binds 0.0.0.0 so both 127.0.0.1 and ::1 work —
// Safari on macOS resolves localhost to ::1)
// ---------------------------------------------------------------------------

let callbackHttpServer = null;

function startCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end("not found");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, {"content-type": "text/html; charset=utf-8"});
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
        reject(new Error(`OAuth error: ${error} ${url.searchParams.get("error_description") ?? ""}`));
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code) {
        res.writeHead(400).end("missing code");
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400).end("state mismatch");
        reject(new Error("OAuth state mismatch (possible CSRF)"));
        return;
      }
      res.writeHead(200, {"content-type": "text/html; charset=utf-8"});
      res.end("<h1>Authorization successful!</h1><p>You can close this tab.</p>");
      resolve(code);
    });
    callbackHttpServer = server;
    server.on("error", (err) =>
      reject(new Error(`Port ${CALLBACK_PORT} unavailable: ${err.message}`)),
    );
    server.listen(CALLBACK_PORT, "0.0.0.0", () => {
      log(`Callback server listening on http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

function openBrowser(url) {
  const platform = process.platform;
  const opener = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawnSync(opener, args, {stdio: "ignore"});
    log("Browser opened for authorization.");
  } catch {
    log("Could not open a browser automatically. Open this URL manually:\n  " + url);
  }
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

async function exchangeCodeForTokens(asMetadata, {code, verifier, clientId, clientSecret, resource}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
    resource,
  });
  // Figma's dynamic registration returns a client_secret even when the client
  // requests token_endpoint_auth_method "none" — the token endpoint rejects
  // the exchange without it (client_secret_post style).
  if (clientSecret) body.set("client_secret", clientSecret);
  const res = await fetch(asMetadata.token_endpoint, {
    method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded", accept: "application/json"},
    body: body.toString(),
  });
  if (!res.ok) {
    die(`Token exchange failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const tokens = await res.json();
  log("Tokens received.");
  return tokens;
}

// ---------------------------------------------------------------------------
// Cheap verification: authenticated initialize against the MCP server
// ---------------------------------------------------------------------------

async function verifyTokens(serverUrl, accessToken) {
  const res = await fetch(serverUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {name: "figma-mcp-bridge-probe", version: "1.0.0"},
      },
      id: 1,
    }),
  });
  if (res.status === 401 || res.status === 403) {
    die(`Verification failed: server rejected the new token (HTTP ${res.status}).`);
  }
  log(`Verification: server accepted the token (HTTP ${res.status}).`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Server: ${SERVER_URL}`);
  log(`Redirect URI: ${REDIRECT_URI}`);

  const {asMetadata, resource} = await discoverAuthorizationServer(SERVER_URL);
  const client = await registerClient(asMetadata);
  const {verifier, challenge} = makePkce();
  const state = randomBytes(16).toString("base64url");

  const authorizeUrl = new URL(asMetadata.authorization_endpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", SCOPE);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("resource", resource);

  const callbackServer = startCallbackServer(state);
  openBrowser(authorizeUrl.toString());
  log("Waiting for authorization (complete the login in the browser)...");

  let code;
  try {
    code = await callbackServer;
  } finally {
    callbackHttpServer?.close();
  }
  log("Authorization code received.");

  const tokens = await exchangeCodeForTokens(asMetadata, {
    code,
    verifier,
    clientId: client.client_id,
    clientSecret: client.client_secret,
    resource,
  });
  await verifyTokens(SERVER_URL, tokens.access_token);

  // ---- write mcp-remote store --------------------------------------------
  const expiresInSeconds = typeof tokens.expires_in === "number" ? tokens.expires_in : undefined;
  const tokensOut = {
    access_token: tokens.access_token,
    token_type: tokens.token_type ?? "bearer",
    ...(tokens.refresh_token ? {refresh_token: tokens.refresh_token} : {}),
    ...(expiresInSeconds !== undefined ? {expires_in: expiresInSeconds} : {}),
    ...(expiresInSeconds !== undefined ? {expires_at: Date.now() + expiresInSeconds * 1000} : {}),
    ...(tokens.scope ? {scope: tokens.scope} : {scope: SCOPE}),
  };
  const clientOut = {
    client_id: client.client_id,
    client_name: CLIENT_NAME,
    redirect_uris: [REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
    ...(client.client_secret !== undefined ? {client_secret: client.client_secret} : {}),
    ...(client.client_secret_expires_at !== undefined
      ? {client_secret_expires_at: client.client_secret_expires_at}
      : {}),
    ...(client.client_id_issued_at !== undefined
      ? {client_id_issued_at: client.client_id_issued_at}
      : {}),
  };

  mkdirSync(storeDir, {recursive: true, mode: 0o700});
  writeFileSync(tokensFile, JSON.stringify(tokensOut, null, 2) + "\n", {mode: 0o600});
  writeFileSync(clientFile, JSON.stringify(clientOut, null, 2) + "\n", {mode: 0o600});
  // writeFileSync's mode only applies on creation — enforce permissions even
  // when overwriting an existing file.
  chmodSync(storeDir, 0o700);
  chmodSync(tokensFile, 0o600);
  chmodSync(clientFile, 0o600);

  log("Stored credentials in mcp-remote format:");
  log(`  ${tokensFile}`);
  log(`  ${clientFile}`);
  log("");
  log("Done. Point your agent at the bridge, e.g. (Goose, config.yaml):");
  log("  extensions:");
  log("    figma:");
  log("      enabled: true");
  log("      type: stdio");
  log("      name: figma");
  log(`      cmd: <repo>/bin/figma-mcp-bridge.sh`);
  log("      timeout: 300");
  log("Then restart the agent.");
}

main().catch((err) => {
  die(err?.message ?? String(err));
});

#!/usr/bin/env node
// verify.mjs — end-to-end self-test: spawn the bridge (same command agents
// run), speak MCP over stdio (initialize + tools/list), report the result.
//
//   node scripts/verify.mjs
//
// Exits 0 and prints the tool count when the bridge is fully functional.

import {spawn} from "node:child_process";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bridge = join(repoRoot, "bin", "figma-mcp-bridge.sh");

const child = spawn(bridge, [], {stdio: ["pipe", "pipe", "inherit"]});

let buffer = "";
let toolsOk = false;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 1 && msg.result) {
      const info = msg.result.serverInfo ?? {};
      console.log(`[verify] initialize OK — ${info.name ?? "?"} ${info.version ?? ""}`.trimEnd());
    }
    if (msg.id === 2) {
      if (msg.result?.tools) {
        const names = msg.result.tools.map((t) => t.name);
        console.log(`[verify] tools/list OK — ${names.length} tools available`);
        console.log(`[verify] e.g. ${names.slice(0, 8).join(", ")}${names.length > 8 ? " ..." : ""}`);
        toolsOk = true;
      } else if (msg.error) {
        console.error("[verify] tools/list error:", JSON.stringify(msg.error));
      }
      child.kill();
      process.exit(toolsOk ? 0 : 1);
    }
  }
});

child.on("exit", (code) => {
  if (!toolsOk) {
    console.error(`[verify] bridge exited before completing the check (code ${code}).`);
    console.error("[verify] Run `node scripts/figma-oauth-auth.mjs` first?");
    process.exit(1);
  }
});

child.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {name: "figma-mcp-bridge-verify", version: "1.0.0"},
    },
    id: 1,
  }) + "\n",
);
child.stdin.write(JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"}) + "\n");

setTimeout(() => {
  child.stdin.write(JSON.stringify({jsonrpc: "2.0", method: "tools/list", id: 2}) + "\n");
}, 3000);

setTimeout(() => {
  console.error("[verify] timeout: no tools/list response in 120s");
  child.kill();
  process.exit(1);
}, 120000);

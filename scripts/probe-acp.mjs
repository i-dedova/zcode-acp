/**
 * i31 ACP wire probe: drives the installed zcode-acp-server over stdio and
 * prints the raw JSON-RPC traffic that matters for protocol negotiation and
 * the catalog shape, so v1/v2 behavior is proven from bytes, not types.
 *
 * Usage:
 *   node scripts/probe-acp.mjs <offeredProtocolVersion> [setLabel]
 *
 * Steps: initialize (offering the given version) → session/new (lazy pending
 * catalog, no prompt sent) → session/set_config_option with BOTH the v1 bare
 * string value and the v2 discriminated envelope → providers/list (expected
 * method-not-found). Every response is printed as one raw JSON line prefixed
 * with the set label, then the child's stdin closes (bridge shuts down via its
 * stdin-close handler).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const offered = Number(process.argv[2] ?? "2");
const label = process.argv[3] ?? `probe-v${offered}`;
const bridgeEntry =
  process.env.I31_BRIDGE_ENTRY ??
  path.join(
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
    "npm",
    "node_modules",
    "zcode-acp-server",
    "dist",
    "cli.js",
  );
const cwd = path.join(os.tmpdir(), "i31-probe-cwd");
mkdirSync(cwd, { recursive: true });

const child = nodeSpawn(process.execPath, [bridgeEntry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ZCODE_ACP_DEBUG: "1" },
});
let stderrTail = "";
child.stderr.on("data", (d) => {
  stderrTail = (stderrTail + d.toString()).slice(-4000);
});

const pending = new Map();
let nextId = 1;
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${method}`)),
      timeoutMs,
    );
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(line);
  });
}

function emit(tag, msg) {
  console.log(`### ${label} ${tag}`);
  console.log(JSON.stringify(msg));
}

try {
  const init = await request("initialize", {
    protocolVersion: offered,
    clientInfo: { name: "i31-probe", version: "0.0.0" },
    clientCapabilities: {},
  });
  emit("initialize", init.result ?? init.error);

  const created = await request("session/new", { cwd, mcpServers: [] });
  emit("session/new", created.result ?? created.error);

  const sid = created.result?.sessionId;
  if (sid) {
    // Materialize + switch to the GLM model first: its snapshot-derived
    // vocabulary (low/high/max) is what the thought sets below must accept.
    const setModel = await request("session/set_config_option", {
      sessionId: sid,
      configId: "model",
      value: "builtin:zai-coding-plan\\GLM-5.3-Flash",
    });
    emit("set-model-glm", setModel.result ?? setModel.error);
    // v1 spelling: bare string value.
    const setV1 = await request("session/set_config_option", {
      sessionId: sid,
      configId: "thought",
      value: "high",
    });
    emit("set-v1-bare", setV1.result ?? setV1.error);
    // v2 spelling: discriminated envelope.
    const setV2 = await request("session/set_config_option", {
      sessionId: sid,
      configId: "thought",
      value: { type: "id", value: "low" },
    });
    emit("set-v2-envelope", setV2.result ?? setV2.error);
    // The backend-registry test: switching onto the start-plan plan
    // (config: enabled:false + systemDisabledReason + stored key; the bridge
    // now pushes it entitled and serves its stored key).
    const setStart = await request("session/set_config_option", {
      sessionId: sid,
      configId: "model",
      value: "builtin:zai-start-plan\\GLM-5.3-Flash",
    });
    emit("set-model-startplan", setStart.result ?? setStart.error);
  }

  const providers = await request("providers/list", {}, 10000);
  emit("providers/list", providers.result ?? providers.error);
} catch (e) {
  console.log(`### ${label} PROBE-ERROR ${e instanceof Error ? e.message : String(e)}`);
} finally {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 1500));
  if (child.exitCode === null) {
    try {
      nodeSpawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch {
      /* stdin close is the primary shutdown path */
    }
  }
  if (stderrTail.trim()) {
    console.log(`### ${label} bridge-stderr-tail`);
    console.log(stderrTail.trim());
  }
}

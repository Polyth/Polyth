#!/usr/bin/env node
// Phase-4 fault proxy shim. Polyth spawns THIS script as its owned "opencode"
// child. It spawns the real opencode binary on an ephemeral port, then serves
// Polyth's chosen --port itself as a transparent HTTP/SSE proxy with a
// deterministic per-request fault rule engine. The exact real OpenCode child
// PID is recorded so faults can SIGKILL only that PID.
//
// Rules file ($OC_PROXY_DIR/rules.json): { "rules": [ ... ] } where each rule:
//   { id, mode: "kill-on-request" | "swallow-kill" | "sse-cut",
//     method?, pathRe, markerRe?, oneshot? }
// Oneshot rules leave a consumed-<id> marker so a respawned wrapper instance
// runs clean pass-through.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";

const dir = process.env.OC_PROXY_DIR;
if (!dir) throw new Error("OC_PROXY_DIR is required");
mkdirSync(dir, { recursive: true });
const realBin = process.env.OC_REAL_BIN ?? "/home/ubuntu/.local/bin/opencode";

const argv = process.argv.slice(2);
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hostname = argValue("--hostname") ?? "127.0.0.1";
const proxyPort = Number(argValue("--port") ?? 0);

const timeline = (entry) =>
  appendFileSync(join(dir, "timeline.ndjson"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
const wire = (entry) =>
  appendFileSync(join(dir, "wire.ndjson"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");

const loadRules = () => {
  try {
    return JSON.parse(readFileSync(join(dir, "rules.json"), "utf8")).rules ?? [];
  } catch {
    return [];
  }
};
const consumedPath = (id) => join(dir, `consumed-${id}`);
const activeRule = (method, path) => {
  for (const rule of loadRules()) {
    if (rule.oneshot && existsSync(consumedPath(rule.id))) continue;
    if (rule.method && rule.method !== method) continue;
    if (!new RegExp(rule.pathRe).test(path)) continue;
    return rule;
  }
  return undefined;
};
const consume = (rule) => {
  if (rule.oneshot) writeFileSync(consumedPath(rule.id), new Date().toISOString());
};

// --- spawn the real opencode child on an ephemeral port -------------------
const child = spawn(realBin, ["serve", "--hostname", hostname, "--port", "0"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
const childLog = join(dir, "opencode.log");
let listenBuffer = "";
let realPort = 0;
const LISTEN_RE = /opencode server listening on https?:\/\/[^\s:]+:(\d+)/i;
const onChildChunk = (chunk) => {
  appendFileSync(childLog, chunk);
  if (realPort) return;
  listenBuffer += chunk.toString();
  const match = listenBuffer.match(LISTEN_RE);
  if (match) {
    realPort = Number(match[1]);
    startProxy();
  }
};
child.stdout.on("data", onChildChunk);
child.stderr.on("data", onChildChunk);
child.on("exit", (code, signal) => {
  timeline({ event: "real-child-exit", pid: child.pid, code, signal });
  // Mirror real owned-child death exactly: exit NOW so no probe can ever hit a
  // half-dead endpoint (wrapper alive, upstream dead) that a real child never has.
  process.exit(code ?? 1);
});
process.on("SIGTERM", () => {
  timeline({ event: "wrapper-sigterm", forwardedTo: child.pid });
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
    process.exit(0);
  }, 2000);
});

const killChild = (why) => {
  timeline({ event: "fault-kill-real-child", pid: child.pid, why });
  try { process.kill(child.pid, "SIGKILL"); } catch {}
};

// --- proxy -----------------------------------------------------------------
const startProxy = () => {
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    wrapperPid: process.pid,
    childPid: child.pid,
    realPort,
    proxyPort,
    startedAt: new Date().toISOString(),
  }, null, 2));

  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    const rule = activeRule(req.method, path.split("?")[0]);

    if (rule?.mode === "kill-on-request") {
      consume(rule);
      killChild(`kill-on-request ${req.method} ${path}`);
      wire({ event: "fault", rule: rule.id, method: req.method, path });
      req.socket.destroy();
      return;
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const upstream = httpRequest({
        host: "127.0.0.1",
        port: realPort,
        method: req.method,
        path,
        headers: { ...req.headers, host: `127.0.0.1:${realPort}` },
      }, (upstreamRes) => {
        if (rule?.mode === "swallow-kill") {
          const resChunks = [];
          upstreamRes.on("data", (c) => resChunks.push(c));
          upstreamRes.on("end", () => {
            const resBody = Buffer.concat(resChunks);
            writeFileSync(join(dir, `captured-${rule.id}.json`), JSON.stringify({
              ts: new Date().toISOString(),
              rule: rule.id,
              request: { method: req.method, path, bodyBytes: body.length, body: body.toString("utf8").slice(0, 4096) },
              response: { status: upstreamRes.statusCode, bodyBytes: resBody.length, body: resBody.toString("utf8").slice(0, 8192) },
            }, null, 2));
            consume(rule);
            killChild(`swallow-kill ${req.method} ${path}`);
            wire({ event: "fault-swallowed-response", rule: rule.id, method: req.method, path, status: upstreamRes.statusCode, resBytes: resBody.length });
            // Never deliver the response: the upstream commit stays invisible.
            res.socket?.destroy();
            req.socket.destroy();
          });
          return;
        }

        // pass-through (with optional SSE cut)
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        let resBytes = 0;
        let cutting = false;
        let tail = "";
        upstreamRes.on("data", (chunk) => {
          resBytes += chunk.length;
          if (rule?.mode === "sse-cut" && !cutting) {
            tail = (tail + chunk.toString("utf8")).slice(-16384);
            if (new RegExp(rule.markerRe).test(tail)) {
              cutting = true;
              consume(rule);
              writeFileSync(join(dir, `cut-${rule.id}`), new Date().toISOString());
              wire({ event: "fault-sse-cut", rule: rule.id, path, afterBytes: resBytes });
              timeline({ event: "sse-cut", rule: rule.id, path });
              // Optional: the upstream commit exists but the exact child dies
              // before its terminal frame can ever be re-delivered (OC-REAL-059).
              if (rule.killAfter) killChild(`sse-cut ${rule.id} ${path}`);
              return; // this chunk (containing the marker) is withheld
            }
          }
          if (!cutting) res.write(chunk);
        });
        upstreamRes.on("end", () => {
          wire({ event: "proxied", method: req.method, path, status: upstreamRes.statusCode, reqBytes: body.length, resBytes, cut: cutting });
          if (!cutting) res.end();
          // when cutting: leave the client hanging like a stalled network path
        });
        upstreamRes.on("error", () => { try { res.destroy(); } catch {} });
      });
      upstream.on("error", (error) => {
        wire({ event: "upstream-error", method: req.method, path, error: String(error.message) });
        try { req.socket.destroy(); } catch {}
        try { res.destroy(); } catch {}
      });
      upstream.end(body);
    });
  });
  server.on("connection", (socket) => socket.setNoDelay(true));
  server.listen(proxyPort, hostname, () => {
    timeline({ event: "proxy-listening", proxyPort, realPort, wrapperPid: process.pid, childPid: child.pid });
    // Only now does Polyth learn the (proxied) endpoint.
    console.log(`opencode server listening on http://${hostname}:${proxyPort}`);
  });
};

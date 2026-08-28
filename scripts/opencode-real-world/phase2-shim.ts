#!/usr/bin/env node
/**
 * Transport-only OpenCode shim for Phase 2 mutation-ambiguity validation.
 *
 * Polyth owns this process as if it were `opencode serve`. The shim starts the
 * pinned real OpenCode binary on a private random port and exposes an HTTP
 * recording/fault proxy on Polyth's requested port. Mutation semantics always
 * come from the real server; rules can only delay, truncate, reset, suppress,
 * or replace transport responses.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Socket } from "node:net";

interface RuleAction {
  kind:
    | "pass"
    | "blackhole"
    | "drop-before-headers"
    | "partial-body-reset"
    | "delay-response"
    | "synthetic";
  delayMs?: number;
  partialBytes?: number;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Rule {
  id: string;
  method?: string;
  pathPattern?: string;
  bodyIncludes?: string;
  maxUses?: number;
  action: RuleAction;
}

interface RuleFile {
  version: number;
  rules: Rule[];
}

interface ActiveRule extends Rule {
  uses: number;
  pathRegex?: RegExp;
}

const controlDir = process.env.POLYTH_PHASE2_SHIM_DIR;
const realBin = process.env.OPENCODE_REAL_BIN ?? "/home/ubuntu/.local/bin/opencode";
if (!controlDir) throw new Error("POLYTH_PHASE2_SHIM_DIR is required");

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
if (args[0] !== "serve") throw new Error(`phase2 shim only supports serve, got ${args.join(" ")}`);
const listenPort = Number(option("--port"));
const hostname = option("--hostname") ?? "127.0.0.1";
if (!Number.isSafeInteger(listenPort) || listenPort <= 0 || listenPort === 14500) {
  throw new Error(`invalid or forbidden proxy port: ${String(listenPort)}`);
}

await mkdir(controlDir, { recursive: true });
const wirePath = join(controlDir, "wire.ndjson");
const statePath = join(controlDir, "state.json");
const rulesPath = join(controlDir, "rules.json");
const opencodeLogPath = join(controlDir, "opencode.log");
let recordSequence = 0;
let connectionSequence = 0;
let rulesVersion = -1;
let rules: ActiveRule[] = [];
let shuttingDown = false;
const activeSockets = new Map<Socket, string>();

const redact = (text: string): string => {
  let value = text;
  for (const candidate of [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    process.env.OPENCODE_SERVER_PASSWORD,
  ]) {
    if (candidate && candidate.length > 4) value = value.split(candidate).join("[REDACTED]");
  }
  return value;
};

const record = async (entry: Record<string, unknown>): Promise<void> => {
  recordSequence += 1;
  await appendFile(
    wirePath,
    `${redact(JSON.stringify({ sequence: recordSequence, time: Date.now(), ...entry }))}\n`,
  );
};

const cappedBody = (body: Buffer, limit = 4_000): unknown => {
  if (body.length === 0) return undefined;
  const raw = body.toString("utf8");
  if (raw.length > limit) return `${raw.slice(0, limit)}…[${body.length} bytes]`;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const loadRules = async (): Promise<void> => {
  try {
    const parsed = JSON.parse(await readFile(rulesPath, "utf8")) as RuleFile;
    if (parsed.version === rulesVersion) return;
    rulesVersion = parsed.version;
    rules = (parsed.rules ?? []).map((rule) => ({
      ...rule,
      uses: 0,
      ...(rule.pathPattern ? { pathRegex: new RegExp(rule.pathPattern) } : {}),
    }));
    await record({
      kind: "rules-loaded",
      version: rulesVersion,
      ruleIds: rules.map((rule) => rule.id),
    });
  } catch (error) {
    if (rulesVersion < 0) {
      rulesVersion = 0;
      rules = [];
      await record({ kind: "rules-loaded", version: 0, ruleIds: [], note: String(error) });
    }
  }
};

const selectRule = async (
  method: string,
  path: string,
  body: Buffer,
): Promise<ActiveRule | undefined> => {
  await loadRules();
  for (const rule of rules) {
    if (rule.method && rule.method !== method) continue;
    if (rule.pathRegex && !rule.pathRegex.test(path)) continue;
    if (rule.bodyIncludes && !body.toString("utf8").includes(rule.bodyIncludes)) continue;
    if (rule.maxUses !== undefined && rule.uses >= rule.maxUses) continue;
    rule.uses += 1;
    return rule;
  }
  return undefined;
};

const waitForRealServer = async (child: ChildProcess): Promise<{ port: number; buffered: string }> => {
  let buffered = "";
  return await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error(`real OpenCode listen timeout: ${buffered.slice(-500)}`)),
      30_000,
    );
    const onData = (chunk: Buffer): void => {
      const text = redact(chunk.toString());
      buffered += text;
      void appendFile(opencodeLogPath, text);
      const match = buffered.match(/opencode server listening on https?:\/\/[^\s:]+:(\d+)/i);
      if (!match) return;
      clearTimeout(timeout);
      resolveReady({ port: Number(match[1]), buffered });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(`real OpenCode exited before listen: code=${String(code)} signal=${String(signal)}`));
    });
  });
};

const real = spawn(realBin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
const ready = await waitForRealServer(real);
const target = { hostname: "127.0.0.1", port: ready.port };

const resetSocket = (socket: Socket | null | undefined): void => {
  if (!socket || socket.destroyed) return;
  if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
  else socket.destroy();
};

const relayHeaders = (
  res: ServerResponse,
  status: number,
  headers: IncomingMessage["headers"],
  contentLength?: number,
): void => {
  const next = { ...headers };
  delete next.connection;
  delete next["keep-alive"];
  delete next["transfer-encoding"];
  if (contentLength !== undefined) next["content-length"] = String(contentLength);
  res.writeHead(status, next);
};

const proxy = createServer((req, res) => {
  const connectionId = ++connectionSequence;
  const method = req.method ?? "GET";
  const path = req.url ?? "/";
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    void (async () => {
      if (res.socket) activeSockets.set(res.socket, `${method} ${path}`);
      const rule = await selectRule(method, path, body);
      const action = rule?.action ?? { kind: "pass" as const };
      const operationId = typeof req.headers["x-polyth-operation-id"] === "string"
        ? req.headers["x-polyth-operation-id"]
        : undefined;
      await record({
        kind: "request",
        connectionId,
        method,
        path,
        bytes: body.length,
        body: cappedBody(body),
        operationId,
        ruleId: rule?.id,
        action: action.kind,
      });

      if (action.kind === "synthetic") {
        const encoded = Buffer.from(
          typeof action.body === "string" ? action.body : JSON.stringify(action.body ?? {}),
        );
        res.writeHead(action.status ?? 200, {
          "content-type": "application/json",
          "content-length": String(encoded.length),
          ...(action.headers ?? {}),
        });
        res.end(encoded);
        await record({
          kind: "fault",
          connectionId,
          ruleId: rule?.id,
          action: action.kind,
          status: action.status ?? 200,
          bytes: encoded.length,
        });
        return;
      }
      if (action.kind === "blackhole") {
        if (res.socket) activeSockets.set(res.socket, `${method} ${path}`);
        await record({ kind: "fault", connectionId, ruleId: rule?.id, action: action.kind });
        return;
      }

      const upstream = httpRequest({
        hostname: target.hostname,
        port: target.port,
        method,
        path,
        headers: { ...req.headers, host: `${target.hostname}:${target.port}` },
      });
      upstream.on("response", (upstreamRes) => {
        const eventStream = /^\/(?:api\/)?event(?:\?|$)/.test(path);
        if (eventStream && action.kind === "pass") {
          const status = upstreamRes.statusCode ?? 502;
          relayHeaders(res, status, upstreamRes.headers);
          void record({
            kind: "upstream-stream",
            connectionId,
            method,
            path,
            status,
            operationId,
            ruleId: rule?.id,
          });
          upstreamRes.on("data", (chunk: Buffer) => {
            if (!res.destroyed) res.write(chunk);
          });
          upstreamRes.on("end", () => {
            if (!res.destroyed) res.end();
          });
          upstreamRes.on("error", (error) => {
            void record({
              kind: "upstream-error",
              connectionId,
              method,
              path,
              note: String(error),
            });
            resetSocket(res.socket);
          });
          return;
        }
        const responseChunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => responseChunks.push(chunk));
        upstreamRes.on("end", () => {
          void (async () => {
            const responseBody = Buffer.concat(responseChunks);
            const status = upstreamRes.statusCode ?? 502;
            await record({
              kind: "upstream-response",
              connectionId,
              method,
              path,
              status,
              bytes: responseBody.length,
              body: cappedBody(responseBody, 2_000),
              operationId,
              ruleId: rule?.id,
            });

            if (action.kind === "drop-before-headers") {
              if ((action.delayMs ?? 0) > 0) {
                await new Promise((resolveDelay) => setTimeout(resolveDelay, action.delayMs));
              }
              await record({
                kind: "fault",
                connectionId,
                ruleId: rule?.id,
                action: action.kind,
                delayMs: action.delayMs ?? 0,
                boundary: "upstream response complete; no downstream headers",
              });
              resetSocket(res.socket);
              return;
            }

            if (action.kind === "partial-body-reset") {
              const partialBytes = Math.max(
                1,
                Math.min(action.partialBytes ?? 13, Math.max(1, responseBody.length - 1)),
              );
              relayHeaders(res, status, upstreamRes.headers, responseBody.length);
              const sent = responseBody.subarray(0, partialBytes);
              res.write(sent);
              await record({
                kind: "fault",
                connectionId,
                ruleId: rule?.id,
                action: action.kind,
                status,
                upstreamBytes: responseBody.length,
                downstreamBodyBytes: sent.length,
                boundary: "2xx headers and partial body written; TCP reset",
              });
              setImmediate(() => resetSocket(res.socket));
              return;
            }

            if (action.kind === "delay-response") {
              await record({
                kind: "fault",
                connectionId,
                ruleId: rule?.id,
                action: action.kind,
                delayMs: action.delayMs ?? 0,
                boundary: "upstream response complete; downstream response held",
              });
              await new Promise((resolveDelay) => setTimeout(resolveDelay, action.delayMs ?? 0));
              if (!res.destroyed) {
                relayHeaders(res, status, upstreamRes.headers, responseBody.length);
                res.end(responseBody);
              }
              await record({
                kind: "fault-release",
                connectionId,
                ruleId: rule?.id,
                downstreamAlreadyClosed: res.destroyed,
              });
              return;
            }

            relayHeaders(res, status, upstreamRes.headers, responseBody.length);
            res.end(responseBody);
          })();
        });
      });
      upstream.on("error", (error) => {
        void record({ kind: "upstream-error", connectionId, method, path, note: String(error) });
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.end(body);
    })().catch((error) => {
      void record({ kind: "shim-error", connectionId, method, path, note: String(error) });
      resetSocket(res.socket);
    });
  });
});

proxy.on("connection", (socket) => {
  activeSockets.set(socket, "unclassified");
  socket.on("close", () => activeSockets.delete(socket));
});
await new Promise<void>((resolveListen, rejectListen) => {
  proxy.once("error", rejectListen);
  proxy.listen(listenPort, hostname, resolveListen);
});

await writeFile(statePath, JSON.stringify({
  shimPid: process.pid,
  opencodePid: real.pid,
  proxyUrl: `http://${hostname}:${listenPort}`,
  targetUrl: `http://${target.hostname}:${target.port}`,
  cwd: process.cwd(),
  configDir: process.env.OPENCODE_CONFIG_DIR,
  xdgDataHome: process.env.XDG_DATA_HOME,
  startedAt: Date.now(),
}, null, 2));
await record({
  kind: "process-start",
  shimPid: process.pid,
  opencodePid: real.pid,
  listenPort,
  targetPort: target.port,
});

// This is the only listening line Polyth sees. The real child's line remains
// in the bounded raw log so the proxy cannot accidentally be bypassed.
console.log(`opencode server listening on http://${hostname}:${listenPort}`);

const stopExactChild = async (): Promise<void> => {
  if (real.exitCode !== null || real.signalCode !== null) return;
  real.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => real.once("exit", () => resolveExit())),
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 3_000)),
  ]);
  if (real.exitCode === null && real.signalCode === null) real.kill("SIGKILL");
};

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  await record({ kind: "process-stop", signal, shimPid: process.pid, opencodePid: real.pid });
  for (const socket of activeSockets.keys()) socket.destroy();
  await new Promise<void>((resolveClose) => proxy.close(() => resolveClose()));
  await stopExactChild();
  process.exit(0);
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGUSR1", () => {
  let destroyed = 0;
  for (const [socket, label] of activeSockets) {
    if (!label.startsWith("GET /event") && !label.startsWith("GET /api/event")) continue;
    socket.destroy();
    destroyed += 1;
  }
  void record({
    kind: "control",
    signal: "SIGUSR1",
    action: "destroy-sse-sockets",
    destroyed,
  });
});
real.once("exit", (code, signal) => {
  if (shuttingDown) return;
  void record({ kind: "real-opencode-exit", code, signal }).finally(() => process.exit(code ?? 1));
});

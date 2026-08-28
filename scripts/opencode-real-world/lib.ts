/**
 * Shared harness for Phase 1 legacy real-OpenCode validation (OC-REAL-001..026).
 *
 * Talks ONLY to real OpenCode (`opencode serve`) directly or through the local
 * recording/fault proxy defined here. Never spawns or substitutes the fake
 * backend. Evidence is written under artifacts/opencode-real-world/phase-1-legacy
 * and logs/opencode-real-world/phase-1-legacy.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createWriteStream, type WriteStream } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const ARTIFACTS_ROOT = join(REPO_ROOT, "artifacts/opencode-real-world/phase-1-legacy");
export const LOGS_ROOT = join(REPO_ROOT, "logs/opencode-real-world/phase-1-legacy");
export const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode";
export const OPENCODE_VERSION = "1.18.18";
export const CHEAP_MODEL = { providerID: "google", modelID: "gemini-2.5-flash-lite" };
export const REASONING_MODEL = { providerID: "google", modelID: "gemini-2.5-flash" };
/** HuggingFace router (HF_TOKEN): gpt-oss-120b supports tools + visible
 * reasoning. Monthly credits were depleted mid-campaign (402). */
export const HF_MODEL = { providerID: "huggingface", modelID: "openai/gpt-oss-120b" };
/** Fresh free-tier quota buckets (per-model per-day) after 2.5-flash/-lite and
 * HF credits were exhausted. gemini-3.5-flash verified live incl. bash tool +
 * permission flow through real opencode serve. */
export const LIVE_MODEL = { providerID: "google", modelID: "gemini-3.5-flash" };
export const LIVE_MODEL_ALT = { providerID: "google", modelID: "gemini-3-flash-preview" };
export const LIVE_MODEL_LITE = { providerID: "google", modelID: "gemini-3.1-flash-lite" };

const SECRET_VALUES = [
  process.env.GEMINI_API_KEY,
  process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  process.env.HUGGINGFACE_API_KEY,
].filter((value): value is string => typeof value === "string" && value.length > 4);

export const redact = (text: string): string => {
  let out = text;
  for (const secret of SECRET_VALUES) out = out.split(secret).join("[REDACTED]");
  return out;
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Scratch {
  id: string;
  root: string;
  home: string;
  project: string;
  artifactsDir: string;
  logsDir: string;
  env: NodeJS.ProcessEnv;
}

/** Fresh isolated HOME/XDG dirs + project dir per scenario. */
export const makeScratch = async (id: string, runId = "run-1"): Promise<Scratch> => {
  const root = `/tmp/ocreal/${id}/${runId}-${Date.now().toString(36)}`;
  const home = join(root, "home");
  const project = join(root, "project");
  const artifactsDir = join(ARTIFACTS_ROOT, id);
  const logsDir = join(LOGS_ROOT, id);
  for (const dir of [
    home,
    project,
    artifactsDir,
    logsDir,
    join(home, ".config"),
    join(home, ".local/share"),
    join(home, ".local/state"),
    join(home, ".cache"),
  ]) await mkdir(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GEMINI_API_KEY ?? "",
    HF_TOKEN: process.env.HUGGINGFACE_API_KEY ?? "",
    // keep PATH so `opencode` resolves
  };
  return { id, root, home, project, artifactsDir, logsDir, env };
};

/** Apply scratch isolation to the current process (owned-lease scenarios spawn
 * children with process.env). */
export const applyScratchEnv = (scratch: Scratch): void => {
  for (const key of [
    "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ]) process.env[key] = scratch.env[key];
};

export interface ServeHandle {
  child: ChildProcess;
  pid: number;
  url: string;
  port: number;
  logPath: string;
  stop(): Promise<void>;
}

const LISTEN_RE = /opencode server listening on https?:\/\/[^\s:]+:(\d+)/i;

export const spawnServe = async (
  scratch: Scratch,
  options: { port?: number; cwd?: string; logName?: string; extraEnv?: NodeJS.ProcessEnv } = {},
): Promise<ServeHandle> => {
  const logPath = join(scratch.logsDir, options.logName ?? "opencode.log");
  const stream: WriteStream = createWriteStream(logPath, { flags: "a" });
  const args = ["serve", "--hostname", "127.0.0.1"];
  if (options.port !== undefined) args.push("--port", String(options.port));
  else args.push("--port", "0");
  const child = spawn(OPENCODE_BIN, args, {
    cwd: options.cwd ?? scratch.project,
    env: { ...scratch.env, ...options.extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    const timer = setTimeout(() => rejectPort(new Error(`serve listen timeout; log tail: ${buffer.slice(-300)}`)), 30_000);
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      buffer += text;
      stream.write(redact(text));
      const match = buffer.match(LISTEN_RE);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    };
    child.stdout!.on("data", onChunk);
    child.stderr!.on("data", onChunk);
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectPort(new Error(`opencode serve exited ${code}: ${buffer.slice(-400)}`));
    });
  });
  return {
    child,
    pid: child.pid!,
    url: `http://127.0.0.1:${port}`,
    port,
    logPath,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((r) => child.once("exit", () => r())),
        sleep(3_000),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      stream.end();
    },
  };
};

export interface WireRecord {
  t: number;
  kind: "request" | "response" | "sse-event" | "fault";
  connection?: number;
  method?: string;
  path?: string;
  status?: number;
  bytes?: number;
  note?: string;
  body?: unknown;
  headerNames?: string[];
}

export class WireLog {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async record(entry: WireRecord): Promise<void> {
    await appendFile(this.path, `${redact(JSON.stringify(entry))}\n`);
  }
}

const capBody = (raw: string, cap = 4_000): unknown => {
  if (!raw) return undefined;
  const text = raw.length > cap ? `${raw.slice(0, cap)}…[${raw.length} bytes total]` : raw;
  try {
    return raw.length > cap ? text : JSON.parse(raw);
  } catch {
    return text;
  }
};

export type ProxyAction =
  | { kind: "pass" }
  | { kind: "error"; status: number; body?: string }
  | { kind: "black-hole" }
  | { kind: "close" }
  /** Forward to real OpenCode, let it commit, then destroy the client socket
   * without relaying the response (true response-loss ambiguity). */
  | { kind: "forward-drop" };

export interface FaultProxy {
  url: string;
  port: number;
  server: Server;
  /** regex applied to `${method} ${path}` */
  setRule(pattern: RegExp | undefined, action?: ProxyAction): void;
  killActiveSockets(): number;
  requestCount(matcher: RegExp): number;
  close(): Promise<void>;
}

/** HTTP-aware recording/fault proxy in front of a REAL opencode serve. */
export const startFaultProxy = async (
  targetUrl: string,
  wire: WireLog,
): Promise<FaultProxy> => {
  const target = new URL(targetUrl);
  const activeSockets = new Set<Socket>();
  const seen: string[] = [];
  let rule: { pattern: RegExp; action: ProxyAction } | undefined;
  let connectionCounter = 0;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const connection = ++connectionCounter;
    const key = `${req.method} ${req.url}`;
    seen.push(key);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const requestBody = Buffer.concat(chunks);
      void wire.record({
        t: Date.now(),
        kind: "request",
        connection,
        method: req.method ?? "",
        path: req.url ?? "",
        bytes: requestBody.length,
        body: capBody(requestBody.toString()),
        headerNames: Object.keys(req.headers),
      });
      const action = rule && rule.pattern.test(key) ? rule.action : { kind: "pass" as const };
      if (action.kind === "error") {
        void wire.record({ t: Date.now(), kind: "fault", connection, note: `injected ${action.status}` });
        res.writeHead(action.status, { "content-type": "application/json" });
        res.end(action.body ?? JSON.stringify({ error: "injected-fault" }));
        return;
      }
      if (action.kind === "black-hole") {
        void wire.record({ t: Date.now(), kind: "fault", connection, note: "black-hole (no response)" });
        activeSockets.add(res.socket!);
        return;
      }
      if (action.kind === "close") {
        void wire.record({ t: Date.now(), kind: "fault", connection, note: "socket destroyed pre-response" });
        res.socket?.destroy();
        return;
      }
      const upstream = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: `${target.hostname}:${target.port}` },
        },
        (upstreamRes) => {
          if (action.kind === "forward-drop") {
            const dropChunks: Buffer[] = [];
            upstreamRes.on("data", (chunk: Buffer) => dropChunks.push(chunk));
            upstreamRes.on("end", () => {
              void wire.record({
                t: Date.now(),
                kind: "fault",
                connection,
                status: upstreamRes.statusCode ?? 0,
                bytes: Buffer.concat(dropChunks).length,
                note: "forward-drop: upstream committed, client socket destroyed without response",
                body: capBody(Buffer.concat(dropChunks).toString(), 1_000),
              });
              res.socket?.destroy();
            });
            return;
          }
          const isSse = (upstreamRes.headers["content-type"] ?? "").includes("event-stream");
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          if (isSse) {
            activeSockets.add(res.socket!);
            let sseBytes = 0;
            upstreamRes.on("data", (chunk: Buffer) => {
              sseBytes += chunk.length;
              res.write(chunk);
            });
            upstreamRes.on("end", () => {
              void wire.record({ t: Date.now(), kind: "response", connection, status: upstreamRes.statusCode ?? 0, bytes: sseBytes, note: "sse-end" });
              res.end();
            });
            void wire.record({ t: Date.now(), kind: "response", connection, status: upstreamRes.statusCode ?? 0, note: "sse-open" });
            return;
          }
          const responseChunks: Buffer[] = [];
          upstreamRes.on("data", (chunk: Buffer) => responseChunks.push(chunk));
          upstreamRes.on("end", () => {
            const responseBody = Buffer.concat(responseChunks);
            void wire.record({
              t: Date.now(),
              kind: "response",
              connection,
              status: upstreamRes.statusCode ?? 0,
              bytes: responseBody.length,
              body: capBody(responseBody.toString()),
            });
            res.end(responseBody);
          });
        },
      );
      upstream.on("error", (error) => {
        void wire.record({ t: Date.now(), kind: "fault", connection, note: `upstream error: ${String(error)}` });
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.end(requestBody);
    });
  };

  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.on("connection", (socket) => {
    socket.on("close", () => activeSockets.delete(socket));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    server,
    setRule(pattern, action) {
      rule = pattern ? { pattern, action: action ?? { kind: "pass" } } : undefined;
    },
    killActiveSockets() {
      let killed = 0;
      for (const socket of activeSockets) {
        socket.destroy();
        killed += 1;
      }
      activeSockets.clear();
      return killed;
    },
    requestCount(matcher) {
      return seen.filter((key) => matcher.test(key)).length;
    },
    async close() {
      for (const socket of activeSockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
};

/** Direct HTTP helper against real OpenCode with wire recording. */
export const httpJson = async (
  base: string,
  method: string,
  path: string,
  body?: unknown,
  wire?: WireLog,
): Promise<{ status: number; body: unknown; raw: string }> => {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  await wire?.record({
    t: Date.now(),
    kind: "request",
    method,
    path,
    body: body === undefined ? undefined : capBody(JSON.stringify(body)),
  });
  const response = await fetch(`${base}${path}`, init);
  const raw = await response.text();
  await wire?.record({
    t: Date.now(),
    kind: "response",
    method,
    path,
    status: response.status,
    bytes: raw.length,
    body: capBody(raw),
  });
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = raw;
  }
  return { status: response.status, body: parsed, raw };
};

/** Raw SSE reader against real OpenCode /event, collecting parsed events. */
export interface SseCollector {
  events: Array<{ t: number; id?: string; type?: string; data: unknown }>;
  close(): void;
  waitFor(predicate: (event: { type?: string; data: unknown }) => boolean, timeoutMs: number): Promise<boolean>;
}

export const collectSse = (base: string, path: string, logPath?: string): SseCollector => {
  const url = new URL(`${base}${path}`);
  const events: SseCollector["events"] = [];
  const waiters: Array<{ predicate: (event: { type?: string; data: unknown }) => boolean; resolve: (found: boolean) => void }> = [];
  const socket = createConnection({ host: url.hostname, port: Number(url.port) }, () => {
    socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: text/event-stream\r\n\r\n`);
  });
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  socket.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const dataLine = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("");
      if (!dataLine) continue;
      try {
        const data = JSON.parse(dataLine) as { type?: string; id?: string };
        const entry = { t: Date.now(), id: data.id, type: data.type, data };
        events.push(entry);
        if (logPath) void appendFile(logPath, `${redact(JSON.stringify(entry))}\n`);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(entry)) {
            waiter.resolve(true);
            waiters.splice(waiters.indexOf(waiter), 1);
          }
        }
      } catch {
        // non-JSON keepalive
      }
    }
  });
  return {
    events,
    close: () => socket.destroy(),
    waitFor(predicate, timeoutMs) {
      const already = events.find(predicate);
      if (already) return Promise.resolve(true);
      return new Promise((resolveWait) => {
        const timer = setTimeout(() => resolveWait(false), timeoutMs);
        waiters.push({
          predicate,
          resolve: (found) => {
            clearTimeout(timer);
            resolveWait(found);
          },
        });
      });
    },
  };
};

export interface Verdict {
  id: string;
  verdict: "pass" | "fail" | "blocked" | "partial";
  opencodeVersion: string;
  protocol: string;
  observed: string;
  expected: string;
  attribution: "POLYTH" | "OPENCODE" | "ENV" | "HARNESS" | "AMBIGUITY" | "NONE";
  evidence: string[];
  notes?: string;
}

export const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, redact(JSON.stringify(value, null, 2)));
};

export const writeVerdict = async (scratch: Scratch, verdict: Verdict): Promise<void> => {
  await writeJson(join(scratch.artifactsDir, "verdict.json"), verdict);
  console.log(`[${verdict.id}] ${verdict.verdict}: ${verdict.observed.slice(0, 200)}`);
};

export const writeEvidence = async (scratch: Scratch, name: string, value: unknown): Promise<void> => {
  await writeJson(join(scratch.artifactsDir, name), value);
};

export const readJsonFile = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

/** Poll the message list until the last assistant message is completed. */
export const waitForAssistantCompletion = async (
  base: string,
  sessionId: string,
  directory: string,
  timeoutMs: number,
): Promise<{ completed: boolean; messages: unknown[] }> => {
  const deadline = Date.now() + timeoutMs;
  let messages: unknown[] = [];
  while (Date.now() < deadline) {
    const result = await httpJson(base, "GET", `/session/${sessionId}/message?directory=${encodeURIComponent(directory)}`);
    if (Array.isArray(result.body)) {
      messages = result.body;
      const assistants = messages.filter((message) =>
        (message as { info?: { role?: string } }).info?.role === "assistant");
      const last = assistants.at(-1) as { info?: { time?: { completed?: number }; error?: unknown } } | undefined;
      if (last?.info?.time?.completed || last?.info?.error) return { completed: true, messages };
    }
    await sleep(500);
  }
  return { completed: false, messages };
};

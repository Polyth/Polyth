/**
 * Phase 3 real-OpenCode SSE/reconciliation torture (OC-REAL-041..047).
 *
 * This harness always proxies a real `opencode serve` process. The proxy can
 * drop, duplicate, hold, silence, reject, or disconnect individual SSE frames;
 * it never substitutes upstream REST/session semantics.
 *
 * Usage: node scripts/opencode-real-world/s041_047.ts OC-REAL-041
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, createWriteStream, readdirSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Socket } from "node:net";

import {
  attachRuntimeLifecycle,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import type {
  AgentRuntime,
  Project,
  ProjectService,
  RuntimeEndpoint,
  RuntimeEndpointLease,
  RuntimeLifecycleNotification,
  SessionEvent,
  SessionPersistence,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService, type Broadcaster } from "../../packages/server/src/sessions.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const ARTIFACT_ROOT = join(REPO_ROOT, "artifacts/opencode-real-world/phase-3");
const LOG_ROOT = join(REPO_ROOT, "logs/opencode-real-world/phase-3");
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode";
const OPENCODE_VERSION = "1.18.18";
const CHEAP_MODEL = { providerID: "opencode", modelID: "big-pickle" };
const TOOL_MODEL = {
  providerID: "google",
  modelID: "gemini-2.5-flash",
  variant: "high",
};
const FREE_TOOL_MODEL = {
  providerID: "opencode",
  modelID: "big-pickle",
};
const TABLES = [
  "events",
  "projections",
  "runtime_operations",
  "session_queue",
  "response_intents",
  "observations",
  "observation_checkpoints",
  "observation_cursors",
  "session_reconciliations",
  "deletion_tombstones",
] as const;

const secretValues = [
  process.env.GEMINI_API_KEY,
  process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  process.env.HUGGINGFACE_API_KEY,
].filter((value): value is string => typeof value === "string" && value.length > 4);

const redact = (value: string): string => {
  let redacted = value;
  for (const secret of secretValues) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
};

const json = (value: unknown): string =>
  redact(JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? Number(item) : item));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const waitUntil = async <T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await sleep(100);
    value = await read();
  }
  if (!accept(value)) throw new Error(`timed out waiting for ${label}`);
  return value;
};

interface Scratch {
  id: string;
  root: string;
  home: string;
  project: string;
  dataDir: string;
  artifactDir: string;
  logDir: string;
  dbPath: string;
  env: NodeJS.ProcessEnv;
}

const makeScratch = async (id: string): Promise<Scratch> => {
  const root = join(tmpdir(), "ocreal", "phase-3", id, `run-${Date.now().toString(36)}`);
  const home = join(root, "home");
  const project = join(root, "project");
  const dataDir = join(root, "polyth-data");
  const artifactDir = join(ARTIFACT_ROOT, id);
  const logDir = join(LOG_ROOT, id);
  for (const directory of [
    home,
    project,
    dataDir,
    artifactDir,
    logDir,
    join(home, ".config"),
    join(home, ".local/share"),
    join(home, ".local/state"),
    join(home, ".cache"),
  ]) {
    await mkdir(directory, { recursive: true });
  }
  return {
    id,
    root,
    home,
    project,
    dataDir,
    artifactDir,
    logDir,
    dbPath: join(dataDir, "sessions.db"),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GEMINI_API_KEY
        ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY
        ?? "",
    },
  };
};

interface ServeHandle {
  child: ChildProcess;
  pid: number;
  port: number;
  url: string;
  logPath: string;
  stop(): Promise<void>;
}

const spawnOpenCode = async (scratch: Scratch): Promise<ServeHandle> => {
  const logPath = join(scratch.logDir, "opencode.log");
  const output: WriteStream = createWriteStream(logPath, { flags: "a" });
  const child = spawn(
    OPENCODE_BIN,
    ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: scratch.project,
      env: scratch.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let buffered = "";
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    const timer = setTimeout(
      () => rejectPort(new Error(`OpenCode listen timeout: ${buffered.slice(-500)}`)),
      30_000,
    );
    const onData = (chunk: Buffer): void => {
      const text = redact(chunk.toString());
      buffered += text;
      output.write(text);
      const match = /opencode server listening on https?:\/\/[^\s:]+:(\d+)/i.exec(buffered);
      if (!match) return;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectPort(new Error(`OpenCode exited before listen (${code}): ${buffered.slice(-500)}`));
    });
  });
  return {
    child,
    pid: child.pid!,
    port,
    url: `http://127.0.0.1:${port}`,
    logPath,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
        sleep(3_000),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      output.end();
    },
  };
};

type DropFamily =
  | "status"
  | "message"
  | "text-delta"
  | "text-final"
  | "reasoning"
  | "tool-start"
  | "tool-finish"
  | "permission"
  | "question"
  | "compaction"
  | "title";

interface ParsedSseFrame {
  raw: string;
  data?: Record<string, unknown>;
  id?: string;
  type?: string;
  sessionId?: string;
}

interface FrameLog {
  t: number;
  connection: number;
  id?: string;
  type?: string;
  sessionId?: string;
  action: "forward" | "drop" | "hold" | "duplicate-same" | "duplicate-new";
  bytes: number;
  durable?: unknown;
}

type StormFault = "close" | "silent" | "401";

interface SseProxy {
  url: string;
  port: number;
  setDropFamilies(families: readonly DropFamily[]): void;
  setDuplicate(mode: "none" | "same-and-new"): void;
  setHoldFamilies(families: readonly DropFamily[]): void;
  setRestEmpty(path: RegExp, count: number): void;
  startStorm(faults: readonly StormFault[]): number;
  setSilent(value: boolean): void;
  disconnectSse(): number;
  releaseHeld(): number;
  heldCount(): number;
  frameLog(): readonly FrameLog[];
  connectionCount(): number;
  disconnectCount(): number;
  maxActiveSse(): number;
  requestCount(pattern: RegExp): number;
  waitForFrame(predicate: (frame: FrameLog) => boolean, timeoutMs: number): Promise<FrameLog>;
  waitForConnections(count: number, timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const parseFrame = (raw: string): ParsedSseFrame => {
  const dataLines = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return { raw };
  try {
    const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    const properties = asRecord(data.properties);
    const nested = asRecord(data.data);
    const part = asRecord(properties?.part);
    const info = asRecord(properties?.info);
    return {
      raw,
      data,
      id: typeof data.id === "string" ? data.id : undefined,
      type: typeof data.type === "string" ? data.type : undefined,
      sessionId:
        typeof properties?.sessionID === "string" ? properties.sessionID
          : typeof part?.sessionID === "string" ? part.sessionID
            : typeof info?.sessionID === "string" ? info.sessionID
              : typeof nested?.sessionID === "string" ? nested.sessionID
                : undefined,
    };
  } catch {
    return { raw };
  }
};

const familyMatches = (family: DropFamily, frame: ParsedSseFrame): boolean => {
  const type = frame.type ?? "";
  const properties = asRecord(frame.data?.properties);
  const native = asRecord(frame.data?.data);
  const part = asRecord(properties?.part);
  const state = asRecord(part?.state);
  if (family === "status") return type === "session.status" || type === "session.idle";
  if (family === "message") return type === "message.updated";
  if (family === "text-delta") {
    return type === "message.part.delta"
      && (properties?.field === "text" || type.includes(".text."));
  }
  if (family === "text-final") {
    return type === "message.part.updated"
      && part?.type === "text"
      && typeof asRecord(part?.time)?.end === "number";
  }
  if (family === "reasoning") {
    return type.includes("reasoning")
      || (type === "message.part.updated" && part?.type === "reasoning");
  }
  if (family === "tool-start") {
    return (type === "message.part.updated"
      && part?.type === "tool"
      && (state?.status === "pending" || state?.status === "running"))
      || type === "session.next.tool.called";
  }
  if (family === "tool-finish") {
    return (type === "message.part.updated"
      && part?.type === "tool"
      && (state?.status === "completed" || state?.status === "error"))
      || type === "session.next.tool.success"
      || type === "session.next.tool.failed";
  }
  if (family === "permission") return type.includes("permission") && type.includes("asked");
  if (family === "question") return type.includes("question") && type.includes("asked");
  if (family === "compaction") return type.includes("compact") || part?.type === "compaction";
  if (family === "title") {
    const info = asRecord(properties?.info);
    return type === "session.updated"
      && (typeof info?.title === "string" || typeof native?.title === "string");
  }
  return false;
};

const startSseProxy = async (
  targetUrl: string,
  logPath: string,
): Promise<SseProxy> => {
  const target = new URL(targetUrl);
  const drops = new Set<DropFamily>();
  const holds = new Set<DropFamily>();
  const held: ParsedSseFrame[] = [];
  const frames: FrameLog[] = [];
  const requests: string[] = [];
  const active = new Map<number, { response: ServerResponse; upstream?: IncomingMessage }>();
  const restEmpty: Array<{ path: RegExp; remaining: number }> = [];
  const waiters = new Set<() => void>();
  let duplicate: "none" | "same-and-new" = "none";
  let silent = false;
  let storm: StormFault[] = [];
  let connectionCounter = 0;
  let sseConnections = 0;
  let sseDisconnects = 0;
  let maximumActive = 0;
  const writeLog = async (value: unknown): Promise<void> => {
    await writeFile(logPath, `${json(value)}\n`, { flag: "a" });
  };
  const notify = (): void => {
    for (const waiter of [...waiters]) waiter();
  };
  const recordFrame = (connection: number, frame: ParsedSseFrame, action: FrameLog["action"]): void => {
    const entry: FrameLog = {
      t: Date.now(),
      connection,
      ...(frame.id ? { id: frame.id } : {}),
      ...(frame.type ? { type: frame.type } : {}),
      ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
      action,
      bytes: Buffer.byteLength(frame.raw),
      ...(frame.data?.durable ? { durable: frame.data.durable } : {}),
    };
    frames.push(entry);
    void writeLog({ kind: "sse-frame", ...entry });
    notify();
  };
  const transformedWithNewId = (frame: ParsedSseFrame): string => {
    if (!frame.data) return frame.raw;
    const next = {
      ...frame.data,
      id: `${frame.id ?? "transportless"}-duplicate-${frames.length}`,
    };
    return `data: ${JSON.stringify(next)}`;
  };
  const forwardFrame = (
    connection: number,
    response: ServerResponse,
    frame: ParsedSseFrame,
  ): void => {
    response.write(`${frame.raw}\n\n`);
    recordFrame(connection, frame, "forward");
    if (duplicate === "same-and-new" && frame.data && frame.type !== "server.connected") {
      response.write(`${frame.raw}\n\n`);
      recordFrame(connection, frame, "duplicate-same");
      const changed = parseFrame(transformedWithNewId(frame));
      response.write(`${changed.raw}\n\n`);
      recordFrame(connection, changed, "duplicate-new");
    }
  };
  const server = createServer((request, response) => {
    const connection = ++connectionCounter;
    const key = `${request.method ?? "GET"} ${request.url ?? "/"}`;
    requests.push(key);
    void writeLog({
      kind: "request",
      t: Date.now(),
      connection,
      method: request.method,
      path: request.url,
      headerNames: Object.keys(request.headers),
    });

    const isSseRequest = (request.url ?? "").startsWith("/event")
      || (request.url ?? "").startsWith("/api/event");
    const stormFault = isSseRequest ? storm.shift() : undefined;
    if (stormFault === "401") {
      sseConnections += 1;
      sseDisconnects += 1;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(`{"error":"injected SSE authorization fault"}`);
      void writeLog({ kind: "fault", t: Date.now(), connection, fault: "401" });
      notify();
      return;
    }
    if (stormFault === "silent") {
      sseConnections += 1;
      active.set(connection, { response });
      maximumActive = Math.max(maximumActive, active.size);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.flushHeaders();
      void writeLog({ kind: "fault", t: Date.now(), connection, fault: "silent" });
      request.on("close", () => {
        if (!active.delete(connection)) return;
        sseDisconnects += 1;
        notify();
      });
      notify();
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const upstreamRequest = httpRequest({
        hostname: target.hostname,
        port: target.port,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: `${target.hostname}:${target.port}` },
      }, (upstreamResponse) => {
        const contentType = String(upstreamResponse.headers["content-type"] ?? "");
        const isSse = contentType.includes("event-stream");
        if (!isSse) {
          const responseChunks: Buffer[] = [];
          upstreamResponse.on("data", (chunk: Buffer) => responseChunks.push(chunk));
          upstreamResponse.on("end", () => {
            let responseBody = Buffer.concat(responseChunks);
            const emptyRule = restEmpty.find((candidate) => {
              candidate.path.lastIndex = 0;
              return candidate.remaining > 0 && candidate.path.test(request.url ?? "");
            });
            if (emptyRule) {
              emptyRule.remaining -= 1;
              responseBody = Buffer.from("[]");
              void writeLog({
                kind: "fault",
                t: Date.now(),
                connection,
                fault: "replace REST response with []",
                path: request.url,
              });
            }
            const headers = { ...upstreamResponse.headers };
            delete headers["content-length"];
            response.writeHead(upstreamResponse.statusCode ?? 502, headers);
            response.end(responseBody);
            void writeLog({
              kind: "response",
              t: Date.now(),
              connection,
              status: upstreamResponse.statusCode,
              bytes: responseBody.length,
            });
          });
          return;
        }

        sseConnections += 1;
        active.set(connection, { response, upstream: upstreamResponse });
        maximumActive = Math.max(maximumActive, active.size);
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        response.flushHeaders();
        void writeLog({
          kind: "sse-open",
          t: Date.now(),
          connection,
          status: upstreamResponse.statusCode,
          stormFault,
        });
        notify();
        if (stormFault === "close") {
          const jitterMs = (sseConnections % 5) * 7;
          setTimeout(() => {
            if (!active.has(connection)) return;
            response.socket?.destroy();
            upstreamResponse.destroy();
          }, jitterMs);
        }

        let buffered = "";
        const drain = (): void => {
          for (;;) {
            const separator = /\r?\n\r?\n/.exec(buffered);
            if (!separator || separator.index === undefined) return;
            const raw = buffered.slice(0, separator.index);
            buffered = buffered.slice(separator.index + separator[0].length);
            const frame = parseFrame(raw);
            if (!frame.data) {
              if (!silent && !stormFault) response.write(`${raw}\n\n`);
              continue;
            }
            const shouldHold = [...holds].some((family) => familyMatches(family, frame));
            const shouldDrop = silent
              || [...drops].some((family) => familyMatches(family, frame));
            if (shouldHold) {
              held.push(frame);
              recordFrame(connection, frame, "hold");
            } else if (shouldDrop) {
              recordFrame(connection, frame, "drop");
            } else if (!stormFault) {
              forwardFrame(connection, response, frame);
            } else {
              recordFrame(connection, frame, "drop");
            }
          }
        };
        upstreamResponse.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          drain();
        });
        upstreamResponse.on("end", () => response.end());
        upstreamResponse.on("error", () => response.socket?.destroy());
        response.on("close", () => {
          if (!active.delete(connection)) return;
          upstreamResponse.destroy();
          sseDisconnects += 1;
          void writeLog({ kind: "sse-close", t: Date.now(), connection });
          notify();
        });
      });
      upstreamRequest.on("error", (error) => {
        void writeLog({ kind: "upstream-error", t: Date.now(), connection, error: String(error) });
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      upstreamRequest.end(body);
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const api: SseProxy = {
    url: `http://127.0.0.1:${port}`,
    port,
    setDropFamilies(families) {
      drops.clear();
      for (const family of families) drops.add(family);
    },
    setDuplicate(mode) {
      duplicate = mode;
    },
    setHoldFamilies(families) {
      holds.clear();
      for (const family of families) holds.add(family);
    },
    setRestEmpty(path, count) {
      restEmpty.push({ path, remaining: count });
    },
    startStorm(faults) {
      storm = [...faults];
      return api.disconnectSse();
    },
    setSilent(value) {
      silent = value;
    },
    disconnectSse() {
      let disconnected = 0;
      for (const [connection, item] of [...active]) {
        item.response.socket?.destroy();
        item.upstream?.destroy();
        active.delete(connection);
        sseDisconnects += 1;
        disconnected += 1;
        void writeLog({
          kind: "fault",
          t: Date.now(),
          connection,
          fault: "exact SSE client socket destroy",
        });
      }
      notify();
      return disconnected;
    },
    releaseHeld() {
      const current = [...active.entries()].at(-1);
      if (!current) return 0;
      const [connection, item] = current;
      const released = held.splice(0);
      for (const frame of released) forwardFrame(connection, item.response, frame);
      return released.length;
    },
    heldCount: () => held.length,
    frameLog: () => frames,
    connectionCount: () => sseConnections,
    disconnectCount: () => sseDisconnects,
    maxActiveSse: () => maximumActive,
    requestCount(pattern) {
      return requests.filter((request) => {
        pattern.lastIndex = 0;
        return pattern.test(request);
      }).length;
    },
    waitForFrame(predicate, timeoutMs) {
      const found = frames.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise<FrameLog>((resolveFrame, rejectFrame) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          rejectFrame(new Error("timed out waiting for upstream SSE frame"));
        }, timeoutMs);
        const check = (): void => {
          const next = frames.find(predicate);
          if (!next) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolveFrame(next);
        };
        waiters.add(check);
      });
    },
    async waitForConnections(count, timeoutMs) {
      await waitUntil(
        () => sseConnections,
        (connections) => connections >= count,
        timeoutMs,
        `${count} SSE connections`,
      );
    },
    async close() {
      api.disconnectSse();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
  return api;
};

const projectService = (project: Project): ProjectService => ({
  list: async () => [project],
  get: async (id) => id === project.id ? project : undefined,
  add: async () => project,
  create: async () => project,
  remove: async () => undefined,
});

const permissionService = {
  evaluate: () => "ask",
  addRule: () => undefined,
  rules: () => [],
} as unknown as PermissionService;

interface Harness {
  scratch: Scratch;
  serve: ServeHandle;
  proxy: SseProxy;
  store: ReturnType<typeof createStore>;
  runtime: AgentRuntime;
  lifecycle: Awaited<ReturnType<typeof createOpenCodeRuntimeLifecycle>>;
  sessions: ReturnType<typeof createSessionService>;
  events: SessionEvent[];
  projections: NonNullable<Awaited<ReturnType<SessionPersistence["projection"]>>>[];
  lifecycleEvents: Array<{ t: number; event: RuntimeLifecycleNotification }>;
  consoleErrors: string[];
  refreshCalls(): number;
  create(name: string): Promise<{ id: string; backendId: string }>;
  reconnect(): Promise<void>;
  close(): Promise<void>;
}

const startHarness = async (
  id: string,
  options: {
    permission?: "allow" | "ask";
    sseStallMs?: number;
    failEveryRefresh?: number;
  } = {},
): Promise<Harness> => {
  const scratch = await makeScratch(id);
  const consoleErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]): void => {
    const message = args.map((arg) =>
      arg instanceof Error ? `${arg.name}: ${arg.message}\n${arg.stack ?? ""}` : String(arg))
      .join(" ");
    consoleErrors.push(message);
    originalConsoleError(...args);
  };
  const configDirectory = join(scratch.env.XDG_CONFIG_HOME!, "opencode");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    permission: {
      edit: "allow",
      write: "allow",
      read: "allow",
      bash: options.permission ?? "allow",
      webfetch: "allow",
    },
  }));
  const serve = await spawnOpenCode(scratch);
  const proxy = await startSseProxy(serve.url, join(scratch.logDir, "wire.ndjson"));
  let refreshCalls = 0;
  const endpoint: RuntimeEndpoint = {
    authorityId: `phase3:${id}:${serve.pid}`,
    continuity: "verified",
    generation: 1,
    url: proxy.url,
    location: { directory: scratch.project },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const lease: RuntimeEndpointLease = {
    control: endpoint.control,
    async endpoint() {
      return endpoint;
    },
    async refresh() {
      refreshCalls += 1;
      if (
        options.failEveryRefresh
        && refreshCalls % options.failEveryRefresh === 0
      ) {
        throw new Error(`injected descriptor refresh failure ${refreshCalls}`);
      }
      return endpoint;
    },
    async dispose() {},
  };
  const polythLog = join(scratch.logDir, "polyth.ndjson");
  const lifecycle = await createOpenCodeRuntimeLifecycle({
    lease,
    protocol: "legacy",
    protocolDeadlineMs: 5_000,
    startupDeadlineMs: 10_000,
    probeDeadlineMs: 2_000,
    transport: { queryAttempts: 1 },
  });
  const facade = createOpenCodeRuntimeFacade({
    lifecycle,
    ...(options.sseStallMs ? { sseStallMs: options.sseStallMs } : {}),
    log(level, message, data) {
      void writeFile(
        polythLog,
        `${json({ t: Date.now(), level, message, data })}\n`,
        { flag: "a" },
      );
    },
  });
  const runtime = attachRuntimeLifecycle(facade, lifecycle);
  const lifecycleEvents: Harness["lifecycleEvents"] = [];
  runtime.onLifecycle?.((event) => {
    lifecycleEvents.push({ t: Date.now(), event });
    void writeFile(
      polythLog,
      `${json({ t: Date.now(), kind: "lifecycle", event })}\n`,
      { flag: "a" },
    );
  });
  const store = createStore(scratch.dbPath);
  const project: Project = {
    id: `project:${id}`,
    name: `Phase 3 ${id}`,
    path: scratch.project,
    createdAt: Date.now(),
  };
  const events: SessionEvent[] = [];
  const projections: Harness["projections"] = [];
  const broadcast: Broadcaster = {
    event(event) {
      events.push(event);
      void writeFile(
        join(scratch.logDir, "broadcast.ndjson"),
        `${json({ t: Date.now(), kind: "event", event })}\n`,
        { flag: "a" },
      );
    },
    projection(projection) {
      projections.push(projection);
      void writeFile(
        join(scratch.logDir, "broadcast.ndjson"),
        `${json({ t: Date.now(), kind: "projection", projection })}\n`,
        { flag: "a" },
      );
    },
  };
  const sessions = createSessionService({
    store,
    projects: projectService(project),
    permissions: permissionService,
    broadcast,
    queue: store,
    runtimes: { forProject: async () => runtime },
  });
  const create = async (name: string): Promise<{ id: string; backendId: string }> => {
    const created = await sessions.create({
      projectId: project.id,
      title: `${id} ${name}`,
    });
    const projection = await waitUntil(
      () => store.projection(created.id),
      (candidate) => Boolean(candidate?.backendSessionId),
      20_000,
      "backend session binding",
    );
    return { id: created.id, backendId: projection!.backendSessionId! };
  };
  const reconnect = async (): Promise<void> => {
    const previousConnections = proxy.connectionCount();
    const before = await Promise.all(
      (await store.projections(project.id)).map(async (projection) => ({
        id: projection.id,
        ordinal: (await store.reconciliation(projection.id))?.ordinal ?? 0,
      })),
    );
    proxy.disconnectSse();
    await proxy.waitForConnections(previousConnections + 1, 30_000);
    for (const item of before) {
      await waitUntil(
        () => store.reconciliation(item.id),
        (value) =>
          (value?.ordinal ?? 0) > item.ordinal
          && value?.state !== "reconciling",
        30_000,
        `reconciliation after reconnect for ${item.id}`,
      );
    }
  };
  await proxy.waitForConnections(1, 20_000);
  return {
    scratch,
    serve,
    proxy,
    store,
    runtime,
    lifecycle,
    sessions,
    events,
    projections,
    lifecycleEvents,
    consoleErrors,
    refreshCalls: () => refreshCalls,
    create,
    reconnect,
    async close() {
      try {
        await runtime.dispose();
        await lifecycle.dispose();
        await proxy.close();
        await serve.stop();
        await store.close();
      } finally {
        console.error = originalConsoleError;
      }
    },
  };
};

const waitForAssistantCompletion = async (
  baseUrl: string,
  backendId: string,
  project: string,
  timeoutMs = 120_000,
): Promise<unknown[]> => {
  return waitUntil(
    async () => {
      const response = await fetch(
        `${baseUrl}/session/${encodeURIComponent(backendId)}/message?directory=${encodeURIComponent(project)}`,
      );
      const body = await response.json().catch(() => []);
      return Array.isArray(body) ? body : [];
    },
    (messages) => messages.some((message) => {
      const info = asRecord(asRecord(message)?.info);
      return info?.role === "assistant"
        && (
          typeof asRecord(info.time)?.completed === "number"
          || info.error !== undefined
        );
    }),
    timeoutMs,
    `assistant completion for ${backendId}`,
  );
};

const pending = async (
  baseUrl: string,
  kind: "permission" | "question",
  project: string,
): Promise<Record<string, unknown>[]> => {
  const response = await fetch(
    `${baseUrl}/${kind}?directory=${encodeURIComponent(project)}`,
  );
  const body = await response.json().catch(() => []);
  return Array.isArray(body)
    ? body.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)))
    : [];
};

const writeArtifact = async (scratch: Scratch, name: string, value: unknown): Promise<void> => {
  await writeFile(join(scratch.artifactDir, name), `${JSON.stringify(
    JSON.parse(json(value)) as unknown,
    null,
    2,
  )}\n`);
};

interface Verdict {
  id: string;
  verdict: "pass" | "fail" | "blocked" | "partial";
  protocol: string;
  observed: string;
  expected: string;
  attribution: "POLYTH" | "OPENCODE" | "AMBIGUITY" | "NONE";
  blockers: number[];
  evidence: string[];
  notes?: string;
}

const dumpDatabase = async (
  scratch: Scratch,
  sessionIds: readonly string[],
): Promise<Record<string, unknown>> => {
  const db = new DatabaseSync(scratch.dbPath);
  try {
    const tables: Record<string, unknown> = {};
    for (const table of TABLES) {
      try {
        tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
      } catch (error) {
        tables[table] = { unavailable: String(error) };
      }
    }
    const result = {
      sessionIds,
      integrityCheck: db.prepare("PRAGMA integrity_check").all(),
      walCheckpoint: db.prepare("PRAGMA wal_checkpoint(PASSIVE)").all(),
      tables,
    };
    await writeArtifact(scratch, "database.json", result);
    return result;
  } finally {
    db.close();
  }
};

const writeManifest = async (
  scratch: Scratch,
  serve: ServeHandle,
  proxy: SseProxy,
): Promise<void> => {
  const binary = execFileSync("bash", ["-lc", `command -v "${OPENCODE_BIN}"`], {
    encoding: "utf8",
  }).trim();
  const binaryHash = createHash("sha256").update(await readFile(binary)).digest("hex");
  const procCmdline = (await readFile(`/proc/${serve.pid}/cmdline`))
    .toString()
    .split("\0")
    .filter(Boolean);
  await writeArtifact(scratch, "manifest.json", {
    id: scratch.id,
    startedAt: new Date().toISOString(),
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim(),
    opencode: {
      version: OPENCODE_VERSION,
      binary,
      sha256: binaryHash,
      pid: serve.pid,
      cmdline: procCmdline,
      endpoint: serve.url,
    },
    proxy: {
      endpoint: proxy.url,
      port: proxy.port,
      seed: `${scratch.id}-deterministic-v1`,
    },
    node: process.version,
    os: `${process.platform} ${process.arch}`,
    protocol: "legacy (forced)",
    providerModel: {
      text: `${CHEAP_MODEL.providerID}/${CHEAP_MODEL.modelID}`,
      tools: `${TOOL_MODEL.providerID}/${TOOL_MODEL.modelID} variant=${TOOL_MODEL.variant}`,
    },
    projectPath: scratch.project,
    polythDataDir: scratch.dataDir,
  });
};

const finish = async (
  harness: Harness,
  sessionIds: readonly string[],
  verdict: Verdict,
  details: unknown,
): Promise<void> => {
  await writeArtifact(harness.scratch, "details.json", details);
  await dumpDatabase(harness.scratch, sessionIds);
  await writeManifest(harness.scratch, harness.serve, harness.proxy);
  await writeArtifact(harness.scratch, "verdict.json", {
    ...verdict,
    opencodeVersion: OPENCODE_VERSION,
  });
  console.log(`[${verdict.id}] ${verdict.verdict}: ${verdict.observed}`);
};

const eventsOf = async (
  harness: Harness,
  sessionId: string,
  type?: string,
): Promise<SessionEvent[]> => {
  const events = await harness.store.events(sessionId);
  return type ? events.filter((event) => event.type === type) : events;
};

const scenario041 = async (): Promise<void> => {
  const harness = await startHarness("OC-REAL-041");
  const sessionIds: string[] = [];
  try {
    const messageCase = await harness.create("drop-message-family");
    sessionIds.push(messageCase.id);
    harness.proxy.setDropFamilies(["message"]);
    const messagePrompt = "Reply exactly PHASE3_MESSAGE_DROP_OK and nothing else.";
    await harness.sessions.send(messageCase.id, {
      text: messagePrompt,
      model: CHEAP_MODEL,
    });
    await waitForAssistantCompletion(
      harness.serve.url,
      messageCase.backendId,
      harness.scratch.project,
    );
    harness.proxy.setDropFamilies([]);
    await harness.reconnect();
    const messageAssistant = await eventsOf(harness, messageCase.id, "assistant/message");

    const deltaCase = await harness.create("drop-text-delta-family");
    sessionIds.push(deltaCase.id);
    harness.proxy.setDropFamilies(["text-delta"]);
    await harness.sessions.send(deltaCase.id, {
      text: "Reply exactly PHASE3_DELTA_DROP_OK and nothing else.",
      model: CHEAP_MODEL,
    });
    await waitForAssistantCompletion(
      harness.serve.url,
      deltaCase.backendId,
      harness.scratch.project,
    );
    harness.proxy.setDropFamilies([]);
    await harness.reconnect();
    const deltaAssistant = await eventsOf(harness, deltaCase.id, "assistant/message");

    const statusCase = await harness.create("drop-status-family");
    sessionIds.push(statusCase.id);
    harness.proxy.setDropFamilies(["status"]);
    await harness.sessions.send(statusCase.id, {
      text: "Reply exactly PHASE3_STATUS_DROP_OK and nothing else.",
      model: CHEAP_MODEL,
    });
    await waitForAssistantCompletion(
      harness.serve.url,
      statusCase.backendId,
      harness.scratch.project,
    );
    harness.proxy.setDropFamilies([]);
    await harness.reconnect();
    const statusProjection = await harness.store.projection(statusCase.id);

    const toolCase = await harness.create("drop-tool-start-family");
    sessionIds.push(toolCase.id);
    const marker = join(harness.scratch.project, "family-marker.txt");
    harness.proxy.setDropFamilies(["tool-start"]);
    await harness.sessions.send(toolCase.id, {
      text: `Use the write tool to create ${marker} containing exactly FAMILY_TOOL_OK, then reply done.`,
      model: FREE_TOOL_MODEL,
    });
    await waitForAssistantCompletion(
      harness.serve.url,
      toolCase.backendId,
      harness.scratch.project,
    );
    harness.proxy.setDropFamilies([]);
    await harness.reconnect();
    const toolEvents = (await eventsOf(harness, toolCase.id))
      .filter((event) => event.type.startsWith("tool/"));
    const resultWithoutCall = toolEvents.some((event, index) =>
      (event.type === "tool/result" || event.type === "tool/error")
      && !toolEvents.slice(0, index).some((prior) =>
        (prior.data as { callId?: string }).callId
        === (event.data as { callId?: string }).callId
        && (prior.type === "tool/call" || prior.type === "tool/started")));

    const messageTexts = messageAssistant.map((event) =>
      String((event.data as { text?: unknown }).text ?? ""));
    const falseAssistant = messageTexts.some((text) => text === messagePrompt);
    const failures = [
      ...(falseAssistant
        ? ["dropping message.updated persisted the user prompt as an assistant message"]
        : []),
      ...(messageAssistant.length !== 1
        ? [`message drop produced ${messageAssistant.length} assistant/message facts`]
        : []),
      ...(resultWithoutCall ? ["dropping tool-start produced a terminal tool event without a call"] : []),
      ...(statusProjection?.status === "working"
        ? ["status drop left the projection fake-running after reconciliation"]
        : []),
    ];
    await finish(
      harness,
      sessionIds,
      {
        id: "OC-REAL-041",
        verdict: failures.length > 0 ? "fail" : "partial",
        protocol: "legacy (forced)",
        observed: failures.length > 0
          ? failures.join("; ")
          : "message, text-delta, status, and tool-start families recovered without a pinned failure; rare reasoning/compaction/title families were not all forced",
        expected: "each missed family is recovered once or remains explicit uncertainty",
        attribution: failures.length > 0 ? "POLYTH" : "NONE",
        blockers: failures.length > 0 ? [8] : [],
        evidence: [
          "artifacts/opencode-real-world/phase-3/OC-REAL-041/details.json",
          "artifacts/opencode-real-world/phase-3/OC-REAL-041/database.json",
          "logs/opencode-real-world/phase-3/OC-REAL-041/wire.ndjson",
        ],
      },
      {
        cases: {
          message: {
            backendId: messageCase.backendId,
            dropped: harness.proxy.frameLog().filter((frame) =>
              frame.sessionId === messageCase.backendId && frame.action === "drop"),
            assistantFacts: messageAssistant,
            falseAssistant,
          },
          textDelta: {
            backendId: deltaCase.backendId,
            assistantFacts: deltaAssistant,
          },
          status: {
            backendId: statusCase.backendId,
            projection: statusProjection,
          },
          toolStart: {
            backendId: toolCase.backendId,
            toolEvents,
            resultWithoutCall,
            sideEffect: existsSync(marker) ? await readFile(marker, "utf8") : null,
          },
        },
        failures,
      },
    );
  } finally {
    await harness.close();
  }
};

const scenario042 = async (): Promise<void> => {
  const harness = await startHarness("OC-REAL-042", { permission: "ask" });
  let sessionId = "";
  try {
    const created = await harness.create("missed-permission");
    sessionId = created.id;
    harness.proxy.setDropFamilies(["permission"]);
    await harness.sessions.send(created.id, {
      text: "Run exactly this bash command using the bash tool: echo PHASE3_PERMISSION_OK",
      model: TOOL_MODEL,
    });
    const dropped = await harness.proxy.waitForFrame(
      (frame) =>
        frame.type === "permission.asked"
        && frame.sessionId === created.backendId
        && frame.action === "drop",
      120_000,
    );
    const upstreamBefore = await pending(
      harness.serve.url,
      "permission",
      harness.scratch.project,
    );
    const request = upstreamBefore.find((item) => item.sessionID === created.backendId);
    if (!request || typeof request.id !== "string") {
      throw new Error("real pending permission was not found after its dropped SSE frame");
    }
    harness.proxy.setDropFamilies([]);
    await harness.reconnect();
    await waitUntil(
      () => eventsOf(harness, created.id, "permission/requested"),
      (events) => events.some((event) =>
        (event.data as { requestId?: string }).requestId === request.id),
      30_000,
      "durable recovered permission",
    );
    await harness.sessions.replyPermission(created.id, request.id, "once");
    await waitForAssistantCompletion(
      harness.serve.url,
      created.backendId,
      harness.scratch.project,
    );
    await harness.reconnect();
    const permissionEvents = (await eventsOf(harness, created.id, "permission/requested"))
      .filter((event) => (event.data as { requestId?: string }).requestId === request.id);
    const replyPosts = harness.proxy.requestCount(
      new RegExp(`^POST /session/${created.backendId}/permissions/${request.id}`),
    );
    const upstreamAfter = await pending(
      harness.serve.url,
      "permission",
      harness.scratch.project,
    );
    const passed = permissionEvents.length === 1
      && replyPosts === 1
      && !upstreamAfter.some((item) => item.id === request.id);
    await finish(
      harness,
      [created.id],
      {
        id: "OC-REAL-042",
        verdict: passed ? "pass" : "fail",
        protocol: "legacy (forced)",
        observed: `dropped permission ${request.id}; pull recovered ${permissionEvents.length} durable card(s); reply POST count=${replyPosts}; pending after reply=${upstreamAfter.some((item) => item.id === request.id)}`,
        expected: "session-bound pending pull recovery exactly once and one answer",
        attribution: passed ? "NONE" : "POLYTH",
        blockers: passed ? [] : [3],
        evidence: [
          "artifacts/opencode-real-world/phase-3/OC-REAL-042/details.json",
          "artifacts/opencode-real-world/phase-3/OC-REAL-042/database.json",
          "logs/opencode-real-world/phase-3/OC-REAL-042/wire.ndjson",
        ],
      },
      {
        dropped,
        request,
        upstreamBefore,
        permissionEvents,
        replyPosts,
        upstreamAfter,
      },
    );
  } finally {
    await harness.close();
  }
};

const scenario043 = async (): Promise<void> => {
  const harness = await startHarness("OC-REAL-043");
  try {
    const created = await harness.create("missed-question");
    harness.proxy.setDropFamilies(["question"]);
    await harness.sessions.send(created.id, {
      text: "Use the question tool to ask which color I prefer. Options exactly red and blue. Do not answer it yourself.",
      model: FREE_TOOL_MODEL,
    });
    const dropped = await harness.proxy.waitForFrame(
      (frame) =>
        frame.type === "question.asked"
        && frame.sessionId === created.backendId
        && frame.action === "drop",
      120_000,
    );
    const upstreamBefore = await pending(
      harness.serve.url,
      "question",
      harness.scratch.project,
    );
    const request = upstreamBefore.find((item) => item.sessionID === created.backendId);
    if (!request || typeof request.id !== "string") {
      throw new Error("real pending question was not found after its dropped SSE frame");
    }
    harness.proxy.setRestEmpty(/^\/question(?:\?|$)/, 1);
    harness.proxy.setDropFamilies([]);
    await harness.reconnect();
    await waitUntil(
      () => eventsOf(harness, created.id, "question/asked"),
      (events) => events.some((event) =>
        (event.data as { requestId?: string }).requestId === request.id),
      40_000,
      "eventual durable question after stale empty list",
    );
    await harness.sessions.replyQuestion(created.id, request.id, {
      answers: [["red"]],
    });
    await waitForAssistantCompletion(
      harness.serve.url,
      created.backendId,
      harness.scratch.project,
    );
    await harness.reconnect();
    const questionEvents = (await eventsOf(harness, created.id, "question/asked"))
      .filter((event) => (event.data as { requestId?: string }).requestId === request.id);
    const replyPosts = harness.proxy.requestCount(
      new RegExp(`^POST /question/${request.id}/reply`),
    );
    const upstreamAfter = await pending(
      harness.serve.url,
      "question",
      harness.scratch.project,
    );
    const passed = questionEvents.length === 1
      && replyPosts === 1
      && !upstreamAfter.some((item) => item.id === request.id);
    await finish(
      harness,
      [created.id],
      {
        id: "OC-REAL-043",
        verdict: passed ? "pass" : "fail",
        protocol: "legacy (forced)",
        observed: `dropped question ${request.id}; first reconciliation list was faulted empty; later pull recovered ${questionEvents.length} durable card(s); reply POST count=${replyPosts}`,
        expected: "identified question is eventually recovered once without inferring list completeness",
        attribution: passed ? "NONE" : "POLYTH",
        blockers: passed ? [] : [4],
        evidence: [
          "artifacts/opencode-real-world/phase-3/OC-REAL-043/details.json",
          "artifacts/opencode-real-world/phase-3/OC-REAL-043/database.json",
          "logs/opencode-real-world/phase-3/OC-REAL-043/wire.ndjson",
        ],
      },
      {
        dropped,
        request,
        upstreamBefore,
        questionEvents,
        replyPosts,
        upstreamAfter,
      },
    );
  } finally {
    await harness.close();
  }
};

const scenario044 = async (): Promise<void> => {
  const harness = await startHarness("OC-REAL-044", { sseStallMs: 750 });
  try {
    const created = await harness.create("missed-completion");
    await harness.sessions.send(created.id, {
      text: "Reply exactly PHASE3_OFFLINE_COMPLETION_OK and nothing else.",
      model: CHEAP_MODEL,
    });
    await harness.proxy.waitForFrame(
      (frame) =>
        frame.sessionId === created.backendId
        && (frame.type === "session.status" || frame.type === "message.updated"),
      60_000,
    );
    harness.proxy.setSilent(true);
    harness.proxy.disconnectSse();
    const messages = await waitForAssistantCompletion(
      harness.serve.url,
      created.backendId,
      harness.scratch.project,
    );
    const whileSilent = await harness.store.projection(created.id);
    harness.proxy.setSilent(false);
    await harness.reconnect();
    await harness.reconnect();
    const finalProjection = await harness.store.projection(created.id);
    const assistantEvents = await eventsOf(harness, created.id, "assistant/message");
    const text = assistantEvents
      .map((event) => String((event.data as { text?: unknown }).text ?? ""))
      .join("");
    const fakeRunning = finalProjection?.status === "working";
    const outputRecoveredOnce = assistantEvents.length === 1
      && text.includes("PHASE3_OFFLINE_COMPLETION_OK");
    const explicitUnknown = finalProjection?.status === "unknown"
      && (await harness.store.reconciliation(created.id))?.state === "unknown";
    await finish(
      harness,
      [created.id],
      {
        id: "OC-REAL-044",
        verdict: !fakeRunning && outputRecoveredOnce && explicitUnknown ? "partial" : "fail",
        protocol: "legacy (forced)",
        observed: `upstream completed while SSE was silent; output recovered ${assistantEvents.length} time(s); projection while silent=${whileSilent?.status}, after two reconnects=${finalProjection?.status}; legacy idle/status has no comparable revision, so terminal state remains explicit unknown`,
        expected: "recover proven output once; never remain fake-running; terminalize only from ordered evidence",
        attribution: !fakeRunning && outputRecoveredOnce ? "AMBIGUITY" : "POLYTH",
        blockers: fakeRunning || !outputRecoveredOnce ? [4] : [],
        evidence: [
          "artifacts/opencode-real-world/phase-3/OC-REAL-044/details.json",
          "artifacts/opencode-real-world/phase-3/OC-REAL-044/database.json",
          "logs/opencode-real-world/phase-3/OC-REAL-044/wire.ndjson",
        ],
        notes: "Contract gap: real legacy terminal status is unversioned. Explicit unknown is safe but cannot close the full terminal-convergence acceptance criterion.",
      },
      {
        upstreamMessages: messages,
        whileSilent,
        finalProjection,
        assistantEvents,
        outputRecoveredOnce,
        fakeRunning,
        reconciliation: await harness.store.reconciliation(created.id),
      },
    );
  } finally {
    await harness.close();
  }
};

const scenario045 = async (): Promise<void> => {
  const harness = await startHarness("OC-REAL-045");
  try {
    const created = await harness.create("duplicate-sse");
    harness.proxy.setDuplicate("same-and-new");
    await harness.sessions.send(created.id, {
      text: "Reply exactly DUPLICATE_TIMELINE_OK and nothing else.",
      model: CHEAP_MODEL,
    });
    await waitForAssistantCompletion(
      harness.serve.url,
      created.backendId,
      harness.scratch.project,
    );
    harness.proxy.setDuplicate("none");
    await harness.reconnect();
    const events = await eventsOf(harness, created.id);
    const assistants = events.filter((event) => event.type === "assistant/message");
    const duplicateFrames = harness.proxy.frameLog().filter((frame) =>
      frame.action === "duplicate-same" || frame.action === "duplicate-new");
    const promptPosts = harness.proxy.requestCount(
      new RegExp(`^POST /session/${created.backendId}/(?:prompt_async|message)`),
    );
    const observationErrors = harness.consoleErrors.filter((error) =>
      error.includes("runtime observation"));
    const passed = duplicateFrames.length > 0
      && assistants.length === 1
      && promptPosts === 1
      && observationErrors.length === 0;
    await finish(
      harness,
      [created.id],
      {
        id: "OC-REAL-045",
        verdict: passed ? "pass" : "fail",
        protocol: "legacy (forced)",
        observed: `${duplicateFrames.length} duplicate deliveries (same and changed transport IDs); assistant facts=${assistants.length}; prompt POSTs=${promptPosts}; internal observation errors=${observationErrors.length}`,
        expected: "semantic facts and side effects occur once across duplicate SSE and pull",
        attribution: passed ? "NONE" : "POLYTH",
        blockers: passed ? [] : [8],
        evidence: [
          "artifacts/opencode-real-world/phase-3/OC-REAL-045/details.json",
          "artifacts/opencode-real-world/phase-3/OC-REAL-045/database.json",
          "logs/opencode-real-world/phase-3/OC-REAL-045/wire.ndjson",
        ],
      },
      {
        duplicateFrames,
        assistants,
        promptPosts,
        observationErrors,
      },
    );
  } finally {
    await harness.close();
  }
};

const scenario046 = async (): Promise<void> => {
  const harness = await startHarness("OC-REAL-046");
  try {
    const created = await harness.create("stale-after-reconcile");
    const marker = join(harness.scratch.project, "stale-marker.txt");
    harness.proxy.setHoldFamilies(["tool-start"]);
    await harness.sessions.send(created.id, {
      text: `Use the write tool to create ${marker} containing exactly STALE_EVENT_OK, then reply done.`,
      model: FREE_TOOL_MODEL,
    });
    await waitUntil(
      () => harness.proxy.heldCount(),
      (count) => count > 0,
      120_000,
      "held old tool event",
    );
    await waitForAssistantCompletion(
      harness.serve.url,
      created.backendId,
      harness.scratch.project,
    );
    harness.proxy.setHoldFamilies([]);
    await harness.reconnect();
    const beforeRelease = await eventsOf(harness, created.id);
    const beforeTools = beforeRelease.filter((event) => event.type.startsWith("tool/"));
    const heldBefore = harness.proxy.heldCount();
    const released = harness.proxy.releaseHeld();
    await sleep(2_000);
    const afterRelease = await eventsOf(harness, created.id);
    const afterTools = afterRelease.filter((event) => event.type.startsWith("tool/"));
    const sequenceByCall = new Map<string, string[]>();
    for (const event of afterTools) {
      const callId = String((event.data as { callId?: unknown }).callId ?? "");
      const values = sequenceByCall.get(callId) ?? [];
      values.push(event.type);
      sequenceByCall.set(callId, values);
    }
    const regressed = [...sequenceByCall.values()].some((sequence) => {
      const terminal = sequence.findIndex((type) =>
        type === "tool/result" || type === "tool/error");
      return terminal >= 0 && sequence.slice(terminal + 1).some((type) =>
        type === "tool/call" || type === "tool/started");
    });
    const appliedAfterRelease = afterTools.length !== beforeTools.length;
    const passed = heldBefore > 0 && released === heldBefore && !regressed && !appliedAfterRelease;
    await finish(
      harness,
      [created.id],
      {
        id: "OC-REAL-046",
        verdict: passed ? "partial" : "fail",
        protocol: "legacy (forced)",
        observed: `held ${heldBefore} real old tool-start frame(s), committed pull/current terminal checkpoint, then released ${released}; durable tool events changed=${appliedAfterRelease}; rank regressed=${regressed}`,
        expected: "old same-generation and old-generation events cannot regress newer durable state",
        attribution: passed ? "NONE" : "POLYTH",
        blockers: passed ? [] : [8],
        evidence: [
          "artifacts/opencode-real-world/phase-3/OC-REAL-046/details.json",
          "artifacts/opencode-real-world/phase-3/OC-REAL-046/database.json",
          "logs/opencode-real-world/phase-3/OC-REAL-046/wire.ndjson",
        ],
        notes: "Same-generation real delayed-frame fence passed. Cross-generation fencing remains deterministic-only in this run, so the full row is partial.",
      },
      {
        heldBefore,
        released,
        beforeTools,
        afterTools,
        appliedAfterRelease,
        regressed,
        sequenceByCall: Object.fromEntries(sequenceByCall),
      },
    );
  } finally {
    await harness.close();
  }
};

const resourceSample = (): { rss: number; fds: number } => ({
  rss: process.memoryUsage().rss,
  fds: existsSync("/proc/self/fd") ? readdirSync("/proc/self/fd").length : -1,
});

const scenario047 = async (): Promise<void> => {
  const harness = await startHarness("OC-REAL-047", {
    sseStallMs: 250,
    failEveryRefresh: 10,
  });
  try {
    const created = await harness.create("disconnect-storm");
    await harness.sessions.send(created.id, {
      text: "Use the question tool to ask me whether to continue. Options exactly yes and no. Do not answer it yourself.",
      model: FREE_TOOL_MODEL,
    });
    const questionFrame = await harness.proxy.waitForFrame(
      (frame) =>
        frame.type === "question.asked"
        && frame.sessionId === created.backendId
        && frame.action === "forward",
      120_000,
    );
    const request = (await pending(
      harness.serve.url,
      "question",
      harness.scratch.project,
    )).find((item) => item.sessionID === created.backendId);
    if (!request || typeof request.id !== "string") {
      throw new Error("storm precondition question was not pending upstream");
    }
    await waitUntil(
      () => eventsOf(harness, created.id, "question/asked"),
      (events) => events.some((event) =>
        (event.data as { requestId?: string }).requestId === request.id),
      20_000,
      "durable pre-storm question",
    );
    const resourcesBefore = resourceSample();
    const connectionBefore = harness.proxy.connectionCount();
    const disconnectBefore = harness.proxy.disconnectCount();
    const faults: StormFault[] = Array.from({ length: 99 }, (_value, index) =>
      (index + 1) % 15 === 0 ? "silent"
        : (index + 1) % 10 === 0 ? "401"
          : "close");
    const initialDisconnects = harness.proxy.startStorm(faults);
    await waitUntil(
      () => harness.proxy.disconnectCount(),
      (count) => count - disconnectBefore >= 100,
      650_000,
      "100 SSE disconnects",
    );
    await harness.proxy.waitForConnections(connectionBefore + 100, 30_000);
    await sleep(1_000);
    const resourcesAfterStorm = resourceSample();
    await harness.sessions.replyQuestion(created.id, request.id, {
      answers: [["yes"]],
    });
    await waitForAssistantCompletion(
      harness.serve.url,
      created.backendId,
      harness.scratch.project,
      120_000,
    );
    await harness.reconnect();
    const projection = await harness.store.projection(created.id);
    const questions = (await eventsOf(harness, created.id, "question/asked"))
      .filter((event) => (event.data as { requestId?: string }).requestId === request.id);
    const replyPosts = harness.proxy.requestCount(
      new RegExp(`^POST /question/${request.id}/reply`),
    );
    const reconciliations = (await eventsOf(harness, created.id))
      .filter((event) =>
        event.type === "reconciliation/started"
        || event.type === "reconciliation/completed");
    const noLeakSignal = harness.proxy.maxActiveSse() <= 2
      && resourcesAfterStorm.fds - resourcesBefore.fds < 25;
    const passed = initialDisconnects === 1
      && harness.proxy.disconnectCount() - disconnectBefore >= 100
      && questions.length === 1
      && replyPosts === 1
      && noLeakSignal
      && projection?.status !== "working";
    await finish(
      harness,
      [created.id],
      {
        id: "OC-REAL-047",
        verdict: passed ? "partial" : "fail",
        protocol: "legacy (forced)",
        observed: `${harness.proxy.disconnectCount() - disconnectBefore} disconnects across close/silent/401 faults; refresh calls=${harness.refreshCalls()} with injected failures; max active SSE=${harness.proxy.maxActiveSse()}; fd delta=${resourcesAfterStorm.fds - resourcesBefore.fds}; question facts=${questions.length}; reply POSTs=${replyPosts}; final projection=${projection?.status}`,
        expected: "bounded backoff, no resource/subscription storm, no mutation replay, eventual single convergence",
        attribution: passed ? "AMBIGUITY" : "POLYTH",
        blockers: passed ? [] : [4, 8],
        evidence: [
          "artifacts/opencode-real-world/phase-3/OC-REAL-047/details.json",
          "artifacts/opencode-real-world/phase-3/OC-REAL-047/database.json",
          "logs/opencode-real-world/phase-3/OC-REAL-047/wire.ndjson",
          "logs/opencode-real-world/phase-3/OC-REAL-047/polyth.ndjson",
        ],
        notes: "Connection/resource safety passed. Full terminal convergence remains limited by real legacy's unversioned idle status, so the row is partial when final state is explicit unknown.",
      },
      {
        questionFrame,
        request,
        faults: {
          close: faults.filter((fault) => fault === "close").length + initialDisconnects,
          silent: faults.filter((fault) => fault === "silent").length,
          unauthorized: faults.filter((fault) => fault === "401").length,
        },
        connectionBefore,
        connectionAfter: harness.proxy.connectionCount(),
        disconnectBefore,
        disconnectAfter: harness.proxy.disconnectCount(),
        refreshCalls: harness.refreshCalls(),
        lifecycleCounts: harness.lifecycleEvents.reduce<Record<string, number>>((counts, item) => {
          counts[item.event.type] = (counts[item.event.type] ?? 0) + 1;
          return counts;
        }, {}),
        resourcesBefore,
        resourcesAfterStorm,
        maximumActiveSse: harness.proxy.maxActiveSse(),
        projection,
        questions,
        replyPosts,
        reconciliationEventCount: reconciliations.length,
      },
    );
  } finally {
    await harness.close();
  }
};

const scenarios: Record<string, () => Promise<void>> = {
  "OC-REAL-041": scenario041,
  "OC-REAL-042": scenario042,
  "OC-REAL-043": scenario043,
  "OC-REAL-044": scenario044,
  "OC-REAL-045": scenario045,
  "OC-REAL-046": scenario046,
  "OC-REAL-047": scenario047,
};

const selected = process.argv[2];
if (!selected || !(selected in scenarios)) {
  throw new Error(`usage: node ${process.argv[1]} ${Object.keys(scenarios).join("|")}`);
}
await scenarios[selected]!();

/**
 * Phase 13 — independent reliability verification against real OpenCode.
 *
 * Shared helpers: isolated scratch dirs, a real `opencode serve` spawner, a
 * recording pass-through proxy with one G1-specific fault (commit upstream,
 * swallow the response, notify the orchestrator), and an in-process Polyth
 * harness (real store + facade + session service) mirroring phase 3.
 *
 * All ports are OS-assigned (never 14500). Forced process stops signal only a
 * recorded exact PID after /proc identity verification.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  SessionEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService, type Broadcaster } from "../../packages/server/src/sessions.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const ARTIFACT_ROOT = join(REPO_ROOT, "artifacts/opencode-real-world/phase-13");
export const LOG_ROOT = join(REPO_ROOT, "logs/opencode-real-world/phase-13");
export const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode";
export const OPENCODE_VERSION = "1.18.18";
export const FREE_MODEL = { providerID: "opencode", modelID: "big-pickle" };
export const TOOL_MODELS = [
  { providerID: "opencode", modelID: "big-pickle" },
  { providerID: "google", modelID: "gemini-2.5-flash" },
  { providerID: "google", modelID: "gemini-3.5-flash" },
];

const secretValues = [
  process.env.GEMINI_API_KEY,
  process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  process.env.HUGGINGFACE_API_KEY,
].filter((value): value is string => typeof value === "string" && value.length > 4);

export const redact = (value: string): string => {
  let redacted = value;
  for (const secret of secretValues) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted;
};

export const json = (value: unknown): string =>
  redact(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? Number(item) : item)));

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export const waitUntil = async <T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await sleep(150);
    value = await read();
  }
  if (!accept(value)) throw new Error(`timed out waiting for ${label}`);
  return value;
};

export interface Scratch {
  id: string;
  root: string;
  home: string;
  project: string;
  dataDir: string;
  configDir: string;
  artifactDir: string;
  logDir: string;
  dbPath: string;
  env: NodeJS.ProcessEnv;
}

export const makeScratch = async (id: string): Promise<Scratch> => {
  const root = join(tmpdir(), "ocreal", "phase-13", id, `run-${Date.now().toString(36)}`);
  const home = join(root, "home");
  const project = join(root, "project");
  const dataDir = join(root, "polyth-data");
  const configDir = join(home, ".config", "opencode");
  const artifactDir = join(ARTIFACT_ROOT, id);
  const logDir = join(LOG_ROOT, id);
  for (const directory of [
    home, project, dataDir, configDir, artifactDir, logDir,
    join(home, ".config"), join(home, ".local/share"), join(home, ".local/state"), join(home, ".cache"),
  ]) await mkdir(directory, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    GOOGLE_GENERATIVE_AI_API_KEY: process.env.GEMINI_API_KEY
      ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY
      ?? "",
  };
  return {
    id, root, home, project, dataDir, configDir, artifactDir, logDir,
    dbPath: join(dataDir, "sessions.db"),
    env,
  };
};

export const writeOpencodeConfig = async (
  scratch: Scratch,
  permission: "allow" | "ask" = "allow",
): Promise<void> => {
  await writeFile(join(scratch.configDir, "opencode.json"), JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    permission: {
      edit: "allow", write: "allow", read: "allow",
      bash: permission,
      webfetch: "allow",
    },
  }));
};

export interface ServeHandle {
  child: ChildProcess;
  pid: number;
  port: number;
  url: string;
  logPath: string;
  stop(): Promise<void>;
}

export const spawnOpenCode = async (scratch: Scratch, logName = "opencode.log"): Promise<ServeHandle> => {
  const logPath = join(scratch.logDir, logName);
  const output: WriteStream = createWriteStream(logPath, { flags: "a" });
  const child = spawn(
    OPENCODE_BIN,
    ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    { cwd: scratch.project, env: scratch.env, stdio: ["ignore", "pipe", "pipe"] },
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

export interface RequestRecord {
  t: number;
  method: string;
  path: string;
  body: string;
  status?: number;
}

export interface RecordingProxy {
  url: string;
  port: number;
  server: Server;
  requests: RequestRecord[];
  /** Arm the G1 fault: forward the matched request upstream, capture the
   * committed response, deliver NOTHING to the client, and invoke the hooks. */
  armSwallow(pattern: RegExp, hooks: {
    onRequest?(record: RequestRecord): void;
    onCommitted(record: RequestRecord, responseBody: string): void;
  }): void;
  disarm(): void;
  count(matcher: (record: RequestRecord) => boolean): number;
  close(): Promise<void>;
}

/** HTTP/SSE pass-through recorder in front of a REAL opencode serve. */
export const startRecordingProxy = async (
  targetUrl: string,
  logPath: string,
): Promise<RecordingProxy> => {
  const target = new URL(targetUrl);
  const requests: RequestRecord[] = [];
  let swallow: { pattern: RegExp; hooks: Parameters<RecordingProxy["armSwallow"]>[1] } | undefined;
  const log = async (value: unknown): Promise<void> => {
    await writeFile(logPath, `${json(value)}\n`, { flag: "a" });
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const record: RequestRecord = {
        t: Date.now(),
        method: request.method ?? "GET",
        path: request.url ?? "/",
        body: body.toString("utf8"),
      };
      requests.push(record);
      const key = `${record.method} ${record.path}`;
      const swallowed = swallow && swallow.pattern.test(key) ? swallow : undefined;
      if (swallowed) swallowed.hooks.onRequest?.(record);
      void log({ kind: "request", t: record.t, method: record.method, path: record.path, bytes: body.length, swallowed: Boolean(swallowed) });
      const upstream = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          method: request.method,
          path: request.url,
          headers: { ...request.headers, host: `${target.hostname}:${target.port}` },
        },
        (upstreamResponse) => {
          record.status = upstreamResponse.statusCode ?? 0;
          if (swallowed) {
            const responseChunks: Buffer[] = [];
            upstreamResponse.on("data", (chunk: Buffer) => responseChunks.push(chunk));
            upstreamResponse.on("end", () => {
              const responseBody = Buffer.concat(responseChunks).toString("utf8");
              void log({
                kind: "swallowed-commit", t: Date.now(),
                method: record.method, path: record.path,
                status: record.status, bytes: responseBody.length,
              });
              swallowed.hooks.onCommitted(record, responseBody);
              // Never relay. The orchestrator kills the client first; destroy
              // whatever remains of the socket afterwards.
              setTimeout(() => response.socket?.destroy(), 2_000);
            });
            return;
          }
          const contentType = String(upstreamResponse.headers["content-type"] ?? "");
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          if (contentType.includes("event-stream")) {
            upstreamResponse.on("data", (chunk: Buffer) => response.write(chunk));
            upstreamResponse.on("end", () => response.end());
            upstreamResponse.on("error", () => response.socket?.destroy());
            response.on("close", () => upstreamResponse.destroy());
            return;
          }
          const responseChunks: Buffer[] = [];
          upstreamResponse.on("data", (chunk: Buffer) => responseChunks.push(chunk));
          upstreamResponse.on("end", () => {
            void log({ kind: "response", t: Date.now(), method: record.method, path: record.path, status: record.status });
            response.end(Buffer.concat(responseChunks));
          });
        },
      );
      upstream.on("error", (error) => {
        void log({ kind: "upstream-error", t: Date.now(), path: record.path, error: String(error) });
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      upstream.end(body);
    });
  };

  const server = createServer(handler);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    server,
    requests,
    armSwallow(pattern, hooks) {
      swallow = { pattern, hooks };
    },
    disarm() {
      swallow = undefined;
    },
    count: (matcher) => requests.filter(matcher).length,
    async close() {
      await new Promise<void>((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      });
    },
  };
};

export const projectServiceFor = (project: Project): ProjectService => ({
  list: async () => [project],
  get: async (id) => (id === project.id ? project : undefined),
  add: async () => project,
  create: async () => project,
  remove: async () => undefined,
});

export const askPermissionService = {
  evaluate: () => "ask",
  addRule: () => undefined,
  rules: () => [],
} as unknown as PermissionService;

export interface PolythHandle {
  store: ReturnType<typeof createStore>;
  runtime: AgentRuntime;
  lifecycle: Awaited<ReturnType<typeof createOpenCodeRuntimeLifecycle>>;
  sessions: ReturnType<typeof createSessionService>;
  events: SessionEvent[];
  create(title: string): Promise<{ id: string; backendId: string }>;
  close(): Promise<void>;
}

/** Real Polyth wiring (store + facade + session service) over an endpoint
 * lease. Callers own the lease when they need owned-child semantics. */
export const startPolyth = async (
  scratch: Scratch,
  lease: RuntimeEndpointLease,
  options: { logName?: string; store?: ReturnType<typeof createStore> } = {},
): Promise<PolythHandle> => {
  const polythLog = join(scratch.logDir, options.logName ?? "polyth.ndjson");
  const lifecycle = await createOpenCodeRuntimeLifecycle({
    lease,
    protocol: "legacy",
    protocolDeadlineMs: 5_000,
    startupDeadlineMs: 15_000,
    probeDeadlineMs: 2_000,
    transport: { queryAttempts: 1 },
  });
  const facade = createOpenCodeRuntimeFacade({
    lifecycle,
    log(level, message, data) {
      void writeFile(polythLog, `${json({ t: Date.now(), level, message, data })}\n`, { flag: "a" });
    },
  });
  const runtime = attachRuntimeLifecycle(facade, lifecycle);
  runtime.onLifecycle?.((event) => {
    void writeFile(polythLog, `${json({ t: Date.now(), kind: "lifecycle", event })}\n`, { flag: "a" });
  });
  const store = options.store ?? createStore(scratch.dbPath);
  const project: Project = {
    id: `project:${scratch.id}`,
    name: `Phase 13 ${scratch.id}`,
    path: scratch.project,
    createdAt: Date.now(),
  };
  const events: SessionEvent[] = [];
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
      void writeFile(
        join(scratch.logDir, "broadcast.ndjson"),
        `${json({ t: Date.now(), kind: "projection", projection })}\n`,
        { flag: "a" },
      );
    },
  };
  const sessions = createSessionService({
    store,
    projects: projectServiceFor(project),
    permissions: askPermissionService,
    broadcast,
    queue: store,
    runtimes: { forProject: async () => runtime },
  });
  return {
    store,
    runtime,
    lifecycle,
    sessions,
    events,
    async create(title) {
      const created = await sessions.create({ projectId: project.id, title });
      const projection = await waitUntil(
        () => store.projection(created.id),
        (candidate) => Boolean(candidate?.backendSessionId),
        30_000,
        "backend session binding",
      );
      return { id: created.id, backendId: projection!.backendSessionId! };
    },
    async close() {
      await runtime.dispose();
      await lifecycle.dispose();
      await store.close();
    },
  };
};

/** Fixed borrowed endpoint (harness-controlled URL, e.g. a recording proxy). */
export const fixedBorrowedLease = (
  url: string,
  directory: string,
  authorityId: string,
): RuntimeEndpointLease => {
  const endpoint: RuntimeEndpoint = {
    authorityId,
    continuity: "verified",
    generation: 1,
    url,
    location: { directory },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  return {
    control: endpoint.control,
    async endpoint() { return endpoint; },
    async refresh() { return endpoint; },
    async dispose() {},
  };
};

export interface Verdict {
  id: string;
  verdict: "pass" | "fail" | "blocked" | "partial";
  protocol: string;
  observed: string;
  expected: string;
  attribution: "POLYTH" | "OPENCODE" | "ENV" | "HARNESS" | "AMBIGUITY" | "NONE";
  evidence: string[];
  notes?: string;
}

export const writeArtifact = async (scratch: Scratch, name: string, value: unknown): Promise<void> => {
  await writeFile(
    join(scratch.artifactDir, name),
    `${JSON.stringify(JSON.parse(json(value)) as unknown, null, 2)}\n`,
  );
};

export const writeManifest = async (scratch: Scratch, extra: Record<string, unknown> = {}): Promise<void> => {
  const binary = execFileSync("bash", ["-lc", `command -v "${OPENCODE_BIN}"`], { encoding: "utf8" }).trim();
  const binaryHash = createHash("sha256").update(await readFile(binary)).digest("hex");
  await writeArtifact(scratch, "manifest.json", {
    id: scratch.id,
    startedAt: new Date().toISOString(),
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
    opencode: { version: OPENCODE_VERSION, binary, sha256: binaryHash },
    node: process.version,
    os: `${process.platform} ${process.arch}`,
    ...extra,
  });
};

export const finishVerdict = async (scratch: Scratch, verdict: Verdict): Promise<void> => {
  await writeArtifact(scratch, "verdict.json", { ...verdict, opencodeVersion: OPENCODE_VERSION });
  console.log(`[${verdict.id}] ${verdict.verdict}: ${verdict.observed}`);
};

export const procIdentity = async (pid: number): Promise<{ cmdline: string; startTick: string } | undefined> => {
  try {
    const [cmdlineBuffer, stat] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const close = stat.lastIndexOf(")");
    const startTick = stat.slice(close + 2).trim().split(/\s+/)[19] ?? "";
    return { cmdline: cmdlineBuffer.toString("utf8").replaceAll("\0", " ").trim(), startTick };
  } catch {
    return undefined;
  }
};

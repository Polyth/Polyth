/**
 * Phase 7 (OC-REAL-073..077) multi-client observation harness.
 *
 * Every scenario boots the production Polyth composition (`boot` from
 * @polyth/server) on 127.0.0.1 port 0 (never 14500) with a fresh
 * POLYTH_DATA_DIR and an isolated OpenCode 1.18.18 config/home. All clients
 * are INDEPENDENT: each is its own real TCP WebSocket (`ws`) plus its own
 * HTTP fetch context with a per-client wire log — no shared in-process
 * shortcuts on the observation path. Upstream (O) evidence is read straight
 * from the owned `opencode serve` HTTP surface discovered via /proc.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";

import { boot } from "@polyth/server";
import type { SessionEvent } from "@polyth/contracts";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const ARTIFACTS_ROOT = join(REPO_ROOT, "artifacts/opencode-real-world/phase-7");
export const LOGS_ROOT = join(REPO_ROOT, "logs/opencode-real-world/phase-7");
export const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "/home/ubuntu/.local/bin/opencode";
export const MODEL = { providerID: "opencode", modelID: "big-pickle" };
export const HEAD_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();
export const OPENCODE_VERSION = execFileSync(OPENCODE_BIN, ["--version"], { encoding: "utf8" }).trim();
if (OPENCODE_VERSION !== "1.18.18") {
  throw new Error(`Phase 7 requires OpenCode 1.18.18, got ${OPENCODE_VERSION}`);
}

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
  redact(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? Number(item) : item), 2));

export const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, json(value));
};

export const appendNdjson = async (path: string, value: unknown): Promise<void> => {
  await appendFile(path, `${redact(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? Number(item) : item)))}\n`);
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 150,
  label = "condition",
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} not reached in ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ""}`);
};

export const errorCode = (error: unknown): string => {
  const err = error as { code?: string; message?: string };
  return String(err?.code ?? err?.message ?? error);
};

export interface Scratch {
  id: string;
  root: string;
  home: string;
  project: string;
  dataDir: string;
  configDir: string;
  artifactsDir: string;
  logsDir: string;
  dbPath: string;
}

export const makeScratch = async (id: string, sub?: string): Promise<Scratch> => {
  const dirId = sub ? `${id}/${sub}` : id;
  const root = `/tmp/ocreal-phase7/${dirId.toLowerCase()}-${Date.now().toString(36)}`;
  const home = join(root, "home");
  const project = join(root, "project");
  const dataDir = join(root, "polyth-data");
  const configDir = join(root, "opencode-config");
  const artifactsDir = join(ARTIFACTS_ROOT, dirId);
  const logsDir = join(LOGS_ROOT, dirId);
  if (process.env.PHASE7_ARCHIVE_EXISTING === "1" && !sub) {
    const suffix = `attempt-${Date.now().toString(36)}`;
    await rename(artifactsDir, join(ARTIFACTS_ROOT, `${id}-${suffix}`)).catch(() => undefined);
    await rename(logsDir, join(LOGS_ROOT, `${id}-${suffix}`)).catch(() => undefined);
  }
  await rm(artifactsDir, { recursive: true, force: true });
  await rm(logsDir, { recursive: true, force: true });
  for (const directory of [
    root, home, project, dataDir, configDir, artifactsDir, logsDir,
    join(home, ".config"), join(home, ".local/share"),
    join(home, ".local/state"), join(home, ".cache"),
  ]) await mkdir(directory, { recursive: true });
  // A tiny real git repo so file tools have an honest project root.
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-C", project, "config", "user.name", "Phase7 Agent"]);
  execFileSync("git", ["-C", project, "config", "user.email", "phase7@polyth.test"]);
  await writeFile(join(project, "README.md"), `phase-7 fixture ${dirId}\n`);
  execFileSync("git", ["-C", project, "add", "-A"]);
  execFileSync("git", ["-C", project, "commit", "-qm", "fixture"]);
  return { id, root, home, project, dataDir, configDir, artifactsDir, logsDir, dbPath: join(dataDir, "sessions.db") };
};

const originalEnvironment = Object.fromEntries(
  ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "POLYTH_DATA_DIR"]
    .map((key) => [key, process.env[key]]),
);

export const applyEnvironment = (scratch: Scratch): void => {
  process.env.HOME = scratch.home;
  process.env.XDG_CONFIG_HOME = join(scratch.home, ".config");
  process.env.XDG_DATA_HOME = join(scratch.home, ".local/share");
  process.env.XDG_STATE_HOME = join(scratch.home, ".local/state");
  process.env.XDG_CACHE_HOME = join(scratch.home, ".cache");
};

export const restoreEnvironment = (): void => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

/** Per-scenario opencode.json in the isolated XDG config home. */
export const writeOpencodeConfig = async (
  scratch: Scratch,
  permission: { bash?: "allow" | "ask" } = {},
): Promise<void> => {
  const configDirectory = join(scratch.home, ".config/opencode");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    permission: {
      read: "allow",
      edit: "allow",
      write: "allow",
      bash: permission.bash ?? "allow",
    },
  }, null, 2));
};

export interface RuntimeHandle {
  app: Awaited<ReturnType<typeof boot>>;
  baseUrl: string;
  port: number;
}

export const openRuntime = async (scratch: Scratch): Promise<RuntimeHandle> => {
  applyEnvironment(scratch);
  const app = await boot({
    port: 0,
    hostname: "127.0.0.1",
    dataDir: scratch.dataDir,
    opencode: {
      bin: OPENCODE_BIN,
      dataDir: scratch.configDir,
      protocol: "legacy",
      startupDeadlineMs: 30_000,
      probeDeadlineMs: 2_000,
    },
  });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Polyth did not bind a TCP port");
  if (address.port === 14500) throw new Error("forbidden Polyth port 14500 was selected");
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, port: address.port };
};

export const closeRuntime = async (runtime: RuntimeHandle | undefined): Promise<void> => {
  if (!runtime) return;
  await runtime.app.shutdown().catch(() => undefined);
  await sleep(300);
};

// ---- independent HTTP clients (each with its own wire log) --------------------------

export interface HttpResult {
  status: number;
  body: unknown;
  raw: string;
}

/** One independent HTTP client identity: own wire log, own fetch calls. */
export class HttpClient {
  readonly name: string;
  readonly baseUrl: string;
  readonly wirePath: string;

  constructor(name: string, baseUrl: string, wirePath: string) {
    this.name = name;
    this.baseUrl = baseUrl;
    this.wirePath = wirePath;
  }

  async call(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<HttpResult> {
    const init: RequestInit = {
      method,
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    await appendNdjson(this.wirePath, { t: Date.now(), client: this.name, kind: "request", method, path, body });
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (error) {
      await appendNdjson(this.wirePath, { t: Date.now(), client: this.name, kind: "transport-error", method, path, error: String(error) });
      throw error;
    }
    const raw = await response.text();
    await appendNdjson(this.wirePath, {
      t: Date.now(), client: this.name, kind: "response", method, path,
      status: response.status, bytes: raw.length,
      body: raw.length > 6_000 ? `${raw.slice(0, 6_000)}…[${raw.length} bytes]` : raw,
    });
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = raw;
    }
    return { status: response.status, body: parsed, raw };
  }
}

// ---- WebSocket trace clients (U evidence) -------------------------------------------

export interface TracedMessage {
  sequence: number;
  time: number;
  message: unknown;
}

export class WsClient {
  readonly name: string;
  readonly messages: TracedMessage[] = [];
  readonly path: string;
  readonly socket: WebSocket;
  closedByServer: { code: number; reason: string } | null = null;

  private constructor(name: string, path: string, socket: WebSocket) {
    this.name = name;
    this.path = path;
    this.socket = socket;
    socket.on("message", (raw) => {
      let body: unknown = String(raw);
      try {
        body = JSON.parse(String(raw)) as unknown;
      } catch {
        // keep malformed transport evidence as text
      }
      const entry = { sequence: this.messages.length + 1, time: Date.now(), message: body };
      this.messages.push(entry);
      void appendNdjson(this.path, { client: this.name, ...entry });
    });
    socket.on("close", (code, reason) => {
      this.closedByServer = { code, reason: String(reason) };
      void appendNdjson(this.path, { client: this.name, time: Date.now(), closed: { code, reason: String(reason) } });
    });
  }

  static async open(name: string, baseUrl: string, path: string): Promise<WsClient> {
    const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error("WebSocket open timeout")), 5_000);
      socket.once("open", () => {
        clearTimeout(timeout);
        resolveOpen();
      });
      socket.once("error", rejectOpen);
    });
    return new WsClient(name, path, socket);
  }

  subscribe(sessionId: string | null, projectId?: string, afterSeq = 0): void {
    this.socket.send(JSON.stringify({
      type: "subscribe",
      ...(sessionId ? { sessionId } : {}),
      ...(projectId ? { projectId } : {}),
      afterSeq,
    }));
  }

  /** Every session event this socket has received (gap-fill frames + live frames), in arrival order. */
  events(): SessionEvent[] {
    const out: SessionEvent[] = [];
    for (const entry of this.messages) {
      const m = entry.message as { type?: string; event?: SessionEvent; events?: SessionEvent[] };
      if (m?.type === "event" && m.event) out.push(m.event);
      else if (m?.type === "events" && Array.isArray(m.events)) out.push(...m.events);
    }
    return out;
  }

  eventsFor(sessionId: string): SessionEvent[] {
    return this.events().filter((event) => event.sessionId === sessionId);
  }

  async waitForEvent(
    predicate: (event: SessionEvent) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<SessionEvent> {
    let found: SessionEvent | undefined;
    await waitFor(() => {
      found = this.events().find(predicate);
      return Boolean(found);
    }, timeoutMs, 100, `${this.name}: ${label}`);
    return found!;
  }

  close(): void {
    this.socket.close();
  }
}

// ---- upstream discovery + O evidence -------------------------------------------------

export interface ServeProcess {
  pid: number;
  cwd: string;
  cmd: string;
  port: number | null;
}

export const opencodeProcesses = (): ServeProcess[] => {
  const out: ServeProcess[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ").trim();
      if (!/(^|\/)opencode\b/.test(cmd.split(" ")[0] ?? "") || !cmd.includes(" serve")) continue;
      const rawCwd = readlinkSync(`/proc/${entry}/cwd`);
      const portMatch = cmd.match(/--port\s+(\d+)/);
      out.push({
        pid: Number(entry),
        cwd: rawCwd.endsWith(" (deleted)") ? rawCwd.slice(0, -" (deleted)".length) : rawCwd,
        cmd,
        port: portMatch ? Number(portMatch[1]) : null,
      });
    } catch {
      // process exited during scan
    }
  }
  return out;
};

/** The owned serve child for this scenario's project cwd (exact-PID evidence). */
export const serveForProject = (project: string): ServeProcess | undefined =>
  opencodeProcesses().find((process_) => resolve(process_.cwd) === resolve(project));

export const httpJson = async (
  base: string,
  method: string,
  path: string,
  body?: unknown,
  wirePath?: string,
): Promise<HttpResult> => {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (wirePath) await appendNdjson(wirePath, { t: Date.now(), kind: "upstream-request", method, path, body });
  const response = await fetch(`${base}${path}`, init);
  const raw = await response.text();
  if (wirePath) {
    await appendNdjson(wirePath, {
      t: Date.now(), kind: "upstream-response", method, path,
      status: response.status, bytes: raw.length,
      body: raw.length > 6_000 ? `${raw.slice(0, 6_000)}…[${raw.length} bytes]` : raw,
    });
  }
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = raw;
  }
  return { status: response.status, body: parsed, raw };
};

export const upstreamMessages = async (
  base: string, backendSessionId: string, directory: string, wirePath?: string,
): Promise<Array<Record<string, unknown>>> => {
  const response = await httpJson(
    base, "GET",
    `/session/${encodeURIComponent(backendSessionId)}/message?directory=${encodeURIComponent(directory)}`,
    undefined, wirePath,
  );
  return Array.isArray(response.body) ? response.body as Array<Record<string, unknown>> : [];
};

export const messageRole = (message: Record<string, unknown>): string =>
  String((message.info as Record<string, unknown> | undefined)?.role ?? "");

export const messageText = (message: Record<string, unknown>): string =>
  (Array.isArray(message.parts) ? message.parts as Array<Record<string, unknown>> : [])
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");

/** How many upstream user messages contain the given text (double-dispatch oracle). */
export const upstreamUserTextCount = (
  messages: Array<Record<string, unknown>>, needle: string,
): number =>
  messages.filter((message) => messageRole(message) === "user" && messageText(message).includes(needle)).length;

// ---- D evidence -----------------------------------------------------------------------

export const databaseSnapshot = async (
  scratch: Scratch, name: string,
): Promise<Record<string, unknown>> => {
  const tables = [
    "events", "projections", "runtime_operations", "session_queue",
    "response_intents", "observations", "observation_checkpoints",
    "observation_cursors", "session_reconciliations", "deletion_tombstones",
    "attention_open",
  ];
  const result: Record<string, unknown> = {};
  const db = new DatabaseSync(scratch.dbPath);
  try {
    result.integrityCheck = db.prepare("PRAGMA integrity_check").all();
    try {
      result.walCheckpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").all();
    } catch (error) {
      result.walCheckpoint = { error: String(error) };
    }
    for (const table of tables) {
      try {
        result[table] = db.prepare(`SELECT * FROM ${table}`).all();
      } catch (error) {
        result[table] = { error: String(error) };
      }
    }
  } finally {
    db.close();
  }
  await writeFile(join(scratch.logsDir, `${name}.json`), json(result));
  return result;
};

export const dbRows = async (
  scratch: Scratch, table: string,
): Promise<Array<Record<string, unknown>>> => {
  const db = new DatabaseSync(scratch.dbPath, { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as unknown as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
};

// ---- verdicts ---------------------------------------------------------------------------

export interface Verdict {
  id: string;
  verdict: "pass" | "fail" | "blocked" | "partial";
  engine: "R" | "H" | "R+H";
  opencodeVersion: string;
  protocol: string;
  observed: string;
  expected: string;
  attribution: "NONE" | "POLYTH" | "OPENCODE" | "HARNESS" | "ENV" | "CONTRACT_GAP";
  /** Phase-7 stop-the-line: duplicate model-visible output / duplicate unkeyed
   * mutation (double admission, double answer, double dispatch) or
   * cross-session event leakage between clients. */
  multiClientBlocker: boolean;
  identifiers: Record<string, unknown>;
  evidence: string[];
  failures: string[];
  notes?: string;
}

export const manifest = async (scratch: Scratch, extra: Record<string, unknown>): Promise<void> => {
  await writeJson(join(scratch.artifactsDir, "manifest.json"), {
    id: scratch.id,
    headSha: HEAD_SHA,
    opencodeBin: OPENCODE_BIN,
    opencodeVersion: OPENCODE_VERSION,
    nodeVersion: process.version,
    os: `${platform()} ${release()}`,
    host: hostname(),
    model: MODEL,
    protocol: "legacy",
    projectPath: scratch.project,
    polythDataDir: scratch.dataDir,
    startedAt: new Date().toISOString(),
    ...extra,
  });
};

export const writeVerdict = async (scratch: Scratch, verdict: Verdict): Promise<void> => {
  await writeJson(join(scratch.artifactsDir, "verdict.json"), verdict);
  console.log(`[${verdict.id}] ${verdict.verdict.toUpperCase()}${verdict.multiClientBlocker ? " [BLOCKER]" : ""}: ${verdict.observed.slice(0, 220)}`);
  if (verdict.failures.length > 0) {
    for (const failure of verdict.failures) console.log(`  - ${failure}`);
  }
};

// ---- shared scenario steps ---------------------------------------------------------------

export interface Check {
  name: string;
  pass: boolean;
  observed: string;
}

export const makeChecks = (): { checks: Check[]; check: (name: string, pass: boolean, observed: string) => void } => {
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, observed: string) => {
    checks.push({ name, pass, observed: redact(observed) });
    console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: ${redact(observed).slice(0, 200)}`);
  };
  return { checks, check };
};

/** Create the project + session over HTTP and wait for idle binding. */
export const createIdleSession = async (
  client: HttpClient, projectPath: string, title: string,
): Promise<{ projectId: string; sessionId: string }> => {
  const project = await client.call("POST", "/api/projects", { path: projectPath, name: title });
  if (project.status !== 200) throw new Error(`project create failed: ${project.status} ${project.raw}`);
  const projectId = String((project.body as { id?: unknown }).id);
  const session = await client.call("POST", "/api/sessions", { projectId, title, model: MODEL });
  if (session.status !== 200) throw new Error(`session create failed: ${session.status} ${session.raw}`);
  const sessionId = String((session.body as { id?: unknown }).id);
  await waitFor(async () => {
    const snap = await client.call("GET", `/api/sessions/${sessionId}`);
    return (snap.body as { status?: string }).status === "idle";
  }, 60_000, 250, `session ${title} idle`);
  return { projectId, sessionId };
};

export const restEvents = async (client: HttpClient, sessionId: string): Promise<SessionEvent[]> => {
  const response = await client.call("GET", `/api/sessions/${sessionId}/events?afterSeq=0`);
  return Array.isArray(response.body) ? response.body as SessionEvent[] : [];
};

export const snapshotOf = async (client: HttpClient, sessionId: string): Promise<Record<string, unknown>> => {
  const response = await client.call("GET", `/api/sessions/${sessionId}`);
  return (response.body ?? {}) as Record<string, unknown>;
};

/** Order-convergence oracle: seq-ordered (type,seq) fingerprints must be equal. */
export const orderFingerprint = (events: SessionEvent[]): string =>
  [...events]
    .sort((a, b) => a.seq - b.seq)
    .map((event) => `${event.seq}:${event.type}`)
    .join("|");

export const duplicateSeqs = (events: SessionEvent[]): number[] => {
  const seen = new Set<number>();
  const dupes: number[] = [];
  for (const event of events) {
    if (seen.has(event.seq)) dupes.push(event.seq);
    seen.add(event.seq);
  }
  return dupes;
};

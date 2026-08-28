/**
 * Phase 6 (OC-REAL-068..072) worktree/directory isolation harness.
 *
 * R rows boot the production Polyth composition (`boot` from @polyth/server)
 * against the real pinned OpenCode 1.18.18 binary, one owned `opencode serve`
 * per resolved cwd. H rows compose the production session service over the
 * existing real-socket fault backend (`fakeOpenCode.ts`) with the exact
 * production sessionIdMap wiring, never substituting upstream semantics where
 * a real server is required.
 *
 * Fixture projects (authoritative directories):
 *   /tmp/polyth-tests/project-a                    IDENTITY.txt = PROJECT_A_MAIN
 *   /tmp/polyth-tests/project-a/worktree-feature   IDENTITY.txt = PROJECT_A_FEATURE
 *   /tmp/polyth-tests/project-b                    IDENTITY.txt = PROJECT_B_MAIN
 *   /tmp/polyth-tests/project-b/worktree-feature   IDENTITY.txt = PROJECT_B_FEATURE
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";

import { boot } from "@polyth/server";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const ARTIFACTS_ROOT = join(REPO_ROOT, "artifacts/opencode-real-world/phase-6");
export const LOGS_ROOT = join(REPO_ROOT, "logs/opencode-real-world/phase-6");
export const FIXTURE_ROOT = "/tmp/polyth-tests";
export const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "/home/ubuntu/.local/bin/opencode";
export const MODEL = { providerID: "opencode", modelID: "big-pickle" };
export const HEAD_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();
export const OPENCODE_VERSION = execFileSync(OPENCODE_BIN, ["--version"], { encoding: "utf8" }).trim();
if (OPENCODE_VERSION !== "1.18.18") {
  throw new Error(`Phase 6 requires OpenCode 1.18.18, got ${OPENCODE_VERSION}`);
}

export const MARKERS = {
  aMain: "PROJECT_A_MAIN",
  aFeature: "PROJECT_A_FEATURE",
  bMain: "PROJECT_B_MAIN",
  bFeature: "PROJECT_B_FEATURE",
} as const;

export interface FixturePaths {
  aRoot: string;
  aFeature: string;
  bRoot: string;
  bFeature: string;
}

export const FIXTURE: FixturePaths = {
  aRoot: join(FIXTURE_ROOT, "project-a"),
  aFeature: join(FIXTURE_ROOT, "project-a/worktree-feature"),
  bRoot: join(FIXTURE_ROOT, "project-b"),
  bFeature: join(FIXTURE_ROOT, "project-b/worktree-feature"),
};

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

/** Recreate both fixture projects from scratch: main branch + one feature
 * worktree each, exact identity markers, no leftover state from prior runs. */
export const resetFixture = (): void => {
  execFileSync("rm", ["-rf", FIXTURE.aRoot, FIXTURE.bRoot]);
  for (const [root, wt, mainMarker, featureMarker] of [
    [FIXTURE.aRoot, FIXTURE.aFeature, MARKERS.aMain, MARKERS.aFeature],
    [FIXTURE.bRoot, FIXTURE.bFeature, MARKERS.bMain, MARKERS.bFeature],
  ] as const) {
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    const git = (args: string[], cwd = root) => execFileSync("git", args, { cwd });
    git(["config", "user.name", "Phase6 Agent"]);
    git(["config", "user.email", "phase6@polyth.test"]);
    execFileSync("bash", ["-c", `printf '%s\n' '${mainMarker}' > '${root}/IDENTITY.txt'`]);
    execFileSync("bash", ["-c", `printf 'worktree-feature/\n' > '${root}/.gitignore'`]);
    git(["add", "-A"]);
    git(["commit", "-qm", "main identity"]);
    git(["worktree", "add", "-q", wt, "-b", "feature"]);
    execFileSync("bash", ["-c", `printf '%s\n' '${featureMarker}' > '${wt}/IDENTITY.txt'`]);
    git(["commit", "-qam", "feature identity"], wt);
  }
};

export interface Scratch {
  id: string;
  root: string;
  home: string;
  dataDir: string;
  configDir: string;
  artifactsDir: string;
  logsDir: string;
  dbPath: string;
}

export const makeScratch = async (id: string, sub?: string): Promise<Scratch> => {
  const dirId = sub ? `${id}/${sub}` : id;
  const root = `/tmp/ocreal-phase6/${dirId.toLowerCase()}-${Date.now().toString(36)}`;
  const home = join(root, "home");
  const dataDir = join(root, "polyth-data");
  const configDir = join(root, "opencode-config");
  const artifactsDir = join(ARTIFACTS_ROOT, dirId);
  const logsDir = join(LOGS_ROOT, dirId);
  if (process.env.PHASE6_ARCHIVE_EXISTING === "1" && !sub) {
    const suffix = `attempt-${Date.now().toString(36)}`;
    await rename(artifactsDir, join(ARTIFACTS_ROOT, `${id}-${suffix}`)).catch(() => undefined);
    await rename(logsDir, join(LOGS_ROOT, `${id}-${suffix}`)).catch(() => undefined);
  }
  await rm(artifactsDir, { recursive: true, force: true });
  await rm(logsDir, { recursive: true, force: true });
  for (const directory of [
    root, home, dataDir, configDir, artifactsDir, logsDir,
    join(home, ".config"), join(home, ".local/share"),
    join(home, ".local/state"), join(home, ".cache"),
  ]) await mkdir(directory, { recursive: true });
  return { id, root, home, dataDir, configDir, artifactsDir, logsDir, dbPath: join(dataDir, "sessions.db") };
};

const originalEnvironment = Object.fromEntries(
  ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "GOOGLE_GENERATIVE_AI_API_KEY", "POLYTH_DATA_DIR"]
    .map((key) => [key, process.env[key]]),
);

export const applyEnvironment = (scratch: Scratch): void => {
  process.env.HOME = scratch.home;
  process.env.XDG_CONFIG_HOME = join(scratch.home, ".config");
  process.env.XDG_DATA_HOME = join(scratch.home, ".local/share");
  process.env.XDG_STATE_HOME = join(scratch.home, ".local/state");
  process.env.XDG_CACHE_HOME = join(scratch.home, ".cache");
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY ?? "";
};

export const restoreEnvironment = (): void => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

/** Per-scenario opencode.json (isolated XDG config home). Read is always
 * allowed; bash defaults to ask so permission phases are reachable. */
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
      bash: permission.bash ?? "ask",
    },
  }, null, 2));
};

export const seedProjects = async (
  scratch: Scratch,
  projects: Array<{ id: string; path: string; name?: string }>,
): Promise<void> => {
  await writeJson(join(scratch.dataDir, "projects.json"), projects.map((project) => ({
    id: project.id,
    name: project.name ?? project.id,
    path: project.path,
    createdAt: Date.now(),
  })));
};

export interface RuntimeHandle {
  app: Awaited<ReturnType<typeof boot>>;
  baseUrl: string;
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
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
};

export const closeRuntime = async (runtime: RuntimeHandle | undefined): Promise<void> => {
  if (!runtime) return;
  await runtime.app.shutdown().catch(() => undefined);
  await sleep(300);
};

// ---- process / endpoint discovery (F evidence) ------------------------------------

export interface ServeProcess {
  pid: number;
  cwd: string;
  cwdDeleted: boolean;
  cmd: string;
  ports: number[];
}

export const opencodeProcesses = (): ServeProcess[] => {
  const out: ServeProcess[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ").trim();
      if (!/(^|\/)opencode\b/.test(cmd.split(" ")[0] ?? "") || !cmd.includes(" serve")) continue;
      const rawCwd = readlinkSync(`/proc/${entry}/cwd`);
      const cwdDeleted = rawCwd.endsWith(" (deleted)");
      const portMatch = cmd.match(/--port\s+(\d+)/);
      out.push({
        pid: Number(entry),
        cwd: cwdDeleted ? rawCwd.slice(0, -" (deleted)".length) : rawCwd,
        cwdDeleted,
        cmd,
        ports: portMatch ? [Number(portMatch[1])] : [],
      });
    } catch {
      // process exited during scan
    }
  }
  return out;
};

/** Only processes under the fixture root are ours; the VM has unrelated
 * long-lived `opencode serve` processes from earlier phases. */
export const fixtureServeProcesses = (): ServeProcess[] =>
  opencodeProcesses().filter((process_) => resolve(process_.cwd).startsWith(FIXTURE_ROOT));

export const serveFor = (cwd: string): ServeProcess | undefined =>
  fixtureServeProcesses().find((process_) => resolve(process_.cwd) === resolve(cwd));

// ---- upstream (O evidence) --------------------------------------------------------

export const httpJson = async (
  base: string,
  method: string,
  path: string,
  body?: unknown,
  wirePath?: string,
): Promise<{ status: number; body: unknown; raw: string }> => {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (wirePath) {
    await appendNdjson(wirePath, { t: Date.now(), kind: "request", method, path, body });
  }
  const response = await fetch(`${base}${path}`, init);
  const raw = await response.text();
  if (wirePath) {
    await appendNdjson(wirePath, {
      t: Date.now(), kind: "response", method, path,
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

export const upstreamSessions = async (
  base: string, directory: string, wirePath?: string,
): Promise<Array<Record<string, unknown>>> => {
  const response = await httpJson(base, "GET", `/session?directory=${encodeURIComponent(directory)}`, undefined, wirePath);
  return Array.isArray(response.body) ? response.body as Array<Record<string, unknown>> : [];
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

export const messageCwd = (message: Record<string, unknown>): string =>
  String(((message.info as Record<string, unknown> | undefined)?.path as Record<string, unknown> | undefined)?.cwd ?? "");

export const toolParts = (
  messages: Array<Record<string, unknown>>,
): Array<{ tool: string; status: string; output: string; error?: string }> =>
  messages
    .filter((message) => messageRole(message) === "assistant")
    .flatMap((message) => (Array.isArray(message.parts) ? message.parts as Array<Record<string, unknown>> : []))
    .filter((part) => part.type === "tool")
    .map((part) => {
      const state = (part.state ?? {}) as Record<string, unknown>;
      return {
        tool: String(part.tool ?? ""),
        status: String(state.status ?? ""),
        output: String(state.output ?? ""),
        ...(state.error ? { error: String(state.error) } : {}),
      };
    });

export const waitUpstreamAssistant = async (
  base: string, backendSessionId: string, directory: string, timeoutMs: number, wirePath?: string,
): Promise<{ completed: boolean; messages: Array<Record<string, unknown>>; text: string }> => {
  const deadline = Date.now() + timeoutMs;
  let messages: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    messages = await upstreamMessages(base, backendSessionId, directory, wirePath);
    const assistants = messages.filter((message) => messageRole(message) === "assistant");
    const last = assistants.at(-1) as { info?: { time?: { completed?: number }; error?: unknown } } | undefined;
    if (last?.info?.time?.completed || last?.info?.error) {
      return { completed: true, messages, text: messageText(last as Record<string, unknown>) };
    }
    await sleep(750);
  }
  return { completed: false, messages, text: "" };
};

// ---- Polyth-side helpers (P/D evidence) --------------------------------------------

export const waitEvent = async (
  runtime: RuntimeHandle,
  sessionId: string,
  predicate: (event: SessionEvent) => boolean,
  timeoutMs: number,
  label: string,
): Promise<SessionEvent> => {
  let found: SessionEvent | undefined;
  await waitFor(async () => {
    const events = await runtime.app.sessions.events(sessionId);
    found = events.find(predicate);
    return Boolean(found);
  }, timeoutMs, 200, label);
  return found!;
};

export const projectionOf = async (
  runtime: RuntimeHandle, sessionId: string,
): Promise<SessionProjection> => runtime.app.sessions.snapshot(sessionId);

/** Answer every open permission of a session with `once` as it appears. */
export const autoAnswerPermissions = (
  runtime: RuntimeHandle, sessionId: string, log: (entry: unknown) => void,
): { stop(): void; answered(): string[] } => {
  const answered: string[] = [];
  let active = true;
  void (async () => {
    while (active) {
      try {
        const events = await runtime.app.sessions.events(sessionId);
        const resolved = new Set(events
          .filter((event) => event.type === "permission/resolved")
          .map((event) => String((event.data as { requestId?: unknown }).requestId ?? "")));
        for (const event of events) {
          if (event.type !== "permission/requested") continue;
          const requestId = String((event.data as { requestId?: unknown }).requestId ?? "");
          if (!requestId || resolved.has(requestId) || answered.includes(requestId)) continue;
          answered.push(requestId);
          log({ t: Date.now(), kind: "auto-permission-reply", sessionId, requestId });
          await runtime.app.sessions.replyPermission(sessionId, requestId, "once");
        }
      } catch (error) {
        log({ t: Date.now(), kind: "auto-permission-error", sessionId, error: String(error) });
      }
      await sleep(300);
    }
  })();
  return { stop: () => { active = false; }, answered: () => answered };
};

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

// ---- WebSocket trace (U evidence) ---------------------------------------------------

export class WsTrace {
  readonly messages: unknown[] = [];
  readonly path: string;
  readonly socket: WebSocket;

  private constructor(path: string, socket: WebSocket) {
    this.path = path;
    this.socket = socket;
    socket.on("message", (raw) => {
      let body: unknown = String(raw);
      try {
        body = JSON.parse(String(raw)) as unknown;
      } catch {
        // keep malformed transport evidence as text
      }
      this.messages.push(body);
      void appendNdjson(this.path, { sequence: this.messages.length, time: Date.now(), message: body });
    });
  }

  static async open(baseUrl: string, path: string): Promise<WsTrace> {
    const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error("WebSocket open timeout")), 5_000);
      socket.once("open", () => {
        clearTimeout(timeout);
        resolveOpen();
      });
      socket.once("error", rejectOpen);
    });
    return new WsTrace(path, socket);
  }

  subscribe(sessionId: string, projectId: string): void {
    this.socket.send(JSON.stringify({ type: "subscribe", sessionId, projectId, afterSeq: 0 }));
  }

  close(): void {
    this.socket.close();
  }
}

// ---- verdicts -----------------------------------------------------------------------

export interface Verdict {
  id: string;
  verdict: "pass" | "fail" | "blocked" | "partial";
  engine: "R" | "H" | "R+H";
  opencodeVersion: string;
  protocol: string;
  observed: string;
  expected: string;
  attribution: "NONE" | "POLYTH" | "OPENCODE" | "HARNESS" | "ENV" | "CONTRACT_GAP";
  /** BLOCKER 6 — phase-6 stop-the-line: cross-worktree/root-fallback leakage
   * (a session escaping its authoritative directory/worktree, or a deleted
   * worktree silently falling back to repo root / last cwd / another tree). */
  crossTreeLeakBlocker: boolean;
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
    fixtureRoot: FIXTURE_ROOT,
    model: MODEL,
    protocol: "legacy",
    startedAt: new Date().toISOString(),
    ...extra,
  });
};

export const writeVerdict = async (scratch: Scratch, verdict: Verdict): Promise<void> => {
  await writeJson(join(scratch.artifactsDir, "verdict.json"), verdict);
  console.log(`[${verdict.id}] ${verdict.verdict.toUpperCase()}${verdict.crossTreeLeakBlocker ? " [BLOCKER-6]" : ""}: ${verdict.observed.slice(0, 220)}`);
  if (verdict.failures.length > 0) {
    for (const failure of verdict.failures) console.log(`  - ${failure}`);
  }
};

export const readEvents = async (
  runtime: RuntimeHandle, sessionId: string,
): Promise<SessionEvent[]> => runtime.app.sessions.events(sessionId);

/** Marker leak check: which foreign markers appear in the given text. */
export const foreignMarkers = (text: string, ownMarker: string): string[] =>
  Object.values(MARKERS).filter((marker) => marker !== ownMarker && text.includes(marker));

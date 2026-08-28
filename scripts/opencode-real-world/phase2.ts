/**
 * Phase 2 (OC-REAL-034..040) real-OpenCode mutation-ambiguity torture.
 *
 * Acceptance traffic uses the production Polyth composition and the pinned
 * real OpenCode 1.18.18 process. `phase2-shim.ts` changes transport behavior
 * only and records every mutation attempt and upstream response boundary.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { boot } from "@polyth/server";
import type { JsonObject, SessionEvent, SessionProjection } from "@polyth/contracts";
import { collectSse, httpJson, sleep } from "./lib.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const ARTIFACTS_ROOT = join(REPO_ROOT, "artifacts/opencode-real-world/phase-2");
const LOGS_ROOT = join(REPO_ROOT, "logs/opencode-real-world/phase-2");
const SHIM_BIN = join(import.meta.dirname, "phase2-shim.ts");
const REAL_BIN = process.env.OPENCODE_BIN ?? "/home/ubuntu/.local/bin/opencode";
const MODEL = { providerID: "opencode", modelID: "big-pickle" };
const QUEUE_MODEL = { providerID: "google", modelID: "gemini-3.5-flash" };
const PROJECT_ID = "phase-2-project";
const HEAD_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();
const OPENCODE_VERSION = execFileSync(REAL_BIN, ["--version"], { encoding: "utf8" }).trim();
if (OPENCODE_VERSION !== "1.18.18") {
  throw new Error(`Phase 2 requires OpenCode 1.18.18, got ${OPENCODE_VERSION}`);
}

interface Scratch {
  id: string;
  root: string;
  project: string;
  dataDir: string;
  configDir: string;
  home: string;
  controlDir: string;
  artifactsDir: string;
  logsDir: string;
  dbPath: string;
  rulesVersion: number;
}

interface Rule {
  id: string;
  method?: string;
  pathPattern?: string;
  bodyIncludes?: string;
  maxUses?: number;
  action: {
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
  };
}

interface ShimState {
  shimPid: number;
  opencodePid: number;
  proxyUrl: string;
  targetUrl: string;
  cwd: string;
  configDir: string;
  xdgDataHome: string;
  startedAt: number;
}

interface RuntimeHandle {
  app: Awaited<ReturnType<typeof boot>>;
  baseUrl: string;
  ws?: WsTrace;
}

interface Verdict {
  id: string;
  verdict: "pass" | "fail" | "blocked";
  engine: "R+H";
  opencodeVersion: string;
  protocol: string;
  observed: string;
  expected: string;
  attribution: "NONE" | "POLYTH" | "OPENCODE" | "HARNESS" | "ENV" | "CONTRACT_GAP";
  duplicateMutationBlocker: boolean;
  identifiers: {
    canonicalSessionIds: string[];
    backendSessionIds: string[];
    operationIds: string[];
    eventIds: string[];
  };
  evidence: string[];
  failures: string[];
  notes?: string;
}

interface WireEntry {
  sequence: number;
  time: number;
  kind: string;
  connectionId?: number;
  method?: string;
  path?: string;
  operationId?: string;
  ruleId?: string;
  action?: string;
  body?: unknown;
  status?: number;
  bytes?: number;
  downstreamBodyBytes?: number;
  upstreamBytes?: number;
  boundary?: string;
}

const originalEnvironment = Object.fromEntries(
  ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "POLYTH_PHASE2_SHIM_DIR", "OPENCODE_REAL_BIN", "GOOGLE_GENERATIVE_AI_API_KEY"]
    .map((key) => [key, process.env[key]]),
);

const json = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, JSON.stringify(value, null, 2));
};

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 100,
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
  throw new Error(`condition not reached in ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ""}`);
};

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const makeScratch = async (id: string): Promise<Scratch> => {
  const root = `/tmp/ocreal-phase2/${id.toLowerCase()}-${Date.now().toString(36)}`;
  const project = join(root, "project");
  const dataDir = join(root, "polyth-data");
  const configDir = join(root, "opencode-config");
  const home = join(root, "home");
  const controlDir = join(root, "shim");
  const artifactsDir = join(ARTIFACTS_ROOT, id);
  const logsDir = join(LOGS_ROOT, id);
  if (process.env.PHASE2_ARCHIVE_EXISTING === "1") {
    const suffix = `attempt-${Date.now().toString(36)}`;
    await rename(artifactsDir, join(ARTIFACTS_ROOT, `${id}-${suffix}`)).catch(() => undefined);
    await rename(logsDir, join(LOGS_ROOT, `${id}-${suffix}`)).catch(() => undefined);
  }
  await rm(artifactsDir, { recursive: true, force: true });
  await rm(logsDir, { recursive: true, force: true });
  for (const directory of [
    root,
    dataDir,
    configDir,
    home,
    controlDir,
    artifactsDir,
    logsDir,
    join(home, ".config"),
    join(home, ".local/share"),
    join(home, ".local/state"),
    join(home, ".cache"),
  ]) await mkdir(directory, { recursive: true });

  execFileSync("git", ["clone", "--quiet", "--shared", REPO_ROOT, project]);
  execFileSync("git", ["checkout", "--quiet", "--detach", HEAD_SHA], { cwd: project });
  await json(join(dataDir, "projects.json"), [{
    id: PROJECT_ID,
    name: `${id} isolated project`,
    path: project,
    createdAt: Date.now(),
  }]);
  const scratch = {
    id,
    root,
    project,
    dataDir,
    configDir,
    home,
    controlDir,
    artifactsDir,
    logsDir,
    dbPath: join(dataDir, "sessions.db"),
    rulesVersion: 0,
  };
  await setRules(scratch, []);
  return scratch;
};

const applyEnvironment = (scratch: Scratch): void => {
  process.env.HOME = scratch.home;
  process.env.XDG_CONFIG_HOME = join(scratch.home, ".config");
  process.env.XDG_DATA_HOME = join(scratch.home, ".local/share");
  process.env.XDG_STATE_HOME = join(scratch.home, ".local/state");
  process.env.XDG_CACHE_HOME = join(scratch.home, ".cache");
  process.env.POLYTH_PHASE2_SHIM_DIR = scratch.controlDir;
  process.env.OPENCODE_REAL_BIN = REAL_BIN;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY ?? "";
};

const restoreEnvironment = (): void => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const setRules = async (scratch: Scratch, rules: Rule[]): Promise<void> => {
  scratch.rulesVersion += 1;
  await json(join(scratch.controlDir, "rules.json"), {
    version: scratch.rulesVersion,
    rules,
  });
};

const readShimState = async (scratch: Scratch): Promise<ShimState> => {
  let state: ShimState | undefined;
  await waitFor(async () => {
    try {
      state = JSON.parse(await readFile(join(scratch.controlDir, "state.json"), "utf8")) as ShimState;
      return processAlive(state.shimPid) && processAlive(state.opencodePid);
    } catch {
      return false;
    }
  }, 30_000);
  return state!;
};

const readWire = async (scratch: Scratch): Promise<WireEntry[]> => {
  try {
    const raw = await readFile(join(scratch.controlDir, "wire.ndjson"), "utf8");
    return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as WireEntry);
  } catch {
    return [];
  }
};

const matchingRequests = async (
  scratch: Scratch,
  marker: string,
): Promise<WireEntry[]> =>
  (await readWire(scratch)).filter((entry) =>
    entry.kind === "request"
    && JSON.stringify(entry.body ?? "").includes(marker));

const openRuntime = async (
  scratch: Scratch,
  options: { wsSessionId?: string; wsLogName?: string } = {},
): Promise<RuntimeHandle> => {
  applyEnvironment(scratch);
  const app = await boot({
    port: 0,
    hostname: "127.0.0.1",
    dataDir: scratch.dataDir,
    opencode: {
      bin: SHIM_BIN,
      dataDir: scratch.configDir,
      protocol: "legacy",
      startupDeadlineMs: 30_000,
      probeDeadlineMs: 1_000,
    },
  });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Polyth did not bind a TCP port");
  if (address.port === 14500) throw new Error("forbidden Polyth port 14500 was selected");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const runtime: RuntimeHandle = { app, baseUrl };
  if (options.wsSessionId) {
    runtime.ws = await WsTrace.open(
      baseUrl.replace("http:", "ws:"),
      join(scratch.logsDir, options.wsLogName ?? "websocket.ndjson"),
    );
    runtime.ws.subscribe(options.wsSessionId);
  }
  return runtime;
};

const closeRuntime = async (runtime: RuntimeHandle | undefined): Promise<void> => {
  if (!runtime) return;
  runtime.ws?.close();
  await runtime.app.shutdown();
  await sleep(300);
};

class WsTrace {
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
        // Preserve malformed transport evidence as text.
      }
      this.messages.push(body);
      void appendFile(
        this.path,
        `${JSON.stringify({
          sequence: this.messages.length,
          time: Date.now(),
          message: body,
        })}\n`,
      );
    });
  }

  static async open(base: string, path: string): Promise<WsTrace> {
    const socket = new WebSocket(`${base}/ws`);
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

  subscribe(sessionId: string): void {
    this.socket.send(JSON.stringify({
      type: "subscribe",
      sessionId,
      projectId: PROJECT_ID,
      afterSeq: 0,
    }));
  }

  close(): void {
    this.socket.close();
  }
}

const sqlRows = (db: DatabaseSync, statement: string): Record<string, unknown>[] =>
  db.prepare(statement).all() as unknown as Record<string, unknown>[];

const databaseSnapshot = async (
  scratch: Scratch,
  name: string,
): Promise<Record<string, unknown>> => {
  const db = new DatabaseSync(scratch.dbPath);
  const tables = [
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
    "attention_open",
  ];
  const result: Record<string, unknown> = {};
  try {
    result.integrityCheck = sqlRows(db, "PRAGMA integrity_check");
    try {
      result.walCheckpoint = sqlRows(db, "PRAGMA wal_checkpoint(PASSIVE)");
    } catch (error) {
      result.walCheckpoint = { error: String(error) };
    }
    for (const table of tables) {
      try {
        result[table] = sqlRows(db, `SELECT * FROM ${table}`);
      } catch (error) {
        result[table] = { error: String(error) };
      }
    }
  } finally {
    db.close();
  }
  await json(join(scratch.logsDir, `${name}.json`), result);
  return result;
};

const rows = async (scratch: Scratch, table: string): Promise<Record<string, unknown>[]> => {
  const db = new DatabaseSync(scratch.dbPath, { readOnly: true });
  try {
    return sqlRows(db, `SELECT * FROM ${table}`);
  } finally {
    db.close();
  }
};

const operationsFor = async (
  scratch: Scratch,
  sessionId: string,
): Promise<Record<string, unknown>[]> =>
  (await rows(scratch, "runtime_operations"))
    .filter((row) => row.session_id === sessionId)
    .sort((left, right) => Number(left.ordinal) - Number(right.ordinal));

const eventsFor = async (
  runtime: RuntimeHandle,
  sessionId: string,
): Promise<SessionEvent[]> =>
  await runtime.app.sessions.events(sessionId);

const projectionFor = async (
  runtime: RuntimeHandle,
  sessionId: string,
): Promise<SessionProjection> =>
  await runtime.app.sessions.snapshot(sessionId);

const upstreamMessages = async (
  targetUrl: string,
  backendSessionId: string,
  project: string,
): Promise<Array<Record<string, unknown>>> => {
  const response = await httpJson(
    targetUrl,
    "GET",
    `/session/${encodeURIComponent(backendSessionId)}/message?limit=1000&directory=${encodeURIComponent(project)}`,
  );
  return Array.isArray(response.body) ? response.body as Array<Record<string, unknown>> : [];
};

const upstreamSessions = async (
  targetUrl: string,
  project: string,
): Promise<Array<Record<string, unknown>>> => {
  const response = await httpJson(
    targetUrl,
    "GET",
    `/session?directory=${encodeURIComponent(project)}`,
  );
  return Array.isArray(response.body) ? response.body as Array<Record<string, unknown>> : [];
};

const messageText = (message: Record<string, unknown>): string =>
  (Array.isArray(message.parts) ? message.parts as Array<Record<string, unknown>> : [])
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");

const messageRole = (message: Record<string, unknown>): string =>
  String((message.info as Record<string, unknown> | undefined)?.role ?? "");

const messageId = (message: Record<string, unknown>): string =>
  String((message.info as Record<string, unknown> | undefined)?.id ?? "");

const waitForUpstreamMarker = async (
  targetUrl: string,
  backendSessionId: string,
  project: string,
  marker: string,
  requireAgentTurn = false,
): Promise<Array<Record<string, unknown>>> => {
  let messages: Array<Record<string, unknown>> = [];
  await waitFor(async () => {
    messages = await upstreamMessages(targetUrl, backendSessionId, project);
    const user = messages.find((message) =>
      messageRole(message) === "user" && messageText(message).includes(marker));
    if (!user) return false;
    if (!requireAgentTurn) return true;
    return messages.some((message) =>
      messageRole(message) === "assistant"
      && String((message.info as Record<string, unknown> | undefined)?.parentID ?? "")
        === messageId(user));
  }, requireAgentTurn ? 90_000 : 30_000, 200);
  return messages;
};

const eventIdentifiers = (events: SessionEvent[]): string[] => events.map((event) => event.id);

const mutationOperation = (
  operations: Record<string, unknown>[],
  kind: string,
): Record<string, unknown> | undefined =>
  operations.findLast((operation) => operation.mutation_kind === kind);

const errorCode = (error: unknown): string =>
  String((error as { code?: unknown } | undefined)?.code ?? "");

const createManifest = async (
  scratch: Scratch,
  runtime: RuntimeHandle,
  state: ShimState,
  seed: string,
): Promise<void> => {
  const binary = await readFile(REAL_BIN);
  const address = runtime.app.server.address();
  await json(join(scratch.artifactsDir, "manifest.json"), {
    scenario: scratch.id,
    seed,
    gitSha: HEAD_SHA,
    opencode: {
      version: OPENCODE_VERSION,
      binary: REAL_BIN,
      sha256: createHash("sha256").update(binary).digest("hex"),
      shimPid: state.shimPid,
      pid: state.opencodePid,
      proxyUrl: state.proxyUrl,
      targetUrl: state.targetUrl,
      configDir: scratch.configDir,
      dataDir: join(scratch.home, ".local/share"),
    },
    polyth: {
      pid: process.pid,
      port: typeof address === "object" && address ? address.port : undefined,
      dataDir: scratch.dataDir,
    },
    project: scratch.project,
    worktree: scratch.project,
    node: process.version,
    os: `${platform()} ${release()}`,
    hostname: hostname(),
    protocol: "legacy (forced)",
    authority: "owned runtime; generation 1 unless restarted",
    createdAt: new Date().toISOString(),
  });
};

const writeVerdict = async (scratch: Scratch, verdict: Verdict): Promise<Verdict> => {
  await json(join(scratch.artifactsDir, "verdict.json"), verdict);
  console.log(`[${verdict.id}] ${verdict.verdict.toUpperCase()} blocker=${verdict.duplicateMutationBlocker} ${verdict.observed}`);
  return verdict;
};

const baseEvidence = (id: string): string[] => [
  `artifacts/opencode-real-world/phase-2/${id}/manifest.json`,
  `logs/opencode-real-world/phase-2/${id}/wire.ndjson`,
  `logs/opencode-real-world/phase-2/${id}/opencode.log`,
  `logs/opencode-real-world/phase-2/${id}/db-before.json`,
  `logs/opencode-real-world/phase-2/${id}/db-after.json`,
];

const copyShimLogs = async (scratch: Scratch): Promise<void> => {
  for (const name of ["wire.ndjson", "opencode.log", "state.json", "rules.json"]) {
    try {
      await writeFile(
        join(scratch.logsDir, name),
        await readFile(join(scratch.controlDir, name)),
      );
    } catch {
      // A process-start failure is itself reflected by the missing evidence.
    }
  }
};

const runPromptLoss = async (): Promise<Verdict> => {
  const scratch = await makeScratch("OC-REAL-034");
  let runtime: RuntimeHandle | undefined;
  const failures: string[] = [];
  const cases: Record<string, unknown>[] = [];
  const sessionIds: string[] = [];
  const backendIds: string[] = [];
  const operationIds: string[] = [];
  const allEventIds: string[] = [];
  let blocker = false;
  try {
    runtime = await openRuntime(scratch);
    // Runtime and DB are lazy until the first session.
    const first = await runtime.app.sessions.create({
      projectId: PROJECT_ID,
      title: "OC-REAL-034 bootstrap",
      model: MODEL,
    });
    sessionIds.push(first.id);
    const firstProjection = await projectionFor(runtime, first.id);
    backendIds.push(firstProjection.backendSessionId!);
    const state = await readShimState(scratch);
    await createManifest(scratch, runtime, state, "phase2-034-delays-0-1-2-5-10-25x2");
    await databaseSnapshot(scratch, "db-before");

    const delays = [0, 1, 2, 5, 10, 25, 0, 1, 2, 5, 10, 25];
    for (let index = 0; index < delays.length; index += 1) {
      const session = index === 0
        ? first
        : await runtime.app.sessions.create({
            projectId: PROJECT_ID,
            title: `OC-REAL-034 repeat ${index + 1}`,
            model: MODEL,
          });
      if (index > 0) sessionIds.push(session.id);
      const projection = await projectionFor(runtime, session.id);
      if (index > 0) backendIds.push(projection.backendSessionId!);
      const marker = `P2-034-${String(index + 1).padStart(2, "0")}`;
      await setRules(scratch, [{
        id: `034-drop-${index + 1}`,
        method: "POST",
        pathPattern: "/session/[^/]+/prompt_async(?:\\?|$)",
        bodyIncludes: marker,
        maxUses: 1,
        action: { kind: "drop-before-headers", delayMs: delays[index] },
      }]);

      let sendError = "";
      try {
        await runtime.app.sessions.send(session.id, {
          text: `Do not use tools. Reply with exactly ${marker}.`,
          model: MODEL,
        });
      } catch (error) {
        sendError = errorCode(error);
      }
      await setRules(scratch, []);
      const upstream = await waitForUpstreamMarker(
        state.targetUrl,
        projection.backendSessionId!,
        scratch.project,
        marker,
        true,
      );
      await waitFor(async () => {
        const operation = mutationOperation(await operationsFor(scratch, session.id), "turn-submit");
        return operation?.state === "unknown";
      }, 15_000);
      const operations = await operationsFor(scratch, session.id);
      const operation = mutationOperation(operations, "turn-submit")!;
      operationIds.push(String(operation.operation_id));
      const canonicalEvents = await eventsFor(runtime, session.id);
      allEventIds.push(...eventIdentifiers(canonicalEvents));
      const canonicalUsers = canonicalEvents.filter((event) =>
        event.type === "user/message"
        && String((event.data as { text?: unknown }).text ?? "").includes(marker));
      const upstreamUsers = upstream.filter((message) =>
        messageRole(message) === "user" && messageText(message).includes(marker));
      const upstreamAssistants = upstream.filter((message) =>
        messageRole(message) === "assistant"
        && String((message.info as Record<string, unknown> | undefined)?.parentID ?? "")
          === messageId(upstreamUsers[0] ?? {}));
      const requests = await matchingRequests(scratch, marker);
      let secondError = "";
      try {
        await runtime.app.sessions.send(session.id, {
          text: `Do not use tools. Reply with exactly ${marker}.`,
          model: MODEL,
        });
      } catch (error) {
        secondError = errorCode(error);
      }
      const requestsAfterSecond = await matchingRequests(scratch, marker);
      const caseFailures: string[] = [];
      if (sendError !== "outcome-unknown") caseFailures.push(`first send error=${sendError || "none"}`);
      if (operation.state !== "unknown") caseFailures.push(`operation state=${String(operation.state)}`);
      if (requests.length !== 1 || requestsAfterSecond.length !== 1) {
        caseFailures.push(`mutation requests=${requestsAfterSecond.length}`);
        blocker = requestsAfterSecond.length > 1;
      }
      if (canonicalUsers.length !== 1) caseFailures.push(`canonical user messages=${canonicalUsers.length}`);
      if (upstreamUsers.length !== 1) {
        caseFailures.push(`upstream user messages=${upstreamUsers.length}`);
        blocker ||= upstreamUsers.length > 1;
      }
      if (upstreamAssistants.length !== 1) {
        caseFailures.push(`upstream agent turns=${upstreamAssistants.length}`);
        blocker ||= upstreamAssistants.length > 1;
      }
      if (secondError !== "conflict") caseFailures.push(`second send error=${secondError || "none"}`);
      cases.push({
        repeat: index + 1,
        delayMs: delays[index],
        marker,
        canonicalSessionId: session.id,
        backendSessionId: projection.backendSessionId,
        operationId: operation.operation_id,
        eventIds: canonicalUsers.map((event) => event.id),
        requestConnectionIds: requestsAfterSecond.map((entry) => entry.connectionId),
        requestOperationIds: requestsAfterSecond.map((entry) => entry.operationId),
        sendError,
        secondError,
        canonicalUserMessages: canonicalUsers.length,
        upstreamUserMessages: upstreamUsers.length,
        upstreamAgentTurns: upstreamAssistants.length,
        projectionStatus: (await projectionFor(runtime, session.id)).status,
        failures: caseFailures,
      });
      failures.push(...caseFailures.map((failure) => `repeat ${index + 1}: ${failure}`));
      if (blocker) break;
    }
    await json(join(scratch.artifactsDir, "repeats.json"), { cases, failures });
    await databaseSnapshot(scratch, "db-after");
    return await writeVerdict(scratch, {
      id: scratch.id,
      verdict: failures.length === 0 ? "pass" : "fail",
      engine: "R+H",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy prompt_async (forced)",
      observed: `${cases.length} response-loss repeats across 0–25ms post-commit disconnects; ${cases.reduce((sum, item) => sum + Number(item.upstreamUserMessages ?? 0), 0)} upstream user messages; ${operationIds.length} distinct durable operations; no replay=${!blocker}`,
      expected: "one POST and one logical user message/agent turn per repeat; durable operation remains unknown; a second send is blocked",
      attribution: failures.length === 0 ? "NONE" : "POLYTH",
      duplicateMutationBlocker: blocker,
      identifiers: {
        canonicalSessionIds: sessionIds,
        backendSessionIds: backendIds,
        operationIds,
        eventIds: allEventIds,
      },
      evidence: [
        ...baseEvidence(scratch.id),
        `artifacts/opencode-real-world/phase-2/${scratch.id}/repeats.json`,
      ],
      failures,
      notes: "The proxy drops only after the real server's upstream response completes and before any downstream headers. OpenCode legacy history has no reflected x-polyth-operation-id, so reconciliation cannot use text similarity as a receipt.",
    });
  } finally {
    await closeRuntime(runtime);
    await copyShimLogs(scratch);
    restoreEnvironment();
  }
};

const messageOnlyDocRule = (): Rule => ({
  id: "legacy-message-only-doc",
  method: "GET",
  pathPattern: "^/doc(?:\\?|$)",
  action: {
    kind: "synthetic",
    status: 200,
    body: { paths: { "/session/{sessionID}/message": { post: {} } } },
  },
});

const runPartialBody = async (): Promise<Verdict> => {
  const scratch = await makeScratch("OC-REAL-035");
  let runtime: RuntimeHandle | undefined;
  const failures: string[] = [];
  let blocker = false;
  let sessionId = "";
  let backendSessionId = "";
  let operationId = "";
  let eventIds: string[] = [];
  try {
    // Real OpenCode's async prompt response is 204 with no body. The transport
    // shim narrows the real dual legacy surface to /message so a real JSON
    // success body can be truncated after 2xx headers.
    await setRules(scratch, [messageOnlyDocRule()]);
    runtime = await openRuntime(scratch);
    const session = await runtime.app.sessions.create({
      projectId: PROJECT_ID,
      title: "OC-REAL-035 partial body",
      model: MODEL,
    });
    sessionId = session.id;
    const projection = await projectionFor(runtime, sessionId);
    backendSessionId = projection.backendSessionId!;
    const state = await readShimState(scratch);
    await createManifest(scratch, runtime, state, "phase2-035-prefix-31");
    await databaseSnapshot(scratch, "db-before");
    const marker = "P2-035-PARTIAL";
    await setRules(scratch, [
      messageOnlyDocRule(),
      {
        id: "035-headers-partial-rst",
        method: "POST",
        pathPattern: "/session/[^/]+/message(?:\\?|$)",
        bodyIncludes: marker,
        maxUses: 1,
        action: { kind: "partial-body-reset", partialBytes: 31 },
      },
    ]);
    let sendError = "";
    try {
      await runtime.app.sessions.send(sessionId, {
        text: `Reply with exactly ${marker}.`,
        model: MODEL,
      });
    } catch (error) {
      sendError = errorCode(error);
    }
    await setRules(scratch, [messageOnlyDocRule()]);
    const upstream = await waitForUpstreamMarker(
      state.targetUrl,
      backendSessionId,
      scratch.project,
      marker,
      true,
    );
    const operations = await operationsFor(scratch, sessionId);
    const operation = mutationOperation(operations, "turn-submit");
    operationId = String(operation?.operation_id ?? "");
    const events = await eventsFor(runtime, sessionId);
    eventIds = eventIdentifiers(events);
    const requests = await matchingRequests(scratch, marker);
    const boundary = (await readWire(scratch)).find((entry) =>
      entry.ruleId === "035-headers-partial-rst" && entry.kind === "fault");
    const canonicalUsers = events.filter((event) =>
      event.type === "user/message"
      && String((event.data as { text?: unknown }).text ?? "").includes(marker));
    const upstreamUsers = upstream.filter((message) =>
      messageRole(message) === "user" && messageText(message).includes(marker));
    const upstreamAssistants = upstream.filter((message) =>
      messageRole(message) === "assistant"
      && String((message.info as Record<string, unknown> | undefined)?.parentID ?? "")
        === messageId(upstreamUsers[0] ?? {}));
    let secondError = "";
    try {
      await runtime.app.sessions.send(sessionId, { text: marker, model: MODEL });
    } catch (error) {
      secondError = errorCode(error);
    }
    const afterSecond = await matchingRequests(scratch, marker);
    if (sendError !== "outcome-unknown") failures.push(`first send error=${sendError || "none"}`);
    if (operation?.state !== "unknown") failures.push(`operation state=${String(operation?.state)}`);
    if (!boundary || !(Number(boundary.downstreamBodyBytes) > 0)
      || !(Number(boundary.downstreamBodyBytes) < Number(boundary.upstreamBytes))) {
      failures.push(`partial boundary not proven: ${JSON.stringify(boundary)}`);
    }
    if (requests.length !== 1 || afterSecond.length !== 1) {
      failures.push(`mutation requests=${afterSecond.length}`);
      blocker = afterSecond.length > 1;
    }
    if (canonicalUsers.length !== 1) failures.push(`canonical user messages=${canonicalUsers.length}`);
    if (upstreamUsers.length !== 1) {
      failures.push(`upstream user messages=${upstreamUsers.length}`);
      blocker ||= upstreamUsers.length > 1;
    }
    if (upstreamAssistants.length !== 1) {
      failures.push(`upstream agent turns=${upstreamAssistants.length}`);
      blocker ||= upstreamAssistants.length > 1;
    }
    if (secondError !== "conflict") failures.push(`second send error=${secondError || "none"}`);
    await json(join(scratch.artifactsDir, "partial-body.json"), {
      marker,
      sendError,
      secondError,
      operation,
      boundary,
      requests,
      canonicalUserEventIds: canonicalUsers.map((event) => event.id),
      upstreamUserMessageIds: upstreamUsers.map(messageId),
      upstreamAgentMessageIds: upstreamAssistants.map(messageId),
      failures,
    });
    await databaseSnapshot(scratch, "db-after");
    return await writeVerdict(scratch, {
      id: scratch.id,
      verdict: failures.length === 0 ? "pass" : "fail",
      engine: "R+H",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy message path, real dual surface narrowed by read-only transport shim",
      observed: `real 2xx JSON response was cut at ${String(boundary?.downstreamBodyBytes)} of ${String(boundary?.upstreamBytes)} body bytes and reset; outcome=${String(operation?.state)}; POSTs=${afterSecond.length}`,
      expected: "one POST; partial success is unknown, not confirmation/rejection; scheduler remains blocked without duplicate dispatch",
      attribution: failures.length === 0 ? "NONE" : "POLYTH",
      duplicateMutationBlocker: blocker,
      identifiers: {
        canonicalSessionIds: [sessionId],
        backendSessionIds: [backendSessionId],
        operationIds: [operationId],
        eventIds,
      },
      evidence: [
        ...baseEvidence(scratch.id),
        `artifacts/opencode-real-world/phase-2/${scratch.id}/partial-body.json`,
      ],
      failures,
      notes: "The /doc response is transport-shimmed only to select OpenCode's real synchronous legacy /message endpoint; the mutation, model execution, and response body all come from real OpenCode.",
    });
  } finally {
    await closeRuntime(runtime);
    await copyShimLogs(scratch);
    restoreEnvironment();
  }
};

const runTimeout = async (): Promise<Verdict> => {
  const scratch = await makeScratch("OC-REAL-036");
  let runtime: RuntimeHandle | undefined;
  const failures: string[] = [];
  let blocker = false;
  let sessionId = "";
  let backendSessionId = "";
  let operationId = "";
  let eventIds: string[] = [];
  try {
    runtime = await openRuntime(scratch);
    const session = await runtime.app.sessions.create({
      projectId: PROJECT_ID,
      title: "OC-REAL-036 timeout",
      model: MODEL,
    });
    sessionId = session.id;
    const projection = await projectionFor(runtime, sessionId);
    backendSessionId = projection.backendSessionId!;
    const state = await readShimState(scratch);
    await createManifest(scratch, runtime, state, "phase2-036-delay-12000");
    await databaseSnapshot(scratch, "db-before");
    const marker = "P2-036-TIMEOUT";
    await setRules(scratch, [{
      id: "036-delay-after-accept",
      method: "POST",
      pathPattern: "/session/[^/]+/prompt_async(?:\\?|$)",
      bodyIncludes: marker,
      maxUses: 1,
      action: { kind: "delay-response", delayMs: 12_000 },
    }]);
    const startedAt = Date.now();
    let sendError = "";
    try {
      await runtime.app.sessions.send(sessionId, {
        text: `Reply with exactly ${marker}.`,
        model: MODEL,
      });
    } catch (error) {
      sendError = errorCode(error);
    }
    const elapsedMs = Date.now() - startedAt;
    const upstream = await waitForUpstreamMarker(
      state.targetUrl,
      backendSessionId,
      scratch.project,
      marker,
      true,
    );
    await waitFor(async () =>
      (await readWire(scratch)).some((entry) =>
        entry.ruleId === "036-delay-after-accept" && entry.kind === "fault-release"),
    20_000);
    await setRules(scratch, []);
    const operations = await operationsFor(scratch, sessionId);
    const operation = mutationOperation(operations, "turn-submit");
    operationId = String(operation?.operation_id ?? "");
    const events = await eventsFor(runtime, sessionId);
    eventIds = eventIdentifiers(events);
    const requests = await matchingRequests(scratch, marker);
    const canonicalUsers = events.filter((event) =>
      event.type === "user/message"
      && String((event.data as { text?: unknown }).text ?? "").includes(marker));
    const upstreamUsers = upstream.filter((message) =>
      messageRole(message) === "user" && messageText(message).includes(marker));
    const upstreamAssistants = upstream.filter((message) =>
      messageRole(message) === "assistant"
      && String((message.info as Record<string, unknown> | undefined)?.parentID ?? "")
        === messageId(upstreamUsers[0] ?? {}));
    if (sendError !== "outcome-unknown") failures.push(`send error=${sendError || "none"}`);
    if (elapsedMs < 9_000 || elapsedMs > 15_000) failures.push(`deadline elapsed=${elapsedMs}ms`);
    if (operation?.state !== "unknown") failures.push(`late response settled operation=${String(operation?.state)}`);
    if (requests.length !== 1) {
      failures.push(`mutation requests=${requests.length}`);
      blocker = requests.length > 1;
    }
    if (canonicalUsers.length !== 1) failures.push(`canonical user messages=${canonicalUsers.length}`);
    if (upstreamUsers.length !== 1) {
      failures.push(`upstream user messages=${upstreamUsers.length}`);
      blocker ||= upstreamUsers.length > 1;
    }
    if (upstreamAssistants.length !== 1) {
      failures.push(`upstream agent turns=${upstreamAssistants.length}`);
      blocker ||= upstreamAssistants.length > 1;
    }
    await json(join(scratch.artifactsDir, "timeout.json"), {
      marker,
      elapsedMs,
      sendError,
      operationAfterLateRelease: operation,
      requestConnectionIds: requests.map((entry) => entry.connectionId),
      canonicalUserEventIds: canonicalUsers.map((event) => event.id),
      upstreamUserMessageIds: upstreamUsers.map(messageId),
      upstreamAgentMessageIds: upstreamAssistants.map(messageId),
      failures,
    });
    await databaseSnapshot(scratch, "db-after");
    return await writeVerdict(scratch, {
      id: scratch.id,
      verdict: failures.length === 0 ? "pass" : "fail",
      engine: "R+H",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy prompt_async (forced)",
      observed: `real prompt committed, downstream response held 12s; Polyth deadline returned unknown in ${elapsedMs}ms; late release left operation=${String(operation?.state)} and POST count=${requests.length}`,
      expected: "one bounded attempt; timeout is unknown; a late response cannot settle the fenced operation",
      attribution: failures.length === 0 ? "NONE" : "POLYTH",
      duplicateMutationBlocker: blocker,
      identifiers: {
        canonicalSessionIds: [sessionId],
        backendSessionIds: [backendSessionId],
        operationIds: [operationId],
        eventIds,
      },
      evidence: [
        ...baseEvidence(scratch.id),
        `artifacts/opencode-real-world/phase-2/${scratch.id}/timeout.json`,
      ],
      failures,
    });
  } finally {
    await closeRuntime(runtime);
    await copyShimLogs(scratch);
    restoreEnvironment();
  }
};

interface QueueWorkerResult {
  phase: "initial" | "restart";
  polythPid: number;
  sessionId: string;
  backendSessionId: string;
  queue: unknown[];
  operations: Record<string, unknown>[];
  events: SessionEvent[];
  projection: SessionProjection;
  headOperationId: string;
  headQueueId: string;
  laterQueueId: string;
}

const worker037 = async (phase: "initial" | "restart", root: string): Promise<void> => {
  const scratch = JSON.parse(await readFile(join(root, "scratch.json"), "utf8")) as Scratch;
  let runtime: RuntimeHandle | undefined;
  try {
    runtime = await openRuntime(scratch);
    let sessionId: string;
    let headQueueId = "";
    let laterQueueId = "";
    if (phase === "initial") {
      const created = await runtime.app.sessions.create({
        projectId: PROJECT_ID,
        title: "OC-REAL-037 queue restart",
        model: QUEUE_MODEL,
      });
      sessionId = created.id;
      await runtime.app.sessions.send(sessionId, {
        text: "Reply with exactly QUEUE-INITIAL-037.",
        model: QUEUE_MODEL,
      });
      const head = await runtime.app.sessions.send(sessionId, {
        text: "Reply with exactly QUEUE-HEAD-037.",
        model: QUEUE_MODEL,
        delivery: "queue",
      });
      const later = await runtime.app.sessions.send(sessionId, {
        text: "Reply with exactly QUEUE-LATER-037.",
        model: QUEUE_MODEL,
        delivery: "queue",
      });
      headQueueId = String(head.queueId ?? "");
      laterQueueId = String(later.queueId ?? "");
      await sleep(2_000);
      await runtime.app.sessions.abort(sessionId);
      await waitFor(async () => {
        const operations = await operationsFor(scratch, sessionId);
        return operations.some((operation) =>
          operation.mutation_kind === "turn-submit" && operation.state === "unknown");
      }, 90_000).catch(() => undefined);
    } else {
      const initial = JSON.parse(
        await readFile(join(root, "worker-initial.json"), "utf8"),
      ) as QueueWorkerResult;
      sessionId = initial.sessionId;
      headQueueId = initial.headQueueId;
      laterQueueId = initial.laterQueueId;
      await runtime.app.sessions.events(sessionId, 0);
      await sleep(3_000);
    }
    const projection = await projectionFor(runtime, sessionId);
    const operations = await operationsFor(scratch, sessionId);
    const headOperation = operations.find((operation) =>
      operation.mutation_kind === "turn-submit" && operation.state === "unknown");
    const result: QueueWorkerResult = {
      phase,
      polythPid: process.pid,
      sessionId,
      backendSessionId: projection.backendSessionId!,
      queue: await runtime.app.sessions.queueList!(sessionId),
      operations,
      events: await runtime.app.sessions.events(sessionId),
      projection,
      headOperationId: String(headOperation?.operation_id ?? ""),
      headQueueId,
      laterQueueId,
    };
    await json(join(root, `worker-${phase}.json`), result);
    if (phase === "initial") {
      process.send?.({ type: "ready", result });
      await new Promise<void>(() => {});
    }
  } finally {
    if (phase === "restart") await closeRuntime(runtime);
    await copyShimLogs(scratch);
    restoreEnvironment();
  }
};

const spawnQueueWorker = (
  phase: "initial" | "restart",
  scratch: Scratch,
): ChildProcess => {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker-037", phase, scratch.root], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: scratch.home,
      XDG_CONFIG_HOME: join(scratch.home, ".config"),
      XDG_DATA_HOME: join(scratch.home, ".local/share"),
      XDG_STATE_HOME: join(scratch.home, ".local/state"),
      XDG_CACHE_HOME: join(scratch.home, ".cache"),
      POLYTH_PHASE2_SHIM_DIR: scratch.controlDir,
      OPENCODE_REAL_BIN: REAL_BIN,
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GEMINI_API_KEY ?? "",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const outputPath = join(scratch.logsDir, `polyth-${phase}.log`);
  child.stdout?.on("data", (chunk) => void writeFile(outputPath, chunk, { flag: "a" }));
  child.stderr?.on("data", (chunk) => void writeFile(outputPath, chunk, { flag: "a" }));
  return child;
};

const waitForChildExit = async (child: ChildProcess, timeoutMs: number): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error(`child ${child.pid} did not exit`)), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
};

const runQueueRestart = async (): Promise<Verdict> => {
  const scratch = await makeScratch("OC-REAL-037");
  const failures: string[] = [];
  let blocker = false;
  await json(join(scratch.root, "scratch.json"), scratch);
  await setRules(scratch, [{
    id: "037-queue-head-drop",
    method: "POST",
    pathPattern: "/session/[^/]+/prompt_async(?:\\?|$)",
    bodyIncludes: "QUEUE-HEAD-037",
    maxUses: 1,
    action: { kind: "drop-before-headers", delayMs: 2 },
  }]);
  await json(join(scratch.root, "scratch.json"), scratch);
  const initialWorker = spawnQueueWorker("initial", scratch);
  let initial: QueueWorkerResult | undefined;
  try {
    await waitFor(async () => {
      try {
        initial = JSON.parse(
          await readFile(join(scratch.root, "worker-initial.json"), "utf8"),
        ) as QueueWorkerResult;
        return true;
      } catch {
        if (initialWorker.exitCode !== null || initialWorker.signalCode !== null) {
          throw new Error(`initial queue worker exited ${initialWorker.exitCode}/${initialWorker.signalCode}`);
        }
        return false;
      }
    }, 120_000, 200);
    const initialState = await readShimState(scratch);
    const fakeRuntimeForManifest = {
      app: { server: { address: () => null } },
    } as unknown as RuntimeHandle;
    await createManifest(scratch, fakeRuntimeForManifest, initialState, "phase2-037-crash-restart");
    await databaseSnapshot(scratch, "db-before");
    const workerPid = initialWorker.pid!;
    const workerProc = await readFile(`/proc/${workerPid}/stat`, "utf8");
    await json(join(scratch.logsDir, "crash-boundary.json"), {
      polythPid: workerPid,
      procStat: workerProc,
      shimPid: initialState.shimPid,
      opencodePid: initialState.opencodePid,
      headOperationId: initial!.headOperationId,
      headQueueId: initial!.headQueueId,
      laterQueueId: initial!.laterQueueId,
      signal: "SIGKILL",
      time: Date.now(),
    });
    initialWorker.kill("SIGKILL");
    await waitForChildExit(initialWorker, 10_000);
    if (!processAlive(initialState.shimPid) || !processAlive(initialState.opencodePid)) {
      failures.push("owned shim/OpenCode did not survive the Polyth SIGKILL boundary");
    }

    const restartWorker = spawnQueueWorker("restart", scratch);
    await waitForChildExit(restartWorker, 60_000);
    const restarted = JSON.parse(
      await readFile(join(scratch.root, "worker-restart.json"), "utf8"),
    ) as QueueWorkerResult;
    const requests = await matchingRequests(scratch, "QUEUE-HEAD-037");
    const laterRequests = await matchingRequests(scratch, "QUEUE-LATER-037");
    const queue = restarted.queue as Array<{ id?: string }>;
    const queueIds = queue.map((item) => item.id);
    const headOperation = restarted.operations.find((operation) =>
      operation.operation_id === initial!.headOperationId);
    const headCanonical = restarted.events.filter((event) =>
      event.type === "user/message"
      && String((event.data as { text?: unknown }).text ?? "").includes("QUEUE-HEAD-037"));
    const laterCanonical = restarted.events.filter((event) =>
      event.type === "user/message"
      && String((event.data as { text?: unknown }).text ?? "").includes("QUEUE-LATER-037"));
    const initialAgentCompleted = initial!.events.some((event) =>
      event.type === "assistant/message"
      && String((event.data as { text?: unknown }).text ?? "").includes("QUEUE-INITIAL-037"));
    if (!initial!.headOperationId) {
      failures.push(initialAgentCompleted
        ? "real initial turn completed upstream but Polyth emitted no terminal event, so the queued head was never reserved or dispatched"
        : "real initial prompt was accepted but produced no observable terminal event, so the queued head was never reserved or dispatched");
    }
    if (requests.length !== 1) {
      failures.push(`queue head mutation requests=${requests.length}`);
      blocker = requests.length > 1;
    }
    if (laterRequests.length !== 0) {
      failures.push(`later item overtook head with ${laterRequests.length} requests`);
      blocker = true;
    }
    if (headOperation?.state !== "unknown") failures.push(`head operation state=${String(headOperation?.state)}`);
    if (restarted.headOperationId !== initial!.headOperationId) {
      failures.push(`operation ID changed ${initial!.headOperationId} -> ${restarted.headOperationId}`);
      blocker = true;
    }
    if (queueIds[0] !== initial!.headQueueId || queueIds[1] !== initial!.laterQueueId) {
      failures.push(`queue order/loss=${JSON.stringify(queueIds)}`);
    }
    if (headCanonical.length !== 1) failures.push(`head canonical messages=${headCanonical.length}`);
    if (laterCanonical.length !== 0) failures.push(`later canonical messages=${laterCanonical.length}`);
    await json(join(scratch.artifactsDir, "queue-restart.json"), {
      initial: {
        polythPid: initial!.polythPid,
        sessionId: initial!.sessionId,
        backendSessionId: initial!.backendSessionId,
        headOperationId: initial!.headOperationId,
        queue: initial!.queue,
        projection: initial!.projection,
      },
      restart: {
        polythPid: restarted.polythPid,
        headOperationId: restarted.headOperationId,
        queue: restarted.queue,
        projection: restarted.projection,
      },
      requestConnectionIds: requests.map((entry) => entry.connectionId),
      requestOperationIds: requests.map((entry) => entry.operationId),
      laterRequestConnectionIds: laterRequests.map((entry) => entry.connectionId),
      headCanonicalEventIds: headCanonical.map((event) => event.id),
      crash: { pid: initialWorker.pid, signal: "SIGKILL" },
      failures,
    });
    await databaseSnapshot(scratch, "db-after");
    await copyShimLogs(scratch);
    return await writeVerdict(scratch, {
      id: scratch.id,
      verdict: failures.length === 0 ? "pass" : "fail",
      engine: "R+H",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy prompt_async (forced)",
      observed: initial!.headOperationId
        ? `reserved FIFO head ${initial!.headQueueId} used operation ${initial!.headOperationId}; after exact-PID SIGKILL and Polyth restart the same unknown reservation blocks ${initial!.laterQueueId}; head POSTs=${requests.length}, later POSTs=${laterRequests.length}`
        : `${initialAgentCompleted ? "real OpenCode completed" : "real OpenCode accepted"} the initial agent turn, but Polyth received no terminal event and never reserved/dispatched FIFO head ${initial!.headQueueId}; head POSTs=${requests.length}, later POSTs=${laterRequests.length}`,
      expected: "same reserved head and operation ID survive; no redispatch or later-item overtaking after restart",
      attribution: failures.length === 0 ? "NONE" : (initialAgentCompleted ? "POLYTH" : "ENV"),
      duplicateMutationBlocker: blocker,
      identifiers: {
        canonicalSessionIds: [initial!.sessionId],
        backendSessionIds: [initial!.backendSessionId],
        operationIds: [initial!.headOperationId],
        eventIds: headCanonical.map((event) => event.id),
      },
      evidence: [
        ...baseEvidence(scratch.id),
        `artifacts/opencode-real-world/phase-2/${scratch.id}/queue-restart.json`,
        `logs/opencode-real-world/phase-2/${scratch.id}/crash-boundary.json`,
        `logs/opencode-real-world/phase-2/${scratch.id}/polyth-initial.log`,
        `logs/opencode-real-world/phase-2/${scratch.id}/polyth-restart.log`,
      ],
      failures,
    });
  } finally {
    if (initialWorker.exitCode === null && initialWorker.signalCode === null) {
      initialWorker.kill("SIGKILL");
      await waitForChildExit(initialWorker, 10_000).catch(() => undefined);
    }
    try {
      const state = await readShimState(scratch);
      if (processAlive(state.shimPid)) process.kill(state.shimPid, "SIGTERM");
    } catch {
      // Restart worker normally owns final cleanup.
    }
  }
};

const configureOpenCode = async (
  scratch: Scratch,
  value: Record<string, unknown>,
): Promise<void> => {
  await mkdir(scratch.configDir, { recursive: true });
  await json(join(scratch.configDir, "opencode.json"), {
    "$schema": "https://opencode.ai/config.json",
    ...value,
  });
};

const waitForEventType = async (
  runtime: RuntimeHandle,
  sessionId: string,
  type: string,
  timeoutMs = 90_000,
): Promise<SessionEvent> => {
  let found: SessionEvent | undefined;
  await waitFor(async () => {
    found = (await eventsFor(runtime, sessionId)).find((event) => event.type === type);
    return found !== undefined;
  }, timeoutMs, 200);
  return found!;
};

const pendingDirect = async (
  targetUrl: string,
  path: "/permission" | "/question",
  project: string,
): Promise<unknown[]> => {
  const response = await httpJson(
    targetUrl,
    "GET",
    `${path}?directory=${encodeURIComponent(project)}`,
  );
  return Array.isArray(response.body) ? response.body : [];
};

const attentionRules = (
  kind: "permission" | "question",
  requestId: string,
  stalePending: unknown[],
  marker: string,
  empty = false,
): Rule[] => [
  {
    id: `${kind}-sse-blackhole`,
    method: "GET",
    pathPattern: "^/event(?:\\?|$)",
    action: { kind: "blackhole" },
  },
  {
    id: `${kind}-pending-${empty ? "empty" : "stale"}`,
    method: "GET",
    pathPattern: `^/${kind}(?:\\?|$)`,
    action: { kind: "synthetic", status: 200, body: empty ? [] : stalePending },
  },
  {
    id: `${kind}-answer-drop`,
    method: "POST",
    pathPattern: kind === "permission"
      ? `/session/[^/]+/permissions/${requestId}(?:\\?|$)`
      : `/question/${requestId}/(?:reply|reject)(?:\\?|$)`,
    bodyIncludes: marker,
    maxUses: 1,
    action: { kind: "drop-before-headers", delayMs: 2 },
  },
];

const runAttentionLoss = async (
  kind: "permission" | "question",
): Promise<Verdict> => {
  const id = kind === "permission" ? "OC-REAL-038" : "OC-REAL-039";
  const scratch = await makeScratch(id);
  if (kind === "permission") {
    await configureOpenCode(scratch, { permission: { bash: "ask" } });
  }
  let runtime: RuntimeHandle | undefined;
  let restarted: RuntimeHandle | undefined;
  const failures: string[] = [];
  let blocker = false;
  let sessionId = "";
  let backendSessionId = "";
  let operationId = "";
  let eventIds: string[] = [];
  let requestId = "";
  try {
    runtime = await openRuntime(scratch);
    const session = await runtime.app.sessions.create({
      projectId: PROJECT_ID,
      title: `${id} ${kind} ambiguity`,
      model: MODEL,
    });
    sessionId = session.id;
    const projection = await projectionFor(runtime, sessionId);
    backendSessionId = projection.backendSessionId!;
    runtime.ws = await WsTrace.open(
      runtime.baseUrl.replace("http:", "ws:"),
      join(scratch.logsDir, "websocket-before-restart.ndjson"),
    );
    runtime.ws.subscribe(sessionId);
    const state = await readShimState(scratch);
    await createManifest(scratch, runtime, state, `phase2-${kind}-stale-empty-restart`);
    const independentSse = collectSse(
      state.targetUrl,
      `/event?directory=${encodeURIComponent(scratch.project)}`,
      join(scratch.logsDir, "upstream-sse.ndjson"),
    );
    const prompt = kind === "permission"
      ? "Use the bash tool exactly once to run: printf P2_PERMISSION_TOOL_MARKER"
      : "Use the question tool to ask me one single-choice question: choose red or blue.";
    await runtime.app.sessions.send(sessionId, { text: prompt, model: MODEL });
    const requested = await waitForEventType(
      runtime,
      sessionId,
      kind === "permission" ? "permission/requested" : "question/asked",
    );
    requestId = String((requested.data as { requestId?: unknown }).requestId ?? "");
    const stalePending = await pendingDirect(
      state.targetUrl,
      kind === "permission" ? "/permission" : "/question",
      scratch.project,
    );
    if (!stalePending.some((entry) =>
      String((entry as { id?: unknown }).id ?? "") === requestId)) {
      failures.push("independent pending list did not contain the live request before answer");
    }
    await databaseSnapshot(scratch, "db-before");
    const answerMarker = kind === "permission" ? "\"response\":\"reject\"" : "\"blue\"";
    await setRules(scratch, attentionRules(kind, requestId, stalePending, answerMarker));
    process.kill(state.shimPid, "SIGUSR1");
    await sleep(300);
    let answerError = "";
    try {
      if (kind === "permission") {
        await runtime.app.sessions.replyPermission(sessionId, requestId, "reject");
      } else {
        await runtime.app.sessions.replyQuestion(sessionId, requestId, { q1: "blue" });
      }
    } catch (error) {
      answerError = errorCode(error);
    }
    const upstreamEventType = kind === "permission" ? "permission.replied" : "question.replied";
    await independentSse.waitFor((event) => event.type === upstreamEventType
      && String((event.data as { properties?: { id?: unknown } }).properties?.id ?? "") === requestId,
    15_000);
    const actualPending = await pendingDirect(
      state.targetUrl,
      kind === "permission" ? "/permission" : "/question",
      scratch.project,
    );
    await waitFor(async () => {
      const operation = (await operationsFor(scratch, sessionId)).find((candidate) =>
        String(candidate.mutation_kind).startsWith(`${kind}-`));
      return operation?.state === "unknown";
    }, 15_000);
    const staleOperation = (await operationsFor(scratch, sessionId)).find((candidate) =>
      String(candidate.mutation_kind).startsWith(`${kind}-`))!;
    operationId = String(staleOperation.operation_id);
    const staleEvents = await eventsFor(runtime, sessionId);
    const resolvedType = kind === "permission" ? "permission/resolved" : "question/answered";
    const responseIntentsBefore = (await rows(scratch, "response_intents"))
      .filter((row) => row.session_id === sessionId && row.request_id === requestId);
    await setRules(scratch, attentionRules(kind, requestId, stalePending, answerMarker, true));
    process.kill(state.shimPid, "SIGUSR1");
    await sleep(1_500);
    const emptySnapshotOperation = (await operationsFor(scratch, sessionId))
      .find((candidate) => candidate.operation_id === operationId);
    const emptySnapshotEvents = await eventsFor(runtime, sessionId);
    const requestsBeforeRestart = await matchingRequests(scratch, answerMarker.replaceAll("\\", ""));
    independentSse.close();
    const websocketMessagesBeforeRestart = runtime.ws?.messages.length ?? 0;
    await closeRuntime(runtime);
    runtime = undefined;

    restarted = await openRuntime(scratch);
    restarted.ws = await WsTrace.open(
      restarted.baseUrl.replace("http:", "ws:"),
      join(scratch.logsDir, "websocket-after-restart.ndjson"),
    );
    restarted.ws.subscribe(sessionId);
    await restarted.app.sessions.events(sessionId, 0);
    const restartedState = await readShimState(scratch);
    await sleep(1_500);
    const responseIntentsAfter = (await rows(scratch, "response_intents"))
      .filter((row) => row.session_id === sessionId && row.request_id === requestId);
    const restartOperation = (await operationsFor(scratch, sessionId))
      .find((candidate) => candidate.operation_id === operationId);
    const restartEvents = await eventsFor(restarted, sessionId);
    let secondError = "";
    try {
      if (kind === "permission") {
        await restarted.app.sessions.replyPermission(sessionId, requestId, "reject");
      } else {
        await restarted.app.sessions.replyQuestion(sessionId, requestId, { q1: "blue" });
      }
    } catch (error) {
      secondError = errorCode(error);
    }
    await sleep(300);
    const requestsAfterRestart = await matchingRequests(scratch, answerMarker.replaceAll("\\", ""));
    eventIds = eventIdentifiers(restartEvents);
    const openRequestedCount = restartEvents.filter((event) =>
      event.type === (kind === "permission" ? "permission/requested" : "question/asked")
      && String((event.data as { requestId?: unknown }).requestId ?? "") === requestId).length;
    const resolvedCount = restartEvents.filter((event) =>
      event.type === resolvedType
      && String((event.data as { requestId?: unknown }).requestId ?? "") === requestId).length;
    const actualStillPending = actualPending.some((entry) =>
      String((entry as { id?: unknown }).id ?? "") === requestId);
    if (answerError !== "outcome-unknown") failures.push(`answer error=${answerError || "none"}`);
    if (actualStillPending) failures.push("real upstream still reports answered request pending");
    if (staleOperation.state !== "unknown"
      || emptySnapshotOperation?.state !== "unknown"
      || restartOperation?.state !== "unknown") {
      failures.push(`operation states stale=${String(staleOperation.state)} empty=${String(emptySnapshotOperation?.state)} restart=${String(restartOperation?.state)}`);
    }
    if (responseIntentsBefore.length !== 1 || responseIntentsAfter.length !== 1) {
      failures.push(`response intent counts before/after=${responseIntentsBefore.length}/${responseIntentsAfter.length}`);
    }
    if (openRequestedCount !== 1 || resolvedCount !== 0) {
      failures.push(`durable card requested/resolved=${openRequestedCount}/${resolvedCount}`);
    }
    if (requestsBeforeRestart.length !== 1 || requestsAfterRestart.length !== 1) {
      failures.push(`answer mutation requests=${requestsAfterRestart.length}`);
      blocker = requestsAfterRestart.length > 1;
    }
    if (secondError !== "conflict" && secondError !== "binding-mismatch") {
      failures.push(`stale second answer error=${secondError || "none"}`);
    }
    if (!processAlive(restartedState.shimPid) || !processAlive(restartedState.opencodePid)) {
      failures.push("restart runtime process evidence unavailable");
    }
    await json(join(scratch.artifactsDir, `${kind}-ambiguity.json`), {
      canonicalSessionId: sessionId,
      backendSessionId,
      requestId,
      operationId,
      requestedEventId: requested.id,
      stalePendingCount: stalePending.length,
      actualPendingAfterAnswer: actualPending,
      answerError,
      secondError,
      operationStates: {
        stale: staleOperation.state,
        emptyPartialSnapshot: emptySnapshotOperation?.state,
        afterRestart: restartOperation?.state,
      },
      responseIntentOperationIds: responseIntentsAfter.map((row) => row.operation_id),
      durableCard: { requestedCount: openRequestedCount, resolvedCount },
      requestConnectionIds: requestsAfterRestart.map((entry) => entry.connectionId),
      requestOperationIds: requestsAfterRestart.map((entry) => entry.operationId),
      websocketMessagesBeforeRestart,
      websocketMessagesAfterRestart: restarted.ws.messages.length,
      failures,
    });
    await databaseSnapshot(scratch, "db-after");
    return await writeVerdict(scratch, {
      id,
      verdict: failures.length === 0 ? "pass" : "fail",
      engine: "R+H",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `real ${kind} answer applied upstream and ack was lost; stale then empty partial pending snapshots and full Polyth/OpenCode restart retained one unknown operation/intent/open card; answer POSTs=${requestsAfterRestart.length}`,
      expected: "one answer mutation; intent/payload and card remain durable until exact or causally complete proof; stale client cannot answer again",
      attribution: failures.length === 0 ? "NONE" : "POLYTH",
      duplicateMutationBlocker: blocker,
      identifiers: {
        canonicalSessionIds: [sessionId],
        backendSessionIds: [backendSessionId],
        operationIds: [operationId],
        eventIds,
      },
      evidence: [
        ...baseEvidence(id),
        `artifacts/opencode-real-world/phase-2/${id}/${kind}-ambiguity.json`,
        `logs/opencode-real-world/phase-2/${id}/upstream-sse.ndjson`,
        `logs/opencode-real-world/phase-2/${id}/websocket-before-restart.ndjson`,
        `logs/opencode-real-world/phase-2/${id}/websocket-after-restart.ndjson`,
      ],
      failures,
      notes: `Legacy pending-list completeness is partial. Both an intentionally stale list and a later empty list are therefore non-causal and must not settle the answer. A both-side restart changes the generation-only endpoint authority, so stale-client replay is conservatively blocked with ${secondError}.`,
    });
  } finally {
    await closeRuntime(runtime);
    await closeRuntime(restarted);
    await copyShimLogs(scratch);
    restoreEnvironment();
  }
};

const waitForTerminalProjection = async (
  runtime: RuntimeHandle,
  sessionId: string,
  timeoutMs = 90_000,
): Promise<void> => {
  await waitFor(async () => {
    const status = (await projectionFor(runtime, sessionId)).status;
    return status === "idle" || status === "failed" || status === "unknown";
  }, timeoutMs, 250);
};

const runForkLoss = async (): Promise<Verdict> => {
  const scratch = await makeScratch("OC-REAL-040");
  let runtime: RuntimeHandle | undefined;
  let restarted: RuntimeHandle | undefined;
  const failures: string[] = [];
  let blocker = false;
  let sessionId = "";
  let backendSessionId = "";
  let operationId = "";
  let eventIds: string[] = [];
  let unsupported = false;
  try {
    runtime = await openRuntime(scratch);
    const session = await runtime.app.sessions.create({
      projectId: PROJECT_ID,
      title: "OC-REAL-040 fork source",
      model: MODEL,
    });
    sessionId = session.id;
    const projection = await projectionFor(runtime, sessionId);
    backendSessionId = projection.backendSessionId!;
    const state = await readShimState(scratch);
    await createManifest(scratch, runtime, state, "phase2-040-fork-restart");
    const beforeSessions = await upstreamSessions(state.targetUrl, scratch.project);
    await databaseSnapshot(scratch, "db-before");
    await setRules(scratch, [{
      id: "040-fork-drop",
      method: "POST",
      pathPattern: "^/session(?:\\?|$)",
      bodyIncludes: "(fork)",
      maxUses: 1,
      action: { kind: "drop-before-headers", delayMs: 2 },
    }]);
    let forkError = "";
    try {
      await runtime.app.sessions.fork(sessionId);
    } catch (error) {
      forkError = errorCode(error);
    }
    await setRules(scratch, []);
    const operations = await operationsFor(scratch, sessionId);
    const forkOperation = mutationOperation(operations, "session-fork");
    operationId = String(forkOperation?.operation_id ?? "");
    const afterSessions = await upstreamSessions(state.targetUrl, scratch.project);
    const beforeIds = new Set(beforeSessions.map((entry) => String(entry.id)));
    const createdChildren = afterSessions.filter((entry) =>
      !beforeIds.has(String(entry.id)));
    const forkRequestsBefore = (await readWire(scratch)).filter((entry) =>
      entry.kind === "request"
      && entry.method === "POST"
      && entry.ruleId === "040-fork-drop");
    unsupported = !forkRequestsBefore.some((entry) =>
      new RegExp(`/session/${backendSessionId}/fork(?:\\?|$)`).test(entry.path ?? ""));
    const sourceEventsBefore = await eventsFor(runtime, sessionId);
    const intended = sourceEventsBefore.find((event) => event.type === "session/fork-intended");
    const intendedChildId = String((intended?.data as { childSessionId?: unknown } | undefined)?.childSessionId ?? "");
    const canonicalChildrenBefore = (await runtime.app.sessions.list(PROJECT_ID))
      .filter((entry) => entry.parentId === sessionId);

    await closeRuntime(runtime);
    runtime = undefined;
    restarted = await openRuntime(scratch);
    await restarted.app.sessions.events(sessionId, 0);
    const restartState = await readShimState(scratch);
    await sleep(1_500);
    let secondError = "";
    try {
      await restarted.app.sessions.fork(sessionId);
    } catch (error) {
      secondError = errorCode(error);
    }
    await sleep(300);
    const finalSessions = await upstreamSessions(restartState.targetUrl, scratch.project);
    const finalChildren = finalSessions.filter((entry) =>
      !beforeIds.has(String(entry.id)));
    const forkRequests = (await readWire(scratch)).filter((entry) =>
      entry.kind === "request"
      && entry.method === "POST"
      && (new RegExp(`/session/${backendSessionId}/fork(?:\\?|$)`).test(entry.path ?? "")
        || JSON.stringify(entry.body ?? "").includes("(fork)")));
    const finalOperations = await operationsFor(scratch, sessionId);
    const finalForkOperation = finalOperations.find((entry) => entry.operation_id === operationId);
    const finalEvents = await eventsFor(restarted, sessionId);
    eventIds = eventIdentifiers(finalEvents);
    const canonicalChildren = (await restarted.app.sessions.list(PROJECT_ID))
      .filter((entry) => entry.parentId === sessionId);
    if (forkError !== "outcome-unknown") failures.push(`fork error=${forkError || "none"}`);
    if (forkRequests.length !== 1) {
      failures.push(`fork mutation requests=${forkRequests.length}`);
      blocker = forkRequests.length > 1;
    }
    if (createdChildren.length > 1 || finalChildren.length > 1) {
      failures.push(`upstream fork children before/after restart=${createdChildren.length}/${finalChildren.length}`);
      blocker = true;
    }
    if (createdChildren.length !== 1) failures.push(`real fork-like children=${createdChildren.length}`);
    if (canonicalChildrenBefore.length !== 0 || canonicalChildren.length !== 0) {
      failures.push(`canonical children published before/after=${canonicalChildrenBefore.length}/${canonicalChildren.length}`);
    }
    if (forkOperation?.state !== "unknown" || finalForkOperation?.state !== "unknown") {
      failures.push(`fork operation states before/after=${String(forkOperation?.state)}/${String(finalForkOperation?.state)}`);
    }
    if (secondError !== "conflict" && secondError !== "binding-mismatch") {
      failures.push(`second fork error=${secondError || "none"}`);
    }
    await json(join(scratch.artifactsDir, "fork-ambiguity.json"), {
      sourceCanonicalSessionId: sessionId,
      sourceBackendSessionId: backendSessionId,
      intendedChildCanonicalId: intendedChildId,
      forkOperationId: operationId,
      forkError,
      secondError,
      forkSupported: !unsupported,
      upstreamChildrenBeforeRestart: createdChildren.map((entry) => ({
        id: entry.id,
        parentID: entry.parentID,
        title: entry.title,
      })),
      upstreamChildrenAfterRestart: finalChildren.map((entry) => ({
        id: entry.id,
        parentID: entry.parentID,
        title: entry.title,
      })),
      canonicalChildrenBeforeRestart: canonicalChildrenBefore.map((entry) => entry.id),
      canonicalChildrenAfterRestart: canonicalChildren.map((entry) => entry.id),
      requestConnectionIds: forkRequests.map((entry) => entry.connectionId),
      requestOperationIds: forkRequests.map((entry) => entry.operationId),
      failures,
    });
    await databaseSnapshot(scratch, "db-after");
    return await writeVerdict(scratch, {
      id: scratch.id,
      verdict: failures.length === 0 ? "pass" : "fail",
      engine: "R+H",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy compatibility create (native fork unsupported)",
      observed: unsupported
        ? `active protocol used an unkeyed compatibility create, committed orphan child ${String(createdChildren[0]?.id)}, and lost its response; operation remained unknown and restart blocked a second create`
        : `real fork committed child ${String(createdChildren[0]?.id)} and response was lost; Polyth published no canonical child, retained operation ${operationId} unknown across both-side restart, and emitted ${forkRequests.length} fork POST`,
      expected: "never issue a second unkeyed fork; publish no child without the exact returned ID; do not adopt by title/history similarity",
      attribution: failures.length === 0 ? "NONE" : (unsupported ? "CONTRACT_GAP" : "POLYTH"),
      duplicateMutationBlocker: blocker,
      identifiers: {
        canonicalSessionIds: [sessionId, ...(intendedChildId ? [intendedChildId] : [])],
        backendSessionIds: [backendSessionId, ...finalChildren.map((entry) => String(entry.id))],
        operationIds: [operationId],
        eventIds,
      },
      evidence: [
        ...baseEvidence(scratch.id),
        `artifacts/opencode-real-world/phase-2/${scratch.id}/fork-ambiguity.json`,
      ],
      failures,
      notes: unsupported
        ? `Legacy does not use OpenCode's native fork endpoint; it falls back to an unkeyed session create. Safety behavior is accepted for that actual wire contract, and stale replay was conservatively blocked with ${secondError}.`
        : `Both Polyth and the owned real OpenCode process were shut down and recreated from the same isolated durable directories before the second-attempt check. The generation-only authority changed, so replay was conservatively blocked with ${secondError}.`,
    });
  } finally {
    await closeRuntime(runtime);
    await closeRuntime(restarted);
    await copyShimLogs(scratch);
    restoreEnvironment();
  }
};

const main = async (): Promise<void> => {
  await mkdir(ARTIFACTS_ROOT, { recursive: true });
  await mkdir(LOGS_ROOT, { recursive: true });
  const requested = new Set(
    (process.env.PHASE2_IDS ?? "034,035,036,037,038,039,040")
      .split(",")
      .map((value) => `OC-REAL-${value.trim().padStart(3, "0")}`),
  );
  const verdicts: Verdict[] = [];
  if (requested.has("OC-REAL-034")) verdicts.push(await runPromptLoss());
  if (requested.has("OC-REAL-035")) verdicts.push(await runPartialBody());
  if (requested.has("OC-REAL-036")) verdicts.push(await runTimeout());
  if (requested.has("OC-REAL-037")) verdicts.push(await runQueueRestart());
  if (requested.has("OC-REAL-038")) verdicts.push(await runAttentionLoss("permission"));
  if (requested.has("OC-REAL-039")) verdicts.push(await runAttentionLoss("question"));
  if (requested.has("OC-REAL-040")) verdicts.push(await runForkLoss());
  await json(join(ARTIFACTS_ROOT, "results.json"), {
    generatedAt: new Date().toISOString(),
    gitSha: HEAD_SHA,
    opencodeVersion: OPENCODE_VERSION,
    verdicts,
  });
};

if (process.argv[2] === "--worker-037") {
  await worker037(process.argv[3] as "initial" | "restart", process.argv[4]!);
} else {
  await main();
}

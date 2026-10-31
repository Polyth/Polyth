import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentIdFrom, serializeAgentFile } from "./agentFile.ts";
import { parseAgentDefinition } from "./loops.ts";
import {
  roleAtLeast,
  type AgentCapabilityContributionRegistry,
  type Disposable,
  type RouteHandler,
  type SessionService,
  type SpaceContext,
} from "@polyth/contracts";
import { AGENTS_PACKAGE_ID, agentsSkill, createAgentsTool } from "./agentTool.ts";
import {
  adoptLegacyPackageData,
  localOnlyRemoteAccess,
  packageDataDir,
  serverServiceKey,
  SERVER_TURN_STOPPED_BUS,
  SESSION_ATTENTION_SERVICE,
  AGENT_EVENT_SOURCES,
  type AgentEventSourceDescriptor,
  systemAppendSessionEvent,
  systemSessionsForProject,
  systemSessionsForSession,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { checkWakeScript, runWakeScript, scriptEvents } from "./agentScript.ts";
import { cacheTelemetry, KEEP_ALIVE_PROMPT, planWarm, runCacheStats } from "./agentCache.ts";
import { promptLayers } from "./agentPrompt.ts";
import { DRAFT_SYSTEM_PROMPT, draftPrompt, parseAgentDraft, type AgentDraft } from "./agentDraft.ts";
import {
  AGENT_SESSION_PURPOSE,
  agentSpecOf,
  assertLoopExecutionTrusted,
  budgetExceeded,
  spendInLastDay,
  composeAgentPrompt,
  createScheduleService,
  DEFAULT_ROTATE_AT,
  DEFAULT_PACE,
  describeEvent,
  explainMatch,
  simulateWakes,
  triggerMatches,
  validateTrigger,
  type AgentEvent,
  type AgentEventTrigger,
  isAgentContinuation,
  rollingKeyOf,
  scanLoopsDir,
  isRouteFailure,
  scheduleExecutionRoutes,
  scheduleExecutionSelection,
  scheduleTurnAdmission,
  settleScheduledRun,
  type AgentBudget,
  type AgentColor,
  type CatchUpPolicy,
  type ScheduleCadence,
  type ScheduleRunner,
  type ScheduleRunOutcome,
  type ScheduleRunRecord,
  type ScheduleTask,
  type AgentPermissionLevel,
  type ScheduleExecutionModel,
  type ScheduleExecutionSelection,
  type ScheduleService,
  type ScheduleTarget,
  type ScheduleTaskInput,
  validateRunAttachments,
} from "./index.ts";
import {
  exchangeAt,
  followUpRun,
  FOLLOW_UP_WINDOW_MS,
  threadDecision,
  type AgentContinuation,
  type AgentFreshReason,
  type ThreadDecision,
  type ThreadSession,
  type ThreadTarget,
} from "./agentThread.ts";

const cadenceOf = (raw: unknown): ScheduleCadence | undefined => {
  const cadence = raw as Record<string, unknown> | undefined;
  if (!cadence || typeof cadence !== "object") return undefined;
  if (cadence.kind === "at") return { kind: "at", at: Number(cadence.at) };
  if (cadence.kind === "every") return { kind: "every", everyMinutes: Number(cadence.everyMinutes) };
  if (cadence.kind === "cron") return {
    kind: "cron",
    expression: String(cadence.expression ?? ""),
    timeZone: String(cadence.timeZone ?? ""),
  };
  return undefined;
};

const targetOf = (raw: unknown): ScheduleTarget | undefined => {
  const target = raw as Record<string, unknown> | undefined;
  if (!target || typeof target !== "object") return undefined;
  if (target.mode !== "existing-session" && target.mode !== "new-session-per-run" && target.mode !== "dedicated-session") return undefined;
  return {
    mode: target.mode,
    ...(target.sessionId ? { sessionId: String(target.sessionId) } : {}),
    ...(target.worktreePolicy === "fresh-worktree" ? { worktreePolicy: "fresh-worktree" as const } : {}),
  };
};

const modelOf = (raw: unknown): ScheduleExecutionModel | undefined => {
  const model = raw as Record<string, unknown> | undefined;
  if (!model || typeof model !== "object") return undefined;
  const providerID = typeof model.providerID === "string" ? model.providerID.trim() : "";
  const modelID = typeof model.modelID === "string" ? model.modelID.trim() : "";
  if (!providerID || !modelID) return undefined;
  return {
    providerID,
    modelID,
    ...(typeof model.variant === "string" && model.variant ? { variant: model.variant } : {}),
    ...(typeof model.harnessId === "string" && model.harnessId ? { harnessId: model.harnessId } : {}),
  };
};

const harnessOf = (raw: unknown): { mode: "auto" } | { mode: "pinned"; harnessId: string } | undefined => {
  const harness = raw as Record<string, unknown> | undefined;
  if (!harness || typeof harness !== "object") return undefined;
  if (harness.mode === "auto") return { mode: "auto" };
  if (harness.mode === "pinned" && typeof harness.harnessId === "string" && harness.harnessId.trim()) {
    return { mode: "pinned", harnessId: harness.harnessId.trim() };
  }
  return undefined;
};

const budgetOf = (raw: unknown): AgentBudget | undefined => {
  const budget = raw as Record<string, unknown> | undefined;
  if (!budget || typeof budget !== "object") return undefined;
  const out: AgentBudget = {};
  for (const key of ["runsPerDay", "tokensPerDay", "costPerDay"] as const) {
    if (budget[key] !== undefined && budget[key] !== null) out[key] = Number(budget[key]);
  }
  return out;
};

/** Write an agent as `.agents/agents/<id>.md` and make the agent follow
 *  that file. `export` turns an app-made agent into a file; `convert`
 *  replaces a trusted legacy loop file with the new format. Never follows
 *  symlinks and never overwrites an existing file. */
export function writeAgentFile(
  schedule: ScheduleService,
  task: ScheduleTask,
  project: { path: string; remote?: unknown },
  action: "export" | "convert",
  spaceId: string,
): ScheduleTask & { filePath: string } {
  const fail = (message: string, code: string) => Object.assign(new Error(message), { code });
  if (project.remote) throw fail("Agent files can only be written in local projects.", "unsupported");
  if (action === "export" && task.source === "loop-file") throw fail("This agent already lives in a file.", "conflict");
  if (action === "convert") {
    if (task.source !== "loop-file" || !task.sourcePath || !/[\\/]\.agents[\\/]loops[\\/][^\\/]+\.md$/.test(task.sourcePath)) {
      throw fail("Only a loop file can be converted.", "invalid-input");
    }
    if (task.trustState !== "trusted-current-version") throw fail("Trust the loop's current version before converting it.", "content-trust-required");
  }
  const agentsRoot = join(project.path, ".agents");
  const dir = join(agentsRoot, "agents");
  for (const path of [agentsRoot, dir]) {
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isDirectory()) throw fail(`${path} is not a plain directory.`, "conflict");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      mkdirSync(path);
    }
  }
  const taken = new Set(readdirSync(dir));
  let id = action === "convert" ? task.loopId! : agentIdFrom(task.title ?? task.prompt.slice(0, 40));
  if (action === "export") for (let n = 2; taken.has(`${id}.md`); n += 1) id = `${agentIdFrom(task.title ?? "agent")}-${n}`;
  if (taken.has(`${id}.md`)) throw fail(`.agents/agents/${id}.md already exists.`, "conflict");
  const text = serializeAgentFile(agentSpecOf(task, id));
  const parsed = parseAgentDefinition(text);
  if (!parsed.loop) throw fail(`The agent could not be written as a file: ${parsed.parseError}`, "invalid-input");
  const target = join(dir, `${id}.md`);
  writeFileSync(target, text, { flag: "wx" });
  if (action === "convert") {
    // The new file replaces the loop: both would claim the same id.
    const old = lstatSync(task.sourcePath!);
    if (old.isFile() && !old.isSymbolicLink()) unlinkSync(task.sourcePath!);
  }
  const digest = createHash("sha256").update(text).digest("hex");
  const adopted = schedule.adoptFile(task.id, spaceId, { path: target, digest, loop: parsed.loop });
  return { ...adopted, filePath: `.agents/agents/${id}.md` };
}

/** The agents service other packages resolve by key (the package id). */
export const AGENTS_SERVICE = serverServiceKey<ScheduleService>("agents");
/** Routes and webhook URLs keep their pre-rename name: `/api/agents` is the
 *  host's harness-agent list, and webhook URLs live in other services. */
export const WEBHOOK_PREFIX = "/hooks/schedule/";
const WEBHOOK_BODY_LIMIT = 64 * 1024;

function readLimited(req: import("node:http").IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) return reject(new Error("too large"));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { req.destroy(); reject(new Error("too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const header = (headers: import("node:http").IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** A webhook body as event fields: a title, the sender's event name, and
 *  compact text. Never parsed further — it is data for the agent. */
export function webhookInput(raw: string, headers: import("node:http").IncomingHttpHeaders): { title?: string; event?: string; text: string } {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { /* plain text */ }
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = parsed?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const event = header(headers, "x-github-event") ?? header(headers, "x-gitlab-event") ?? header(headers, "x-event-key")
    ?? pick("event", "type", "action");
  const title = pick("title", "subject", "name", "summary", "message") ?? event;
  const text = parsed ? JSON.stringify(parsed) : raw;
  return { ...(title ? { title } : {}), ...(event ? { event } : {}), text: text.trim() };
}

/** Replace stored webhook token hashes with a presence flag. */
/**
 * What the caller may do with a task (§14.2): `own` — its owner, server work,
 * a loop file's task (repository content every member can read), or a Space
 * admin for an ownerless legacy task; `admin` — a Space admin looking at
 * someone else's task: its metadata, pause/resume/stop/delete, never its
 * prompt, notebook or runs; `none` — not even its existence.
 */
export type ScheduleTaskAccess = "own" | "admin" | "none";

const isPerson = (space: SpaceContext): boolean =>
  Boolean(space.userId) && !space.userId.startsWith("system:")
  && (space as { authority?: { kind?: unknown } }).authority?.kind !== "system";

export function scheduleTaskAccess(space: SpaceContext, task: Pick<ScheduleTask, "ownerUserId" | "source">): ScheduleTaskAccess {
  if (!isPerson(space) || task.source === "loop-file") return "own";
  if (task.ownerUserId === space.userId) return "own";
  const admin = roleAtLeast(space.role, "admin");
  if (!task.ownerUserId) return admin ? "own" : "none";
  return admin ? "admin" : "none";
}

/** Someone else's task as a Space admin sees it: what and when, not what it says or did. */
const METADATA_KEYS = [
  "id", "projectId", "spaceId", "ownerUserId", "title", "description", "icon", "color", "kind", "at", "everyMinutes",
  "cadence", "enabled", "manualOnly", "createdAt", "updatedAt", "lastRunAt", "nextRunAt", "runs", "source", "tripped",
] as const;
export const scheduleTaskMetadata = (task: ScheduleTask): ScheduleTask => ({
  ...Object.fromEntries(METADATA_KEYS.filter((key) => task[key] !== undefined).map((key) => [key, task[key]])),
  prompt: "",
}) as ScheduleTask;

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.eventTriggers) && !Array.isArray(record.tasks)) return value;
  if (Array.isArray(record.tasks)) return { ...record, tasks: record.tasks.map(scrub) };
  return {
    ...record,
    eventTriggers: (record.eventTriggers as Array<Record<string, unknown>>).map(({ tokenHash, ...trigger }) =>
      trigger.kind === "webhook" ? { ...trigger, hasToken: Boolean(tokenHash) } : trigger),
  };
}

export interface AgentDraftRequest {
  projectId: string;
  projectPath: string;
  description: string;
  /** Excerpt of a conversation the agent should continue. */
  conversation?: string;
  timeZone: string;
  userId?: string;
}

const validZone = (zone: unknown): string => {
  if (typeof zone !== "string" || !zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
};

const contextModeOf = (task: Pick<ScheduleTask, "target" | "sessionId">): ScheduleTarget["mode"] =>
  task.target?.mode ?? (task.sessionId ? "existing-session" : "new-session-per-run");

/** Reads a session a run might continue: undefined when it is gone or is
 *  not in the agent's project and Space. */
export type ThreadSessionReader = (task: ScheduleTask, sessionId: string) => Promise<ThreadSession | undefined>;

export interface AgentThreadChoice {
  decision: ThreadDecision;
  /** `rollingKeyOf(task)` now. */
  currentKey: string;
  /** The session the run could continue, when there is one. */
  candidate?: { sessionId: string; at: number; key?: string };
  /** Fresh agents: the run the person's message follows up. */
  run?: ScheduleRunRecord;
}

/** Whether a rolling or fresh agent's run continues a session or starts a
 *  new one. The run and the owner's preview (`followUp`) share it, so the
 *  person is told what the run will do. `existing-session` agents always go
 *  to their chosen session and never ask. `fixed`: where a fresh agent's
 *  waiting message was promised to go when it queued; only that session's
 *  health is checked again. A rolling agent always follows its ongoing
 *  conversation, which may have moved on while the message waited. */
export async function chooseThread(
  task: ScheduleTask,
  input: { continuation: AgentContinuation; personal: boolean; now: number; excludeRunId?: string; fixed?: ThreadTarget },
  sessionOf: ThreadSessionReader,
): Promise<AgentThreadChoice> {
  const mode = contextModeOf(task) === "dedicated-session" ? "rolling" : "fresh";
  const currentKey = rollingKeyOf(task);
  let continuation = input.continuation;
  let run: ScheduleRunRecord | undefined;
  let candidate: AgentThreadChoice["candidate"];
  if (mode === "rolling") {
    if (task.lastSessionId) {
      const last = task.history?.find((record) => record.sessionId === task.lastSessionId && record.status !== "skipped");
      candidate = {
        sessionId: task.lastSessionId,
        at: last ? exchangeAt(last) : task.lastRunAt ?? 0,
        ...(task.rollingKey ? { key: task.rollingKey } : {}),
      };
    }
  } else if (input.fixed) {
    const fixed = input.fixed;
    if (!fixed.sessionId) return { decision: { continue: false, reason: fixed.reason ?? "none" }, currentKey };
    run = task.history?.find((record) => record.sessionId === fixed.sessionId && record.runId !== input.excludeRunId);
    candidate = {
      sessionId: fixed.sessionId,
      at: fixed.at ?? (run ? exchangeAt(run) : input.now),
      ...(fixed.key ? { key: fixed.key } : {}),
    };
    // The follow-up window was judged when the message queued, not now.
    continuation = "continue";
  } else if (input.personal) {
    // Only the person's words follow up a fresh agent's run; nothing else reads a session.
    run = followUpRun(task.history?.filter((record) => record.runId !== input.excludeRunId));
    if (run?.sessionId) candidate = { sessionId: run.sessionId, at: exchangeAt(run), ...(run.key ? { key: run.key } : {}) };
  }
  const session = candidate ? await sessionOf(task, candidate.sessionId) : undefined;
  const decision = threadDecision({
    mode,
    continuation,
    personal: input.personal,
    now: input.now,
    currentKey,
    ...(candidate ? { candidate } : {}),
    ...(session ? { session } : {}),
    // Rolling-only settings: a fresh agent never rotates or compacts by them.
    ...(mode === "rolling" && task.rotateAt !== undefined ? { rotateAt: task.rotateAt } : {}),
    ...(mode === "rolling" && task.whenFull ? { whenFull: task.whenFull } : {}),
  });
  return { decision, currentKey, ...(candidate ? { candidate } : {}), ...(run ? { run } : {}) };
}

/** Where the person's message would go now, as a waiting message keeps it
 *  (`ScheduleRunner.thread`). */
export async function messageThread(
  task: ScheduleTask,
  continuation: AgentContinuation,
  sessionOf: ThreadSessionReader,
  now: number,
): Promise<ThreadTarget> {
  if (contextModeOf(task) === "existing-session") {
    const sessionId = task.target?.sessionId ?? task.sessionId;
    return sessionId ? { sessionId } : { reason: "unavailable" };
  }
  const { decision, candidate } = await chooseThread(task, { continuation, personal: true, now }, sessionOf);
  if (!decision.continue) return { reason: decision.reason };
  return {
    sessionId: decision.sessionId,
    ...(candidate?.key ? { key: candidate.key } : {}),
    ...(candidate ? { at: candidate.at } : {}),
  };
}

/** Where the person's next message goes (`ScheduleTaskDto.followUp`). */
export interface AgentFollowUp {
  sessionId?: string;
  at?: number;
  /** After this the next message starts a new conversation; null = no limit. */
  until?: number | null;
  reason?: AgentFreshReason;
}

export async function agentFollowUp(task: ScheduleTask, sessionOf: ThreadSessionReader, now = Date.now()): Promise<AgentFollowUp> {
  const mode = contextModeOf(task);
  // While messages wait, the next one joins them and goes where they go.
  const waiting = task.queuedStart?.thread;
  if (task.queuedStart && waiting) {
    return waiting.sessionId
      ? { sessionId: waiting.sessionId, ...(waiting.at !== undefined ? { at: waiting.at } : {}), until: null }
      : { reason: waiting.reason ?? "none" };
  }
  if (mode === "existing-session") {
    const sessionId = task.target?.sessionId ?? task.sessionId;
    return sessionId ? { sessionId, until: null } : { reason: "unavailable" };
  }
  const { decision, candidate } = await chooseThread(task, { continuation: "auto", personal: true, now }, sessionOf);
  if (!decision.continue) return { reason: decision.reason };
  const at = candidate?.at ?? now;
  return { sessionId: decision.sessionId, at, until: mode === "new-session-per-run" ? at + FOLLOW_UP_WINDOW_MS : null };
}

export function scheduleRoutes(deps: {
  schedule: ScheduleService;
  forSpace: ServerPackageHost["forSpace"];
  /** Small-model agent draft; undefined = the model's answer was unusable. */
  draft?: (request: AgentDraftRequest) => Promise<AgentDraft | undefined>;
  /** Bounded excerpt of a session's conversation for "Make agent". */
  conversationOf?: (sessionId: string) => Promise<string>;
  /** Session stops in one project since `since`, as agent events. */
  recentSessionEvents?: (projectId: string, spaceId: string, since: number) => Promise<AgentEvent[]>;
  /** Integration events one source published in a Space since `since`. */
  recentIntegrationEvents?: (spaceId: string, source: string, since: number) => AgentEvent[];
  /** Registered integration sources, for the editor. */
  sources?: () => AgentEventSourceDescriptor[];
  /** Live context and cache state of an agent (its rolling session). */
  context?: (task: ScheduleTask) => Promise<unknown>;
  /** Ask the harness to compact the agent's current session. */
  compact?: (task: ScheduleTask) => Promise<void>;
  /** Run a wake script on sample events (no agent state is changed). */
  testScript?: (script: string, events: AgentEvent[]) => Promise<unknown>;
  /** Syntax check of a wake script; undefined when it compiles. */
  checkScript?: (script: string) => Promise<string | undefined>;
  /** Stop the agent's runs in progress; resolves with how many were stopped. */
  stop?: (task: ScheduleTask) => Promise<number>;
  /** The read runs use to decide whether to continue a session, so the
   *  owner's `followUp` preview matches them. Default: the caller's own
   *  Space-scoped session snapshot. */
  threadSession?: ThreadSessionReader;
}): RouteHandler {
  const inputOf = (input: Record<string, unknown>): Partial<ScheduleTaskInput> => {
    const model = input.model === null ? null : modelOf(input.model);
    const harness = input.harness === null ? null : harnessOf(input.harness);
    return {
      ...(input.projectId !== undefined ? { projectId: String(input.projectId) } : {}),
      ...(input.prompt !== undefined ? { prompt: String(input.prompt) } : {}),
      ...(input.kind !== undefined ? { kind: input.kind as ScheduleTaskInput["kind"] } : {}),
      ...(input.at !== undefined ? { at: Number(input.at) } : {}),
      ...(input.everyMinutes !== undefined ? { everyMinutes: Number(input.everyMinutes) } : {}),
      ...(cadenceOf(input.cadence) ? { cadence: cadenceOf(input.cadence)! } : {}),
      ...(targetOf(input.target) ? { target: targetOf(input.target)! } : {}),
      ...(input.overlapPolicy === "skip" || input.overlapPolicy === "queue" || input.overlapPolicy === "parallel" ? { overlapPolicy: input.overlapPolicy } : {}),
      ...(input.catchUp === "once" || input.catchUp === "skip" ? { catchUp: input.catchUp as CatchUpPolicy } : {}),
      ...(input.sessionId !== undefined && input.sessionId !== "" ? { sessionId: String(input.sessionId) } : {}),
      ...(input.title !== undefined && input.title !== "" ? { title: String(input.title) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled === true } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(harness !== undefined ? { harness } : {}),
      ...(input.fallbackModels === null || Array.isArray(input.fallbackModels) ? { fallbackModels: input.fallbackModels as unknown[] | null } : {}),
      ...(input.permissions === null || input.permissions === "ask" || input.permissions === "routine" || input.permissions === "all"
        ? { permissions: input.permissions as ScheduleTaskInput["permissions"] }
        : {}),
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      ...(typeof input.icon === "string" ? { icon: input.icon } : {}),
      ...(typeof input.color === "string" ? { color: input.color as AgentColor } : {}),
      ...(typeof input.manualOnly === "boolean" ? { manualOnly: input.manualOnly } : {}),
      ...(input.whenFull === "new-session" || input.whenFull === "compact" ? { whenFull: input.whenFull } : {}),
      ...(input.keepWarm === "off" || input.keepWarm === "auto" ? { keepWarm: input.keepWarm } : {}),
      ...(input.rotateAt !== undefined ? { rotateAt: Number(input.rotateAt) } : {}),
      ...(input.budget === null ? { budget: null } : budgetOf(input.budget) ? { budget: budgetOf(input.budget)! } : {}),
      ...(Array.isArray(input.eventTriggers) ? { eventTriggers: input.eventTriggers } : {}),
      ...(input.approvals === null
        ? { approvals: null }
        : input.approvals && typeof input.approvals === "object"
          ? { approvals: input.approvals as ScheduleTaskInput["approvals"] }
          : {}),
      ...(input.pauseAfterFailures === null
        ? { pauseAfterFailures: null }
        : input.pauseAfterFailures !== undefined ? { pauseAfterFailures: Number(input.pauseAfterFailures) } : {}),
      ...(input.heartbeat === null
        ? { heartbeat: null }
        : input.heartbeat && typeof input.heartbeat === "object" ? { heartbeat: input.heartbeat } : {}),
      ...(typeof input.notebook === "string" ? { notebook: input.notebook } : {}),
      ...(input.notify === "alerts" || input.notify === "updates" || input.notify === "off" ? { notify: input.notify } : {}),
    };
  };

  return async (rc) => {
    const { path, method, url, json: rawJson } = rc;
    // Anonymous webhook ingress. Outside /api the host offers the request
    // without a tenant; the URL token is the only authority, so this branch
    // never reads `rc.space` and answers unknown and disabled hooks alike.
    if (path.startsWith(WEBHOOK_PREFIX)) {
      const token = path.slice(WEBHOOK_PREFIX.length);
      if (method !== "POST") { rawJson(405, { error: "method-not-allowed" }); return true; }
      let raw: string;
      try { raw = await readLimited(rc.req, WEBHOOK_BODY_LIMIT); } catch {
        rawJson(413, { error: "too-large", message: `Webhook bodies are limited to ${WEBHOOK_BODY_LIMIT / 1024} KB.` });
        return true;
      }
      const outcome = deps.schedule.receiveWebhook(token, webhookInput(raw, rc.req.headers));
      if (outcome === "unknown") rawJson(404, { error: "not-found" });
      else if (outcome === "throttled") rawJson(429, { error: "too-many-requests" });
      else rawJson(202, { ok: true });
      return true;
    }
    if (!path.startsWith("/api/schedule")) return false;
    const body = rc.body;
    // Task responses never carry webhook token hashes.
    const json = (code: number, value: unknown) => rawJson(code, scrub(value));
    const scoped = deps.forSpace(rc.space);
    const project = async (projectId: string) => scoped.projects.get(projectId);
    // A task recorded under another Space is foreign even if a project id
    // happens to resolve here.
    const inSpace = (task: { spaceId?: string }) => !task.spaceId || task.spaceId === rc.space.spaceId;
    const accessOf = (task: ScheduleTask) => scheduleTaskAccess(rc.space, task);
    const sessionOf: ThreadSessionReader = deps.threadSession ?? (async (task, sessionId) => {
      try {
        const session = await scoped.sessions.snapshot(sessionId);
        return session.projectId === task.projectId ? session : undefined;
      } catch {
        return undefined;
      }
    });
    /** A task as the caller may see it. Only its owner learns where their
     *  next message goes (one session read per agent); anyone else gets the
     *  metadata view. Callers pass tasks already checked to be in this Space. */
    const view = async (task: ScheduleTask): Promise<ScheduleTask> => {
      if (accessOf(task) !== "own") return scheduleTaskMetadata(task);
      const followUp = await agentFollowUp(task, sessionOf).catch((): AgentFollowUp => ({ reason: "unavailable" }));
      // The waiting start is the server's record; the page reads `queued`.
      const { queuedStart: _queuedStart, ...shown } = task;
      return { ...shown, followUp } as ScheduleTask;
    };
    /** A task the caller may see; `own` also demands full access (else 403). */
    const allowedTask = async (id: string, need: ScheduleTaskAccess = "own") => {
      const task = deps.schedule.get(id);
      if (!task || !inSpace(task) || !(await project(task.projectId))) return undefined;
      const access = accessOf(task);
      if (access === "none") return undefined;
      if (need === "own" && access !== "own") {
        json(403, { error: "forbidden", message: "Only the person who owns this agent can change or read it." });
        return null;
      }
      return task;
    };
    const validateTarget = async (input: Partial<ScheduleTaskInput>, fallbackProjectId?: string): Promise<boolean> => {
      const projectId = input.projectId ?? fallbackProjectId;
      if (!projectId || !(await project(projectId))) return false;
      const sessionId = input.target?.sessionId ?? input.sessionId;
      if (sessionId) {
        try {
          const session = await scoped.sessions.snapshot(sessionId);
          if (session.projectId !== projectId) return false;
        } catch { return false; }
      }
      return true;
    };

    if (path === "/api/schedule" && method === "GET") {
      const requested = url.searchParams.get("projectId") ?? undefined;
      if (requested && !(await project(requested))) {
        json(200, { tasks: [], loopErrors: [] });
        return true;
      }
      const allowedIds = requested
        ? new Set([requested])
        : new Set((await scoped.projects.list()).map((item) => item.id));
      json(200, {
        tasks: await Promise.all(deps.schedule.list(requested)
          .filter((task) => allowedIds.has(task.projectId) && inSpace(task) && accessOf(task) !== "none")
          .map(view)),
        loopErrors: requested
          ? deps.schedule.loopErrors(requested)
          : [...allowedIds].flatMap((projectId) => deps.schedule.loopErrors(projectId)),
      });
      return true;
    }
    /** Reject a wake script that does not compile before anything is saved. */
    const scriptProblem = async (input: Partial<ScheduleTaskInput>): Promise<string | undefined> => {
      if (!deps.checkScript || !Array.isArray(input.eventTriggers)) return undefined;
      for (const raw of input.eventTriggers) {
        const script = (raw as { script?: unknown; id?: unknown }).script;
        if (typeof script !== "string" || !script.trim()) continue;
        const problem = await deps.checkScript(script);
        if (problem) return `Wake "${String((raw as { id?: unknown }).id)}": ${problem}`;
      }
      return undefined;
    };
    if (path === "/api/schedule" && method === "POST") {
      const { ownerUserId: _callerOwner, ...input } = inputOf(await body()) as ScheduleTaskInput;
      const problem = await scriptProblem(input);
      if (problem) { json(400, { error: "invalid-input", message: problem }); return true; }
      if (!(await validateTarget(input))) {
        json(404, { error: "not-found", message: "project or target session not found" });
        return true;
      }
      // The signed-in person owns the agent; its runs act for them.
      const person = isPerson(rc.space);
      const created = deps.schedule.create({
        ...input,
        spaceId: rc.space.spaceId,
        ...(person ? { ownerUserId: rc.space.userId } : {}),
      });
      json(200, { ...(await view(created)), webhookTokens: deps.schedule.takeIssuedWebhookTokens(created.id) });
      return true;
    }
    if (path === "/api/schedule/draft" && method === "POST") {
      if (!deps.draft) { json(503, { error: "unavailable", message: "Drafting is not available." }); return true; }
      const input = await body();
      const owned = await project(String(input.projectId ?? ""));
      if (!owned) { json(404, { error: "not-found", message: "project not found" }); return true; }
      let conversation: string | undefined;
      if (typeof input.sessionId === "string" && input.sessionId) {
        try {
          const session = await scoped.sessions.snapshot(input.sessionId);
          if (session.projectId !== owned.id) throw new Error("foreign session");
        } catch {
          json(404, { error: "not-found", message: "session not found" });
          return true;
        }
        conversation = await deps.conversationOf?.(input.sessionId);
      }
      const description = typeof input.description === "string" ? input.description.trim() : "";
      if (!description && !conversation) {
        json(400, { error: "invalid-input", message: "Describe what the agent should do." });
        return true;
      }
      const draft = await deps.draft({
        projectId: owned.id,
        projectPath: owned.path,
        description: description || "Turn the conversation below into a recurring agent.",
        ...(conversation ? { conversation } : {}),
        timeZone: validZone(input.timeZone),
        ...(rc.space.userId ? { userId: rc.space.userId } : {}),
      });
      if (!draft) {
        json(502, { error: "draft-unusable", message: "The model's answer could not be used. Fill the agent in by hand." });
        return true;
      }
      json(200, draft);
      return true;
    }
    /** Real events of the last day a trigger's kind could have seen. */
    const eventsFor = async (trigger: AgentEventTrigger, owned: { id: string }, spaceId: string): Promise<AgentEvent[]> => {
      const since = Date.now() - 24 * 60 * 60_000;
      let events: AgentEvent[] = [];
      if (trigger.kind === "session") {
        events = await deps.recentSessionEvents?.(owned.id, spaceId, since) ?? [];
      } else if (trigger.kind === "integration") {
        events = deps.recentIntegrationEvents?.(spaceId, trigger.source, since)
          .filter((event) => !event.projectId || event.projectId === owned.id) ?? [];
      } else if (trigger.kind === "agent") {
        const source = deps.schedule.get(trigger.agentId);
        if (source && inSpace(source) && accessOf(source) === "own" && (await project(source.projectId))) {
          events = (source.history ?? [])
            .filter((run) => run.startedAt >= since && (run.status === "ok" || run.status === "failed"))
            .map((run) => ({
              id: run.runId, kind: "agent" as const, at: run.finishedAt ?? run.startedAt, projectId: source.projectId,
              outcome: run.status === "ok" ? "ok" as const : "failed" as const, sourceAgentId: source.id, chainDepth: run.chainDepth ?? 0,
              fields: { agent: source.title ?? "", ...(run.summary ? { summary: run.summary } : {}), ...(run.error ? { error: run.error } : {}) },
            }));
        }
      }
      return events;
    };

    if (path === "/api/schedule/script-test" && method === "POST") {
      const input = await body();
      const owned = await project(String(input.projectId ?? ""));
      if (!owned) { json(404, { error: "not-found", message: "project not found" }); return true; }
      let trigger: AgentEventTrigger;
      try { trigger = validateTrigger(input.trigger); } catch (error) {
        json(400, { error: "invalid-input", message: error instanceof Error ? error.message : String(error) });
        return true;
      }
      if (!trigger.script || !deps.testScript) { json(400, { error: "invalid-input", message: "the wake has no script" }); return true; }
      const self = typeof input.agentId === "string" && input.agentId ? input.agentId : "__draft__";
      const matching = (await eventsFor(trigger, owned, rc.space.spaceId))
        .filter((event) => triggerMatches(trigger, event, self))
        .sort((a, b) => a.at - b.at);
      // The script sees what the pace would hand it: the newest event, or the batch.
      const batch = (trigger.pace ?? DEFAULT_PACE).coalesce === "batch" ? matching.slice(-20) : matching.slice(-1);
      if (!batch.length) { json(200, { events: 0 }); return true; }
      json(200, { events: batch.length, result: await deps.testScript(trigger.script, batch) });
      return true;
    }
    if (path === "/api/schedule/sources" && method === "GET") {
      json(200, deps.sources?.() ?? []);
      return true;
    }
    if (path === "/api/schedule/trigger-preview" && method === "POST") {
      const input = await body();
      const owned = await project(String(input.projectId ?? ""));
      if (!owned) { json(404, { error: "not-found", message: "project not found" }); return true; }
      let trigger: AgentEventTrigger;
      try { trigger = validateTrigger(input.trigger); } catch (error) {
        json(400, { error: "invalid-input", message: error instanceof Error ? error.message : String(error) });
        return true;
      }
      const selfId = typeof input.agentId === "string" ? input.agentId : "";
      const events = await eventsFor(trigger, owned, rc.space.spaceId);
      const self = selfId || "__draft__";
      const matching = events.filter((event) => triggerMatches(trigger, event, self)).sort((a, b) => a.at - b.at);
      json(200, {
        events: matching.length,
        wakes: simulateWakes(matching, trigger.pace ?? DEFAULT_PACE),
        samples: matching.slice(-3).reverse().map((event) => ({ at: event.at, text: describeEvent(event) })),
        // Dry run: the latest events of this kind, and why each would (not) wake the agent.
        recent: [...events].sort((a, b) => b.at - a.at).slice(0, 6).map((event) => ({
          at: event.at,
          text: describeEvent(event),
          ...explainMatch(trigger, event, self),
        })),
      });
      return true;
    }
    if (path === "/api/schedule/preview" && method === "POST") {
      const input = await body();
      const cadence = cadenceOf(input.cadence);
      if (!cadence) { json(400, { error: "invalid-input", message: "cadence is required" }); return true; }
      json(200, deps.schedule.preview(cadence, input.count !== undefined ? Number(input.count) : 5));
      return true;
    }
    if (path === "/api/schedule/loops" && method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? "";
      if (!projectId || !(await project(projectId))) { json(200, []); return true; }
      json(200, await Promise.all(deps.schedule.list(projectId).filter((task) => task.source === "loop-file" && inSpace(task)).map(view)));
      return true;
    }
    if (path === "/api/schedule/loops/rescan" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "");
      const owned = await project(projectId);
      if (!owned) { json(404, { error: "not-found", message: "project not found" }); return true; }
      const synced = deps.schedule.syncLoops(projectId, scanLoopsDir(owned.path), { explicit: true });
      json(200, { ...synced, tasks: await Promise.all(synced.tasks.filter(inSpace).map(view)) });
      return true;
    }
    if (path === "/api/schedule/loops/errors/dismiss" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "");
      if (!(await project(projectId))) { json(404, { error: "not-found", message: "project not found" }); return true; }
      json(200, { ok: deps.schedule.dismissLoopError(projectId, String(input.path ?? "")) });
      return true;
    }

    const trustMatch = path.match(/^\/api\/schedule\/([^/]+)\/trust$/);
    if (trustMatch && method === "POST") {
      const id = trustMatch[1]!;
      const task = await allowedTask(id);
      if (task === null) return true;
      if (!task || task.source !== "loop-file" || !task.sourcePath || !task.loopId) {
        json(404, { error: "not-found", message: "managed loop task not found" });
        return true;
      }
      const owned = await project(task.projectId);
      if (!owned) { json(404, { error: "not-found", message: "project not found" }); return true; }
      const scan = scanLoopsDir(owned.path);
      const current = scan.find((file) => file.path === task.sourcePath && file.loop?.id === task.loopId);
      if (!current?.loop || current.digest !== task.sourceDigest) {
        deps.schedule.syncLoops(task.projectId, scan, { explicit: true });
        json(409, { error: "content-trust-changed", message: "Loop changed again. Refresh and review the current version." });
        return true;
      }
      const input = await body();
      const action = String(input.action ?? "");
      if (action === "trust-current") { json(200, await view(deps.schedule.trustLoopVersion(id, rc.space.spaceId, current))); return true; }
      if (action === "run-once") { json(200, await view(await deps.schedule.runLoopVersionOnce(id, rc.space.spaceId, current))); return true; }
      if (action === "reject") { json(200, await view(deps.schedule.rejectLoopVersion(id))); return true; }
      json(400, { error: "invalid-input", message: "action must be trust-current, run-once, or reject" });
      return true;
    }

    const fileMatch = path.match(/^\/api\/schedule\/([^/]+)\/file$/);
    if (fileMatch && method === "POST") {
      const task = await allowedTask(fileMatch[1]!);
      if (task === null) return true;
      const owned = task ? await project(task.projectId) : undefined;
      if (!task || !owned) { json(404, { error: "not-found" }); return true; }
      const action = String((await body()).action ?? "");
      if (action !== "export" && action !== "convert") {
        json(400, { error: "invalid-input", message: "action must be export or convert" });
        return true;
      }
      const written = writeAgentFile(deps.schedule, task, owned, action, rc.space.spaceId);
      json(200, { ...(await view(written)), filePath: written.filePath });
      return true;
    }
    const contextMatch = path.match(/^\/api\/schedule\/([^/]+)\/context$/);
    if (contextMatch) {
      const task = await allowedTask(contextMatch[1]!);
      if (task === null) return true;
      if (!task) { json(404, { error: "not-found" }); return true; }
      if (method === "GET") {
        json(200, await deps.context?.(task) ?? null);
        return true;
      }
      if (method === "POST") {
        const action = String((await body()).action ?? "");
        if (action === "new-session") { json(200, await view(deps.schedule.resetSession(task.id))); return true; }
        if (action === "compact") {
          if (!deps.compact) { json(503, { error: "unavailable" }); return true; }
          await deps.compact(task);
          json(200, { ok: true });
          return true;
        }
        json(400, { error: "invalid-input", message: "action must be new-session or compact" });
        return true;
      }
    }

    const feedbackMatch = path.match(/^\/api\/schedule\/([^/]+)\/runs\/([^/]+)\/feedback$/);
    if (feedbackMatch && method === "POST") {
      const task = await allowedTask(feedbackMatch[1]!);
      if (task === null) return true;
      if (!task) { json(404, { error: "not-found" }); return true; }
      const input = await body();
      const verdict = input.verdict;
      if (verdict !== null && verdict !== "up" && verdict !== "down") {
        json(400, { error: "invalid-input", message: "verdict must be up, down or null" });
        return true;
      }
      json(200, await view(deps.schedule.setFeedback(task.id, feedbackMatch[2]!, verdict === null
        ? null
        : { verdict, ...(typeof input.note === "string" ? { note: input.note } : {}) })));
      return true;
    }

    const match = path.match(/^\/api\/schedule\/([^/]+)(?:\/(pause|resume|run|runs|seen|stop))?$/);
    if (!match) return false;
    const id = match[1]!;
    const action = match[2];
    // An admin may pause, resume, stop or delete someone else's agent; every
    // other action reads or changes what it says, so it is the owner's.
    const governs = (!action && method === "DELETE")
      || (method === "POST" && (action === "pause" || action === "resume" || action === "stop"));
    const task = await allowedTask(id, governs ? "admin" : "own");
    if (task === null) return true;
    if (!task) { json(404, { error: "not-found" }); return true; }
    if (!action && method === "PATCH") {
      const input = inputOf(await body());
      const problem = await scriptProblem(input);
      if (problem) { json(400, { error: "invalid-input", message: problem }); return true; }
      if (!(await validateTarget(input, task.projectId))) { json(404, { error: "not-found" }); return true; }
      const updated = deps.schedule.update(id, { ...input, spaceId: rc.space.spaceId });
      json(200, { ...(await view(updated)), webhookTokens: deps.schedule.takeIssuedWebhookTokens(id) });
      return true;
    }
    if (!action && method === "DELETE") { json(200, { ok: deps.schedule.remove(id) }); return true; }
    if (method === "GET" && action === "runs") { json(200, deps.schedule.runsOf(id, Number(url.searchParams.get("limit") ?? 50))); return true; }
    // An admin pausing someone else's agent gets its metadata back, never its content.
    if (method === "POST" && (action === "pause" || action === "resume")) { json(200, await view(deps.schedule.setEnabled(id, action === "resume"))); return true; }
    if (method === "POST" && action === "run") {
      const input = await body().catch(() => ({} as Record<string, unknown>));
      const text = typeof input.input === "string" ? input.input : undefined;
      let attachments: ReturnType<typeof validateRunAttachments>;
      try {
        attachments = validateRunAttachments(input.attachments);
      } catch (error) {
        json(400, { error: "invalid-input", message: error instanceof Error ? error.message : String(error) });
        return true;
      }
      const continuation = input.continuation ?? undefined;
      if (continuation !== undefined && !isAgentContinuation(continuation)) {
        json(400, { error: "invalid-input", message: "continuation must be auto, continue or new" });
        return true;
      }
      if (continuation === "new" && contextModeOf(task) === "existing-session") {
        json(400, { error: "invalid-input", message: "This agent always works in the session chosen for it, so a message cannot start a new conversation." });
        return true;
      }
      let updated: ScheduleTask;
      try {
        updated = await deps.schedule.runNow(id, {
          ...(text ? { input: text } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(continuation ? { continuation } : {}),
        });
      } catch (error) {
        // A refused message: the page keeps the person's text and shows why.
        const code = (error as { code?: unknown })?.code;
        const status = code === "invalid-input" ? 400 : code === "conflict" ? 409 : code === "payload-too-large" ? 413
          : code === "unavailable" ? 503 : undefined;
        if (!status) throw error;
        json(status, { error: code, message: error instanceof Error ? error.message : String(error) });
        return true;
      }
      json(200, await view(updated));
      return true;
    }
    if (method === "POST" && action === "seen") {
      const input = await body().catch(() => ({} as Record<string, unknown>));
      const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : undefined;
      json(200, await view(deps.schedule.markSeen(id, at)));
      return true;
    }
    if (method === "POST" && action === "stop") {
      if (!deps.stop) { json(503, { error: "unavailable" }); return true; }
      json(200, { stopped: await deps.stop(task) });
      return true;
    }
    return false;
  };
}

/** Run `attempt` on each route from `from` on, moving to the next only when
 *  a route is refused outright (see `isRouteFailure`). The last refusal is
 *  rethrown; any other error is never retried, since it may have landed. */
export async function withRouteFailover<T>(
  routes: readonly ScheduleExecutionSelection[],
  from: number,
  attempt: (execution: ScheduleExecutionSelection) => Promise<T>,
): Promise<{ value: T; route: number }> {
  for (let route = from; ; route += 1) {
    try {
      return { value: await attempt(routes[route] ?? {}), route };
    } catch (error) {
      if (route + 1 >= routes.length || !isRouteFailure(error)) throw error;
    }
  }
}

const AUTO_ACCEPT_OF = { ask: "off", routine: "on", all: "all" } as const;

/** Give the run's session the agent's approval level. The agent's own
 *  sessions follow it exactly (unset = inherit); a person's chosen session
 *  changes only when a level is set. Raising the level acts for the owner,
 *  so it goes through their guarded session service: an account that may
 *  not auto-approve is refused and the run does not start. */
export async function applyPermissions(
  sessions: Pick<SessionService, "autoAcceptSet">,
  sessionId: string,
  level: AgentPermissionLevel | undefined,
  opts: { ownSession: boolean; owned: boolean },
): Promise<void> {
  if (!level && !opts.ownSession) return;
  const setting = level ? AUTO_ACCEPT_OF[level] : "inherit";
  if ((setting === "on" || setting === "all") && !opts.owned) {
    throw Object.assign(new Error("Only an agent that acts for a person can approve requests on its own"), { code: "forbidden" });
  }
  if (!sessions.autoAcceptSet) {
    if (setting === "inherit") return;
    throw Object.assign(new Error("This server cannot set an agent's approval level"), { code: "unsupported" });
  }
  await sessions.autoAcceptSet(sessionId, setting);
}

/** Runs with a pinned profile resolve model/agent through it. The profile is
 *  passed on create (so the session starts on the profile's harness) and on
 *  send (so an existing target session switches to it explicitly). */
const profileOf = (task: ScheduleTask): { agentProfileId: string } | Record<string, never> =>
  task.agentProfile ? { agentProfileId: task.agentProfile } : {};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // projectId -> owning Space; refreshed from the canonical project list.
  const projectSpaces = new Map<string, string>();
  const rememberProjects = (projects: Array<{ id: string; spaceId?: string }>): void => {
    for (const project of projects) if (project.spaceId) projectSpaces.set(project.id, project.spaceId);
  };
  const spaceFile = (spaceId: string): string =>
    join(host.spaceStorage(host.systemSpaceContext(spaceId)).packageDir(host.pluginId), "schedule.json");
  const dataDir = packageDataDir(host);
  // Adopt the legacy shared file first; the Space split below then runs on the
  // adopted path exactly as it did before the package owned a directory.
  adoptLegacyPackageData(host, ["schedule.json"]);

  /** The session service a task's runs create and send through: its owner's
   *  own context when it has an owner, so it can use only what that person
   *  could (their private assistant accounts, chats they can open). A task
   *  whose owner is no longer a member of its Space refuses to run. Undefined
   *  for tasks without an owner, which keep the system context. */
  const ownerSessions = async (task: ScheduleTask): Promise<SessionService | undefined> => {
    if (!task.ownerUserId || !host.personSpaceContext) return undefined;
    const spaceId = task.spaceId ?? (await host.projects.get(task.projectId))?.spaceId;
    const person = spaceId ? host.personSpaceContext(task.ownerUserId, spaceId) : undefined;
    if (!person) {
      throw Object.assign(new Error("The person this agent acts for is no longer a member of this Space"), { code: "forbidden" });
    }
    return host.forSpace(person).sessions;
  };

  /** A session an agent's run may continue: one of its own, so it must still
   *  be in the agent's project and Space. */
  const threadSessionOf: ThreadSessionReader = async (task, sessionId) => {
    const projection = await host.store.projection(sessionId);
    if (!projection || projection.projectId !== task.projectId) return undefined;
    if (task.spaceId && projection.spaceId && projection.spaceId !== task.spaceId) return undefined;
    return projection;
  };

  const runner: ScheduleRunner = {
    thread: (task, continuation, at) => messageThread(task, continuation, threadSessionOf, at),
    run: async (task, runId, wake) => {
      if (task.source === "loop-file") {
        const project = await host.projects.get(task.projectId);
        if (!project || !task.sourcePath || !task.loopId) {
          throw Object.assign(new Error("managed loop project/source is unavailable"), { code: "content-trust-changed" });
        }
        const current = scanLoopsDir(project.path).find((file) => file.path === task.sourcePath && file.loop?.id === task.loopId);
        const owningSpaceId = project.spaceId ?? task.trustReceipt?.spaceId ?? "";
        assertLoopExecutionTrusted(task, current, owningSpaceId);
      }
      // Resolved before anything runs, so a refused owner leaves no trace.
      const asOwner = await ownerSessions(task);
      const mode = contextModeOf(task);
      // Main route first, then each backup; a backup is tried only after the
      // previous route was refused outright, so nothing ran on it.
      const routes = scheduleExecutionRoutes(task);
      let route = 0;
      let sessionId: string | undefined;
      // A chosen session keeps its own history: it gets the charter every run.
      let continuing = false;
      let rollingKey: string | undefined;
      let rotated: ScheduleRunOutcome["rotated"];
      let key: string | undefined;
      let continued = false;
      let fresh: AgentFreshReason | undefined;
      // Set when a fresh agent continues an older session than its newest one.
      let followedAt: number | undefined;
      if (mode === "existing-session") {
        sessionId = task.target?.sessionId ?? task.sessionId;
        if (!sessionId || !(await host.store.projection(sessionId))) throw Object.assign(new Error("target session no longer exists"), { code: "not-found" });
      } else {
        // Rolling: continue the last session while it is healthy. Fresh: a
        // new session per run, except that the person's message continues
        // the exchange it answers while that is recent and healthy. A message
        // that waited for a run carries where it was promised to go, and its
        // words even when it joined an event wake.
        const personal = Boolean(wake.thread)
          || (wake.trigger === "manual" && Boolean(wake.input?.trim() || wake.attachments?.length));
        const choice = await chooseThread(task, {
          continuation: wake.continuation ?? "auto", personal, now: wake.at, excludeRunId: runId,
          ...(wake.thread ? { fixed: wake.thread } : {}),
        }, threadSessionOf);
        const { decision, currentKey } = choice;
        key = currentKey;
        if (decision.continue) {
          sessionId = decision.sessionId;
          continuing = !decision.resendCharter;
          continued = true;
          key = choice.candidate?.key ?? currentKey;
          if (mode !== "dedicated-session" && choice.run && sessionId !== task.lastSessionId) followedAt = choice.run.startedAt;
          if (decision.compactFirst) {
            const sessions = await systemSessionsForSession(host, sessionId);
            if (!sessions.compact) {
              // The harness cannot compact: fall back to a new session.
              sessionId = undefined;
              continuing = false;
              continued = false;
              key = currentKey;
              fresh = "context-full";
              if (mode === "dedicated-session") {
                rollingKey = currentKey;
                rotated = "context-full";
              }
            } else {
              await sessions.compact(sessionId);
            }
          }
        } else {
          if (mode === "dedicated-session") {
            rollingKey = currentKey;
            if (decision.reason === "instructions-changed" || decision.reason === "context-full" || decision.reason === "compacted") {
              rotated = decision.reason;
            }
          }
          // A first run (or a scheduled fresh one) has nothing to explain.
          if (decision.reason !== "none" || personal) fresh = decision.reason;
        }
      }

      let sessions = asOwner ?? (sessionId ? await systemSessionsForSession(host, sessionId) : await systemSessionsForProject(host, task.projectId));
      const ownSession = !sessionId || mode !== "existing-session";
      if (!sessionId) {
        const creator = sessions;
        const created = await withRouteFailover(routes, route, (execution) => creator.create({
          projectId: task.projectId,
          title: task.title ?? `Scheduled: ${task.prompt.slice(0, 48)}`,
          // The agent's own session: its page lists it, the session list does not.
          purpose: AGENT_SESSION_PURPOSE,
          ...execution,
          ...profileOf(task),
        }));
        route = created.route;
        sessionId = created.value.id;
        sessions = asOwner ?? await systemSessionsForSession(host, sessionId);
      }
      await applyPermissions(sessions, sessionId, task.permissions, { ownSession, owned: !!asOwner });
      const marker = await systemAppendSessionEvent(host, sessionId, "schedule/run-started", {
        taskId: task.id,
        runId,
        trigger: wake.trigger,
        ...(rotated ? { rotated } : {}),
        ...(task.title ? { taskTitle: task.title } : {}),
        ...(task.source === "loop-file" ? { source: "loop-file", ...(task.loopId ? { loopId: task.loopId } : {}) } : {}),
      }, { ignorable: true, producerPlugin: host.pluginId });
      // A continuing session already holds the notebook unless the person
      // changed it since; a new session always starts with it. The revision
      // the agent last sent tracks its newest session; for an older one any
      // change since that exchange started is news.
      const notebookRev = task.notebookRev ?? 0;
      const notebookChanged = continuing && (followedAt !== undefined
        ? (task.notebookUpdatedAt ?? 0) > followedAt
        : notebookRev > 0 && task.notebookSentRev !== notebookRev);
      const text = composeAgentPrompt(task, wake, { continuing, notebookChanged });
      const sender = sessions;
      const target = sessionId;
      // The session validates the files again and hands them to the model.
      const attachments = wake.attachments?.length ? { attachments: wake.attachments } : {};
      const delivered = await withRouteFailover(routes, route, (execution) =>
        sender.send(target, { text, ...attachments, ...execution, ...profileOf(task) }, scheduleTurnAdmission(task)));
      route = delivered.route;
      const sent = delivered.value;
      return {
        ...(route > 0 ? { backup: route } : {}),
        sessionId,
        markerSeq: marker.seq,
        ...(!continuing || notebookChanged ? { notebookRev } : {}),
        ...(rollingKey ? { rollingKey } : {}),
        ...(rotated ? { rotated } : {}),
        ...(key ? { key } : {}),
        ...(continued ? { continued: true } : {}),
        ...(fresh ? { fresh } : {}),
        ...(sent?.queued && sent.queueId ? { queueId: sent.queueId } : {}),
        ...(sent?.turnId ? { turnId: sent.turnId } : {}),
      };
    },
    settle: (task, run, signal, onWaiting, onActivity) => settleScheduledRun(run, {
      signal,
      events: (sessionId, afterSeq) => host.store.events(sessionId, afterSeq),
      ...(onWaiting ? { onWaiting } : {}),
      ...(onActivity ? { onActivity } : {}),
      ...(run.sessionId && scheduleExecutionRoutes(task).length > 1 ? {
        backup: run.backup ?? 0,
        // The provider refused or ran out mid-run: continue the same turn on
        // the next backup through the session's own resume path, which
        // re-sends the run's prompt on the chosen route.
        onRouteFailure: async (next: number) => {
          const routes = scheduleExecutionRoutes(task);
          const execution = routes[next];
          if (!execution) return false;
          const sessions = await ownerSessions(task) ?? await systemSessionsForSession(host, run.sessionId!);
          if (!sessions.resumeNow) return false;
          await sessions.resumeNow(run.sessionId!, {
            ...(execution.model ? { model: execution.model } : {}),
            ...(execution.harness ? { harness: execution.harness } : {}),
          });
          return true;
        },
      } : {}),
      ...(task.approvals && task.approvals.onTimeout !== "wait" && run.sessionId ? {
        approvalTimeoutMs: task.approvals.timeoutMinutes * 60_000,
        onApprovalTimeout: async (request) => {
          const sessionId = run.sessionId!;
          const sessions = await systemSessionsForSession(host, sessionId);
          // A question cannot be "denied" on the person's behalf; it stops the run.
          if (task.approvals!.onTimeout === "reject" && request.kind === "permission") {
            await sessions.replyPermission(sessionId, request.requestId, "reject");
          } else {
            await sessions.abort(sessionId, { source: "agent-approval-timeout" });
          }
        },
      } : {}),
    }),
  };

  const draft = async (request: AgentDraftRequest): Promise<AgentDraft | undefined> => {
    const model = host.smallModel(request.userId);
    const runtime = await host.runtimes.forProject(request.projectId, request.projectPath, model?.harnessId);
    const result = await host.smallModelComplete(runtime, {
      cwd: request.projectPath,
      systemPrompt: DRAFT_SYSTEM_PROMPT,
      prompt: draftPrompt(request),
      ...(model ? { model } : {}),
      maxOutputTokens: 1_200,
      timeoutMs: 60_000,
      purpose: "agent-draft",
    });
    return parseAgentDraft(result.text, request.timeZone);
  };
  const recentSessionEvents = async (projectId: string, spaceId: string, since: number): Promise<AgentEvent[]> => {
    const projections = (await host.store.projections(projectId, { spaceId }))
      .filter((projection) => !projection.parentId && projection.updatedAt >= since)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200);
    const events: AgentEvent[] = [];
    for (const projection of projections) {
      const latest = await host.store.latestSeq(projection.id);
      const stops = host.store.eventsOfTypes
        // ponytail: the newest 5000 events per session; a day of stops fits.
        ? await host.store.eventsOfTypes(projection.id, ["turn/stopped"], Math.max(0, latest - 5_000), latest, 200)
        : (await host.store.events(projection.id, Math.max(0, latest - 2_000))).filter((event) => event.type === "turn/stopped");
      const owner = schedule?.agentForSession(projection.id);
      for (const stop of stops) {
        if (stop.time < since) continue;
        const data = stop.data as { reason?: string; error?: unknown; retry?: unknown };
        const outcome = data.reason === "completed" ? "completed" : data.reason === "aborted" ? "stopped" : data.retry ? undefined : "failed";
        if (!outcome) continue;
        events.push({
          id: stop.id, kind: "session", at: stop.time, projectId, outcome,
          ...(owner ? { sourceAgentId: owner.agentId } : {}), chainDepth: owner?.chainDepth ?? 0,
          fields: {
            title: projection.title ?? "",
            ...(typeof data.error === "string" ? { error: data.error.slice(0, 300) } : {}),
            ...(projection.resolvedHarnessId ? { harness: projection.resolvedHarnessId } : {}),
            ...(projection.model?.modelID ? { model: projection.model.modelID } : {}),
            ...(owner?.name ? { agent: owner.name } : {}),
          },
        });
      }
    }
    return events;
  };
  const conversationOf = async (sessionId: string): Promise<string> => {
    const latest = await host.store.latestSeq(sessionId);
    const head = host.store.eventsOfTypes
      ? await host.store.eventsOfTypes(sessionId, ["user/message"], 0, latest, 1)
      : [];
    const tail = (await host.store.events(sessionId, Math.max(0, latest - 400)))
      .filter((event) => event.type === "user/message" || event.type === "assistant/message");
    const seen = new Set<number>();
    const lines: string[] = [];
    for (const event of [...head, ...tail.slice(-4)]) {
      if (seen.has(event.seq)) continue;
      seen.add(event.seq);
      const text = (event.data as { text?: unknown }).text;
      if (typeof text !== "string" || !text.trim()) continue;
      lines.push(`${event.type === "user/message" ? "User" : "Agent"}: ${text.trim().slice(0, 1_500)}`);
    }
    return lines.join("\n\n");
  };

  const scriptInput = (task: ScheduleTask, events: AgentEvent[]) => ({
    events: scriptEvents(events),
    agent: {
      name: task.title ?? "",
      runsToday: spendInLastDay(task.history, Date.now()).runs,
      lastRunAt: task.lastRunAt ?? null,
    },
  });

  // Built on first enable: Space documents can only be located once the
  // canonical project list (and therefore every owning Space) is readable.
  let schedule: ScheduleService | null = null;
  const current = (): ScheduleService => {
    if (!schedule) throw Object.assign(new Error("planner is not enabled"), { code: "unavailable" });
    return schedule;
  };
  const facade = new Proxy({} as ScheduleService, {
    get(_target, property) {
      // Shutdown stops every package service, enabled or not.
      if (!schedule && (property === "stop" || property === "start")) return () => {};
      const service = current();
      const value = Reflect.get(service, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(service) : value;
    },
  });
  host.services.provide(AGENTS_SERVICE, facade);
  // ---- integration event sources --------------------------------------------
  const sources = new Map<string, AgentEventSourceDescriptor>();
  const recentIntegration: AgentEvent[] = [];
  host.services.provide(AGENT_EVENT_SOURCES, {
    register(source) {
      if (!/^[a-z0-9-]{1,40}$/.test(source.id)) throw Object.assign(new Error("invalid source id"), { code: "invalid-input" });
      sources.set(source.id, source);
      return { dispose: () => { if (sources.get(source.id) === source) sources.delete(source.id); } };
    },
    publish(input) {
      if (!sources.has(input.source) || !/^[a-z0-9-]{1,40}$/.test(input.type)) return;
      const event: AgentEvent = {
        id: randomUUID(),
        kind: "integration",
        at: Date.now(),
        projectId: input.projectId ?? "",
        spaceId: input.spaceId,
        source: input.source,
        outcome: input.type,
        chainDepth: 0,
        fields: {
          ...Object.fromEntries(Object.entries(input.fields ?? {}).map(([key, value]) => [key, String(value).slice(0, 2_000)])),
          title: input.title.slice(0, 160),
        },
      };
      recentIntegration.push(event);
      const cutoff = Date.now() - 24 * 60 * 60_000;
      while (recentIntegration.length && (recentIntegration.length > 2_000 || recentIntegration[0]!.at < cutoff)) recentIntegration.shift();
      schedule?.dispatchEvent(event);
    },
    subscribed: (source) => schedule?.subscribed(source) ?? [],
  });
  const recentIntegrationEvents = (spaceId: string, source: string, since: number): AgentEvent[] =>
    recentIntegration.filter((event) => event.spaceId === spaceId && event.source === source && event.at >= since);

  // ---- context and cache ------------------------------------------------------
  let warmTimer: ReturnType<typeof setInterval> | null = null;
  /** Sessions whose current turn is a keep-alive: its stop is not an event. */
  const pinging = new Set<string>();
  const rolling = (task: ScheduleTask): boolean =>
    (task.target?.mode ?? (task.sessionId ? "existing-session" : "new-session-per-run")) === "dedicated-session";
  const lastActivity = (task: ScheduleTask): number | undefined => {
    const finished = task.history?.find((run) => run.finishedAt && run.status !== "skipped")?.finishedAt;
    const pinged = task.warmPings?.at(-1);
    return Math.max(finished ?? 0, pinged ?? 0) || undefined;
  };
  const warmPlanOf = async (task: ScheduleTask) => {
    const projection = task.lastSessionId ? await host.store.projection(task.lastSessionId) : undefined;
    return planWarm({
      ...(task.keepWarm ? { keepWarm: task.keepWarm } : {}),
      rolling: rolling(task) && !!projection,
      nextRunAt: task.manualOnly ? null : task.nextRunAt,
      lastActivityAt: lastActivity(task),
      providerId: projection?.model?.providerID ?? task.model?.providerID,
      telemetry: cacheTelemetry(task.history),
    }, Date.now());
  };
  /** Send keep-alives that the plan says pay for themselves. */
  const keepWarm = async (): Promise<void> => {
    if (!schedule) return;
    for (const task of schedule.list()) {
      if (task.keepWarm !== "auto" || !task.enabled || task.tripped || !task.lastSessionId) continue;
      if (schedule.isRunning(task.id) || budgetExceeded(task, Date.now())) continue;
      const plan = await warmPlanOf(task);
      if (plan.reason !== "due") continue;
      const projection = await host.store.projection(task.lastSessionId);
      if (!projection || projection.status !== "idle") continue;
      // A keep-alive is a send like a run's: it acts for the owner too, and
      // is skipped while the owner may not act in the Space.
      const asOwner = await ownerSessions(task).catch(() => null);
      if (asOwner === null) continue;
      const sessions = asOwner ?? await systemSessionsForSession(host, task.lastSessionId);
      schedule.recordWarm(task.id, Date.now());
      pinging.add(task.lastSessionId);
      await sessions.send(task.lastSessionId, { text: KEEP_ALIVE_PROMPT, ...scheduleExecutionSelection(task), ...profileOf(task) });
    }
  };
  const context = async (task: ScheduleTask) => {
    const projection = task.lastSessionId && task.target?.mode !== "new-session-per-run"
      ? await host.store.projection(task.lastSessionId)
      : undefined;
    const window = projection?.contextWindow;
    const plan = await warmPlanOf(task);
    return {
      mode: rolling(task) ? "rolling" : task.target?.mode === "existing-session" || task.sessionId ? "session" : "fresh",
      rotateAt: task.rotateAt ?? DEFAULT_ROTATE_AT,
      whenFull: task.whenFull ?? "new-session",
      session: projection ? {
        id: projection.id,
        title: projection.title ?? "",
        status: projection.status,
        ...(typeof window?.fraction === "number" ? { fraction: window.fraction } : {}),
        ...(typeof window?.usedTokens === "number" ? { usedTokens: window.usedTokens } : {}),
        ...(typeof window?.limitTokens === "number" ? { limitTokens: window.limitTokens } : {}),
        ...(window?.compaction?.lastAt ? { compactedAt: window.compaction.lastAt } : {}),
        telemetry: window?.source ?? "unknown",
      } : null,
      layers: promptLayers(task, { trigger: "schedule", at: Date.now() }),
      cache: {
        telemetry: cacheTelemetry(task.history),
        runs: runCacheStats(task.history),
        ttlMs: plan.ttlMs ?? null,
        lastActivityAt: lastActivity(task) ?? null,
      },
      warm: { ...plan, pings24h: (task.warmPings ?? []).filter((at) => at > Date.now() - 24 * 60 * 60_000).length },
    };
  };
  const compact = async (task: ScheduleTask): Promise<void> => {
    if (!task.lastSessionId) throw Object.assign(new Error("This agent has no session to compact yet."), { code: "invalid-input" });
    const sessions = await systemSessionsForSession(host, task.lastSessionId);
    if (!sessions.compact) throw Object.assign(new Error("This harness cannot compact a session."), { code: "unsupported" });
    await sessions.compact(task.lastSessionId);
  };

  /** A finished run that met the agent's notify policy reaches the person
   *  through the host's notification centre and push. */
  const notifyRun = (task: ScheduleTask, run: ScheduleRunRecord, reason: "report" | "tripped"): void => {
    const attention = host.services.get(SESSION_ATTENTION_SERVICE);
    const sessionId = run.sessionId ?? task.lastSessionId;
    if (!attention?.notify || !sessionId) return;
    if (reason === "tripped") {
      attention.notify(sessionId, { kind: "failed", statusText: task.tripped?.message ?? "stopped after repeated failures", key: `tripped:${run.runId}` });
      return;
    }
    const headline = run.headline ?? "has an update";
    attention.notify(sessionId, {
      kind: "completed",
      statusText: run.signal === "alert" ? `needs you: ${headline}` : headline,
      key: run.runId,
    });
  };
  /** The person stops the agent's runs; they are marked first so the abort
   *  never counts as the agent failing. */
  const stopRuns = async (task: ScheduleTask): Promise<number> => {
    const sessionIds = [...new Set(current().requestStop(task.id))];
    for (const sessionId of sessionIds) {
      const sessions = await systemSessionsForSession(host, sessionId);
      await sessions.abort(sessionId, { source: "agent-stop" });
    }
    return sessionIds.length;
  };

  const agentsTool = createAgentsTool({
    service: facade,
    personSpace: (userId, spaceId) => host.personSpaceContext?.(userId, spaceId),
    project: (space, projectId) => host.forSpace(space).projects.get(projectId),
    access: scheduleTaskAccess,
  });
  let capabilities: Disposable[] = [];
  let routes: RouteHandler | null = null;
  let stopSubscription: { dispose(): void } | null = null;
  let notificationClaim: { dispose(): void } | null = null;
  const OUTCOME = { completed: "completed", error: "failed", aborted: "stopped" } as const;
  /** A session's turn stopped: offer it to agents as a session event. */
  const onTurnStopped = async ({ sessionId, reason }: { sessionId: string; reason: keyof typeof OUTCOME }) => {
    if (pinging.delete(sessionId)) return;
    if (!schedule) return;
    const projection = await host.store.projection(sessionId);
    // Delegated children report to their parent; a pending provider-limit
    // resume is not a real stop.
    if (!projection || projection.parentId || projection.resume) return;
    let error: string | undefined;
    if (reason === "error") {
      const latest = await host.store.latestSeq(sessionId);
      const tail = await host.store.events(sessionId, Math.max(0, latest - 20));
      const stop = tail.filter((event) => event.type === "turn/stopped").at(-1);
      const text = (stop?.data as { error?: unknown } | undefined)?.error;
      if (typeof text === "string") error = text.slice(0, 300);
    }
    const owner = schedule.agentForSession(sessionId);
    // A heartbeat is a glance, not news: its result reaches other agents as
    // the agent's own run event, and only when it was not quiet.
    if (owner?.trigger === "heartbeat") return;
    schedule.dispatchEvent({
      id: `${sessionId}:${projection.lastTurnAt ?? Date.now()}`,
      kind: "session",
      at: Date.now(),
      projectId: projection.projectId,
      outcome: OUTCOME[reason],
      ...(owner ? { sourceAgentId: owner.agentId } : {}),
      chainDepth: owner?.chainDepth ?? 0,
      fields: {
        title: projection.title ?? "",
        ...(error ? { error } : {}),
        ...(projection.resolvedHarnessId ? { harness: projection.resolvedHarnessId } : {}),
        ...(projection.model?.modelID ? { model: projection.model.modelID } : {}),
        ...(owner?.name ? { agent: owner.name } : {}),
      },
    });
  };
  let loopTimer: ReturnType<typeof setInterval> | null = null;
  // Background scan: a listing failure must degrade this sync, never crash the server.
  const loopSync = async () => {
    const projects = await host.projects.list().catch(() => []);
    rememberProjects(projects);
    if (!schedule) return;
    schedule.assignSpaces();
    for (const project of projects) {
      try { schedule.syncLoops(project.id, scanLoopsDir(project.path)); } catch { /* keep scanning other projects */ }
    }
  };
  return {
    remoteAccess: localOnlyRemoteAccess(["schedule"]),
    routes: async (request) => routes ? routes(request) : false,
    async onEnable() {
      if (!schedule) {
        rememberProjects(await host.projects.list().catch(() => []));
        schedule = createScheduleService({
          runScript: async (task, script, events) => runWakeScript(script, scriptInput(task, events)),
          file: join(dataDir, "schedule.json"),
          spaceFile,
          spaceIds: [...new Set(projectSpaces.values())],
          spaceOf: (projectId) => projectSpaces.get(projectId),
          runner,
          notify: notifyRun,
        });
      }
      routes ??= scheduleRoutes({
        schedule: facade, forSpace: host.forSpace, draft, conversationOf, recentSessionEvents,
        recentIntegrationEvents, sources: () => [...sources.values()], context, compact,
        testScript: (script, events) => runWakeScript(script, { events: scriptEvents(events), agent: { name: "", runsToday: 0, lastRunAt: null } }),
        checkScript: checkWakeScript,
        stop: stopRuns,
        threadSession: threadSessionOf,
      });
      if (warmTimer) clearInterval(warmTimer);
      warmTimer = setInterval(() => { void keepWarm().catch((error) => console.error("[schedule] keep-alive failed", error)); }, 30_000);
      warmTimer.unref?.();
      schedule.start();
      stopSubscription?.dispose();
      stopSubscription = host.services.get(SERVER_TURN_STOPPED_BUS)?.subscribe((event) =>
        onTurnStopped(event).catch((error) => console.error("[schedule] session event failed", error))) ?? null;
      // An agent's own sessions report through the agent's notify policy, so
      // a quiet heartbeat never becomes a "finished" notification.
      notificationClaim?.dispose();
      notificationClaim = host.services.get(SESSION_ATTENTION_SERVICE)?.claimTurnNotifications?.((sessionId) => {
        const owner = schedule?.agentForSession(sessionId);
        return !!owner && !owner.scheduledMessage;
      }) ?? null;
      void loopSync();
      if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
      loopTimer = setInterval(() => void loopSync(), 60_000);
      loopTimer.unref?.();
      const registry = host.services.get(serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"));
      if (registry && capabilities.length === 0) {
        capabilities = [registry.register(AGENTS_PACKAGE_ID, agentsSkill), registry.register(AGENTS_PACKAGE_ID, agentsTool)];
      }
    },
    async onDisable() {
      for (const capability of capabilities.toReversed()) await capability.dispose();
      capabilities = [];
      if (warmTimer) clearInterval(warmTimer);
      warmTimer = null;
      stopSubscription?.dispose();
      stopSubscription = null;
      notificationClaim?.dispose();
      notificationClaim = null;
      schedule?.stop();
      if (loopTimer) clearInterval(loopTimer);
      loopTimer = null;
    },
  };
}

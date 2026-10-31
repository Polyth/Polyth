// Polyth-owned `polyth_planner` agent tool: the agent schedules a prompt into
// its OWN session ("check the repo status at 17:00"). A thin front over the
// Planner service: the task is an ordinary `existing-session` Planner task, so
// the same timer, overlap/catch-up rules, run history and Planner UI apply.
// Server-only: it reads session ownership and writes the Planner store.
import type { AgentCapabilityContribution, JsonObject, ToolExecutionContext } from "@polyth/contracts";
import type { PlannerCadence, PlannerTask } from "./model.ts";
import type { PlannerService } from "./index.ts";
import { describeCron, validateCron } from "./cron.ts";
import { PLANNER_PACKAGE_ID } from "./packageId.ts";

export const PLANNER_TOOL_ID = "planner.tool";
export const PLANNER_TOOL_NAME = "polyth_planner";

/** Active tasks one session may hold; a looping agent cannot pile up wakes. */
export const PLANNER_TOOL_MAX_ACTIVE = 10;
/** Fastest repeat an agent may set up on its own (the UI allows 1 minute). */
export const PLANNER_TOOL_MIN_EVERY_MINUTES = 5;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;
const PROMPT_LIMIT = 4_000;
const TITLE_LIMIT = 120;

export interface PlannerToolDeps {
  planner: PlannerService;
  /** The session's project in `spaceId`; must reject a foreign session. */
  sessionProject(spaceId: string, sessionId: string): Promise<string | undefined>;
  now?: () => number;
  /** IANA zone for wall-clock times given without one (the server's zone). */
  defaultTimeZone?: () => string;
}

const err = (message: string, code = "invalid-input"): Error => Object.assign(new Error(message), { code });

const isZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const serverZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Wall-clock fields of `epoch` in `zone`. */
function wallOf(epoch: number, zone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(epoch));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/** Epoch of a wall-clock time in `zone`. A time skipped by a DST jump lands
 *  just after the jump; a repeated one resolves to its first occurrence. */
export function zonedEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetAt = (epoch: number) => {
    const w = wallOf(epoch, zone);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - epoch;
  };
  const first = asUtc - offsetAt(asUtc);
  const second = asUtc - offsetAt(first);
  return Math.min(first, second);
}

/** `at` → epoch ms. An explicit offset/Z wins; otherwise the time is a wall
 *  clock in `zone`; a bare `HH:MM` is its next occurrence from `now`. */
export function parseAt(raw: string, zone: string, now: number): number {
  const text = raw.trim();
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (clock) {
    const [h, mi, s] = [Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0)];
    if (h > 23 || mi > 59 || s > 59) throw err(`at: ${text} is not a valid time of day`);
    const today = wallOf(now, zone);
    let at = zonedEpoch(today.y, today.mo, today.d, h, mi, s, zone);
    if (at <= now) {
      const tomorrow = wallOf(now + 24 * 60 * 60_000, zone);
      at = zonedEpoch(tomorrow.y, tomorrow.mo, tomorrow.d, h, mi, s, zone);
    }
    return at;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (local) {
    const [y, mo, d, h, mi, s] = local.slice(1).map((value) => Number(value ?? 0)) as [number, number, number, number, number, number];
    if (h > 23 || mi > 59 || s > 59) throw err(`at: ${text} is not a valid time of day`);
    const at = zonedEpoch(y, mo, d, h, mi, s, zone);
    const back = wallOf(at, zone);
    if (back.y !== y || back.mo !== mo || back.d !== d) throw err(`at: ${text} is not a valid date`);
    return at;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    const at = Date.parse(text);
    if (Number.isFinite(at)) return at;
  }
  throw err("at must be HH:MM, YYYY-MM-DDTHH:MM (wall clock in timeZone) or RFC 3339 with an offset");
}

/** `when` in `zone`, e.g. `2026-10-18 17:00 Europe/Kyiv (2026-10-18T14:00:00.000Z)`. */
export function formatWhen(epoch: number, zone: string): string {
  const w = wallOf(epoch, zone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${w.y}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)} ${zone} (${new Date(epoch).toISOString()})`;
}

const describeCadence = (cadence: PlannerCadence, zone: string): string => {
  if (cadence.kind === "at") return `once at ${formatWhen(cadence.at, zone)}`;
  if (cadence.kind === "every") return `every ${cadence.everyMinutes} min`;
  return `${describeCron(cadence.expression)} (${cadence.expression}, ${cadence.timeZone})`;
};

const describeTask = (task: PlannerTask, zone: string): string => {
  const next = task.nextRunAt === null ? "no further runs" : `next ${formatWhen(task.nextRunAt, zone)}`;
  const state = task.enabled ? next : "paused";
  const title = task.title ? `${task.title} — ` : "";
  const prompt = task.prompt.length > 160 ? `${task.prompt.slice(0, 160)}…` : task.prompt;
  return `${task.id}: ${title}${describeCadence(task.cadence, zone)}; ${state}${task.lastError ? `; last error: ${task.lastError}` : ""}\n  prompt: ${prompt}`;
};

const inputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["create", "list", "cancel"] },
    prompt: {
      type: "string",
      description: "create: the message this session receives when the time comes. Write it as a self-contained instruction to yourself, e.g. \"Scheduled check: run git status in this repo and report what changed.\"",
    },
    at: {
      type: "string",
      description: "create, once: HH:MM (next occurrence), YYYY-MM-DDTHH:MM (wall clock in timeZone) or RFC 3339 with an offset.",
    },
    inMinutes: { type: "number", description: "create, once: run this many minutes from now." },
    everyMinutes: { type: "number", description: `create, repeating: interval in minutes (>= ${PLANNER_TOOL_MIN_EVERY_MINUTES}).` },
    cron: { type: "string", description: "create, repeating: 5-field cron expression evaluated in timeZone, e.g. \"0 9 * * 1-5\"." },
    timeZone: { type: "string", description: "IANA zone for at/cron and for displayed times, e.g. Europe/Kyiv. Defaults to the server's zone." },
    title: { type: "string", description: "create: short label shown in the Planner." },
    id: { type: "string", description: "cancel: the task id from create or list." },
  },
};

export function createPlannerAgentTool(deps: PlannerToolDeps): AgentCapabilityContribution {
  const now = deps.now ?? Date.now;
  const defaultZone = deps.defaultTimeZone ?? serverZone;

  /** Tasks this session scheduled into itself, in its own Space. */
  const ownTasks = (ctx: ToolExecutionContext): PlannerTask[] =>
    deps.planner.list(ctx.projectId).filter((task) =>
      task.spaceId === ctx.spaceId
      && (task.target?.mode ?? (task.sessionId ? "existing-session" : "new-session-per-run")) === "existing-session"
      && (task.target?.sessionId ?? task.sessionId) === ctx.sessionId);

  const run = async (input: JsonObject, ctx: ToolExecutionContext): Promise<{ output: string; metadata?: JsonObject }> => {
    if (!ctx.sessionId || !ctx.spaceId) throw err(`${PLANNER_TOOL_NAME} needs a Polyth session`, "unavailable");
    // Ownership comes from the server-side session record, never from input.
    const projectId = await deps.sessionProject(ctx.spaceId, ctx.sessionId);
    if (!projectId || projectId !== ctx.projectId) throw err("this session is not available to the planner", "not-found");
    const zoneInput = typeof input.timeZone === "string" ? input.timeZone.trim() : "";
    if (zoneInput && !isZone(zoneInput)) throw err(`timeZone: unknown IANA zone ${zoneInput}`);
    const zone = zoneInput || defaultZone();
    const t0 = now();
    const clock = `Now: ${formatWhen(t0, zone)}.`;

    if (input.action === "list") {
      const tasks = ownTasks(ctx);
      if (tasks.length === 0) return { output: `${clock}\nNothing is scheduled for this session.`, metadata: { count: 0 } };
      return {
        output: [clock, `Scheduled for this session (${tasks.length}):`, ...tasks.map((task) => describeTask(task, zone))].join("\n"),
        metadata: { count: tasks.length },
      };
    }

    if (input.action === "cancel") {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) throw err("id is required to cancel");
      const task = ownTasks(ctx).find((item) => item.id === id);
      // Another session's or Space's task reads as absent, never as forbidden.
      if (!task) throw err(`no task ${id} is scheduled for this session`, "not-found");
      deps.planner.remove(task.id);
      return { output: `Cancelled ${task.id}: ${describeCadence(task.cadence, zone)}.`, metadata: { taskId: task.id, status: "cancelled" } };
    }

    if (input.action !== "create") throw err("action must be create, list or cancel");
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) throw err("prompt is required");
    if (prompt.length > PROMPT_LIMIT) throw err(`prompt must be at most ${PROMPT_LIMIT} characters`);
    const given = (["at", "inMinutes", "everyMinutes", "cron"] as const).filter((key) => input[key] !== undefined && input[key] !== null && input[key] !== "");
    if (given.length !== 1) throw err("give exactly one of at, inMinutes, everyMinutes or cron");

    let cadence: PlannerCadence;
    if (input.at !== undefined && input.at !== null && input.at !== "") {
      if (typeof input.at !== "string") throw err("at must be a string");
      cadence = { kind: "at", at: parseAt(input.at, zone, t0) };
    } else if (input.inMinutes !== undefined && input.inMinutes !== null) {
      const minutes = Number(input.inMinutes);
      if (!Number.isFinite(minutes) || minutes < 1) throw err("inMinutes must be a number >= 1");
      cadence = { kind: "at", at: t0 + Math.round(minutes * 60_000) };
    } else if (input.everyMinutes !== undefined && input.everyMinutes !== null) {
      const minutes = Number(input.everyMinutes);
      if (!Number.isFinite(minutes) || minutes < PLANNER_TOOL_MIN_EVERY_MINUTES) {
        throw err(`everyMinutes must be a number >= ${PLANNER_TOOL_MIN_EVERY_MINUTES}`);
      }
      cadence = { kind: "every", everyMinutes: Math.round(minutes) };
    } else {
      if (typeof input.cron !== "string") throw err("cron must be a string");
      const checked = validateCron(input.cron, zone, { minIntervalMinutes: PLANNER_TOOL_MIN_EVERY_MINUTES });
      if (!checked.ok) throw err(`cron: ${checked.error}`);
      cadence = { kind: "cron", expression: input.cron.trim(), timeZone: zone };
    }
    if (cadence.kind === "at") {
      if (cadence.at <= t0) throw err(`at is in the past (${formatWhen(cadence.at, zone)}); ${clock}`);
      if (cadence.at - t0 > MAX_AHEAD_MS) throw err("at must be within a year");
    }
    if (ownTasks(ctx).filter((task) => task.enabled).length >= PLANNER_TOOL_MAX_ACTIVE) {
      throw err(`this session already has ${PLANNER_TOOL_MAX_ACTIVE} active scheduled tasks; cancel one first`, "conflict");
    }
    const title = typeof input.title === "string" ? input.title.trim().slice(0, TITLE_LIMIT) : "";
    const owner = ctx.actorUserId && !ctx.actorUserId.startsWith("system:") ? ctx.actorUserId : undefined;
    const task = deps.planner.create({
      projectId,
      spaceId: ctx.spaceId,
      ...(owner ? { ownerUserId: owner } : {}),
      prompt,
      cadence,
      ...(title ? { title } : {}),
      target: { mode: "existing-session", sessionId: ctx.sessionId },
      sessionId: ctx.sessionId,
      // A due wake joins this session's queue if a turn is running; a wake
      // missed while Polyth was down runs once, marked late.
      overlapPolicy: "skip",
      catchUp: "once",
    });
    return {
      output: `${clock}\nScheduled ${describeTask(task, zone)}\nIt runs as a new message in this session. Cancel with action "cancel", id "${task.id}".`,
      metadata: { taskId: task.id, ...(task.nextRunAt !== null ? { nextRunAt: task.nextRunAt } : {}), status: "scheduled" },
    };
  };

  return {
    descriptor: {
      id: PLANNER_TOOL_ID,
      kind: "tool",
      owner: PLANNER_PACKAGE_ID,
      scope: "deployment",
      revision: "1",
      name: PLANNER_TOOL_NAME,
      description: "Schedule a prompt to arrive later in THIS session, once or repeating, e.g. \"check the repo status at 17:00\". Actions: create (prompt + exactly one of at, inMinutes, everyMinutes, cron), list (this session's scheduled tasks), cancel (id). At the time, Polyth sends the prompt to this session as a new message on the user's behalf; if a turn is running it waits in the queue. Times without an offset use timeZone (default: the server's zone; the result shows the current time). Confirm the resolved time to the user. The user also sees and manages these tasks in the Planner.",
      inputSchema,
      trust: "workspace",
      mutating: true,
    },
    // Only schedules into the calling session; counts and intervals are capped.
    autoApprove: () => true,
    execute: run,
  };
}

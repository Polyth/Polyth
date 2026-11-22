// The server-owned wait: durable records, one light poll loop, and a fire
// sequence that survives a failed send and a restart.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Disposable, JsonObject, SpaceContext, ToolExecutionContext } from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins/atomic-write";
import { SESSION_ATTENTION_SERVICE, type ServerPackageHost } from "@polyth/plugins";
import type { WaitConditionProvider, WaitConditionRegistry } from "./index.ts";
import { allowedRoots, confineFile, fail, fileAppeared, identifyProcess, processGone, workspaceRoots, type ProcessIdentity } from "./local.ts";

export const WAIT_STARTED_EVENT = "wait/started";
export const WAIT_ENDED_EVENT = "wait/ended";
export const MAX_PENDING_PER_CHAT = 8;
export const MAX_PENDING_PER_SPACE = 200;
const DEFAULT_TIMEOUT_MINUTES = 120;
const MAX_SEND_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 15 * 60_000;
const PRUNE_AFTER_MS = 24 * 3_600_000;
const FILE = "waits.json";

export type WaitKind = "pid" | "file" | "seconds" | (string & {});
export type WaitState = "pending" | "firing" | "done" | "cancelled";

export interface WaitRecord {
  id: string;
  spaceId: string;
  projectId: string;
  sessionId: string;
  actorUserId: string;
  kind: WaitKind;
  label: string;
  target: JsonObject;
  note?: string;
  createdAt: number;
  deadline: number;
  state: WaitState;
  outcome?: string;
  /** The wake text, fixed when the wait starts firing so a resend is identical. */
  text?: string;
  attempts?: number;
  nextAttemptAt?: number;
}

export interface WaitManagerOptions {
  host: ServerPackageHost;
  now?: () => number;
  /** Poll interval for pid/file/deadline checks; about 2 s. */
  tickMs?: number;
  platform?: NodeJS.Platform;
}

/** RFC-4122-shaped id derived from `value`, the way runtime wakes derive theirs. */
export function uuidFromHash(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | (parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const isRecord = (value: unknown): value is WaitRecord => {
  const row = value as Partial<WaitRecord> | null;
  return !!row && typeof row.id === "string" && typeof row.spaceId === "string" && typeof row.sessionId === "string"
    && typeof row.projectId === "string" && typeof row.actorUserId === "string" && typeof row.kind === "string"
    && typeof row.deadline === "number" && typeof row.state === "string" && !!row.target && typeof row.target === "object";
};

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

export interface WaitManager extends WaitConditionRegistry {
  runTool(input: JsonObject, ctx: ToolExecutionContext): Promise<string>;
  resume(): Promise<void>;
  /** Run one scan now (tests drive time with it). */
  tick(): Promise<void>;
  records(spaceId: string): WaitRecord[];
  dispose(): void;
}

export function createWaitManager(options: WaitManagerOptions): WaitManager {
  const { host } = options;
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const providers = new Map<string, WaitConditionProvider>();
  const lastPolled = new Map<string, number>();
  const inFlight = new Set<string>();
  const spaces = new Map<string, WaitRecord[]>();
  const loading = new Map<string, Promise<WaitRecord[]>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  /** Serialize every mutation so two ticks or a tool call never interleave a save. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const dirFor = (spaceId: string) => host.spaceStorage(host.systemSpaceContext(spaceId)).packageDir(host.pluginId);
  const load = (spaceId: string): Promise<WaitRecord[]> => {
    const known = spaces.get(spaceId);
    if (known) return Promise.resolve(known);
    let pending = loading.get(spaceId);
    if (!pending) {
      pending = Promise.resolve().then(() => {
        let rows: WaitRecord[] = [];
        try {
          const parsed = JSON.parse(readFileSync(join(dirFor(spaceId), FILE), "utf8")) as { waits?: unknown };
          rows = Array.isArray(parsed.waits) ? parsed.waits.filter(isRecord) : [];
        } catch { /* no file yet */ }
        spaces.set(spaceId, rows);
        loading.delete(spaceId);
        return rows;
      });
      loading.set(spaceId, pending);
    }
    return pending;
  };
  const save = (spaceId: string): void => {
    const rows = spaces.get(spaceId) ?? [];
    const cutoff = now() - PRUNE_AFTER_MS;
    const kept = rows.filter((row) => !((row.state === "done" || row.state === "cancelled") && row.deadline < cutoff && (row.nextAttemptAt ?? row.createdAt) < cutoff));
    rows.splice(0, rows.length, ...kept);
    const dir = dirFor(spaceId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteSync(join(dir, FILE), JSON.stringify({ version: 1, waits: rows }), 0o600);
  };

  const hold = (record: WaitRecord): void => {
    if (record.kind === "pid" || record.kind === "file") host.sessions.holdRuntime?.(record.sessionId, record.id, record.deadline);
  };
  const release = (record: WaitRecord): void => {
    if (record.kind === "pid" || record.kind === "file") host.sessions.releaseRuntimeHold?.(record.sessionId, record.id);
  };
  const append = async (record: WaitRecord, type: string, outcome?: string): Promise<void> => {
    await host.events.append(record.sessionId, type, {
      id: record.id, kind: record.kind, label: record.label, ...(outcome ? { outcome } : {}),
    }, { ignorable: true, producerPlugin: host.pluginId }).catch(() => undefined);
  };

  const stopTimerIfIdle = (): void => {
    const live = [...spaces.values()].some((rows) => rows.some((row) => row.state === "pending" || row.state === "firing"));
    if (!live && timer) { clearInterval(timer); timer = undefined; }
  };
  const ensureTimer = (): void => {
    if (disposed || timer) return;
    timer = setInterval(() => { void tick(); }, options.tickMs ?? 2000);
    timer.unref?.();
  };

  const chatState = async (record: WaitRecord): Promise<"ok" | "gone"> => {
    const projection = await host.store.projection(record.sessionId).catch(() => null);
    if (!projection || projection.projectId !== record.projectId) return "gone";
    if (projection.spaceId && projection.spaceId !== record.spaceId) return "gone";
    if (projection.status === "archived" || (projection as { archived?: boolean }).archived) return "gone";
    return "ok";
  };

  const cancelSilently = async (record: WaitRecord): Promise<void> => {
    record.state = "cancelled";
    record.outcome = "cancelled";
    release(record);
    save(record.spaceId);
    await append(record, WAIT_ENDED_EVENT, "cancelled");
  };

  const waitedFor = (record: WaitRecord): string => {
    if (record.kind === "pid") return `the process ${record.target.pid}${record.label.includes("(") ? ` ${record.label.slice(record.label.indexOf("("))}` : ""}`;
    if (record.kind === "file") return `the file ${record.target.path}`;
    if (record.kind === "seconds") return `${record.target.seconds} seconds`;
    return record.label;
  };
  const withNote = (record: WaitRecord, text: string): string =>
    `${text}${record.note ? `\nYour note: ${record.note}` : ""}\nContinue your task.`;

  /** Persist "firing", send, persist "done"; a failed send retries later. */
  const fire = async (record: WaitRecord, outcome: string, text: string): Promise<void> => {
    if (record.state === "pending") {
      record.state = "firing";
      record.outcome = outcome;
      record.text = withNote(record, text);
      record.attempts = 0;
      save(record.spaceId);
    }
    if (await chatState(record) === "gone") { await cancelSilently(record); return; }
    const person: SpaceContext | undefined = host.personSpaceContext?.(record.actorUserId, record.spaceId);
    try {
      if (!person) throw fail("forbidden", "The person this wait acts for is no longer a member of this Space.");
      await host.forSpace(person).sessions.send(record.sessionId, {
        text: record.text ?? withNote(record, text), delivery: "normal", hiddenUserMessage: true,
        clientOperationId: uuidFromHash(`polyth-wait:${record.id}`),
      }, { author: { userId: record.actorUserId, via: "schedule" } });
    } catch {
      record.attempts = (record.attempts ?? 0) + 1;
      if (record.attempts >= MAX_SEND_ATTEMPTS) {
        record.state = "done";
        record.outcome = "wake-failed";
        delete record.nextAttemptAt;
        release(record);
        save(record.spaceId);
        host.services.get(SESSION_ATTENTION_SERVICE)?.notify?.(record.sessionId, {
          kind: "failed", statusText: `Polyth could not wake this chat for its wait (${waitedFor(record)}).`, key: `wait:${record.id}`,
        });
        await append(record, WAIT_ENDED_EVENT, "wake-failed");
        return;
      }
      record.nextAttemptAt = now() + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (record.attempts - 1));
      save(record.spaceId);
      return;
    }
    record.state = "done";
    delete record.nextAttemptAt;
    release(record);
    save(record.spaceId);
    await append(record, WAIT_ENDED_EVENT, record.outcome);
  };

  const timedOutText = (record: WaitRecord): string =>
    `${waitedFor(record)[0]!.toUpperCase()}${waitedFor(record).slice(1)} is still not done after ${Math.round((record.deadline - record.createdAt) / 60_000)} minutes; the wait has ended, so decide whether to wait again.`;

  /** Whether one pending record's condition holds now; fires when it does. */
  const check = async (record: WaitRecord): Promise<void> => {
    const t = now();
    if (record.kind === "seconds") {
      if (t >= record.deadline) await fire(record, "elapsed", `The timer elapsed (${record.target.seconds} seconds).`);
      return;
    }
    if (record.kind === "pid") {
      const identity = record.target as unknown as ProcessIdentity;
      if (await processGone(identity, platform)) {
        const restarted = record.target.resumed === true;
        const label = identity.label ? ` (${identity.label})` : "";
        await fire(record, "exited", restarted
          ? `The process ${identity.pid}${label} is gone. Polyth restarted while you waited, so its exit status is unknown; check its output.`
          : `The process ${identity.pid}${label} has exited; its exit status is not known, so check its output.`);
        return;
      }
    } else if (record.kind === "file") {
      const found = fileAppeared(String(record.target.path), (record.target.roots as string[] | undefined) ?? []);
      if (found) {
        await fire(record, "appeared", `The file ${record.target.path} now exists (${found.size} bytes, modified ${found.mtime}).`);
        return;
      }
    } else {
      const provider = providers.get(record.kind);
      const due = (lastPolled.get(record.id) ?? 0) + Math.max(5000, provider?.intervalMs ?? 30_000) <= t;
      if (provider && due && !inFlight.has(record.id)) {
        lastPolled.set(record.id, t);
        inFlight.add(record.id);
        const result = await provider.poll({
          id: record.id, spaceId: record.spaceId, projectId: record.projectId, sessionId: record.sessionId,
          actorUserId: record.actorUserId, kind: record.kind, label: record.label, target: record.target,
        }).catch(() => ({ done: false as const })).finally(() => inFlight.delete(record.id));
        if (result.done) { await fire(record, result.outcome, result.text); return; }
      }
    }
    if (t >= record.deadline) await fire(record, "timed-out", timedOutText(record));
  };

  const tick = (): Promise<void> => serial(async () => {
    if (disposed) return;
    for (const rows of [...spaces.values()]) {
      for (const record of [...rows]) {
        if (disposed) return;
        try {
          if (record.state === "pending") {
            if (await chatState(record) === "gone") await cancelSilently(record);
            else await check(record);
          } else if (record.state === "firing" && (record.nextAttemptAt ?? 0) <= now()) {
            await fire(record, record.outcome ?? "timed-out", record.text ?? "");
          }
        } catch { /* one record never stops the scan */ }
      }
    }
    stopTimerIfIdle();
  });

  const resume = (): Promise<void> => serial(async () => {
    disposed = false;
    const ids = [...new Set((await host.projects.list()).map((project) => project.spaceId).filter((id): id is string => !!id))];
    for (const spaceId of ids) {
      for (const record of await load(spaceId)) {
        if (record.state === "pending") {
          hold(record);
          if (record.kind === "pid") record.target = { ...record.target, resumed: true };
        } else if (record.state === "firing") {
          record.nextAttemptAt = 0;
        }
      }
    }
    if ([...spaces.values()].some((rows) => rows.some((row) => row.state === "pending" || row.state === "firing"))) ensureTimer();
    if (!disposed) void tick();
  });

  const live = (rows: WaitRecord[], sessionId?: string) =>
    rows.filter((row) => (row.state === "pending" || row.state === "firing") && (!sessionId || row.sessionId === sessionId));

  const runTool = (input: JsonObject, ctx: ToolExecutionContext): Promise<string> => serial(async () => {
    const spaceId = ctx.spaceId;
    if (!spaceId) throw fail("forbidden", "This chat has no Space.");
    if (!ctx.actorUserId) throw fail("forbidden", "A wait acts for a person, and this turn acts for no one.");
    const projection = await host.store.projection(ctx.sessionId);
    if (!projection || projection.projectId !== ctx.projectId || (projection.spaceId && projection.spaceId !== spaceId)) {
      throw fail("not-found", "This chat is not available.");
    }
    const project = await host.projects.get(ctx.projectId);
    if (!project || (project.spaceId && project.spaceId !== spaceId)) throw fail("not-found", "The project is not available.");
    const action = input.action === undefined ? "start" : input.action;
    const rows = await load(spaceId);

    if (action === "list") {
      const mine = live(rows, ctx.sessionId);
      return mine.length
        ? mine.map((row) => `${row.id}: ${waitedFor(row)} (${row.state}), ends by ${new Date(row.deadline).toISOString()}${row.note ? ` — ${row.note}` : ""}`).join("\n")
        : "This chat has no pending waits.";
    }
    if (action === "cancel") {
      const id = typeof input.id === "string" ? input.id : "";
      const record = rows.find((row) => row.id === id && row.sessionId === ctx.sessionId && row.state === "pending");
      if (!record) throw fail("not-found", "This chat has no pending wait with that id.");
      await cancelSilently(record);
      stopTimerIfIdle();
      return `Cancelled the wait ${record.id}.`;
    }
    if (action !== "start") throw fail("invalid-input", "action must be start, list or cancel.");

    const conditions = (["pid", "file", "github_run", "seconds"] as const).filter((key) => input[key] !== undefined);
    if (conditions.length !== 1) throw fail("invalid-input", "Pass exactly one of pid, file, github_run or seconds.");
    const [condition] = conditions;
    const pending = live(rows);
    if (live(pending, ctx.sessionId).length >= MAX_PENDING_PER_CHAT) throw fail("limit", `This chat already has ${MAX_PENDING_PER_CHAT} pending waits; cancel one first.`);
    if (pending.length >= MAX_PENDING_PER_SPACE) throw fail("limit", `This Space already has ${MAX_PENDING_PER_SPACE} pending waits; try again later.`);
    if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 500)) throw fail("invalid-input", "note must be text of at most 500 characters.");
    if (input.timeoutMinutes !== undefined && !isInt(input.timeoutMinutes, 1, 1440)) throw fail("invalid-input", "timeoutMinutes must be an integer from 1 to 1440.");
    const t = now();
    const timeoutMinutes = (input.timeoutMinutes as number | undefined) ?? DEFAULT_TIMEOUT_MINUTES;
    let kind: WaitKind = condition!;
    let label = "";
    let target: JsonObject = {};
    let deadline = t + timeoutMinutes * 60_000;
    if (condition === "seconds") {
      if (!isInt(input.seconds, 1, 86_400)) throw fail("invalid-input", "seconds must be an integer from 1 to 86400.");
      deadline = t + input.seconds * 1000;
      label = `${input.seconds} seconds`;
      target = { seconds: input.seconds };
    } else if (condition === "pid" || condition === "file") {
      // The process or file would be on another machine for an SSH workspace.
      if (project.remote) throw fail("unsupported", `This chat runs on a remote host, so a ${condition} on it cannot be watched from this machine. Use seconds or github_run.`);
      if (condition === "pid") {
        const identity = await identifyProcess(input.pid, platform, workspaceRoots(ctx.cwd, project.path));
        target = { ...identity };
        label = `process ${identity.pid}${identity.label ? ` (${identity.label})` : ""}`;
      } else {
        const roots = allowedRoots(ctx.cwd, project.path);
        const path = confineFile(input.file, ctx.cwd, roots);
        target = { path, roots };
        label = `file ${path}`;
      }
    } else {
      const provider = providers.get("github_run");
      if (!provider) throw fail("unsupported", "GitHub support is not available.");
      const started = await provider.start(input.github_run as JsonObject, {
        spaceId, projectId: ctx.projectId, sessionId: ctx.sessionId, actorUserId: ctx.actorUserId, cwd: ctx.cwd,
      });
      kind = provider.kind;
      label = started.label;
      target = started.target;
    }
    const record: WaitRecord = {
      id: `w_${randomBytes(6).toString("hex")}`, spaceId, projectId: ctx.projectId, sessionId: ctx.sessionId,
      actorUserId: ctx.actorUserId, kind, label, target, ...(typeof input.note === "string" && input.note ? { note: input.note } : {}),
      createdAt: t, deadline, state: "pending",
    };
    rows.push(record);
    save(spaceId);
    hold(record);
    ensureTimer();
    await append(record, WAIT_STARTED_EVENT);
    const when = condition === "seconds" ? "the time is up" : condition === "pid" ? "exits" : condition === "file" ? "appears" : "finishes";
    const limit = condition === "seconds" ? "" : `, or after ${timeoutMinutes} minutes`;
    return `Waiting for ${label} for this chat (id ${record.id}). You will be woken here when it ${condition === "seconds" ? "elapses" : when}${limit}. End your turn now; do not poll.`;
  });

  return {
    register(provider): Disposable {
      providers.set(provider.kind, provider);
      return { dispose: () => { if (providers.get(provider.kind) === provider) providers.delete(provider.kind); } };
    },
    runTool,
    resume,
    tick,
    records: (spaceId) => [...(spaces.get(spaceId) ?? [])],
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const rows of spaces.values()) for (const row of rows) if (row.state === "pending") release(row);
    spaces.clear();
    lastPolled.clear();
    },
  };
}

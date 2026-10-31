import { randomUUID } from "node:crypto";
import type {
  JsonObject,
  SessionEvent,
  SessionProjection,
  SessionService,
  SpaceContext,
} from "@polyth/contracts";
import { SESSION_PAUSE_ENDED_EVENT } from "@polyth/contracts";
import type {
  DurableSessionWatch,
  DurableSessionWatchStop,
  Store,
} from "@polyth/session";
import type {
  ServerSessionWatchCreateInput,
  ServerSessionWatchDelivery,
  ServerSessionWatchDto,
  ServerSessionWatchReason,
  ServerSessionWatchService,
} from "@polyth/plugins";

const REASONS = ["completed", "error", "aborted", "paused"] as const satisfies readonly ServerSessionWatchReason[];
// The default stores what older servers can read: "aborted" already hears
// of pauses (wants).
const DEFAULT_EVENTS = ["completed", "error", "aborted"] as const satisfies readonly ServerSessionWatchReason[];
const DELIVERIES = ["observe", "wake"] as const satisfies readonly ServerSessionWatchDelivery[];

export interface SessionWatchCoordinator extends ServerSessionWatchService {
  /** Event-driven kick from the canonical turnStopped seam. */
  kick(sourceSessionId: string): Promise<void>;
  /** The target's pause ended: deliver the wakes held for it. */
  kickTarget(targetSessionId: string): Promise<void>;
  /** One bounded replay pass after process restart; no polling remains armed. */
  recover(): Promise<void>;
  /** Wait for in-flight deliveries. Persistence is owned by the session Store. */
  close(): Promise<void>;
}

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

const parseStop = ({ type, data }: DurableSessionWatchStop): {
  reason?: ServerSessionWatchReason;
  retrying: boolean;
} => {
  // A pause that ends in Stop finishes the paused work as aborted; one that
  // continued is not a stop.
  if (type === SESSION_PAUSE_ENDED_EVENT) {
    return { ...(data.outcome === "stopped" ? { reason: "aborted" as const } : {}), retrying: false };
  }
  const stated = data.reason === "paused"
    ? undefined
    : REASONS.find((reason) => reason === data.reason);
  const reason = stated === "aborted" && data.paused === true ? "paused" : stated;
  return {
    reason,
    retrying: reason === "error" && data.retry !== undefined && data.retry !== null,
  };
};

/** A watch for aborts also hears of pauses: one is the other, not yet final. */
const wants = (wanted: ReadonlySet<ServerSessionWatchReason>, reason: ServerSessionWatchReason): boolean =>
  wanted.has(reason) || (reason === "paused" && wanted.has("aborted"));

const canonicalEvents = (events: ServerSessionWatchReason[] | undefined): ServerSessionWatchReason[] => {
  if (events === undefined) return [...DEFAULT_EVENTS];
  if (!Array.isArray(events) || events.length === 0) {
    return fail("invalid-input", "watch events must contain at least one terminal reason");
  }
  const selected = new Set<ServerSessionWatchReason>();
  for (const event of events) {
    if (!REASONS.includes(event)) return fail("invalid-input", `unsupported watch event: ${String(event)}`);
    selected.add(event);
  }
  return REASONS.filter((reason) => selected.has(reason));
};

const dto = (watch: DurableSessionWatch): ServerSessionWatchDto => ({
  id: watch.id,
  sourceSessionId: watch.sourceSessionId,
  targetSessionId: watch.targetSessionId,
  events: canonicalEvents(watch.events as ServerSessionWatchReason[]),
  delivery: watch.delivery,
  once: watch.once,
  createdAt: watch.createdAt,
});

// The text is a pure function of immutable facts (ids, stop, parentage): a
// retried wake reuses its client operation id and must replay the same text.
const messageFor = (
  source: SessionProjection,
  reason: ServerSessionWatchReason,
  stopSeq: number,
  targetSessionId: string,
): string => {
  if (reason === "paused") {
    return [
      "A watched Polyth session was paused by a person.",
      `Session: ${source.id}`,
      `Project: ${source.projectId}`,
      "Result: paused",
      `Terminal event seq: ${stopSeq}`,
      "",
      "Its turn was interrupted, but its work is neither finished nor failed: the person will continue it or stop it. Do not replace, restart or message it, and do not treat its partial result as final; agents cannot continue it. This watch stays armed and reports again when it ends. Meanwhile continue whatever does not depend on it.",
    ].join("\n");
  }
  const status = reason === "completed" ? "completed successfully" : reason === "error" ? "failed" : "was aborted";
  return [
    "A watched Polyth session has terminated.",
    `Session: ${source.id}`,
    `Project: ${source.projectId}`,
    `Result: ${status}`,
    `Terminal event seq: ${stopSeq}`,
    "",
    "Inspect that session with the Polyth session tools if its result matters, then continue your orchestration task.",
    ...(source.parentId === targetSessionId
      ? ["If you spawned it with isolation=isolated, its changes reach your checkout only through agent.merge (or agent.discard); agent.list shows what is still unmerged."]
      : []),
  ].join("\n");
};

export function createSessionWatchCoordinator(deps: {
  store: Store;
  sessions(): SessionService;
  broadcast: { event(event: SessionEvent): void };
  now?: () => number;
}): SessionWatchCoordinator {
  const now = deps.now ?? Date.now;
  let closing = false;
  const tails = new Map<string, Promise<void>>();

  const open = (): void => {
    if (closing) fail("unavailable", "session watch service is shutting down");
  };

  const sessionSpace = (projection: SessionProjection | undefined): string | undefined =>
    projection?.spaceId ?? (projection ? deps.store.spaceOfSession(projection.id) : undefined);

  const assertSpaceSession = async (
    space: SpaceContext,
    sessionId: string,
    role: "source" | "target",
  ): Promise<SessionProjection> => {
    const projection = await deps.store.projection(sessionId);
    if (!projection || sessionSpace(projection) !== space.spaceId) {
      return fail("not-found", `${role} session is not in the current Space`);
    }
    return projection;
  };

  const appendObservation = async (
    watch: DurableSessionWatch,
    source: SessionProjection,
    reason: ServerSessionWatchReason,
    stopSeq: number,
  ): Promise<void> => {
    if (await deps.store.sessionWatchObservationDelivered(watch.targetSessionId, watch.id, stopSeq)) return;
    const event = await deps.store.append(
      watch.targetSessionId,
      "session/watch-fired",
      {
        watchId: watch.id,
        sourceSessionId: source.id,
        sourceProjectId: source.projectId,
        sourceStopSeq: stopSeq,
        reason,
      } satisfies JsonObject,
      { ignorable: true, producerPlugin: "harness-runtime" },
    );
    deps.broadcast.event(event);
  };

  const wake = async (
    watch: DurableSessionWatch,
    source: SessionProjection,
    reason: ServerSessionWatchReason,
    stopSeq: number,
  ): Promise<void> => {
    let operationId = watch.pendingSeq === stopSeq ? watch.pendingOperationId : undefined;
    if (!operationId) {
      operationId = randomUUID();
      const updated = await deps.store.updateSessionWatch(watch.id, {
        cursorSeq: watch.cursorSeq,
        pendingSeq: stopSeq,
        pendingOperationId: operationId,
      });
      if (!updated) return fail("not-found", "session watch disappeared before delivery");
    }
    await deps.sessions().send(watch.targetSessionId, {
      text: messageFor(source, reason, stopSeq, watch.targetSessionId),
      delivery: "normal",
      hiddenUserMessage: true,
      clientOperationId: operationId,
    });
  };

  const settle = async (watch: DurableSessionWatch, seq: number): Promise<void> => {
    if (watch.once) {
      await deps.store.deleteSessionWatch(watch.id);
      return;
    }
    await deps.store.updateSessionWatch(watch.id, {
      cursorSeq: seq,
      pendingSeq: null,
      pendingOperationId: null,
    });
  };

  const advance = async (watch: DurableSessionWatch, seq: number): Promise<void> => {
    await deps.store.updateSessionWatch(watch.id, {
      cursorSeq: seq,
      pendingSeq: null,
      pendingOperationId: null,
    });
  };

  const drainWatch = async (watchId: string): Promise<void> => {
    while (!closing) {
      const watch = await deps.store.sessionWatch(watchId);
      if (!watch) return;
      const source = await deps.store.projection(watch.sourceSessionId);
      const target = await deps.store.projection(watch.targetSessionId);
      if (!source || !target) {
        await deps.store.deleteSessionWatch(watch.id);
        return;
      }
      const sourceSpace = sessionSpace(source);
      const targetSpace = sessionSpace(target);
      if (!sourceSpace || sourceSpace !== watch.spaceId || targetSpace !== watch.spaceId) {
        await deps.store.deleteSessionWatch(watch.id);
        return;
      }

      const stops = await deps.store.sessionWatchStopsAfter(watch.sourceSessionId, watch.cursorSeq, 128);
      if (stops.length === 0) return;

      const wanted = new Set(canonicalEvents(watch.events as ServerSessionWatchReason[]));
      for (const stop of stops) {
        const current = await deps.store.sessionWatch(watch.id);
        if (!current) return;
        if (stop.seq <= current.cursorSeq) continue;
        const terminal = parseStop(stop);
        if (terminal.retrying || !terminal.reason || !wants(wanted, terminal.reason)) {
          await advance(current, stop.seq);
          continue;
        }
        const reason = terminal.reason;
        // A wake into a session a person paused would continue it: it waits
        // for the pause to end (kickTarget), in order.
        if (current.delivery === "wake" && target.paused) return;
        if (current.delivery === "observe") {
          await appendObservation(current, source, reason, stop.seq);
        } else {
          await wake(current, source, reason, stop.seq);
        }
        // A pause is not the end: even a one-shot watch stays armed for it.
        if (reason === "paused") {
          await advance(current, stop.seq);
          continue;
        }
        await settle(current, stop.seq);
        if (current.once) return;
      }
      if (stops.length < 128) return;
    }
  };

  const serialized = async (watchId: string): Promise<void> => {
    const previous = tails.get(watchId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => drainWatch(watchId));
    const settled = run.then(() => undefined, () => undefined);
    tails.set(watchId, settled);
    try {
      await run;
    } finally {
      if (tails.get(watchId) === settled) tails.delete(watchId);
    }
  };

  return {
    async create(space, input: ServerSessionWatchCreateInput) {
      open();
      if (!input || typeof input.sourceSessionId !== "string" || typeof input.targetSessionId !== "string") {
        return fail("invalid-input", "sourceSessionId and targetSessionId are required");
      }
      if (input.sourceSessionId === input.targetSessionId) {
        return fail("invalid-input", "a session cannot watch itself");
      }
      const delivery = input.delivery ?? "wake";
      if (!DELIVERIES.includes(delivery)) return fail("invalid-input", `unsupported watch delivery: ${String(delivery)}`);
      const events = canonicalEvents(input.events);
      const once = input.once !== false;
      await Promise.all([
        assertSpaceSession(space, input.sourceSessionId, "source"),
        assertSpaceSession(space, input.targetSessionId, "target"),
      ]);

      // Snapshot the current durable tail before insertion: watches never fire
      // retroactively. createSessionWatch performs the final duplicate/cycle
      // check and insert in the Store transaction. The immediate drain below
      // closes the latestSeq→insert race without polling.
      const cursorSeq = await deps.store.latestSeq(input.sourceSessionId);
      const persisted = await deps.store.createSessionWatch({
        id: randomUUID(),
        spaceId: space.spaceId,
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        events,
        delivery,
        once,
        cursorSeq,
        createdAt: now(),
      });
      await serialized(persisted.watch.id);
      return dto((await deps.store.sessionWatch(persisted.watch.id)) ?? persisted.watch);
    },

    async list(space, input = {}) {
      open();
      return (await deps.store.sessionWatches({
        spaceId: space.spaceId,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
      })).map(dto);
    },

    async remove(space, id, targetSessionId) {
      open();
      if (!id) return false;
      return deps.store.deleteSessionWatch(id, {
        spaceId: space.spaceId,
        ...(targetSessionId ? { targetSessionId } : {}),
      });
    },

    async kick(sourceSessionId) {
      if (closing) return;
      const ids = await deps.store.sessionWatchIdsForSource(sourceSessionId);
      const results = await Promise.allSettled(ids.map((id) => serialized(id)));
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("[polyth] session watch delivery failed", result.reason);
        }
      }
    },

    async kickTarget(targetSessionId) {
      if (closing) return;
      const watches = await deps.store.sessionWatches({ targetSessionId });
      const results = await Promise.allSettled(watches.map((watch) => serialized(watch.id)));
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("[polyth] held session watch delivery failed", result.reason);
        }
      }
    },

    async recover() {
      if (closing) return;
      const watches = await deps.store.sessionWatches();
      // Deliberately bounded/sequential at boot: recovery must not stampede
      // runtimes when many durable watches became ready while the server was down.
      for (const watch of watches) {
        try {
          await serialized(watch.id);
        } catch (error) {
          console.error("[polyth] session watch recovery failed", error);
        }
      }
    },

    async close() {
      if (closing) return;
      closing = true;
      await Promise.allSettled([...tails.values()]);
    },
  };
}

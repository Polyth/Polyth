import type { SessionEvent, SessionPersistence, SessionProjection } from "@polyth/contracts";
import { deriveMessages, effectiveHistory } from "@polyth/session";
import { assistFreshnessSeq } from "@polyth/session/next-action";
import type { GoalChildContext, GoalContext, GoalState } from "./index.ts";

const BUSY = new Set(["working", "waiting", "reconciling", "unknown", "epoch-pending"]);
const CONTEXT_TYPES = ["user/message", "assistant/message", "assistant/chunk", "turn/started", "turn/stopped", "session/forked", "session/rewound", "session/rewind-cleared"];
const MAX_REPORTS = 16;
const MAX_REPORT_CHARS = 16_000;

function lastReply(events: readonly SessionEvent[]): string {
  const visible = effectiveHistory(events).events;
  const lastMessage = visible.findLast((event) => event.type === "assistant/message"
    && typeof event.data.text === "string" && event.data.text.trim());
  const lastChunk = visible.findLast((event) => event.type === "assistant/chunk"
    && typeof event.data.text === "string" && event.data.text.trim());
  if (lastChunk && lastChunk.seq > (lastMessage?.seq ?? 0)) {
    const boundary = visible.findLast((event) => event.seq < lastChunk.seq
      && (event.type === "user/message" || event.type === "turn/started"))?.seq ?? 0;
    return visible.filter((event) => event.seq > boundary && event.type === "assistant/chunk"
      && (!lastChunk.data.partId || event.data.partId === lastChunk.data.partId))
      .map((event) => typeof event.data.text === "string" ? event.data.text : "").join("");
  }
  const messages = deriveMessages([...events]);
  const message = messages.findLast((item) => item.role === "assistant"
    && item.parts.some((part) => part.type === "text" && part.text.trim()));
  return message?.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "";
}

/** Persistence-only context. Reading a goal must never activate a native leg. */
/** The newest event of `types`. `eventsOfTypes` pages oldest-first, so walk to the end. */
export async function latestGoalEvent(
  store: Pick<SessionPersistence, "events" | "latestSeq"> & Partial<Pick<SessionPersistence, "eventsOfTypes">>,
  sessionId: string,
  types: readonly string[],
): Promise<SessionEvent | undefined> {
  if (!store.eventsOfTypes) return (await store.events(sessionId)).filter((event) => types.includes(event.type)).at(-1);
  const through = await store.latestSeq(sessionId);
  let last: SessionEvent | undefined;
  for (let after = 0; ;) {
    const page = await store.eventsOfTypes(sessionId, types, after, through, 500);
    if (page.length) { last = page.at(-1); after = last!.seq; }
    if (page.length < 500) return last;
  }
}

export function createGoalContextReader(deps: {
  store: SessionPersistence;
  admit(sessionId: string): Promise<SessionProjection>;
  goal(sessionId: string): Promise<Pick<GoalState, "status" | "lastVerdict"> | null>;
  queued(sessionId: string): Promise<boolean>;
}) {
  const sameScope = (a: SessionProjection, b: SessionProjection): boolean =>
    Boolean(a.spaceId) && a.spaceId === b.spaceId && a.projectId === b.projectId;

  const isFork = async (id: string): Promise<boolean> => deps.store.hasEventOfType
    ? deps.store.hasEventOfType(id, "session/forked")
    : (await deps.store.events(id)).some((event) => event.type === "session/forked");

  const contextEvents = async (id: string): Promise<SessionEvent[]> => deps.store.eventsOfTypes
    ? deps.store.eventsOfTypes(id, CONTEXT_TYPES, 0, await deps.store.latestSeq(id), 256)
    : deps.store.events(id);

  return {
    async context(sessionId: string): Promise<GoalContext> {
      const parent = await deps.admit(sessionId);
      const parentEvents = await deps.store.events(sessionId);
      const rows = (await deps.store.projections(parent.projectId, { spaceId: parent.spaceId }))
        .filter((row) => sameScope(parent, row));
      const byParent = new Map<string, SessionProjection[]>();
      for (const row of rows) {
        if (!row.parentId) continue;
        const list = byParent.get(row.parentId) ?? [];
        list.push(row);
        byParent.set(row.parentId, list);
      }
      const descendants: SessionProjection[] = [];
      const seen = new Set([sessionId]);
      for (const id of seen) {
        for (const row of byParent.get(id) ?? []) {
          // A fork has parentId for provenance; it is not delegated work.
          if (seen.has(row.id) || await isFork(row.id)) continue;
          seen.add(row.id);
          descendants.push(row);
        }
      }
      const pendingSessionIds: string[] = [];
      const revisions: Array<[string, string, number, string, boolean]> = [];
      const children: GoalChildContext[] = [];
      const newest = descendants.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      let remaining = MAX_REPORT_CHARS;
      for (const child of newest) {
        const goal = await deps.goal(child.id);
        const queued = await deps.queued(child.id);
        const events = await contextEvents(child.id);
        const effective = effectiveHistory(events).events;
        const stop = effective.findLast((event) => event.type === "turn/stopped");
        const goalPending = child.status === "idle" && stop?.data.reason === "completed"
          && goal?.status === "active" && goal.lastVerdict !== "stuck";
        // A person paused it: idle, but its work is not over (nor failed).
        const busy = BUSY.has(child.status) || queued || goalPending || child.paused !== undefined;
        if (busy) pendingSessionIds.push(child.id);
        revisions.push([child.id, child.paused ? "paused" : child.status, assistFreshnessSeq(events), `${goal?.status ?? ""}/${goal?.lastVerdict ?? ""}`, queued]);
        if (children.length >= MAX_REPORTS || remaining < 512) continue;
        const text = (event: SessionEvent | undefined): string => typeof event?.data.text === "string" ? event.data.text : "";
        const prompt = text(effective.find((event) => event.type === "user/message")).slice(0, Math.min(1000, remaining / 4));
        const reply = lastReply(effective).slice(-Math.min(2500, remaining - prompt.length));
        remaining -= prompt.length + reply.length + 512;
        children.push({ sessionId: child.id, parentId: child.parentId!, title: child.title.slice(0, 160), status: child.status,
          ...(goal ? { goalStatus: goal.status } : {}),
          ...(child.paused ? { stopReason: "paused" } : typeof stop?.data.reason === "string" ? { stopReason: stop.data.reason } : {}),
          ...(typeof stop?.data.error === "string" ? { error: stop.data.error.slice(0, 240) } : {}), prompt, reply });
      }
      const parentQueued = await deps.queued(sessionId);
      const lastTurn = effectiveHistory(parentEvents).events.findLast((event) => event.type === "turn/started" || event.type === "turn/stopped");
      const reply = lastReply(parentEvents);
      const ready = Boolean(reply) && !parentQueued && lastTurn?.type !== "turn/started"
        && lastTurn?.data.reason !== "aborted" && lastTurn?.data.reason !== "error"
        && !parentEvents.some((event) => event.type === "user/message" && lastTurn && event.seq > lastTurn.seq)
        && (parent.status === "idle" || parent.status === "finished" || (parent.status === "waiting" && pendingSessionIds.length > 0));
      return {
        revision: JSON.stringify([parent.status, assistFreshnessSeq(parentEvents), parentQueued, revisions.sort((a, b) => a[0].localeCompare(b[0]))]),
        ready, reply, pendingSessionIds: pendingSessionIds.sort(), children,
        omittedChildren: descendants.length - children.length,
      };
    },

    async related(sessionId: string): Promise<Array<{ sessionId: string; events: readonly SessionEvent[] }>> {
      const source = await deps.admit(sessionId);
      const related: Array<{ sessionId: string; events: readonly SessionEvent[] }> = [];
      const seen = new Set([sessionId]);
      let child = source;
      while (child.parentId && !seen.has(child.parentId) && seen.size < 64) {
        if (await isFork(child.id)) break;
        const parent = await deps.store.projection(child.parentId);
        if (!parent || !sameScope(source, parent)) break;
        seen.add(parent.id);
        if (!deps.store.hasEventOfType || await deps.store.hasEventOfType(parent.id, "goal/attached")) {
          related.push({ sessionId: parent.id, events: await deps.store.events(parent.id) });
        }
        child = parent;
      }
      return related;
    },
  };
}

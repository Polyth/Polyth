import type { DurableOperation, SessionEvent, SessionPersistence } from "@polyth/contracts";

/** The durable reads needed to decide whether an operation still gates a session. */
export interface OperationAdmissionStore {
  operations(sessionId: string): Promise<DurableOperation[]>;
  events: SessionPersistence["events"];
  eventsOfTypes?: SessionPersistence["eventsOfTypes"];
  latestSeq: SessionPersistence["latestSeq"];
}

export const isRuntimeOperationBlocking = (operation: DurableOperation): boolean =>
  operation.state === "prepared"
  || operation.state === "executing"
  || operation.state === "unknown";

/** Indexed type-filtered read when the store offers one; whole-log fallback otherwise. */
async function eventsOfType(
  store: OperationAdmissionStore,
  sessionId: string,
  types: readonly string[],
): Promise<SessionEvent[]> {
  if (store.eventsOfTypes) {
    const through = await store.latestSeq(sessionId);
    const collected: SessionEvent[] = [];
    let cursor = 0;
    while (cursor < through) {
      const page = await store.eventsOfTypes(sessionId, types, cursor, through);
      if (!page.length) break;
      collected.push(...page);
      cursor = page[page.length - 1]!.seq;
    }
    return collected;
  }
  const wanted = new Set(types);
  return (await store.events(sessionId)).filter((event) => wanted.has(event.type));
}

/** Ordinal of the newest confirmed session-reset that a durable
 *  `runtime/epoch-replaced` marker names, or undefined without one. */
export async function latestConfirmedEpochResetOrdinal(
  store: OperationAdmissionStore,
  sessionId: string,
  operations?: readonly DurableOperation[],
): Promise<number | undefined> {
  const resetIds = (await eventsOfType(store, sessionId, ["runtime/epoch-replaced"]))
    .map((event) => (event.data as { resetOperationId?: unknown }).resetOperationId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (resetIds.length === 0) return undefined;
  const named = new Set(resetIds);
  const reset = (operations ?? await store.operations(sessionId))
    .filter((operation) =>
      operation.mutationKind === "session-reset"
      && operation.state === "confirmed"
      && named.has(operation.operationId))
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  return reset?.ordinal;
}

/** Operations named by any `runtime/restart-recovered` marker — turns that
 *  were in flight when Polyth restarted and whose owned backend session was
 *  later re-verified alive. They stay `unknown` (never auto-resolved) but no
 *  longer gate send admission, mirroring prior-epoch unknowns after a
 *  confirmed session-reset. Fork / rewind / assertMutable still 409 on them. */
export async function restartRecoveredOperationIds(
  store: OperationAdmissionStore,
  sessionId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const event of await eventsOfType(store, sessionId, ["runtime/restart-recovered"])) {
    const recovered = (event.data as { recoveredOperationIds?: unknown }).recoveredOperationIds;
    if (Array.isArray(recovered)) {
      for (const id of recovered) if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/** The first operation that still gates this session: prepared/executing
 *  work, or an `unknown` outcome that no later confirmed epoch reset or
 *  restart-recovery marker has superseded. Send admission, idle runtime
 *  release and boot status recovery share this one definition so a
 *  prior-epoch unknown cannot keep a session uncertain (or its process alive)
 *  after the runtime that owned it was provably replaced. Durable event reads
 *  happen only when an unknown operation actually needs the evidence. */
export async function admissionBlockingOperations(
  store: OperationAdmissionStore,
  sessionId: string,
): Promise<DurableOperation[]> {
  const operations = await store.operations(sessionId);
  const blocking = operations.filter(isRuntimeOperationBlocking);
  if (blocking.length === 0) return blocking;
  const uncertain = blocking.some((operation) => operation.state === "unknown");
  const resetOrdinal = uncertain ? await latestConfirmedEpochResetOrdinal(store, sessionId, operations) : undefined;
  const recovered = uncertain ? await restartRecoveredOperationIds(store, sessionId) : undefined;
  return blocking.filter((operation) => {
    if (operation.state !== "unknown") return true;
    if (resetOrdinal !== undefined && operation.ordinal < resetOrdinal) return false;
    if (recovered?.has(operation.operationId)) return false;
    return true;
  });
}

export async function admissionBlockingOperation(
  store: OperationAdmissionStore,
  sessionId: string,
): Promise<DurableOperation | undefined> {
  return (await admissionBlockingOperations(store, sessionId))[0];
}

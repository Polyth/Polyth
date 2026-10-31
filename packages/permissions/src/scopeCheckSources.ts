// Server-side evidence for the Auto-Approve second opinion: the latest request
// a person wrote in the session, read from canonical persistence only.
import type { SessionEvent, SessionPersistence } from "@polyth/contracts";
import { effectiveHistory } from "@polyth/session";

const TYPES = ["user/message", "session/rewound", "session/rewind-cleared"];
const PAGE = 500;
const MAX_PAGES = 40;

/** A user message a person typed: not a package/agent-produced message, a
 * GitHub handoff card or a recovery re-delivery. */
export function isPersonAuthoredRequest(event: SessionEvent): boolean {
  if (event.type !== "user/message" || event.producerPlugin) return false;
  const data = event.data as Record<string, unknown>;
  if (data.githubConflictResolution || data.compactionRecovery || data.runtimeEpochRecovery) return false;
  return typeof data.text === "string" && data.text.trim().length > 0;
}

export async function latestPersonRequest(
  store: Pick<SessionPersistence, "events" | "eventsOfTypes" | "latestSeq">,
  sessionId: string,
): Promise<string | undefined> {
  let events: SessionEvent[];
  if (store.eventsOfTypes) {
    events = [];
    const through = await store.latestSeq(sessionId);
    let cursor = 0;
    for (let page = 0; page < MAX_PAGES && cursor < through; page++) {
      const rows = await store.eventsOfTypes(sessionId, TYPES, cursor, through, PAGE);
      events.push(...rows);
      if (rows.length < PAGE) break;
      cursor = rows.at(-1)!.seq;
    }
  } else {
    events = (await store.events(sessionId)).filter((event) => TYPES.includes(event.type));
  }
  const latest = effectiveHistory(events).events.findLast(isPersonAuthoredRequest);
  return latest ? String(latest.data.text) : undefined;
}

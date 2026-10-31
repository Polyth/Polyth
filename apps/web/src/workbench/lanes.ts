// Chat lanes. A workbench profile that declares `sessionPurpose` has its own
// chat lane; everything else is the Conversation lane. Pure helpers so the
// navigation layer, the sidebar and tests agree on one rule.
import type { WorkbenchProfileSummary } from "@polyth/web-sdk";
import { SESSION_PURPOSE_CONVERSATION } from "@polyth/contracts";

export interface LaneSession {
  id: string;
  parentId?: string;
  purpose?: string;
}

/** Whether a session purpose names a chat lane. A package declares one with
 *  `sessionPurpose`; every other purpose (a workflow run marker, a small-model
 *  utility kind) is metadata, not a lane. The default accepts every purpose so
 *  pure callers keep the historical walk; navigation passes the live rule. */
export type LanePurposePredicate = (purpose: string) => boolean;

const EVERY_PURPOSE: LanePurposePredicate = () => true;

/** The purpose deciding a session's lane: its own, or the nearest ancestor's,
 *  so delegated children stay beside the chat that spawned them. A purpose
 *  that names no lane is skipped, so a package marker such as a workflow run
 *  does not strand the session outside every list. */
export function lanePurposeOf(
  session: LaneSession,
  byId: ReadonlyMap<string, LaneSession>,
  isLanePurpose: LanePurposePredicate = EVERY_PURPOSE,
): string {
  let current: LaneSession | undefined = session;
  for (let depth = 0; current !== undefined && depth < 32; depth += 1) {
    // A conversation is the host's own people-first chat, not a package
    // lane: it lists beside ordinary chats.
    if (
      current.purpose
      && current.purpose !== SESSION_PURPOSE_CONVERSATION
      && isLanePurpose(current.purpose)
    ) return current.purpose;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return "";
}

/** Profile owning a purpose. Ordinary chats, and purposes whose package is not
 *  available, belong to `fallback` (the Conversation profile). */
export function laneProfileFor(
  purpose: string,
  profiles: readonly WorkbenchProfileSummary[],
  fallback: string,
): string {
  if (!purpose) return fallback;
  return profiles.find((profile) => profile.available && profile.sessionPurpose === purpose)?.id ?? fallback;
}

/** Sessions whose own purpose, or nearest ancestor's, is this lane.
 *  An empty purpose is the ordinary Conversation lane. Descendants stay with
 *  the chat that spawned them. Purposes a package presents in its own UI
 *  (`listedElsewhere`) stay out of every other lane's list.
 *
 *  A purpose a package owns is package-owned for the session's whole life, so
 *  one whose owning profile is not currently available (its package was
 *  disabled or uninstalled) belongs to *no* listed lane. It must never fall
 *  back into the Conversation lane, which would show a package's chats as
 *  ordinary chats the moment its package is turned off. Opening such a chat
 *  still works through lane routing (`laneProfileFor`). A purpose no package
 *  declares names no lane at all (a workflow run marker, for instance), so the
 *  session falls back to its nearest ancestor's lane instead of disappearing. */
export function sessionsInLane<T extends LaneSession>(
  sessions: readonly T[],
  lanePurpose: string | undefined,
  availablePurposes?: ReadonlySet<string>,
  listedElsewhere?: ReadonlySet<string>,
  isLanePurpose: LanePurposePredicate = EVERY_PURPOSE,
): T[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const expected = lanePurpose ?? "";
  return sessions.filter((session) => {
    const purpose = lanePurposeOf(session, byId, isLanePurpose);
    if (purpose && purpose !== expected && listedElsewhere?.has(purpose)) return false;
    if (purpose && availablePurposes && !availablePurposes.has(purpose)) return false;
    return purpose === expected;
  });
}

const LANE_DRAFT_PREFIX = "lane:";

/** Persistence id for an unsent new chat. Ordinary chats omit it so the
 *  existing project draft key stays readable. */
export function newSessionLaneDraftId(purpose: string | undefined): string | undefined {
  return purpose ? `${LANE_DRAFT_PREFIX}${purpose}` : undefined;
}

let lanePurposeReader: () => string | undefined = () => undefined;

/** Profile navigation installs this so draft storage can see the active lane
 *  without importing the app store. */
export function bindLanePurposeReader(reader: () => string | undefined): void {
  lanePurposeReader = reader;
}

export function activeDraftLanePurpose(): string | undefined {
  const purpose = lanePurposeReader();
  return purpose || undefined;
}

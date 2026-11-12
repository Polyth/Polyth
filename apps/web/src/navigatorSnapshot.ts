// What the navigator last showed — the project list and the open project's
// newest rows — kept per connection and account, so a launch paints it at once
// while the same reads are on their way to the server. The server's answers
// replace it within a round trip; until then the catch-up state labels the
// screen as updating (syncCatchUp.ts). Rows keep only the navigator's own
// summary fields: no transcript, no session detail, no archived chats. The
// branch label rides along, so the composer's chip needs no git read first.
import { SESSION_SUMMARY_FIELDS, type Project, type SessionProjection } from "@polyth/contracts";
import { sessionRepositoryScope } from "@polyth/contracts/workspace";
import { hydrateClientRecord, writeClientPreference, type PersistenceScope } from "./clientPersistence.ts";

const KIND = "navigator-snapshot-v1";
/** Well under the Link store's 256 KB per record. */
export const NAVIGATOR_SNAPSHOT_MAX_BYTES = 192 * 1024;
/** Newest rows kept besides pinned ones: the recency page the server sends. */
export const NAVIGATOR_SNAPSHOT_ROWS = 50;

export interface NavigatorSnapshot {
  v: 1;
  savedAt: number;
  /** The Space the projects belong to when it was taken. */
  spaceId: string;
  projects: Project[];
  /** The project whose rows are kept. */
  projectId: string | null;
  /** Summary rows (`summary: true`): an open still reads the full session. */
  sessions: SessionProjection[];
  /** The checkout branch label last shown for `projectId`, and the worktree
   *  it belongs to ("" = the primary checkout). */
  branch: { scope: string; label: string } | null;
}

function summaryRow(session: SessionProjection): SessionProjection {
  const row: Record<string, unknown> = {};
  for (const key of SESSION_SUMMARY_FIELDS) {
    const value = session[key];
    if (value !== undefined) row[key] = value;
  }
  // A full row knows its scope only through `workspace`, which stays out.
  const repositoryScope = sessionRepositoryScope(session);
  if (repositoryScope) row.repositoryScope = repositoryScope;
  else delete row.repositoryScope;
  row.summary = true;
  return row as unknown as SessionProjection;
}

/** The rows of `projectId` a launch would show: the newest page plus every
 *  pinned row, never archived ones. */
export function snapshotRows(sessions: readonly SessionProjection[], projectId: string | null): SessionProjection[] {
  if (!projectId) return [];
  const own = sessions
    .filter((session) => session.projectId === projectId && session.status !== "archived")
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const recent = own.slice(0, NAVIGATOR_SNAPSHOT_ROWS);
  const kept = new Set(recent.map((session) => session.id));
  const pinned = own.filter((session) => session.pinned && !kept.has(session.id));
  return [...recent, ...pinned].map(summaryRow);
}

/** Serialized snapshot under the byte cap (oldest rows dropped first), or
 *  null when there is nothing worth keeping or even the projects are too big. */
export function encodeNavigatorSnapshot(snapshot: Omit<NavigatorSnapshot, "v">): string | null {
  if (snapshot.projects.length === 0) return null;
  const rows = [...snapshot.sessions];
  for (;;) {
    const encoded = JSON.stringify({ v: 1, ...snapshot, sessions: rows } satisfies NavigatorSnapshot);
    if (encoded.length <= NAVIGATOR_SNAPSHOT_MAX_BYTES) return encoded;
    if (rows.length === 0) return null;
    rows.splice(Math.max(0, rows.length - Math.ceil(rows.length / 4)));
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function decodeNavigatorSnapshot(raw: string | null): NavigatorSnapshot | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value) || value.v !== 1 || typeof value.spaceId !== "string" || typeof value.savedAt !== "number") return null;
  if (!Array.isArray(value.projects) || !Array.isArray(value.sessions)) return null;
  if (value.projectId !== null && typeof value.projectId !== "string") return null;
  const projects = value.projects.filter((project): project is Project =>
    isRecord(project) && typeof project.id === "string" && project.id !== "" && typeof project.name === "string");
  if (projects.length === 0) return null;
  const sessions = value.sessions.filter((session): session is SessionProjection =>
    isRecord(session) && typeof session.id === "string" && typeof session.status === "string"
    && session.projectId === value.projectId && session.summary === true);
  const branch = isRecord(value.branch) && typeof value.branch.scope === "string"
    && typeof value.branch.label === "string" && value.branch.label !== "" && value.projectId !== null
    ? { scope: value.branch.scope, label: value.branch.label }
    : null;
  return { v: 1, savedAt: value.savedAt, spaceId: value.spaceId, projects, projectId: value.projectId as string | null, sessions, branch };
}

export async function readNavigatorSnapshot(scope: PersistenceScope): Promise<NavigatorSnapshot | null> {
  try {
    return decodeNavigatorSnapshot(await hydrateClientRecord(KIND, scope));
  } catch {
    return null; // a slow or failed store read only means no head start
  }
}

/** Presentation only: a lost write costs the next launch its head start. */
export function writeNavigatorSnapshot(scope: PersistenceScope, encoded: string): void {
  writeClientPreference(KIND, scope, encoded);
}

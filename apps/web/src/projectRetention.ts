// Cleanup of expired and archived sessions, chosen per project in Settings →
// Projects → Cleanup. Each person sets it separately for each project and it
// only ever touches that person's own chats; the server sweep reads the same
// synced record (`sessionDefaults.projectRetention`, see
// packages/server/src/expiredSessionCleanup.ts).
//
// The choice used to be one global setting per person. A project with no entry
// still follows that older record, on the server and here, so nothing changes
// until the person edits a project. The first edit writes an entry for every
// project from the older record and turns its switch off: an older client that
// drops the unknown map then cleans up nothing instead of everything.
import { getState, updateSettings } from "./store.ts";
import { getSessionDefaults, setSessionDefaults, type ProjectRetentionEntry, type SessionDefaults } from "./sessionDefaults.ts";

export type RetentionAction = "archive" | "delete";

export interface ProjectRetention {
  autoCleanup: boolean;
  days: number;
  action: RetentionAction;
  skipIsolated: boolean;
  archiveDays: number;
  /** Only a project's own entry turns this on; the older record never had it. */
  autoDeleteArchives: boolean;
}

function legacyEntry(defaults: SessionDefaults, legacyAuto: boolean): ProjectRetentionEntry {
  return {
    autoCleanup: legacyAuto,
    ...(defaults.retentionDays ? { days: defaults.retentionDays } : {}),
    ...(defaults.retentionAction ? { action: defaults.retentionAction } : {}),
    ...(defaults.retentionSkipIsolated !== undefined ? { skipIsolated: defaults.retentionSkipIsolated } : {}),
    ...(defaults.archiveRetentionDays ? { archiveDays: defaults.archiveRetentionDays } : {}),
  };
}

/** One project's effective choice (pass a room's parent project id). */
export function projectRetention(defaults: SessionDefaults, legacyAuto: boolean, projectId: string): ProjectRetention {
  const own = defaults.projectRetention && Object.hasOwn(defaults.projectRetention, projectId)
    ? defaults.projectRetention[projectId]
    : undefined;
  const entry = own ?? legacyEntry(defaults, legacyAuto);
  return {
    autoCleanup: entry.autoCleanup === true,
    days: entry.days ?? 30,
    action: entry.action ?? "archive",
    // Only an explicit `false` lets cleanup take isolated work.
    skipIsolated: entry.skipIsolated !== false,
    archiveDays: entry.archiveDays ?? 30,
    autoDeleteArchives: own?.autoDeleteArchives === true,
  };
}

/** Change one project's choice. `projectIds` are every project this person can
 *  see, seeded from the older global record on the first edit. */
export function setProjectRetention(
  projectId: string,
  patch: Partial<ProjectRetentionEntry>,
  projectIds: readonly string[],
): void {
  const defaults = getSessionDefaults();
  const legacyAuto = getState().settings.autoCleanupExpiredSessions;
  const map: Record<string, ProjectRetentionEntry> = { ...defaults.projectRetention };
  if (!defaults.projectRetention) {
    const seed = legacyEntry(defaults, legacyAuto);
    for (const id of new Set([...projectIds, projectId])) map[id] = { ...seed };
  }
  map[projectId] = { ...(map[projectId] ?? legacyEntry(defaults, false)), ...patch };
  setSessionDefaults({ projectRetention: map });
  if (legacyAuto) updateSettings({ autoCleanupExpiredSessions: false });
}

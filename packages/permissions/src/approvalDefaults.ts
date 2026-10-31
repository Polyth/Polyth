// Approval defaults: the level a chat gets when neither it nor any chat above
// it picked one. Each Space has a default, and a project may set its own (in
// either direction). Only a person (the instance owner, through the UI) raises
// one; reading or storage failures fail closed to "off".
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";

/** Off asks for everything, routine is Auto-Approve, all is Full access. */
export type ApprovalLevel = "off" | "routine" | "all";

export const APPROVAL_LEVELS: readonly ApprovalLevel[] = ["off", "routine", "all"];

export const isApprovalLevel = (value: unknown): value is ApprovalLevel =>
  value === "off" || value === "routine" || value === "all";

/** Orders levels by autonomy, so a change can be classified as a raise. */
export const approvalLevelRank = (level: ApprovalLevel): number =>
  level === "all" ? 2 : level === "routine" ? 1 : 0;

export interface ApprovalDefault {
  level: ApprovalLevel;
  /** When and by whom it was last changed; absent for the built-in default. */
  changedAt?: number;
  changedBy?: string;
}

export interface ApprovalDefaultsState extends ApprovalDefault {
  /** Projects with a level of their own, by project id. */
  projects: Record<string, ApprovalDefault>;
}

export interface ApprovalDefaultsService {
  /** The level for a chat with no choice in its chain: its project's own
   *  level, else the Space's, else off. */
  level(spaceId: string | undefined, projectId?: string): ApprovalLevel;
  get(spaceId: string): ApprovalDefaultsState;
  setSpaceLevel(spaceId: string, level: ApprovalLevel, userId: string): ApprovalDefaultsState;
  /** "inherit" removes the project's own level. */
  setProjectLevel(spaceId: string, projectId: string, level: ApprovalLevel | "inherit", userId: string): ApprovalDefaultsState;
  /** Fires with the Space id after a change has been persisted. */
  subscribe(listener: (spaceId: string) => void): () => void;
}

const OFF: ApprovalDefaultsState = { level: "off", projects: {} };

const parseDefault = (raw: unknown): ApprovalDefault | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!isApprovalLevel(value.level)) return undefined;
  return {
    level: value.level,
    ...(typeof value.changedAt === "number" ? { changedAt: value.changedAt } : {}),
    ...(typeof value.changedBy === "string" ? { changedBy: value.changedBy } : {}),
  };
};

/** The file keeps its historic name and `enabled` field, which older servers
 *  read as "Full access in every chat". A file without `level` is one of
 *  theirs; a `level` that is present but unknown reads as off. */
export const parseApprovalDefaults = (raw: unknown): ApprovalDefaultsState => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return OFF;
  const value = raw as Record<string, unknown>;
  if (!("level" in value)) {
    if (value.enabled !== true) return OFF;
    return {
      level: "all",
      ...(typeof value.enabledAt === "number" ? { changedAt: value.enabledAt } : {}),
      ...(typeof value.enabledBy === "string" ? { changedBy: value.enabledBy } : {}),
      projects: {},
    };
  }
  const space = parseDefault(value);
  if (!space) return OFF;
  const projects: Record<string, ApprovalDefault> = {};
  if (value.projects && typeof value.projects === "object" && !Array.isArray(value.projects)) {
    for (const [projectId, entry] of Object.entries(value.projects as Record<string, unknown>)) {
      const parsed = parseDefault(entry);
      // An unreadable project entry would otherwise fall back to the Space's
      // level, which may be broader than what was stored: hold it at off.
      projects[projectId] = parsed ?? { level: "off" };
    }
  }
  return { ...space, projects };
};

/** What an older server, which only knows "Full access in every chat", may
 *  safely conclude: Full access only where nothing narrower was chosen. */
const legacyFullAccess = (state: ApprovalDefaultsState): boolean =>
  state.level === "all" && Object.values(state.projects).every((entry) => entry.level === "all");

const serialize = (state: ApprovalDefaultsState): string => {
  const legacy = legacyFullAccess(state);
  return `${JSON.stringify({
    enabled: legacy,
    ...(legacy && state.changedAt !== undefined ? { enabledAt: state.changedAt } : {}),
    ...(legacy && state.changedBy !== undefined ? { enabledBy: state.changedBy } : {}),
    level: state.level,
    ...(state.changedAt !== undefined ? { changedAt: state.changedAt } : {}),
    ...(state.changedBy !== undefined ? { changedBy: state.changedBy } : {}),
    projects: state.projects,
  }, null, 2)}\n`;
};

const copy = (state: ApprovalDefaultsState): ApprovalDefaultsState => ({
  ...state,
  projects: Object.fromEntries(Object.entries(state.projects).map(([id, entry]) => [id, { ...entry }])),
});

/** `fileOf` maps a Space to its own storage file, or undefined when the Space
 *  cannot be resolved (which reads as off). */
export function createApprovalDefaultsService(
  fileOf: (spaceId: string) => string | undefined,
): ApprovalDefaultsService {
  const cache = new Map<string, ApprovalDefaultsState>();
  const listeners = new Set<(spaceId: string) => void>();

  /** Throws for anything but a missing file; the file only ever appears
   *  through `write`, so a missing one can be cached as off. */
  const load = (spaceId: string): ApprovalDefaultsState => {
    const cached = cache.get(spaceId);
    if (cached) return cached;
    const file = fileOf(spaceId);
    let state = OFF;
    if (file) {
      try {
        state = parseApprovalDefaults(JSON.parse(readFileSync(file, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
      }
    }
    cache.set(spaceId, state);
    return state;
  };

  // Unreadable or malformed: off, and not cached, so a transient failure
  // does not pin the answer.
  const read = (spaceId: string): ApprovalDefaultsState => {
    try {
      return load(spaceId);
    } catch {
      return OFF;
    }
  };

  // A change starts from what is stored, never from a fail-closed stand-in
  // that would drop the other levels.
  const readForWrite = (spaceId: string): ApprovalDefaultsState => {
    try {
      return load(spaceId);
    } catch {
      throw Object.assign(new Error("Approval defaults could not be read"), { code: "unavailable" });
    }
  };

  const write = (spaceId: string, next: ApprovalDefaultsState): ApprovalDefaultsState => {
    const file = fileOf(spaceId);
    if (!file) throw Object.assign(new Error("Space storage is unavailable"), { code: "unavailable" });
    mkdirSync(dirname(file), { recursive: true });
    atomicWriteSync(file, serialize(next));
    cache.set(spaceId, next);
    for (const listener of listeners) {
      try {
        listener(spaceId);
      } catch (error) {
        console.error("[polyth] approval defaults listener failed", error);
      }
    }
    return copy(next);
  };

  return {
    level(spaceId, projectId) {
      if (!spaceId) return "off";
      const state = read(spaceId);
      return (projectId ? state.projects[projectId]?.level : undefined) ?? state.level;
    },
    get: (spaceId) => copy(read(spaceId)),
    setSpaceLevel(spaceId, level, userId) {
      if (!isApprovalLevel(level)) throw Object.assign(new Error("level must be off, routine, or all"), { code: "invalid-input" });
      const current = readForWrite(spaceId);
      return write(spaceId, { ...current, level, changedAt: Date.now(), changedBy: userId });
    },
    setProjectLevel(spaceId, projectId, level, userId) {
      if (!projectId) throw Object.assign(new Error("project id is required"), { code: "invalid-input" });
      if (level !== "inherit" && !isApprovalLevel(level)) {
        throw Object.assign(new Error("level must be off, routine, all, or inherit"), { code: "invalid-input" });
      }
      const current = readForWrite(spaceId);
      const projects = { ...current.projects };
      if (level === "inherit") delete projects[projectId];
      else projects[projectId] = { level, changedAt: Date.now(), changedBy: userId };
      return write(spaceId, { ...current, projects });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

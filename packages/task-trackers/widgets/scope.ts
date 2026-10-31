import { useSyncExternalStore } from "react";
import type {
  TaskTrackerBoardDto,
  TaskTrackerProjectDto,
  TaskTrackerProvider,
} from "@polyth/contracts";
import type { WebUiPreferenceAdapter } from "@polyth/web-sdk";
import { TASK_TRACKER_PROVIDERS } from "../src/types.ts";

/**
 * Which projects/workspaces and boards a person wants to see per tracker,
 * and which ones open by default. Each Polyth project keeps its own choice
 * (see "per Polyth project" below). This is the caller's own view preference:
 * it is cached in localStorage for synchronous reads and mirrored through
 * the host's account preference seam, never through Space settings.
 *
 * Hidden ids (rather than shown ids) are stored so a board created later is
 * visible right away. Unknown ids are harmless: they never match.
 */

export interface ProviderBoardScope {
  hiddenProjects: string[];
  hiddenBoards: string[];
  /** Empty means "all projects". */
  defaultProjectId: string;
  /** Empty means the first visible board. */
  defaultBoardId: string;
}

export type BoardScope = Record<TaskTrackerProvider, ProviderBoardScope>;

export const BOARD_SCOPE_PREFERENCE = "package.task-trackers.boards";
const STORAGE_KEY = "polyth.task-trackers.boards";
const ID_MAX = 256;
const LIST_MAX = 500;

export const EMPTY_PROVIDER_SCOPE: ProviderBoardScope = Object.freeze({
  hiddenProjects: [],
  hiddenBoards: [],
  defaultProjectId: "",
  defaultBoardId: "",
}) as ProviderBoardScope;

const idOf = (value: unknown): string =>
  typeof value === "string" && value.length <= ID_MAX ? value : "";

const idList = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.map(idOf).filter(Boolean))].slice(0, LIST_MAX)
    : [];

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const isProvider = (value: unknown): value is TaskTrackerProvider =>
  typeof value === "string" && (TASK_TRACKER_PROVIDERS as readonly string[]).includes(value);

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function normalizeProviderScope(value: unknown): ProviderBoardScope {
  const input = record(value);
  return {
    hiddenProjects: idList(input.hiddenProjects),
    hiddenBoards: idList(input.hiddenBoards),
    defaultProjectId: idOf(input.defaultProjectId),
    defaultBoardId: idOf(input.defaultBoardId),
  };
}

/** Tolerates missing, older, or malformed values; unknown keys are dropped. */
export function normalizeBoardScope(value: unknown): BoardScope {
  const input = record(value);
  return Object.fromEntries(TASK_TRACKER_PROVIDERS.map((provider) =>
    [provider, normalizeProviderScope(input[provider])])) as BoardScope;
}

const isEmpty = (scope: ProviderBoardScope): boolean =>
  scope.hiddenProjects.length === 0
  && scope.hiddenBoards.length === 0
  && !scope.defaultProjectId
  && !scope.defaultBoardId;

// ---------------------------------------------------------------- per Polyth project

/**
 * The board choice of one Polyth project: the tracker it opens with and, per
 * tracker, the shown and default boards. A tracker the project never changed
 * follows the account-wide selection (`boardScope()`): what the person chose
 * before boards were chosen per project, edited only where no project is
 * open. So nothing moves until they change it in a project, and from then on
 * that project keeps its own.
 */
export interface ProjectBoardScope {
  /** The tracker this project opens with; empty = the first usable one. */
  provider: TaskTrackerProvider | "";
  trackers: Partial<BoardScope>;
  /** When the person last chose what this project opens (its tracker or a
   *  default). What a window remembers from before that gives way to it. */
  changedAt?: number;
}

export const PROJECT_BOARD_SCOPE_PREFERENCE = "package.task-trackers.project-boards";
const PROJECT_STORAGE_KEY = "polyth.task-trackers.project-boards";
/** Projects kept; the one changed least recently goes first. */
const PROJECTS_MAX = 100;

/** Tolerates missing, older, or malformed values; unknown keys are dropped. */
export function normalizeProjectBoardScopes(value: unknown): Record<string, ProjectBoardScope> {
  const entries: Array<[string, ProjectBoardScope]> = [];
  for (const [projectId, raw] of Object.entries(record(record(value).projects))) {
    if (!idOf(projectId)) continue;
    const item = record(raw);
    const stored = record(item.trackers);
    const trackers: Partial<BoardScope> = {};
    for (const provider of TASK_TRACKER_PROVIDERS) {
      if (stored[provider] !== undefined) trackers[provider] = normalizeProviderScope(stored[provider]);
    }
    entries.push([projectId, {
      provider: isProvider(item.provider) ? item.provider : "",
      trackers,
      ...(isTime(item.changedAt) ? { changedAt: item.changedAt } : {}),
    }]);
  }
  return Object.fromEntries(entries.slice(-PROJECTS_MAX));
}

// ---------------------------------------------------------------- store

const readStorage = (): BoardScope => {
  try {
    return normalizeBoardScope(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeBoardScope(undefined);
  }
};

const readProjectStorage = (): Record<string, ProjectBoardScope> => {
  try {
    return normalizeProjectBoardScopes(JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? "null"));
  } catch {
    return {};
  }
};

let scope: BoardScope = readStorage();
let projects: Record<string, ProjectBoardScope> = readProjectStorage();
const listeners = new Set<() => void>();

const store = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Preference only; the in-memory value still drives this page.
  }
};

const notify = (): void => {
  for (const listener of listeners) listener();
};

const commit = (next: BoardScope): void => {
  if (JSON.stringify(next) === JSON.stringify(scope)) return;
  scope = next;
  store(STORAGE_KEY, scope);
  notify();
};

const commitProjects = (next: Record<string, ProjectBoardScope>): void => {
  if (JSON.stringify(next) === JSON.stringify(projects)) return;
  projects = next;
  store(PROJECT_STORAGE_KEY, projects);
  notify();
};

const own = (projectId: string | null | undefined): ProjectBoardScope | undefined =>
  projectId && Object.hasOwn(projects, projectId) ? projects[projectId] : undefined;

/** Writes one project's choice (moving it to the newest end) or removes it. */
const commitProject = (projectId: string, entry: ProjectBoardScope | null): void => {
  const current = own(projectId);
  if (JSON.stringify(current ?? null) === JSON.stringify(entry)) return;
  commitProjects(Object.fromEntries([
    ...Object.entries(projects).filter(([id]) => id !== projectId),
    ...(entry ? [[projectId, entry] as const] : []),
  ].slice(-PROJECTS_MAX)));
};

/** The account-wide selection: where no project is open, and the start of a project's own. */
export function boardScope(): BoardScope {
  return scope;
}

/** What a window in this Polyth project shows of this tracker (no project: the account-wide selection). */
export function providerScope(projectId: string | null | undefined, provider: TaskTrackerProvider): ProviderBoardScope {
  return own(projectId)?.trackers[provider] ?? scope[provider];
}

/** The tracker this Polyth project opens with; empty when it has none. */
export function projectTracker(projectId: string | null | undefined): TaskTrackerProvider | "" {
  return own(projectId)?.provider ?? "";
}

/** When this project's tracker or a default was last chosen; 0 = never. */
export function projectChangedAt(projectId: string | null | undefined): number {
  return own(projectId)?.changedAt ?? 0;
}

export function subscribeBoardScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Authoritative replacement, e.g. the account mirror arriving from the host. */
export function replaceBoardScope(value: unknown): void {
  commit(normalizeBoardScope(value));
}

/** Authoritative replacement of every project's choice (the account mirror). */
export function replaceProjectBoardScopes(value: unknown): void {
  commitProjects(normalizeProjectBoardScopes(value));
}

/** Changes what this Polyth project shows of a tracker; other projects keep theirs. */
export function updateProviderScope(
  projectId: string | null | undefined,
  provider: TaskTrackerProvider,
  patch: Partial<ProviderBoardScope>,
): void {
  const previous = providerScope(projectId, provider);
  const next = normalizeProviderScope({ ...previous, ...patch });
  // A hidden project or board cannot stay the default.
  if (next.defaultProjectId && next.hiddenProjects.includes(next.defaultProjectId)) next.defaultProjectId = "";
  if (next.defaultBoardId && next.hiddenBoards.includes(next.defaultBoardId)) next.defaultBoardId = "";
  if (!projectId) {
    commit({ ...scope, [provider]: next });
    return;
  }
  const current = own(projectId);
  // Choosing a default is a decision about what opens; hiding or clearing is not.
  const chose = (next.defaultProjectId && next.defaultProjectId !== previous.defaultProjectId)
    || (next.defaultBoardId && next.defaultBoardId !== previous.defaultBoardId);
  const changedAt = chose ? Date.now() : current?.changedAt;
  commitProject(projectId, {
    provider: current?.provider ?? "",
    trackers: { ...current?.trackers, [provider]: next },
    ...(changedAt ? { changedAt } : {}),
  });
}

/** Chooses the tracker this Polyth project opens with (empty: the first usable one). */
export function setProjectTracker(projectId: string, provider: TaskTrackerProvider | ""): void {
  const current = own(projectId);
  if (!projectId || (current?.provider ?? "") === provider) return;
  const trackers = { ...current?.trackers };
  const changedAt = provider ? Date.now() : current?.changedAt;
  commitProject(projectId, provider || Object.keys(trackers).length > 0
    ? { provider, trackers, ...(changedAt ? { changedAt } : {}) }
    : null);
}

export function useProviderScope(projectId: string | null | undefined, provider: TaskTrackerProvider): ProviderBoardScope {
  return useSyncExternalStore(subscribeBoardScope, () => providerScope(projectId, provider), () => EMPTY_PROVIDER_SCOPE);
}

export function useProjectTracker(projectId: string | null | undefined): TaskTrackerProvider | "" {
  return useSyncExternalStore(subscribeBoardScope, () => projectTracker(projectId), () => "");
}

/** The host mirrors the account-wide selection through the account settings transport. */
export const boardScopeAdapter: WebUiPreferenceAdapter = {
  read: () => (TASK_TRACKER_PROVIDERS.every((provider) => isEmpty(scope[provider])) ? null : scope),
  write: replaceBoardScope,
  subscribe: subscribeBoardScope,
};

/** …and every project's own choice, under its own id so a client that
 *  predates per-project boards never drops them when it writes its value. */
export const projectBoardScopeAdapter: WebUiPreferenceAdapter = {
  read: () => (Object.keys(projects).length === 0 ? null : { projects }),
  write: replaceProjectBoardScopes,
  subscribe: subscribeBoardScope,
};

/** Test seam: forget cached state between isolated renders. */
export function resetBoardScopeForTests(): void {
  scope = normalizeBoardScope(undefined);
  projects = {};
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PROJECT_STORAGE_KEY);
  } catch { /* no storage */ }
  notify();
}

// ---------------------------------------------------------------- pure helpers

export const isProjectVisible = (scope: ProviderBoardScope, projectId: string | undefined): boolean =>
  !projectId || !scope.hiddenProjects.includes(projectId);

export const isBoardVisible = (scope: ProviderBoardScope, board: Pick<TaskTrackerBoardDto, "id" | "projectId">): boolean =>
  !scope.hiddenBoards.includes(board.id) && isProjectVisible(scope, board.projectId);

export function visibleProjects<T extends Pick<TaskTrackerProjectDto, "id">>(
  projects: readonly T[],
  scope: ProviderBoardScope,
): T[] {
  return projects.filter((project) => isProjectVisible(scope, project.id));
}

export function visibleBoards<T extends Pick<TaskTrackerBoardDto, "id" | "projectId">>(
  boards: readonly T[],
  scope: ProviderBoardScope,
): T[] {
  return boards.filter((board) => isBoardVisible(scope, board));
}

/**
 * The project filter to open: the first preferred id that is a visible
 * project, else the default, else "all". Preferred ids come from what the
 * device remembers; the default from the account preference.
 */
export function resolveProject(
  projects: readonly Pick<TaskTrackerProjectDto, "id">[],
  scope: ProviderBoardScope,
  preferred: readonly (string | undefined | null)[] = [],
): string {
  const visible = new Set(visibleProjects(projects, scope).map((project) => project.id));
  for (const id of preferred) if (id && visible.has(id)) return id;
  return scope.defaultProjectId && visible.has(scope.defaultProjectId) ? scope.defaultProjectId : "";
}

/** Same precedence for boards, falling back to the first visible one. */
export function resolveBoard(
  boards: readonly Pick<TaskTrackerBoardDto, "id" | "projectId">[],
  scope: ProviderBoardScope,
  preferred: readonly (string | undefined | null)[] = [],
): string {
  const visible = visibleBoards(boards, scope);
  const ids = new Set(visible.map((board) => board.id));
  for (const id of preferred) if (id && ids.has(id)) return id;
  if (scope.defaultBoardId && ids.has(scope.defaultBoardId)) return scope.defaultBoardId;
  return visible[0]?.id ?? "";
}

// ---------------------------------------------------------------- device memory

/** Where a window remembers what it showed in one Polyth project: a project
 *  never opens the board another project last showed. */
export const projectMemoryKey = (key: string, projectId: string | null | undefined): string =>
  projectId ? `${key}:${projectId}` : key;

/** What one board window last showed. Device-local: never synced. */
export interface BoardMemory {
  provider?: TaskTrackerProvider;
  selections: Partial<Record<TaskTrackerProvider, { projectId: string; boardId: string }>>;
  /** The assignee filter per tracker (tokens from `people.ts`); people are
   *  the tracker's, so it holds across that tracker's boards. */
  assignees?: Partial<Record<TaskTrackerProvider, string[]>>;
  /** When the tracker or a board selection was last written. */
  at?: number;
}

const ASSIGNEES_MAX = 50;

export interface BoardMemoryStore {
  read(): BoardMemory;
  /** Merges: a provider patch keeps the other providers' selections. */
  write(patch: Partial<BoardMemory>): void;
}

export function normalizeBoardMemory(value: unknown): BoardMemory {
  const input = record(value);
  const selections: BoardMemory["selections"] = {};
  const stored = record(input.selections);
  for (const provider of TASK_TRACKER_PROVIDERS) {
    const item = record(stored[provider]);
    const projectId = idOf(item.projectId);
    const boardId = idOf(item.boardId);
    if (projectId || boardId) selections[provider] = { projectId, boardId };
  }
  const assignees: NonNullable<BoardMemory["assignees"]> = {};
  const storedAssignees = record(input.assignees);
  for (const provider of TASK_TRACKER_PROVIDERS) {
    const tokens = idList(storedAssignees[provider]).slice(0, ASSIGNEES_MAX);
    if (tokens.length > 0) assignees[provider] = tokens;
  }
  return {
    ...(isProvider(input.provider) ? { provider: input.provider } : {}),
    selections,
    ...(Object.keys(assignees).length > 0 ? { assignees } : {}),
    ...(isTime(input.at) ? { at: input.at } : {}),
  };
}

/**
 * A window's memory. The tracker and boards it remembers from before `since`
 * (when the project's tracker or a default was last chosen) are forgotten, so
 * the newer choice opens; the assignee filter stays. Until the window writes
 * under `key`, it reads `legacyKey`: what it showed before it remembered per
 * project, which every project starts from.
 */
export function localBoardMemory(
  key: string,
  { since = 0, legacyKey }: { since?: number; legacyKey?: string } = {},
): BoardMemoryStore {
  const read = (): BoardMemory => {
    let value: BoardMemory;
    try {
      const stored = localStorage.getItem(key) ?? (legacyKey ? localStorage.getItem(legacyKey) : null);
      value = normalizeBoardMemory(JSON.parse(stored ?? "null"));
    } catch {
      return { selections: {} };
    }
    return (value.at ?? 0) < since
      ? { selections: {}, ...(value.assignees ? { assignees: value.assignees } : {}) }
      : value;
  };
  return {
    read,
    write(patch) {
      const current = read();
      const assignees = { ...current.assignees, ...patch.assignees };
      for (const provider of TASK_TRACKER_PROVIDERS) {
        if (assignees[provider]?.length === 0) delete assignees[provider];
      }
      const at = patch.provider || patch.selections ? Date.now() : current.at;
      const next: BoardMemory = {
        ...(patch.provider ?? current.provider ? { provider: patch.provider ?? current.provider } : {}),
        selections: { ...current.selections, ...patch.selections },
        ...(Object.keys(assignees).length > 0 ? { assignees } : {}),
        ...(at ? { at } : {}),
      };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Memory only; the window still works without it.
      }
    },
  };
}

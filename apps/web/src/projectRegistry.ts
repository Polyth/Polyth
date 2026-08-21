// UX-ONBOARDING: canonical project-registry state. One discriminated union
// replaces `projectsLoaded: boolean` plus a free array: `loading`, `failed`,
// and `ready` are distinct truths, an empty array is project data only after a
// successful list response, and every list request carries a monotonically
// increasing requestId plus the mutationVersion it captured — a stale response
// can never publish over a newer request or a confirmed mutation.
//
// Pure module: no fetch, no store, no DOM. The store applies these transitions
// atomically; init.ts owns the request/reconciliation loop.
import type { Project } from "@polyth/contracts";

export type ProjectRegistryState =
  | {
      status: "loading";
      requestId: number;
      projects: [];
    }
  | {
      status: "failed";
      requestId: number;
      projects: [];
      error: string;
    }
  | {
      status: "ready";
      requestId: number;
      projects: Project[];
      mutationVersion: number;
      refreshing: boolean;
      refreshError: string | null;
    };

export function initialProjectRegistry(): ProjectRegistryState {
  return { status: "loading", requestId: 0, projects: [] };
}

/** Non-ready states have never observed a successful mutation publish (a
 *  registry can only leave `ready` through nothing — refresh failures keep the
 *  snapshot), so their effective mutation version is 0. */
export function mutationVersionOf(state: ProjectRegistryState): number {
  return state.status === "ready" ? state.mutationVersion : 0;
}

/** Unknown, duplicate, and reordered list entries normalize by stable project
 *  id; the server's order remains the display order (first occurrence wins). */
export function normalizeProjects(projects: readonly Project[]): Project[] {
  const seen = new Set<string>();
  const out: Project[] = [];
  for (const p of projects) {
    if (!p || typeof p.id !== "string" || p.id === "" || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** Step 3 of the refresh ordering: enter `loading` only when no ready snapshot
 *  exists; otherwise mark the ready snapshot as refreshing. Known data never
 *  turns back into unknown data. */
export function beginListRequest(state: ProjectRegistryState, requestId: number): ProjectRegistryState {
  if (state.status === "ready") return { ...state, requestId, refreshing: true };
  return { status: "loading", requestId, projects: [] };
}

export type ListPublishOutcome =
  /** The response is current and no mutation intervened — it published. */
  | "published"
  /** A newer list request owns publication; this response is discarded. */
  | "stale-request"
  /** A mutation completed after this request began; the caller must discard
   *  the captured data and start one reconciliation list request. */
  | "superseded-by-mutation";

export interface ListPublishResult {
  outcome: ListPublishOutcome;
  state: ProjectRegistryState;
}

export function publishListSuccess(
  state: ProjectRegistryState,
  requestId: number,
  capturedMutationVersion: number,
  projects: readonly Project[],
): ListPublishResult {
  if (state.requestId !== requestId) return { outcome: "stale-request", state };
  if (mutationVersionOf(state) !== capturedMutationVersion) {
    return { outcome: "superseded-by-mutation", state };
  }
  return {
    outcome: "published",
    state: {
      status: "ready",
      requestId,
      projects: normalizeProjects(projects),
      mutationVersion: mutationVersionOf(state),
      refreshing: false,
      refreshError: null,
    },
  };
}

/** Initial failure has no data and becomes `failed`. A refresh failure after a
 *  ready snapshot keeps that snapshot usable and exposes a retryable error. */
export function publishListFailure(
  state: ProjectRegistryState,
  requestId: number,
  error: string,
): ProjectRegistryState {
  if (state.requestId !== requestId) return state;
  if (state.status === "ready") return { ...state, refreshing: false, refreshError: error };
  return { status: "failed", requestId, projects: [], error };
}

/** Add/Create/Rename success: upsert the exact server-returned project by id
 *  (a duplicate Add of the same canonical path reuses the returned existing
 *  project — never a second card) and increment mutationVersion so any list
 *  response captured before this mutation is discarded. An upsert always
 *  yields a ready registry: a confirmed project is project data. */
export function upsertProject(state: ProjectRegistryState, project: Project): ProjectRegistryState {
  const base: Project[] = state.status === "ready" ? state.projects : [];
  const i = base.findIndex((p) => p.id === project.id);
  const projects = i >= 0 ? base.map((p, j) => (j === i ? project : p)) : [...base, project];
  return {
    status: "ready",
    requestId: state.requestId,
    projects,
    mutationVersion: mutationVersionOf(state) + 1,
    refreshing: state.status === "ready" ? state.refreshing : false,
    refreshError: state.status === "ready" ? state.refreshError : null,
  };
}

/** Delete success: remove the confirmed id and count the mutation. */
export function removeProject(state: ProjectRegistryState, id: string): ProjectRegistryState {
  if (state.status !== "ready" || !state.projects.some((p) => p.id === id)) return state;
  return {
    ...state,
    projects: state.projects.filter((p) => p.id !== id),
    mutationVersion: state.mutationVersion + 1,
  };
}

// ---- active-project resolution ------------------------------------------------

export interface ActiveProjectCandidates {
  /** Project owning a valid session deep link (resolved by the caller). */
  sessionProjectId?: string | null;
  /** Project id from a /p/:projectId URL. */
  urlProjectId?: string | null;
  /** Persisted `polyth.activeProjectId`. */
  savedProjectId?: string | null;
}

/** Selection order: valid session deep link, valid project deep link, valid
 *  saved project id, then the first server project. Invalid candidates fall
 *  through — they never manufacture an empty first run. */
export function resolveActiveProjectId(
  projects: readonly Project[],
  candidates: ActiveProjectCandidates,
): string | null {
  for (const id of [candidates.sessionProjectId, candidates.urlProjectId, candidates.savedProjectId]) {
    if (id && projects.some((p) => p.id === id)) return id;
  }
  return projects[0]?.id ?? null;
}

/** After a delete or an external refresh: keep the current active project when
 *  it still exists, otherwise fall back to the first remaining project. */
export function replacementActiveId(
  projects: readonly Project[],
  currentActiveId: string | null,
): string | null {
  if (currentActiveId && projects.some((p) => p.id === currentActiveId)) return currentActiveId;
  return projects[0]?.id ?? null;
}

/** True only when the id names a project in a ready registry. */
export function hasValidActiveProject(
  state: ProjectRegistryState,
  activeProjectId: string | null,
): boolean {
  return (
    state.status === "ready"
    && activeProjectId !== null
    && state.projects.some((p) => p.id === activeProjectId)
  );
}

import type { SessionIsolation } from "./index.ts";

/** A repository registered under a logical Project. Paths are opaque projected
 * values; this module never probes the filesystem or infers availability. */
export interface ProjectRepository {
  id: string;
  alias: string;
  path: string;
}

/** The checkout a Session currently exposes for one Project repository. */
export interface WorkspaceRepository {
  repositoryId: string;
  alias: string;
  path: string;
  state: "ready" | "missing";
  branch?: string;
}

/** A durable session snapshot. An explicit list is a subset selection; an
 * omitted workspace means the Project's complete repository set. */
export interface SessionWorkspace {
  /** Absent on older snapshots; explicit snapshots default to subset. */
  mode?: "all" | "subset";
  /** Monotonic revision used to reject stale membership edits. */
  revision?: number;
  /** Stable scalar-runtime cwd anchor; independent of surface selection. */
  executionRepositoryId?: string;
  repositories: Array<{
    repositoryId: string;
    /** Retained display identity if a registration becomes unavailable. */
    alias?: string;
    path: string;
    state?: "ready" | "missing";
    branch?: string;
    /** Package-owned managed checkout evidence; never accepted from HTTP. */
    isolation?: SessionIsolation;
  }>;
}

/** Omitted repositoryIds selects all repositories at the time of mutation.
 * Paths and isolation evidence can only be supplied by the checkout owner. */
export interface SessionWorkspaceSelection {
  repositoryIds?: readonly string[];
  expectedRevision?: number;
  /** Explicitly adopt the current Project registration for selected existing
   * ordinary checkouts after Locate. Requires expectedRevision; never accepts paths. */
  relocateRepositoryIds?: readonly string[];
}

export interface WorkspaceContext {
  projectId: string;
  sessionId: string | null;
  repositories: readonly WorkspaceRepository[];
}

/** Structural input keeps this module independent of the aggregate contract
 * while remaining assignable from the public Project type. */
export interface ProjectWorkspaceSource {
  id: string;
  name: string;
  path: string;
  repositories?: readonly ProjectRepository[];
  primaryRepositoryId?: string;
  /** Original scalar cwd identity retained when defaults or registrations change. */
  legacyRepositoryId?: string;
}

type SessionWorkspaceSource = {
  id: string;
  projectId: string;
  worktreePath?: string;
  isolation?: { worktreePath?: string; state?: string };
  worktreeState?: "ready" | "bootstrapping" | "busy" | "missing";
  branch?: string;
  workspace?: SessionWorkspace | null;
};

function workspaceError(code: "invalid-input" | "not-found", message: string): Error {
  return Object.assign(new Error(message), { code });
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw workspaceError("invalid-input", `${label} must be non-empty`);
  }
  return value;
}

function projectPrimaryRepository(
  project: ProjectWorkspaceSource,
  repositories: readonly ProjectRepository[],
): ProjectRepository {
  if (project.primaryRepositoryId !== undefined) {
    const selected = repositories.find((repository) => repository.id === project.primaryRepositoryId);
    if (!selected) throw workspaceError("invalid-input", "primary repository is not part of the project");
    return selected;
  }
  const matchingRoot = repositories.filter((repository) => repository.path === project.path);
  if (matchingRoot.length === 1) return matchingRoot[0]!;
  if (repositories.length === 1) return repositories[0]!;
  throw workspaceError("invalid-input", "project has no unambiguous primary repository");
}

/** Return the Project repository set without touching the filesystem. Legacy
 * projects are represented by one stable synthetic `primary` repository. */
export function projectRepositories(project: ProjectWorkspaceSource): readonly ProjectRepository[] {
  const raw = project.repositories;
  if (raw === undefined) {
    return [{ id: "primary", alias: nonEmpty(project.name, "project name"), path: nonEmpty(project.path, "project path") }];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw workspaceError("invalid-input", "project repositories must be a non-empty list");
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  const repositories = raw.map((repository, index) => {
    if (!repository || typeof repository !== "object") {
      throw workspaceError("invalid-input", `project repository ${index} is invalid`);
    }
    const id = nonEmpty(repository.id, `project repository ${index} id`);
    const alias = nonEmpty(repository.alias, `project repository ${index} alias`);
    const path = nonEmpty(repository.path, `project repository ${index} path`);
    if (ids.has(id)) throw workspaceError("invalid-input", `duplicate project repository id: ${id}`);
    if (paths.has(path)) throw workspaceError("invalid-input", `duplicate project repository path: ${path}`);
    ids.add(id);
    paths.add(path);
    return { id, alias, path };
  });
  // Validate the declared primary even when callers only request the project
  // list; a later runtime lookup must not discover this contradiction.
  if (project.primaryRepositoryId !== undefined) projectPrimaryRepository(project, repositories);
  return repositories;
}

function workspaceRows(
  project: ProjectWorkspaceSource,
  repositories: readonly ProjectRepository[],
  session: SessionWorkspaceSource,
): WorkspaceRepository[] {
  if (session.workspace === undefined || session.workspace === null) {
    const legacyCheckout = session.worktreePath !== undefined || session.isolation !== undefined;
    const legacyCheckoutPath = session.worktreePath ?? session.isolation?.worktreePath;
    if (legacyCheckout && legacyCheckoutPath === undefined) {
      throw workspaceError("invalid-input", "legacy isolated session has no checkout path");
    }
    const legacy = project.legacyRepositoryId
      ? repositories.find((row) => row.id === project.legacyRepositoryId)
        ?? { id: project.legacyRepositoryId, alias: project.name, path: project.path }
      : projectPrimaryRepository(project, repositories);
    const relocatedLegacyRoot = !legacyCheckout && project.legacyRepositoryId !== undefined && legacy.path !== project.path;
    const primary = legacyCheckout || session.worktreeState === "missing" || relocatedLegacyRoot ? legacy : undefined;
    const primaryState = session.worktreeState === "missing" || relocatedLegacyRoot ? "missing" : "ready";
    const rows = repositories.map((repository): WorkspaceRepository => ({
      repositoryId: repository.id,
      alias: repository.alias,
      path: primary?.id === repository.id
        ? (legacyCheckoutPath === undefined ? (relocatedLegacyRoot ? project.path : repository.path) : nonEmpty(legacyCheckoutPath, "session worktree path"))
        : repository.path,
      state: primary?.id === repository.id ? primaryState : "ready",
      ...(primary?.id === repository.id && session.branch !== undefined ? { branch: session.branch } : {}),
    }));
    if (project.legacyRepositoryId && !repositories.some((row) => row.id === project.legacyRepositoryId)) {
      rows.push({ repositoryId: project.legacyRepositoryId, alias: project.name, path: legacyCheckoutPath ?? project.path, state: "missing" });
    }
    return legacyCheckout ? rows.filter((row) => row.repositoryId === primary?.id) : rows;
  }

  if (!Array.isArray(session.workspace.repositories)) {
    throw workspaceError("invalid-input", "session workspace repositories must be a list");
  }
  const byId = new Map(repositories.map((repository) => [repository.id, repository]));
  const selected = new Set<string>();
  const paths = new Set<string>();
  const rows = session.workspace.repositories.map((snapshot, index): WorkspaceRepository => {
    if (!snapshot || typeof snapshot !== "object") {
      throw workspaceError("invalid-input", `session workspace repository ${index} is invalid`);
    }
    const repositoryId = nonEmpty(snapshot.repositoryId, `session workspace repository ${index} id`);
    const repository = byId.get(repositoryId);
    // A durable snapshot retains removed registrations as unavailable. Its
    // old path remains display evidence, never a usable authority.
    if (!repository && !snapshot.alias) throw workspaceError("not-found", `session workspace repository is not part of the project: ${repositoryId}`);
    if (selected.has(repositoryId)) throw workspaceError("invalid-input", `duplicate session workspace repository: ${repositoryId}`);
    const path = nonEmpty(snapshot.path, `session workspace repository ${index} path`);
    if (paths.has(path)) throw workspaceError("invalid-input", `ambiguous session workspace path: ${path}`);
    selected.add(repositoryId);
    paths.add(path);
    if (snapshot.state !== undefined && snapshot.state !== "ready" && snapshot.state !== "missing") {
      throw workspaceError("invalid-input", `invalid session workspace repository state: ${snapshot.state}`);
    }
    return {
      repositoryId,
      alias: repository?.alias ?? nonEmpty(snapshot.alias, "snapshot repository alias"),
      path,
      state: repository ? snapshot.state ?? "ready" : "missing",
      ...(snapshot.branch === undefined ? {} : { branch: snapshot.branch }),
    };
  });

  if (session.worktreePath !== undefined) {
    const anchorId = session.workspace.executionRepositoryId ?? projectPrimaryRepository(project, repositories).id;
    const primaryRow = rows.find((row) => row.repositoryId === anchorId);
    if (!primaryRow || primaryRow.path !== nonEmpty(session.worktreePath, "session worktree path")) {
      throw workspaceError("invalid-input", "legacy session worktree conflicts with its workspace snapshot");
    }
  }
  return rows;
}

/** Resolve a Project and optional canonical Session into one workspace context.
 * A foreign Session is rejected before any repository lookup. */
export function resolveWorkspaceContext(
  project: ProjectWorkspaceSource,
  session?: SessionWorkspaceSource | null,
): WorkspaceContext {
  const repositories = projectRepositories(project);
  if (session && session.projectId !== project.id) {
    throw workspaceError("not-found", "session does not belong to this project");
  }
  return {
    projectId: project.id,
    sessionId: session?.id ?? null,
    repositories: session ? workspaceRows(project, repositories, session) : repositories.map((repository) => ({
      repositoryId: repository.id,
      alias: repository.alias,
      path: repository.path,
      state: "ready" as const,
    })),
  };
}

/** Find a repository in an already validated context. Unknown ids never fall
 * back to the primary repository. */
export function workspaceRepository(
  context: WorkspaceContext,
  repositoryId: string,
): WorkspaceRepository {
  const repository = context.repositories.find((candidate) => candidate.repositoryId === repositoryId);
  if (!repository) throw workspaceError("not-found", `repository is not part of this workspace: ${repositoryId}`);
  return repository;
}

/** Scalar runtime compatibility chooses once from canonical membership, never
 * from a surface's selection. An unavailable anchor must not silently change. */
export function workspaceExecutionPath(
  project: ProjectWorkspaceSource,
  session?: SessionWorkspaceSource | null,
): string {
  const context = resolveWorkspaceContext(project, session);
  const declared = session?.workspace?.executionRepositoryId
    ?? (session && !session.workspace ? project.legacyRepositoryId : undefined);
  const primary = projectPrimaryRepository(project, projectRepositories(project));
  const selected = declared
    ? workspaceRepository(context, declared)
    : context.repositories.find((repository) => repository.repositoryId === primary.id)
      ?? context.repositories[0];
  if (!selected) throw workspaceError("invalid-input", "session workspace has no repositories");
  if (selected.state !== "ready") throw workspaceError("not-found", "session execution checkout is missing");
  return selected.path;
}

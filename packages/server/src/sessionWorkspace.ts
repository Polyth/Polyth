import type {
  ProjectService,
  SessionProjection,
  SessionWorkspace,
  SessionWorkspaceSelection,
} from "@polyth/contracts";
import {
  projectRepositories,
  resolveWorkspaceContext,
  workspaceExecutionPath,
} from "@polyth/contracts/workspace";

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });
const notFound = (message: string): Error => Object.assign(new Error(message), { code: "not-found" });
const conflict = (message: string): Error => Object.assign(new Error(message), { code: "conflict" });

export interface SessionWorkspaceOwner {
  projects: ProjectService;
  worktrees?: { list(root: string): Promise<Array<{ path: string; branch: string | null }>> };
}

export function primaryRepositoryId(project: Parameters<typeof projectRepositories>[0]): string {
  const repositories = projectRepositories(project);
  if (project.primaryRepositoryId !== undefined) return project.primaryRepositoryId;
  return repositories.find((repository) => repository.path === project.path)?.id
    ?? (repositories.length === 1 ? repositories[0]!.id : (() => {
      throw invalid("project has no unambiguous primary repository");
    })());
}

function selectedIds(
  project: Parameters<typeof projectRepositories>[0],
  repositoryIds: readonly string[] | undefined,
  isolated: boolean,
): { ids: string[]; explicit: boolean } {
  const repositories = projectRepositories(project);
  const byId = new Map(repositories.map((repository) => [repository.id, repository]));
  const primary = primaryRepositoryId(project);
  if (isolated) {
    if (repositoryIds?.some((id) => id !== primary)) {
      throw conflict("isolated sessions currently support only the primary repository");
    }
    return { ids: [primary], explicit: repositoryIds !== undefined };
  }
  const ids = repositoryIds === undefined ? repositories.map((repository) => repository.id) : [...repositoryIds];
  if (ids.length === 0) throw invalid("repositoryIds must select at least one repository");
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !id.trim()) throw invalid("repositoryIds must contain non-empty ids");
    if (seen.has(id)) throw invalid(`duplicate repository id: ${id}`);
    if (!byId.has(id)) throw notFound(`repository is not part of this project: ${id}`);
    seen.add(id);
  }
  return { ids, explicit: repositoryIds !== undefined };
}

/** Build the durable membership manifest for a newly-created session. */
export function createSessionWorkspace(
  project: Parameters<typeof projectRepositories>[0],
  input: {
    repositoryIds?: readonly string[];
    workspace?: SessionWorkspace;
    worktreePath?: string;
    isolated?: boolean;
  },
): SessionWorkspace {
  const primary = primaryRepositoryId(project);
  // Legacy scalar isolated sessions have one primary checkout. A trusted
  // workspace snapshot from the checkout owner already carries the complete
  // multi-repository allocation and must not be narrowed back to primary.
  const selected = selectedIds(project, input.repositoryIds, input.isolated === true && input.workspace === undefined);
  if (input.worktreePath !== undefined && !input.workspace && !selected.ids.includes(primary)) {
    throw invalid("worktreePath requires the project primary repository to be selected");
  }
  if (input.workspace) {
    const workspace = cloneWorkspace(input.workspace);
    validateWorkspaceAgainstProject(project, workspace);
    const ids = new Set(selected.ids);
    if (workspace.repositories.some((row) => !ids.has(row.repositoryId))) {
      throw invalid("trusted workspace contains a repository outside the requested membership");
    }
    if (workspace.repositories.length === 0) throw invalid("workspace must contain at least one repository");
    const executionRepositoryId = workspace.executionRepositoryId
      ?? (ids.has(primary) ? primary : workspace.repositories[0]!.repositoryId);
    if (!workspace.repositories.some((row) => row.repositoryId === executionRepositoryId)) {
      throw invalid("workspace execution repository is not a member");
    }
    return {
      ...workspace,
      mode: selected.explicit ? "subset" : workspace.mode ?? (input.isolated ? "subset" : "all"),
      revision: workspace.revision ?? 1,
      executionRepositoryId,
    };
  }
  const repositories = projectRepositories(project);
  const rows = repositories
    .filter((repository) => selected.ids.includes(repository.id))
    .map((repository) => ({
      repositoryId: repository.id,
      alias: repository.alias,
      path: input.worktreePath && repository.id === primary ? input.worktreePath : repository.path,
      state: "ready" as const,
    }));
  return {
    mode: selected.explicit ? "subset" : "all",
    revision: 1,
    executionRepositoryId: selected.ids.includes(primary) ? primary : selected.ids[0]!,
    repositories: rows,
  };
}

export function cloneWorkspace(workspace: SessionWorkspace): SessionWorkspace {
  return {
    ...(workspace.mode ? { mode: workspace.mode } : {}),
    ...(workspace.revision === undefined ? {} : { revision: workspace.revision }),
    ...(workspace.executionRepositoryId ? { executionRepositoryId: workspace.executionRepositoryId } : {}),
    repositories: workspace.repositories.map((row) => ({
      repositoryId: row.repositoryId,
      ...(row.alias ? { alias: row.alias } : {}),
      path: row.path,
      ...(row.state ? { state: row.state } : {}),
      ...(row.branch ? { branch: row.branch } : {}),
      ...(row.isolation
        ? { isolation: JSON.parse(JSON.stringify(row.isolation)) as NonNullable<typeof row.isolation> }
        : {}),
    })),
  };
}

/** Clone a workspace for a child/subagent session. Preserves repository checkouts and branches
 * without copying isolation ownership, so the child shares the workspace without owning its lifecycle. */
export function cloneWorkspaceForChild(workspace: SessionWorkspace): SessionWorkspace {
  return {
    ...(workspace.mode ? { mode: workspace.mode } : {}),
    ...(workspace.revision === undefined ? {} : { revision: workspace.revision }),
    ...(workspace.executionRepositoryId ? { executionRepositoryId: workspace.executionRepositoryId } : {}),
    repositories: workspace.repositories.map((row) => ({
      repositoryId: row.repositoryId,
      ...(row.alias ? { alias: row.alias } : {}),
      path: row.path,
      ...(row.state ? { state: row.state } : {}),
      ...(row.branch ? { branch: row.branch } : {}),
    })),
  };
}


export function validateWorkspaceAgainstProject(
  project: Parameters<typeof projectRepositories>[0],
  workspace: SessionWorkspace,
): void {
  if (!workspace || !Array.isArray(workspace.repositories) || workspace.repositories.length === 0) {
    throw invalid("workspace must contain at least one repository");
  }
  const registered = new Map(projectRepositories(project).map((repository) => [repository.id, repository]));
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const row of workspace.repositories) {
    if (!row || typeof row.repositoryId !== "string" || !row.repositoryId) throw invalid("workspace repository id is required");
    const projectRepository = registered.get(row.repositoryId);
    if (!projectRepository) throw notFound(`repository is not part of this project: ${row.repositoryId}`);
    if (ids.has(row.repositoryId)) throw invalid(`duplicate workspace repository: ${row.repositoryId}`);
    if (typeof row.path !== "string" || !row.path) throw invalid("workspace repository path is required");
    if (paths.has(row.path)) throw invalid(`ambiguous workspace repository path: ${row.path}`);
    if (row.state !== undefined && row.state !== "ready" && row.state !== "missing") throw invalid("invalid workspace repository state");
    if (row.alias !== undefined && (!row.alias || typeof row.alias !== "string")) throw invalid("invalid workspace repository alias");
    ids.add(row.repositoryId);
    paths.add(row.path);
    if (projectRepository.path === row.path) continue;
    // A non-project-root path is accepted only for an explicitly managed
    // checkout supplied by the checkout owner. The caller performs inventory
    // validation through validateWorkspacePaths before persistence.
  }
  if (workspace.executionRepositoryId !== undefined && !ids.has(workspace.executionRepositoryId)) {
    throw invalid("workspace execution repository is not a member");
  }
}

/** Validate trusted checkout-owner paths against the project and worktree inventory. */
export async function validateWorkspacePaths(
  owner: SessionWorkspaceOwner,
  project: Parameters<typeof projectRepositories>[0],
  workspace: SessionWorkspace,
): Promise<void> {
  validateWorkspaceAgainstProject(project, workspace);
  const repositoryIdsByPath = new Map<string, Set<string>>();
  for (const repository of projectRepositories(project)) {
    repositoryIdsByPath.set(repository.path, new Set([repository.id]));
  }
  if (owner.worktrees) {
    // A multi-repository Project has one Git inventory per registered root.
    // Build the trusted checkout set from every inventory rather than using
    // the legacy project root as a proxy for secondary repositories.
    for (const repository of projectRepositories(project)) {
      if (!workspace.repositories.some((row) => row.repositoryId === repository.id && row.state !== "missing" && row.path !== repository.path)) continue;
      for (const row of await owner.worktrees.list(repository.path)) {
        const ids = repositoryIdsByPath.get(row.path) ?? new Set<string>();
        ids.add(repository.id);
        repositoryIdsByPath.set(row.path, ids);
      }
    }
  }
  for (const row of workspace.repositories) {
    if (row.state === "missing") continue;
    if (row.isolation?.kind === "git-worktree") {
      const reboundForCleanup = (row.isolation.state === "rebind-pending" || row.isolation.state === "cleanup-pending")
        && (row.path === row.isolation.targetPath || row.path === row.isolation.originPath);
      if (row.isolation.worktreePath !== row.path && !reboundForCleanup) {
        throw invalid(`workspace isolation checkout does not match repository path: ${row.repositoryId}`);
      }
      // The isolation evidence identifies the intended checkout, while the
      // per-repository inventory proves that checkout still belongs to the
      // corresponding repository. This prevents a row from borrowing a
      // different repository's worktree path.
    }
    if (!repositoryIdsByPath.get(row.path)?.has(row.repositoryId)) {
      throw notFound(`workspace checkout is not registered: ${row.path}`);
    }
  }
}

export function workspaceSelection(
  project: Parameters<typeof projectRepositories>[0],
  current: SessionProjection,
  selection: SessionWorkspaceSelection,
  options: { allowMissingExecutionAnchor?: boolean } = {},
): SessionWorkspace {
  const currentWorkspace = current.workspace;
  const currentContext = resolveWorkspaceContext(project, current);
  const currentIds = currentContext.repositories.map((repository) => repository.repositoryId);
  const requested = selection.repositoryIds === undefined ? undefined : [...selection.repositoryIds];
  // A legacy isolated projection without a durable workspace is inherently
  // primary-only. Once the checkout owner has supplied a trusted workspace
  // snapshot, its per-repository rows are authoritative and membership edits
  // may select all or a subset of those repositories.
  const isolated = Boolean((current.isolation || current.worktreePath) && !currentWorkspace);
  const selected = selectedIds(project, requested, isolated);
  const currentRevision = currentWorkspace?.revision ?? 0;
  if (selection.expectedRevision !== undefined && selection.expectedRevision !== currentRevision) {
    throw conflict(`workspace revision is stale; expected ${selection.expectedRevision}, current ${currentRevision}`);
  }
  const currentById = new Map(currentContext.repositories.map((repository) => [repository.repositoryId, repository]));
  const snapshotsById = new Map(currentWorkspace ? cloneWorkspace(currentWorkspace).repositories.map((row) => [row.repositoryId, row]) : []);
  const projectById = new Map(projectRepositories(project).map((repository) => [repository.id, repository]));
  const relocateIds = selection.relocateRepositoryIds;
  if (relocateIds !== undefined) {
    if (!Array.isArray(relocateIds) || relocateIds.length === 0 || relocateIds.length > 128
      || new Set(relocateIds).size !== relocateIds.length
      || relocateIds.some((id) => typeof id !== "string" || !selected.ids.includes(id) || !currentById.has(id))) {
      throw invalid("relocateRepositoryIds must identify selected existing workspace repositories");
    }
    if (selection.expectedRevision === undefined) throw invalid("relocation requires expectedRevision");
    if (current.isolation || (!currentWorkspace && current.worktreePath) || currentWorkspace?.repositories.some((row) => row.isolation)) {
      throw conflict("managed checkouts must be recovered through their isolation lifecycle");
    }
  }
  const relocated = new Set(relocateIds);
  const rows = selected.ids.map((id) => {
    const existing = currentById.get(id);
    const registered = projectById.get(id)!;
    if (relocated.has(id)) return { repositoryId: id, alias: registered.alias, path: registered.path, state: "ready" as const };
    return existing
      ? { ...snapshotsById.get(id), repositoryId: id, alias: existing.alias, path: existing.path, state: existing.state, ...(existing.branch ? { branch: existing.branch } : {}) }
      : { repositoryId: id, alias: registered.alias, path: registered.path, state: "ready" as const };
  });
  const anchor = currentWorkspace?.executionRepositoryId
    ?? (currentIds.includes(primaryRepositoryId(project)) ? primaryRepositoryId(project) : currentIds[0]);
  const anchorMissing = anchor !== undefined
    && currentContext.repositories.find((repository) => repository.repositoryId === anchor)?.state === "missing";
  if ((!anchor || !selected.ids.includes(anchor)) && !(options.allowMissingExecutionAnchor && anchorMissing)) {
    throw conflict("cannot remove the current execution repository; rebind it first");
  }
  const executionRepositoryId = selected.ids.includes(anchor ?? "")
    ? anchor
    : selected.ids.includes(primaryRepositoryId(project))
      ? primaryRepositoryId(project)
      : selected.ids[0];
  const workspace: SessionWorkspace = {
    mode: selected.explicit ? "subset" : "all",
    revision: currentRevision + 1,
    executionRepositoryId,
    repositories: rows,
  };
  validateWorkspaceAgainstProject(project, workspace);
  // This is intentionally evaluated before persistence: a missing execution
  // checkout must remain visible as missing and must never fall back silently.
  workspaceExecutionPath(project, {
    ...current,
    workspace,
    // Rebind commits this scalar path together with the selected snapshot.
    // Validate that future pair, after validating the current pair above.
    worktreePath: rows.find((row) => row.repositoryId === executionRepositoryId)?.path,
  });
  return workspace;
}

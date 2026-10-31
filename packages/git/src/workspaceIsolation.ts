import type {
  Project,
  ProjectRepository,
  SessionIsolation,
  SessionProjection,
  SessionWorkspace,
} from "@polyth/contracts";
import { projectRepositories } from "@polyth/contracts/workspace";

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });
const notFound = (message: string): Error => Object.assign(new Error(message), { code: "not-found" });

export interface IsolationRepositoryProject extends Pick<Project, "id" | "path" | "primaryRepositoryId" | "remote"> {
  repositories?: ProjectRepository[];
}

export interface SelectedIsolationRepository extends ProjectRepository {
  primary: boolean;
}

/** Select the immutable Project inventory for an isolation admission. Omitted
 * membership means every registered repository; an explicit list is a strict
 * subset and never silently falls back to the primary. */
export function selectIsolationRepositories(
  project: IsolationRepositoryProject,
  repositoryIds?: readonly string[],
): { repositories: SelectedIsolationRepository[]; explicit: boolean; executionRepositoryId: string } {
  const registered = projectRepositories({ ...project, name: project.id });
  const byId = new Map(registered.map((repository) => [repository.id, repository]));
  const primary = project.primaryRepositoryId
    ?? registered.find((repository) => repository.path === project.path)?.id
    ?? (registered.length === 1 ? registered[0]!.id : undefined);
  if (!primary) throw invalid("project has no unambiguous primary repository");
  const ids = repositoryIds === undefined ? registered.map((repository) => repository.id) : [...repositoryIds];
  if (ids.length === 0) throw invalid("repositoryIds must select at least one repository");
  const seen = new Set<string>();
  const repositories = ids.map((id) => {
    if (typeof id !== "string" || !id.trim()) throw invalid("repositoryIds must contain non-empty ids");
    if (seen.has(id)) throw invalid(`duplicate repository id: ${id}`);
    seen.add(id);
    const repository = byId.get(id);
    if (!repository) throw notFound(`repository is not part of this project: ${id}`);
    return { ...repository, primary: repository.id === primary };
  });
  const execution = repositories.find((repository) => repository.primary) ?? repositories[0]!;
  return { repositories, explicit: repositoryIds !== undefined, executionRepositoryId: execution.id };
}

export interface IsolationAllocation {
  repositoryId: string;
  alias: string;
  path: string;
  branch: string;
  isolation: SessionIsolation;
}

/** Build the durable workspace snapshot after every selected checkout has been
 * allocated and ownership has been proven. */
export function workspaceForIsolationAllocations(
  selected: ReturnType<typeof selectIsolationRepositories>,
  allocations: readonly IsolationAllocation[],
): SessionWorkspace {
  const allocated = new Set(allocations.map((allocation) => allocation.repositoryId));
  if (allocated.size !== selected.repositories.length) {
    throw invalid("isolated workspace allocation is incomplete");
  }
  const rows = selected.repositories.map((repository) => {
    const allocation = allocations.find((candidate) => candidate.repositoryId === repository.id);
    if (!allocation) throw invalid(`isolated workspace allocation is missing: ${repository.id}`);
    return {
      repositoryId: repository.id,
      alias: repository.alias,
      path: allocation.path,
      state: "ready" as const,
      branch: allocation.branch,
      isolation: allocation.isolation,
    };
  });
  return {
    mode: selected.explicit ? "subset" : "all",
    revision: 1,
    executionRepositoryId: selected.executionRepositoryId,
    repositories: rows,
  };
}

/** Return every owned checkout recorded in the canonical workspace. Legacy
 * sessions expose their scalar isolation record as one synthetic row. */
export function isolationWorkspaceRows(session: SessionProjection): Array<{
  repositoryId: string;
  path: string;
  isolation: SessionIsolation;
}> {
  const rows = session.workspace?.repositories
    ?.filter((row): row is typeof row & { isolation: SessionIsolation } => !!row.isolation)
    .map((row) => ({ repositoryId: row.repositoryId, path: row.path, isolation: row.isolation })) ?? [];
  if (rows.length > 0) return rows;
  if (!session.isolation) return [];
  return [{
    repositoryId: session.workspace?.executionRepositoryId ?? "primary",
    path: session.isolation.worktreePath,
    isolation: session.isolation,
  }];
}

export function workspaceRowForIsolation(
  session: SessionProjection,
  repositoryId: string,
): { repositoryId: string; path: string; isolation: SessionIsolation } | undefined {
  return isolationWorkspaceRows(session).find((row) => row.repositoryId === repositoryId);
}

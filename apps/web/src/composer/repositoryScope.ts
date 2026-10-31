// New-session repository scope for multi-repository projects. The choice is a
// draft preference (`newSessionIntent.repositoryIds`, omitted = every
// repository) that is sent once with session creation. The worktree picker
// only ever targets the execution repository — the primary when it is in
// scope — because linked-worktree management is primary-only on the server
// and a scalar isolation base branch belongs to the execution repository.

export interface ScopeRepository {
  id: string;
  alias: string;
  path: string;
}

/** Row id the picker uses for "All repositories". Never a repository id. */
export const ALL_REPOSITORIES = "*all";

/** The primary repository, resolved the way the server resolves it. */
export function primaryRepositoryIdOf(
  project: { path: string; primaryRepositoryId?: string } | null | undefined,
  repositories: readonly ScopeRepository[],
): string | undefined {
  if (!project) return undefined;
  if (project.primaryRepositoryId && repositories.some((row) => row.id === project.primaryRepositoryId)) {
    return project.primaryRepositoryId;
  }
  return repositories.find((row) => row.path === project.path)?.id
    ?? (repositories.length === 1 ? repositories[0]!.id : undefined);
}

/** Selected ids in project order. Unknown ids (a removed registration) drop
 *  out; an empty or complete result means every repository. */
export function normalizeRepositoryScope(
  repositories: readonly ScopeRepository[],
  selected: readonly string[] | undefined,
): string[] | undefined {
  if (selected === undefined) return undefined;
  const wanted = new Set(selected);
  const ids = repositories.filter((row) => wanted.has(row.id)).map((row) => row.id);
  return ids.length === 0 || ids.length === repositories.length ? undefined : ids;
}

/** Apply one picker row toggle. A scope always keeps at least one repository. */
export function toggleRepositoryScope(
  repositories: readonly ScopeRepository[],
  selected: readonly string[] | undefined,
  id: string,
): string[] | undefined {
  if (id === ALL_REPOSITORIES) return undefined;
  if (!repositories.some((row) => row.id === id)) return normalizeRepositoryScope(repositories, selected);
  const current = normalizeRepositoryScope(repositories, selected) ?? repositories.map((row) => row.id);
  if (current.includes(id)) {
    if (current.length === 1) return current;
    return normalizeRepositoryScope(repositories, current.filter((value) => value !== id));
  }
  return normalizeRepositoryScope(repositories, [...current, id]);
}

/** The repository the agent runtime starts in and the worktree picker targets. */
export function executionRepositoryOf(
  repositories: readonly ScopeRepository[],
  selected: readonly string[] | undefined,
  primaryId: string | undefined,
): ScopeRepository | undefined {
  const ids = normalizeRepositoryScope(repositories, selected);
  const inScope = ids ? repositories.filter((row) => ids.includes(row.id)) : repositories;
  return inScope.find((row) => row.id === primaryId) ?? inScope[0];
}

/** The picker's checked rows: "All" checks itself and every repository. */
export function repositoryScopeValues(
  repositories: readonly ScopeRepository[],
  selected: readonly string[] | undefined,
): string[] {
  const ids = normalizeRepositoryScope(repositories, selected);
  return ids ?? [ALL_REPOSITORIES, ...repositories.map((row) => row.id)];
}

/** Aliases for a subset chip: "api + web", "api, web +2". */
export function repositoryScopeAliases(
  repositories: readonly ScopeRepository[],
  selected: readonly string[],
): string {
  const aliases = repositories.filter((row) => selected.includes(row.id)).map((row) => row.alias);
  if (aliases.length <= 2) return aliases.join(" + ");
  return `${aliases.slice(0, 2).join(", ")} +${aliases.length - 2}`;
}

/** A short, path-like detail that stays legible in a narrow picker row. */
export function repositoryPathTail(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

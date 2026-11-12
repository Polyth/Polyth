// Repository chips of a multi-repository Project's session list (desktop
// sidebar and phone navigator). A chip narrows the list to the sessions whose
// explicit repository subset includes that repository; whole-project sessions
// show only under All. The choice is a device preference (sidebarPrefs.ts),
// the matching rule is the shared contracts helper, and the server applies the
// same rule to `SessionSummaryQuery.repositoryId` so paging stays honest.
import { useEffect } from "react";
import type { Project, SessionProjection } from "@polyth/contracts";
import { sessionInRepositoryScope, sessionRepositoryScope } from "@polyth/contracts/workspace";
import { primaryRepositoryIdOf } from "./composer/repositoryScope.ts";
import { getRepositoryFilter, setRepositoryFilter, useStoredRepositoryFilter, useStoredRepositoryFilters } from "./sidebarPrefs.ts";
import { useStore, type NewChatRepositoryFilter } from "./store.ts";

/** One chip: a registered repository with its colour slot. */
export interface FilterRepository {
  id: string;
  alias: string;
  /** The registered checkout path, for the chip's tooltip. */
  path: string;
  /** `data-repository-tone` (styles.css): one of the eight signal-derived
   *  categorical tones people's colours use. */
  tone: number;
}

/** Repository order → tone. The first four stay far apart on the wheel (blue,
 *  amber, purple, green); red, which reads as an error, comes last. */
const REPOSITORY_TONES = [5, 2, 6, 3, 4, 7, 1, 0] as const;

type ProjectRepositories = Pick<Project, "path" | "repositories" | "primaryRepositoryId" | "parentProjectId">;

/** The chips of a project in project order with the primary first, or none
 *  for a project with fewer than two repositories. A private room
 *  (`parentProjectId`) keeps its short list without chips. */
export function filterRepositoriesOf(project: ProjectRepositories | null | undefined): FilterRepository[] {
  const rows = project?.repositories ?? [];
  if (rows.length < 2 || project?.parentProjectId) return [];
  const primaryId = primaryRepositoryIdOf(project, rows);
  const primary = rows.find((row) => row.id === primaryId);
  const ordered = primary ? [primary, ...rows.filter((row) => row !== primary)] : [...rows];
  return ordered.map((row, index) => ({
    id: row.id,
    alias: row.alias,
    path: row.path,
    tone: REPOSITORY_TONES[index % REPOSITORY_TONES.length]!,
  }));
}

/** The stored chip while it still names one of the project's repositories. */
export function activeRepositoryFilter(
  project: ProjectRepositories | null | undefined,
  stored: string | undefined,
): string | undefined {
  return stored !== undefined && filterRepositoriesOf(project).some((row) => row.id === stored) ? stored : undefined;
}

/** The project's active chip. A chip whose repository is no longer registered
 *  (or a project that is down to one repository) goes back to All, and the
 *  stale entry is cleared once the project registry is known. */
export function useRepositoryFilter(projectId: string, project: ProjectRepositories | null | undefined): string | undefined {
  const stored = useStoredRepositoryFilter(projectId);
  const ready = useStore((state) => state.projectRegistry.status === "ready");
  const active = activeRepositoryFilter(project, stored);
  const stale = ready && !!project && stored !== undefined && active === undefined;
  useEffect(() => {
    if (stale) setRepositoryFilter(projectId, undefined);
  }, [stale, projectId]);
  return active;
}

/** The active chip of every listed project (the phone navigator draws them
 *  all in one list); stale entries are cleared as `useRepositoryFilter` does. */
export function useRepositoryFilters(
  projects: readonly (ProjectRepositories & { id: string })[],
): ReadonlyMap<string, string> {
  const stored = useStoredRepositoryFilters();
  const ready = useStore((state) => state.projectRegistry.status === "ready");
  const active = new Map<string, string>();
  const stale: string[] = [];
  for (const project of projects) {
    const choice = activeRepositoryFilter(project, stored[project.id]);
    if (choice) active.set(project.id, choice);
    else if (ready && stored[project.id] !== undefined) stale.push(project.id);
  }
  const staleKey = stale.join("\u0000");
  useEffect(() => {
    if (!staleKey) return;
    for (const projectId of staleKey.split("\u0000")) setRepositoryFilter(projectId, undefined);
  }, [staleKey]);
  return active;
}

/** Whether a listed session belongs under `repositoryId`. A delegated child
 *  follows its top listed ancestor, so a nested tree is kept or hidden whole;
 *  a child whose parent is not loaded answers for itself until it is. */
export function sessionMatchesRepositoryFilter(
  session: SessionProjection,
  repositoryId: string,
  projectRepositoryIds: readonly string[],
  byId: ReadonlyMap<string, SessionProjection>,
): boolean {
  let root = session;
  const seen = new Set([session.id]);
  while (root.parentId) {
    const parent = byId.get(root.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    root = parent;
  }
  return sessionInRepositoryScope(root, repositoryId, projectRepositoryIds);
}

/** The registered repositories a row's mark shows, in chip order; undefined
 *  for a whole-project session (no mark). */
export function sessionRepositoryMark(
  session: SessionProjection,
  repositories: readonly FilterRepository[],
): FilterRepository[] | undefined {
  if (repositories.length < 2) return undefined;
  const scope = sessionRepositoryScope(session, repositories.map((row) => row.id));
  if (!scope) return undefined;
  const marked = repositories.filter((row) => scope.repositoryIds.includes(row.id));
  return marked.length > 0 ? marked : undefined;
}

/** What a row's mark draws of its scope. Under All, every repository. Under a
 *  chip the list already says which repository it is, so a scope of that
 *  repository alone draws nothing and a wider one draws only the others,
 *  after a plus ("+ • api"). The accessible name keeps the full scope. */
export function repositoryMarkParts(
  repositories: readonly FilterRepository[],
  active: string | undefined,
): { shown: FilterRepository[]; plus: boolean } {
  if (active === undefined) return { shown: [...repositories], plus: false };
  const others = repositories.filter((repository) => repository.id !== active);
  return { shown: others, plus: others.length > 0 && others.length < repositories.length };
}

/** What a project's New chat starts under: the active chip, or All. Undefined
 *  for a project without chips, which keeps New chat exactly as it was. */
export function newChatRepositoryFilter(project: (ProjectRepositories & { id: string }) | null | undefined): NewChatRepositoryFilter | undefined {
  if (!project || filterRepositoriesOf(project).length === 0) return undefined;
  const active = activeRepositoryFilter(project, getRepositoryFilter(project.id));
  return { ids: active ? [active] : undefined };
}

/** `startFreshSession` options for a project's New chat. */
export function newChatOptions(project: (ProjectRepositories & { id: string }) | null | undefined): { repositoryFilter?: NewChatRepositoryFilter } {
  const repositoryFilter = newChatRepositoryFilter(project);
  return repositoryFilter ? { repositoryFilter } : {};
}

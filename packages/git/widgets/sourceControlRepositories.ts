import {
  resolveWorkspaceContext,
  type ProjectWorkspaceSource,
  type WorkspaceRepository,
} from "@polyth/contracts/workspace";

type SessionWorkspaceSource = NonNullable<Parameters<typeof resolveWorkspaceContext>[1]>;

/** A repository Source control can show. `outsideSession` marks a project
 * repository the open chat did not select: it is read and changed through the
 * project's own checkout, never through the chat's workspace. */
export type SourceControlRepository = WorkspaceRepository & { outsideSession?: true };

/**
 * Every repository of a multi-repository project, the chat's own first.
 *
 * A chat's workspace is a snapshot of the repositories it chose, but Source
 * control is the project's view: the rest stay reachable too. `null` means the
 * chat's workspace could not be resolved (it then fails closed, as before).
 */
export function sourceControlRepositories(
  project: ProjectWorkspaceSource,
  session: SessionWorkspaceSource | null,
): SourceControlRepository[] | null {
  let rows: readonly WorkspaceRepository[];
  try { rows = resolveWorkspaceContext(project, session).repositories; } catch { return null; }
  if (!session || !project.repositories || project.repositories.length < 2) return [...rows];
  const inSession = new Set(rows.map((row) => row.repositoryId));
  const outside = resolveWorkspaceContext(project, null).repositories
    .filter((row) => !inSession.has(row.repositoryId))
    .map((row): SourceControlRepository => ({ ...row, outsideSession: true }));
  return [...rows, ...outside];
}

/** The repository Source control opens on without a stored choice: one of the
 * chat's own, never one outside it while it has any. The primary wins when the
 * chat has it, then the chat's execution repository. */
export function defaultSourceControlRepository(
  rows: readonly SourceControlRepository[],
  primaryRepositoryId: string | null | undefined,
  executionRepositoryId: string | null | undefined,
): string | undefined {
  const own = rows.filter((row) => !row.outsideSession);
  const ownHas = (id: string | null | undefined): id is string => !!id && own.some((row) => row.repositoryId === id);
  if (ownHas(primaryRepositoryId)) return primaryRepositoryId;
  if (ownHas(executionRepositoryId)) return executionRepositoryId;
  return own[0]?.repositoryId ?? primaryRepositoryId ?? rows[0]?.repositoryId;
}

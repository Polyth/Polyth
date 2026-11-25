import type { ResourceRef } from "@polyth/web-sdk";
import { projectRepositories, resolveWorkspaceContext } from "@polyth/contracts/workspace";
import { api } from "@polyth/session/web-api";
import { getState, type AppState } from "../store.ts";

export interface ResolvedFile { ref: ResourceRef; alias: string; deletedDiff?: string }

type StateProject = AppState["projectRegistry"]["projects"][number];
type StateSession = AppState["sessions"][number];

/** The checkout directories an absolute file path in this workspace may start
 *  with: the session's own checkouts (an isolated worktree has its own) and
 *  the Project's registered repositories, which an agent working in a
 *  worktree may still name. Both map to the same repository id, so the path
 *  opens in the session's checkout. Paths only — no file is read here. */
export function workspaceFileRoots(project: StateProject | undefined, session: StateSession | undefined): Array<{ repositoryId: string; path: string }> {
  if (!project) return [];
  const roots: Array<{ repositoryId: string; path: string }> = [];
  try {
    const usable = session && session.projectId === project.id ? session : null;
    for (const row of resolveWorkspaceContext(project, usable).repositories) roots.push({ repositoryId: row.repositoryId, path: row.path });
  } catch { /* An invalid workspace contributes no roots. */ }
  try {
    for (const row of projectRepositories(project)) roots.push({ repositoryId: row.id, path: row.path });
  } catch { /* Same as above. */ }
  return roots;
}

/** Resolve only within the originating canonical workspace. A bare path is
 * never allowed to choose an arbitrary repository when several contain it. */
export async function resolveFileReference(ref: ResourceRef): Promise<ResolvedFile[]> {
  if (ref.scheme !== "file" || !ref.locator || ref.locator.startsWith("/")
    || ref.locator.includes("\\") || ref.locator.includes("\0")
    || ref.locator.split("/").some((part) => part === ".." || part === "." || !part)) return [];
  const state = getState();
  const project = state.projectRegistry.projects.find((candidate) => candidate.id === ref.projectId);
  if (!project) return [];
  const session = ref.sessionId ? state.sessions.find((candidate) => candidate.id === ref.sessionId) : null;
  if (ref.sessionId && (!session || session.projectId !== ref.projectId)) return [];
  let context;
  try { context = resolveWorkspaceContext(project, session); } catch { return []; }
  const repositories = context.repositories.filter((repository) => repository.state === "ready"
    && (ref.repositoryId === undefined || repository.repositoryId === ref.repositoryId));
  const results = await Promise.all(repositories.map(async (repository): Promise<ResolvedFile | null> => {
    const resolved = { ...ref, repositoryId: repository.repositoryId };
    try {
      const stat = await api.filesStat(ref.projectId, ref.locator, ref.sessionId ?? undefined, repository.repositoryId);
      if (stat.kind === "file") return { ref: resolved, alias: repository.alias };
    } catch { /* A deleted tracked file can still have a reviewable diff. */ }
    try {
      for (const staged of [false, true]) {
        const result = await api.gitDiff(ref.projectId, ref.locator, staged, false, ref.sessionId ?? undefined, repository.repositoryId);
        if (/^\+\+\+ \/dev\/null$/m.test(result.diff)) {
          return { ref: resolved, alias: repository.alias, deletedDiff: result.diff };
        }
      }
    } catch { /* Unresolved prose paths remain ordinary text. */ }
    return null;
  }));
  return results.filter((result): result is ResolvedFile => result !== null);
}

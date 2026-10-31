// Derives the status-bar model from the live stores. Owns the serial Git
// status scan of the repositories in scope — so it runs once per bar, never
// once per segment — and only while the full bar that needs it is mounted.
// Package segments (such as the workflow chip) fetch their own data and are
// not part of this model.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { resolveWorkspaceContext } from "@polyth/contracts/workspace";
import { useStore } from "../store.ts";
import { isWorkspaceSurface, listSurfaces } from "../surfaces.ts";
import { api } from "@polyth/session/web-api";
import { subscribeGitStatus } from "../../../../packages/git/widgets/gitStatusStore.ts";
import { langOf } from "../highlight.ts";
import { getEditorCursor, subscribeEditorCursor } from "../resources/views.ts";
import type { StatusbarBranch, StatusbarChanges, StatusbarEditor, StatusbarModel } from "./model.ts";

interface GitContext {
  scopeKey: string;
  branch: string | null;
  ahead: number;
  behind: number;
  changes: number;
  repositories: number;
  unavailable: number;
  /** At least one probed folder is a Git repository. */
  hasRepository: boolean;
}

interface GitScanRequest {
  scopeKey: string;
  projectId: string;
  sessionId: string | undefined;
  repositoryIds: readonly (string | undefined)[];
  missing: number;
  generation: number;
}

export interface StatusbarDataOptions {
  /** Probe Git for the branch and the changed-file count. Only the full bar
   *  shows them, so the workflow-only strip leaves Git alone. */
  git: boolean;
}

export function useStatusbarData({ git }: StatusbarDataOptions): StatusbarModel {
  const storeBranch = useStore((s) => s.gitBranch);
  const project = useStore((s) => s.projectRegistry.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const focusedRepositoryId = useStore((s) => s.editorRepositoryId);
  const editorFile = useStore((s) => s.editorFile);
  const editorLocation = useStore((s) => s.editorLocation);
  const editorCursor = useSyncExternalStore(subscribeEditorCursor, getEditorCursor, () => null);
  const rail = useStore((s) => s.railPlugin);
  const topologyRevision = useStore((s) => project?.id ? s.worktreeTopology[project.id] ?? 0 : 0);
  const view = useStore((s) => s.activeView);
  const filesFocused = rail === "files";
  const effectiveFocusedRepositoryId = filesFocused ? focusedRepositoryId : null;
  const declaredRepositoryRows = (() => {
    if (!git || !project) return [];
    try { return resolveWorkspaceContext(project, session).repositories; } catch { return []; }
  })();
  const consideredRepositoryRows = declaredRepositoryRows
    .filter((row) => !effectiveFocusedRepositoryId || row.repositoryId === effectiveFocusedRepositoryId);
  const allReadyRepositoryIds = consideredRepositoryRows
    .filter((row) => row.state === "ready")
    .map((row) => row.repositoryId);
  const readyRepositoryIds = allReadyRepositoryIds.slice(0, 128);
  const unavailableRepositoryCount = consideredRepositoryRows.filter((row) => row.state !== "ready").length
    + Math.max(0, allReadyRepositoryIds.length - readyRepositoryIds.length);
  const statusRepositoryIds = readyRepositoryIds.length > 0
    ? readyRepositoryIds
    : consideredRepositoryRows.length === 0
      ? [undefined]
      : [];
  const statusScopeKey = `${project?.id ?? "none"}:${session?.id ?? "project"}:${consideredRepositoryRows.map((row) => `${row.repositoryId}:${row.state}`).join(",")}:${statusRepositoryIds.join(",")}:${unavailableRepositoryCount}:${topologyRevision}`;
  const [gitContext, setGitContext] = useState<GitContext | null>(null);
  const [gitInvalidation, setGitInvalidation] = useState(0);
  const gitScanRef = useRef<{ running: boolean; generation: number; pending: GitScanRequest | null }>({
    running: false, generation: 0, pending: null,
  });
  const mountedRef = useRef(true);
  const paneTitle = rail !== null
    ? listSurfaces().find((s) => s.id === rail && isWorkspaceSurface(s))?.title ?? null
    : null;

  useEffect(() => (git ? subscribeGitStatus(() => setGitInvalidation((value) => value + 1)) : undefined), [git]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const worker = gitScanRef.current;
    worker.generation += 1;
    if (!git || !project?.id) {
      worker.pending = null;
      setGitContext(null);
      return;
    }
    const scopeKey = statusScopeKey;
    const request: GitScanRequest = {
      scopeKey,
      projectId: project.id,
      sessionId: session?.id,
      repositoryIds: statusRepositoryIds,
      missing: unavailableRepositoryCount,
      generation: worker.generation,
    };
    // The previous result stays on screen while a rescan of the same scope runs
    // (Git status is invalidated by unrelated widgets all the time); a different
    // scope is never shown, because the result below is matched on `scopeKey`.
    worker.pending = request;
    if (worker.running) return;
    worker.running = true;
    const run = async (): Promise<void> => {
      while (worker.pending && mountedRef.current) {
        const current = worker.pending;
        worker.pending = null;
        const statuses: Array<{ repositoryId: string | undefined; status: Awaited<ReturnType<typeof api.gitStatus>> }> = [];
        let unavailable = current.missing;
        for (const repositoryId of current.repositoryIds) {
          if (!mountedRef.current || worker.generation !== current.generation) break;
          try {
            statuses.push({ repositoryId, status: await api.gitStatus(current.projectId, current.sessionId, repositoryId) });
          } catch { unavailable++; }
        }
        if (!mountedRef.current) return;
        if (worker.pending || worker.generation !== current.generation) continue;
        const changed = new Set<string>();
        for (const { repositoryId, status } of statuses) {
          // A plain folder reports `isRepo: false` with empty lists; counting
          // it would read as a clean "0 changes" repository.
          if (status.isRepo === false) continue;
          for (const file of [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted]) {
            changed.add(`${repositoryId ?? "project"}\0${file.path}`);
          }
        }
        const primary = statuses.find(({ status }) => status.isRepo !== false)?.status;
        setGitContext({
          scopeKey: current.scopeKey,
          branch: primary?.branch ?? null,
          ahead: primary?.ahead ?? 0,
          behind: primary?.behind ?? 0,
          changes: changed.size,
          repositories: current.repositoryIds.length + current.missing,
          unavailable,
          hasRepository: primary !== undefined,
        });
      }
    };
    void run().finally(() => { worker.running = false; });
  }, [git, gitInvalidation, project?.id, session?.id, statusRepositoryIds.join(","), statusScopeKey]);

  const gitReady = gitContext?.scopeKey === statusScopeKey ? gitContext : null;
  // Before the first scan of a scope settles the bar shows nothing rather than
  // the previous scope's branch; with no project at all the store's branch is
  // the only signal there is.
  const branchName = gitReady ? gitReady.branch : (project ? null : storeBranch);
  const branch: StatusbarBranch | null = branchName
    ? { name: branchName, ahead: gitReady?.ahead ?? 0, behind: gitReady?.behind ?? 0 }
    : null;
  const changes: StatusbarChanges | null = gitReady && gitReady.hasRepository
    ? {
        count: gitReady.changes,
        repositories: gitReady.repositories,
        unavailable: gitReady.unavailable,
        aggregate: !effectiveFocusedRepositoryId && gitReady.repositories > 1,
      }
    : null;

  let editor: StatusbarEditor | null = null;
  if (git && editorFile && project && filesFocused) {
    const editorRepository = declaredRepositoryRows.find((row) => row.repositoryId === focusedRepositoryId);
    const alias = editorRepository && "alias" in editorRepository ? editorRepository.alias : null;
    const liveCursor = editorCursor?.resource.projectId === project.id
      && (editorCursor.resource.sessionId ?? null) === (session?.id ?? null)
      && (editorCursor.resource.repositoryId ?? "primary") === (focusedRepositoryId ?? "primary")
      && editorCursor.resource.locator === editorFile ? editorCursor : null;
    const location = liveCursor ? { startLine: liveCursor.line, column: liveCursor.column }
      : editorLocation && editorLocation.path === editorFile ? editorLocation : null;
    editor = {
      file: editorFile,
      alias: alias ?? null,
      language: langOf(editorFile),
      line: location?.startLine || null,
      column: location?.column || null,
    };
  }

  return {
    projectId: project?.id ?? null,
    sessionId: session?.id ?? null,
    projectName: project ? project.name || project.path : null,
    modelId: session?.model?.modelID ?? null,
    agent: session?.agent ?? null,
    branch,
    changes,
    editor,
    view,
    paneTitle,
  };
}

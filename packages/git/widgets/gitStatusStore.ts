import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, type GitStatus } from "@polyth/session/web-api";
import type { ProjectContextSnapshot } from "@polyth/web-sdk";
import { workspacePresentationKey } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

interface StatusEntry {
  status: GitStatus | null;
  listeners: Set<() => void>;
  inFlight: Promise<GitStatus | null> | null;
  requestGeneration: number;
  polling: number;
  timer: ReturnType<typeof setInterval> | null;
}

export interface GitSourceControlContext {
  label: string;
  provider: "github" | "gitlab" | "generic";
  source: "repository" | "project" | "global" | "system";
}

export function gitChangedCount(status: GitStatus | null): number {
  if (!status || status.isRepo === false) return 0;
  return status.conflicted.length + status.staged.length + status.unstaged.length + status.untracked.length;
}

export function gitUnpushedCount(status: GitStatus | null): number {
  return status && status.isRepo !== false ? status.ahead : 0;
}

const entries = new Map<string, StatusEntry>();
const globalListeners = new Set<() => void>();

const contextKey = (projectId: string, sessionId?: string | null, repositoryId?: string | null): string =>
  `${workspacePresentationKey("git-status", projectId, sessionId ?? null)}\0${repositoryId ?? ""}`;

function entry(projectId: string, sessionId?: string | null, repositoryId?: string | null): StatusEntry {
  const key = contextKey(projectId, sessionId, repositoryId);
  let value = entries.get(key);
  if (!value) {
    value = { status: null, listeners: new Set(), inFlight: null, requestGeneration: 0, polling: 0, timer: null };
    entries.set(key, value);
  }
  return value;
}

function notify(value: StatusEntry): void {
  for (const listener of [...value.listeners]) listener();
  for (const listener of [...globalListeners]) listener();
}

export function peekGitStatus(projectId: string, sessionId?: string | null, repositoryId?: string | null): GitStatus | null {
  return entries.get(contextKey(projectId, sessionId, repositoryId))?.status ?? null;
}

export function subscribeGitStatus(listener: () => void): () => void {
  globalListeners.add(listener);
  return () => { globalListeners.delete(listener); };
}

export function cacheGitStatus(
  projectId: string,
  status: GitStatus | null,
  sessionId?: string | null,
  repositoryId?: string | null,
): void {
  const value = entry(projectId, sessionId, repositoryId);
  value.status = status;
  notify(value);
}

export function gitContextSnapshot(
  status: GitStatus | null,
  sourceControl?: GitSourceControlContext | null,
): ProjectContextSnapshot | null {
  if (!status || status.isRepo === false) return null;
  const items = [{ label: tr("gitview.branch"), value: status.branch || "HEAD" }];
  if (sourceControl) {
    const provider = sourceControl.provider === "github"
      ? "GitHub"
      : sourceControl.provider === "gitlab"
        ? "GitLab"
        : "Git";
    items.push({ label: tr("gitreg.sourceControl"), value: `${provider} · ${sourceControl.label}` });
  }
  if (status.ahead > 0 || status.behind > 0) {
    items.push({ label: tr("gitreg.ctxSync"), value: tr("gitsettings.aheadBehindValue", { ahead: status.ahead, behind: status.behind }) });
  }
  return {
    title: "Git",
    items,
    recommendedWidgetIds: ["git.pending-changes", "git.recent"],
  };
}

export function refreshGitStatus(projectId: string, sessionId?: string | null, repositoryId?: string | null): Promise<GitStatus | null> {
  const value = entry(projectId, sessionId, repositoryId);
  if (value.inFlight) return value.inFlight;
  const generation = ++value.requestGeneration;
  value.inFlight = api.gitStatus(projectId, sessionId ?? undefined, repositoryId ?? undefined)
    .then((status) => {
      if (generation === value.requestGeneration) {
        value.status = status;
        notify(value);
      }
      return status;
    })
    .catch(() => {
      if (generation === value.requestGeneration) {
        value.status = null;
        notify(value);
      }
      return null;
    })
    .finally(() => {
      value.inFlight = null;
    });
  return value.inFlight;
}

function beginPolling(projectId: string, sessionId?: string | null, repositoryId?: string | null): () => void {
  const value = entry(projectId, sessionId, repositoryId);
  value.polling += 1;
  if (!value.timer) {
    value.timer = setInterval(() => void refreshGitStatus(projectId, sessionId, repositoryId), 2_500);
  }
  return () => {
    value.polling = Math.max(0, value.polling - 1);
    if (value.polling === 0 && value.timer) {
      clearInterval(value.timer);
      value.timer = null;
    }
  };
}

export function useGitStatus(projectId: string | null, poll: boolean, sessionId?: string | null, repositoryId?: string | null, enabled = true): GitStatus | null {
  const subscribe = useCallback((listener: () => void) => {
    if (!projectId) return () => {};
    const value = entry(projectId, sessionId, repositoryId);
    value.listeners.add(listener);
    return () => value.listeners.delete(listener);
  }, [projectId, sessionId, repositoryId]);
  const snapshot = useCallback(() => projectId ? entry(projectId, sessionId, repositoryId).status : null, [projectId, sessionId, repositoryId]);
  const status = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (!projectId || !enabled) return;
    void refreshGitStatus(projectId, sessionId, repositoryId);
  }, [enabled, projectId, sessionId, repositoryId]);

  useEffect(() => {
    if (!projectId || !poll || !enabled) return;
    return beginPolling(projectId, sessionId, repositoryId);
  }, [enabled, projectId, sessionId, repositoryId, poll]);

  return status;
}

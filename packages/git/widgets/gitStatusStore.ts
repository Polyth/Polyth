import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, type GitStatus } from "@polyth/session/web-api";
import type { ProjectContextSnapshot } from "@polyth/web-sdk";

interface StatusEntry {
  status: GitStatus | null;
  listeners: Set<() => void>;
  inFlight: Promise<GitStatus | null> | null;
  polling: number;
  timer: ReturnType<typeof setInterval> | null;
}

export interface GitSourceControlContext {
  label: string;
  provider: "github" | "gitlab" | "generic";
  source: "repository" | "project" | "global" | "system";
}

const entries = new Map<string, StatusEntry>();
const globalListeners = new Set<() => void>();

const contextKey = (projectId: string, sessionId?: string | null): string =>
  `${projectId}\0${sessionId ?? ""}`;

function entry(projectId: string, sessionId?: string | null): StatusEntry {
  const key = contextKey(projectId, sessionId);
  let value = entries.get(key);
  if (!value) {
    value = { status: null, listeners: new Set(), inFlight: null, polling: 0, timer: null };
    entries.set(key, value);
  }
  return value;
}

function notify(value: StatusEntry): void {
  for (const listener of [...value.listeners]) listener();
  for (const listener of [...globalListeners]) listener();
}

export function peekGitStatus(projectId: string, sessionId?: string | null): GitStatus | null {
  return entries.get(contextKey(projectId, sessionId))?.status ?? null;
}

export function subscribeGitStatus(listener: () => void): () => void {
  globalListeners.add(listener);
  return () => { globalListeners.delete(listener); };
}

export function cacheGitStatus(
  projectId: string,
  status: GitStatus | null,
  sessionId?: string | null,
): void {
  const value = entry(projectId, sessionId);
  value.status = status;
  notify(value);
}

export function gitContextSnapshot(
  status: GitStatus | null,
  sourceControl?: GitSourceControlContext | null,
): ProjectContextSnapshot | null {
  if (!status || status.isRepo === false) return null;
  const items = [{ label: "Branch", value: status.branch || "HEAD" }];
  if (sourceControl) {
    const provider = sourceControl.provider === "github"
      ? "GitHub"
      : sourceControl.provider === "gitlab"
        ? "GitLab"
        : "Git";
    items.push({ label: "Source control", value: `${provider} · ${sourceControl.label}` });
  }
  if (status.ahead > 0 || status.behind > 0) {
    items.push({ label: "Sync", value: `${status.ahead} ahead · ${status.behind} behind` });
  }
  return {
    title: "Git",
    items,
    recommendedWidgetIds: ["git.pending-changes", "git.recent"],
  };
}

export function refreshGitStatus(projectId: string, sessionId?: string | null): Promise<GitStatus | null> {
  const value = entry(projectId, sessionId);
  if (value.inFlight) return value.inFlight;
  value.inFlight = api.gitStatus(projectId, sessionId ?? undefined)
    .then((status) => {
      value.status = status;
      notify(value);
      return status;
    })
    .catch(() => {
      value.status = null;
      notify(value);
      return null;
    })
    .finally(() => {
      value.inFlight = null;
    });
  return value.inFlight;
}

function beginPolling(projectId: string, sessionId?: string | null): () => void {
  const value = entry(projectId, sessionId);
  value.polling += 1;
  if (!value.timer) {
    value.timer = setInterval(() => void refreshGitStatus(projectId, sessionId), 2_500);
  }
  return () => {
    value.polling = Math.max(0, value.polling - 1);
    if (value.polling === 0 && value.timer) {
      clearInterval(value.timer);
      value.timer = null;
    }
  };
}

export function useGitStatus(projectId: string | null, poll: boolean, sessionId?: string | null): GitStatus | null {
  const subscribe = useCallback((listener: () => void) => {
    if (!projectId) return () => {};
    const value = entry(projectId, sessionId);
    value.listeners.add(listener);
    return () => value.listeners.delete(listener);
  }, [projectId, sessionId]);
  const snapshot = useCallback(() => projectId ? entry(projectId, sessionId).status : null, [projectId, sessionId]);
  const status = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (!projectId) return;
    void refreshGitStatus(projectId, sessionId);
  }, [projectId, sessionId]);

  useEffect(() => {
    if (!projectId || !poll) return;
    return beginPolling(projectId, sessionId);
  }, [projectId, sessionId, poll]);

  return status;
}

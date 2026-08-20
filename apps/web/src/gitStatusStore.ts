import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api, type GitStatus } from "./api.ts";

interface StatusEntry {
  status: GitStatus | null;
  listeners: Set<() => void>;
  inFlight: Promise<GitStatus | null> | null;
  polling: number;
  timer: ReturnType<typeof setInterval> | null;
}

const entries = new Map<string, StatusEntry>();

function entry(projectId: string): StatusEntry {
  let value = entries.get(projectId);
  if (!value) {
    value = { status: null, listeners: new Set(), inFlight: null, polling: 0, timer: null };
    entries.set(projectId, value);
  }
  return value;
}

function notify(value: StatusEntry): void {
  for (const listener of [...value.listeners]) listener();
}

/** Shared, deduplicated status fetch used by GitView, the rail, and the composer bar. */
export function refreshGitStatus(projectId: string): Promise<GitStatus | null> {
  const value = entry(projectId);
  if (value.inFlight) return value.inFlight;
  value.inFlight = api.gitStatus(projectId)
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

function beginPolling(projectId: string): () => void {
  const value = entry(projectId);
  value.polling += 1;
  if (!value.timer) {
    value.timer = setInterval(() => void refreshGitStatus(projectId), 2_500);
  }
  return () => {
    value.polling = Math.max(0, value.polling - 1);
    if (value.polling === 0 && value.timer) {
      clearInterval(value.timer);
      value.timer = null;
    }
  };
}

export function useGitStatus(projectId: string | null, poll: boolean): GitStatus | null {
  const subscribe = useCallback((listener: () => void) => {
    if (!projectId) return () => {};
    const value = entry(projectId);
    value.listeners.add(listener);
    return () => value.listeners.delete(listener);
  }, [projectId]);
  const snapshot = useCallback(() => projectId ? entry(projectId).status : null, [projectId]);
  const status = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (!projectId) return;
    void refreshGitStatus(projectId);
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !poll) return;
    return beginPolling(projectId);
  }, [projectId, poll]);

  return status;
}

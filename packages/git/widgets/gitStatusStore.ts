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
  /** Serialized `status`: an unchanged answer keeps the object and stays silent. */
  statusKey: string;
  /** Views the person is looking at (Git view, recent changes). */
  polling: number;
  /** Views that only follow a running turn. */
  following: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Wall-clock time of the next scheduled read. */
  nextAt: number;
  /** How long the last read took, the measure of what this machine can afford. */
  lastDurationMs: number;
  lastCompletedAt: number;
}

/** While a view is open, or while a turn runs and nothing reports activity. */
export const GIT_STATUS_VIEW_POLL_MS = 2_500;
export const GIT_STATUS_TURN_POLL_MS = 15_000;
/** A read that follows reported activity waits for the burst to settle. */
export const GIT_STATUS_ACTIVITY_DELAY_MS = 1_000;
/** A slow `git status` (a big tree, a synced folder, a scanned disk) spaces
 *  itself out instead of keeping the machine busy with one process after another. */
const SLOW_READ_FACTOR = 10;
const SLOWEST_POLL_MS = 60_000;

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
    value = {
      status: null, listeners: new Set(), inFlight: null, requestGeneration: 0, statusKey: "null",
      polling: 0, following: 0, timer: null, nextAt: 0, lastDurationMs: 0, lastCompletedAt: 0,
    };
    entries.set(key, value);
  }
  return value;
}

function notify(value: StatusEntry): void {
  for (const listener of [...value.listeners]) listener();
  for (const listener of [...globalListeners]) listener();
}

/** Consumers run effects keyed on the status object (one `git diff` per changed
 *  file among them), so only a real change may produce a new one. */
function publish(value: StatusEntry, status: GitStatus | null): void {
  const key = JSON.stringify(status);
  if (key === value.statusKey) return;
  value.status = status;
  value.statusKey = key;
  notify(value);
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
  // Someone changed the repository and says so: tell everyone, even when the
  // cached value happens to read the same.
  const value = entry(projectId, sessionId, repositoryId);
  value.status = status;
  value.statusKey = JSON.stringify(status);
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
  const startedAt = Date.now();
  value.inFlight = api.gitStatus(projectId, sessionId ?? undefined, repositoryId ?? undefined)
    .then((status) => {
      if (generation === value.requestGeneration) publish(value, status);
      return status;
    })
    .catch(() => {
      if (generation === value.requestGeneration) publish(value, null);
      return null;
    })
    .finally(() => {
      value.inFlight = null;
      value.lastCompletedAt = Date.now();
      value.lastDurationMs = value.lastCompletedAt - startedAt;
    });
  return value.inFlight;
}

const documentHidden = (): boolean =>
  (globalThis as { document?: Document }).document?.visibilityState === "hidden";

/** Time from the end of one read to the start of the next. */
const pollGap = (value: StatusEntry): number => Math.min(
  SLOWEST_POLL_MS,
  Math.max(
    value.polling > 0 ? GIT_STATUS_VIEW_POLL_MS : GIT_STATUS_TURN_POLL_MS,
    value.lastDurationMs * SLOW_READ_FACTOR,
  ),
);

function clearSchedule(value: StatusEntry): void {
  if (value.timer) clearTimeout(value.timer);
  value.timer = null;
  value.nextAt = 0;
}

function schedule(value: StatusEntry, delayMs: number, read: () => Promise<unknown>): void {
  if (value.timer) clearTimeout(value.timer);
  value.nextAt = Date.now() + delayMs;
  value.timer = setTimeout(() => {
    value.timer = null;
    value.nextAt = 0;
    const next = () => {
      if (value.polling + value.following > 0) schedule(value, pollGap(value), read);
    };
    // A hidden window reads nothing; it looks again once it could be seen.
    if (documentHidden()) next();
    else void read().finally(next);
  }, delayMs);
  (value.timer as { unref?: () => void }).unref?.();
}

function beginPolling(
  mode: "view" | "turn",
  projectId: string,
  sessionId?: string | null,
  repositoryId?: string | null,
): () => void {
  const value = entry(projectId, sessionId, repositoryId);
  const read = () => refreshGitStatus(projectId, sessionId, repositoryId);
  const field = mode === "view" ? "polling" : "following";
  value[field] += 1;
  // Opening a view speeds up a schedule a running turn left long.
  if (!value.timer || (mode === "view" && value.nextAt - Date.now() > pollGap(value))) {
    schedule(value, pollGap(value), read);
  }
  return () => {
    value[field] = Math.max(0, value[field] - 1);
    if (value.polling + value.following === 0) clearSchedule(value);
  };
}

/** A tool finished in the running turn: its changes are worth reading soon. A
 *  burst of tools collapses into one read, no sooner than this machine affords. */
export function noteGitActivity(projectId: string, sessionId?: string | null, repositoryId?: string | null): void {
  const value = entry(projectId, sessionId, repositoryId);
  const read = () => refreshGitStatus(projectId, sessionId, repositoryId);
  const affordableAt = value.lastCompletedAt + Math.min(SLOWEST_POLL_MS, value.lastDurationMs * SLOW_READ_FACTOR);
  const delay = Math.max(GIT_STATUS_ACTIVITY_DELAY_MS, affordableAt - Date.now());
  if (value.timer && value.nextAt - Date.now() <= delay) return;
  schedule(value, delay, read);
}

/** `poll`: `true` while a view shows the status, `"turn"` while a turn runs (a
 *  slow fallback for `noteGitActivity`), `false` otherwise. The read when a turn
 *  ends shows what it left behind. */
export function useGitStatus(projectId: string | null, poll: boolean | "turn", sessionId?: string | null, repositoryId?: string | null, enabled = true): GitStatus | null {
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
    const stop = beginPolling(poll === "turn" ? "turn" : "view", projectId, sessionId, repositoryId);
    return () => {
      stop();
      if (poll === "turn") void refreshGitStatus(projectId, sessionId, repositoryId);
    };
  }, [enabled, projectId, sessionId, repositoryId, poll]);

  return status;
}

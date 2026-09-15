import {
  parseSourceControlRemoteUrl,
  type SourceControlRemote,
} from "@polyth/contracts/source-control";

type RemoteDirection = "fetch" | "push";

interface RemoteRow {
  remoteName: string;
  direction: RemoteDirection;
  remote: SourceControlRemote;
}

interface RejectedRemote {
  remoteName: string;
  direction: RemoteDirection;
}

const remoteSnapshots = new Map<string, SourceControlRemote | null>();
const inFlight = new Map<string, Promise<SourceControlRemote | null>>();
const listeners = new Set<() => void>();

const unsafeRemoteError = (remoteName?: string): Error =>
  new Error(remoteName
    ? `Git remote ${remoteName} cannot be safely validated for this source-control profile.`
    : "Git remotes cannot be safely validated for this source-control profile.");

const parseInspection = (value: unknown): { remotes: RemoteRow[]; rejected: RejectedRemote[] } => {
  if (!value || typeof value !== "object") throw unsafeRemoteError();
  const payload = value as { remotes?: unknown; rejected?: unknown };
  if (!Array.isArray(payload.remotes) || !Array.isArray(payload.rejected)) throw unsafeRemoteError();

  const rejected: RejectedRemote[] = payload.rejected.map((entry) => {
    if (!entry || typeof entry !== "object") throw unsafeRemoteError();
    const row = entry as { remoteName?: unknown; direction?: unknown };
    if (typeof row.remoteName !== "string" || !row.remoteName.trim()
      || (row.direction !== "fetch" && row.direction !== "push")) {
      throw unsafeRemoteError();
    }
    return { remoteName: row.remoteName.trim(), direction: row.direction };
  });

  const remotes: RemoteRow[] = payload.remotes.map((entry) => {
    if (!entry || typeof entry !== "object") throw unsafeRemoteError();
    const row = entry as { remoteName?: unknown; direction?: unknown; url?: unknown };
    if (typeof row.remoteName !== "string" || !row.remoteName.trim()
      || (row.direction !== "fetch" && row.direction !== "push")
      || typeof row.url !== "string") {
      throw unsafeRemoteError();
    }
    // Re-parse instead of trusting server-derived hostname/protocol fields.
    const remote = parseSourceControlRemoteUrl(row.url);
    if (!remote) throw unsafeRemoteError(row.remoteName.trim());
    return { remoteName: row.remoteName.trim(), direction: row.direction, remote };
  });

  return { remotes, rejected };
};

const sameRemote = (left: SourceControlRemote | null | undefined, right: SourceControlRemote | null): boolean =>
  left === right || (!!left && !!right
    && left.url === right.url
    && left.hostname === right.hostname
    && left.fullPath === right.fullPath
    && left.protocol === right.protocol);

const publishRemote = (projectId: string, remote: SourceControlRemote | null): void => {
  const previous = remoteSnapshots.get(projectId);
  remoteSnapshots.set(projectId, remote);
  if (previous !== undefined && sameRemote(previous, remote)) return;
  for (const listener of [...listeners]) listener();
};

/** Undefined means not inspected yet; null means inspected and no remote exists. */
export function peekRepositorySourceControlRemote(projectId: string): SourceControlRemote | null | undefined {
  return remoteSnapshots.has(projectId) ? remoteSnapshots.get(projectId)! : undefined;
}

export function subscribeRepositorySourceControlRemotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Pick the credential-bearing direction first: origin push, then origin fetch,
 * then the first other remote (push preferred within that name). */
export function selectRepositorySourceControlRemote(value: unknown): SourceControlRemote | null {
  const { remotes, rejected } = parseInspection(value);
  const rejectedNames = new Set(rejected.map((row) => row.remoteName));

  if (rejectedNames.has("origin")) throw unsafeRemoteError("origin");

  const origin = remotes.filter((row) => row.remoteName === "origin");
  const pool = origin.length > 0 ? origin : remotes;
  if (pool.length === 0) {
    if (rejected.length > 0) throw unsafeRemoteError(rejected[0]?.remoteName);
    return null;
  }

  const remoteName = pool[0]!.remoteName;
  if (rejectedNames.has(remoteName)) throw unsafeRemoteError(remoteName);
  const candidates = pool.filter((row) => row.remoteName === remoteName);
  return (candidates.find((row) => row.direction === "push")
    ?? candidates.find((row) => row.direction === "fetch")
    ?? candidates[0]!).remote;
}

export function repositorySourceControlRemote(projectId: string): Promise<SourceControlRemote | null> {
  const pending = inFlight.get(projectId);
  if (pending) return pending;

  const task = (async () => {
    const response = await fetch(`/api/git/remotes?projectId=${encodeURIComponent(projectId)}`);
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("polyth:auth-required"));
    }
    if (!response.ok) {
      let message = `Unable to inspect Git remotes (${response.status}).`;
      try {
        const body = await response.json() as { message?: unknown };
        if (typeof body.message === "string" && body.message.trim()) message = body.message.trim();
      } catch {
        // Keep the bounded generic message for non-JSON failures.
      }
      throw new Error(message);
    }
    const remote = selectRepositorySourceControlRemote(await response.json());
    publishRemote(projectId, remote);
    return remote;
  })().finally(() => {
    inFlight.delete(projectId);
  });

  inFlight.set(projectId, task);
  return task;
}

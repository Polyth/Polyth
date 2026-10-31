import {
  parseSourceControlRemoteUrl,
  type SourceControlRemote,
} from "@polyth/contracts/source-control";
import { workspacePresentationKey } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export type SourceControlRemoteDirection = "fetch" | "push";

export interface RepositorySourceControlRemote {
  remoteName: string;
  remote: SourceControlRemote;
  directions: readonly SourceControlRemoteDirection[];
}

interface RemoteRow {
  remoteName: string;
  direction: SourceControlRemoteDirection;
  remote: SourceControlRemote;
}

interface RejectedRemote {
  remoteName: string;
  direction: SourceControlRemoteDirection;
}

interface SourceControlRemoteInspection {
  remotes: RemoteRow[];
  rejected: RejectedRemote[];
}

const SAFE_REMOTE_NAME = /^[\w.-]{1,120}$/;
const remoteSnapshots = new Map<string, SourceControlRemote | null>();
const inspectionRequests = new Map<string, Promise<SourceControlRemoteInspection>>();
const listeners = new Set<() => void>();

const scopeKey = (projectId: string, repositoryId?: string | null, sessionId?: string | null): string =>
  `${workspacePresentationKey("git-remote-inspection", projectId, sessionId ?? null)}\0${repositoryId ?? ""}`;

const unsafeRemoteError = (remoteName?: string): Error =>
  new Error(remoteName
    ? tr("gitreg.remoteUnsafeNamed", { name: remoteName })
    : tr("gitreg.remoteUnsafe"));

const parseInspection = (value: unknown): SourceControlRemoteInspection => {
  if (!value || typeof value !== "object") throw unsafeRemoteError();
  const payload = value as { remotes?: unknown; rejected?: unknown };
  if (!Array.isArray(payload.remotes) || !Array.isArray(payload.rejected)) throw unsafeRemoteError();

  const rejected: RejectedRemote[] = payload.rejected.map((entry) => {
    if (!entry || typeof entry !== "object") throw unsafeRemoteError();
    const row = entry as { remoteName?: unknown; direction?: unknown };
    const remoteName = typeof row.remoteName === "string" ? row.remoteName.trim() : "";
    if (!SAFE_REMOTE_NAME.test(remoteName)
      || (row.direction !== "fetch" && row.direction !== "push")) {
      throw unsafeRemoteError(remoteName || undefined);
    }
    return { remoteName, direction: row.direction };
  });

  const remotes: RemoteRow[] = payload.remotes.map((entry) => {
    if (!entry || typeof entry !== "object") throw unsafeRemoteError();
    const row = entry as { remoteName?: unknown; direction?: unknown; url?: unknown };
    const remoteName = typeof row.remoteName === "string" ? row.remoteName.trim() : "";
    if (!SAFE_REMOTE_NAME.test(remoteName)
      || (row.direction !== "fetch" && row.direction !== "push")
      || typeof row.url !== "string") {
      throw unsafeRemoteError(remoteName || undefined);
    }
    // Re-parse instead of trusting server-derived hostname/protocol fields.
    const remote = parseSourceControlRemoteUrl(row.url);
    if (!remote) throw unsafeRemoteError(remoteName);
    return { remoteName, direction: row.direction, remote };
  });

  return { remotes, rejected };
};

const sameRemote = (left: SourceControlRemote | null | undefined, right: SourceControlRemote | null): boolean =>
  left === right || (!!left && !!right
    && left.url === right.url
    && left.hostname === right.hostname
    && left.fullPath === right.fullPath
    && left.protocol === right.protocol);

const publishRemote = (key: string, remote: SourceControlRemote | null): void => {
  const previous = remoteSnapshots.get(key);
  remoteSnapshots.set(key, remote);
  if (previous !== undefined && sameRemote(previous, remote)) return;
  for (const listener of [...listeners]) listener();
};

const selectInspectionRemote = ({ remotes, rejected }: SourceControlRemoteInspection): SourceControlRemote | null => {
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
};

/** Pick the credential-bearing direction first: origin push, then origin fetch,
 * then the first other remote (push preferred within that name). */
export function selectRepositorySourceControlRemote(value: unknown): SourceControlRemote | null {
  return selectInspectionRemote(parseInspection(value));
}

const groupRemotes = (remotes: readonly RemoteRow[]): RepositorySourceControlRemote[] => {
  const grouped = new Map<string, { remote: SourceControlRemote; directions: Set<SourceControlRemoteDirection> }>();
  for (const row of remotes) {
    const current = grouped.get(row.remoteName);
    if (!current) {
      grouped.set(row.remoteName, { remote: row.remote, directions: new Set([row.direction]) });
      continue;
    }
    // A push URL is the most useful target detail for a person choosing where
    // to publish; retain the first safe URL when both directions are equal.
    if (row.direction === "push" && !current.directions.has("push")) current.remote = row.remote;
    current.directions.add(row.direction);
  }
  return [...grouped].map(([remoteName, value]) => ({
    remoteName,
    remote: value.remote,
    directions: [...value.directions],
  }));
};

const catalogRemotes = (inspection: SourceControlRemoteInspection): RepositorySourceControlRemote[] => {
  const rejectedNames = new Set(inspection.rejected.map((row) => row.remoteName));
  if (rejectedNames.has("origin")) throw unsafeRemoteError("origin");
  if (inspection.remotes.length === 0 && inspection.rejected.length > 0) {
    throw unsafeRemoteError(inspection.rejected[0]?.remoteName);
  }
  return groupRemotes(inspection.remotes);
};

/** Group safe fetch/push rows by the remote name Git actually accepts. */
export function parseRepositorySourceControlRemotes(value: unknown): RepositorySourceControlRemote[] {
  return catalogRemotes(parseInspection(value));
}

async function requestInspection(projectId: string, repositoryId?: string | null, sessionId?: string | null): Promise<SourceControlRemoteInspection> {
  const key = scopeKey(projectId, repositoryId, sessionId);
  const pending = inspectionRequests.get(key);
  if (pending) return pending;

  const task = (async () => {
    const query = new URLSearchParams({ projectId });
    if (repositoryId) query.set("repositoryId", repositoryId);
    if (sessionId) query.set("sessionId", sessionId);
    const response = await fetch(`/api/git/remotes?${query.toString()}`);
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("polyth:auth-required"));
    }
    if (!response.ok) {
      let message = tr("gitreg.inspectRemotesFailed", { status: response.status });
      try {
        const body = await response.json() as { message?: unknown };
        if (typeof body.message === "string" && body.message.trim()) message = body.message.trim();
      } catch {
        // Keep the bounded generic message for non-JSON failures.
      }
      throw new Error(message);
    }
    return parseInspection(await response.json());
  })().finally(() => {
    if (inspectionRequests.get(key) === task) inspectionRequests.delete(key);
  });

  inspectionRequests.set(key, task);
  return task;
}

/** Read and validate the safe remote catalog for a repository checkout. */
export function repositorySourceControlRemotes(
  projectId: string,
  repositoryId?: string | null,
  sessionId?: string | null,
): Promise<RepositorySourceControlRemote[]> {
  return requestInspection(projectId, repositoryId, sessionId).then(catalogRemotes);
}

/** Undefined means not inspected yet; null means inspected and no remote exists. */
export function peekRepositorySourceControlRemote(projectId: string, repositoryId?: string | null, sessionId?: string | null): SourceControlRemote | null | undefined {
  const key = scopeKey(projectId, repositoryId, sessionId);
  return remoteSnapshots.has(key) ? remoteSnapshots.get(key)! : undefined;
}

export function subscribeRepositorySourceControlRemotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function repositorySourceControlRemote(projectId: string, repositoryId?: string | null, sessionId?: string | null): Promise<SourceControlRemote | null> {
  return requestInspection(projectId, repositoryId, sessionId).then((inspection) => {
    const remote = selectInspectionRemote(inspection);
    publishRemote(scopeKey(projectId, repositoryId, sessionId), remote);
    return remote;
  });
}

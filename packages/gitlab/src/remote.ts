import type { DeploymentProfile } from "@polyth/contracts";
import { inspectOutboundHttpUrl, type Resolver } from "@polyth/outbound";
import {
  detectGitRemotes,
  parseGitRemoteUrl,
  type GitRemoteExec,
  type GitRemoteLocation,
} from "@polyth/code-hosting/remotes";

export {
  detectGitRemotes,
  parseGitRemoteUrl,
  type GitRemoteLocation,
};
export type GitExec = GitRemoteExec;

export interface GitlabInstanceEndpoint {
  origin: string;
  host: string;
  hostname: string;
  apiBaseUrl: string;
}

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

/** Pure syntax normalization. DNS is deliberately deferred until connect/request. */
export function normalizeGitlabInstance(raw: string): GitlabInstanceEndpoint {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return fail("invalid-input", "GitLab instance URL is invalid");
  }
  if (url.username || url.password || url.search || url.hash) {
    return fail("invalid-input", "GitLab instance URL must be an origin without credentials, query, or fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return fail("invalid-input", "GitLab instance URL must not include a path");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return fail("invalid-input", "GitLab instances must use HTTPS (HTTP is allowed only for loopback)");
  }
  return {
    origin: url.origin,
    host: url.host.toLowerCase(),
    hostname: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    apiBaseUrl: new URL("/api/v4/", url.origin).toString(),
  };
}

/** Resolve immediately before account connection and again before each request. */
export async function validateGitlabInstance(
  instance: GitlabInstanceEndpoint,
  deployment: DeploymentProfile,
  resolve?: Resolver,
): Promise<GitlabInstanceEndpoint> {
  const decision = await inspectOutboundHttpUrl(instance.origin, {
    policy: deployment === "local-trusted" ? "user-origin" : "public-only",
    ...(resolve ? { resolve } : {}),
  });
  if (!decision.ok) return fail("NETWORK_ORIGIN_DENIED", decision.reason);
  if (decision.url.origin !== instance.origin) {
    return fail("NETWORK_ORIGIN_DENIED", "GitLab instance origin changed during validation");
  }
  return instance;
}

export interface GitlabRemoteBinding {
  projectId: string;
  remoteName: string;
  observedUrl: string;
  instanceId: string;
  accountId: string;
}

/** Refuse silent publication when a repository remote changed after binding. */
export function requireCurrentRemote(
  binding: GitlabRemoteBinding,
  remotes: readonly GitRemoteLocation[],
): GitRemoteLocation {
  const current = remotes.find((remote) =>
    remote.remoteName === binding.remoteName && remote.url === binding.observedUrl
  );
  if (!current) return fail("remote-binding-stale", "Git remote changed; select the GitLab account again");
  return current;
}

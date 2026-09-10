import { execFile } from "node:child_process";
import type { DeploymentProfile } from "@polyth/contracts";
import {
  inspectOutboundHttpUrl,
  pinnedHttpRequest,
  type PinnedHttpResult,
  type Resolver,
} from "@polyth/outbound";
import type { GitlabInstanceEndpoint } from "./remote.ts";
import { validateGitlabInstance } from "./remote.ts";

export type GitlabRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface GitlabRequestOptions { method?: GitlabRequestMethod; body?: unknown; signal?: AbortSignal }
export interface GitlabApiClient {
  request<T>(path: string, options?: GitlabRequestOptions): Promise<T>;
  list<T>(path: string, limit?: number): Promise<T[]>;
}

export type GitlabHttpTransport = (
  url: URL,
  pin: { address: string; family: 4 | 6 },
  init: { method: GitlabRequestMethod; headers: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs: number; maxBytes: number },
) => Promise<PinnedHttpResult>;

export type GlabExec = (
  bin: "glab",
  args: string[],
  opts: { cwd?: string; input?: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

const unknownMutation = (message: string): never => {
  throw Object.assign(new Error(message), {
    code: "mutation-outcome-unknown",
    outcome: "unknown" as const,
  });
};

function endpoint(instance: GitlabInstanceEndpoint, path: string): URL {
  if (
    typeof path !== "string" || !path || path.startsWith("/")
    || /^[A-Za-z][A-Za-z\d+.-]*:/.test(path)
    || path.includes("\\") || /(^|\/)\.\.?(\/|$)/.test(path)
  ) {
    return fail("invalid-input", "GitLab API path must be relative to /api/v4");
  }
  const url = new URL(path, instance.apiBaseUrl);
  if (url.origin !== instance.origin || !url.pathname.startsWith("/api/v4/")) {
    return fail("NETWORK_ORIGIN_DENIED", "GitLab API path escaped its bound instance");
  }
  return url;
}

function parseBody<T>(result: PinnedHttpResult, method: GitlabRequestMethod): T {
  if (result.status < 200 || result.status >= 300) {
    if (result.status === 401) return fail("invalid-token", "GitLab rejected the configured credential");
    if (result.status === 403) return fail("forbidden", "GitLab denied this operation");
    if (result.status === 404) return fail("not-found", "GitLab resource not found");
    if (result.status === 429) return fail("rate-limited", "GitLab rate limit reached");
    if (result.status >= 500) {
      return method === "GET"
        ? fail("unavailable", "GitLab service is unavailable")
        : unknownMutation("GitLab mutation outcome is unknown; inspect the resource before retrying");
    }
    return fail("gitlab-http-error", `GitLab request failed (${result.status})`);
  }
  if (!result.body.length) return undefined as T;
  try {
    return JSON.parse(result.body.toString("utf8")) as T;
  } catch {
    return method === "GET"
      ? fail("gitlab-invalid-response", "GitLab returned invalid JSON")
      : unknownMutation("GitLab mutation succeeded but returned an unreadable result; inspect the resource before retrying");
  }
}

/** Direct REST client for a Secure Safe PAT. Redirects are rejected, never followed. */
export function createGitlabApiClient(input: {
  instance: GitlabInstanceEndpoint;
  deployment: DeploymentProfile;
  token: string;
  resolve?: Resolver;
  transport?: GitlabHttpTransport;
}): GitlabApiClient {
  const transport: GitlabHttpTransport = input.transport ?? ((url, pin, init) => pinnedHttpRequest(url, pin, init));
  const requestPage = async <T>(path: string, options: GitlabRequestOptions = {}): Promise<T> => {
    if (!input.token) return fail("auth-required", "GitLab credential is unavailable");
    const instance = await validateGitlabInstance(input.instance, input.deployment, input.resolve);
    const url = endpoint(instance, path);
    const decision = await inspectOutboundHttpUrl(url.toString(), {
      policy: input.deployment === "local-trusted" ? "user-origin" : "public-only",
      ...(input.resolve ? { resolve: input.resolve } : {}),
    });
    if (!decision.ok || decision.url.origin !== instance.origin) {
      return fail("NETWORK_ORIGIN_DENIED", decision.ok ? "GitLab origin changed" : decision.reason);
    }
    const address = decision.addresses[0];
    if (!address) return fail("NETWORK_ORIGIN_DENIED", "GitLab DNS lookup returned no addresses");
    const method = options.method ?? "GET";
    let body: string | undefined;
    try { body = options.body === undefined ? undefined : JSON.stringify(options.body); }
    catch { return fail("invalid-input", "GitLab request body is not valid JSON"); }
    let result: PinnedHttpResult;
    try {
      result = await transport(url, { address, family: address.includes(":") ? 6 : 4 }, {
        method,
        headers: {
          accept: "application/json",
          // GitLab accepts Bearer for both PATs and OAuth tokens. This keeps
          // transient tokens from an existing glab OAuth login usable without
          // guessing their credential type.
          authorization: `Bearer ${input.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: 20_000,
        maxBytes: 1024 * 1024,
      });
    } catch {
      return method === "GET"
        ? fail("unavailable", "GitLab is unreachable")
        : unknownMutation("GitLab mutation outcome is unknown; inspect the resource before retrying");
    }
    if (result.status >= 300 && result.status < 400) {
      return method === "GET"
        ? fail("NETWORK_ORIGIN_DENIED", "GitLab redirects are not allowed")
        : unknownMutation("GitLab redirected after a mutation; inspect the resource before retrying");
    }
    return parseBody<T>(result, method);
  };
  return {
    request: requestPage,
    async list<T>(path: string, limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail("invalid-input", "limit must be between 1 and 100");
      const url = endpoint(input.instance, path);
      url.searchParams.set("per_page", String(limit));
      const result = await requestPage<T[]>(`${url.pathname.slice("/api/v4/".length)}${url.search}`);
      if (!Array.isArray(result)) return fail("gitlab-invalid-response", "GitLab list response was not an array");
      return result.slice(0, limit);
    },
  };
}

const defaultGlabExec: GlabExec = (bin, args, opts) => new Promise((resolve, reject) => {
  const child = execFile(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  }, (error, stdout, stderr) => error
    ? reject(Object.assign(new Error("glab authentication lookup failed"), {
      code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-installed" : "auth-required",
    }))
    : resolve({ stdout, stderr }));
  if (opts.input !== undefined && child.stdin) {
    child.stdin.on("error", reject);
    child.stdin.end(opts.input);
  }
});

/**
 * Uses an existing glab login for one host. glab has one active identity per
 * host, so every request re-checks it against the stored username. PAT mode is
 * the supported path for simultaneous accounts on the same instance.
 */
export function createGlabApiClient(input: {
  instance: GitlabInstanceEndpoint;
  deployment: DeploymentProfile;
  expectedUsername: string;
  cwd?: string;
  exec?: GlabExec;
  resolve?: Resolver;
  transport?: GitlabHttpTransport;
}): GitlabApiClient {
  if (input.deployment !== "local-trusted") {
    return fail("forbidden", "existing glab login is available only in local-trusted deployments");
  }
  const exec = input.exec ?? defaultGlabExec;
  const env = { ...process.env };
  for (const key of [
    "GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "CI_JOB_TOKEN",
    "GITLAB_CI", "CI", "GITLAB_HOST", "GITLAB_URI", "GL_HOST",
  ]) delete env[key];
  env.GLAB_ENABLE_CI_AUTOLOGIN = "false";
  const call = async <T>(path: string, options: GitlabRequestOptions = {}): Promise<T> => {
    endpoint(input.instance, path);
    await validateGitlabInstance(input.instance, input.deployment, input.resolve);
    let token: string;
    try {
      token = (await exec("glab", [
        "config", "get", "token", "--host", input.instance.host, "--global",
      ], { cwd: input.cwd, env })).stdout.trim();
    } catch (error) {
      const code = (error as { code?: string }).code === "not-installed" ? "not-installed" : "auth-required";
      return fail(code, code === "not-installed" ? "GitLab CLI is not installed" : "glab is not authenticated for this instance");
    }
    if (!token || token.length > 4096 || /[\0-\x1f\x7f]/.test(token)) {
      return fail("auth-required", "glab is not authenticated for this instance");
    }
    const rest = createGitlabApiClient({
      instance: input.instance,
      deployment: input.deployment,
      token,
      ...(input.resolve ? { resolve: input.resolve } : {}),
      ...(input.transport ? { transport: input.transport } : {}),
    });
    const identity = await rest.request<{ username?: unknown }>("user");
    const username = typeof identity.username === "string" ? identity.username : "";
    if (username.toLocaleLowerCase() !== input.expectedUsername.toLocaleLowerCase()) {
      return fail("auth-account-mismatch", "glab is authenticated as a different GitLab account");
    }
    return rest.request<T>(path, options);
  };
  return {
    request: call,
    async list<T>(path: string, limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail("invalid-input", "limit must be between 1 and 100");
      const url = endpoint(input.instance, path);
      url.searchParams.set("per_page", String(limit));
      const result = await call<T[]>(`${url.pathname.slice("/api/v4/".length)}${url.search}`);
      if (!Array.isArray(result)) return fail("gitlab-invalid-response", "GitLab list response was not an array");
      return result.slice(0, limit);
    },
  };
}

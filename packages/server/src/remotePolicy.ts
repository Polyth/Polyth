import {
  isRemoteCapability,
  isRemotePathPattern,
  matchRemotePath,
  REMOTE_CAPABILITY,
  remotePathPatternsOverlap,
  type AuthPrincipal,
  type HttpMethod,
  type RemoteAccessPolicy,
  type RemoteHttpRule,
} from "@polyth/contracts";
import { AuthorizationError } from "./auth.ts";

const METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isHttpMethod(value: string): value is HttpMethod {
  return (METHODS as readonly string[]).includes(value);
}

function pathScope(path: string, kind: "http" | "websocket"): string | null {
  const parts = path.split("/");
  if (kind === "http") {
    if (parts[1] !== "api" || !parts[2]) return null;
    return parts[2];
  }
  if (path === "/ws") return "core";
  if (parts[1] !== "ws" || !parts[2]) return null;
  return parts[2] === ":id" ? null : parts[2];
}

export function validateRemoteAccessPolicy(
  owner: string,
  policy: RemoteAccessPolicy,
  existing: readonly OwnedRemotePolicy[] = [],
): void {
  if (!Array.isArray(policy.routeScopes) || policy.routeScopes.length === 0
    || policy.routeScopes.some((s) => typeof s !== "string" || !s || /\s/.test(s))) {
    throw Object.assign(new Error(`package "${owner}" remoteAccess.routeScopes is invalid`), { code: "invalid-input" });
  }
  const scopes = new Set(policy.routeScopes);
  if (scopes.size !== policy.routeScopes.length) {
    throw Object.assign(new Error(`package "${owner}" remoteAccess.routeScopes contains duplicates`), { code: "invalid-input" });
  }
  for (const other of existing) {
    if (other.owner === owner) continue;
    for (const scope of policy.routeScopes) {
      if (other.policy.routeScopes.includes(scope)) {
        throw Object.assign(
          new Error(`package "${owner}" routeScope "${scope}" overlaps "${other.owner}"`),
          { code: "invalid-input" },
        );
      }
    }
  }

  const seenHttp = new Set<string>();
  for (const rule of policy.http) {
    if (!isRemotePathPattern(rule.path) || !rule.path.startsWith("/api/")) {
      throw Object.assign(new Error(`package "${owner}" remote HTTP path is invalid: ${rule.path}`), { code: "invalid-input" });
    }
    const scope = pathScope(rule.path, "http");
    if (!scope || !scopes.has(scope)) {
      throw Object.assign(
        new Error(`package "${owner}" HTTP path ${rule.path} is outside routeScopes`),
        { code: "invalid-input" },
      );
    }
    if (!isRemoteCapability(rule.capability)) {
      throw Object.assign(new Error(`package "${owner}" remote capability is invalid: ${rule.capability}`), { code: "invalid-input" });
    }
    if (!rule.methods.length || !rule.methods.every((m) => isHttpMethod(m))) {
      throw Object.assign(new Error(`package "${owner}" remote HTTP methods are invalid`), { code: "invalid-input" });
    }
    const uniqueMethods = new Set(rule.methods);
    if (uniqueMethods.size !== rule.methods.length) {
      throw Object.assign(new Error(`package "${owner}" remote HTTP methods are duplicated`), { code: "invalid-input" });
    }
    if (rule.methods.some((method) => SAFE_METHODS.has(method)) && rule.mutation) {
      throw Object.assign(new Error(`package "${owner}" ${rule.path} marks a safe method as a mutation`), { code: "invalid-input" });
    }
    if (rule.methods.some((method) => MUTATING_METHODS.has(method)) && !rule.mutation) {
      throw Object.assign(new Error(`package "${owner}" ${rule.path} is missing mutation: true`), { code: "invalid-input" });
    }
    if (rule.maxBodyBytes !== undefined && (!Number.isInteger(rule.maxBodyBytes) || rule.maxBodyBytes < 0)) {
      throw Object.assign(new Error(`package "${owner}" maxBodyBytes is invalid`), { code: "invalid-input" });
    }
    const key = `${[...rule.methods].sort().join(",")}|${rule.path}`;
    if (seenHttp.has(key)) {
      throw Object.assign(new Error(`package "${owner}" duplicate remote HTTP rule ${key}`), { code: "invalid-input" });
    }
    seenHttp.add(key);
  }

  const seenWs = new Set<string>();
  for (const rule of policy.websocket ?? []) {
    if (!rule.path.startsWith("/ws") || (rule.path !== "/ws" && !isRemotePathPattern(rule.path))) {
      throw Object.assign(new Error(`package "${owner}" remote WebSocket path must start with /ws`), { code: "invalid-input" });
    }
    const scope = pathScope(rule.path, "websocket");
    if (!scope || !scopes.has(scope)) {
      throw Object.assign(
        new Error(`package "${owner}" WebSocket path ${rule.path} is outside routeScopes`),
        { code: "invalid-input" },
      );
    }
    if (!isRemoteCapability(rule.capability)) {
      throw Object.assign(new Error(`package "${owner}" remote capability is invalid: ${rule.capability}`), { code: "invalid-input" });
    }
    if (seenWs.has(rule.path)) {
      throw Object.assign(new Error(`package "${owner}" duplicate remote WebSocket path ${rule.path}`), { code: "invalid-input" });
    }
    seenWs.add(rule.path);
  }

  const overlaps = findRemotePolicyOverlaps([{ owner, policy }, ...existing]);
  if (overlaps.length > 0) {
    throw Object.assign(new Error(`package "${owner}" remote policy overlaps: ${overlaps.join("; ")}`), { code: "invalid-input" });
  }
}

export const CORE_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: [
    "agents", "auth", "core", "folders", "health", "labels", "models", "notifications",
    "packages", "projects", "providers", "runtime", "search", "sessions", "settings",
    "spaces",
  ],
  http: [
    { methods: ["GET"], path: "/api/health", capability: REMOTE_CAPABILITY.coreHealthRead, mutation: false },
    { methods: ["GET"], path: "/api/auth/status", capability: REMOTE_CAPABILITY.coreHealthRead, mutation: false },
    { methods: ["GET"], path: "/api/projects", capability: REMOTE_CAPABILITY.coreProjectsRead, mutation: false },
    { methods: ["POST"], path: "/api/projects", capability: REMOTE_CAPABILITY.coreProjectsWrite, mutation: true },
    { methods: ["POST"], path: "/api/projects/create", capability: REMOTE_CAPABILITY.coreProjectsWrite, mutation: true },
    { methods: ["DELETE"], path: "/api/projects/:id", capability: REMOTE_CAPABILITY.coreProjectsWrite, mutation: true },
    { methods: ["GET"], path: "/api/sessions", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    { methods: ["POST"], path: "/api/sessions", capability: REMOTE_CAPABILITY.coreSessionsCreate, mutation: true },
    { methods: ["GET"], path: "/api/sessions/:id", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    { methods: ["DELETE"], path: "/api/sessions/:id", capability: REMOTE_CAPABILITY.coreSessionsDelete, mutation: true },
    { methods: ["GET"], path: "/api/sessions/:id/events", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    { methods: ["POST"], path: "/api/sessions/:id/message", capability: REMOTE_CAPABILITY.coreSessionsMessage, mutation: true },
    { methods: ["GET"], path: "/api/sessions/:id/queue", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    { methods: ["PATCH"], path: "/api/sessions/:id/queue/order", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
    { methods: ["PATCH"], path: "/api/sessions/:id/queue/:itemId", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
    { methods: ["DELETE"], path: "/api/sessions/:id/queue/:itemId", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
    { methods: ["POST"], path: "/api/sessions/:id/abort", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
    { methods: ["POST"], path: "/api/sessions/:id/archive", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
    { methods: ["POST"], path: "/api/sessions/:id/restore", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
    { methods: ["POST"], path: "/api/sessions/:id/resume/cancel", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
    { methods: ["POST"], path: "/api/sessions/:id/resume/now", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
    { methods: ["POST"], path: "/api/sessions/:id/fork", capability: REMOTE_CAPABILITY.coreSessionsCreate, mutation: true },
    { methods: ["POST"], path: "/api/sessions/:id/rewind", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
    { methods: ["POST"], path: "/api/sessions/:id/rewind/clear", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
    { methods: ["POST"], path: "/api/sessions/:id/shell", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
    { methods: ["POST"], path: "/api/sessions/:id/permission/:requestId", capability: REMOTE_CAPABILITY.coreRequestsRespond, mutation: true },
    { methods: ["POST"], path: "/api/sessions/:id/question/:requestId", capability: REMOTE_CAPABILITY.coreRequestsRespond, mutation: true },
    { methods: ["POST"], path: "/api/sessions/:id/question/:requestId/reject", capability: REMOTE_CAPABILITY.coreRequestsRespond, mutation: true },
    { methods: ["GET"], path: "/api/models", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    { methods: ["GET"], path: "/api/providers", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    { methods: ["GET"], path: "/api/agents", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    // A paired device sees the same empty catalog and needs the same reason;
    // it already reads project paths through /api/projects.
    { methods: ["GET"], path: "/api/runtime/diagnostics", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    { methods: ["GET"], path: "/api/notifications", capability: REMOTE_CAPABILITY.coreNotificationsRead, mutation: false },
    { methods: ["POST"], path: "/api/notifications/read", capability: REMOTE_CAPABILITY.coreNotificationsRead, mutation: true },
    { methods: ["POST"], path: "/api/notifications/read-all", capability: REMOTE_CAPABILITY.coreNotificationsRead, mutation: true },
    { methods: ["POST"], path: "/api/notifications/clear", capability: REMOTE_CAPABILITY.coreNotificationsRead, mutation: true },
    { methods: ["GET"], path: "/api/packages", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    { methods: ["GET"], path: "/api/folders", capability: REMOTE_CAPABILITY.coreProjectsRead, mutation: false },
    { methods: ["GET"], path: "/api/labels", capability: REMOTE_CAPABILITY.coreProjectsRead, mutation: false },
    { methods: ["GET"], path: "/api/search/workspaces", capability: REMOTE_CAPABILITY.coreProjectsRead, mutation: false },
    { methods: ["GET"], path: "/api/search/sessions", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    // Spaces: a paired device may see which Spaces it can enter and switch
    // between them. Creating, renaming, deleting, and membership changes stay
    // local-only — tenancy administration is not a remote-device affordance.
    { methods: ["GET"], path: "/api/spaces", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    { methods: ["POST"], path: "/api/spaces/:id/activate", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
    { methods: ["GET"], path: "/api/settings/client", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    { methods: ["PUT"], path: "/api/settings/client", capability: REMOTE_CAPABILITY.coreSessionsControl, mutation: true },
  ],
  websocket: [
    { path: "/ws", capability: REMOTE_CAPABILITY.coreSessionsRead },
  ],
};

/** Core HTTP prefixes that exist locally and stay default-deny for paired devices. */
export const CORE_LOCAL_ONLY_PREFIXES: readonly string[] = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/logout-all",
  "/api/auth/sessions",
  "/api/mcp",
  "/api/settings/behavior",
  "/api/settings/assist",
  "/api/system",
  "/api/agent",
  "/api/browse",
  "/api/opencode",
  "/api/push",
  "/api/models/enabled",
  "/api/plugins",
  "/internal",
  "/debug",
  "/metrics",
];

export interface OwnedRemotePolicy {
  owner: string;
  policy: RemoteAccessPolicy;
}

export interface RemoteRuleMatch {
  owner: string;
  rule: RemoteHttpRule;
}

function patternSpecificity(pattern: string): number {
  return pattern.split("/").reduce((count, part) => count + (part && !part.startsWith(":") ? 1 : 0), 0);
}

function httpMatches(policies: readonly OwnedRemotePolicy[], method: HttpMethod, path: string): RemoteRuleMatch[] {
  const matches: RemoteRuleMatch[] = [];
  for (const owned of policies) {
    for (const rule of owned.policy.http) {
      if (!rule.methods.includes(method)) continue;
      if (matchRemotePath(rule.path, path)) matches.push({ owner: owned.owner, rule });
    }
  }
  return matches;
}

function matchesAreAmbiguous(matches: readonly RemoteRuleMatch[]): boolean {
  const first = matches[0];
  if (!first) return false;
  return matches.some((match) =>
    match.owner !== first.owner
    || match.rule.capability !== first.rule.capability
    || match.rule.mutation !== first.rule.mutation
    || match.rule.maxBodyBytes !== first.rule.maxBodyBytes);
}

function selectHttpMatch(matches: readonly RemoteRuleMatch[]): RemoteRuleMatch | null {
  if (matches.length === 0) return null;
  if (matchesAreAmbiguous(matches)) {
    throw new AuthorizationError("forbidden", "not allowed");
  }
  return [...matches].sort((left, right) => {
    const spec = patternSpecificity(right.rule.path) - patternSpecificity(left.rule.path);
    if (spec !== 0) return spec;
    const path = left.rule.path.localeCompare(right.rule.path);
    if (path !== 0) return path;
    return left.owner.localeCompare(right.owner);
  })[0] ?? null;
}

export function findRemoteHttpRule(
  policies: readonly OwnedRemotePolicy[],
  method: string,
  path: string,
): RemoteRuleMatch | null {
  if (!isHttpMethod(method)) return null;
  return selectHttpMatch(httpMatches(policies, method, path));
}

export function assertPairedHttpAllowed(
  principal: AuthPrincipal,
  method: string,
  path: string,
  policies: readonly OwnedRemotePolicy[],
  bodyBytes?: number,
): RemoteRuleMatch {
  if (principal.kind !== "paired-device") {
    throw new AuthorizationError("forbidden", "not allowed");
  }
  const match = findRemoteHttpRule(policies, method, path);
  if (!match) {
    throw new AuthorizationError("forbidden", "not allowed");
  }
  if (!principal.grants.includes(match.rule.capability)) {
    throw new AuthorizationError("forbidden", "not allowed");
  }
  if (match.rule.maxBodyBytes !== undefined && bodyBytes !== undefined && bodyBytes > match.rule.maxBodyBytes) {
    throw Object.assign(new Error("request body too large"), { code: "payload-too-large" });
  }
  return match;
}

export function findRemotePolicyOverlaps(policies: readonly OwnedRemotePolicy[]): string[] {
  const overlaps: string[] = [];
  for (let i = 0; i < policies.length; i++) {
    const left = policies[i]!;
    for (const leftRule of left.policy.http) {
      for (let j = i; j < policies.length; j++) {
        const right = policies[j]!;
        for (const rightRule of right.policy.http) {
          if (left.owner === right.owner && leftRule === rightRule) continue;
          if (!remotePathPatternsOverlap(leftRule.path, rightRule.path)) continue;
          const methods = leftRule.methods.filter((method) => rightRule.methods.includes(method));
          if (methods.length === 0) continue;
          const ambiguous = left.owner !== right.owner
            || leftRule.capability !== rightRule.capability
            || leftRule.mutation !== rightRule.mutation
            || leftRule.maxBodyBytes !== rightRule.maxBodyBytes;
          if (ambiguous) {
            overlaps.push(`${left.owner} ∩ ${right.owner}: ${methods.sort().join(",")} ${leftRule.path} ~ ${rightRule.path}`);
          }
        }
      }
    }
  }
  return overlaps;
}

export function allRemotePolicies(packagePolicies: readonly OwnedRemotePolicy[]): OwnedRemotePolicy[] {
  return [{ owner: "core", policy: CORE_REMOTE_ACCESS }, ...packagePolicies];
}

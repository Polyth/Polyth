import {
  matchRemotePath,
  REMOTE_CAPABILITY,
  type AuthPrincipal,
  type HttpMethod,
  type RemoteAccessPolicy,
  type RemoteHttpRule,
  type RemoteWebSocketRule,
} from "@polyth/contracts";
import { AuthorizationError } from "./auth.ts";

const METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export function isHttpMethod(value: string): value is HttpMethod {
  return (METHODS as readonly string[]).includes(value);
}

export function validateRemoteAccessPolicy(owner: string, policy: RemoteAccessPolicy): void {
  if (!Array.isArray(policy.routeScopes) || policy.routeScopes.some((s) => typeof s !== "string" || !s)) {
    throw Object.assign(new Error(`package "${owner}" remoteAccess.routeScopes is invalid`), { code: "invalid-input" });
  }
  for (const rule of policy.http) {
    if (!rule.path.startsWith("/") || !matchRemotePath(rule.path, rule.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, "x"))) {
      throw Object.assign(new Error(`package "${owner}" remote HTTP path is invalid: ${rule.path}`), { code: "invalid-input" });
    }
    if (!rule.capability.includes(".")) {
      throw Object.assign(new Error(`package "${owner}" remote capability is invalid: ${rule.capability}`), { code: "invalid-input" });
    }
    if (!rule.methods.every((m) => isHttpMethod(m))) {
      throw Object.assign(new Error(`package "${owner}" remote HTTP methods are invalid`), { code: "invalid-input" });
    }
  }
  for (const rule of policy.websocket ?? []) {
    if (!rule.path.startsWith("/ws")) {
      throw Object.assign(new Error(`package "${owner}" remote WebSocket path must start with /ws`), { code: "invalid-input" });
    }
  }
}

export const CORE_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: ["core"],
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
    { methods: ["GET"], path: "/api/notifications", capability: REMOTE_CAPABILITY.coreNotificationsRead, mutation: false },
    { methods: ["POST"], path: "/api/notifications/read", capability: REMOTE_CAPABILITY.coreNotificationsRead, mutation: true },
    { methods: ["POST"], path: "/api/notifications/read-all", capability: REMOTE_CAPABILITY.coreNotificationsRead, mutation: true },
    { methods: ["POST"], path: "/api/notifications/clear", capability: REMOTE_CAPABILITY.coreNotificationsRead, mutation: true },
    { methods: ["GET"], path: "/api/packages", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    { methods: ["GET"], path: "/api/folders", capability: REMOTE_CAPABILITY.coreProjectsRead, mutation: false },
    { methods: ["GET"], path: "/api/labels", capability: REMOTE_CAPABILITY.coreProjectsRead, mutation: false },
    { methods: ["GET"], path: "/api/search/workspaces", capability: REMOTE_CAPABILITY.coreProjectsRead, mutation: false },
    { methods: ["GET"], path: "/api/search/sessions", capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
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
  "/api/control",
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

export function findRemoteHttpRule(
  policies: readonly OwnedRemotePolicy[],
  method: string,
  path: string,
): RemoteRuleMatch | null {
  if (!isHttpMethod(method)) return null;
  for (const owned of policies) {
    for (const rule of owned.policy.http) {
      if (!rule.methods.includes(method)) continue;
      if (matchRemotePath(rule.path, path)) return { owner: owned.owner, rule };
    }
  }
  return null;
}

export function findRemoteWebSocketRule(
  policies: readonly OwnedRemotePolicy[],
  path: string,
): { owner: string; rule: RemoteWebSocketRule } | null {
  for (const owned of policies) {
    for (const rule of owned.policy.websocket ?? []) {
      if (matchRemotePath(rule.path, path)) return { owner: owned.owner, rule };
    }
  }
  return null;
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

export function assertPairedWebSocketAllowed(
  principal: AuthPrincipal,
  path: string,
  policies: readonly OwnedRemotePolicy[],
): { owner: string; rule: RemoteWebSocketRule } {
  if (principal.kind !== "paired-device") {
    throw new AuthorizationError("forbidden", "not allowed");
  }
  const match = findRemoteWebSocketRule(policies, path);
  if (!match || !principal.grants.includes(match.rule.capability)) {
    throw new AuthorizationError("forbidden", "not allowed");
  }
  return match;
}

export function capabilityIdsFromPolicies(policies: readonly OwnedRemotePolicy[]): string[] {
  const ids = new Set<string>();
  for (const owned of policies) {
    for (const rule of owned.policy.http) ids.add(rule.capability);
    for (const rule of owned.policy.websocket ?? []) ids.add(rule.capability);
  }
  return [...ids].sort();
}

export function findRemotePolicyOverlaps(policies: readonly OwnedRemotePolicy[]): string[] {
  const seen = new Map<string, string>();
  const overlaps: string[] = [];
  for (const owned of policies) {
    for (const rule of owned.policy.http) {
      const key = `${rule.methods.slice().sort().join(",")}|${rule.path}`;
      const previous = seen.get(key);
      if (previous && previous !== owned.owner) overlaps.push(`${previous} ∩ ${owned.owner}: ${key}`);
      else seen.set(key, owned.owner);
    }
  }
  return overlaps;
}

import { controlError, type ControlPlane } from "./index.ts";
import type {
  CanonicalResource,
  ResourceLifecycle,
  ResourceRegistry,
} from "./resources.ts";

/** One principal's access to a resource, lowest first: `view` reads it,
 *  `collaborate` also works in it, `manage` also shares and administers it. */
export type ResourceAccessLevel = "view" | "collaborate" | "manage";
export const RESOURCE_ACCESS_LEVELS: readonly ResourceAccessLevel[] = ["view", "collaborate", "manage"];
export const isResourceAccessLevel = (value: unknown): value is ResourceAccessLevel =>
  typeof value === "string" && (RESOURCE_ACCESS_LEVELS as readonly string[]).includes(value);
export const accessAtLeast = (level: ResourceAccessLevel | undefined, required: ResourceAccessLevel): boolean =>
  level !== undefined && RESOURCE_ACCESS_LEVELS.indexOf(level) >= RESOURCE_ACCESS_LEVELS.indexOf(required);

export interface ResourceAccessInput {
  resourceId: string;
  principalId: string;
  orgId: string;
  spaceId: string;
  /** Internal recovery callers may admit transitional states while preserving
   * every ownership/visibility/membership check. Defaults to active+archived. */
  lifecycles?: readonly ResourceLifecycle[];
}

export interface ResourceAccess {
  resource: CanonicalResource;
  level: ResourceAccessLevel;
}

export interface ResourceAccessAuthority {
  readable(input: ResourceAccessInput): CanonicalResource | undefined;
  requireReadable(input: ResourceAccessInput): CanonicalResource;
  /** The principal's effective access, or undefined when it cannot read. */
  access(input: ResourceAccessInput): ResourceAccess | undefined;
  /**
   * `access` for many resources of one principal in one scope: each call
   * decides, and throws, exactly as `access` with that `resourceId` would.
   * The rows of `resourceIds`, the principal's kind, membership, grants and
   * project policy are read once for the pass, so use it within one
   * synchronous pass only: it never sees a write made after it read.
   */
  accessPass(input: Omit<ResourceAccessInput, "resourceId">, resourceIds: readonly string[]): (resourceId: string) => ResourceAccess | undefined;
}

/** What one access decision reads; the pass memoizes the same reads. */
interface AccessReads {
  resource(resourceId: string): CanonicalResource | undefined;
  principalKind(principalId: string): string | undefined;
  membershipRole(principalId: string, spaceId: string): string | undefined;
  grantOf(resourceId: string, principalId: string): ResourceAccessLevel | undefined;
  projectAllowed: ((principalId: string, projectId: string) => boolean) | undefined;
}

const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/;
const LIFECYCLES = new Set<ResourceLifecycle>([
  "provisioning", "active", "archiving", "archived", "deleting", "deleted", "quarantined",
]);
const DEFAULT_READABLE: readonly ResourceLifecycle[] = ["active", "archived"];
/** Ids per batched grant read in an access pass; one bound JSON array each. */
const GRANT_BATCH = 500;
const id = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw controlError("invalid-input", `Invalid ${label}`);
  return value;
};
const allowedLifecycles = (value: readonly ResourceLifecycle[] | undefined): ReadonlySet<ResourceLifecycle> => {
  const source = value ?? DEFAULT_READABLE;
  if (source.length === 0 || source.some((state) => !LIFECYCLES.has(state))) {
    throw controlError("invalid-input", "Invalid readable resource lifecycle");
  }
  return new Set(source);
};
const higher = (a: ResourceAccessLevel | undefined, b: ResourceAccessLevel | undefined): ResourceAccessLevel | undefined =>
  a === undefined ? b : b === undefined ? a : accessAtLeast(a, b) ? a : b;

/**
 * Canonical access policy (Spaces §14.3). Every human path requires an active
 * Space membership; then:
 *
 * - the owner manages the resource;
 * - `private` admits nobody else (grants are ignored there);
 * - `restricted` admits exactly the principals with a grant;
 * - `space` admits every member — Space admins manage, members collaborate,
 *   viewers view — and a grant can raise one person above that;
 * - `inherit` follows the access parent (or the registry parent), which makes
 *   sessions follow their project and delegated subagents their parent chat
 *   without duplicating ACL state; a grant on the row itself can raise it.
 *
 * A viewer membership never acts above `view`, whatever a grant says.
 */
export function createResourceAccessAuthority(
  control: ControlPlane,
  resources: ResourceRegistry,
  opts: {
    now?: () => number;
    /** Host policy: may this human principal use this project at all? An
     *  owner-set per-account project list narrows every resource under the
     *  project, including the principal's own. Absent = every project. */
    projectAllowed?: (principalId: string, projectId: string) => boolean;
  } = {},
): ResourceAccessAuthority {
  const now = opts.now ?? Date.now;
  const projectAllowed = opts.projectAllowed;

  /** The project a resource lives under (itself for a project), if any. */
  const projectOf = (reads: AccessReads, row: CanonicalResource): string | undefined => {
    let current: CanonicalResource | undefined = row;
    for (let depth = 0; current && depth < 32; depth += 1) {
      if (current.kind === "project") return current.id;
      if (!current.parentId) return undefined;
      current = reads.resource(current.parentId);
    }
    throw controlError("recovery-required", "Resource ancestry is inconsistent");
  };

  const membershipRole = (principalId: string, spaceId: string): string | undefined => control.get<{ role: string }>(
    `SELECT role FROM space_memberships
      WHERE space_id=? AND principal_id=? AND state='active'
        AND (expires_at_ms IS NULL OR expires_at_ms>?)`,
    spaceId,
    principalId,
    now(),
  )?.role;
  const principalKind = (principalId: string): string | undefined => control.get<{ kind: string }>(
    "SELECT kind FROM principals WHERE id=? AND status='active'",
    principalId,
  )?.kind;
  const grantOf = (resourceId: string, principalId: string): ResourceAccessLevel | undefined => {
    const access = control.get<{ access: string }>(
      `SELECT access FROM resource_grants
        WHERE resource_id=? AND principal_id=? AND (expires_at_ms IS NULL OR expires_at_ms>?)`,
      resourceId,
      principalId,
      now(),
    )?.access;
    return isResourceAccessLevel(access) ? access : undefined;
  };
  const spaceWide = (role: string): ResourceAccessLevel =>
    role === "owner" || role === "admin" ? "manage" : role === "member" ? "collaborate" : "view";

  const levelOf = (
    reads: AccessReads,
    row: CanonicalResource,
    principalId: string,
    role: string,
    seen: Set<string>,
  ): ResourceAccessLevel | undefined => {
    if (row.ownerPrincipalId === principalId) return "manage";
    if (row.visibility === "private") return undefined;
    const granted = reads.grantOf(row.id, principalId);
    if (row.visibility === "restricted") return granted;
    if (row.visibility === "space") return higher(granted, spaceWide(role));
    const parentId = row.accessParentId ?? row.parentId;
    if (!parentId || seen.has(row.id) || seen.size >= 32) {
      throw controlError("recovery-required", "Resource visibility inheritance is inconsistent");
    }
    seen.add(row.id);
    const parent = reads.resource(parentId);
    if (!parent) throw controlError("recovery-required", "Inherited resource parent is missing");
    if (parent.orgId !== row.orgId || parent.spaceId !== row.spaceId) return granted;
    // A child may be in a transient lifecycle while its parent remains active,
    // so parent visibility uses normal readable lifecycle semantics.
    if (!DEFAULT_READABLE.includes(parent.lifecycle)) return granted;
    return higher(granted, levelOf(reads, parent, principalId, role, seen));
  };

  const scopeOf = (raw: Omit<ResourceAccessInput, "resourceId">) => ({
    principalId: id(raw.principalId, "principal ID"),
    orgId: id(raw.orgId, "organization ID"),
    spaceId: id(raw.spaceId, "Space ID"),
    lifecycles: allowedLifecycles(raw.lifecycles),
  });
  type Scope = ReturnType<typeof scopeOf>;

  const decide = (reads: AccessReads, input: Scope, resourceId: string): ResourceAccess | undefined => {
    const row = reads.resource(resourceId);
    if (!row) return undefined;
    if (row.orgId !== input.orgId || row.spaceId !== input.spaceId) return undefined;
    if (!input.lifecycles.has(row.lifecycle)) return undefined;
    // Durable system principals are the runtime itself. They intentionally have
    // no Space membership, so background work reads inside the Space it was
    // already scoped to instead of impersonating a member.
    if (reads.principalKind(input.principalId) === "system") return { resource: row, level: "manage" };
    if (reads.projectAllowed) {
      const projectId = projectOf(reads, row);
      if (projectId !== undefined && !reads.projectAllowed(input.principalId, projectId)) return undefined;
    }
    // Human access, ownership included, never outlives tenant membership.
    const role = reads.membershipRole(input.principalId, input.spaceId);
    if (role === undefined) return undefined;
    const level = levelOf(reads, row, input.principalId, role, new Set());
    if (level === undefined) return undefined;
    return { resource: row, level: role === "viewer" || role === "reference" ? "view" : level };
  };

  const direct: AccessReads = {
    resource: (resourceId) => resources.resource(resourceId),
    principalKind,
    membershipRole,
    grantOf,
    projectAllowed,
  };

  const access = (raw: ResourceAccessInput): ResourceAccess | undefined => {
    const resourceId = id(raw.resourceId, "resource ID");
    return decide(direct, scopeOf(raw), resourceId);
  };

  const accessPass = (
    raw: Omit<ResourceAccessInput, "resourceId">,
    resourceIds: readonly string[],
  ): ((resourceId: string) => ResourceAccess | undefined) => {
    // Invalid scope fails every call, as it fails every `access` call.
    let scope: Scope | undefined;
    let scopeError: unknown;
    try { scope = scopeOf(raw); } catch (cause) { scopeError = cause; }
    const rows = new Map<string, CanonicalResource | undefined>();
    if (scope) {
      const valid = resourceIds.filter((resourceId) => typeof resourceId === "string" && IDENTIFIER.test(resourceId));
      const found = resources.resourcesByIds(valid);
      for (const resourceId of valid) rows.set(resourceId, found.get(resourceId));
    }
    const kinds = new Map<string, string | undefined>();
    const roles = new Map<string, string | undefined>();
    const allowed = new Map<string, boolean>();
    const grants = new Map<string, Map<string, ResourceAccessLevel | undefined>>();
    const memo = <K, V>(map: Map<K, V>, key: K, read: () => V): V => {
      if (map.has(key)) return map.get(key) as V;
      const value = read();
      map.set(key, value);
      return value;
    };
    const reads: AccessReads = {
      resource: (resourceId) => memo(rows, resourceId, () => resources.resource(resourceId)),
      principalKind: (principalId) => memo(kinds, principalId, () => principalKind(principalId)),
      membershipRole: (principalId, spaceId) => memo(roles, `${principalId}\n${spaceId}`, () => membershipRole(principalId, spaceId)),
      // The principal's unexpired grants on the pass's rows in one read: the
      // same rows `grantOf` finds one at a time. Any other resource (an
      // ancestor) is read on its own, once.
      grantOf: (resourceId, principalId) => {
        let held = grants.get(principalId);
        if (!held) {
          held = new Map();
          const listed = [...rows.keys()];
          for (let start = 0; start < listed.length; start += GRANT_BATCH) {
            for (const grant of control.all<{ resource_id: string; access: string }>(
              `SELECT resource_id,access FROM resource_grants
                WHERE principal_id=? AND resource_id IN (SELECT value FROM json_each(?))
                  AND (expires_at_ms IS NULL OR expires_at_ms>?)`,
              principalId,
              JSON.stringify(listed.slice(start, start + GRANT_BATCH)),
              now(),
            )) held.set(grant.resource_id, isResourceAccessLevel(grant.access) ? grant.access : undefined);
            for (const listedId of listed.slice(start, start + GRANT_BATCH)) if (!held.has(listedId)) held.set(listedId, undefined);
          }
          grants.set(principalId, held);
        }
        if (!held.has(resourceId)) held.set(resourceId, grantOf(resourceId, principalId));
        return held.get(resourceId);
      },
      projectAllowed: projectAllowed
        ? (principalId, projectId) => memo(allowed, `${principalId}\n${projectId}`, () => projectAllowed(principalId, projectId))
        : undefined,
    };
    return (resourceId) => {
      const checked = id(resourceId, "resource ID");
      if (!scope) throw scopeError;
      return decide(reads, scope, checked);
    };
  };

  const readable = (input: ResourceAccessInput): CanonicalResource | undefined => access(input)?.resource;

  return {
    readable,
    access,
    accessPass,
    requireReadable(input) {
      const row = readable(input);
      if (!row) throw controlError("not-found", "Resource not found");
      return row;
    },
  };
}

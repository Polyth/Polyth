import { controlError, type ControlPlane } from "./index.ts";
import type { CanonicalResource, ResourceRegistry } from "./resources.ts";

export interface ResourceAccessInput {
  resourceId: string;
  principalId: string;
  orgId: string;
  spaceId: string;
}

export interface ResourceAccessAuthority {
  readable(input: ResourceAccessInput): CanonicalResource | undefined;
  requireReadable(input: ResourceAccessInput): CanonicalResource;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const id = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw controlError("invalid-input", `Invalid ${label}`);
  return value;
};

/**
 * Minimal canonical read policy. Resource-specific grants/policy documents can
 * extend `restricted` later without changing callers; until then it is safely
 * owner-only. `inherit` follows the immutable parent chain and therefore makes
 * sessions inherit project visibility without duplicating ACL state.
 */
export function createResourceAccessAuthority(
  control: ControlPlane,
  resources: ResourceRegistry,
  opts: { now?: () => number } = {},
): ResourceAccessAuthority {
  const now = opts.now ?? Date.now;

  const member = (principalId: string, spaceId: string): boolean => !!control.get(
    `SELECT 1 FROM space_memberships
      WHERE space_id=? AND principal_id=? AND state='active'
        AND (expires_at_ms IS NULL OR expires_at_ms>?)`,
    spaceId,
    principalId,
    now(),
  );

  const visible = (
    row: CanonicalResource,
    principalId: string,
    orgId: string,
    spaceId: string,
    seen: Set<string>,
  ): boolean => {
    if (row.orgId !== orgId || row.spaceId !== spaceId) return false;
    if (row.lifecycle !== "active" && row.lifecycle !== "archived") return false;
    if (row.ownerPrincipalId === principalId) return true;
    if (row.visibility === "private" || row.visibility === "restricted") return false;
    if (row.visibility === "space") return member(principalId, spaceId);
    if (!row.parentId || seen.has(row.id) || seen.size >= 32) {
      throw controlError("recovery-required", "Resource visibility inheritance is inconsistent");
    }
    seen.add(row.id);
    const parent = resources.resource(row.parentId);
    if (!parent) throw controlError("recovery-required", "Inherited resource parent is missing");
    return visible(parent, principalId, orgId, spaceId, seen);
  };

  const readable = (raw: ResourceAccessInput): CanonicalResource | undefined => {
    const input = {
      resourceId: id(raw.resourceId, "resource ID"),
      principalId: id(raw.principalId, "principal ID"),
      orgId: id(raw.orgId, "organization ID"),
      spaceId: id(raw.spaceId, "Space ID"),
    };
    const row = resources.resource(input.resourceId);
    if (!row) return undefined;
    return visible(row, input.principalId, input.orgId, input.spaceId, new Set()) ? row : undefined;
  };

  return {
    readable,
    requireReadable(input) {
      const row = readable(input);
      if (!row) throw controlError("not-found", "Resource not found");
      return row;
    },
  };
}

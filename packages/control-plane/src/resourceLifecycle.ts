import { controlError, type ControlPlane } from "./index.ts";
import type {
  CanonicalResource,
  ResourceLifecycle,
  ResourceRegistry,
} from "./resources.ts";

const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/;
const KIND = /^[a-z][a-z0-9.-]{0,63}$/;
const ALLOWED: Readonly<Record<ResourceLifecycle, readonly ResourceLifecycle[]>> = {
  provisioning: [],
  active: ["archiving", "deleting"],
  archiving: ["active", "archived"],
  archived: ["active", "deleting"],
  deleting: ["active", "archived", "deleted"],
  deleted: [],
  quarantined: [],
};

const identifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw controlError("invalid-input", `Invalid ${label}`);
  return value;
};
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw controlError("invalid-input", "Invalid resource revision");
  return Number(value);
};
const kind = (value: unknown): string => {
  if (typeof value !== "string" || !KIND.test(value)) throw controlError("invalid-input", "Invalid resource kind");
  return value;
};

export interface ResourceLifecycleTransition {
  resourceId: string;
  kind: string;
  orgId: string;
  spaceId: string;
  from: readonly ResourceLifecycle[];
  to: ResourceLifecycle;
  expectedRevision: number;
  actor: string;
  action: string;
  /** Entering/exiting visibility-bearing lifecycle normally revokes cached grants. */
  bumpAccess?: boolean;
}

export interface ResourceLifecycleAuthority {
  transition(input: ResourceLifecycleTransition): CanonicalResource;
}

/**
 * Revision-checked post-provisioning lifecycle authority. Provisioning and
 * quarantine have their own receipt-backed ResourceRegistry protocol; this
 * seam intentionally cannot skip that protocol or resurrect deleted rows.
 */
export function createResourceLifecycleAuthority(
  control: ControlPlane,
  resources: ResourceRegistry,
  opts: { now?: () => number } = {},
): ResourceLifecycleAuthority {
  const now = opts.now ?? Date.now;
  return {
    transition(raw) {
      const input = {
        resourceId: identifier(raw.resourceId, "resource ID"),
        kind: kind(raw.kind),
        orgId: identifier(raw.orgId, "organization ID"),
        spaceId: identifier(raw.spaceId, "Space ID"),
        from: [...raw.from],
        to: raw.to,
        expectedRevision: revision(raw.expectedRevision),
        actor: identifier(raw.actor, "actor"),
        action: identifier(raw.action, "audit action"),
        bumpAccess: raw.bumpAccess !== false,
      };
      if (input.from.length === 0 || !Object.hasOwn(ALLOWED, input.to)
        || input.from.some((state) => !Object.hasOwn(ALLOWED, state))) {
        throw controlError("invalid-input", "Invalid resource lifecycle transition");
      }
      for (const from of input.from) {
        if (!ALLOWED[from].includes(input.to)) throw controlError("invalid-transition", "Resource lifecycle transition is not allowed");
      }
      const current = resources.resource(input.resourceId);
      if (!current) throw controlError("not-found", "Resource not found");
      if (current.kind !== input.kind || current.orgId !== input.orgId || current.spaceId !== input.spaceId) {
        throw controlError("not-found", "Resource not found in requested scope");
      }
      if (!input.from.includes(current.lifecycle)) throw controlError("invalid-transition", "Resource lifecycle changed");
      if (current.revision !== input.expectedRevision) throw controlError("conflict", "Resource revision is stale");
      const placeholders = input.from.map(() => "?").join(",");
      return control.transaction(() => {
        // A parent cannot disappear while a durable child still depends on it.
        // BEGIN IMMEDIATE makes this check and the lifecycle write one writer
        // critical section, so a concurrent child cannot race in afterward.
        if (input.to === "deleting" && control.get(
          "SELECT 1 FROM resources WHERE parent_id=? AND lifecycle<>'deleted' LIMIT 1",
          input.resourceId,
        )) {
          throw controlError("conflict", "Delete child resources before deleting their parent");
        }
        const changes = control.run(
          `UPDATE resources
              SET lifecycle=?,revision=revision+1,access_revision=access_revision+?,updated_at_ms=?
            WHERE id=? AND kind=? AND org_id=? AND space_id=? AND revision=?
              AND lifecycle IN (${placeholders})`,
          input.to,
          input.bumpAccess ? 1 : 0,
          now(),
          input.resourceId,
          input.kind,
          input.orgId,
          input.spaceId,
          input.expectedRevision,
          ...input.from,
        ).changes;
        if (Number(changes) !== 1) throw controlError("conflict", "Resource state changed; retry from current state");
        control.audit(input.actor, input.action, input.resourceId);
        const updated = resources.resource(input.resourceId);
        if (!updated) throw controlError("recovery-required", "Resource lifecycle update was not durable");
        return updated;
      });
    },
  };
}

import { controlError, type ControlPlane } from "./index.ts";
import { isResourceAccessLevel, type ResourceAccessLevel } from "./resourceAccess.ts";
import type { CanonicalResource, ResourceRegistry, ResourceVisibility } from "./resources.ts";

/** A principal given access to one resource by name. */
export interface ResourceGrant {
  principalId: string;
  access: ResourceAccessLevel;
  grantedBy: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

/** How a Space shares its content (Spaces §14.3). */
export interface SpaceSharingPolicyRecord {
  defaultVisibility: "private" | "space";
  allowSpaceVisibility: boolean;
  membersMayShare: boolean;
  maxMemberAccess: ResourceAccessLevel;
  /** 0 until an admin first saves the policy. */
  revision: number;
}

export const DEFAULT_SHARING_POLICY: Readonly<Omit<SpaceSharingPolicyRecord, "revision">> = Object.freeze({
  defaultVisibility: "private",
  allowSpaceVisibility: true,
  membersMayShare: true,
  maxMemberAccess: "manage",
});

export interface ShareResourceInput {
  resourceId: string;
  orgId: string;
  spaceId: string;
  /** Already authorized by the caller; recorded as the granting principal. */
  actor: string;
  /** Rejects the change when the resource's access changed since this revision. */
  expectedAccessRevision?: number;
  visibility?: Exclude<ResourceVisibility, "inherit"> | "inherit";
  /** The complete people list; omitted keeps the current one. */
  grants?: ReadonlyArray<{ principalId: string; access: ResourceAccessLevel }>;
}

export interface ResourceSharingAuthority {
  policy(spaceId: string): SpaceSharingPolicyRecord;
  /** Persist a policy change; the caller has checked the actor is a Space admin. */
  setPolicy(input: {
    spaceId: string;
    actor: string;
    expectedRevision?: number;
    patch: Partial<Omit<SpaceSharingPolicyRecord, "revision">>;
  }): SpaceSharingPolicyRecord;
  grants(resourceId: string): ResourceGrant[];
  /**
   * Change who can open a resource in one transaction. Grants name active
   * human members of the resource's Space other than its owner. Making a
   * resource private removes every grant. The caller authorizes the actor;
   * this only keeps the stored state consistent.
   */
  share(input: ShareResourceInput): { resource: CanonicalResource; grants: ResourceGrant[] };
  /** Give private/restricted rows owned by a non-person back to the member
   *  who last narrowed them; returns their ids. Startup repair. */
  reclaimUnreachable(): string[];
  /** Set, once, the resource whose access an inheriting row follows. */
  adoptAccessParent(resourceId: string, accessParentId: string): CanonicalResource;
  /** Rows whose access follows `resourceId` directly. */
  accessChildren(resourceId: string): string[];
}

const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/;
const MAX_GRANTS = 200;
const identifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw controlError("invalid-input", `Invalid ${label}`);
  return value;
};

type PolicyRow = {
  default_visibility: "private" | "space";
  allow_space_visibility: number;
  members_may_share: number;
  max_member_access: string;
  revision: number;
};
type GrantRow = {
  principal_id: string; access: string; granted_by: string;
  created_at_ms: number; updated_at_ms: number; revision: number;
};

export function createResourceSharingAuthority(
  control: ControlPlane,
  resources: ResourceRegistry,
  opts: { now?: () => number } = {},
): ResourceSharingAuthority {
  const now = opts.now ?? Date.now;

  const policy = (spaceId: string): SpaceSharingPolicyRecord => {
    const row = control.get<PolicyRow>(
      `SELECT default_visibility,allow_space_visibility,members_may_share,max_member_access,revision
         FROM space_sharing_policies WHERE space_id=?`,
      identifier(spaceId, "Space ID"),
    );
    if (!row) return { ...DEFAULT_SHARING_POLICY, revision: 0 };
    return {
      defaultVisibility: row.default_visibility === "space" ? "space" : "private",
      allowSpaceVisibility: row.allow_space_visibility === 1,
      membersMayShare: row.members_may_share === 1,
      maxMemberAccess: isResourceAccessLevel(row.max_member_access) ? row.max_member_access : "view",
      revision: row.revision,
    };
  };

  const grants = (resourceId: string): ResourceGrant[] => control.all<GrantRow>(
    `SELECT principal_id,access,granted_by,created_at_ms,updated_at_ms,revision
       FROM resource_grants WHERE resource_id=? AND (expires_at_ms IS NULL OR expires_at_ms>?)
      ORDER BY created_at_ms,principal_id`,
    identifier(resourceId, "resource ID"),
    now(),
  ).flatMap((row) => isResourceAccessLevel(row.access) ? [{
    principalId: row.principal_id,
    access: row.access,
    grantedBy: row.granted_by,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    revision: row.revision,
  }] : []);

  const activeHumanMember = (principalId: string, spaceId: string): boolean => !!control.get(
    `SELECT 1 FROM space_memberships m JOIN principals p ON p.id=m.principal_id
      WHERE m.space_id=? AND m.principal_id=? AND m.state='active'
        AND m.role IN ('owner','admin','member','viewer')
        AND (m.expires_at_ms IS NULL OR m.expires_at_ms>?)
        AND p.kind='user' AND p.status='active'`,
    spaceId,
    principalId,
    now(),
  );

  const humanPrincipal = (principalId: string): boolean => !!control.get(
    "SELECT 1 FROM principals WHERE id=? AND kind='user'",
    principalId,
  );

  return {
    policy,
    grants,
    reclaimUnreachable() {
      // Before `share` adopted them, narrowing a chat server work owns left it
      // owned by a system principal that no person is: invisible to everyone.
      // Hand each one to the member who last narrowed it.
      const rows = control.all<{ id: string; space_id: string; revision: number; actor: string | null }>(
        `SELECT r.id,r.space_id,r.revision,(SELECT a.actor_id FROM audit_events a
            WHERE a.resource_id=r.id AND a.action='resource.shared' ORDER BY a.seq DESC LIMIT 1) AS actor
           FROM resources r JOIN principals p ON p.id=r.owner_principal_id
          WHERE r.visibility IN ('private','restricted') AND p.kind<>'user' AND r.lifecycle<>'deleted'`,
      );
      const reclaimed: string[] = [];
      for (const row of rows) {
        if (!row.actor || !activeHumanMember(row.actor, row.space_id)) continue;
        control.transaction(() => {
          const changes = control.run(
            `UPDATE resources SET owner_principal_id=?,access_revision=access_revision+1,revision=revision+1,updated_at_ms=?
              WHERE id=? AND revision=?`,
            row.actor, now(), row.id, row.revision,
          ).changes;
          if (Number(changes) !== 1) return;
          control.audit("system:resource-reconciler", "resource.owner-adopted", row.id);
          reclaimed.push(row.id);
        });
      }
      return reclaimed;
    },
    setPolicy(raw) {
      const spaceId = identifier(raw.spaceId, "Space ID");
      const actor = identifier(raw.actor, "actor");
      const current = policy(spaceId);
      if (raw.expectedRevision !== undefined && raw.expectedRevision !== current.revision) {
        throw controlError("conflict", "The sharing policy changed; reload it and try again");
      }
      const patch = raw.patch;
      const next = {
        defaultVisibility: patch.defaultVisibility ?? current.defaultVisibility,
        allowSpaceVisibility: patch.allowSpaceVisibility ?? current.allowSpaceVisibility,
        membersMayShare: patch.membersMayShare ?? current.membersMayShare,
        maxMemberAccess: patch.maxMemberAccess ?? current.maxMemberAccess,
      };
      if (next.defaultVisibility !== "private" && next.defaultVisibility !== "space") {
        throw controlError("invalid-input", "Invalid default visibility");
      }
      if (typeof next.allowSpaceVisibility !== "boolean" || typeof next.membersMayShare !== "boolean") {
        throw controlError("invalid-input", "Invalid sharing policy");
      }
      if (!isResourceAccessLevel(next.maxMemberAccess)) throw controlError("invalid-input", "Invalid access level");
      if (!next.allowSpaceVisibility && next.defaultVisibility === "space") {
        throw controlError("invalid-input", "New chats cannot default to the whole Space when Space-wide sharing is off");
      }
      return control.transaction(() => {
        if (!control.get("SELECT 1 FROM spaces WHERE id=?", spaceId)) throw controlError("not-found", "Space not found");
        const raced = policy(spaceId);
        if (raced.revision !== current.revision) throw controlError("conflict", "The sharing policy changed; reload it and try again");
        control.run(
          `INSERT INTO space_sharing_policies(space_id,default_visibility,allow_space_visibility,members_may_share,
             max_member_access,revision,updated_by,updated_at_ms)
           VALUES(?,?,?,?,?,1,?,?)
           ON CONFLICT(space_id) DO UPDATE SET default_visibility=excluded.default_visibility,
             allow_space_visibility=excluded.allow_space_visibility,members_may_share=excluded.members_may_share,
             max_member_access=excluded.max_member_access,revision=space_sharing_policies.revision+1,
             updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms`,
          spaceId, next.defaultVisibility, next.allowSpaceVisibility ? 1 : 0, next.membersMayShare ? 1 : 0,
          next.maxMemberAccess, actor, now(),
        );
        control.audit(actor, "space.sharing-policy-set", spaceId);
        return policy(spaceId);
      });
    },
    share(raw) {
      const resourceId = identifier(raw.resourceId, "resource ID");
      const orgId = identifier(raw.orgId, "organization ID");
      const spaceId = identifier(raw.spaceId, "Space ID");
      const actor = identifier(raw.actor, "actor");
      const visibility = raw.visibility;
      if (visibility !== undefined && !["private", "restricted", "space", "inherit"].includes(visibility)) {
        throw controlError("invalid-input", "Invalid resource visibility");
      }
      let wanted: Map<string, ResourceAccessLevel> | undefined;
      if (raw.grants !== undefined) {
        if (!Array.isArray(raw.grants) || raw.grants.length > MAX_GRANTS) throw controlError("invalid-input", "Invalid people list");
        wanted = new Map();
        for (const grant of raw.grants) {
          const principalId = identifier(grant?.principalId, "person");
          if (!isResourceAccessLevel(grant.access)) throw controlError("invalid-input", "Invalid access level");
          if (wanted.has(principalId)) throw controlError("invalid-input", "A person is listed twice");
          wanted.set(principalId, grant.access);
        }
      }
      return control.transaction(() => {
        const row = resources.resource(resourceId);
        if (!row || row.orgId !== orgId || row.spaceId !== spaceId) throw controlError("not-found", "Resource not found");
        if (row.lifecycle !== "active" && row.lifecycle !== "archived") throw controlError("conflict", "Resource is not shareable now");
        if (raw.expectedAccessRevision !== undefined && raw.expectedAccessRevision !== row.accessRevision) {
          throw controlError("conflict", "Sharing changed; reload it and try again");
        }
        const nextVisibility = visibility ?? row.visibility;
        if (nextVisibility === "inherit" && !row.parentId && !row.accessParentId) {
          throw controlError("invalid-input", "Nothing to inherit sharing from");
        }
        if (nextVisibility === "private") wanted = new Map();
        // Server work owns the chats it starts, and a system principal is no
        // person: narrowing such a chat would lock everyone out, the person
        // narrowing it included. They become its owner instead.
        const adopt = (nextVisibility === "private" || nextVisibility === "restricted")
          && !humanPrincipal(row.ownerPrincipalId) && activeHumanMember(actor, spaceId);
        const owner = adopt ? actor : row.ownerPrincipalId;
        if (adopt) wanted?.delete(actor);
        const time = now();
        let changed = nextVisibility !== row.visibility || adopt;
        if (wanted) {
          for (const [principalId] of wanted) {
            if (principalId === owner) throw controlError("invalid-input", "The owner already has access");
            if (!activeHumanMember(principalId, spaceId)) throw controlError("invalid-input", "Only members of this Space can be added");
          }
          const before = new Map(grants(resourceId).map((grant) => [grant.principalId, grant.access] as const));
          for (const principalId of before.keys()) {
            if (wanted.has(principalId)) continue;
            control.run("DELETE FROM resource_grants WHERE resource_id=? AND principal_id=?", resourceId, principalId);
            changed = true;
          }
          // Expired rows are invisible to `grants`; clear them so a re-grant starts clean.
          control.run(
            "DELETE FROM resource_grants WHERE resource_id=? AND expires_at_ms IS NOT NULL AND expires_at_ms<=?",
            resourceId, time,
          );
          for (const [principalId, access] of wanted) {
            if (before.get(principalId) === access) continue;
            control.run(
              `INSERT INTO resource_grants(resource_id,principal_id,access,granted_by,created_at_ms,updated_at_ms)
               VALUES(?,?,?,?,?,?)
               ON CONFLICT(resource_id,principal_id) DO UPDATE SET access=excluded.access,granted_by=excluded.granted_by,
                 updated_at_ms=excluded.updated_at_ms,expires_at_ms=NULL,revision=resource_grants.revision+1`,
              resourceId, principalId, access, actor, time, time,
            );
            changed = true;
          }
        }
        if (!changed) return { resource: row, grants: grants(resourceId) };
        const updated = control.run(
          `UPDATE resources SET visibility=?,owner_principal_id=?,access_revision=access_revision+1,revision=revision+1,
             updated_at_ms=? WHERE id=? AND revision=?`,
          nextVisibility, owner, time, resourceId, row.revision,
        ).changes;
        if (Number(updated) !== 1) throw controlError("conflict", "Resource state changed; retry from current state");
        if (adopt) control.audit(actor, "resource.owner-adopted", resourceId);
        control.audit(actor, "resource.shared", resourceId);
        const current = resources.resource(resourceId);
        if (!current) throw controlError("recovery-required", "Resource sharing update was not durable");
        return { resource: current, grants: grants(resourceId) };
      });
    },
    adoptAccessParent(rawResourceId, rawAccessParentId) {
      const resourceId = identifier(rawResourceId, "resource ID");
      const accessParentId = identifier(rawAccessParentId, "access parent resource ID");
      return control.transaction(() => {
        const row = resources.resource(resourceId);
        if (!row) throw controlError("not-found", "Resource not found");
        if (row.accessParentId === accessParentId) return row;
        if (row.accessParentId !== undefined) throw controlError("conflict", "Resource already follows another resource");
        if (row.visibility !== "inherit" || accessParentId === resourceId) {
          throw controlError("invalid-input", "Only an inheriting resource may follow another resource");
        }
        const parent = resources.resource(accessParentId);
        if (!parent || parent.orgId !== row.orgId || parent.spaceId !== row.spaceId) {
          throw controlError("not-found", "Access parent is not in the resource's scope");
        }
        // A cycle would make access undecidable; refuse it outright.
        let cursor: CanonicalResource | undefined = parent;
        for (let depth = 0; cursor?.accessParentId && depth < 32; depth += 1) {
          if (cursor.accessParentId === resourceId) throw controlError("invalid-input", "Access inheritance would loop");
          cursor = resources.resource(cursor.accessParentId);
        }
        const changes = control.run(
          `UPDATE resources SET access_parent_id=?,access_revision=access_revision+1,revision=revision+1,updated_at_ms=?
            WHERE id=? AND revision=? AND access_parent_id IS NULL`,
          accessParentId, now(), resourceId, row.revision,
        ).changes;
        if (Number(changes) !== 1) throw controlError("conflict", "Resource state changed; retry from current state");
        control.audit("system:resource-reconciler", "resource.access-parent-adopted", resourceId);
        const current = resources.resource(resourceId);
        if (!current) throw controlError("recovery-required", "Resource access parent update was not durable");
        return current;
      });
    },
    accessChildren(resourceId) {
      return control.all<{ id: string }>(
        "SELECT id FROM resources WHERE access_parent_id=? AND lifecycle<>'deleted' ORDER BY id",
        identifier(resourceId, "resource ID"),
      ).map((row) => row.id);
    },
  };
}

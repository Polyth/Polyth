import { randomUUID } from "node:crypto";
import type { ControlPlane } from "@polyth/control-plane";
import {
  roleAtLeast,
  type SpaceDto,
  type SpaceMemberDto,
  type SpaceRole,
  type SpaceSummaryDto,
  type UserDto,
} from "@polyth/contracts";
import { noSuchSpace, type CreateSpaceInput, type TenancyFile, type TenancyStore } from "./store.ts";

const error = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const id = (prefix: "spc" | "usr"): string => `${prefix}_${randomUUID()}`;
const text = (value: string, field: string, maximum = 60): string => {
  const normalized = value.trim();
  if (!normalized) throw error("invalid-input", `${field} is required`);
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw error("invalid-input", `${field} is invalid`);
  }
  return normalized;
};
const optionalVisual = (value: string | undefined, field: "color" | "icon"): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (field === "color") {
    if (!/^#[0-9a-fA-F]{3,8}$/.test(normalized)) throw error("invalid-input", "color is invalid");
  } else if (normalized.length > 16 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw error("invalid-input", "icon is invalid");
  }
  return normalized;
};

type UserRow = { id: string; name: string; createdAt: number };
type SpaceRow = SpaceDto & { orgId: string; revision: number };

function dto(row: SpaceRow): SpaceDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ...(row.color ? { color: row.color } : {}),
    ...(row.icon ? { icon: row.icon } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isDefault: !!row.isDefault,
  };
}

/**
 * Canonical tenancy adapter over the control-plane authority.
 *
 * It deliberately does not provision identities or Personal Spaces. Account
 * creation belongs to the identity domain and grants belong to explicit admin
 * mutations. The legacy JSON registry may coexist only as migration input.
 */
export function createControlTenancyStore(control: ControlPlane, opts: { now?: () => number } = {}): TenancyStore {
  const now = opts.now ?? Date.now;
  const userRow = (userId: string): UserRow | undefined => control.get<UserRow>(
    `SELECT u.id,u.display_name AS name,u.created_at_ms AS createdAt
       FROM users u JOIN principals p ON p.id=u.id
      WHERE u.id=? AND p.kind='user' AND p.status='active'`,
    userId,
  );
  const spaceRow = (spaceId: string): SpaceRow | undefined => control.get<SpaceRow>(
    `SELECT id,org_id AS orgId,name,storage_identity AS slug,color,icon,
            created_at_ms AS createdAt,updated_at_ms AS updatedAt,is_default AS isDefault,revision
       FROM spaces WHERE id=?`,
    spaceId,
  );
  const roleOf = (userId: string, spaceId: string): SpaceRole | undefined => control.get<{ role: SpaceRole }>(
    `SELECT role FROM space_memberships
      WHERE space_id=? AND principal_id=? AND state='active'
        AND role IN ('owner','admin','member','viewer')`,
    spaceId,
    userId,
  )?.role;
  const assertActiveUser = (userId: string): void => {
    if (!userRow(userId)) throw error("not-found", "Account not found");
  };
  const requireMembership = (userId: string, spaceId: string, minimumRole: SpaceRole = "viewer") => {
    const row = spaceRow(spaceId);
    const role = roleOf(userId, spaceId);
    if (!row || !role) throw noSuchSpace();
    if (!roleAtLeast(role, minimumRole)) throw error("forbidden", `this action requires the ${minimumRole} role`);
    return { space: dto(row), role };
  };
  const uniqueOrgFor = (userId: string): string => {
    const rows = control.all<{ orgId: string }>(
      `SELECT org_id AS orgId FROM organization_memberships
        WHERE user_id=? AND state='active' ORDER BY org_id`,
      userId,
    );
    if (rows.length !== 1) {
      throw error(rows.length ? "conflict" : "forbidden", "Select an organization before creating a Space");
    }
    return rows[0]!.orgId;
  };
  const activeOwnerCount = (spaceId: string, excluding?: string): number => control.get<{ n: number }>(
    `SELECT count(*) AS n FROM space_memberships m
       JOIN principals p ON p.id=m.principal_id
      WHERE m.space_id=? AND m.state='active' AND m.role='owner' AND p.status='active'
        ${excluding ? "AND m.principal_id<>?" : ""}`,
    ...(excluding ? [spaceId, excluding] : [spaceId]),
  )?.n ?? 0;
  const memberCount = (spaceId: string): number => control.get<{ n: number }>(
    `SELECT count(*) AS n FROM space_memberships
      WHERE space_id=? AND state='active' AND role IN ('owner','admin','member','viewer')`,
    spaceId,
  )?.n ?? 0;
  const audit = (actorId: string, action: string, resourceId: string): void => {
    control.bumpEpoch();
    control.audit(actorId, action, resourceId);
  };

  const store: TenancyStore = {
    users: () => control.all<UserRow>(
      `SELECT u.id,u.display_name AS name,u.created_at_ms AS createdAt
         FROM users u JOIN principals p ON p.id=u.id
        WHERE p.kind='user' AND p.status='active' ORDER BY u.created_at_ms,u.id`,
    ),
    user: (userId) => userRow(userId),
    createUser() {
      throw error("forbidden", "Accounts must be created by the identity service");
    },
    allSpaces: () => control.all<SpaceRow>(
      `SELECT id,org_id AS orgId,name,storage_identity AS slug,color,icon,
              created_at_ms AS createdAt,updated_at_ms AS updatedAt,is_default AS isDefault,revision
         FROM spaces ORDER BY created_at_ms,id`,
    ).map(dto),
    spacesFor(userId) {
      assertActiveUser(userId);
      return control.all<SpaceRow & { role: SpaceRole; memberCount: number }>(
        `SELECT s.id,s.org_id AS orgId,s.name,s.storage_identity AS slug,s.color,s.icon,
                s.created_at_ms AS createdAt,s.updated_at_ms AS updatedAt,s.is_default AS isDefault,s.revision,
                m.role,
                (SELECT count(*) FROM space_memberships x
                  WHERE x.space_id=s.id AND x.state='active'
                    AND x.role IN ('owner','admin','member','viewer')) AS memberCount
           FROM space_memberships m JOIN spaces s ON s.id=m.space_id
          WHERE m.principal_id=? AND m.state='active'
            AND m.role IN ('owner','admin','member','viewer')
          ORDER BY s.is_default DESC,s.created_at_ms,s.id`,
        userId,
      ).map((row) => ({ ...dto(row), role: row.role, memberCount: row.memberCount } satisfies SpaceSummaryDto));
    },
    requireMembership,
    roleOf,
    createSpace(input: CreateSpaceInput) {
      assertActiveUser(input.ownerId);
      const name = text(input.name, "name");
      const orgId = uniqueOrgFor(input.ownerId);
      const spaceId = id("spc");
      // storage identity, unlike display name, is immutable and never reused.
      const storageIdentity = spaceId;
      const color = optionalVisual(input.color, "color");
      const icon = optionalVisual(input.icon, "icon");
      const time = now();
      return control.transaction(() => {
        if (input.isDefault && control.get(
          `SELECT 1 FROM spaces s JOIN space_memberships m ON m.space_id=s.id
            WHERE m.principal_id=? AND m.state='active' AND s.is_default=1 LIMIT 1`, input.ownerId,
        )) throw error("conflict", "This account already has a default Space");
        control.run(
          `INSERT INTO spaces(id,org_id,name,storage_identity,kind,is_default,color,icon,created_at_ms,updated_at_ms)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          spaceId, orgId, name, storageIdentity, "shared", input.isDefault ? 1 : 0, color ?? null, icon ?? null, time, time,
        );
        control.run(
          `INSERT INTO space_memberships(space_id,principal_id,role,state,created_at_ms)
           VALUES(?,?,'owner','active',?)`,
          spaceId, input.ownerId, time,
        );
        audit(input.ownerId, "space.created", spaceId);
        return dto(spaceRow(spaceId)!);
      });
    },
    renameSpace(userId, spaceId, patch) {
      requireMembership(userId, spaceId, "admin");
      if (patch.name === undefined && patch.color === undefined && patch.icon === undefined) return dto(spaceRow(spaceId)!);
      const name = patch.name === undefined ? undefined : text(patch.name, "name");
      const color = patch.color === undefined ? undefined : optionalVisual(patch.color, "color") ?? null;
      const icon = patch.icon === undefined ? undefined : optionalVisual(patch.icon, "icon") ?? null;
      return control.transaction(() => {
        const row = spaceRow(spaceId);
        if (!row) throw noSuchSpace();
        control.run(
          `UPDATE spaces SET name=?,color=?,icon=?,updated_at_ms=?,revision=revision+1 WHERE id=? AND revision=?`,
          name ?? row.name,
          color === undefined ? row.color ?? null : color,
          icon === undefined ? row.icon ?? null : icon,
          now(), spaceId, row.revision,
        );
        audit(userId, "space.updated", spaceId);
        return dto(spaceRow(spaceId)!);
      });
    },
    deleteSpace(userId, spaceId) {
      requireMembership(userId, spaceId, "owner");
      control.transaction(() => {
        const row = spaceRow(spaceId);
        if (!row) throw noSuchSpace();
        if (row.isDefault) throw error("forbidden", "The default Space cannot be deleted");
        control.run("DELETE FROM device_selections WHERE space_id=?", spaceId);
        control.run("DELETE FROM space_memberships WHERE space_id=?", spaceId);
        control.run("DELETE FROM spaces WHERE id=?", spaceId);
        audit(userId, "space.deleted", spaceId);
      });
    },
    defaultSpaceFor(userId) {
      assertActiveUser(userId);
      const row = control.get<SpaceRow>(
        `SELECT s.id,s.org_id AS orgId,s.name,s.storage_identity AS slug,s.color,s.icon,
                s.created_at_ms AS createdAt,s.updated_at_ms AS updatedAt,s.is_default AS isDefault,s.revision
           FROM space_memberships m JOIN spaces s ON s.id=m.space_id
          WHERE m.principal_id=? AND m.state='active'
            AND m.role IN ('owner','admin','member','viewer')
          ORDER BY s.is_default DESC,s.created_at_ms,s.id LIMIT 1`, userId,
      );
      return row ? dto(row) : undefined;
    },
    members(userId, spaceId) {
      requireMembership(userId, spaceId, "viewer");
      return control.all<SpaceMemberDto>(
        `SELECT principal_id AS userId,space_id AS spaceId,role,created_at_ms AS createdAt
           FROM space_memberships
          WHERE space_id=? AND state='active' AND role IN ('owner','admin','member','viewer')
          ORDER BY created_at_ms,principal_id`, spaceId,
      );
    },
    addMember(actorId, spaceId, userId, role) {
      requireMembership(actorId, spaceId, "admin");
      assertActiveUser(userId);
      const time = now();
      return control.transaction(() => {
        const existing = control.get<{ role: string; createdAt: number }>(
          "SELECT role,created_at_ms AS createdAt FROM space_memberships WHERE space_id=? AND principal_id=?",
          spaceId, userId,
        );
        if (existing?.role === "owner" && role !== "owner" && activeOwnerCount(spaceId, userId) === 0) {
          throw error("last-owner", "The last active Space owner must be preserved");
        }
        if (existing) {
          control.run(
            "UPDATE space_memberships SET role=?,state='active',revision=revision+1 WHERE space_id=? AND principal_id=?",
            role, spaceId, userId,
          );
          audit(actorId, "space.member-role-updated", `${spaceId}:${userId}`);
          return { userId, spaceId, role, createdAt: existing.createdAt };
        }
        control.run(
          "INSERT INTO space_memberships(space_id,principal_id,role,state,created_at_ms) VALUES(?,?,?,'active',?)",
          spaceId, userId, role, time,
        );
        audit(actorId, "space.member-added", `${spaceId}:${userId}`);
        return { userId, spaceId, role, createdAt: time };
      });
    },
    removeMember(actorId, spaceId, userId) {
      requireMembership(actorId, spaceId, "admin");
      const role = roleOf(userId, spaceId);
      if (!role) throw noSuchSpace();
      if (role === "owner" && activeOwnerCount(spaceId, userId) === 0) {
        throw error("last-owner", "The last active Space owner must be preserved");
      }
      control.transaction(() => {
        control.run("DELETE FROM device_selections WHERE user_id=? AND space_id=?", userId, spaceId);
        control.run("DELETE FROM space_memberships WHERE space_id=? AND principal_id=?", spaceId, userId);
        audit(actorId, "space.member-removed", `${spaceId}:${userId}`);
      });
    },
    selection(deviceKey, userId) {
      const row = control.get<{ spaceId: string }>(
        `SELECT d.space_id AS spaceId FROM device_selections d
           JOIN space_memberships m ON m.space_id=d.space_id AND m.principal_id=d.user_id
          WHERE d.device_key=? AND d.user_id=? AND m.state='active'
            AND m.role IN ('owner','admin','member','viewer')`,
        deviceKey, userId,
      );
      return row?.spaceId;
    },
    select(deviceKey, userId, spaceId) {
      requireMembership(userId, spaceId, "viewer");
      if (!deviceKey || deviceKey.length > 512 || /[\u0000-\u001f\u007f]/.test(deviceKey)) throw error("invalid-input", "Device selection is invalid");
      control.transaction(() => {
        control.run(
          `INSERT INTO device_selections(device_key,user_id,space_id) VALUES(?,?,?)
           ON CONFLICT(device_key,user_id) DO UPDATE SET space_id=excluded.space_id`,
          deviceKey, userId, spaceId,
        );
        control.audit(userId, "space.selected", spaceId);
      });
    },
    snapshot(): TenancyFile {
      const users = store.users();
      const spaces = store.allSpaces();
      const memberships = control.all<SpaceMemberDto>(
        `SELECT principal_id AS userId,space_id AS spaceId,role,created_at_ms AS createdAt
           FROM space_memberships WHERE state='active' AND role IN ('owner','admin','member','viewer')
          ORDER BY created_at_ms,space_id,principal_id`,
      );
      const selections: Record<string, string> = {};
      for (const row of control.all<{ deviceKey: string; userId: string; spaceId: string }>(
        "SELECT device_key AS deviceKey,user_id AS userId,space_id AS spaceId FROM device_selections ORDER BY device_key,user_id",
      )) selections[`${row.deviceKey}\u0000${row.userId}`] = row.spaceId;
      return { version: 1, users, spaces, memberships, selections };
    },
  };
  return store;
}

import { randomUUID } from "node:crypto";
import { digest, type ControlPlane } from "@polyth/control-plane";
import { executeOnce, type MutationReceipt } from "@polyth/control-plane/operations";
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
type MembershipRow = { role: SpaceRole; createdAt: number; revision: number };
type OperationOptions = { operationId?: string };
type CreateOperationOptions = OperationOptions & { maxOwnedSpaces?: number };

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
 *
 * Public mutation routes may pass a durable operationId. Canonical writes then
 * use executeOnce(), so domain mutation + audit + outbox + replay receipt share
 * one SQLite transaction. Direct trusted callers remain supported and still
 * receive the same atomic audit/outbox invariant, just without replay caching.
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
  const membershipRow = (spaceId: string, userId: string): MembershipRow | undefined => control.get<MembershipRow>(
    `SELECT role,created_at_ms AS createdAt,revision FROM space_memberships
      WHERE space_id=? AND principal_id=? AND state='active'
        AND role IN ('owner','admin','member','viewer')`,
    spaceId,
    userId,
  );
  const roleOf = (userId: string, spaceId: string): SpaceRole | undefined => membershipRow(spaceId, userId)?.role;
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
  const ownedSpaceCount = (userId: string): number => control.get<{ n: number }>(
    `SELECT count(*) AS n FROM space_memberships
      WHERE principal_id=? AND state='active' AND role='owner'`,
    userId,
  )?.n ?? 0;

  const commitMutation = <T>(spec: {
    actorId: string;
    operationId?: string;
    action: string;
    resourceId: string;
    request: unknown;
    authorize: () => void;
    mutate: () => T;
    receipt: (value: T) => MutationReceipt;
    replay: (receipt: MutationReceipt) => T;
    bumpEpoch?: boolean;
  }): T => {
    if (!spec.operationId) {
      return control.transaction(() => {
        spec.authorize();
        const value = spec.mutate();
        if (spec.bumpEpoch !== false) control.bumpEpoch();
        control.audit(spec.actorId, spec.action, spec.resourceId);
        return value;
      });
    }
    let produced = false;
    let value!: T;
    const result = executeOnce(control, {
      actorId: spec.actorId,
      operationId: spec.operationId,
      action: spec.action,
      resourceId: spec.resourceId,
      request: spec.request,
    }, spec.authorize, () => {
      value = spec.mutate();
      produced = true;
      if (spec.bumpEpoch !== false) control.bumpEpoch();
      return spec.receipt(value);
    });
    return produced ? value : spec.replay(result.receipt);
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
    createSpace(input: CreateSpaceInput, operation?: CreateOperationOptions) {
      const name = text(input.name, "name");
      const color = optionalVisual(input.color, "color");
      const icon = optionalVisual(input.icon, "icon");
      const operationId = operation?.operationId;
      const spaceId = operationId
        ? `spc_${digest(`space:create:${input.ownerId}:${operationId}`).slice(0, 32)}`
        : id("spc");
      const storageIdentity = spaceId;
      const time = now();
      const maximum = operation?.maxOwnedSpaces;
      if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 1)) {
        throw error("invalid-input", "Invalid Space ownership limit");
      }
      let orgId = "";
      return commitMutation({
        actorId: input.ownerId,
        operationId,
        action: "space.created",
        resourceId: spaceId,
        request: { name, color: color ?? null, icon: icon ?? null, isDefault: input.isDefault === true },
        authorize() {
          assertActiveUser(input.ownerId);
          orgId = uniqueOrgFor(input.ownerId);
        },
        mutate() {
          if (maximum !== undefined && ownedSpaceCount(input.ownerId) >= maximum) {
            throw error("invalid-input", `a user may own at most ${maximum} spaces`);
          }
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
          return dto(spaceRow(spaceId)!);
        },
        receipt: () => ({ resourceId: spaceId, revision: spaceRow(spaceId)!.revision, state: "active" }),
        replay() {
          requireMembership(input.ownerId, spaceId, "viewer");
          const row = spaceRow(spaceId);
          if (!row) throw noSuchSpace();
          return dto(row);
        },
      });
    },
    renameSpace(userId, spaceId, patch, operation?: OperationOptions) {
      if (patch.name === undefined && patch.color === undefined && patch.icon === undefined) return dto(spaceRow(spaceId)!);
      const name = patch.name === undefined ? undefined : text(patch.name, "name");
      const color = patch.color === undefined ? undefined : optionalVisual(patch.color, "color") ?? null;
      const icon = patch.icon === undefined ? undefined : optionalVisual(patch.icon, "icon") ?? null;
      return commitMutation({
        actorId: userId,
        operationId: operation?.operationId,
        action: "space.updated",
        resourceId: spaceId,
        request: { name: name ?? null, color: color ?? null, icon: icon ?? null },
        authorize: () => { assertActiveUser(userId); },
        mutate() {
          requireMembership(userId, spaceId, "admin");
          const row = spaceRow(spaceId);
          if (!row) throw noSuchSpace();
          control.run(
            `UPDATE spaces SET name=?,color=?,icon=?,updated_at_ms=?,revision=revision+1 WHERE id=? AND revision=?`,
            name ?? row.name,
            color === undefined ? row.color ?? null : color,
            icon === undefined ? row.icon ?? null : icon,
            now(), spaceId, row.revision,
          );
          return dto(spaceRow(spaceId)!);
        },
        receipt: () => ({ resourceId: spaceId, revision: spaceRow(spaceId)!.revision, state: "active" }),
        replay() {
          requireMembership(userId, spaceId, "viewer");
          const row = spaceRow(spaceId);
          if (!row) throw noSuchSpace();
          return dto(row);
        },
      });
    },
    deleteSpace(userId, spaceId, operation?: OperationOptions) {
      commitMutation({
        actorId: userId,
        operationId: operation?.operationId,
        action: "space.deleted",
        resourceId: spaceId,
        request: {},
        authorize: () => { assertActiveUser(userId); },
        mutate() {
          requireMembership(userId, spaceId, "owner");
          const row = spaceRow(spaceId);
          if (!row) throw noSuchSpace();
          if (row.isDefault) throw error("forbidden", "The default Space cannot be deleted");
          control.run("DELETE FROM device_selections WHERE space_id=?", spaceId);
          control.run("DELETE FROM space_memberships WHERE space_id=?", spaceId);
          control.run("DELETE FROM spaces WHERE id=?", spaceId);
          return row.revision;
        },
        receipt: (revision) => ({ resourceId: spaceId, revision, state: "deleted" }),
        replay: (receipt) => receipt.revision,
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
    addMember(actorId, spaceId, userId, role, operation?: OperationOptions) {
      const time = now();
      const resourceId = `${spaceId}:${userId}`;
      return commitMutation({
        actorId,
        operationId: operation?.operationId,
        action: "space.member-set",
        resourceId,
        request: { spaceId, userId, role },
        authorize: () => { assertActiveUser(actorId); },
        mutate() {
          requireMembership(actorId, spaceId, "admin");
          assertActiveUser(userId);
          const existing = membershipRow(spaceId, userId);
          if (existing?.role === "owner" && role !== "owner" && activeOwnerCount(spaceId, userId) === 0) {
            throw error("last-owner", "The last active Space owner must be preserved");
          }
          if (existing) {
            control.run(
              "UPDATE space_memberships SET role=?,state='active',revision=revision+1 WHERE space_id=? AND principal_id=?",
              role, spaceId, userId,
            );
            return { userId, spaceId, role, createdAt: existing.createdAt };
          }
          control.run(
            "INSERT INTO space_memberships(space_id,principal_id,role,state,created_at_ms) VALUES(?,?,?,'active',?)",
            spaceId, userId, role, time,
          );
          return { userId, spaceId, role, createdAt: time };
        },
        receipt: () => ({ resourceId, revision: membershipRow(spaceId, userId)!.revision, state: "active" }),
        replay() {
          requireMembership(actorId, spaceId, "viewer");
          const row = membershipRow(spaceId, userId);
          if (!row) throw noSuchSpace();
          return { userId, spaceId, role: row.role, createdAt: row.createdAt };
        },
      });
    },
    removeMember(actorId, spaceId, userId, operation?: OperationOptions) {
      const resourceId = `${spaceId}:${userId}`;
      commitMutation({
        actorId,
        operationId: operation?.operationId,
        action: "space.member-removed",
        resourceId,
        request: { spaceId, userId },
        authorize: () => { assertActiveUser(actorId); },
        mutate() {
          requireMembership(actorId, spaceId, "admin");
          const existing = membershipRow(spaceId, userId);
          if (!existing) throw noSuchSpace();
          if (existing.role === "owner" && activeOwnerCount(spaceId, userId) === 0) {
            throw error("last-owner", "The last active Space owner must be preserved");
          }
          control.run("DELETE FROM device_selections WHERE user_id=? AND space_id=?", userId, spaceId);
          control.run("DELETE FROM space_memberships WHERE space_id=? AND principal_id=?", spaceId, userId);
          return existing.revision;
        },
        receipt: (revision) => ({ resourceId, revision, state: "deleted" }),
        replay: (receipt) => receipt.revision,
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

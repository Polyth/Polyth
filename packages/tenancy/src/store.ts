// Durable tenancy registry: identities, Spaces, memberships, and the last
// Space each device selected. JSON-file backed with atomic replace, matching
// the rest of Polyth's small control-plane state (auth.json, projects.json).
//
// Nothing here trusts a caller-supplied space id: every read that names a
// Space also names the user, and the store answers "not a member" the same way
// it answers "no such Space" so probing cannot enumerate other tenants.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  isSpaceRole,
  roleAtLeast,
  type SpaceDto,
  type SpaceMemberDto,
  type SpaceRole,
  type SpaceSummaryDto,
  type UserDto,
} from "@polyth/contracts";

const error = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

/** Not-found and not-a-member are indistinguishable on purpose. */
export const noSuchSpace = (): Error => error("not-found", "space not found");

export interface TenancyFile {
  version: number;
  users: UserDto[];
  spaces: SpaceDto[];
  memberships: SpaceMemberDto[];
  /** deviceKey → spaceId. The device key is derived server-side from the
   *  principal (remembered-device id, paired-device id, or "local"). */
  selections: Record<string, string>;
}

/** A FUNCTION, not a constant: a shared literal would hand every store that
 *  starts empty the same arrays, so one instance's writes would appear in
 *  another's. */
const emptyState = (): TenancyFile => ({
  version: 1,
  users: [],
  spaces: [],
  memberships: [],
  selections: {},
});

/** Slug rules double as directory-name rules: the slug IS the on-disk folder,
 *  so anything that could traverse or collide is rejected here. */
export const SPACE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function slugify(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base || "space";
}

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (cause) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw cause;
  }
}

const validName = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw error("invalid-input", `${field} must be text`);
  const text = value.trim();
  if (!text) throw error("invalid-input", `${field} is required`);
  if (text.length > 60) throw error("invalid-input", `${field} must be at most 60 characters`);
  return text;
};

export interface CreateSpaceInput {
  name: string;
  slug?: string;
  color?: string;
  icon?: string;
  /** The user who becomes the Space owner. */
  ownerId: string;
  isDefault?: boolean;
}

export interface TenancyStore {
  users(): UserDto[];
  user(id: string): UserDto | undefined;
  createUser(name: string, id?: string): UserDto;

  /** Every Space in the deployment. Administrative use only — never an
   *  answer to a user-facing request. */
  allSpaces(): SpaceDto[];
  /** Spaces `userId` is a member of, with their role. This is the only list a
   *  user-facing API may return. */
  spacesFor(userId: string): SpaceSummaryDto[];
  /** The Space `userId` may use, or throws `not-found` when they may not.
   *  Membership is checked here, not by the caller. */
  requireMembership(userId: string, spaceId: string, minimumRole?: SpaceRole): { space: SpaceDto; role: SpaceRole };
  /** Non-throwing membership probe. */
  roleOf(userId: string, spaceId: string): SpaceRole | undefined;

  createSpace(input: CreateSpaceInput): SpaceDto;
  renameSpace(userId: string, spaceId: string, patch: { name?: string; color?: string; icon?: string }): SpaceDto;
  deleteSpace(userId: string, spaceId: string): void;
  /** Default Space for a user: their default-flagged Space, else the oldest. */
  defaultSpaceFor(userId: string): SpaceDto | undefined;

  members(userId: string, spaceId: string): SpaceMemberDto[];
  addMember(actorId: string, spaceId: string, userId: string, role: SpaceRole): SpaceMemberDto;
  removeMember(actorId: string, spaceId: string, userId: string): void;

  /** Last Space this device selected, if it is still usable by `userId`. */
  selection(deviceKey: string, userId: string): string | undefined;
  select(deviceKey: string, userId: string, spaceId: string): void;

  snapshot(): TenancyFile;
}

export function createTenancyStore(opts: { file: string }): TenancyStore {
  let state: TenancyFile = emptyState();
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Partial<TenancyFile>;
    state = {
      version: typeof raw.version === "number" ? raw.version : 1,
      users: Array.isArray(raw.users) ? raw.users.filter((u): u is UserDto =>
        !!u && typeof u.id === "string" && typeof u.name === "string") : [],
      spaces: Array.isArray(raw.spaces) ? raw.spaces.filter((s): s is SpaceDto =>
        !!s && typeof s.id === "string" && typeof s.slug === "string") : [],
      memberships: Array.isArray(raw.memberships) ? raw.memberships.filter((m): m is SpaceMemberDto =>
        !!m && typeof m.userId === "string" && typeof m.spaceId === "string" && isSpaceRole(m.role)) : [],
      selections: raw.selections && typeof raw.selections === "object" && !Array.isArray(raw.selections)
        ? Object.fromEntries(
            Object.entries(raw.selections as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          )
        : {},
    };
  } catch { /* first boot */ }

  const persist = (): void => atomicWrite(opts.file, `${JSON.stringify(state, null, 2)}\n`);

  const spaceById = (id: string): SpaceDto | undefined => state.spaces.find((s) => s.id === id);

  const roleOf = (userId: string, spaceId: string): SpaceRole | undefined =>
    state.memberships.find((m) => m.userId === userId && m.spaceId === spaceId)?.role;

  const requireMembership = (
    userId: string,
    spaceId: string,
    minimumRole: SpaceRole = "viewer",
  ): { space: SpaceDto; role: SpaceRole } => {
    const space = spaceById(spaceId);
    const role = roleOf(userId, spaceId);
    // A Space the caller cannot see and a Space that does not exist answer
    // identically: existence itself is tenant-scoped information.
    if (!space || !role) throw noSuchSpace();
    if (!roleAtLeast(role, minimumRole)) {
      throw error("forbidden", `this action requires the ${minimumRole} role`);
    }
    return { space, role };
  };

  const memberCount = (spaceId: string): number =>
    state.memberships.filter((m) => m.spaceId === spaceId).length;

  const store: TenancyStore = {
    users: () => state.users.map((u) => ({ ...u })),
    user: (id) => {
      const found = state.users.find((u) => u.id === id);
      return found ? { ...found } : undefined;
    },

    createUser(name, id) {
      const userId = id ?? `usr_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      if (state.users.some((u) => u.id === userId)) {
        throw error("conflict", "user already exists");
      }
      const user: UserDto = { id: userId, name: validName(name, "name"), createdAt: Date.now() };
      state.users.push(user);
      persist();
      return { ...user };
    },

    allSpaces: () => state.spaces.map((s) => ({ ...s })),

    spacesFor(userId) {
      return state.memberships
        .filter((m) => m.userId === userId)
        .flatMap((m) => {
          const space = spaceById(m.spaceId);
          if (!space) return [];
          return [{ ...space, role: m.role, memberCount: memberCount(space.id) }];
        })
        .sort((a, b) => (a.isDefault === b.isDefault
          ? a.createdAt - b.createdAt
          : a.isDefault ? -1 : 1));
    },

    requireMembership,
    roleOf,

    createSpace(input) {
      if (!state.users.some((u) => u.id === input.ownerId)) {
        throw error("invalid-input", "owner must be a known user");
      }
      const name = validName(input.name, "name");
      const requested = input.slug ?? slugify(name);
      if (!SPACE_SLUG.test(requested)) {
        throw error("invalid-input", "slug must be lowercase letters, digits, and dashes");
      }
      // Slugs are directory names: uniqueness is a storage invariant, not a
      // cosmetic one, so a collision is resolved rather than merged.
      let slug = requested;
      for (let i = 2; state.spaces.some((s) => s.slug === slug); i++) slug = `${requested}-${i}`;
      const now = Date.now();
      const space: SpaceDto = {
        id: `spc_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        name,
        slug,
        ...(input.color ? { color: input.color } : {}),
        ...(input.icon ? { icon: input.icon } : {}),
        createdAt: now,
        updatedAt: now,
        isDefault: input.isDefault === true || state.spaces.length === 0,
      };
      state.spaces.push(space);
      state.memberships.push({
        userId: input.ownerId,
        spaceId: space.id,
        role: "owner",
        createdAt: now,
      });
      persist();
      return { ...space };
    },

    renameSpace(userId, spaceId, patch) {
      const { space } = requireMembership(userId, spaceId, "admin");
      if (patch.name !== undefined) space.name = validName(patch.name, "name");
      if (patch.color !== undefined) {
        if (patch.color !== "" && !/^#[0-9a-fA-F]{3,8}$/.test(patch.color)) {
          throw error("invalid-input", "color must be a hex value");
        }
        if (patch.color === "") delete space.color;
        else space.color = patch.color;
      }
      if (patch.icon !== undefined) {
        if (typeof patch.icon !== "string" || patch.icon.length > 16) {
          throw error("invalid-input", "icon must be a short glyph");
        }
        if (patch.icon === "") delete space.icon;
        else space.icon = patch.icon;
      }
      space.updatedAt = Date.now();
      persist();
      return { ...space };
    },

    deleteSpace(userId, spaceId) {
      const { space } = requireMembership(userId, spaceId, "owner");
      if (space.isDefault) {
        throw error("invalid-input", "the default space cannot be deleted");
      }
      state.spaces = state.spaces.filter((s) => s.id !== spaceId);
      state.memberships = state.memberships.filter((m) => m.spaceId !== spaceId);
      for (const [device, selected] of Object.entries(state.selections)) {
        if (selected === spaceId) delete state.selections[device];
      }
      persist();
    },

    defaultSpaceFor(userId) {
      const mine = store.spacesFor(userId);
      const preferred = mine.find((s) => s.isDefault) ?? mine[0];
      if (!preferred) return undefined;
      const { role: _role, memberCount: _count, ...space } = preferred;
      return space;
    },

    members(userId, spaceId) {
      requireMembership(userId, spaceId);
      return state.memberships.filter((m) => m.spaceId === spaceId).map((m) => ({ ...m }));
    },

    addMember(actorId, spaceId, userId, role) {
      requireMembership(actorId, spaceId, "admin");
      if (!isSpaceRole(role)) throw error("invalid-input", "unknown role");
      if (!state.users.some((u) => u.id === userId)) {
        throw error("invalid-input", "unknown user");
      }
      const existing = state.memberships.find((m) => m.spaceId === spaceId && m.userId === userId);
      if (existing) {
        existing.role = role;
        persist();
        return { ...existing };
      }
      const membership: SpaceMemberDto = { userId, spaceId, role, createdAt: Date.now() };
      state.memberships.push(membership);
      persist();
      return { ...membership };
    },

    removeMember(actorId, spaceId, userId) {
      requireMembership(actorId, spaceId, "admin");
      const owners = state.memberships.filter((m) => m.spaceId === spaceId && m.role === "owner");
      if (owners.length === 1 && owners[0]!.userId === userId) {
        throw error("invalid-input", "a space must keep at least one owner");
      }
      state.memberships = state.memberships.filter(
        (m) => !(m.spaceId === spaceId && m.userId === userId),
      );
      persist();
    },

    selection(deviceKey, userId) {
      const selected = state.selections[deviceKey];
      if (!selected) return undefined;
      // A remembered selection is re-authorized on every read: losing
      // membership silently drops the device back to its default Space.
      return roleOf(userId, selected) ? selected : undefined;
    },

    select(deviceKey, userId, spaceId) {
      requireMembership(userId, spaceId);
      if (state.selections[deviceKey] === spaceId) return;
      state.selections[deviceKey] = spaceId;
      persist();
    },

    snapshot: () => JSON.parse(JSON.stringify(state)) as TenancyFile,
  };

  return store;
}

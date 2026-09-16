// Legacy single-writer JSON registry until the reviewed SQLite switch-over.
// Strict loading and atomic mutations prevent corrupt/failed state from granting
// access. This is NOT the new control authority or an implicit owner bootstrap.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isSpaceRole, roleAtLeast, type SpaceDto, type SpaceMemberDto, type SpaceRole, type SpaceSummaryDto, type UserDto, } from "@polyth/contracts";
import { digestLegacyFile } from "./legacyFiles.ts";
import { isLegacyTenancyId, loadLegacyTenancyState, parseLegacyTenancyState, SPACE_SLUG, type TenancyFile } from "./legacyTenancy.ts";
export { SPACE_SLUG, type TenancyFile } from "./legacyTenancy.ts";
const error = (code: string, message: string): Error => Object.assign(new Error(message), { code });
export const noSuchSpace = (): Error => error("not-found", "space not found");
const recovery = (): Error => error("recovery-required", "Tenancy persistence requires operator recovery");
export function slugify(name: string): string {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "space";
}
function atomicWrite(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
  }
  catch (cause) {
    closeSync(fd);
    try {
      unlinkSync(temporary);
    }
    catch { /* A missing temp file does not change the original failure. */ }
    throw cause;
  }
  closeSync(fd);
  try {
    renameSync(temporary, file);
    const directory = openSync(dirname(file), "r");
    try {
      fsyncSync(directory);
    }
    finally {
      closeSync(directory);
    }
  }
  catch (cause) {
    try {
      unlinkSync(temporary);
    }
    catch { /* A missing temp file does not change the original failure. */ }
    throw cause;
  }
}
function validName(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw error("invalid-input", `${field} must be between 1 and 60 visible characters`);
  }
  return value.trim();
}
function decoration(patch: {
  color?: string;
  icon?: string;
}): void {
  if (patch.color !== undefined && patch.color !== "" && (typeof patch.color !== "string" || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(patch.color))) {
    throw error("invalid-input", "color must be a hex value");
  }
  if (patch.icon !== undefined && (typeof patch.icon !== "string" || patch.icon.length > 16 || (patch.icon !== "" && !patch.icon.trim()) || /[\u0000-\u001f\u007f]/.test(patch.icon))) {
    throw error("invalid-input", "icon must be a short glyph");
  }
}
export interface CreateSpaceInput {
  name: string;
  slug?: string;
  color?: string;
  icon?: string;
  ownerId: string;
  isDefault?: boolean;
}
export interface TenancyStore {
  users(): UserDto[];
  user(id: string): UserDto | undefined;
  createUser(name: string, id?: string): UserDto;
  /** Administrative only; user-facing lists use spacesFor. */
  allSpaces(): SpaceDto[];
  spacesFor(userId: string): SpaceSummaryDto[];
  requireMembership(userId: string, spaceId: string, minimumRole?: SpaceRole): {
    space: SpaceDto;
    role: SpaceRole;
  };
  roleOf(userId: string, spaceId: string): SpaceRole | undefined;
  createSpace(input: CreateSpaceInput): SpaceDto;
  renameSpace(userId: string, spaceId: string, patch: {
    name?: string;
    color?: string;
    icon?: string;
  }): SpaceDto;
  deleteSpace(userId: string, spaceId: string): void;
  defaultSpaceFor(userId: string): SpaceDto | undefined;
  members(userId: string, spaceId: string): SpaceMemberDto[];
  addMember(actorId: string, spaceId: string, userId: string, role: SpaceRole): SpaceMemberDto;
  removeMember(actorId: string, spaceId: string, userId: string): void;
  selection(deviceKey: string, userId: string): string | undefined;
  select(deviceKey: string, userId: string, spaceId: string): void;
  snapshot(): TenancyFile;
}
export function createTenancyStore(opts: {
  file: string;
}): TenancyStore {
  const loaded = loadLegacyTenancyState(opts.file);
  let state = loaded.state, expectedDigest = loaded.digest, unavailable = false;
  const available = (): void => {
    if (unavailable)
      throw recovery();
  };
  const mutate = <T>(work: () => T): T => {
    available();
    const previous = state;
    state = structuredClone(state);
    let result: T;
    try {
      result = work();
      parseLegacyTenancyState(state);
    }
    catch (cause) {
      state = previous;
      throw cause;
    }
    try {
      // Detect stale independent writers; legacy JSON still requires one owner
      // process, not a claim of an inter-process CAS across the rename itself.
      if (digestLegacyFile(opts.file).sha256 !== expectedDigest)
        throw recovery();
      const text = `${JSON.stringify(state, null, 2)}\n`;
      atomicWrite(opts.file, text);
      expectedDigest = createHash("sha256").update(text).digest("hex");
      return result;
    }
    catch {
      // A post-rename fsync failure has an uncertain durability outcome. Deny
      // subsequent reads/writes until reopen; do not serve an unpersisted grant.
      state = previous;
      unavailable = true;
      throw recovery();
    }
  };
  const spaceById = (id: string): SpaceDto | undefined => state.spaces.find(space => space.id === id);
  const roleOf = (userId: string, spaceId: string): SpaceRole | undefined => {
    available();
    return state.memberships.find(member => member.userId === userId && member.spaceId === spaceId)?.role;
  };
  const membership = (userId: string, spaceId: string, minimumRole: SpaceRole = "viewer"): {
    space: SpaceDto;
    role: SpaceRole;
  } => {
    available();
    const space = spaceById(spaceId), role = roleOf(userId, spaceId);
    if (!space || !role)
      throw noSuchSpace();
    if (!isSpaceRole(minimumRole) || !roleAtLeast(role, minimumRole))
      throw error("forbidden", `this action requires the ${minimumRole} role`);
    return { space, role };
  };
  const ownerChange = (actorRole: SpaceRole, spaceId: string, userId: string, next: SpaceRole | undefined): void => {
    const current = roleOf(userId, spaceId);
    if ((current === "owner" || next === "owner") && actorRole !== "owner")
      throw error("forbidden", "only an owner can change owners");
    if (current === "owner" && next !== "owner" && state.memberships.filter(row => row.spaceId === spaceId && row.role === "owner").length === 1) {
      throw error("invalid-input", "a space must keep at least one owner");
    }
  };
  const store: TenancyStore = {
    users() {
      available();
      return state.users.map(user => ({ ...user }));
    },
    user(id) {
      available();
      const found = state.users.find(user => user.id === id);
      return found ? { ...found } : undefined;
    },
    createUser(name, id) {
      return mutate(() => {
        const userId = id ?? `usr_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
        if (!isLegacyTenancyId(userId))
          throw error("invalid-input", "invalid user id");
        if (state.users.some(user => user.id === userId))
          throw error("conflict", "user already exists");
        const user = { id: userId, name: validName(name, "name"), createdAt: Date.now() };
        state.users.push(user);
        return { ...user };
      });
    },
    allSpaces() {
      available();
      return state.spaces.map(space => ({ ...space }));
    },
    spacesFor(userId) {
      available();
      return state.memberships.filter(member => member.userId === userId).flatMap(member => {
        const space = spaceById(member.spaceId);
        return space ? [{ ...space, role: member.role, memberCount: state.memberships.filter(row => row.spaceId === space.id).length }] : [];
      }).sort((a, b) => a.isDefault === b.isDefault ? a.createdAt - b.createdAt : a.isDefault ? -1 : 1);
    },
    requireMembership(userId, spaceId, minimumRole) {
      const found = membership(userId, spaceId, minimumRole);
      return { space: { ...found.space }, role: found.role };
    },
    roleOf,
    createSpace(input) {
      return mutate(() => {
        if (!state.users.some(user => user.id === input.ownerId))
          throw error("invalid-input", "owner must be a known user");
        const name = validName(input.name, "name"), requested = input.slug ?? slugify(name);
        decoration(input);
        if (typeof requested !== "string" || !SPACE_SLUG.test(requested))
          throw error("invalid-input", "slug must be lowercase letters, digits, and dashes");
        let slug = requested;
        for (let i = 2; state.spaces.some(space => space.slug === slug); i++) {
          const suffix = `-${i}`;
          slug = `${requested.slice(0, 40 - suffix.length).replace(/-+$/g, "")}${suffix}`;
        }
        const now = Date.now();
        const space: SpaceDto = {
          id: `spc_${randomUUID().replace(/-/g, "").slice(0, 20)}`, name, slug,
          ...(input.color ? { color: input.color } : {}), ...(input.icon ? { icon: input.icon } : {}), createdAt: now, updatedAt: now,
          isDefault: input.isDefault === true || state.spaces.length === 0,
        };
        state.spaces.push(space);
        state.memberships.push({ userId: input.ownerId, spaceId: space.id, role: "owner", createdAt: now });
        return { ...space };
      });
    },
    renameSpace(userId, spaceId, patch) {
      return mutate(() => {
        const { space } = membership(userId, spaceId, "admin");
        decoration(patch);
        if (patch.name !== undefined)
          space.name = validName(patch.name, "name");
        if (patch.color !== undefined) {
          if (patch.color === "")
            delete space.color;
          else
            space.color = patch.color;
        }
        if (patch.icon !== undefined) {
          if (patch.icon === "")
            delete space.icon;
          else
            space.icon = patch.icon;
        }
        space.updatedAt = Math.max(Date.now(), space.createdAt, space.updatedAt);
        return { ...space };
      });
    },
    deleteSpace(userId, spaceId) {
      mutate(() => {
        if (membership(userId, spaceId, "owner").space.isDefault)
          throw error("invalid-input", "the default space cannot be deleted");
        state.spaces = state.spaces.filter(space => space.id !== spaceId);
        state.memberships = state.memberships.filter(member => member.spaceId !== spaceId);
        for (const [key, selected] of Object.entries(state.selections))
          if (selected === spaceId)
            delete state.selections[key];
      });
    },
    defaultSpaceFor(userId) {
      const mine = store.spacesFor(userId), preferred = mine.find(space => space.isDefault) ?? mine[0];
      if (!preferred)
        return undefined;
      const { role: _role, memberCount: _count, ...space } = preferred;
      return space;
    },
    members(userId, spaceId) {
      membership(userId, spaceId);
      return state.memberships.filter(member => member.spaceId === spaceId).map(member => ({ ...member }));
    },
    addMember(actorId, spaceId, userId, role) {
      return mutate(() => {
        const actor = membership(actorId, spaceId, "admin");
        if (!isSpaceRole(role))
          throw error("invalid-input", "unknown role");
        if (!state.users.some(user => user.id === userId))
          throw error("invalid-input", "unknown user");
        ownerChange(actor.role, spaceId, userId, role);
        const existing = state.memberships.find(member => member.spaceId === spaceId && member.userId === userId);
        if (existing) {
          existing.role = role;
          return { ...existing };
        }
        const member = { userId, spaceId, role, createdAt: Date.now() };
        state.memberships.push(member);
        return { ...member };
      });
    },
    removeMember(actorId, spaceId, userId) {
      mutate(() => {
        const actor = membership(actorId, spaceId, "admin");
        ownerChange(actor.role, spaceId, userId, undefined);
        state.memberships = state.memberships.filter(member => !(member.spaceId === spaceId && member.userId === userId));
      });
    },
    selection(deviceKey, userId) {
      available();
      const selected = Object.hasOwn(state.selections, deviceKey) ? state.selections[deviceKey] : undefined;
      return selected && roleOf(userId, selected) ? selected : undefined;
    },
    select(deviceKey, userId, spaceId) {
      membership(userId, spaceId);
      if (typeof deviceKey !== "string" || !deviceKey.trim() || deviceKey.length > 1024 || /[\u0000-\u001f\u007f]/.test(deviceKey))
        throw error("invalid-input", "invalid device key");
      if (store.selection(deviceKey, userId) === spaceId)
        return;
      mutate(() => {
        Object.defineProperty(state.selections, deviceKey, { value: spaceId, enumerable: true, configurable: true, writable: true });
      });
    },
    snapshot() {
      available();
      return structuredClone(state);
    },
  };
  return store;
}

// Shared, strict parser for the supported JSON registry. Unknown/corrupt state
// requires recovery; never filter away rows and accidentally bootstrap an owner.
import { isSpaceRole, type UserDto, type SpaceDto, type SpaceMemberDto } from "@polyth/contracts";
import { readLegacyFile } from "./legacyFiles.ts";

export interface TenancyFile {
  version: number;
  users: UserDto[];
  spaces: SpaceDto[];
  memberships: SpaceMemberDto[];
  selections: Record<string, string>;
}
export interface LegacyTenancyIssue { path: string; code: string }
export const SPACE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const isLegacyTenancyId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
const row = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
function recovery(issues: LegacyTenancyIssue[] = []): never {
  throw Object.assign(new Error("Tenancy state requires operator recovery"), { code: "recovery-required", issues });
}
export const emptyLegacyTenancy = (): TenancyFile => ({ version: 1, users: [], spaces: [], memberships: [], selections: {} });

/** Collect safe locations for all invalid rows. Diagnostics contain only fixed
 * property names and numeric offsets, never raw labels or credential values. */
export function parseLegacyTenancyState(raw: unknown): TenancyFile {
  if (!row(raw) || raw.version !== 1 || !keys(raw, ["version", "users", "spaces", "memberships", "selections"])
    || !Array.isArray(raw.users) || !Array.isArray(raw.spaces) || !Array.isArray(raw.memberships) || !row(raw.selections)) {
    recovery([{ path: "root", code: "unsupported-shape" }]);
  }
  const issues: LegacyTenancyIssue[] = [];
  const invalid = (path: string, code: string): void => { issues.push({ path, code }); };
  const users: UserDto[] = [], spaces: SpaceDto[] = [], memberships: SpaceMemberDto[] = [];
  const userIds = new Set<string>(), spaceIds = new Set<string>(), slugs = new Set<string>(), memberKeys = new Set<string>(), owners = new Set<string>();
  for (const [i, user] of raw.users.entries()) {
    if (!row(user) || !keys(user, ["id", "name", "createdAt"]) || !isLegacyTenancyId(user.id)
      || !text(user.name, 60) || !time(user.createdAt) || userIds.has(user.id)) {
      invalid(`users[${i}]`, "invalid-or-duplicate-user"); continue;
    }
    userIds.add(user.id); users.push({ id: user.id, name: user.name, createdAt: user.createdAt });
  }
  for (const [i, space] of raw.spaces.entries()) {
    if (!row(space) || !keys(space, ["id", "name", "slug", "color", "icon", "createdAt", "updatedAt", "isDefault"])
      || !isLegacyTenancyId(space.id) || !text(space.name, 60) || typeof space.slug !== "string" || !SPACE_SLUG.test(space.slug)
      || !time(space.createdAt) || !time(space.updatedAt) || space.updatedAt < space.createdAt || typeof space.isDefault !== "boolean"
      || spaceIds.has(space.id) || slugs.has(space.slug)
      || (space.color !== undefined && (typeof space.color !== "string" || !/^#[0-9a-fA-F]{3,8}$/.test(space.color)))
      || (space.icon !== undefined && !text(space.icon, 16))) {
      invalid(`spaces[${i}]`, "invalid-or-duplicate-space"); continue;
    }
    spaceIds.add(space.id); slugs.add(space.slug);
    spaces.push({ id: space.id, name: space.name, slug: space.slug, createdAt: space.createdAt, updatedAt: space.updatedAt, isDefault: space.isDefault,
      ...(space.color !== undefined ? { color: space.color as string } : {}), ...(space.icon !== undefined ? { icon: space.icon as string } : {}) });
  }
  for (const [i, member] of raw.memberships.entries()) {
    if (!row(member) || !keys(member, ["userId", "spaceId", "role", "createdAt"]) || !isLegacyTenancyId(member.userId)
      || !isLegacyTenancyId(member.spaceId) || !isSpaceRole(member.role) || !time(member.createdAt)
      || !userIds.has(member.userId) || !spaceIds.has(member.spaceId)) {
      invalid(`memberships[${i}]`, "invalid-or-orphan-membership"); continue;
    }
    const key = JSON.stringify([member.userId, member.spaceId]);
    if (memberKeys.has(key)) { invalid(`memberships[${i}]`, "duplicate-membership"); continue; }
    memberKeys.add(key); if (member.role === "owner") owners.add(member.spaceId);
    memberships.push({ userId: member.userId, spaceId: member.spaceId, role: member.role, createdAt: member.createdAt });
  }
  for (const [i, space] of raw.spaces.entries()) {
    if (row(space) && isLegacyTenancyId(space.id) && spaceIds.has(space.id) && !owners.has(space.id)) invalid(`spaces[${i}]`, "ownerless-space");
  }
  const selections: Record<string, string> = Object.create(null);
  for (const [i, [key, value]] of Object.entries(raw.selections).entries()) {
    if (!text(key, 1024) || !isLegacyTenancyId(value) || !spaceIds.has(value)) {
      invalid(`selections[${i}]`, "invalid-selection"); continue;
    }
    selections[key] = value;
  }
  if (issues.length) recovery(issues);
  return { version: 1, users, spaces, memberships, selections };
}
export function loadLegacyTenancyState(file: string): { state: TenancyFile; digest?: string } {
  try {
    const { data, digest } = readLegacyFile(file);
    if (data === null) return { state: emptyLegacyTenancy() };
    return { state: parseLegacyTenancyState(JSON.parse(data.toString("utf8"))), digest: digest.sha256 };
  } catch { return recovery(); }
}

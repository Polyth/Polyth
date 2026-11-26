import type { SpaceMemberDto } from "@polyth/contracts";

/** A member of the current Space the instance owner can pair a device for. */
export interface Teammate {
  id: string;
  /** Empty when the server knows no display name. */
  name: string;
}

/**
 * The current Space's other members, for the instance owner only: `null` for
 * everyone else, and in another server's Space (`rmt_`), whose members are not
 * accounts here. Ownership is the server's `canManage` on the account list;
 * the pairing route enforces it again.
 */
export async function loadTeammates(api: { get<T>(path: string): Promise<T> }): Promise<Teammate[] | null> {
  const accounts = await api.get<{ canManage?: unknown; currentAccountId?: unknown }>("/api/auth/accounts");
  if (accounts.canManage !== true) return null;
  const spaces = await api.get<{ activeSpaceId?: unknown }>("/api/spaces");
  if (typeof spaces.activeSpaceId !== "string" || spaces.activeSpaceId.startsWith("rmt_")) return null;
  const members = await api.get<SpaceMemberDto[]>(`/api/spaces/${encodeURIComponent(spaces.activeSpaceId)}/members`);
  if (!Array.isArray(members)) return null;
  return members
    .filter((member) => member.userId !== accounts.currentAccountId)
    // Without a display name the server may answer with the raw account id.
    .map((member) => ({ id: member.userId, name: member.name && member.name !== member.userId ? member.name : "" }));
}

import type { SpaceMemberDto, SpaceRole } from "@polyth/contracts";
import { createIdempotentMutationClient } from "@polyth/session/idempotent-mutation";
import { api } from "@polyth/session/web-api";

export interface CurrentSpaceAccess {
  id: string;
  name: string;
  role: SpaceRole;
  canManageMembers: boolean;
  members: SpaceMemberDto[];
}

const mutations = createIdempotentMutationClient({
  fetch: (input, init) => fetch(input, init),
  onUnauthorized: () => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("polyth:auth-required"));
  },
});

export async function loadCurrentSpaceAccess(): Promise<CurrentSpaceAccess | null> {
  const state = await api.spaces();
  const active = state.spaces.find((space) => space.id === state.activeSpaceId);
  if (!active) return null;
  return {
    id: active.id,
    name: active.name,
    role: active.role,
    canManageMembers: active.role === "owner" || active.role === "admin",
    members: await api.spaceMembers(active.id),
  };
}

export async function grantSpaceMember(
  spaceId: string,
  userId: string,
  role: SpaceRole = "member",
): Promise<SpaceMemberDto> {
  return mutations.request<SpaceMemberDto>(
    `/api/spaces/${encodeURIComponent(spaceId)}/members`,
    "POST",
    { userId, role },
  );
}

export async function revokeSpaceMember(spaceId: string, userId: string): Promise<void> {
  await mutations.request<{ ok: boolean }>(
    `/api/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(userId)}`,
    "DELETE",
  );
}

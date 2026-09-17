import type { AuthPrincipal, SpaceContext } from "./index.ts";

type AuthoritativeSpaceContext = SpaceContext & {
  /** Canonical server-minted deployment authority; request input cannot set it. */
  readonly instanceOwner?: boolean;
};

export interface InstanceAuthorityRequest {
  readonly space: SpaceContext;
  readonly principal: AuthPrincipal;
}

/**
 * Require authority over installation-global state.
 *
 * Canonical contexts always carry an explicit `instanceOwner` decision from
 * `instance_roles`; Space ownership/admin is intentionally insufficient.
 * `local-user` with no marker is the pre-canonical single-user compatibility
 * path only. Canonical ui-session accounts never inherit ambient authority.
 */
export function requireInstanceOwnerAuthority(
  request: InstanceAuthorityRequest,
  message = "instance owner access is required",
): void {
  const marker = (request.space as AuthoritativeSpaceContext).instanceOwner;
  if (marker === true) return;
  if (marker === undefined && request.principal.kind === "local-user") return;
  throw Object.assign(new Error(message), { code: "forbidden" });
}

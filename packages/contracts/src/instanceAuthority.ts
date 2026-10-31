import type { AuthPrincipal, SpaceContext } from "./index.ts";

type AuthoritativeSpaceContext = SpaceContext & {
  /** Canonical server-minted deployment authority; request input cannot set it. */
  readonly instanceOwner?: boolean;
  /** Canonical server-minted `harnesses.manage` account permission. */
  readonly harnessManager?: boolean;
  /** Canonical server-minted `harnesses.personal` account permission. */
  readonly harnessPersonal?: boolean;
  /** Canonical server-minted account limit: the shared harnesses this account
   *  may use; null or absent = every harness. */
  readonly allowedHarnesses?: readonly string[] | null;
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

/** True when the caller is the instance owner (or the pre-canonical single
 *  local user, like `requireInstanceOwnerAuthority`). */
export function hasInstanceOwnerAuthority(request: InstanceAuthorityRequest): boolean {
  const marker = (request.space as AuthoritativeSpaceContext).instanceOwner;
  return marker === true || (marker === undefined && request.principal.kind === "local-user");
}

/** The instance owner, or an account the owner gave `harnesses.manage`. */
export function hasHarnessManagerAuthority(request: InstanceAuthorityRequest): boolean {
  return hasInstanceOwnerAuthority(request)
    || (request.space as AuthoritativeSpaceContext).harnessManager === true;
}

/** May add, rename and remove its OWN private harness accounts: the instance
 *  owner, a harness manager, or an account given `harnesses.personal`. */
export function hasPersonalHarnessAuthority(request: InstanceAuthorityRequest): boolean {
  return hasHarnessManagerAuthority(request)
    || (request.space as AuthoritativeSpaceContext).harnessPersonal === true;
}

/** Adding/changing one's own private harness accounts. */
export function requirePersonalHarnessAuthority(
  request: InstanceAuthorityRequest,
  message = "adding your own assistant accounts requires permission from the server owner",
): void {
  if (!hasPersonalHarnessAuthority(request)) throw Object.assign(new Error(message), { code: "forbidden" });
}

/** The shared harnesses the owner limited this account to, or null for all.
 *  Its own private logins are not on the list and stay usable. */
export function allowedHarnessesFor(request: Pick<InstanceAuthorityRequest, "space">): readonly string[] | null {
  return (request.space as AuthoritativeSpaceContext).allowedHarnesses ?? null;
}

/** Turning harnesses on/off and adding private harness accounts. */
export function requireHarnessManagerAuthority(
  request: InstanceAuthorityRequest,
  message = "managing assistants requires permission from the server owner",
): void {
  if (!hasHarnessManagerAuthority(request)) throw Object.assign(new Error(message), { code: "forbidden" });
}

import {
  REMOTE_CAPABILITY,
  isLocalUiPrincipal,
  roleAtLeast,
  type RouteRequest,
  type SpaceContext,
} from "@polyth/contracts";

/**
 * Deployment-global package binary/runtime mutations.
 * Space admin is not sufficient: a Space admin of A must not replace
 * binaries used by Space B. Local UI principals are the v1 deployment
 * administrator (`packages.install` is privileged and not in Full remote).
 */
export function assertDeploymentPackageMutator(request: RouteRequest): void {
  request.requireCapability(REMOTE_CAPABILITY.packagesInstall);
}

function assertSpacePackageOperator(
  request: RouteRequest,
  space: SpaceContext,
  capability: string,
): void {
  if (isLocalUiPrincipal(request.principal)) return;
  if (roleAtLeast(space.role, "admin")) return;
  request.requireCapability(capability);
}

/** Enable in the calling Space. Does not mutate the global binary. */
export function assertSpacePackageEnable(request: RouteRequest, space: SpaceContext): void {
  assertSpacePackageOperator(request, space, REMOTE_CAPABILITY.packagesEnable);
}

/** Disable in the calling Space. Last-Space disable may dispose process runtime. */
export function assertSpacePackageDisable(request: RouteRequest, space: SpaceContext): void {
  assertSpacePackageOperator(request, space, REMOTE_CAPABILITY.packagesDisable);
}

/** Capability grants and connection-definition approval are Space operations. */
export function assertSpacePackageGrant(request: RouteRequest, space: SpaceContext): void {
  if (isLocalUiPrincipal(request.principal)) return;
  if (!roleAtLeast(space.role, "admin")) {
    throw Object.assign(new Error("package grants require a Space admin"), { code: "forbidden" });
  }
}

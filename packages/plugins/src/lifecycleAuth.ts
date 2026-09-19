import {
  REMOTE_CAPABILITY,
  isLocalUiPrincipal,
  roleAtLeast,
  type RouteRequest,
  type SpaceContext,
} from "@polyth/contracts";
import { requireInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";

const forbidden: (message: string) => never = (message) => {
  throw Object.assign(new Error(message), { code: "forbidden" });
};

/**
 * Deployment-global package binary/runtime mutations.
 * A Space owner/admin is not enough: binaries are shared by every Space on the
 * installation. Canonical contexts carry instanceOwner from instance_roles.
 * The local-user fallback exists only for pre-canonical trusted installations;
 * canonical ui-session accounts never receive ambient deployment authority.
 */
export function assertDeploymentPackageMutator(request: RouteRequest): void {
  requireInstanceOwnerAuthority(
    request,
    "package installation and binary changes require the instance owner",
  );
  // Paired-device callers must also possess the privileged transport grant.
  // ui-session/local-user pass this legacy transport layer only after the
  // durable account authority above has admitted them.
  request.requireCapability(REMOTE_CAPABILITY.packagesInstall);
}

function assertSpacePackageOperator(
  request: RouteRequest,
  space: SpaceContext,
  capability: string,
): void {
  if (!roleAtLeast(space.role, "admin")) {
    forbidden("package lifecycle changes require a Space admin");
  }
  if (!isLocalUiPrincipal(request.principal)) {
    request.requireCapability(capability);
  }
}

/** Enable in the calling Space. Does not mutate the global binary. */
export function assertSpacePackageEnable(request: RouteRequest, space: SpaceContext): void {
  assertSpacePackageOperator(request, space, REMOTE_CAPABILITY.packagesEnable);
}

/** Disable in the calling Space. Last-Space disable may dispose process runtime. */
export function assertSpacePackageDisable(request: RouteRequest, space: SpaceContext): void {
  assertSpacePackageOperator(request, space, REMOTE_CAPABILITY.packagesDisable);
}

/**
 * Capability grants and connection-definition approval are Space operations.
 * There is intentionally no remote grant capability in v1: an admin must use
 * an authenticated local UI session to approve new package authority.
 */
export function assertSpacePackageGrant(request: RouteRequest, space: SpaceContext): void {
  if (!roleAtLeast(space.role, "admin")) {
    forbidden("package grants require a Space admin");
  }
  if (!isLocalUiPrincipal(request.principal)) {
    forbidden("package grants require an authenticated local UI session");
  }
}

/**
 * Trusted server entries execute setup()/dispose() in the deployment's
 * Node process. Starting or stopping one is therefore deployment-wide
 * authority even though the enabled bit remains Space-scoped.
 */
export function assertTrustedServerRuntimeMutator(
  request: RouteRequest,
  hasServerRuntime: boolean,
): void {
  if (hasServerRuntime) assertDeploymentPackageMutator(request);
}

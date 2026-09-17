import {
  REMOTE_CAPABILITY,
  roleAtLeast,
  type RouteRequest,
  type SpaceContext,
} from "@polyth/contracts";

const forbidden = (message: string): never => {
  throw Object.assign(new Error(message), { code: "forbidden" });
};

/**
 * Deployment-global package binary/runtime mutations.
 *
 * A Space owner is not automatically a deployment administrator on a
 * shared control plane. V1 therefore permits the local trusted operator
 * only in local-trusted deployments, or a paired device carrying the
 * deliberately rare packages.install capability. Both paths still need
 * owner membership in the active Space.
 */
export function assertDeploymentPackageMutator(request: RouteRequest): void {
  if (!roleAtLeast(request.space.role, "owner")) {
    forbidden("deployment package mutations require an owner");
  }
  const principal = request.principal;
  if (
    request.space.deployment === "local-trusted"
    && (principal.kind === "local-user" || principal.kind === "ui-session")
  ) {
    return;
  }
  if (
    principal.kind === "paired-device"
    && principal.grants.includes(REMOTE_CAPABILITY.packagesInstall)
  ) {
    return;
  }
  forbidden("deployment package mutation is not allowed for this principal");
}

function assertSpaceAdmin(space: SpaceContext): void {
  if (!roleAtLeast(space.role, "admin")) {
    forbidden("package lifecycle changes require a Space admin");
  }
}

/** Enable in the calling Space. Does not mutate the global binary. */
export function assertSpacePackageEnable(_request: RouteRequest, space: SpaceContext): void {
  assertSpaceAdmin(space);
}

/** Disable in the calling Space. Last-Space disable may dispose process runtime. */
export function assertSpacePackageDisable(_request: RouteRequest, space: SpaceContext): void {
  assertSpaceAdmin(space);
}

/** Capability grants and connection-definition approval are Space operations. */
export function assertSpacePackageGrant(_request: RouteRequest, space: SpaceContext): void {
  assertSpaceAdmin(space);
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

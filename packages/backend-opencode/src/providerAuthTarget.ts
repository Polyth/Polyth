import { allowsInteractiveProviderAuth, type HarnessContext, type RuntimeEndpoint, type SpaceContext } from "@polyth/contracts";
import { authError, throwAuthError } from "@polyth/models/auth";
import { hostnameIsLoopback } from "@polyth/models/auth";

/**
 * Sentinel project id that is never a user project. The OpenCode pool looks up
 * `projects.get(id)?.remote` only for that id, so this entry cannot inherit an
 * SSH binding from Project A/B/C, appear in Projects, create sessions, or
 * become the selected project. Provider auth targets the local-server OpenCode
 * config authority, not `projects.list()[0]`.
 */
export const LOCAL_OPENCODE_AUTH_PROJECT_ID = "__polyth_local_opencode_auth__";

/**
 * cwd is the Polyth host storage root (deployment-wide), not a user project
 * and not `process.cwd()` (often the git checkout the server was started
 * from). OpenCode still reads host-global auth from its own config directory;
 * this cwd only avoids loading repo-local `.opencode` plugins/config because
 * the process happened to start in a repository.
 */
export const localOpenCodeAuthContext = (space: SpaceContext, hostStorageDir: string): HarnessContext => ({
  space,
  spaceId: space.spaceId,
  projectId: LOCAL_OPENCODE_AUTH_PROJECT_ID,
  cwd: hostStorageDir,
  remote: false,
});

/** OpenCode on this Polyth host (owned+writable+loopback). SSH forwards look like loopback but are remote. */
export const openCodeProcessIsLocal = (endpoint?: RuntimeEndpoint): boolean => {
  if (!endpoint) return false;
  if (endpoint.config.kind !== "writable") return false;
  try {
    return hostnameIsLoopback(new URL(endpoint.url).hostname);
  } catch {
    return false;
  }
};

export const INTERACTIVE_PROVIDER_AUTH_MESSAGE =
  "Authentication is managed by this deployment and cannot be changed here.";

export const interactiveProviderAuthUnavailable = () =>
  authError("AUTH_CAPABILITY_UNAVAILABLE", { message: INTERACTIVE_PROVIDER_AUTH_MESSAGE });

/** Fail closed: host-global OpenCode credentials are not a per-Space store. */
export const assertInteractiveProviderAuth = (space: SpaceContext): void => {
  if (allowsInteractiveProviderAuth(space.deployment)) return;
  return throwAuthError(interactiveProviderAuthUnavailable());
};

/** Well-known commands spawn on this process; persist only to the reviewed local OpenCode. */
export type WellKnownExecutionLocality = "local-process";

export interface OpenCodeAuthTarget {
  spaceId: string;
  authorityId: string;
  generation: number;
  executionLocality: WellKnownExecutionLocality;
}

export const localAuthTarget = (
  space: SpaceContext,
  identity: { authorityId: string; generation: number },
): OpenCodeAuthTarget => ({
  spaceId: space.spaceId,
  authorityId: identity.authorityId,
  generation: identity.generation,
  executionLocality: "local-process",
});

export const sameAuthTarget = (left: OpenCodeAuthTarget, right: OpenCodeAuthTarget): boolean =>
  left.spaceId === right.spaceId
  && left.authorityId === right.authorityId
  && left.generation === right.generation
  && left.executionLocality === right.executionLocality;

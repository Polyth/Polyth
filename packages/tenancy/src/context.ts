// request → identity → membership → SpaceContext.
//
// This is the only place a SpaceContext is minted. Every step is server-side:
// the identity comes from the authenticated principal (never a body field),
// the requested Space is validated against membership, and the storage root is
// derived from the resolved Space rather than from anything the client sent.
import {
  isDeploymentProfile,
  type AuthPrincipal,
  type DeploymentProfile,
  type SpaceContext,
  type SpaceDto,
} from "@polyth/contracts";
import { spaceStorageDir } from "./paths.ts";
import { noSuchSpace, type TenancyStore } from "./store.ts";

const error = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

export function deploymentProfileFromEnv(
  env: Record<string, string | undefined> = process.env,
): DeploymentProfile {
  const raw = env.POLYTH_DEPLOYMENT_PROFILE;
  if (isDeploymentProfile(raw)) return raw;
  if (raw) {
    console.warn(`[polyth] unknown POLYTH_DEPLOYMENT_PROFILE=${raw}; falling back to local-trusted`);
  }
  return "local-trusted";
}

/** Durable identity behind one authenticated request channel.
 *
 * Polyth today has a single shared UI password, so every human principal maps
 * to the one bootstrap user. The mapping lives here (not in the auth service)
 * so per-user credentials can change ONLY this function later. */
export interface Identity {
  userId: string;
  /** Stable per-device key used to remember the last selected Space. */
  deviceKey: string;
}

export interface IdentityResolver {
  /** null when the principal has no tenant identity (anonymous, or an
   *  internal service that must be given an explicit context instead). */
  resolve(principal: AuthPrincipal): Identity | null;
}

export function createIdentityResolver(opts: {
  ownerUserId: string;
  /** Trusted deployments let the local control socket act as the operator.
   *  Hosted deployments never grant ambient tenancy to a service. */
  deployment: DeploymentProfile;
}): IdentityResolver {
  const { ownerUserId } = opts;
  return {
    resolve(principal) {
      switch (principal.kind) {
        case "anonymous":
          return null;
        case "local-user":
          return { userId: ownerUserId, deviceKey: `local:${principal.sessionId ?? "loopback"}` };
        case "ui-session":
          return { userId: ownerUserId, deviceKey: `ui:${principal.rememberedDeviceId}` };
        case "paired-device":
          // A paired device acts for the user who paired it. Today that is the
          // owner; when devices are paired per user this reads the pairing row.
          return { userId: ownerUserId, deviceKey: `device:${principal.deviceId}` };
        case "internal-service":
          // The local control socket (Polyth's own MCP) is filesystem-protected
          // and speaks for the operator, so in a trusted deployment it resolves
          // to the owner — the same identity the loopback UI gets.
          //
          // In a hosted deployment there IS no ambient operator: a service must
          // be handed an explicit context by whatever invoked it, so it gets
          // none here.
          if (opts.deployment === "local-trusted") {
            return { userId: ownerUserId, deviceKey: `service:${principal.serviceId}` };
          }
          return null;
      }
    },
  };
}

/** Client-supplied hints. Every one of them is a REQUEST, never an authority:
 *  each is validated against membership before it is honoured. */
export interface SpaceHints {
  /** Explicit selection (`X-Polyth-Space` header or a route parameter). An
   *  explicit hint that fails membership is an error, not a silent fallback. */
  explicit?: string | null;
  /** Remembered selection (cookie). Invalid values fall back silently. */
  remembered?: string | null;
}

export interface SpaceResolver {
  /** Mint a context for an authenticated principal. Throws `unauthorized`
   *  when there is no identity and `not-found` when an explicit Space is not
   *  one the caller belongs to. */
  forPrincipal(principal: AuthPrincipal, hints?: SpaceHints): SpaceContext;
  /** Mint a context for a known user + Space. Membership is still checked. */
  forUser(userId: string, spaceId: string): SpaceContext;
  /** Remember `spaceId` for this principal's device after a switch. */
  remember(principal: AuthPrincipal, spaceId: string): void;
  identity(principal: AuthPrincipal): Identity | null;
  deployment: DeploymentProfile;
}

export function createSpaceResolver(opts: {
  store: TenancyStore;
  identities: IdentityResolver;
  dataDir: string;
  deployment: DeploymentProfile;
}): SpaceResolver {
  const { store, identities, dataDir, deployment } = opts;

  const contextFor = (userId: string, space: SpaceDto, role: SpaceContext["role"]): SpaceContext => ({
    spaceId: space.id,
    spaceSlug: space.slug,
    userId,
    role,
    deployment,
    storageDir: spaceStorageDir(dataDir, space),
  });

  const resolveForUser = (userId: string, spaceId: string): SpaceContext => {
    const { space, role } = store.requireMembership(userId, spaceId);
    return contextFor(userId, space, role);
  };

  return {
    deployment,
    identity: (principal) => identities.resolve(principal),

    forPrincipal(principal, hints = {}) {
      const identity = identities.resolve(principal);
      if (!identity) throw error("unauthorized", "authentication required");

      // 1. explicit selection — must be valid, never silently downgraded
      if (hints.explicit) {
        return resolveForUser(identity.userId, hints.explicit);
      }
      // 2. remembered selection (server-side, then the client's cookie hint)
      const remembered = store.selection(identity.deviceKey, identity.userId)
        ?? (hints.remembered && store.roleOf(identity.userId, hints.remembered)
          ? hints.remembered
          : undefined);
      if (remembered) return resolveForUser(identity.userId, remembered);

      // 3. the user's default Space
      const fallback = store.defaultSpaceFor(identity.userId);
      if (!fallback) throw noSuchSpace();
      return resolveForUser(identity.userId, fallback.id);
    },

    forUser: resolveForUser,

    remember(principal, spaceId) {
      const identity = identities.resolve(principal);
      if (!identity) throw error("unauthorized", "authentication required");
      store.select(identity.deviceKey, identity.userId, spaceId);
    },
  };
}

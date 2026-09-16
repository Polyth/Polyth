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

type IdentifiedPrincipal = AuthPrincipal & { userId?: string };

export function deploymentProfileFromEnv(
  env: Record<string, string | undefined> = process.env,
): DeploymentProfile {
  const raw = env.POLYTH_DEPLOYMENT_PROFILE;
  if (raw === undefined) return "local-trusted";
  if (isDeploymentProfile(raw)) return raw;
  throw error("invalid-deployment-profile", "POLYTH_DEPLOYMENT_PROFILE must name a supported deployment profile");
}

/** Durable identity behind one authenticated request channel. */
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
  const identifiedUser = (principal: AuthPrincipal): string | undefined => {
    const userId = (principal as IdentifiedPrincipal).userId;
    return typeof userId === "string" && userId ? userId : undefined;
  };
  return {
    resolve(principal) {
      switch (principal.kind) {
        case "anonymous":
          return null;
        case "local-user":
          return {
            userId: identifiedUser(principal) ?? ownerUserId,
            deviceKey: `local:${principal.sessionId ?? "loopback"}`,
          };
        case "ui-session":
          return {
            userId: identifiedUser(principal) ?? ownerUserId,
            deviceKey: `ui:${principal.rememberedDeviceId}`,
          };
        case "paired-device":
          return {
            userId: identifiedUser(principal) ?? ownerUserId,
            deviceKey: `device:${principal.deviceId}`,
          };
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

const accountName = (userId: string): string => {
  const raw = userId.startsWith("usr_") ? userId.slice(4) : userId;
  const name = raw.replace(/[-_]+/g, " ").trim();
  return name ? name.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "User";
};

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

  const ensureUser = (identity: Identity): void => {
    if (!store.user(identity.userId)) {
      store.createUser(accountName(identity.userId), identity.userId);
    }
    // Only an authenticated, server-minted principal can reach this point.
    // Provisioning here avoids a second account registry and guarantees every
    // newly authenticated user starts inside an isolated Personal Space. The
    // user and Space are persisted separately, so also repair an interrupted
    // or older partial provisioning that left a known user with no membership.
    if (store.spacesFor(identity.userId).length === 0) {
      store.createSpace({ name: "Personal", ownerId: identity.userId, isDefault: true });
    }
  };

  return {
    deployment,
    identity: (principal) => identities.resolve(principal),

    forPrincipal(principal, hints = {}) {
      const identity = identities.resolve(principal);
      if (!identity) throw error("unauthorized", "authentication required");
      ensureUser(identity);

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
      ensureUser(identity);
      store.select(identity.deviceKey, identity.userId, spaceId);
    },
  };
}

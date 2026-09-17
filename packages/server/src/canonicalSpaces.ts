import type { ControlPlane } from "@polyth/control-plane";
import type { DeploymentProfile, SessionService, SpaceContext } from "@polyth/contracts";
import {
  AUDIT,
  createAuditSink,
  createControlTenancyStore,
  createIdentityResolver,
  createSpaceResolver,
  deploymentProfileFromEnv,
} from "@polyth/tenancy";
import type { ProjectRegistry } from "./projects.ts";
import { createSpaceGuard, createSpaceServices } from "./spaceScope.ts";
import type { SpaceGateway, SpaceSessionStore } from "./spaces.ts";

export interface CanonicalSpaceGatewayOptions {
  control: ControlPlane;
  dataDir: string;
  registry: ProjectRegistry;
  sessions: () => SessionService;
  store: SpaceSessionStore;
  deployment?: DeploymentProfile;
  cookieName?: string;
  now?: () => number;
}

type AuthoritativeSpaceContext = SpaceContext & {
  /** Server-minted deployment authority. Never accepted from request input. */
  readonly instanceOwner: boolean;
};

/**
 * Canonical Space gateway. Human/device contexts must arrive with a durable
 * userId and an explicit membership. Internal services are never projected to
 * an owner; callers that operate on a project/session must carry the resource's
 * already-resolved SpaceContext instead.
 */
export function createCanonicalSpaceGateway(opts: CanonicalSpaceGatewayOptions): SpaceGateway {
  const deployment = opts.deployment ?? deploymentProfileFromEnv();
  const store = createControlTenancyStore(opts.control, opts.now ? { now: opts.now } : {});
  const audit = createAuditSink(opts.now ? { now: opts.now } : {});
  const identities = createIdentityResolver({ ownerUserId: "", ambientOwner: false, deployment });
  const resolver = createSpaceResolver({
    store,
    identities,
    dataDir: opts.dataDir,
    deployment,
    provisionMissing: false,
  });
  const withInstanceAuthority = (ctx: SpaceContext): AuthoritativeSpaceContext => ({
    ...ctx,
    instanceOwner: !!opts.control.get(
      `SELECT 1 FROM instance_roles r JOIN principals p ON p.id=r.user_id
        WHERE r.user_id=? AND r.role='owner' AND p.status='active'`,
      ctx.userId,
    ),
  });
  const authoritativeResolver = {
    ...resolver,
    forPrincipal: (principal: Parameters<typeof resolver.forPrincipal>[0], hints?: Parameters<typeof resolver.forPrincipal>[1]) =>
      withInstanceAuthority(resolver.forPrincipal(principal, hints)),
    forUser: (userId: string, spaceId: string) => withInstanceAuthority(resolver.forUser(userId, spaceId)),
  };
  const guard = createSpaceGuard({
    spaceOfSession: (sessionId) => opts.store.spaceOfSession(sessionId),
    spaceOfProject: (projectId) => opts.registry.spaceOfProject(projectId),
  });
  const services = createSpaceServices({ registry: opts.registry, sessions: opts.sessions, guard });
  return {
    resolve: (principal, hints) => authoritativeResolver.forPrincipal(principal, hints),
    resolveInternal: () => {
      throw Object.assign(new Error("internal services do not inherit a human Space"), { code: "unauthorized" });
    },
    services,
    spaceOfSession: (sessionId) => opts.store.spaceOfSession(sessionId),
    store,
    resolver: authoritativeResolver,
    guard,
    audit,
    deployment,
    cookieName: opts.cookieName ?? "polyth_space",
  };
}

/** Explicit resource-scoped helper for trusted server components. */
export function canonicalSpaceForResource(gateway: SpaceGateway, userId: string, spaceId: string): SpaceContext {
  return gateway.resolver.forUser(userId, spaceId);
}

export { AUDIT };

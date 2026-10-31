import type { ControlPlane } from "@polyth/control-plane";
import type { AccountPermission, DeploymentProfile, SessionService, SpaceContext } from "@polyth/contracts";
import {
  AUDIT,
  createAuditSink,
  createControlTenancyStore,
  createIdentityResolver,
  createSpaceResolver,
  deploymentProfileFromEnv,
} from "@polyth/tenancy";
import { guardedRole, guardrailsForUser } from "./accountGuardrails.ts";
import { limitsForUser } from "./accountLimits.ts";
import type { HarnessAccess } from "./accountPermissions.ts";
import type { PersonHarnessDefault } from "./personHarnessDefault.ts";
import type { ProjectRegistry } from "./projects.ts";
import { createSessionPeople, peopleDirectory } from "./sessionPeople.ts";
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
  harnessAccess?: HarnessAccess;
  personHarnessDefault?: PersonHarnessDefault;
}

type AuthoritativeSpaceContext = SpaceContext & {
  /** Server-minted deployment authority. Never accepted from request input. */
  readonly instanceOwner: boolean;
  /** Server-minted `harnesses.manage` grant; never from request input. */
  readonly harnessManager: boolean;
  /** Server-minted `harnesses.personal` grant; never from request input. */
  readonly harnessPersonal: boolean;
  /** Server-minted account limit on shared harnesses; null = all. */
  readonly allowedHarnesses: readonly string[] | null;
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
  const hasPermission = (userId: string, permission: AccountPermission): boolean => !!opts.control.get(
    `SELECT 1 FROM account_permissions a JOIN principals p ON p.id=a.user_id, json_each(a.permissions_json) j
      WHERE a.user_id=? AND p.status='active' AND j.value=?`,
    userId,
    permission,
  );
  const withInstanceAuthority = (ctx: SpaceContext): AuthoritativeSpaceContext => ({
    ...ctx,
    // Guardrails cap the effective role, so every role-gated Space operation
    // (members, packages, Space-wide integrations) stays closed for them.
    role: guardedRole(ctx.role, guardrailsForUser(ctx.userId)),
    // A guarded account never manages assistants, whatever it was granted.
    harnessManager: !guardrailsForUser(ctx.userId) && hasPermission(ctx.userId, "harnesses.manage"),
    harnessPersonal: !guardrailsForUser(ctx.userId) && hasPermission(ctx.userId, "harnesses.personal"),
    // Minted per resolution, so a saved limit applies to the next request.
    allowedHarnesses: limitsForUser(ctx.userId)?.harnesses ?? null,
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
  const people = createSessionPeople(opts.store, peopleDirectory(store));
  const services = createSpaceServices({
    registry: opts.registry,
    sessions: opts.sessions,
    guard,
    people,
    ...(opts.harnessAccess ? { harnessAccess: opts.harnessAccess } : {}),
    ...(opts.personHarnessDefault ? { personHarnessDefault: opts.personHarnessDefault } : {}),
  });
  return {
    resolve: (principal, hints) => authoritativeResolver.forPrincipal(principal, hints),
    resolveInternal: () => {
      throw Object.assign(new Error("internal services do not inherit a human Space"), { code: "unauthorized" });
    },
    services,
    spaceOfSession: (sessionId) => opts.store.spaceOfSession(sessionId),
    people,
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

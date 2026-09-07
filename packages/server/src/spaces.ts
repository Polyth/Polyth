// Composition of the tenancy boundary for the HTTP/WS gateway.
//
// Everything tenant-related that the gateway needs is assembled here exactly
// once: the registry, the identity mapping, the request → SpaceContext
// resolver, the ownership guard, the per-request scoped services, and the boot
// migration that adopts a pre-tenancy installation into its Personal Space.
import {
  AUDIT,
  createAuditSink,
  createIdentityResolver,
  createSpaceResolver,
  createTenancyStore,
  deploymentProfileFromEnv,
  migrateToSpaces,
  type AuditSink,
  type MigrationResult,
  type SpaceHints,
  type SpaceResolver,
  type TenancyStore,
} from "@polyth/tenancy";
import type {
  AuthPrincipal,
  DeploymentProfile,
  SessionService,
  SpaceContext,
} from "@polyth/contracts";
import type { ProjectRegistry } from "./projects.ts";
import {
  createSpaceGuard,
  createSpaceServices,
  type SpaceGuard,
  type SpaceServices,
} from "./spaceScope.ts";

/** Session-store surface the guard and the migration need. */
export interface SpaceSessionStore {
  spaceOfSession(sessionId: string): string | undefined;
  adoptSessionsIntoSpace(spaceId: string): Promise<number>;
  /** Optional so lightweight test doubles stay valid. */
  adoptLabelsIntoSpace?(spaceId: string): Promise<number>;
}

const SPACE_COOKIE = "polyth_space";
export const SPACE_HEADER = "x-polyth-space";

/** What the gateway calls per request. Deliberately tiny: the gateway must not
 *  be able to reach around it into the registry. */
export interface SpaceGateway {
  /** Mint the tenant context for an authenticated principal. Throws
   *  `unauthorized` for anonymous callers and `not-found` when an explicitly
   *  requested Space is not one this identity belongs to. */
  resolve(principal: AuthPrincipal, hints?: SpaceHints): SpaceContext;
  /** Control-plane callers have no ambient identity; bind them explicitly to
   *  the installation owner and an optional requested Space. */
  resolveInternal(spaceId?: string | null): SpaceContext;
  /** Scoped services for a context. The only way a handler gets a session or
   *  project service. */
  services(ctx: SpaceContext): SpaceServices;
  /** Owning Space of a session — used by event fan-out. */
  spaceOfSession(sessionId: string): string | undefined;
  store: TenancyStore;
  resolver: SpaceResolver;
  guard: SpaceGuard;
  audit: AuditSink;
  deployment: DeploymentProfile;
  cookieName: string;
}

export interface SpaceGatewayOptions {
  dataDir: string;
  registry: ProjectRegistry;
  /** Composed after packages load; captured lazily so boot order is free. */
  sessions: () => SessionService;
  store: SpaceSessionStore;
  deployment?: DeploymentProfile;
  ownerName?: string;
  cookieName?: string;
  now?: () => number;
}

export interface SpaceGatewayHandle {
  gateway: SpaceGateway;
  migration: MigrationResult;
}

/** Build the tenancy boundary and run the initial migration. Idempotent: a
 *  second boot finds the Personal Space already present and adopts nothing. */
export async function createSpaceGateway(
  opts: SpaceGatewayOptions,
): Promise<SpaceGatewayHandle> {
  const deployment = opts.deployment ?? deploymentProfileFromEnv();
  const store = createTenancyStore({ file: `${opts.dataDir}/tenancy.json` });
  const audit = createAuditSink(opts.now ? { now: opts.now } : {});

  const migration = await migrateToSpaces({
    store,
    ...(opts.ownerName ? { ownerName: opts.ownerName } : {}),
    targets: {
      adoptProjects: (spaceId) => opts.registry.adoptIntoSpace(spaceId),
      adoptSessions: async (spaceId) => {
        const sessions = await opts.store.adoptSessionsIntoSpace(spaceId);
        // Workspace labels were global before tenancy; they move with the
        // sessions that reference them.
        await opts.store.adoptLabelsIntoSpace?.(spaceId);
        return sessions;
      },
    },
  });

  const identities = createIdentityResolver({ ownerUserId: migration.user.id, deployment });
  const resolver = createSpaceResolver({
    store,
    identities,
    dataDir: opts.dataDir,
    deployment,
  });
  const guard = createSpaceGuard({
    spaceOfSession: (sessionId) => opts.store.spaceOfSession(sessionId),
    spaceOfProject: (id) => opts.registry.spaceOfProject(id),
  });
  const services = createSpaceServices({
    registry: opts.registry,
    sessions: opts.sessions,
    guard,
  });

  if (migration.created || migration.projectsAdopted || migration.sessionsAdopted) {
    console.log(
      `[polyth] spaces: ${migration.created ? "created" : "using"} "${migration.space.name}"`
      + ` (${migration.projectsAdopted} projects, ${migration.sessionsAdopted} sessions adopted)`,
    );
    const bootstrapCtx = resolver.forUser(migration.user.id, migration.space.id);
    audit.record(bootstrapCtx, AUDIT.spaceCreated, {
      resource: { kind: "space", id: migration.space.id },
      detail: {
        migration: true,
        projectsAdopted: migration.projectsAdopted,
        sessionsAdopted: migration.sessionsAdopted,
      },
    });
  }

  const gateway: SpaceGateway = {
    resolve: (principal, hints) => resolver.forPrincipal(principal, hints),
    resolveInternal: (spaceId) => {
      // A filesystem-protected local socket speaks for the operator, which is
      // meaningful only where there IS an ambient operator. In a hosted
      // deployment the installation owner is not a tenant that a service may
      // act as, so the caller must be given a context by whatever invoked it.
      if (deployment === "multi-tenant-sandboxed") {
        throw Object.assign(
          new Error("internal services must be given an explicit space in this deployment"),
          { code: "unauthorized" },
        );
      }
      return resolver.forUser(migration.user.id, spaceId ?? migration.space.id);
    },
    services,
    spaceOfSession: (sessionId) => opts.store.spaceOfSession(sessionId),
    store,
    resolver,
    guard,
    audit,
    deployment,
    cookieName: opts.cookieName ?? SPACE_COOKIE,
  };

  return { gateway, migration };
}

/** Space id remembered by this browser, if any. Only ever a HINT: the resolver
 *  re-checks membership before honouring it. */
export function parseSpaceCookie(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== cookieName) continue;
    const value = part.slice(eq + 1).trim();
    return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
  }
  return null;
}

export function spaceCookieHeader(opts: { name: string; spaceId: string; secure: boolean }): string {
  // Not httpOnly: it carries no authority (membership is re-checked server-side
  // every request) and the SPA reads it to avoid a first-paint flash of the
  // wrong Space.
  const secure = opts.secure ? "; Secure" : "";
  return `${opts.name}=${opts.spaceId}; Path=/; SameSite=Strict; Max-Age=${60 * 60 * 24 * 365}${secure}`;
}

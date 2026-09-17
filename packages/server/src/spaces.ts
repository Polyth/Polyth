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
  noSuchSpace,
  spaceStorageDir,
  type AuditSink,
  type MigrationResult,
  type SpaceHints,
  type SpaceResolver,
  type TenancyStore,
} from "@polyth/tenancy";
import type {
  AuthPrincipal,
  DeploymentProfile,
  SessionProjection,
  SessionService,
  SpaceContext,
} from "@polyth/contracts";
import type { ProjectRegistry } from "./projects.ts";
import { createCanonicalSpaceGateway } from "./canonicalSpaces.ts";
import { canonicalSecurity } from "./runtimeSecurity.ts";
import { reconcileCanonicalResourcesAtBoot } from "./resourceStartupReconciliation.ts";
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
  /** Canonical startup uses this only when canonical session resources exist. */
  projection?(sessionId: string): Promise<SessionProjection | undefined>;
  /** Optional so lightweight test doubles stay valid. */
  adoptLabelsIntoSpace?(spaceId: string): Promise<number>;
}

const SPACE_COOKIE = "polyth_space";
export const SPACE_HEADER = "x-polyth-space";

type SystemSpaceContext = SpaceContext & {
  /** Explicit server-only authority marker. Absence on ordinary SpaceContext
   * means the context came from authenticated membership. */
  readonly authority: { readonly kind: "system"; readonly serviceId: string };
};

/** What the gateway calls per request. Deliberately tiny: the gateway must not
 *  be able to reach around it into the registry. */
export interface SpaceGateway {
  /** Mint the tenant context for an authenticated principal. Throws
   *  `unauthorized` for anonymous callers and `not-found` when an explicitly
   *  requested Space is not one this identity belongs to. */
  resolve(principal: AuthPrincipal, hints?: SpaceHints): SpaceContext;
  /** Trusted server work may bind to a resource Space without impersonating a
   * human member. Canonical mode returns a context marked authority=system;
   * direct canonical APIs still refuse ambient internal identity. */
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

function canonicalSpaceGateway(opts: SpaceGatewayOptions): SpaceGatewayHandle | null {
  const security = canonicalSecurity();
  if (!security) return null;
  if (security.control.installation().state !== "ready") {
    throw Object.assign(new Error("Canonical setup must complete before the application runtime starts"), { code: "setup-required" });
  }

  const deployment = opts.deployment ?? deploymentProfileFromEnv();
  const canonical = createCanonicalSpaceGateway({
    control: security.control,
    dataDir: opts.dataDir,
    registry: opts.registry,
    sessions: opts.sessions,
    store: opts.store,
    deployment,
    ...(opts.cookieName ? { cookieName: opts.cookieName } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const ownerId = security.control.get<{ user_id: string }>(
    `SELECT r.user_id FROM instance_roles r JOIN principals p ON p.id=r.user_id
      WHERE r.role='owner' AND p.status='active' ORDER BY r.user_id LIMIT 1`,
  )?.user_id;
  const owner = ownerId ? canonical.store.user(ownerId) : undefined;
  const defaultSpace = ownerId ? canonical.store.defaultSpaceFor(ownerId) : undefined;
  if (!owner || !defaultSpace) {
    throw Object.assign(new Error("Canonical authority is ready without an active owner/default Space"), { code: "recovery-required" });
  }

  const systemContext = (requested?: string | null): SystemSpaceContext => {
    if (!requested && deployment === "multi-tenant-sandboxed") {
      throw Object.assign(new Error("Internal services require an explicit Space in this deployment"), { code: "unauthorized" });
    }
    const space = requested
      ? canonical.store.allSpaces().find((candidate) => candidate.id === requested)
      : defaultSpace;
    if (!space) throw noSuchSpace();
    return {
      spaceId: space.id,
      spaceSlug: space.slug,
      // This is deliberately not a user id from the tenancy registry. Any
      // code that tries to turn a system context into a human membership fails
      // closed rather than silently inheriting the installation owner.
      userId: "system:polyth-runtime",
      role: "owner",
      deployment,
      storageDir: spaceStorageDir(opts.dataDir, space),
      authority: { kind: "system", serviceId: "polyth-runtime" },
    };
  };

  const gateway: SpaceGateway = {
    ...canonical,
    resolveInternal: systemContext,
  };
  return {
    gateway,
    // Compatibility metadata only; canonical mode never runs legacy adoption
    // during boot. The reviewed offline migration already made these durable.
    migration: {
      user: owner,
      space: defaultSpace,
      created: false,
      projectsAdopted: 0,
      sessionsAdopted: 0,
    },
  };
}

/** Build the tenancy boundary and run the initial migration. Idempotent: a
 *  second boot finds the Personal Space already present and adopts nothing.
 *  When bootstrap bound canonical security, legacy JSON is never opened. */
export async function createSpaceGateway(
  opts: SpaceGatewayOptions,
): Promise<SpaceGatewayHandle> {
  const canonical = canonicalSpaceGateway(opts);
  if (canonical) {
    const security = canonicalSecurity();
    if (!security) {
      throw Object.assign(new Error("Canonical authority disappeared during boot"), { code: "recovery-required" });
    }
    const reconciled = await reconcileCanonicalResourcesAtBoot({
      security,
      projects: opts.registry,
      sessions: opts.store,
    });
    const changed = Object.values(reconciled).reduce((sum, value) => sum + value, 0);
    if (changed > 0) {
      console.log(`[polyth] canonical resources reconciled at boot (${changed} lifecycle repairs)`);
    }
    return canonical;
  }

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
      // Compatibility-only legacy behavior. Canonical mode never reaches this
      // branch and therefore never maps an internal service to a human owner.
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

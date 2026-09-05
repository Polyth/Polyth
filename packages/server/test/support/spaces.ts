// Test support: a real tenancy boundary over a throwaway data directory.
//
// Tests get the genuine article rather than a stub, so the isolation they
// assert is the isolation production runs. Not a *.test.ts file — the runner's
// glob does not pick it up.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProjectService,
  SessionService,
  SpaceContext,
} from "@polyth/contracts";
import { createProjectService, type ProjectRegistry } from "../../src/projects.ts";
import { createSpaceGateway, type SpaceGateway } from "../../src/spaces.ts";
import type { SpaceServices } from "../../src/spaceScope.ts";

export const tmpDataDir = (prefix = "polyth-spaces-"): string =>
  mkdtempSync(join(tmpdir(), prefix));

/** In-memory stand-in for the session store's tenancy surface. */
export function memorySpaceStore(): {
  spaceOfSession(id: string): string | undefined;
  adoptSessionsIntoSpace(spaceId: string): Promise<number>;
  own(sessionId: string, spaceId: string): void;
} {
  const owners = new Map<string, string>();
  return {
    spaceOfSession: (id) => owners.get(id),
    adoptSessionsIntoSpace: async () => 0,
    own: (sessionId, spaceId) => { owners.set(sessionId, spaceId); },
  };
}

export interface TestTenancy {
  dataDir: string;
  gateway: SpaceGateway;
  registry: ProjectRegistry;
  sessionOwners: ReturnType<typeof memorySpaceStore>;
  /** The Personal Space created by the boot migration. */
  defaultContext: SpaceContext;
  /** Create an additional Space owned by the same user and return its context. */
  addSpace(name: string): SpaceContext;
  services(ctx: SpaceContext): SpaceServices;
}

/** Build a working tenancy boundary for a test. `sessions` defaults to a stub
 *  that answers empty, which is enough for routing/auth tests. */
export async function testTenancy(opts: {
  dataDir?: string;
  sessions?: () => SessionService;
  projects?: ProjectRegistry;
} = {}): Promise<TestTenancy> {
  const dataDir = opts.dataDir ?? tmpDataDir();
  const registry = opts.projects ?? createProjectService(dataDir);
  const sessionOwners = memorySpaceStore();
  const emptySessions = {
    list: async () => [],
    sync: async () => [],
  } as unknown as SessionService;
  const { gateway } = await createSpaceGateway({
    dataDir,
    registry,
    store: sessionOwners,
    sessions: opts.sessions ?? (() => emptySessions),
  });
  const owner = gateway.store.users()[0]!;
  const defaultSpace = gateway.store.defaultSpaceFor(owner.id)!;
  const defaultContext = gateway.resolver.forUser(owner.id, defaultSpace.id);
  return {
    dataDir,
    gateway,
    registry,
    sessionOwners,
    defaultContext,
    addSpace(name) {
      const space = gateway.store.createSpace({ name, ownerId: owner.id });
      return gateway.resolver.forUser(owner.id, space.id);
    },
    services: (ctx) => gateway.services(ctx),
  };
}

/** A plain SpaceContext for tests that fake a RouteRequest directly. */
export const fakeSpaceContext = (overrides: Partial<SpaceContext> = {}): SpaceContext => ({
  spaceId: "spc_test",
  spaceSlug: "test",
  userId: "usr_test",
  role: "owner",
  deployment: "local-trusted",
  storageDir: tmpDataDir("polyth-space-ctx-"),
  ...overrides,
});

/** A `SpaceServicesFor` that hands back the given services unchanged.
 *  For tests whose subject is NOT tenancy — isolation itself is covered by
 *  spaceIsolation.test.ts against the real scoped facades. */
export const passthroughSpaces = (services: {
  sessions?: SessionService;
  projects?: ProjectService;
}) => (ctx: SpaceContext): SpaceServices => ({
  ctx,
  sessions: services.sessions as SessionService,
  projects: services.projects as ProjectService,
  guard: {
    assertSession: () => {},
    assertProject: () => {},
    owns: () => true,
  },
});

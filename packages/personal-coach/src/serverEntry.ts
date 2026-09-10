import type {
  AgentCapabilityContributionRegistry,
  RouteHandler,
  SpaceContext,
} from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { registerCoachCapabilities, type CoachCapabilitySet } from "./capabilities.ts";
import type { CoachStore } from "./index.ts";
import { personalCoachRoutes } from "./routes.ts";
import { createPersonalCoachService, type PersonalCoachService } from "./service.ts";
import { personalCoachSessionRoute } from "./sessionRoute.ts";

export type { PersonalCoachService } from "./service.ts";

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const service = createPersonalCoachService({
    storageFor: (space) => host.spaceStorage(space),
    projects: host.projects,
  });
  host.services.provide(serverServiceKey<PersonalCoachService>("personal-coach"), service);

  let routes: RouteHandler | null = null;
  const capabilities = new Map<string, CoachCapabilitySet>();

  const ensureCapabilities = (
    space: Pick<SpaceContext, "spaceId">,
    projectId: string,
    store: CoachStore,
  ): void => {
    if (capabilities.has(projectId)) return;
    const registry = host.services.require(
      serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
    );
    capabilities.set(projectId, registerCoachCapabilities({ registry, space, projectId, store }));
  };

  const restoreCapabilities = async (): Promise<void> => {
    const projectIds = new Set(
      (await host.store.projections())
        .map((projection) => projection.projectId)
        .filter((projectId) => projectId.startsWith("__polyth_pkg_")),
    );
    for (const projectId of projectIds) {
      const project = await host.projects.get(projectId);
      if (!project?.spaceId) continue;
      try {
        const store = await service.forWorkspaceProject(projectId, project.spaceId);
        ensureCapabilities({ spaceId: project.spaceId }, projectId, store);
      } catch (cause) {
        if ((cause as { code?: string }).code !== "not-found") throw cause;
        // Another package owns this internal workspace.
      }
    }
  };

  return {
    remoteAccess: localOnlyRemoteAccess(["personal-coach"]),
    routes: async (request) => routes ? routes(request) : false,
    async onEnable() {
      const handlers = [
        personalCoachSessionRoute(host, { coach: service, ensureCapabilities }),
        personalCoachRoutes(service),
      ];
      routes = async (request) => {
        for (const handler of handlers) {
          if (await handler(request)) return true;
        }
        return false;
      };
      await restoreCapabilities();
    },
    async onDisable() {
      routes = null;
      for (const capability of [...capabilities.values()].toReversed()) {
        await capability.dispose();
      }
      capabilities.clear();
      service.close();
    },
  };
}

import type {
  AgentCapabilityContributionRegistry,
  Disposable,
} from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  SPACE_SECURE_SAFE,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createWebSearchAgentTool } from "./agentTool.ts";
import { webSearchSkill } from "./agentSkill.ts";
import { WebFetchRuntime } from "./fetchRuntime.ts";
import { createWebFetchAgentTool } from "./fetchTool.ts";
import { createDuckDuckGoProvider } from "./providers/duckduckgo.ts";
import { createTavilyProvider } from "./providers/tavily.ts";
import { webSearchRoutes } from "./routes.ts";
import { WebSearchRuntime } from "./runtime.ts";
import { createWebSearchSettingsStore } from "./settingsStore.ts";
import { WEB_SEARCH_PACKAGE_ID } from "./settings.ts";

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const settings = createWebSearchSettingsStore((space) => host.spaceStorage(space));
  const runtime = new WebSearchRuntime({
    settings,
    providers: [createDuckDuckGoProvider(), createTavilyProvider()],
    spaceForId: (spaceId) => host.systemSpaceContext(spaceId),
    secureSafeForSpace: (space) => host.services.get(SPACE_SECURE_SAFE)?.forSpace(space),
    projectExists: async (space, projectId) => Boolean(await host.forSpace(space).projects.get(projectId)),
  });
  const fetcher = new WebFetchRuntime({
    spaceForId: (spaceId) => host.systemSpaceContext(spaceId),
    projectExists: async (space, projectId) => Boolean(await host.forSpace(space).projects.get(projectId)),
  });
  let registrations: Disposable[] | undefined;

  return {
    routes: webSearchRoutes(runtime),
    remoteAccess: localOnlyRemoteAccess([WEB_SEARCH_PACKAGE_ID]),
    onEnable() {
      if (registrations) return;
      runtime.start();
      fetcher.start();
      const registered: Disposable[] = [];
      try {
        const capabilities = host.services.require(
          serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
        );
        registered.push(capabilities.register(WEB_SEARCH_PACKAGE_ID, webSearchSkill));
        registered.push(capabilities.register(WEB_SEARCH_PACKAGE_ID, createWebSearchAgentTool(runtime)));
        registered.push(capabilities.register(WEB_SEARCH_PACKAGE_ID, createWebFetchAgentTool(fetcher)));
        registrations = registered;
      } catch (cause) {
        for (const registration of registered.toReversed()) registration.dispose();
        fetcher.stop();
        runtime.stop();
        throw cause;
      }
    },
    async onDisable() {
      runtime.stop();
      fetcher.stop();
      for (const registration of registrations?.toReversed() ?? []) await registration.dispose();
      registrations = undefined;
    },
  };
}

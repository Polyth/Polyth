import type { AgentCapabilityContributionRegistry, Disposable, RouteHandler } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  SPACE_SECURE_SAFE,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createGoogleConnector, GOOGLE_PACKAGE_ID, type GoogleConnector } from "./accounts.ts";
import { createOAuthFlows, type OAuthFlows } from "./oauth.ts";
import { googleRoutes } from "./routes.ts";
import { createGoogleTools } from "./tools.ts";

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | undefined;
  let connector: GoogleConnector | undefined;
  let flows: OAuthFlows | undefined;
  let registrations: Disposable[] = [];

  const teardown = async (): Promise<void> => {
    routes = undefined;
    flows?.dispose();
    flows = undefined;
    connector?.reset();
    connector = undefined;
    for (const registration of registrations.toReversed()) await registration.dispose();
    registrations = [];
  };

  return {
    // OAuth secrets and account administration never leave the trusted ingress.
    remoteAccess: localOnlyRemoteAccess([GOOGLE_PACKAGE_ID]),
    routes: async (rc) => routes ? routes(rc) : false,
    async onEnable() {
      if (connector) return;
      const people = host.people;
      if (!people) throw new Error("The Google package needs person-owned storage (host.people), which this host does not provide.");
      const active = createGoogleConnector({
        storage: (spaceId) => host.spaceStorage(host.systemSpaceContext(spaceId)),
        // Resolved per use: the Credential Vault package may be enabled later.
        vault: (spaceId) => host.services.get(SPACE_SECURE_SAFE)?.forSpaceId(spaceId),
        people,
        // The server's own client wins over Polyth's built-in app, whose ID and
        // secret release builds bake in (apps/desktop/build.ts); git has neither.
        env: process.env.POLYTH_GOOGLE_CLIENT_ID?.trim()
          ? { clientId: process.env.POLYTH_GOOGLE_CLIENT_ID, clientSecret: process.env.POLYTH_GOOGLE_CLIENT_SECRET }
          : { clientId: process.env.POLYTH_GOOGLE_BUILTIN_CLIENT_ID, clientSecret: process.env.POLYTH_GOOGLE_BUILTIN_CLIENT_SECRET, builtin: true },
      });
      connector = active;
      flows = createOAuthFlows({ complete: (completion) => active.completeAuthorization(completion) });
      const capabilities = host.services.require(
        serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
      );
      try {
        for (const tool of createGoogleTools(active)) registrations.push(capabilities.register(GOOGLE_PACKAGE_ID, tool));
      } catch (error) {
        await teardown();
        throw error;
      }
      routes = googleRoutes({ connector: active, flows });
    },
    onDisable: teardown,
  };
}

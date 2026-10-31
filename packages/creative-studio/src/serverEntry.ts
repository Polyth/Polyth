import type { AgentCapabilityContributionRegistry, Disposable } from "@polyth/contracts";
import { findChromiumExecutable } from "@polyth/browser/chromium";
import {
  localOnlyRemoteAccess,
  SESSION_PURPOSES,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { CREATIVE_STUDIO_PACKAGE_ID, CREATIVE_STUDIO_PURPOSE, studioTurnContext } from "./index.ts";
import { creativeStudioSkill } from "./skill.ts";
import { studioRoutes } from "./server/routes.ts";
import { createStudioService, type DictationLike, type StudioService } from "./server/service.ts";
import { StudioStore } from "./server/store.ts";
import { createStudioTools } from "./server/tools.ts";

// Studio state lives in each session checkout, so the package keeps no tenant
// data of its own. Enable starts the service and publishes the session
// purpose, the reference skill and the tools; disable stops every render job
// (Chromium + FFmpeg children) before withdrawing them.
export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let service: StudioService | undefined;
  let registrations: Disposable[] = [];

  return {
    remoteAccess: localOnlyRemoteAccess([CREATIVE_STUDIO_PACKAGE_ID]),
    routes: studioRoutes(host, () => service),
    onEnable() {
      if (service) return;
      const created = createStudioService({
        store: new StudioStore(),
        renderer: {
          chromiumPath: () => findChromiumExecutable(),
          ...(process.env.POLYTH_FFMPEG_PATH ? { ffmpegPath: process.env.POLYTH_FFMPEG_PATH } : {}),
        },
        dictation: () => host.services.get(serverServiceKey<DictationLike>("dictation")),
        maxConcurrentRenders: 1,
      });
      service = created;
      registrations.push(host.services.require(SESSION_PURPOSES).register(CREATIVE_STUDIO_PURPOSE, (session) => studioTurnContext(session)));
      const capabilities = host.services.get(serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"));
      if (capabilities) {
        registrations.push(capabilities.register(CREATIVE_STUDIO_PACKAGE_ID, creativeStudioSkill));
        for (const tool of createStudioTools(created)) registrations.push(capabilities.register(CREATIVE_STUDIO_PACKAGE_ID, tool));
      }
    },
    async onDisable() {
      const current = service;
      service = undefined;
      const owned = registrations;
      registrations = [];
      for (const registration of owned.toReversed()) await registration.dispose();
      await current?.dispose();
    },
  };
}

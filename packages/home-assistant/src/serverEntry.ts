import { join } from "node:path";
import type { Disposable } from "@polyth/contracts";
import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import {
  createHomeAssistantPlugin,
  createHomeAssistantService,
  homeAssistantRoutes,
} from "./index.ts";

/** Discovered via the polyth.serverEntry marker in package.json. Routes join
 *  the gateway while the package is enabled; the kernel plugin (capability +
 *  widget contributions) mounts on enable and unmounts on disable. */
export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const service = createHomeAssistantService({
    file: join(host.storageDir, "home-assistant.json"),
  });
  let plugin: Disposable | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["home-assistant"]),
    routes: homeAssistantRoutes(service),
    async onEnable() {
      plugin = await host.loadPlugin(createHomeAssistantPlugin(service));
    },
    async onDisable() {
      await plugin?.dispose();
      plugin = null;
    },
  };
}

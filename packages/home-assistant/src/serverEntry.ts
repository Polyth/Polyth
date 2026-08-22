import { join } from "node:path";
import type { Plugin } from "@polyth/contracts";
import type { TrustedServerPluginHost } from "@polyth/plugins";
import {
  createHomeAssistantPlugin,
  createHomeAssistantService,
  homeAssistantRoutes,
} from "./index.ts";

export default function createHomeAssistantServerPlugin(
  host: TrustedServerPluginHost,
): Plugin {
  const service = createHomeAssistantService({
    file: join(host.storageDir, "home-assistant.json"),
  });
  const plugin = createHomeAssistantPlugin(service);
  return {
    manifest: plugin.manifest,
    async setup(context, config) {
      await plugin.setup(context, config);
      const route = host.routes.add(homeAssistantRoutes(service));
      context.effect(() => route.dispose());
    },
  };
}

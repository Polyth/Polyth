import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import type { RecapEngineService, RecapLifecycleService } from "./index.ts";

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let active = false;
  const lifecycle: RecapLifecycleService = {
    active: () => active,
  };

  host.services.provide(serverServiceKey<RecapLifecycleService>("recap.lifecycle"), lifecycle);

  const engine = (): RecapEngineService | undefined =>
    host.services.get(serverServiceKey<RecapEngineService>("recap.engine"));

  return {
    onEnable() {
      active = true;
      engine()?.activate();
    },
    onDisable() {
      active = false;
      engine()?.stop();
    },
  };
}

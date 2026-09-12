import type { Disposable } from "@polyth/contracts";
import type { ServerPackage, ServerPackageHost } from "@polyth/plugins";
import registerHarnessPackage from "./serverEntry.ts";
import { registerPolythSessionControl } from "./sessionControlTool.ts";

export default async function registerPackage(host: ServerPackageHost): Promise<ServerPackage> {
  const base = await registerHarnessPackage(host);
  let sessionControl: Disposable | undefined;

  return {
    ...base,
    async onEnable() {
      await base.onEnable?.();
      if (!sessionControl) sessionControl = registerPolythSessionControl(host);
    },
    async onDisable() {
      await sessionControl?.dispose();
      sessionControl = undefined;
      await base.onDisable?.();
    },
  };
}

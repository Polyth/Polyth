import type { Disposable } from "@polyth/contracts";
import type { ServerPackage, ServerPackageHost } from "@polyth/plugins";
import registerHarnessPackage from "./serverEntry.ts";
import { registerPeerObservationTool } from "./peerObservationTool.ts";
import { registerPolythSessionControl } from "./sessionControlTool.ts";

export default async function registerPackage(host: ServerPackageHost): Promise<ServerPackage> {
  const base = await registerHarnessPackage(host);
  let sessionControl: Disposable | undefined;
  let peerObservations: Disposable | undefined;

  return {
    ...base,
    async onEnable() {
      await base.onEnable?.();
      if (!sessionControl) sessionControl = registerPolythSessionControl(host);
      if (!peerObservations) peerObservations = registerPeerObservationTool(host);
    },
    async onDisable() {
      await peerObservations?.dispose();
      peerObservations = undefined;
      await sessionControl?.dispose();
      sessionControl = undefined;
      await base.onDisable?.();
    },
  };
}

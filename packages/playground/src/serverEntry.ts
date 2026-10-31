import type { Disposable } from "@polyth/contracts";
import { localOnlyRemoteAccess, SESSION_PURPOSES, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { PLAYGROUND_PURPOSE, playgroundTurnContext } from "./index.ts";

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let registration: Disposable | undefined;
  return {
    remoteAccess: localOnlyRemoteAccess(["playground"]),
    onEnable() {
      registration?.dispose();
      registration = host.services.require(SESSION_PURPOSES).register(
        PLAYGROUND_PURPOSE,
        (session) => playgroundTurnContext(session),
      );
    },
    onDisable() {
      registration?.dispose();
      registration = undefined;
    },
  };
}

import type { Disposable, NativeHarnessMemory } from "@polyth/contracts";
import {
  SERVER_ACCOUNT_REMOVAL_BUS,
  SERVER_PERSON_DATA_VOLUME,
  SERVER_TURN_COMPLETION_BUS,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { JUDGMENT_SERVICE } from "@polyth/judgment/server";
import { createMemoryRuntimeService, createMemoryService, createNativeHarnessMemory, erasePersonMemory, openEverySpace, personMemoryBytes, memoryRoutes, registerMemoryTool, type ScopedMemorySource } from "./service.ts";
import { createSpaceMemoryStores } from "./spaceStore.ts";
import { REFLECT_DURABILITY_DESCRIPTOR, unregisterReflectDurability } from "./reflectService.ts";

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // One database per Space, in this package's own directory. A store is opened
  // only for a Space context the gateway or the host has already admitted.
  const stores = createSpaceMemoryStores(host);
  const source: ScopedMemorySource = {
    async prepareProject(space) { return { memory: stores.forSpace(space) }; },
  };
  const service = createMemoryService(host, source);
  host.services.provide(serverServiceKey("memory"), service);
  host.services.provide(serverServiceKey("memory.runtime"), createMemoryRuntimeService(host, service));
  let enabled = false;
  host.services.provide(serverServiceKey<NativeHarnessMemory>("memory.native-harness"), createNativeHarnessMemory(host, service, () => enabled));
  let tool: Disposable | undefined;
  let completion: Disposable | undefined;
  let accountRemoval: Disposable | undefined;
  let dataVolume: Disposable | undefined;
  let unregisterUse: (() => void) | undefined;
  return {
    // Explicit local-only inventory; paired devices remain default-deny.
    remoteAccess: { routeScopes: ["memory"], http: [] },
    routes: memoryRoutes(host, service),
    onEnable() {
      enabled = true;
      tool = registerMemoryTool(host, service);
      const judgment = host.services?.get ? host.services.get(JUDGMENT_SERVICE) : undefined;
      if (judgment) {
        try {
          unregisterUse = judgment.registerUse(REFLECT_DURABILITY_DESCRIPTOR);
        } catch {
          // tolerate duplicate registration
        }
      }
      const bus = host.services.get(SERVER_TURN_COMPLETION_BUS);
      completion = bus?.subscribe((event) => {
        // Deterministic and local: proposals only, no model call, no writes
        // beyond this Space's Reflect queue. A failed scan retries next turn.
        void service.reflect.kick(event.sessionId).catch(() => undefined);
        return service.harvest.kick(event.sessionId);
      });
      accountRemoval = host.services.get(SERVER_ACCOUNT_REMOVAL_BUS)?.subscribe(({ userId }) =>
        erasePersonMemory(host, service, userId).then(() => undefined));
      dataVolume = host.services.get(SERVER_PERSON_DATA_VOLUME)?.contribute((userId) => personMemoryBytes(host, service, userId));
      service.harvest.start();
      // Every Space moves to this store at start, not when someone first opens
      // its memory: the old tables are gone for everyone after one restart.
      void openEverySpace(host, service);
    },
    async onDisable() {
      enabled = false;
      unregisterUse?.();
      unregisterUse = undefined;
      unregisterReflectDurability();
      completion?.dispose(); completion = undefined;
      accountRemoval?.dispose(); accountRemoval = undefined;
      dataVolume?.dispose(); dataVolume = undefined;
      tool?.dispose(); tool = undefined;
      await service.harvest.stop();
      stores.close();
    },
  };
}

import type { Disposable } from "@polyth/contracts";
import {
  SERVER_TURN_COMPLETION_BUS,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { JUDGMENT_SERVICE } from "@polyth/judgment/server";
import { createMemoryRuntimeService, createMemoryService, MEMORY_SCOPE_SERVICE, memoryRoutes, registerMemoryTool, type ScopedMemorySource } from "./service.ts";
import { REFLECT_DURABILITY_DESCRIPTOR, unregisterReflectDurability } from "./reflectService.ts";

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // The knowledge package owns the database. Resolve its Space router only
  // when a request/job is admitted; package discovery order is not a data
  // dependency order and opening a fallback DB here would break isolation.
  const source: ScopedMemorySource = {
    async prepareProject(space, projectId) {
      const router = host.services.get(MEMORY_SCOPE_SERVICE);
      if (!router) throw Object.assign(new Error("memory service is unavailable"), { code: "unavailable" });
      return router.prepareProject(space, projectId);
    },
  };
  const service = createMemoryService(host, source);
  host.services.provide(serverServiceKey("memory"), service);
  host.services.provide(serverServiceKey("memory.runtime"), createMemoryRuntimeService(host, service));
  let tool: Disposable | undefined;
  let completion: Disposable | undefined;
  let unregisterUse: (() => void) | undefined;
  return {
    // Explicit local-only inventory; paired devices remain default-deny.
    remoteAccess: { routeScopes: ["memory"], http: [] },
    routes: memoryRoutes(host, service),
    onEnable() {
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
      service.harvest.start();
    },
    async onDisable() {
      unregisterUse?.();
      unregisterUse = undefined;
      unregisterReflectDurability();
      completion?.dispose(); completion = undefined;
      tool?.dispose(); tool = undefined;
      await service.harvest.stop();
    },
  };
}

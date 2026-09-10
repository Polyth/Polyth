import { join } from "node:path";
import type { RouteHandler, SpaceContext, SpaceStorage } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createCoachStore, type CoachStore } from "./index.ts";
import { personalCoachRoutes } from "./routes.ts";
import { personalCoachSessionRoute } from "./sessionRoute.ts";

export interface PersonalCoachService {
  forSpace(space: SpaceContext): CoachStore;
  close(): void;
}

export function createPersonalCoachService(
  storageFor: (space: SpaceContext) => SpaceStorage,
): PersonalCoachService {
  const stores = new Map<string, CoachStore>();
  return {
    forSpace(space) {
      const storage = storageFor(space);
      const key = `${space.spaceId}\0${storage.root}`;
      let store = stores.get(key);
      if (!store) {
        store = createCoachStore(join(storage.packageDir("personal-coach"), "coach.db"));
        stores.set(key, store);
      }
      return store;
    },
    close() {
      for (const store of stores.values()) store.close();
      stores.clear();
    },
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const service = createPersonalCoachService((space) => host.spaceStorage(space));
  host.services.provide(serverServiceKey<PersonalCoachService>("personal-coach"), service);
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["personal-coach"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const handlers = [
        personalCoachSessionRoute(host),
        personalCoachRoutes(service),
      ];
      routes = async (request) => {
        for (const handler of handlers) {
          if (await handler(request)) return true;
        }
        return false;
      };
    },
    onDisable() {
      routes = null;
      service.close();
    },
  };
}

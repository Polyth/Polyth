import type { Disposable, RemoteAccessPolicy, RouteHandler } from "@polyth/contracts";
import type { OwnedRemotePolicy } from "./remotePolicy.ts";
import { validateRemoteAccessPolicy } from "./remotePolicy.ts";

export interface RouteRegistry {
  add(handler: RouteHandler): Disposable;
  add(id: string, handler: RouteHandler, remoteAccess?: RemoteAccessPolicy): Disposable;
  handler: RouteHandler;
  policies(): OwnedRemotePolicy[];
}

export function createRouteRegistry(): RouteRegistry {
  const handlers = new Map<string | symbol, {
    handler: RouteHandler;
    remoteAccess?: RemoteAccessPolicy;
    owner: string;
  }>();

  return {
    add(idOrHandler: string | RouteHandler, maybeHandler?: RouteHandler, remoteAccess?: RemoteAccessPolicy) {
      const id = typeof idOrHandler === "string" ? idOrHandler : Symbol("plugin-route");
      const handler = typeof idOrHandler === "string" ? maybeHandler! : idOrHandler;
      const owner = typeof idOrHandler === "string" ? idOrHandler : "anonymous";
      if (remoteAccess) validateRemoteAccessPolicy(owner, remoteAccess);
      handlers.set(id, { handler, remoteAccess, owner });
      return {
        dispose() {
          const current = handlers.get(id);
          if (current?.handler === handler) handlers.delete(id);
        },
      };
    },
    policies() {
      const out: OwnedRemotePolicy[] = [];
      for (const entry of handlers.values()) {
        if (entry.remoteAccess) out.push({ owner: entry.owner, policy: entry.remoteAccess });
      }
      return out;
    },
    async handler(request) {
      for (const entry of handlers.values()) {
        if (await entry.handler(request)) return true;
      }
      return false;
    },
  };
}

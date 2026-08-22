import type { Disposable } from "@polyth/contracts";
import type { RouteHandler } from "./http.ts";

export interface RouteRegistry {
  add(handler: RouteHandler): Disposable;
  add(id: string, handler: RouteHandler): Disposable;
  handler: RouteHandler;
}

export function createRouteRegistry(): RouteRegistry {
  const handlers = new Map<string | symbol, RouteHandler>();

  return {
    add(idOrHandler: string | RouteHandler, maybeHandler?: RouteHandler) {
      const id = typeof idOrHandler === "string" ? idOrHandler : Symbol("plugin-route");
      const handler = typeof idOrHandler === "string" ? maybeHandler! : idOrHandler;
      handlers.set(id, handler);
      return {
        dispose() {
          if (handlers.get(id) === handler) handlers.delete(id);
        },
      };
    },
    async handler(request) {
      for (const handler of handlers.values()) {
        if (await handler(request)) return true;
      }
      return false;
    },
  };
}

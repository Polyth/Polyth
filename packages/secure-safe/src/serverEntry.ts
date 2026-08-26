import type {
  RouteHandler,
  SecureSafeKind,
  SecureSafePatchInput,
  SecureSafeScope,
  SecureSafeService,
} from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";

const kind = (value: unknown): SecureSafeKind => {
  if (value === "env" || value === "token" || value === "password") return value;
  throw Object.assign(new Error("kind must be env, token, or password"), {
    code: "invalid-input",
  });
};

const scope = (value: unknown): SecureSafeScope => {
  if (value === "global" || value === "project") return value;
  throw Object.assign(new Error("scope must be global or project"), {
    code: "invalid-input",
  });
};

export function secureSafeRoutes(safe: SecureSafeService): RouteHandler {
  return async ({ path, method, body, json }) => {
    if (path === "/api/secure-safe" && method === "GET") {
      json(200, safe.list());
      return true;
    }
    if (path === "/api/secure-safe/forbidden-config" && method === "GET") {
      json(200, safe.manifest());
      return true;
    }
    if (path === "/api/secure-safe" && method === "POST") {
      const input = await body();
      json(200, await safe.create({
        handle: String(input.handle ?? ""),
        label: String(input.label ?? ""),
        ...(input.purpose !== undefined ? { purpose: String(input.purpose) } : {}),
        ...(input.kind !== undefined ? { kind: kind(input.kind) } : {}),
        ...(input.scope !== undefined ? { scope: scope(input.scope) } : {}),
        ...(input.projectId !== undefined
          ? { projectId: String(input.projectId) }
          : {}),
        value: typeof input.value === "string" ? input.value : "",
      }));
      return true;
    }
    const match = path.match(/^\/api\/secure-safe\/([^/]+)$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]!);
    if (method === "PATCH") {
      const input = await body();
      const patch: SecureSafePatchInput = {
        ...(input.handle !== undefined ? { handle: String(input.handle) } : {}),
        ...(input.label !== undefined ? { label: String(input.label) } : {}),
        ...(input.purpose !== undefined ? { purpose: String(input.purpose) } : {}),
        ...(input.kind !== undefined ? { kind: kind(input.kind) } : {}),
        ...(input.scope !== undefined ? { scope: scope(input.scope) } : {}),
        ...(input.projectId !== undefined
          ? { projectId: input.projectId === null ? null : String(input.projectId) }
          : {}),
        ...(typeof input.value === "string" ? { value: input.value } : {}),
      };
      json(200, await safe.update(id, patch));
      return true;
    }
    if (method === "DELETE") {
      json(200, { ok: await safe.remove(id) });
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | null = null;
  return {
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      routes ??= secureSafeRoutes(host.services.require(
        serverServiceKey<SecureSafeService>("secure-safe"),
      ));
    },
  };
}

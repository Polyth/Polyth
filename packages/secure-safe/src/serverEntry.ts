import type {
  RouteHandler,
  SecureSafeKind,
  SecureSafePatchInput,
  SecureSafeScope,
  SecureSafeService,
  SpaceContext,
  SpaceStorage,
} from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  SPACE_SECURE_SAFE,
  type ServerPackage,
  type ServerPackageHost,
  type SpaceSecureSafeRegistry,
} from "@polyth/plugins";
import {
  configureSecureSafeSpaceRouting,
  createSecureSafeService,
} from "./index.ts";

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

function routeWith(resolveSafe: (space: SpaceContext) => SecureSafeService): RouteHandler {
  return async ({ path, method, body, json, space }) => {
    const safe = resolveSafe(space);
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

/** Legacy/test helper for a pre-resolved safe. Production uses Space routing. */
export function secureSafeRoutes(safe: SecureSafeService): RouteHandler {
  return routeWith(() => safe);
}

function createSpaceSafeRegistry(host: ServerPackageHost): SpaceSecureSafeRegistry {
  const safes = new Map<string, SecureSafeService>();
  const rootsBySpace = new Map<string, string>();

  const forStorage = (spaceId: string, storage: SpaceStorage): SecureSafeService => {
    const root = storage.path("secure-safe");
    rootsBySpace.set(spaceId, root);
    let safe = safes.get(root);
    if (!safe) {
      safe = createSecureSafeService({ dataDir: root, localOnly: true });
      safes.set(root, safe);
    }
    return safe;
  };

  return {
    forSpace(space) {
      return forStorage(space.spaceId, host.spaceStorage(space));
    },
    forSpaceId(spaceId) {
      const known = rootsBySpace.get(spaceId);
      if (known) return safes.get(known);
      const view = host.packageSpaces?.().find((item) => item.spaceId === spaceId);
      return view ? forStorage(spaceId, view.storage) : undefined;
    },
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const spaces = createSpaceSafeRegistry(host);
  host.services.provide(SPACE_SECURE_SAFE, spaces);
  configureSecureSafeSpaceRouting((space) => spaces.forSpace(space));
  const routes = routeWith((space) => spaces.forSpace(space));
  return {
    remoteAccess: localOnlyRemoteAccess(["secure-safe"]),
    routes,
  };
}

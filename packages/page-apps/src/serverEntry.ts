import type { RemoteAccessPolicy, RouteHandler, SpaceContext } from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import type { ServerPackage, ServerPackageHost } from "@polyth/plugins";
import { join } from "node:path";
import { APP_LIMITS, PAGE_APPS_PACKAGE_ID } from "./apps.ts";
import { createPageAppsService } from "./service.ts";

export const PAGE_APPS_PATH = "/api/page-apps";
const APP_PATH = `${PAGE_APPS_PATH}/app`;
const UPDATE_PATH = `${PAGE_APPS_PATH}/update`;
const DELETE_PATH = `${PAGE_APPS_PATH}/delete`;
const STORAGE_PATH = `${PAGE_APPS_PATH}/storage`;

// A page or a storage map, with room for JSON escaping.
const MAX_SAVE_BYTES = 2 * APP_LIMITS.htmlBytes + 64 * 1024;
const MAX_STORAGE_BYTES = 2 * APP_LIMITS.storageBytes + 64 * 1024;
const MAX_SMALL_BYTES = 16 * 1024;

// Paired devices open and keep apps exactly as far as their session grants
// reach. Ids travel in bodies and queries, so no path segment is user text.
export const PAGE_APPS_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: [PAGE_APPS_PACKAGE_ID],
  http: [
    ...[PAGE_APPS_PATH, APP_PATH].map((path) => ({
      methods: ["GET"] as const,
      path,
      capability: REMOTE_CAPABILITY.coreSessionsRead,
      mutation: false,
    })),
    ...([
      [PAGE_APPS_PATH, MAX_SAVE_BYTES],
      [UPDATE_PATH, MAX_SMALL_BYTES],
      [DELETE_PATH, MAX_SMALL_BYTES],
      [STORAGE_PATH, MAX_STORAGE_BYTES],
    ] as const).map(([path, maxBodyBytes]) => ({
      methods: ["POST"] as const,
      path,
      capability: REMOTE_CAPABILITY.coreSessionsControl,
      mutation: true,
      maxBodyBytes,
    })),
  ],
};

const publicError = (cause: unknown): { status: number; code: string; message: string } => {
  const code = typeof (cause as { code?: unknown })?.code === "string" ? (cause as { code: string }).code : "unavailable";
  const message = cause instanceof Error ? cause.message : "Apps are unavailable";
  if (code === "invalid-input") return { status: 400, code, message };
  if (code === "forbidden") return { status: 403, code, message };
  if (code === "not-found") return { status: 404, code, message };
  if (code === "conflict") return { status: 409, code, message };
  if (code === "too-large") return { status: 413, code, message };
  console.error("[polyth] page apps failed", cause);
  return { status: 503, code: "unavailable", message: "Apps are unavailable" };
};

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const SPACE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$/;

/** Apps belong to one signed-in person in one Space. */
function requirePerson(space: SpaceContext): string {
  const userId = space.userId;
  if (
    typeof userId !== "string"
    || userId === ""
    || userId.startsWith("system:")
    || (space as { authority?: { kind?: unknown } }).authority?.kind === "system"
  ) {
    throw fail("forbidden", "Apps belong to a signed-in person");
  }
  if (!SPACE_SEGMENT.test(space.spaceId)) throw fail("invalid-input", "Invalid Space id");
  return userId;
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const service = createPageAppsService({
    path: (space, relative) => {
      const userId = requirePerson(space);
      if (!host.people) throw fail("unavailable", "Apps need person-owned storage, which this host does not provide");
      return host.people.storage(userId, PAGE_APPS_PACKAGE_ID).path(join("spaces", space.spaceId, relative));
    },
  });

  const routes: RouteHandler = async (request) => {
    const { path, method, space, json, url } = request;
    if (path !== PAGE_APPS_PATH && !path.startsWith(`${PAGE_APPS_PATH}/`)) return false;
    try {
      if (method === "GET") {
        if (path === PAGE_APPS_PATH) {
          requirePerson(space);
          json(200, await service.list(space));
          return true;
        }
        if (path === APP_PATH) {
          requirePerson(space);
          json(200, await service.open(space, url.searchParams.get("id")));
          return true;
        }
        return false;
      }
      if (method !== "POST" || ![PAGE_APPS_PATH, UPDATE_PATH, DELETE_PATH, STORAGE_PATH].includes(path)) return false;
      requirePerson(space);
      const body = await request.body();
      if (path === PAGE_APPS_PATH) json(200, await service.save(space, body));
      else if (path === UPDATE_PATH) json(200, await service.rename(space, body.id, body.title));
      else if (path === DELETE_PATH) json(200, await service.remove(space, body.id));
      else json(200, await service.store(space, body.id, body));
      return true;
    } catch (cause) {
      const error = publicError(cause);
      json(error.status, { error: error.code, message: error.message });
      return true;
    }
  };

  return { remoteAccess: PAGE_APPS_REMOTE_ACCESS, routes };
}

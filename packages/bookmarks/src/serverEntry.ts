import type { RemoteAccessPolicy, RouteHandler, SpaceContext } from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import type { ServerPackage, ServerPackageHost } from "@polyth/plugins";
import { join } from "node:path";
import { BOOKMARK_LIMITS, BOOKMARKS_PACKAGE_ID } from "./bookmarks.ts";
import { createBookmarksService } from "./service.ts";

export const BOOKMARKS_PATH = "/api/bookmarks";
const BODY_PATH = `${BOOKMARKS_PATH}/body`;
const EXPORT_PATH = `${BOOKMARKS_PATH}/export`;
const UPDATE_PATH = `${BOOKMARKS_PATH}/update`;
const DELETE_PATH = `${BOOKMARKS_PATH}/delete`;

// Text, title and note, with room for JSON escaping.
const MAX_REQUEST_BYTES = 2 * BOOKMARK_LIMITS.bodyBytes + 128 * 1024;

// Paired devices read and save bookmarks exactly as far as their session grants
// reach. Ids travel in bodies and queries, so no path segment is user text.
export const BOOKMARKS_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: [BOOKMARKS_PACKAGE_ID],
  http: [
    ...[BOOKMARKS_PATH, BODY_PATH, EXPORT_PATH].map((path) => ({
      methods: ["GET"] as const,
      path,
      capability: REMOTE_CAPABILITY.coreSessionsRead,
      mutation: false,
    })),
    ...[BOOKMARKS_PATH, UPDATE_PATH, DELETE_PATH].map((path) => ({
      methods: ["POST"] as const,
      path,
      capability: REMOTE_CAPABILITY.coreSessionsControl,
      mutation: true,
      maxBodyBytes: MAX_REQUEST_BYTES,
    })),
  ],
};

const publicError = (cause: unknown): { status: number; code: string; message: string } => {
  const code = typeof (cause as { code?: unknown })?.code === "string" ? (cause as { code: string }).code : "unavailable";
  const message = cause instanceof Error ? cause.message : "Bookmarks are unavailable";
  if (code === "invalid-input") return { status: 400, code, message };
  if (code === "forbidden") return { status: 403, code, message };
  if (code === "not-found") return { status: 404, code, message };
  if (code === "conflict") return { status: 409, code, message };
  console.error("[polyth] bookmarks failed", cause);
  return { status: 503, code: "unavailable", message: "Bookmarks are unavailable" };
};

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const SPACE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$/;

/** Bookmarks belong to one signed-in person in one Space (Spaces §14.6). */
function requirePerson(space: SpaceContext): string {
  const userId = space.userId;
  if (
    typeof userId !== "string"
    || userId === ""
    || userId.startsWith("system:")
    || (space as { authority?: { kind?: unknown } }).authority?.kind === "system"
  ) {
    throw fail("forbidden", "Bookmarks belong to a signed-in person");
  }
  if (!SPACE_SEGMENT.test(space.spaceId)) throw fail("invalid-input", "Invalid Space id");
  return userId;
}

const query = (url: URL, name: string): string | undefined => url.searchParams.get(name) ?? undefined;

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const service = createBookmarksService({
    path: (space, relative) => {
      const userId = requirePerson(space);
      if (!host.people) throw fail("unavailable", "Bookmarks need person-owned storage, which this host does not provide");
      return host.people.storage(userId, BOOKMARKS_PACKAGE_ID).path(join("spaces", space.spaceId, relative));
    },
    session: (space, sessionId) => host.forSpace(space).sessions.snapshot(sessionId),
    exists: async (sessionId) => (await host.store.projection(sessionId)) !== undefined,
    projectName: async (space, projectId) => {
      try {
        return (await host.forSpace(space).projects.get(projectId))?.name;
      } catch {
        return undefined;
      }
    },
  });

  const routes: RouteHandler = async (request) => {
    const { path, method, space, json, url } = request;
    if (path !== BOOKMARKS_PATH && !path.startsWith(`${BOOKMARKS_PATH}/`)) return false;
    try {
      const scope = {
        ...(query(url, "projectId") ? { projectId: query(url, "projectId")! } : {}),
        ...(query(url, "sessionId") ? { sessionId: query(url, "sessionId")! } : {}),
      };
      if (method === "GET") {
        if (path === BOOKMARKS_PATH) {
          requirePerson(space);
          json(200, await service.list(space, scope));
          return true;
        }
        if (path === BODY_PATH) {
          requirePerson(space);
          json(200, await service.body(space, query(url, "id") ?? ""));
          return true;
        }
        if (path === EXPORT_PATH) {
          requirePerson(space);
          json(200, await service.exportMarkdown(space, scope));
          return true;
        }
        return false;
      }
      if (method !== "POST" || ![BOOKMARKS_PATH, UPDATE_PATH, DELETE_PATH].includes(path)) return false;
      requirePerson(space);
      const body = await request.body();
      if (path === BOOKMARKS_PATH) {
        json(200, { bookmark: await service.create(space, body) });
        return true;
      }
      const id = typeof body.id === "string" ? body.id : "";
      if (path === UPDATE_PATH) {
        json(200, { bookmark: await service.update(space, id, body.revision, body) });
        return true;
      }
      json(200, await service.remove(space, id));
      return true;
    } catch (cause) {
      const error = publicError(cause);
      json(error.status, { error: error.code, message: error.message });
      return true;
    }
  };

  return { remoteAccess: BOOKMARKS_REMOTE_ACCESS, routes };
}

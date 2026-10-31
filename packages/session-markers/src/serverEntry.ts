import type { AgentCapabilityContributionRegistry, Disposable, RemoteAccessPolicy, RouteHandler, SpaceContext } from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import { serverServiceKey, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { createSessionMarkersTool, sessionMarkersSkill } from "./agentTool.ts";
import { invalidInput, SESSION_MARKERS_PACKAGE_ID, type MarkerAddition } from "./markers.ts";
import { createSessionMarkersService } from "./service.ts";

export const SESSION_MARKERS_PATH = "/api/session-markers";
const APPLY_PATH = `${SESSION_MARKERS_PATH}/apply`;
const DEFINITIONS_PATH = `${SESSION_MARKERS_PATH}/definitions`;
const UPDATE_PATH = `${DEFINITIONS_PATH}/update`;
const DELETE_PATH = `${DEFINITIONS_PATH}/delete`;

// Paired devices may read and mark chats exactly as far as their session
// grants reach; marker ids travel in bodies, so no path segment is user text.
export const SESSION_MARKERS_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: [SESSION_MARKERS_PACKAGE_ID],
  http: [
    { methods: ["GET"], path: SESSION_MARKERS_PATH, capability: REMOTE_CAPABILITY.coreSessionsRead, mutation: false },
    ...[APPLY_PATH, DEFINITIONS_PATH, UPDATE_PATH, DELETE_PATH].map((path) => ({
      methods: ["POST"] as const,
      path,
      capability: REMOTE_CAPABILITY.coreSessionsControl,
      mutation: true,
      maxBodyBytes: 64 * 1024,
    })),
  ],
};

const publicError = (cause: unknown): { status: number; code: string; message: string } => {
  const code = typeof (cause as { code?: unknown })?.code === "string" ? (cause as { code: string }).code : "unavailable";
  const message = cause instanceof Error ? cause.message : "Chat markers are unavailable";
  if (code === "invalid-input") return { status: 400, code, message };
  if (code === "forbidden") return { status: 403, code, message };
  if (code === "not-found") return { status: 404, code, message };
  if (code === "conflict") return { status: 409, code, message };
  console.error("[polyth] chat markers failed", cause);
  return { status: 503, code: "unavailable", message: "Chat markers are unavailable" };
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const additions = (value: unknown): MarkerAddition[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidInput("add must be a list");
  return value.map((item) => {
    if (typeof item === "string") return { marker: item };
    if (item && typeof item === "object" && typeof (item as { marker?: unknown }).marker === "string") {
      const { marker, note } = item as { marker: string; note?: unknown };
      return { marker, ...(note !== undefined ? { note } : {}) };
    }
    throw invalidInput("Each addition names a marker");
  });
};

const requireWriter = (space: SpaceContext): void => {
  if (space.role === "viewer") throw Object.assign(new Error("Viewers can't change chat markers"), { code: "forbidden" });
};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const service = createSessionMarkersService({
    storage: (space) => host.spaceStorage(space),
    session: (space, sessionId) => host.forSpace(space).sessions.snapshot(sessionId),
    exists: async (sessionId) => (await host.store.projection(sessionId)) !== undefined,
  });
  const tool = createSessionMarkersTool({
    service,
    personSpace: (userId, spaceId) => host.personSpaceContext?.(userId, spaceId),
    systemSpace: (spaceId) => host.systemSpaceContext(spaceId),
    projectName: async (space, projectId) => (await host.forSpace(space).projects.get(projectId))?.name,
  });
  let capabilities: Disposable[] = [];

  const routes: RouteHandler = async (request) => {
    const { path, method, space, json } = request;
    if (path !== SESSION_MARKERS_PATH && !path.startsWith(`${SESSION_MARKERS_PATH}/`)) return false;
    try {
      if (path === SESSION_MARKERS_PATH && method === "GET") {
        json(200, await service.snapshot(space));
        return true;
      }
      if (method !== "POST" || ![APPLY_PATH, DEFINITIONS_PATH, UPDATE_PATH, DELETE_PATH].includes(path)) return false;
      requireWriter(space);
      const body = await request.body();
      if (path === APPLY_PATH) {
        json(200, await service.apply(space, {
          sessionIds: strings(body.sessionIds),
          add: additions(body.add),
          remove: strings(body.remove),
          clear: body.clear === true,
          create: body.create === true,
        }, { kind: "person", userId: space.userId }));
        return true;
      }
      if (path === DEFINITIONS_PATH) {
        json(200, await service.define(space, body));
        return true;
      }
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) throw invalidInput("Name the marker");
      json(200, path === UPDATE_PATH ? await service.update(space, id, body) : await service.remove(space, id));
      return true;
    } catch (cause) {
      const error = publicError(cause);
      json(error.status, { error: error.code, message: error.message });
      return true;
    }
  };

  return {
    remoteAccess: SESSION_MARKERS_REMOTE_ACCESS,
    routes,
    onEnable() {
      const registry = host.services.get(serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"));
      if (registry && capabilities.length === 0) {
        capabilities = [
          registry.register(SESSION_MARKERS_PACKAGE_ID, sessionMarkersSkill),
          registry.register(SESSION_MARKERS_PACKAGE_ID, tool),
        ];
      }
    },
    async onDisable() {
      for (const capability of capabilities.toReversed()) await capability.dispose();
      capabilities = [];
    },
  };
}

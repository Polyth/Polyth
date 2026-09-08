import type {
  AgentDescriptor,
  AgentProfile,
  ModelDescriptor,
  ModelDiscoveryState,
  RouteHandler,
} from "@polyth/contracts";
import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { customProviderRoutes } from "./customProviderRoutes.ts";
import { validateProfile } from "./index.ts";

interface ProfileStore {
  profileList(): Promise<AgentProfile[]>;
  profileGet(id: string): Promise<AgentProfile | undefined>;
  profileCreate(
    input: Omit<AgentProfile, "id" | "revision" | "createdAt" | "updatedAt">,
  ): Promise<AgentProfile>;
  profileUpdate(
    id: string,
    patch: Partial<Omit<AgentProfile, "id" | "revision" | "createdAt" | "updatedAt">>,
    expectedRevision: number,
  ): Promise<AgentProfile>;
  profileRemove(id: string): Promise<boolean>;
}

export function profileRoutes(deps: {
  store: ProfileStore;
  listModels(): Promise<ModelDescriptor[]>;
  listAgents(): Promise<AgentDescriptor[]>;
}): RouteHandler {
  const optional = (value: unknown): string | undefined =>
    value === undefined ? undefined : value === null ? "" : String(value);
  const patchOf = (
    input: Record<string, unknown>,
  ): Partial<Omit<AgentProfile, "id" | "revision" | "createdAt" | "updatedAt">> => ({
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    ...(typeof input.harnessId === "string" ? { harnessId: input.harnessId } : {}),
    ...(typeof input.providerID === "string" ? { providerID: input.providerID } : {}),
    ...(typeof input.modelID === "string" ? { modelID: input.modelID } : {}),
    ...(optional(input.agent) !== undefined ? { agent: optional(input.agent)! } : {}),
    ...(optional(input.mode) !== undefined ? { mode: optional(input.mode)! } : {}),
    ...(optional(input.thinking) !== undefined
      ? { thinking: optional(input.thinking)! }
      : {}),
    ...(input.features && typeof input.features === "object"
      ? { features: input.features as Record<string, boolean> }
      : {}),
    ...(optional(input.notes) !== undefined ? { notes: optional(input.notes)! } : {}),
    ...(optional(input.icon) !== undefined ? { icon: optional(input.icon)! } : {}),
    ...(optional(input.color) !== undefined ? { color: optional(input.color)! } : {}),
  });

  return async ({ path, method, body, json }) => {
    if (!path.startsWith("/api/agent-profiles")) return false;
    if (path === "/api/agent-profiles" && method === "GET") {
      json(200, await deps.store.profileList());
      return true;
    }
    if (path === "/api/agent-profiles" && method === "POST") {
      const input = await body();
      json(200, await deps.store.profileCreate({
        name: String(input.name ?? ""),
        // This endpoint historically described OpenCode models. Keeping that
        // default preserves old clients while every updated profile editor
        // sends an explicit harness identity.
        harnessId: typeof input.harnessId === "string" ? input.harnessId : "opencode",
        providerID: String(input.providerID ?? ""),
        modelID: String(input.modelID ?? ""),
        features: input.features && typeof input.features === "object"
          ? input.features as Record<string, boolean>
          : {},
        ...(input.agent ? { agent: String(input.agent) } : {}),
        ...(input.mode ? { mode: String(input.mode) } : {}),
        ...(input.thinking ? { thinking: String(input.thinking) } : {}),
        ...(input.notes ? { notes: String(input.notes) } : {}),
        ...(input.icon ? { icon: String(input.icon) } : {}),
        ...(input.color ? { color: String(input.color) } : {}),
      }));
      return true;
    }
    let match = path.match(/^\/api\/agent-profiles\/([^/]+)\/validate$/);
    if (match && method === "POST") {
      const profile = await deps.store.profileGet(match[1]!);
      if (!profile) {
        json(404, { error: "not-found" });
        return true;
      }
      const [models, agents] = await Promise.all([
        deps.listModels().catch((): ModelDescriptor[] => []),
        deps.listAgents().catch((): AgentDescriptor[] => []),
      ]);
      json(200, validateProfile(profile, models, agents));
      return true;
    }
    match = path.match(/^\/api\/agent-profiles\/([^/]+)$/);
    if (match && method === "GET") {
      const profile = await deps.store.profileGet(match[1]!);
      if (!profile) {
        json(404, { error: "not-found" });
        return true;
      }
      json(200, profile);
      return true;
    }
    if (match && method === "PATCH") {
      const input = await body();
      json(200, await deps.store.profileUpdate(
        match[1]!,
        patchOf(input),
        Number(input.expectedRevision ?? 0),
      ));
      return true;
    }
    if (match && method === "DELETE") {
      const removed = await deps.store.profileRemove(match[1]!);
      json(removed ? 200 : 404, removed ? { ok: true } : { error: "not-found" });
      return true;
    }
    return false;
  };
}

const aggregate = async <T>(
  host: ServerPackageHost,
  fetch: (projectId: string) => Promise<T[]>,
  key: (item: T) => string,
): Promise<T[]> => {
  const projects = await host.projects.list();
  const ids = projects.length ? projects.map((project) => project.id) : ["__default__"];
  const settled = await Promise.allSettled(ids.map(fetch));
  const seen = new Set<string>();
  const result: T[] = [];
  for (const response of settled) {
    if (response.status !== "fulfilled") continue;
    for (const item of response.value) {
      const id = key(item);
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(item);
    }
  }
  return result;
};

/** Route-local catalogs keep account/model identity scoped to the session's
 * current runtime. A provider's empty model list means native default. */
export function runtimeCatalogRoutes(host: ServerPackageHost): RouteHandler {
  return async (request) => {
    const sessionId = request.url.searchParams.get("sessionId");
    if (request.path !== "/api/runtime-catalog" || !sessionId || request.method !== "GET") return false;
    const scoped = host.forSpace(request.space);
    const session = await scoped.sessions.snapshot(sessionId);
    const project = await scoped.projects.get(session.projectId);
    if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
    if (session.harnessTransition) throw Object.assign(new Error("Harness switch in progress"), { code: "conflict" });
    const runtime = host.runtimes.forSession
      ? await host.runtimes.forSession(session, session.worktreePath ?? project.path)
      : await host.runtimes.forProject(project.id, session.worktreePath ?? project.path);
    // A harness whose discovery failed is reported as unavailable with the
    // reason. Reporting it as an empty catalog would tell the user this engine
    // has no models, which is a different and false claim.
    const [modelResult, rawAgents, capabilities] = await Promise.all([
      runtime.models().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, reason: (error as { message?: string })?.message?.trim() || "model discovery failed" }),
      ),
      runtime.agents().catch(() => []),
      runtime.capabilities(),
    ]);
    const models = (modelResult.ok ? modelResult.value : []).map((model) => ({ ...model, ...(runtime.harnessId ? { harnessId: runtime.harnessId } : {}) }));
    const agents = rawAgents.map((agent) => ({ ...agent, ...(runtime.harnessId ? { harnessId: runtime.harnessId } : {}) }));
    const discovery: ModelDiscoveryState = !modelResult.ok
      ? { state: "unavailable", reason: modelResult.reason }
      : models.length > 0 ? { state: "available" } : { state: "empty" };
    request.json(200, { models, agents, capabilities, discovery, nativeDefault: models.length === 0, harnessId: runtime.harnessId }); return true;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const listModels = () => aggregate(
    host,
    async (projectId) => {
      const runtime = await host.runtimes.forProject(projectId);
      return (await runtime.models()).map((model) => ({
        ...model,
        ...(runtime.harnessId ? { harnessId: runtime.harnessId } : {}),
      }));
    },
    (model) => `${model.harnessId ?? "legacy"}/${model.providerID}/${model.modelID}`,
  );
  const listAgents = () => aggregate(
    host,
    async (projectId) => {
      const runtime = await host.runtimes.forProject(projectId);
      return (await runtime.agents()).map((agent) => ({
        ...agent,
        ...(runtime.harnessId ? { harnessId: runtime.harnessId } : {}),
      }));
    },
    (agent) => `${agent.harnessId ?? "legacy"}/${agent.name}`,
  );
  const profiles = profileRoutes({
    store: host.store as unknown as ProfileStore,
    listModels,
    listAgents,
  });
  const custom = customProviderRoutes(host, listModels);
  return {
    remoteAccess: localOnlyRemoteAccess(["agent-profiles", "runtime-catalog"]),
    routes: async (request) => {
      if (await runtimeCatalogRoutes(host)(request)) return true;
      if (await custom(request)) return true;
      return profiles(request);
    },
  };
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentDescriptor,
  AgentProfile,
  AgentRuntime,
  HarnessRegistry,
  ModelDescriptor,
  ModelDiscoveryState,
  Project,
  RouteHandler,
} from "@polyth/contracts";
import {
  atomicWriteSync,
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { customProviderRoutes } from "./customProviderRoutes.ts";
import { validateProfile } from "./index.ts";

const OWNER_USER_ID = "usr_owner";

interface LegacyProfileStore {
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

interface ProfileStore {
  profileList(userId: string): Promise<AgentProfile[]>;
  profileGet(id: string, userId: string): Promise<AgentProfile | undefined>;
  profileCreate(
    input: Omit<AgentProfile, "id" | "revision" | "createdAt" | "updatedAt">,
    userId: string,
  ): Promise<AgentProfile>;
  profileUpdate(
    id: string,
    patch: Partial<Omit<AgentProfile, "id" | "revision" | "createdAt" | "updatedAt">>,
    expectedRevision: number,
    userId: string,
  ): Promise<AgentProfile>;
  profileRemove(id: string, userId: string): Promise<boolean>;
}

interface ProfileOwnersFile {
  version: 1;
  owners: Record<string, string>;
}

/**
 * Agent presets predate user accounts and live in the session store. Moving
 * that table would add a broad migration for a small ownership problem, so the
 * models package owns the missing relation explicitly: preset id -> user id.
 * Unmapped legacy rows belong to the only historical account, `usr_owner`.
 */
function createOwnedProfileStore(base: LegacyProfileStore, file: string): ProfileStore {
  const legacy = {
    list: base.profileList.bind(base),
    get: base.profileGet.bind(base),
    create: base.profileCreate.bind(base),
    update: base.profileUpdate.bind(base),
    remove: base.profileRemove.bind(base),
  };
  let owners: Record<string, string> = {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ProfileOwnersFile>;
    if (raw.version === 1 && raw.owners && typeof raw.owners === "object" && !Array.isArray(raw.owners)) {
      owners = Object.fromEntries(
        Object.entries(raw.owners).filter((entry): entry is [string, string] =>
          Boolean(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1])),
      );
    }
  } catch {
    // First boot: all pre-existing presets are bootstrap-owner presets.
  }

  const ownerOf = (id: string): string => owners[id] ?? OWNER_USER_ID;
  const persist = (): void => {
    atomicWriteSync(file, `${JSON.stringify({ version: 1, owners }, null, 2)}\n`, 0o600);
  };

  return {
    async profileList(userId) {
      return (await legacy.list()).filter((profile) => ownerOf(profile.id) === userId);
    },

    async profileGet(id, userId) {
      if (ownerOf(id) !== userId) return undefined;
      return legacy.get(id);
    },

    async profileCreate(input, userId) {
      const created = await legacy.create(input);
      owners = { ...owners, [created.id]: userId };
      try {
        persist();
      } catch (error) {
        const next = { ...owners };
        delete next[created.id];
        owners = next;
        await legacy.remove(created.id).catch(() => false);
        throw error;
      }
      return created;
    },

    async profileUpdate(id, patch, expectedRevision, userId) {
      if (ownerOf(id) !== userId) {
        throw Object.assign(new Error("agent preset not found"), { code: "not-found" });
      }
      return legacy.update(id, patch, expectedRevision);
    },

    async profileRemove(id, userId) {
      if (ownerOf(id) !== userId) return false;
      const removed = await legacy.remove(id);
      if (!removed) return false;
      if (Object.prototype.hasOwnProperty.call(owners, id)) {
        const next = { ...owners };
        delete next[id];
        owners = next;
        persist();
      }
      return true;
    },
  };
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

  return async (request) => {
    const { path, method, body, json } = request;
    if (!path.startsWith("/api/agent-profiles")) return false;
    const userId = request.space.userId;
    if (path === "/api/agent-profiles" && method === "GET") {
      json(200, await deps.store.profileList(userId));
      return true;
    }
    if (path === "/api/agent-profiles" && method === "POST") {
      const input = await body();
      json(200, await deps.store.profileCreate({
        name: String(input.name ?? ""),
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
      }, userId));
      return true;
    }
    let match = path.match(/^\/api\/agent-profiles\/([^/]+)\/validate$/);
    if (match && method === "POST") {
      const profile = await deps.store.profileGet(match[1]!, userId);
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
      const profile = await deps.store.profileGet(match[1]!, userId);
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
        userId,
      ));
      return true;
    }
    if (match && method === "DELETE") {
      const removed = await deps.store.profileRemove(match[1]!, userId);
      json(removed ? 200 : 404, removed ? { ok: true } : { error: "not-found" });
      return true;
    }
    return false;
  };
}

const selectionKey = (project: Project): string => {
  const selection = project.defaults?.harness;
  return selection?.mode === "pinned" ? `pinned:${selection.harnessId}` : "auto";
};

/**
 * Package-local agent metadata fallback is bounded by harness diversity, not
 * project count. Canonical model metadata uses the shared runtime.catalog
 * service so custom-provider/preset validation never duplicates discovery.
 */
const aggregate = async <T>(
  host: ServerPackageHost,
  fetch: (projectId: string) => Promise<T[]>,
  key: (item: T) => string,
): Promise<T[]> => {
  const projects = await host.projects.list();
  const bySelection = new Map<string, Project>();
  for (const project of projects) {
    const selection = selectionKey(project);
    const current = bySelection.get(selection);
    if (!current || (current.remote && !project.remote)) bySelection.set(selection, project);
  }
  const representatives = [...bySelection.values()].map((project) => project.id);
  if (representatives.length === 0) representatives.push("__default__");

  const settled = await Promise.allSettled(representatives.map(fetch));
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
  const visibleModels = (models: ModelDescriptor[], harnessId: string): ModelDescriptor[] =>
    host.services.get(serverServiceKey<{
      filterHarness(models: ModelDescriptor[], harnessId: string, opts?: { includeDisconnected?: boolean }): ModelDescriptor[];
    }>("models.visibility"))?.filterHarness(models, harnessId) ?? models;

  return async (request) => {
    const sessionId = request.url.searchParams.get("sessionId");
    if (request.path !== "/api/runtime-catalog" || !sessionId || request.method !== "GET") return false;
    const scoped = host.forSpace(request.space);
    const session = await scoped.sessions.snapshot(sessionId);
    const project = await scoped.projects.get(session.projectId);
    if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
    if (session.harnessTransition) throw Object.assign(new Error("Harness switch in progress"), { code: "conflict" });
    const cwd = session.worktreePath ?? project.path;
    let runtime: AgentRuntime;
    try {
      runtime = host.runtimes.forSession
        ? await host.runtimes.forSession(session, cwd)
        : await host.runtimes.forProject(project.id, cwd);
    } catch (runtimeError) {
      // Model metadata is read-only presentation state. A prior executor whose
      // release is still unverified must keep turn admission fenced, but it
      // must not also erase a catalog that the provider can discover through
      // its process-independent/throwaway metadata path. This is especially
      // important after a server restart: materializing the persisted ACP leg
      // can correctly fail closed while transient discovery can still
      // enumerate the models needed to choose the next action.
      const harnessId = session.resolvedHarnessId
        ?? (session.harness?.mode === "pinned" ? session.harness.harnessId : undefined);
      const registry = host.services.get(serverServiceKey<HarnessRegistry>("harnesses"));
      if (!harnessId || !registry) throw runtimeError;
      const [snapshot] = await registry.snapshots({
        space: request.space,
        spaceId: request.space.spaceId,
        projectId: project.id,
        cwd,
        model: session.model,
        remote: Boolean(project.remote),
      }, { harnessId, detail: true });
      if (!snapshot) throw runtimeError;
      const rawModels = (snapshot.catalog?.models ?? []).map((model) => ({
        ...model,
        harnessId: model.harnessId ?? harnessId,
      }));
      const models = visibleModels(rawModels, harnessId);
      const agents = (snapshot.catalog?.agents ?? snapshot.catalog?.roles ?? []).map((agent) => ({
        ...agent,
        harnessId: agent.harnessId ?? harnessId,
      }));
      const unavailable = snapshot.availability.state !== "ready"
        && snapshot.availability.state !== "unknown";
      const reason = snapshot.message?.trim()
        || (runtimeError as { message?: string })?.message?.trim()
        || "runtime model discovery failed";
      const discovery: ModelDiscoveryState = models.length > 0
        ? { state: "available" }
        : unavailable
          ? { state: "unavailable", reason }
          : { state: "empty" };
      request.json(200, {
        models,
        agents,
        capabilities: snapshot.capabilities
          ?? registry.get(harnessId)?.staticFeatures,
        discovery,
        nativeDefault: !unavailable && rawModels.length === 0,
        harnessId,
      });
      return true;
    }
    const [modelResult, rawAgents, capabilities] = await Promise.all([
      runtime.models().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, reason: (error as { message?: string })?.message?.trim() || "model discovery failed" }),
      ),
      runtime.agents().catch(() => []),
      runtime.capabilities(),
    ]);
    const rawModels = (modelResult.ok ? modelResult.value : []).map((model) => ({ ...model, ...(runtime.harnessId ? { harnessId: runtime.harnessId } : {}) }));
    const models = runtime.harnessId ? visibleModels(rawModels, runtime.harnessId) : rawModels;
    const agents = rawAgents.map((agent) => ({ ...agent, ...(runtime.harnessId ? { harnessId: runtime.harnessId } : {}) }));
    const discovery: ModelDiscoveryState = !modelResult.ok
      ? { state: "unavailable", reason: modelResult.reason }
      : models.length > 0 ? { state: "available" } : { state: "empty" };
    request.json(200, {
      models,
      agents,
      capabilities,
      discovery,
      nativeDefault: modelResult.ok && rawModels.length === 0,
      harnessId: runtime.harnessId,
    }); return true;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const sharedCatalog = host.services.get(serverServiceKey<{
    models(): Promise<ModelDescriptor[]>;
  }>("runtime.catalog"));
  const fallbackModels = () => aggregate(
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
  const listModels = () => sharedCatalog?.models() ?? fallbackModels();
  const listSelectableModels = async () => {
    const models = await listModels();
    return host.services.get(serverServiceKey<{
      filter(models: ModelDescriptor[], opts?: { includeDisconnected?: boolean }): ModelDescriptor[];
    }>("models.visibility"))?.filter(models, { includeDisconnected: true }) ?? models;
  };
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
  const legacyStore = host.store as unknown as LegacyProfileStore;
  const ownedProfiles = createOwnedProfileStore(
    legacyStore,
    join(host.storageDir, "agent-profile-owners.json"),
  );
  // The core session service is composed after packages load. Its historical
  // direct preset lookup has no authenticated user parameter, so disable that
  // unscoped path. Composer selection resolves presets into explicit execution
  // configuration before the scoped session facade strips the private id.
  legacyStore.profileGet = async () => undefined;
  const profiles = profileRoutes({ store: ownedProfiles, listModels: listSelectableModels, listAgents });
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

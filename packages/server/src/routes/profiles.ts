// Agent profile routes (WP8): server-owned reusable execution configurations.
// CRUD with optimistic revisions plus capability validation that returns
// visible repairs instead of silently rewriting records.
import type { AgentDescriptor, AgentProfile, ModelDescriptor } from "@polyth/contracts";
import { validateProfile } from "@polyth/models";
import type { Store } from "@polyth/session";
import type { RouteHandler } from "../http.ts";

export function profileRoutes(deps: {
  store: Store;
  listModels(): Promise<ModelDescriptor[]>;
  listAgents(): Promise<AgentDescriptor[]>;
}): RouteHandler {
  const { store } = deps;

  // null clears an optional column; it maps to "" which the store persists as
  // NULL and the DTO omits.
  const opt = (v: unknown): string | undefined => (v === undefined ? undefined : v === null ? "" : String(v));
  const patchOf = (b: Record<string, unknown>): Partial<Omit<AgentProfile, "id" | "revision" | "createdAt" | "updatedAt">> => ({
    ...(typeof b.name === "string" ? { name: b.name } : {}),
    ...(typeof b.providerID === "string" ? { providerID: b.providerID } : {}),
    ...(typeof b.modelID === "string" ? { modelID: b.modelID } : {}),
    ...(opt(b.agent) !== undefined ? { agent: opt(b.agent)! } : {}),
    ...(opt(b.mode) !== undefined ? { mode: opt(b.mode)! } : {}),
    ...(opt(b.thinking) !== undefined ? { thinking: opt(b.thinking)! } : {}),
    ...(b.features && typeof b.features === "object" ? { features: b.features as Record<string, boolean> } : {}),
    ...(opt(b.notes) !== undefined ? { notes: opt(b.notes)! } : {}),
    ...(opt(b.icon) !== undefined ? { icon: opt(b.icon)! } : {}),
    ...(opt(b.color) !== undefined ? { color: opt(b.color)! } : {}),
  });

  return async ({ path, method, body, json }) => {
    if (!path.startsWith("/api/agent-profiles")) return false;

    if (path === "/api/agent-profiles" && method === "GET") {
      json(200, await store.profileList());
      return true;
    }
    if (path === "/api/agent-profiles" && method === "POST") {
      const b = await body();
      json(200, await store.profileCreate({
        name: String(b.name ?? ""),
        providerID: String(b.providerID ?? ""),
        modelID: String(b.modelID ?? ""),
        features: b.features && typeof b.features === "object" ? (b.features as Record<string, boolean>) : {},
        ...(b.agent ? { agent: String(b.agent) } : {}),
        ...(b.mode ? { mode: String(b.mode) } : {}),
        ...(b.thinking ? { thinking: String(b.thinking) } : {}),
        ...(b.notes ? { notes: String(b.notes) } : {}),
        ...(b.icon ? { icon: String(b.icon) } : {}),
        ...(b.color ? { color: String(b.color) } : {}),
      }));
      return true;
    }

    let m = path.match(/^\/api\/agent-profiles\/([^/]+)\/validate$/);
    if (m && method === "POST") {
      const profile = await store.profileGet(m[1]!);
      if (!profile) { json(404, { error: "not-found" }); return true; }
      const [models, agents] = await Promise.all([
        deps.listModels().catch((): ModelDescriptor[] => []),
        deps.listAgents().catch((): AgentDescriptor[] => []),
      ]);
      json(200, validateProfile(profile, models, agents));
      return true;
    }

    m = path.match(/^\/api\/agent-profiles\/([^/]+)$/);
    if (m && method === "GET") {
      const profile = await store.profileGet(m[1]!);
      if (!profile) { json(404, { error: "not-found" }); return true; }
      json(200, profile);
      return true;
    }
    if (m && method === "PATCH") {
      const b = await body();
      json(200, await store.profileUpdate(m[1]!, patchOf(b), Number(b.expectedRevision ?? 0)));
      return true;
    }
    if (m && method === "DELETE") {
      const removed = await store.profileRemove(m[1]!);
      json(removed ? 200 : 404, removed ? { ok: true } : { error: "not-found" });
      return true;
    }

    return false;
  };
}

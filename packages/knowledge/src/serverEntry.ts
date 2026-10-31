import type {
  JsonObject,
  RouteHandler,
  SessionEvent,
  TrackCreateInput,
  TrackDto,
  TrackStepInput,
} from "@polyth/contracts";
import {
  adoptLegacyPackageData,
  localOnlyRemoteAccess,
  packageDataDir,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { join } from "node:path";
import { createSpaceKnowledgeRouter, type SpaceKnowledgeRouter } from "./spaceKnowledge.ts";
import {
  createTrackStore,
  knowledgeDigest,
  type KnowledgeKind,
  type KnowledgePatch,
  type KnowledgeStore,
  type TrackStore,
} from "./index.ts";
import { createLazyTrackWorkflow, type TrackWorkflow } from "./trackWorkflow.ts";

const KNOWLEDGE_KINDS: KnowledgeKind[] = ["note", "spec", "plan", "memory"];

export function knowledgeRoutes(deps: {
  knowledge: KnowledgeStore;
  router: SpaceKnowledgeRouter;
  events: {
    append(sessionId: string, type: string, data: JsonObject): Promise<SessionEvent>;
  };
}): RouteHandler {
  return async ({ path, method, url, body, json, space }) => {
    if (path === "/api/knowledge" && method === "GET") {
      const kind = url.searchParams.get("kind");
      const projectId = url.searchParams.get("projectId") ?? "";
      const scoped = await deps.router.prepareProject(space, projectId);
      json(200, await scoped.list({
        projectId,
        ...(kind && KNOWLEDGE_KINDS.includes(kind as KnowledgeKind)
          ? { kind: kind as KnowledgeKind }
          : {}),
        ...(url.searchParams.get("q") ? { q: url.searchParams.get("q")! } : {}),
        ...(url.searchParams.get("limit")
          ? { limit: Number(url.searchParams.get("limit")) }
          : {}),
        ...(url.searchParams.get("offset")
          ? { offset: Number(url.searchParams.get("offset")) }
          : {}),
      }));
      return true;
    }
    if (path === "/api/knowledge" && method === "POST") {
      const input = await body();
      const projectId = String(input.projectId ?? "");
      const scoped = await deps.router.prepareProject(space, projectId);
      json(200, await scoped.create({
        projectId,
        kind: (KNOWLEDGE_KINDS.includes(input.kind as KnowledgeKind)
          ? input.kind
          : "note") as KnowledgeKind,
        title: String(input.title ?? ""),
        body: String(input.body ?? ""),
        ...(Array.isArray(input.tags) ? { tags: input.tags.map(String) } : {}),
        ...(input.sourceSessionId
          ? { sourceSessionId: String(input.sourceSessionId) }
          : {}),
      }));
      return true;
    }
    let match = path.match(/^\/api\/knowledge\/([^/]+)$/);
    if (match && method === "GET") {
      const item = await deps.router.run(space, () => deps.knowledge.get(match[1]!));
      if (!item) json(404, { error: "not-found" });
      else json(200, item);
      return true;
    }
    if (match && method === "PATCH") {
      const input = await body();
      const patch: KnowledgePatch = {
        ...(input.title !== undefined ? { title: String(input.title) } : {}),
        ...(input.body !== undefined ? { body: String(input.body) } : {}),
        ...(Array.isArray(input.tags) ? { tags: input.tags.map(String) } : {}),
        ...(input.kind !== undefined
          && KNOWLEDGE_KINDS.includes(input.kind as KnowledgeKind)
          ? { kind: input.kind as KnowledgeKind }
          : {}),
      };
      json(200, await deps.router.run(space, () => deps.knowledge.update(
          match[1]!, patch, Number(input.expectedRevision ?? 0))));
      return true;
    }
    if (match && method === "DELETE") {
      json(200, { ok: await deps.router.run(space, () => deps.knowledge.remove(match[1]!)) });
      return true;
    }
    match = path.match(/^\/api\/sessions\/([^/]+)\/knowledge$/);
    if (match && method === "POST") {
      const input = await body();
      const item = await deps.router.run(space, () => deps.knowledge.get(String(input.knowledgeId ?? "")));
      if (!item) {
        json(404, { error: "not-found", message: "knowledge item not found" });
        return true;
      }
      if (input.revision !== undefined && Number(input.revision) !== item.revision) {
        json(409, {
          error: "conflict",
          message: `item is at revision ${item.revision}, you attached ${Number(input.revision)}`,
        });
        return true;
      }
      const event = await deps.events.append(match[1]!, "knowledge/attached", {
        knowledgeId: item.id,
        revision: item.revision,
        title: item.title,
        body: item.body,
        digest: knowledgeDigest(item.body),
      });
      json(200, { ok: true, eventSeq: event.seq, revision: item.revision });
      return true;
    }
    return false;
  };
}

const stepOf = (raw: unknown): TrackStepInput => {
  const step = raw as Record<string, unknown>;
  return {
    title: String(step?.title ?? ""),
    ...(step?.prompt !== undefined ? { prompt: String(step.prompt) } : {}),
    testCommand: String(step?.testCommand ?? ""),
    ...(step?.commitMessage !== undefined
      ? { commitMessage: String(step.commitMessage) }
      : {}),
  };
};

export function trackRoutes(tracks: TrackWorkflow): RouteHandler {
  return async ({ path, method, url, body, json }) => {
    if (!path.startsWith("/api/tracks")) return false;
    if (path === "/api/tracks" && method === "GET") {
      json(200, tracks.list(url.searchParams.get("projectId") ?? undefined));
      return true;
    }
    if (path === "/api/tracks" && method === "POST") {
      const input = await body();
      json(200, await tracks.create({
        projectId: String(input.projectId ?? ""),
        title: String(input.title ?? ""),
        spec: String(input.spec ?? ""),
        steps: Array.isArray(input.steps) ? input.steps.map(stepOf) : [],
        ...(input.budgetTokens !== undefined
          ? { budgetTokens: Number(input.budgetTokens) }
          : {}),
        ...(input.maxContinuations !== undefined
          ? { maxContinuations: Number(input.maxContinuations) }
          : {}),
      }));
      return true;
    }
    const match = path.match(
      /^\/api\/tracks\/([^/]+)(?:\/(start|retry|complete-step))?$/,
    );
    if (!match) return false;
    const id = decodeURIComponent(match[1]!);
    const action = match[2];
    if (!action && method === "GET") {
      const track = tracks.get(id);
      if (!track) throw Object.assign(new Error("track not found"), { code: "not-found" });
      json(200, track);
      return true;
    }
    if (method !== "POST" || !action) return false;
    if (action === "complete-step") {
      json(200, await tracks.completeStep(id));
      return true;
    }
    const input = await body();
    if (action === "start") {
      json(200, await tracks.start(id, String(input.sessionId ?? "")));
      return true;
    }
    json(200, await tracks.retry(
      id,
      input.sessionId ? String(input.sessionId) : undefined,
    ));
    return true;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // The router is the sole owner of tenant knowledge/memory stores. Memory's
  // service resolves this seam lazily, so package discovery order does not
  // affect storage admission and disabling the Memory UI cannot select a
  // deployment-wide fallback database.
  const router = createSpaceKnowledgeRouter(host);
  const knowledge = router.routed;
  const dataDir = packageDataDir(host);
  adoptLegacyPackageData(host, ["tracks.json"]);
  const trackStore = createTrackStore({
    file: join(dataDir, "tracks.json"),
    knowledge,
  });
  // A lazily-resolving facade: creating it reads no cross-package service, so
  // registration order stays irrelevant. The server's goal-completion hook
  // reads this generic key to settle a finished track step; first use resolves
  // goals/schedule/git/terminal (or reports `unavailable`).
  const tracks = createLazyTrackWorkflow(host, trackStore);
  host.services.provide(serverServiceKey<KnowledgeStore>("knowledge"), knowledge);
  host.services.provide(serverServiceKey<TrackStore>("tracks.store"), trackStore);
  host.services.provide(serverServiceKey<TrackWorkflow>("tracks.workflow"), tracks);
  host.services.provide(serverServiceKey("knowledge.space"), {
    prepareProject: (space: Parameters<SpaceKnowledgeRouter["prepareProject"]>[0], projectId: string) =>
      router.prepareProject(space, projectId),
  });
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["knowledge"]),
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const knowledgeRoute = knowledgeRoutes({
        knowledge,
        router,
        events: {
          append: (sessionId, type, data) => host.events.append(
            sessionId,
            type,
            data,
            { producerPlugin: "knowledge" },
          ),
        },
      });
      const trackRoute = trackRoutes(tracks);
      routes ??= async (request) => {
        if (await knowledgeRoute(request)) return true;
        return trackRoute(request);
      };
    },
    onDisable() {
      routes = null;
      router.close();
    },
  };
}

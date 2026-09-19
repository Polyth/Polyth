import type {
  HandoffResultImportedData,
  JsonObject,
  RemoteAccessPolicy,
  RouteHandler,
} from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createBuiltinSources } from "./builtins.ts";
import { createBundleService, hashText } from "./bundles.ts";
import { createContextSourceRegistry, type ContextSourceRegistry } from "./index.ts";
import { HANDOFF_PRESETS, mergePresetSources, presetById } from "./presets.ts";

const STATUS: Record<string, number> = {
  "not-found": 404,
  "invalid-input": 400,
};

export function handoffRoutes(deps: {
  host: ServerPackageHost;
  registry: ContextSourceRegistry;
  bundles: ReturnType<typeof createBundleService>;
  warnTokenThreshold: number;
}): RouteHandler {
  const { host, registry, bundles } = deps;

  return async (request) => {
    const { path } = request;
    if (!path.startsWith("/api/handoff/")) return false;
    const { method, url, body, json, space } = request;
    try {
      const spaces = host.forSpace(space);
      const query = (key: string) => url.searchParams.get(key) ?? "";

      if (path === "/api/handoff/presets" && method === "GET") {
        json(200, { presets: HANDOFF_PRESETS });
        return true;
      }

      if (path === "/api/handoff/sources" && method === "GET") {
        const projectId = query("projectId");
        const sessionId = query("sessionId");
        if (!projectId || !sessionId) {
          json(400, { error: "invalid-input", message: "projectId and sessionId required" });
          return true;
        }
        const project = await spaces.projects.get(projectId);
        if (!project) {
          json(404, { error: "not-found", message: "project not found" });
          return true;
        }
        const session = await spaces.sessions.snapshot(sessionId).catch(() => null);
        if (!session) {
          json(404, { error: "not-found", message: "session not found" });
          return true;
        }
        const listed = await bundles.estimateSources(registry, {
          space,
          projectId,
          sessionId,
        }, []);
        json(200, { sources: listed });
        return true;
      }

      if (path === "/api/handoff/bundles" && method === "GET") {
        const projectId = query("projectId");
        if (!projectId) {
          json(400, { error: "invalid-input", message: "projectId required" });
          return true;
        }
        const project = await spaces.projects.get(projectId);
        if (!project) {
          json(404, { error: "not-found", message: "project not found" });
          return true;
        }
        const list = await bundles.listBundles(host.spaceStorage(space), projectId, space.spaceId);
        json(200, { bundles: list });
        return true;
      }

      if (path === "/api/handoff/bundles" && method === "POST") {
        const input = await body();
        const projectId = String(input.projectId ?? "");
        const sessionId = String(input.sessionId ?? "");
        const presetId = String(input.presetId ?? "custom");
        const instruction = String(input.instruction ?? presetById(presetId)?.instruction ?? "");
        const label = String(input.label ?? presetById(presetId)?.label ?? "Context");
        const sources = mergePresetSources(
          presetId,
          Array.isArray(input.sources) ? input.sources as Array<{ id: string; params?: JsonObject }> : [],
        );
        const project = await spaces.projects.get(projectId);
        if (!project) {
          json(404, { error: "not-found", message: "project not found" });
          return true;
        }
        const session = await spaces.sessions.snapshot(sessionId).catch(() => null);
        if (!session) {
          json(404, { error: "not-found", message: "session not found" });
          return true;
        }
        const bundle = await bundles.createBundle({
          storage: host.spaceStorage(space),
          collectCtx: { space, projectId, sessionId },
          projectId,
          sessionId,
          presetId,
          label,
          instruction,
          sources,
          ...(input.warnTokenThreshold !== undefined && input.warnTokenThreshold !== null
            ? { warnTokenThreshold: Number(input.warnTokenThreshold) }
            : {}),
        });
        json(200, bundle);
        return true;
      }

      let match = path.match(/^\/api\/handoff\/bundles\/([^/]+)$/);
      if (match && method === "GET") {
        const projectId = query("projectId");
        if (!projectId) {
          json(400, { error: "invalid-input", message: "projectId required" });
          return true;
        }
        const project = await spaces.projects.get(projectId);
        if (!project) {
          json(404, { error: "not-found", message: "project not found" });
          return true;
        }
        const bundle = await bundles.getBundle(host.spaceStorage(space), projectId, match[1]!, space.spaceId);
        json(bundle ? 200 : 404, bundle ?? { error: "not-found" });
        return true;
      }

      match = path.match(/^\/api\/handoff\/bundles\/([^/]+)\/check$/);
      if (match && method === "GET") {
        const projectId = query("projectId");
        const sessionId = query("sessionId");
        if (!projectId || !sessionId) {
          json(400, { error: "invalid-input", message: "projectId and sessionId required" });
          return true;
        }
        const project = await spaces.projects.get(projectId);
        if (!project) {
          json(404, { error: "not-found", message: "project not found" });
          return true;
        }
        const session = await spaces.sessions.snapshot(sessionId).catch(() => null);
        if (!session) {
          json(404, { error: "not-found", message: "session not found" });
          return true;
        }
        const result = await bundles.checkStale(
          host.spaceStorage(space),
          { space, projectId, sessionId },
          projectId,
          match[1]!,
        );
        json(200, result);
        return true;
      }

      if (path === "/api/handoff/imports" && method === "POST") {
        const input = await body();
        const sessionId = String(input.sessionId ?? "");
        const provenance = input.provenance as HandoffResultImportedData["provenance"] | undefined;
        const textHash = String(input.textHash ?? "");
        if (!sessionId || !provenance || !textHash) {
          json(400, { error: "invalid-input", message: "sessionId, provenance, and textHash required" });
          return true;
        }
        const session = await spaces.sessions.snapshot(sessionId).catch(() => null);
        if (!session) {
          json(404, { error: "not-found", message: "session not found" });
          return true;
        }
        await host.events.append(sessionId, "handoff/result-imported", {
          provenance,
          textHash,
        }, { ignorable: true, producerPlugin: "handoff" });
        json(200, { ok: true });
        return true;
      }

      return false;
    } catch (error) {
      const failure = error as Error & { code?: string };
      json(STATUS[failure.code ?? ""] ?? 500, {
        error: failure.code ?? "internal",
        message: failure.message,
      });
      return true;
    }
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const registry = createContextSourceRegistry();
  host.services.provide(serverServiceKey<ContextSourceRegistry>("handoff.sources"), registry);
  const warnTokenThreshold = 80_000;
  const bundles = createBundleService({ registry, warnTokenThreshold });
  for (const provider of createBuiltinSources({ sessionsFor: (space) => host.forSpace(space).sessions })) {
    registry.register(provider);
  }
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["handoff"]) satisfies RemoteAccessPolicy,
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      routes ??= handoffRoutes({ host, registry, bundles, warnTokenThreshold });
    },
  };
}

export { hashText };

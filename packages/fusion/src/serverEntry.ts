import type { ModelRef, RouteHandler } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  publishBackgroundWork,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createFusionService, synthesisPrompt, type FusionService } from "./index.ts";

const parseModel = (raw?: string): ModelRef | undefined => {
  if (!raw || !raw.includes("/")) return undefined;
  const i = raw.indexOf("/");
  return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) };
};

export function fusionRoutes(fusion: FusionService): RouteHandler {
  return async ({ path, method, body, json }) => {
    let match = path.match(/^\/api\/sessions\/([^/]+)\/fuse$/);
    if (match && method === "POST") {
      const input = await body();
      const models = Array.isArray(input.models) ? input.models.map(String) : [];
      const { id } = await fusion.start(match[1]!, {
        text: String(input.text ?? ""),
        models,
      });
      json(200, { fusionId: id });
      return true;
    }
    match = path.match(/^\/api\/fusions\/([^/]+)$/);
    if (match && method === "GET") {
      const state = fusion.get(match[1]!);
      if (!state) {
        json(404, { error: "not-found" });
        return true;
      }
      json(200, fusion.snapshot(state));
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // M3: fusion resolves the parent session's project/runtime lazily, the same
  // way multirun does, so it works for any session.
  const fusion = createFusionService({
    append: async (sessionId, type, data) => {
      const event = await host.events.append(sessionId, type, data, { ignorable: true });
      const id = typeof data.fusionId === "string" ? data.fusionId : "";
      if (id && type === "fusion/started") {
        await publishBackgroundWork(host, sessionId, "fusion", { phase: "started", id });
      } else if (id && type === "fusion/completed") {
        await publishBackgroundWork(host, sessionId, "fusion", {
          phase: "completed",
          id,
          status: data.status === "failed" ? "failed" : "completed",
        });
      }
      return event;
    },
    runModel: async ({ sessionId, model, prompt }) => {
      const { rt, cwd } = await host.resolveSessionRuntime(sessionId);
      return host.oneShot(rt, {
        cwd,
        prompt,
        ...(parseModel(model) ? { model: parseModel(model)! } : {}),
      });
    },
    synthesize: async ({ sessionId, prompt, answers }) => {
      const { rt, cwd, model } = await host.resolveSessionRuntime(sessionId);
      return host.oneShot(rt, {
        cwd,
        prompt: synthesisPrompt(prompt, answers),
        ...(host.smallModel() ? { model: host.smallModel()! } : model ? { model } : {}),
      });
    },
  });
  host.services.provide(serverServiceKey<FusionService>("fusion"), fusion);
  return {
    remoteAccess: localOnlyRemoteAccess(["fusion"]),
    routes: fusionRoutes(fusion),
  };
}

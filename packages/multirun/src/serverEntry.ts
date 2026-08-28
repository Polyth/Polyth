import type { ModelRef, RouteHandler } from "@polyth/contracts";
import {
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createMultirunService, type MultirunRunSpec, type MultirunService } from "./index.ts";
import { createMultirunRunOne } from "./runner.ts";

const asModel = (value: unknown): ModelRef | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const model = value as { providerID?: unknown; modelID?: unknown };
  return typeof model.providerID === "string" && typeof model.modelID === "string"
    ? { providerID: model.providerID, modelID: model.modelID }
    : undefined;
};

export function multirunRoutes(multirun: MultirunService): RouteHandler {
  return async ({ path, method, body, json }) => {
    let match = path.match(/^\/api\/sessions\/([^/]+)\/multirun$/);
    if (match && method === "POST") {
      const input = await body();
      const runs: MultirunRunSpec[] = Array.isArray(input.runs)
        ? input.runs.map((candidate) => {
            const raw = (candidate ?? {}) as Record<string, unknown>;
            const model = asModel(raw.model);
            const agent = typeof raw.agent === "string" ? raw.agent : undefined;
            return { ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
          })
        : [];
      const { id } = await multirun.start(match[1]!, {
        text: String(input.text ?? ""),
        runs,
      });
      json(200, { multirunId: id });
      return true;
    }
    match = path.match(/^\/api\/multiruns\/([^/]+)\/pick$/);
    if (match && method === "POST") {
      const input = await body();
      await multirun.pick(match[1]!, String(input.runId ?? ""));
      json(200, { ok: true });
      return true;
    }
    match = path.match(/^\/api\/multiruns\/([^/]+)$/);
    if (match && method === "GET") {
      const state = multirun.get(match[1]!);
      if (!state) {
        json(404, { error: "not-found" });
        return true;
      }
      json(200, multirun.snapshot(state));
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // M3: runs resolve the parent session's project/runtime lazily, so they
  // work for any session without composition-root wiring.
  const multirun = createMultirunService({
    append: (sessionId, type, data) =>
      host.events.append(sessionId, type, data, { ignorable: true }),
    runOne: createMultirunRunOne(
      (sessionId) => host.resolveSessionRuntime(sessionId),
      { store: host.store },
    ),
  });
  host.services.provide(serverServiceKey<MultirunService>("multirun"), multirun);
  return { routes: multirunRoutes(multirun) };
}

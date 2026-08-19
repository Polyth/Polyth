// HTTP face of the multirun plugin (PLAN §12/M3, wire protocol fixed).
import type { ModelRef } from "@polyth/contracts";
import type { MultirunRunSpec, MultirunService } from "@polyth/multirun";
import type { RouteHandler } from "../http.ts";

const asModel = (v: unknown): ModelRef | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const r = v as { providerID?: unknown; modelID?: unknown };
  return typeof r.providerID === "string" && typeof r.modelID === "string"
    ? { providerID: r.providerID, modelID: r.modelID }
    : undefined;
};

export function multirunRoutes(multirun: MultirunService): RouteHandler {
  return async ({ path, method, body, json }) => {
    let m = path.match(/^\/api\/sessions\/([^/]+)\/multirun$/);
    if (m && method === "POST") {
      const b = await body();
      const runs: MultirunRunSpec[] = Array.isArray(b.runs)
        ? b.runs.map((r) => {
            const spec = (r ?? {}) as Record<string, unknown>;
            const model = asModel(spec.model);
            const agent = typeof spec.agent === "string" ? spec.agent : undefined;
            return { ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
          })
        : [];
      const { id } = await multirun.start(m[1]!, { text: String(b.text ?? ""), runs });
      json(200, { multirunId: id });
      return true;
    }

    m = path.match(/^\/api\/multiruns\/([^/]+)\/pick$/);
    if (m && method === "POST") {
      const b = await body();
      await multirun.pick(m[1]!, String(b.runId ?? ""));
      json(200, { ok: true });
      return true;
    }

    m = path.match(/^\/api\/multiruns\/([^/]+)$/);
    if (m && method === "GET") {
      const state = multirun.get(m[1]!);
      if (!state) { json(404, { error: "not-found" }); return true; }
      json(200, multirun.snapshot(state));
      return true;
    }

    return false;
  };
}

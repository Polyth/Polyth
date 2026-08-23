import type { TrackCreateInput, TrackStepInput } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import type { TrackWorkflow } from "../tracks.ts";

const stepOf = (raw: unknown): TrackStepInput => {
  const step = raw as Record<string, unknown>;
  return {
    title: String(step?.title ?? ""),
    ...(step?.prompt !== undefined ? { prompt: String(step.prompt) } : {}),
    testCommand: String(step?.testCommand ?? ""),
    ...(step?.commitMessage !== undefined ? { commitMessage: String(step.commitMessage) } : {}),
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
      const b = await body();
      const input: TrackCreateInput = {
        projectId: String(b.projectId ?? ""),
        title: String(b.title ?? ""),
        spec: String(b.spec ?? ""),
        steps: Array.isArray(b.steps) ? b.steps.map(stepOf) : [],
        ...(b.budgetTokens !== undefined ? { budgetTokens: Number(b.budgetTokens) } : {}),
        ...(b.maxContinuations !== undefined ? { maxContinuations: Number(b.maxContinuations) } : {}),
      };
      json(200, await tracks.create(input));
      return true;
    }

    const match = path.match(/^\/api\/tracks\/([^/]+)(?:\/(start|retry|complete-step))?$/);
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
    const b = await body();
    if (action === "start") {
      json(200, await tracks.start(id, String(b.sessionId ?? "")));
      return true;
    }
    json(200, await tracks.retry(id, b.sessionId ? String(b.sessionId) : undefined));
    return true;
  };
}

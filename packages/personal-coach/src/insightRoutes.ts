import type { RouteHandler } from "@polyth/contracts";
import type { CoachInsight, CoachInsightStatus } from "./index.ts";
import type { CoachStoreResolver } from "./routes.ts";

const statuses: readonly CoachInsightStatus[] = ["candidate", "accepted", "rejected", "expired"];
const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

function getInsight(store: ReturnType<CoachStoreResolver["forSpace"]>, id: string): CoachInsight {
  const insight = store.listInsights().find((item) => item.id === id);
  if (!insight) throw fail("not-found", "insight not found");
  return insight;
}

export function personalCoachInsightRoutes(service: CoachStoreResolver): RouteHandler {
  return async (request) => {
    if (!request.path.startsWith("/api/personal-coach/insights")) return false;
    const store = service.forSpace(request.space);
    const { path, method, url, json } = request;

    if (path === "/api/personal-coach/insights" && method === "GET") {
      const raw = url.searchParams.get("status");
      if (raw && !statuses.includes(raw as CoachInsightStatus)) {
        throw fail("invalid-input", `status must be one of: ${statuses.join(", ")}`);
      }
      json(200, { insights: store.listInsights(raw ? raw as CoachInsightStatus : undefined).slice(0, 100) });
      return true;
    }

    const match = path.match(/^\/api\/personal-coach\/insights\/([^/]+)(?:\/(accept|reject|forget))?$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]!);
    const action = match[2];
    if (!action && method === "GET") {
      json(200, getInsight(store, id));
      return true;
    }
    if (method !== "POST") return false;

    const current = getInsight(store, id);
    const target: CoachInsightStatus = action === "accept"
      ? "accepted"
      : action === "reject" ? "rejected" : "expired";
    if (current.status === target) {
      json(200, current);
      return true;
    }
    if (action !== "forget" && current.status !== "candidate") {
      throw fail("conflict", `insight is already ${current.status}`);
    }
    json(200, store.setInsightStatus(id, target));
    return true;
  };
}

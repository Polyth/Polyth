import type { RouteHandler } from "@polyth/contracts";
import type { CoachProposal, CoachProposalStatus } from "./index.ts";
import type { CoachStoreResolver } from "./routes.ts";

const allowedStatuses: readonly CoachProposalStatus[] = ["pending", "accepted", "rejected", "expired"];

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

function proposal(store: ReturnType<CoachStoreResolver["forSpace"]>, id: string): CoachProposal {
  const row = store.listProposals().find((item) => item.id === id);
  if (!row) throw fail("not-found", "proposal not found");
  return row;
}

function transition(
  store: ReturnType<CoachStoreResolver["forSpace"]>,
  id: string,
  target: Extract<CoachProposalStatus, "accepted" | "rejected">,
): CoachProposal {
  const current = proposal(store, id);
  if (current.status === target) return current;
  if (current.status !== "pending") {
    throw fail("conflict", `proposal is already ${current.status}`);
  }
  return store.setProposalStatus(id, target);
}

/**
 * Review seam for durable model-created proposals. Acceptance records explicit
 * user approval; materialization into versioned plan entities is deliberately
 * separate until those domain contracts exist, so this route never pretends a
 * plan change was applied when only approval was captured.
 */
export function personalCoachProposalRoutes(service: CoachStoreResolver): RouteHandler {
  return async (request) => {
    if (!request.path.startsWith("/api/personal-coach/proposals")) return false;
    const store = service.forSpace(request.space);
    const { path, method, url, json } = request;

    if (path === "/api/personal-coach/proposals" && method === "GET") {
      const rawStatus = url.searchParams.get("status");
      if (rawStatus && !allowedStatuses.includes(rawStatus as CoachProposalStatus)) {
        throw fail("invalid-input", `status must be one of: ${allowedStatuses.join(", ")}`);
      }
      json(200, {
        proposals: store.listProposals(rawStatus ? rawStatus as CoachProposalStatus : undefined).slice(0, 100),
      });
      return true;
    }

    const match = path.match(/^\/api\/personal-coach\/proposals\/([^/]+)(?:\/(accept|reject))?$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]!);
    const action = match[2];
    if (!action && method === "GET") {
      json(200, proposal(store, id));
      return true;
    }
    if (method !== "POST") return false;
    if (action === "accept") {
      json(200, transition(store, id, "accepted"));
      return true;
    }
    if (action === "reject") {
      json(200, transition(store, id, "rejected"));
      return true;
    }
    return false;
  };
}

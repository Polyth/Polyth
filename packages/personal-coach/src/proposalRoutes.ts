import type { RouteHandler, SpaceContext } from "@polyth/contracts";
import type { CoachProposalStatus } from "./index.ts";
import type { CoachProposalReviewStore } from "./proposals.ts";

export interface CoachProposalReviewResolver {
  proposalReviewForSpace(space: SpaceContext): CoachProposalReviewStore;
}

const allowedStatuses: readonly CoachProposalStatus[] = ["pending", "accepted", "rejected", "expired"];
const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export function personalCoachProposalRoutes(service: CoachProposalReviewResolver): RouteHandler {
  return async (request) => {
    if (!request.path.startsWith("/api/personal-coach/proposals")
      && !request.path.startsWith("/api/personal-coach/plans")) return false;
    const review = service.proposalReviewForSpace(request.space);
    const { path, method, url, json } = request;

    if (path === "/api/personal-coach/proposals" && method === "GET") {
      const rawStatus = url.searchParams.get("status");
      if (rawStatus && !allowedStatuses.includes(rawStatus as CoachProposalStatus)) {
        throw fail("invalid-input", `status must be one of: ${allowedStatuses.join(", ")}`);
      }
      json(200, {
        proposals: review.listProposals(rawStatus ? rawStatus as CoachProposalStatus : undefined, 100),
      });
      return true;
    }

    let match = path.match(/^\/api\/personal-coach\/proposals\/([^/]+)(?:\/(accept|reject))?$/);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const action = match[2];
      if (!action && method === "GET") {
        const proposal = review.getProposal(id);
        if (!proposal) throw fail("not-found", "proposal not found");
        json(200, proposal);
        return true;
      }
      if (method !== "POST") return false;
      if (action === "accept") {
        json(200, review.accept(id));
        return true;
      }
      if (action === "reject") {
        json(200, review.reject(id));
        return true;
      }
      return false;
    }

    if (path === "/api/personal-coach/plans" && method === "GET") {
      json(200, { plans: review.listPlans(100) });
      return true;
    }
    match = path.match(/^\/api\/personal-coach\/plans\/([^/]+)$/);
    if (match && method === "GET") {
      const plan = review.getPlan(decodeURIComponent(match[1]!));
      if (!plan) throw fail("not-found", "plan not found");
      json(200, plan);
      return true;
    }

    return false;
  };
}

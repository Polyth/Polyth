import type {
  AgentCapabilityContributionRegistry,
  Disposable,
  JsonObject,
  SpaceContext,
  ToolExecutionContext,
} from "@polyth/contracts";
import type { CoachProposal, CoachStore } from "./index.ts";
import type { CoachProposalReviewStore } from "./proposals.ts";

export interface CoachPlanCapabilitySet {
  ids: string[];
  dispose(): void | Promise<void>;
}

const schema = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const text = (description: string): JsonObject => ({ type: "string", description });

export function registerCoachPlanCapabilities(input: {
  registry: AgentCapabilityContributionRegistry;
  space: Pick<SpaceContext, "spaceId">;
  projectId: string;
  store: CoachStore;
  plans: CoachProposalReviewStore;
  onProposalCreated?: (proposal: CoachProposal, ctx: ToolExecutionContext) => void | Promise<void>;
}): CoachPlanCapabilitySet {
  const suffix = input.projectId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-16) || "workspace";
  const registrations: Disposable[] = [];
  const ids: string[] = [];
  const assertTarget = (ctx: ToolExecutionContext): void => {
    if (ctx.projectId !== input.projectId || (ctx.spaceId && ctx.spaceId !== input.space.spaceId)) {
      throw Object.assign(new Error("Coach plan target mismatch"), { code: "forbidden" });
    }
  };
  const register = (contribution: Parameters<AgentCapabilityContributionRegistry["register"]>[1]) => {
    ids.push(contribution.descriptor.id);
    registrations.push(input.registry.register("personal-coach", contribution));
  };

  register({
    descriptor: {
      id: `personal-coach.list-plans-${suffix}`,
      kind: "tool",
      owner: "personal-coach",
      scope: "project",
      spaceId: input.space.spaceId,
      projectId: input.projectId,
      revision: "1",
      name: "coach_list_plans",
      description: "Read current versioned Coach plans. Pass planId to include that plan's complete revision history; omit it for a bounded plan list.",
      trust: "pure",
      mutating: false,
      inputSchema: schema({ planId: text("Optional plan id to read with revision history") }),
    },
    execute: async (value, ctx) => {
      assertTarget(ctx);
      const planId = typeof value.planId === "string" && value.planId.trim() ? value.planId.trim() : undefined;
      if (planId) {
        const plan = input.plans.getPlan(planId);
        if (!plan) throw Object.assign(new Error("plan not found"), { code: "not-found" });
        return { output: JSON.stringify(plan) };
      }
      return { output: JSON.stringify({ plans: input.plans.listPlans(30) }) };
    },
  });

  register({
    descriptor: {
      id: `personal-coach.propose-plan-revision-${suffix}`,
      kind: "tool",
      owner: "personal-coach",
      scope: "project",
      spaceId: input.space.spaceId,
      projectId: input.projectId,
      revision: "1",
      name: "coach_propose_plan_revision",
      description: "Propose a new revision to an existing versioned Coach plan. The change is pending until the user applies the inline proposal card.",
      trust: "workspace",
      mutating: true,
      inputSchema: schema({
        planId: text("Existing plan id"),
        summary: text("Short human-readable description of the proposed revision"),
        changes: { type: "object", description: "Structured patch describing only what changes from the current plan" },
        reason: text("Evidence-based reason for revising the plan"),
      }, ["planId", "summary", "changes"]),
    },
    execute: async (value, ctx) => {
      assertTarget(ctx);
      const planId = typeof value.planId === "string" ? value.planId.trim() : "";
      if (!planId || !input.plans.getPlan(planId)) {
        throw Object.assign(new Error("plan not found"), { code: "not-found" });
      }
      const changes = value.changes;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        throw Object.assign(new Error("changes must be an object"), { code: "invalid-input" });
      }
      const summary = typeof value.summary === "string" ? value.summary.trim() : "";
      if (!summary) throw Object.assign(new Error("summary is required"), { code: "invalid-input" });
      const reason = typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : undefined;
      const proposal = input.store.createProposal({
        type: "plan-change",
        payload: {
          planId,
          summary,
          changes: changes as JsonObject,
        },
        ...(reason ? { reason } : {}),
        ...(ctx.sessionId ? { sourceSessionId: ctx.sessionId } : {}),
      });
      await input.onProposalCreated?.(proposal, ctx);
      return { output: JSON.stringify(proposal), metadata: { entityId: proposal.id } };
    },
  });

  return {
    ids,
    async dispose() {
      for (const registration of registrations.toReversed()) await registration.dispose();
    },
  };
}

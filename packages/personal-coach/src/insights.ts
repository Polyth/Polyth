import type {
  AgentCapabilityContributionRegistry,
  Disposable,
  JsonObject,
  SpaceContext,
  ToolExecutionContext,
} from "@polyth/contracts";
import type { CoachInsight, CoachStore } from "./index.ts";

export interface CoachInsightCapabilitySet {
  ids: string[];
  dispose(): void | Promise<void>;
}

const schema = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export function registerCoachInsightCapabilities(input: {
  registry: AgentCapabilityContributionRegistry;
  space: Pick<SpaceContext, "spaceId">;
  projectId: string;
  store: CoachStore;
  onInsightCreated?: (insight: CoachInsight, ctx: ToolExecutionContext) => void | Promise<void>;
}): CoachInsightCapabilitySet {
  const suffix = input.projectId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-16) || "workspace";
  const registrations: Disposable[] = [];
  const ids: string[] = [];
  const assertTarget = (ctx: ToolExecutionContext): void => {
    if (ctx.projectId !== input.projectId || (ctx.spaceId && ctx.spaceId !== input.space.spaceId)) {
      throw Object.assign(new Error("Coach insight target mismatch"), { code: "forbidden" });
    }
  };
  const register = (contribution: Parameters<AgentCapabilityContributionRegistry["register"]>[1]) => {
    ids.push(contribution.descriptor.id);
    registrations.push(input.registry.register("personal-coach", contribution));
  };

  register({
    descriptor: {
      id: `personal-coach.record-weekly-review-${suffix}`,
      kind: "tool",
      owner: "personal-coach",
      scope: "project",
      spaceId: input.space.spaceId,
      projectId: input.projectId,
      revision: "1",
      name: "coach_record_weekly_review",
      description: "Persist a concise weekly review after the review conversation is complete. Summarize only evidence and conclusions actually established with the user.",
      trust: "workspace",
      mutating: true,
      inputSchema: schema({
        summary: { type: "string", description: "Concise grounded review summary" },
      }, ["summary"]),
    },
    execute: async (value, ctx) => {
      assertTarget(ctx);
      const reflection = input.store.recordReflection({
        kind: "weekly",
        text: String(value.summary ?? ""),
        ...(ctx.sessionId ? { sourceSessionId: ctx.sessionId } : {}),
      });
      return { output: JSON.stringify(reflection), metadata: { entityId: reflection.id } };
    },
  });

  register({
    descriptor: {
      id: `personal-coach.propose-insight-${suffix}`,
      kind: "tool",
      owner: "personal-coach",
      scope: "project",
      spaceId: input.space.spaceId,
      projectId: input.projectId,
      revision: "1",
      name: "coach_propose_insight",
      description: "Create a candidate coaching insight as a hypothesis backed by recent Coach event sequence numbers. The user must be able to confirm, reject, or forget it.",
      trust: "workspace",
      mutating: true,
      inputSchema: schema({
        statement: { type: "string", description: "Tentative pattern or hypothesis, not a diagnosis or fact" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        evidence: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "number", description: "Recent Coach event sequence number" },
        },
      }, ["statement", "confidence", "evidence"]),
    },
    execute: async (value, ctx) => {
      assertTarget(ctx);
      if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.length > 8) {
        throw Object.assign(new Error("evidence must contain 1-8 recent Coach event sequence numbers"), { code: "invalid-input" });
      }
      const recent = new Set(input.store.listEvents({ limit: 100 }).map((event) => event.seq));
      const evidence = [...new Set(value.evidence.map((item) => Number(item)))];
      if (evidence.some((seq) => !Number.isInteger(seq) || seq < 1 || !recent.has(seq))) {
        throw Object.assign(new Error("insight evidence must reference recent durable Coach events"), { code: "invalid-input" });
      }
      const confidence = value.confidence;
      if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
        throw Object.assign(new Error("confidence must be low, medium, or high"), { code: "invalid-input" });
      }
      const insight = input.store.createInsight({
        statement: String(value.statement ?? ""),
        confidence,
        evidence: evidence.map((eventSeq) => ({ eventSeq })),
      });
      await input.onInsightCreated?.(insight, ctx);
      return { output: JSON.stringify(insight), metadata: { entityId: insight.id } };
    },
  });

  return {
    ids,
    async dispose() {
      for (const registration of registrations.toReversed()) await registration.dispose();
    },
  };
}

// Structured review generation + bounded auto-review loop (WP11).
//
// generateReview: capture diff → model → strict parse → append review/generated
// and review/risk-scored to the session log BEFORE the caller sees the result.
//
// Review flow: opt-in per session, event-derived state, hard iteration bound.
// The flow has no GitHub/git dependency at all — it is structurally unable to
// merge, push, or publish; those stay separate explicit user actions.
import { randomUUID } from "node:crypto";
import type { JsonObject, ReviewAssessment, ReviewFlowState, SessionEvent, WalkthroughSource } from "@polyth/contracts";
import { buildReviewPrompt, parseReviewAssessment, sourceDigestOf } from "@polyth/walkthrough";

export interface ReviewDeps {
  captureDiff: (source: WalkthroughSource) => Promise<string>;
  generate: ((source: WalkthroughSource, prompt: string) => Promise<string>) | null;
  append: (sessionId: string, type: string, data: JsonObject) => Promise<SessionEvent>;
}

export type ReviewResult =
  | { ok: true; reviewId: string; sourceDigest: string; assessment: ReviewAssessment }
  | { ok: false; reason: string };

export function createReviewService(deps: ReviewDeps) {
  return {
    async generate(sessionId: string, source: WalkthroughSource): Promise<ReviewResult> {
      if (!deps.generate) return { ok: false, reason: "model generation unavailable — no agent runtime" };
      const diff = await deps.captureDiff(source);
      if (!diff.trim()) return { ok: false, reason: "no changes in the selected source" };
      const digest = sourceDigestOf(diff);
      let raw: string;
      try {
        raw = await deps.generate(source, buildReviewPrompt(diff));
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
      const parsed = parseReviewAssessment(raw);
      if (!parsed.ok) return { ok: false, reason: parsed.error };
      const reviewId = randomUUID();
      // durable log first — the complete review is model- and user-visible only
      // after these appends succeed
      await deps.append(sessionId, "review/generated", {
        reviewId, sourceDigest: digest,
        summary: parsed.assessment.summary,
        findings: parsed.assessment.findings as unknown as JsonObject[],
      });
      await deps.append(sessionId, "review/risk-scored", {
        reviewId,
        riskScore: parsed.assessment.riskScore,
        confidenceScore: parsed.assessment.confidenceScore,
      });
      return { ok: true, reviewId, sourceDigest: digest, assessment: parsed.assessment };
    },
  };
}

// ---------------------------------------------------------------- review flow

export interface ReviewFlowDeps {
  sessionStatus: (sessionId: string) => Promise<string | null>;
  sessionProject: (sessionId: string) => Promise<string | null>;
  send: (sessionId: string, text: string) => Promise<void>;
  review: (sessionId: string, source: WalkthroughSource) => Promise<ReviewResult>;
  append: (sessionId: string, type: string, data: JsonObject) => Promise<SessionEvent>;
  /** risk at or below this with no critical/high findings passes */
  passRiskThreshold?: number;
}

export interface ReviewFlowService {
  create(sessionId: string, opts?: { maxIterations?: number }): Promise<ReviewFlowState>;
  get(sessionId: string): ReviewFlowState | null;
  pause(sessionId: string): Promise<ReviewFlowState | null>;
  resume(sessionId: string): Promise<ReviewFlowState | null>;
  stop(sessionId: string, reason?: string): Promise<ReviewFlowState | null>;
  /** advance every active flow one step; interval-driven in the server, called
   *  directly in tests */
  tick(): Promise<void>;
}

const ACTIVE = new Set(["implementing", "awaiting-review", "reviewing", "changes-requested"]);

export function createReviewFlowService(deps: ReviewFlowDeps): ReviewFlowService {
  const flows = new Map<string, ReviewFlowState>();
  const threshold = deps.passRiskThreshold ?? 2;
  let ticking = false;

  const log = (sessionId: string, type: string, data: JsonObject) => deps.append(sessionId, type, data);

  const stepFlow = async (flow: ReviewFlowState): Promise<void> => {
    const status = await deps.sessionStatus(flow.sessionId);
    if (status === null) {
      flow.status = "failed";
      flow.stoppedReason = "session no longer exists";
      await log(flow.sessionId, "review-flow/failed", { flowId: flow.id, reason: flow.stoppedReason });
      return;
    }
    // permission/question prompts pause the loop until a human answers
    if (status === "waiting") {
      flow.status = "paused";
      flow.stoppedReason = "session is waiting on a permission or question";
      await log(flow.sessionId, "review-flow/paused", { flowId: flow.id, reason: flow.stoppedReason });
      return;
    }
    if (flow.status === "implementing" && status === "working") return; // still implementing
    if (flow.status !== "implementing" || status !== "idle") return;

    // session settled → request a review of the working tree
    flow.status = "reviewing";
    const projectId = await deps.sessionProject(flow.sessionId);
    if (!projectId) {
      flow.status = "failed";
      flow.stoppedReason = "session has no project";
      await log(flow.sessionId, "review-flow/failed", { flowId: flow.id, reason: flow.stoppedReason });
      return;
    }
    await log(flow.sessionId, "review-flow/review-requested", { flowId: flow.id, iteration: flow.iteration });
    const result = await deps.review(flow.sessionId, { kind: "working-tree", projectId });
    if (!result.ok) {
      flow.status = "failed";
      flow.stoppedReason = result.reason;
      await log(flow.sessionId, "review-flow/failed", { flowId: flow.id, reason: result.reason });
      return;
    }
    flow.latestReviewId = result.reviewId;
    flow.baseDigest = result.sourceDigest;
    const blocking = result.assessment.findings.filter((f) => f.severity === "critical" || f.severity === "high");
    if (result.assessment.riskScore <= threshold && blocking.length === 0) {
      flow.status = "passed";
      await log(flow.sessionId, "review-flow/passed", {
        flowId: flow.id, reviewId: result.reviewId, iteration: flow.iteration,
      });
      return;
    }
    if (flow.iteration >= flow.maxIterations) {
      flow.status = "stopped";
      flow.stoppedReason = `iteration limit (${flow.maxIterations}) reached`;
      await log(flow.sessionId, "review-flow/stopped", { flowId: flow.id, reason: flow.stoppedReason });
      return;
    }
    flow.iteration += 1;
    const prompt = [
      `Automated review iteration ${flow.iteration}: the reviewer requested changes (risk ${result.assessment.riskScore}/5).`,
      result.assessment.summary,
      ...blocking.map((f) => `- [${f.severity}] ${f.path ? `${f.path}${f.line ? `:${f.line}` : ""} — ` : ""}${f.body}`),
      "Address these findings. Do not merge, push, or publish anything.",
    ].join("\n");
    // the complete handoff prompt is logged before the implementer sees it
    await log(flow.sessionId, "review-flow/changes-requested", {
      flowId: flow.id, reviewId: result.reviewId, iteration: flow.iteration, prompt,
    });
    flow.status = "implementing";
    await deps.send(flow.sessionId, prompt);
  };

  return {
    async create(sessionId, opts = {}) {
      const existing = flows.get(sessionId);
      if (existing && ACTIVE.has(existing.status)) return existing;
      const flow: ReviewFlowState = {
        id: randomUUID(),
        sessionId,
        status: "implementing",
        iteration: 0,
        maxIterations: Math.min(10, Math.max(1, opts.maxIterations ?? 3)),
        baseDigest: "",
      };
      flows.set(sessionId, flow);
      await log(sessionId, "review-flow/started", { flowId: flow.id, maxIterations: flow.maxIterations });
      return flow;
    },

    get: (sessionId) => flows.get(sessionId) ?? null,

    async pause(sessionId) {
      const flow = flows.get(sessionId);
      if (!flow || !ACTIVE.has(flow.status)) return flow ?? null;
      flow.status = "paused";
      flow.stoppedReason = "paused by user";
      await log(sessionId, "review-flow/paused", { flowId: flow.id, reason: flow.stoppedReason });
      return flow;
    },

    async resume(sessionId) {
      const flow = flows.get(sessionId);
      if (!flow || flow.status !== "paused") return flow ?? null;
      flow.status = "implementing";
      delete flow.stoppedReason;
      await log(sessionId, "review-flow/started", { flowId: flow.id, resumed: true, maxIterations: flow.maxIterations });
      return flow;
    },

    async stop(sessionId, reason = "stopped by user") {
      const flow = flows.get(sessionId);
      if (!flow) return null;
      // idempotent: stopping a settled flow appends nothing
      if (flow.status === "stopped" || flow.status === "passed" || flow.status === "failed") return flow;
      flow.status = "stopped";
      flow.stoppedReason = reason;
      await log(sessionId, "review-flow/stopped", { flowId: flow.id, reason });
      return flow;
    },

    async tick() {
      if (ticking) return;
      ticking = true;
      try {
        for (const flow of flows.values()) {
          if (!ACTIVE.has(flow.status)) continue;
          await stepFlow(flow).catch(async (e: unknown) => {
            flow.status = "failed";
            flow.stoppedReason = e instanceof Error ? e.message : String(e);
            await log(flow.sessionId, "review-flow/failed", { flowId: flow.id, reason: flow.stoppedReason }).catch(() => {});
          });
        }
      } finally {
        ticking = false;
      }
    },
  };
}

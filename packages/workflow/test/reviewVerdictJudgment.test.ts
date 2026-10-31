import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SpaceContext, WorkflowNodeDto } from "@polyth/contracts";
import type { JudgmentService } from "@polyth/judgment/server";
import {
  DEFAULT_VERDICT_MARGIN,
  DEFAULT_VERDICT_THRESHOLD,
  DEFAULT_VERDICT_UNCERTAIN,
  WORKFLOW_REVIEW_VERDICT_SCOPE,
  WORKFLOW_REVIEW_VERDICT_USE_ID,
  boundReviewReportTail,
  createReviewVerdictQuestion,
  judgeReviewVerdict,
  parseReviewVerdict,
  resolveReviewVerdict,
  workflowReviewVerdictDescriptor,
} from "../src/index.ts";
import { createWorkflowService } from "../src/index.ts";
import {
  workflowJudgedLabel,
  workflowNodeDetail,
  workflowUncertainReviews,
  workflowVerdictLabel,
} from "../widgets/workflowRun.ts";

function createFakeJudgmentService(options: {
  enabled?: boolean;
  params?: Record<string, unknown>;
  answer?: {
    value: "approved" | "changes_requested" | "cannot_tell";
    probabilities: { approved: number; changes_requested: number; cannot_tell: number };
    confidence?: number;
  };
  ok?: boolean;
  error?: Error;
}) {
  const calls: unknown[] = [];
  const registeredDescriptors: unknown[] = [];

  const service: JudgmentService = {
    registerEngine: () => () => {},
    registerUse: (descriptor) => {
      registeredDescriptors.push(descriptor);
      return () => {
        const idx = registeredDescriptors.indexOf(descriptor);
        if (idx >= 0) registeredDescriptors.splice(idx, 1);
      };
    },
    resolveUse: async (_ctx, useId) => {
      return {
        useId,
        scope: WORKFLOW_REVIEW_VERDICT_SCOPE,
        enabled: options.enabled ?? true,
        params: {
          threshold: DEFAULT_VERDICT_THRESHOLD,
          margin: DEFAULT_VERDICT_MARGIN,
          uncertain: DEFAULT_VERDICT_UNCERTAIN,
          ...(options.params ?? {}),
        },
      };
    },
    createRun: (async () => {
      if (options.error) throw options.error;
      return {
        judge: async (req: unknown) => {
          calls.push(req);
          if (options.ok === false) {
            return {
              ok: false,
              reason: "provider-error",
              retryable: false,
              attempts: 1,
              timing: { startedAt: 0, completedAt: 1, durationMs: 1 },
            };
          }
          const answer = options.answer ?? {
            value: "approved",
            confidence: 0.9,
            probabilities: { approved: 0.9, changes_requested: 0.05, cannot_tell: 0.05 },
          };
          return {
            ok: true,
            attempts: 1,
            engine: { id: "fake" },
            timing: { startedAt: 0, completedAt: 1, durationMs: 1 },
            answers: {
              verdict: {
                type: "choice",
                value: answer.value,
                confidence: answer.confidence ?? 0.9,
                probabilities: answer.probabilities,
              },
            },
          };
        },
        dispose: () => {},
      };
    }) as any,
  };

  return { service, calls, registeredDescriptors };
}

const space: SpaceContext = {
  spaceId: "test-space",
  spaceSlug: "test-space",
  userId: "user-test",
  role: "owner",
  deployment: "local-trusted" as SpaceContext["deployment"],
  storageDir: "/tmp/polyth-test",
};

test("workflow review verdict descriptor conforms to Judgment specifications", () => {
  assert.equal(workflowReviewVerdictDescriptor.id, WORKFLOW_REVIEW_VERDICT_USE_ID);
  assert.equal(workflowReviewVerdictDescriptor.scope, WORKFLOW_REVIEW_VERDICT_SCOPE);
  assert.equal(workflowReviewVerdictDescriptor.packageId, "workflow");
  assert.equal(workflowReviewVerdictDescriptor.evidence, "long");
  assert.equal(workflowReviewVerdictDescriptor.defaultEnabled, false);
  assert.equal(workflowReviewVerdictDescriptor.params.length, 3);
  assert.deepEqual(
    workflowReviewVerdictDescriptor.params.map((p) => p.id),
    ["threshold", "margin", "uncertain"]
  );
});

test("boundReviewReportTail bounds text to the last ~4000 characters", () => {
  const shortText = "Brief review report.";
  assert.equal(boundReviewReportTail(shortText), shortText);

  const longText = "A".repeat(5000) + "END_REPORT";
  const bounded = boundReviewReportTail(longText, 4000);
  assert.equal(bounded.length, 4000);
  assert.ok(bounded.endsWith("END_REPORT"));
});

test("policy: an explicit Verdict line ALWAYS wins and Judgment is not called", async () => {
  const fake = createFakeJudgmentService({
    answer: {
      value: "changes_requested",
      probabilities: { approved: 0.1, changes_requested: 0.85, cannot_tell: 0.05 },
    },
  });

  const outcomeApproved = await resolveReviewVerdict({
    output: "The changes look great.\n\nVerdict: approved",
    judgment: fake.service,
    space,
    projectId: "p1",
  });
  assert.equal(outcomeApproved.verdict, "approved");
  assert.equal(outcomeApproved.judgment, undefined, "no judgment recorded when explicit line wins");
  assert.equal(fake.calls.length, 0, "Judgment must never be called when explicit line is present");

  const outcomeChanges = await resolveReviewVerdict({
    output: "Need tests updated.\n\nVerdict: changes requested",
    judgment: fake.service,
    space,
    projectId: "p1",
  });
  assert.equal(outcomeChanges.verdict, "changes-requested");
  assert.equal(outcomeChanges.judgment, undefined);
  assert.equal(fake.calls.length, 0, "Judgment must never be called when explicit line is present");
});

test("judged changes: calls Judgment and returns changes-requested when threshold and margin pass", async () => {
  const fake = createFakeJudgmentService({
    answer: {
      value: "changes_requested",
      probabilities: { approved: 0.05, changes_requested: 0.85, cannot_tell: 0.1 },
    },
  });

  const outcome = await resolveReviewVerdict({
    output: "The review found that the database query has no limit clause and can exhaust memory.",
    judgment: fake.service,
    space,
    projectId: "p1",
    sessionId: "sess-1",
  });

  assert.equal(outcome.verdict, "changes-requested");
  assert.ok(outcome.judgment);
  assert.equal(outcome.judgment.verdict, "changes-requested");
  assert.equal(outcome.judgment.topChoice, "changes_requested");
  assert.equal(outcome.judgment.topProbability, 0.85);
  assert.ok(outcome.judgment.margin >= 0.7);
  assert.equal(fake.calls.length, 1);
});

test("judged approved: calls Judgment and returns approved when threshold and margin pass", async () => {
  const fake = createFakeJudgmentService({
    answer: {
      value: "approved",
      probabilities: { approved: 0.9, changes_requested: 0.05, cannot_tell: 0.05 },
    },
  });

  const outcome = await resolveReviewVerdict({
    output: "All unit tests pass and implementation looks clean. Ready to ship.",
    judgment: fake.service,
    space,
    projectId: "p1",
  });

  assert.equal(outcome.verdict, "approved");
  assert.ok(outcome.judgment);
  assert.equal(outcome.judgment.verdict, "approved");
  assert.equal(outcome.judgment.topChoice, "approved");
  assert.equal(outcome.judgment.topProbability, 0.9);
  assert.ok(outcome.judgment.margin >= 0.8);
  assert.equal(fake.calls.length, 1);
});

test("uncertain path with uncertain: 'ask' (default): records uncertain verdict without auto-rework", async () => {
  const fake = createFakeJudgmentService({
    params: { uncertain: "ask" },
    answer: {
      value: "cannot_tell",
      probabilities: { approved: 0.3, changes_requested: 0.3, cannot_tell: 0.4 },
    },
  });

  const outcome = await resolveReviewVerdict({
    output: "LGTM, though the retry path still swallows the abort error.",
    judgment: fake.service,
    space,
    projectId: "p1",
  });

  assert.equal(outcome.verdict, undefined);
  assert.ok(outcome.judgment);
  assert.equal(outcome.judgment.verdict, "uncertain");
  assert.equal(outcome.judgment.topChoice, "cannot_tell");
  assert.equal(outcome.judgment.topProbability, 0.4);
});

test("uncertain path with low margin: falls back to uncertain when margin < param", async () => {
  const fake = createFakeJudgmentService({
    params: { threshold: 0.7, margin: 0.2, uncertain: "ask" },
    answer: {
      value: "changes_requested",
      // Probability 0.75 >= 0.7, but runner-up is 0.65 -> margin = 0.1 < 0.2
      probabilities: { approved: 0.2, changes_requested: 0.55, cannot_tell: 0.25 },
    },
  });

  const outcome = await resolveReviewVerdict({
    output: "Mixed feedback on styling and performance.",
    judgment: fake.service,
    space,
    projectId: "p1",
  });

  assert.equal(outcome.verdict, undefined);
  assert.ok(outcome.judgment);
  assert.equal(outcome.judgment.verdict, "uncertain");
});

test("uncertain path with uncertain: 'approve': approves when uncertain", async () => {
  const fake = createFakeJudgmentService({
    params: { uncertain: "approve" },
    answer: {
      value: "cannot_tell",
      probabilities: { approved: 0.34, changes_requested: 0.33, cannot_tell: 0.33 },
    },
  });

  const outcome = await resolveReviewVerdict({
    output: "Some feedback notes without clear approval.",
    judgment: fake.service,
    space,
    projectId: "p1",
  });

  assert.equal(outcome.verdict, "approved");
  assert.ok(outcome.judgment);
  assert.equal(outcome.judgment.verdict, "approved");
  assert.equal(outcome.judgment.topProbability, 0.34);
});

test("judgment off or missing: behaves as today (verdict: undefined, no judgment recorded)", async () => {
  const fakeDisabled = createFakeJudgmentService({ enabled: false });

  const outcome = await resolveReviewVerdict({
    output: "Report with no verdict.",
    judgment: fakeDisabled.service,
    space,
    projectId: "p1",
  });

  assert.equal(outcome.verdict, undefined);
  assert.equal(outcome.judgment, undefined);
  assert.equal(fakeDisabled.calls.length, 0);

  const outcomeNoService = await resolveReviewVerdict({
    output: "Report with no verdict.",
  });
  assert.equal(outcomeNoService.verdict, undefined);
  assert.equal(outcomeNoService.judgment, undefined);
});

test("judgment failure or error: falls back to today's behavior (verdict: undefined)", async () => {
  const fakeFailed = createFakeJudgmentService({ ok: false });

  const outcomeFailed = await resolveReviewVerdict({
    output: "Report with no verdict.",
    judgment: fakeFailed.service,
    space,
    projectId: "p1",
  });
  assert.equal(outcomeFailed.verdict, undefined);
  assert.equal(outcomeFailed.judgment, undefined);

  const fakeError = createFakeJudgmentService({ error: new Error("network timeout") });
  const outcomeError = await resolveReviewVerdict({
    output: "Report with no verdict.",
    judgment: fakeError.service,
    space,
    projectId: "p1",
  });
  assert.equal(outcomeError.verdict, undefined);
  assert.equal(outcomeError.judgment, undefined);
});

test("UI labels: workflowVerdictLabel and workflowJudgedLabel display correctly", () => {
  assert.equal(workflowVerdictLabel("approved"), "Approved");
  assert.equal(workflowVerdictLabel("changes-requested"), "Changes requested");
  assert.equal(workflowVerdictLabel("uncertain"), "Uncertain");

  const judgmentSample = {
    verdict: "uncertain" as const,
    topChoice: "cannot_tell" as const,
    topProbability: 0.54,
    margin: 0.1,
    probabilities: { approved: 0.2, changes_requested: 0.26, cannot_tell: 0.54 },
  };
  assert.equal(workflowJudgedLabel(judgmentSample), "Judged · 54%");

  const nodeSample: any = {
    id: "review",
    role: "Reviewer",
    status: "done",
    judgment: judgmentSample,
  };
  assert.equal(workflowNodeDetail(nodeSample), "Uncertain · Judged · 54%");
  assert.deepEqual(workflowUncertainReviews({ status: "done", nodes: [nodeSample] }), [nodeSample]);
});

test("end-to-end workflow run: judged changes triggers rework loop", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workflow-judgment-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  let reviewCallCount = 0;

  const fake = createFakeJudgmentService({
    answer: {
      value: "changes_requested",
      probabilities: { approved: 0.1, changes_requested: 0.85, cannot_tell: 0.05 },
    },
  });

  const workerNode: WorkflowNodeDto = { id: "builder", role: "Builder", prompt: "build it", kind: "worker" };
  const reviewNode: WorkflowNodeDto = { id: "reviewer", role: "Reviewer", prompt: "review it", kind: "review" };

  const service = createWorkflowService({
    file: join(root, "workflows.json"),
    space,
    judgment: fake.service,
    append: async (_sid, type, data) => {
      events.push({ type, data: data as Record<string, unknown> });
    },
    runNode: async (ctx) => {
      if (ctx.node.id === "reviewer") {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          // Round 1: no verdict line, but expresses finding that needs rework
          return { output: "Found an issue in the auth flow: tokens never expire." };
        }
        // Round 2: explicit approval
        return { output: "Auth tokens now expire properly.\n\nVerdict: approved" };
      }
      return { output: `Builder pass ${ctx.round ?? 1} output.` };
    },
  });

  const wf = service.create({
    projectId: "p1",
    name: "Judgment review rework test",
    nodes: [workerNode, reviewNode],
    edges: [{ id: "e1", source: "builder", target: "reviewer" }],
    defaults: { reviewRounds: 2 },
  });

  const run = await service.start(wf.id, "parent-session", "Test input");

  // Wait for run execution to settle
  await new Promise((resolve) => setTimeout(resolve, 50));
  const settled = service.getRun(run.id)!;
  assert.equal(settled.status, "done");

  const reviewerNode = settled.nodes.find((n) => n.id === "reviewer")!;
  assert.equal(reviewerNode.round, 2, "review ran for 2 rounds");
  assert.equal(reviewerNode.verdict, "approved", "final verdict in round 2 was approved");

  // In round 1, Judgment was called and attached to node-progress
  const progressEvents = events.filter((e) => e.type === "workflow/node-progress" && e.data.nodeId === "reviewer");
  const round1Progress = progressEvents.find((e) => (e.data.node as Record<string, unknown>)?.verdict === "changes-requested");
  assert.ok(round1Progress, "Round 1 progress reported changes-requested verdict");
  const round1Judgment = (round1Progress?.data.node as Record<string, unknown>)?.judgment as Record<string, unknown>;
  assert.ok(round1Judgment, "Judgment data was included in round 1 progress");
  assert.equal(round1Judgment.topProbability, 0.85);

  assert.equal(fake.calls.length, 1, "Judgment was called exactly once in round 1, not in round 2 where explicit line won");
});

test("end-to-end workflow run: uncertain review with uncertain: 'ask' does not trigger rework", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workflow-uncertain-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  let reviewCalls = 0;

  const fake = createFakeJudgmentService({
    params: { uncertain: "ask" },
    answer: {
      value: "cannot_tell",
      probabilities: { approved: 0.3, changes_requested: 0.35, cannot_tell: 0.35 },
    },
  });

  const workerNode: WorkflowNodeDto = { id: "builder", role: "Builder", prompt: "build it", kind: "worker" };
  const reviewNode: WorkflowNodeDto = { id: "reviewer", role: "Reviewer", prompt: "review it", kind: "review" };

  const service = createWorkflowService({
    file: join(root, "workflows.json"),
    space,
    judgment: fake.service,
    append: async (_sid, type, data) => {
      events.push({ type, data: data as Record<string, unknown> });
    },
    runNode: async (ctx) => {
      if (ctx.node.id === "reviewer") {
        reviewCalls++;
        return { output: "Some observations, no clear verdict." };
      }
      return { output: "Built successfully." };
    },
  });

  const wf = service.create({
    projectId: "p1",
    name: "Uncertain review test",
    nodes: [workerNode, reviewNode],
    edges: [{ id: "e1", source: "builder", target: "reviewer" }],
    defaults: { reviewRounds: 2 },
  });

  const run = await service.start(wf.id, "parent-session", "Test input");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const settled = service.getRun(run.id)!;

  assert.equal(settled.status, "done");
  assert.equal(reviewCalls, 1, "Review was called only once: uncertain does not trigger auto-rework");

  const reviewerNode = settled.nodes.find((n) => n.id === "reviewer")!;
  assert.equal(reviewerNode.verdict, undefined);
  assert.equal(reviewerNode.judgment?.verdict, "uncertain");
  assert.ok(reviewerNode.judgment);
  assert.equal(reviewerNode.judgment.topProbability, 0.35);

  // Check parent context message
  const contextEvent = events.find((e) => e.type === "package/context");
  assert.ok(contextEvent);
  assert.match(String(contextEvent.data.text), /Reviewer: done, uncertain verdict \(judged 35%\)/);
  assert.match(String(contextEvent.data.text), /uncertain verdict requiring human attention/);
});

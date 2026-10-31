import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, WorkflowRunDto } from "@polyth/contracts";
import {
  createWorkflowService,
  type RunNodeFn,
  type WorkflowReviewSettled,
  type WorkflowService,
} from "../src/index.ts";

const BLOCKER = "- [blocker] src/cache.ts:12 — the cache key ignores the tenant; key it by tenant id";
const DISPUTE = "Disputed: cache key tenant — the key is already tenant-scoped upstream";

function setup(reports: Record<string, string[] | ((round: number) => string)>, decisionTimeoutMs?: number) {
  const events: Array<{ type: string; data: JsonObject }> = [];
  const settled: WorkflowReviewSettled[] = [];
  const calls: Array<{ id: string; round: number; prompt: string }> = [];
  const runNode: RunNodeFn = async (context) => {
    const round = context.round ?? 1;
    calls.push({ id: context.node.id, round, prompt: context.prompt });
    const script = reports[context.node.id];
    const output = typeof script === "function" ? script(round) : script?.[round - 1] ?? `${context.node.id} ok (round ${round})`;
    return { sessionId: `s-${context.node.id}`, output };
  };
  let clock = 1_000;
  const service = createWorkflowService({
    file: join(mkdtempSync(join(tmpdir(), "polyth-workflow-convergence-")), "workflows.json"),
    append: async (_sessionId, type, data) => { events.push({ type, data }); },
    runNode,
    now: () => clock++,
    onReviewSettled: (event) => settled.push(event),
    ...(decisionTimeoutMs !== undefined ? { decisionTimeoutMs } : {}),
  });
  const workflow = service.create({
    projectId: "p", name: "Build + Review",
    nodes: [
      { id: "builder", role: "Builder", prompt: "Build", kind: "worker" },
      { id: "review", role: "Reviewer", prompt: "Review", kind: "review" },
    ],
    edges: [{ id: "e", source: "builder", target: "review" }],
  });
  return { service, workflow, events, settled, calls };
}

async function settle(service: WorkflowService, id: string): Promise<WorkflowRunDto> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const run = service.getRun(id);
    if (run && run.status !== "running") return run;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("workflow run did not settle");
}
async function held(service: WorkflowService, id: string, expectedRound?: number): Promise<WorkflowRunDto> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const run = service.getRun(id);
    const review = run?.nodes.find((node) => node.id === "review");
    if (review?.needsDecision && (expectedRound === undefined || review.round === expectedRound)) return run!;
    if (run && run.status !== "running") throw new Error("run settled without holding the review");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("workflow run was never held for a decision");
}
const ids = (calls: Array<{ id: string; round: number }>) => calls.map((call) => `${call.id}@${call.round}`);
const reviewOf = (run: WorkflowRunDto) => run.nodes.find((node) => node.id === "review")!;

test("a clean report approves on the first round with one notification and no rework", async () => {
  const h = setup({ review: ["No findings.\n\nVerdict: approved"] });
  const run = await settle(h.service, (await h.service.start(h.workflow.id, "parent", "Task")).id);
  assert.deepEqual(ids(h.calls), ["builder@1", "review@1"]);
  assert.equal(reviewOf(run).verdict, "approved");
  assert.equal(h.settled.length, 1);
  assert.deepEqual(h.settled.map((event) => [event.outcome, event.rounds, event.parentSessionId]), [["approved", 1, "parent"]]);
});

test("notes alone approve early even when the verdict line asks for changes", async () => {
  const h = setup({ review: ["- [note] src/a.ts:3 — consider a clearer name\n- [minor] README.md — typo\n\nVerdict: changes requested"] });
  const run = await settle(h.service, (await h.service.start(h.workflow.id, "parent", "Task")).id);
  assert.deepEqual(ids(h.calls), ["builder@1", "review@1"], "notes never send work back");
  const review = reviewOf(run);
  assert.equal(review.verdict, "approved");
  assert.deepEqual(review.findings?.map((finding) => [finding.severity, finding.path, finding.line]), [["note", "src/a.ts", 3], ["note", "README.md", undefined]]);
  assert.equal(h.settled.length, 1);
});

test("a blocker requests changes even when the verdict line approves", async () => {
  const h = setup({ review: [`${BLOCKER}\n\nVerdict: approved`, "No findings.\n\nVerdict: approved"] });
  const run = await settle(h.service, (await h.service.start(h.workflow.id, "parent", "Task")).id);
  assert.deepEqual(ids(h.calls), ["builder@1", "review@1", "builder@2", "review@2"]);
  assert.match(h.calls[2]!.prompt, /Disputed: <finding in a few words>/, "the builder is told how to state a disagreement");
  assert.equal(reviewOf(run).verdict, "approved");
  assert.deepEqual(h.settled.map((event) => [event.outcome, event.rounds]), [["approved", 2]]);
});

test("a persistent blocker holds the run with the builder's reply, and accepting continues", async () => {
  const h = setup({ review: () => `${BLOCKER}\n\nVerdict: changes requested`, builder: (round) => round > 1 ? `Left it.\n\n${DISPUTE}` : "Built." });
  const started = await h.service.start(h.workflow.id, "parent", "Task", { reviewRounds: 2 }, undefined, "alice");
  const parked = await held(h.service, started.id);
  assert.deepEqual(ids(h.calls), ["builder@1", "review@1", "builder@2", "review@2", "builder@3", "review@3"]);
  const request = reviewOf(parked).needsDecision!;
  assert.equal(request.canAnotherRound, true);
  assert.deepEqual(request.items, [{
    finding: { severity: "blocker", path: "src/cache.ts", line: 12, message: "the cache key ignores the tenant; key it by tenant id" },
    reply: "the key is already tenant-scoped upstream",
  }]);
  assert.deepEqual(h.settled.map((event) => event.outcome), ["needs-decision"], "the person is asked exactly once");
  assert.equal(parked.status, "running");

  await assert.rejects(h.service.decide(started.id, { nodeId: "review", action: "accept" }, "bob"), /only the person who started/);
  await assert.rejects(h.service.decide(started.id, { nodeId: "review", action: "nope" as never }, "alice"), /action/);
  const accepted = await h.service.decide(started.id, { nodeId: "review", action: "accept", clientOperationId: "op-1" }, "alice");
  assert.equal(reviewOf(accepted).decision, "accepted");
  const run = await settle(h.service, started.id);
  assert.equal(run.status, "done");
  assert.equal(reviewOf(run).verdict, "changes-requested", "the review keeps its verdict");
  assert.equal(reviewOf(run).decision, "accepted");
  assert.equal(reviewOf(run).needsDecision, undefined);
  assert.deepEqual(ids(h.calls).length, 6, "accepting starts no further round");
  assert.match(String(h.events.at(-1)?.data.text), /the person accepted the work as it is/);
  assert.deepEqual(h.settled.map((event) => event.outcome), ["needs-decision"], "no approval notice for work nobody approved");
  // Repeating the decision is not an error and changes nothing.
  assert.equal(reviewOf(await h.service.decide(started.id, { nodeId: "review", action: "accept", clientOperationId: "op-1" }, "alice")).decision, "accepted");
  assert.equal(reviewOf(await h.service.decide(started.id, { nodeId: "review", action: "accept" }, "alice")).decision, "accepted");
  await assert.rejects(h.service.decide(started.id, { nodeId: "review", action: "another-round" }, "alice"), /not waiting/);
});

test("another round runs once more with the person's note and finishes when the review approves", async () => {
  const h = setup({ review: (round) => round >= 4 ? "No findings.\n\nVerdict: approved" : `${BLOCKER}\n\nVerdict: changes requested` });
  const started = await h.service.start(h.workflow.id, "parent", "Task", { reviewRounds: 2 }, undefined, "alice");
  await held(h.service, started.id);
  await h.service.decide(started.id, { nodeId: "review", action: "another-round", note: "Scope the key by tenant id, nothing else." }, "alice");
  const run = await settle(h.service, started.id);
  assert.deepEqual(ids(h.calls).slice(6), ["builder@4", "review@4"]);
  assert.match(h.calls[6]!.prompt, /# Guidance from the person[\s\S]*Scope the key by tenant id/);
  assert.doesNotMatch(h.calls[7]!.prompt, /Guidance from the person/, "only the executors receive the note");
  assert.equal(reviewOf(run).verdict, "approved");
  assert.equal(reviewOf(run).decision, undefined);
  assert.deepEqual(h.settled.map((event) => [event.outcome, event.rounds]), [["needs-decision", 3], ["approved", 4]]);
});

test("a person can grant at most two extra rounds, then only accepting is offered", async () => {
  const h = setup({ review: () => `${BLOCKER}\n\nVerdict: changes requested` });
  const started = await h.service.start(h.workflow.id, "parent", "Task", { reviewRounds: 1 }, undefined, "alice");
  let parked = await held(h.service, started.id, 2);
  assert.equal(reviewOf(parked).needsDecision?.canAnotherRound, true);
  assert.equal(reviewOf(parked).roundLimit, 2);
  await h.service.decide(started.id, { nodeId: "review", action: "another-round" }, "alice");
  parked = await held(h.service, started.id, 3);
  assert.equal(reviewOf(parked).roundLimit, 3);
  await h.service.decide(started.id, { nodeId: "review", action: "another-round" }, "alice");
  parked = await held(h.service, started.id, 4);
  assert.equal(reviewOf(parked).needsDecision?.canAnotherRound, false);
  await assert.rejects(h.service.decide(started.id, { nodeId: "review", action: "another-round" }, "alice"), /no more extra rounds/);
  await h.service.decide(started.id, { nodeId: "review", action: "accept" }, "alice");
  const run = await settle(h.service, started.id);
  assert.equal(run.status, "done");
  assert.deepEqual(ids(h.calls), ["builder@1", "review@1", "builder@2", "review@2", "builder@3", "review@3", "builder@4", "review@4"]);
});

test("a held review moves on at its deadline and records that nobody decided", async () => {
  const h = setup({ review: () => `${BLOCKER}\n\nVerdict: changes requested` }, 15);
  const run = await settle(h.service, (await h.service.start(h.workflow.id, "parent", "Task", { reviewRounds: 1 }, undefined, "alice")).id);
  assert.equal(run.status, "done");
  assert.equal(reviewOf(run).decision, "timed-out");
  assert.equal(reviewOf(run).needsDecision, undefined);
  assert.equal(reviewOf(run).verdict, "changes-requested");
  assert.match(String(h.events.at(-1)?.data.text), /still requested changes after the allowed rework rounds; the result below is not approved/);
});

test("stopping a held run releases the hold without a decision", async () => {
  const h = setup({ review: () => `${BLOCKER}\n\nVerdict: changes requested` });
  const started = await h.service.start(h.workflow.id, "parent", "Task", { reviewRounds: 1 }, undefined, "alice");
  await held(h.service, started.id);
  const stopped = await h.service.stop(started.id);
  assert.equal(stopped.status, "stopped");
  await assert.rejects(h.service.decide(started.id, { nodeId: "review", action: "accept" }, "alice"), /not waiting/);
});

test("zero review rounds never hold a run", async () => {
  const h = setup({ review: () => `${BLOCKER}\n\nVerdict: changes requested` });
  const run = await settle(h.service, (await h.service.start(h.workflow.id, "parent", "Task", { reviewRounds: 0 })).id);
  assert.deepEqual(ids(h.calls), ["builder@1", "review@1"]);
  assert.equal(run.status, "done");
});

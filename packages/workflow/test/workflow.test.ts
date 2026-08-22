import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, WorkflowRunDto } from "@polyth/contracts";
import {
  buildNodePrompt,
  createWorkflowService,
  type RunNodeFn,
  type WorkflowService,
} from "../src/index.ts";

interface Harness {
  events: Array<{ sessionId: string; type: string; data: JsonObject }>;
  file: string;
  service: WorkflowService;
}

function harness(runNode: RunNodeFn, file?: string): Harness {
  const events: Array<{ sessionId: string; type: string; data: JsonObject }> = [];
  const target = file ?? join(mkdtempSync(join(tmpdir(), "polyth-workflow-")), "workflows.json");
  let clock = 1_000;
  const service = createWorkflowService({
    file: target,
    append: async (sessionId, type, data) => {
      events.push({ sessionId, type, data });
    },
    runNode,
    now: () => clock++,
  });
  return { events, file: target, service };
}

async function terminal(service: WorkflowService, id: string): Promise<WorkflowRunDto> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = service.getRun(id);
    if (run && run.status !== "running") return run;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("workflow run did not settle");
}

const node = (id: string, role = id) => ({ id, role, prompt: `Instructions for ${role}` });

test("buildNodePrompt includes role, instructions, task, and labelled upstream output", () => {
  const prompt = buildNodePrompt(
    node("review", "Reviewer"),
    "Ship the feature",
    [{ node: node("draft", "Writer"), output: "A proposed implementation" }],
  );
  assert.match(prompt, /# Role\n\nReviewer/);
  assert.match(prompt, /# Instructions\n\nInstructions for Reviewer/);
  assert.match(prompt, /# Workflow input\n\nShip the feature/);
  assert.match(prompt, /## Writer \(draft\)\n\nA proposed implementation/);
});

test("definitions persist as JSON and support project-scoped CRUD", () => {
  const first = harness(async () => ({ output: "ok" }));
  const created = first.service.create({
    projectId: "p1",
    name: "Release",
    nodes: [node("a")],
    edges: [],
    defaults: { pipe: "direct", maxParallel: 2 },
  });
  first.service.create({ projectId: "p2", name: "Other", nodes: [node("b")], edges: [] });
  assert.equal(first.service.list("p1").length, 1);
  assert.equal(first.service.get(created.id)?.name, "Release");

  const updated = first.service.update(created.id, { name: "Release review" });
  assert.equal(updated.name, "Release review");
  assert.equal(JSON.parse(readFileSync(first.file, "utf8")).v, 1);

  const reloaded = harness(async () => ({ output: "ok" }), first.file);
  assert.equal(reloaded.service.get(created.id)?.name, "Release review");
  assert.equal(reloaded.service.remove(created.id), true);
  assert.equal(reloaded.service.get(created.id), null);
});

test("invalid definitions and empty run inputs are rejected", async () => {
  const h = harness(async () => ({ output: "ok" }));
  assert.throws(() => h.service.create({
    projectId: "p",
    name: "Cycle",
    nodes: [node("a"), node("b")],
    edges: [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "a" },
    ],
  }), /cycle/);
  const workflow = h.service.create({ projectId: "p", name: "Valid", nodes: [node("a")], edges: [] });
  await assert.rejects(() => h.service.start(workflow.id, "session", "  "), /input/);
});

test("engine executes layers in order and caps concurrency within a layer", async () => {
  let concurrent = 0;
  let peak = 0;
  const started: string[] = [];
  const h = harness(async (context, onUpdate) => {
    started.push(context.node.id);
    concurrent++;
    peak = Math.max(peak, concurrent);
    await onUpdate({ activity: "working" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent--;
    return { sessionId: `s-${context.node.id}`, output: `output-${context.node.id}` };
  });
  const workflow = h.service.create({
    projectId: "p",
    name: "Parallel",
    nodes: [node("a"), node("b"), node("c"), node("final")],
    edges: [
      { id: "ea", source: "a", target: "final" },
      { id: "eb", source: "b", target: "final" },
      { id: "ec", source: "c", target: "final" },
    ],
  });
  const startedRun = await h.service.start(workflow.id, "parent", "Do work", { maxParallel: 2 });
  const run = await terminal(h.service, startedRun.id);

  assert.equal(peak, 2);
  assert.equal(started.at(-1), "final");
  assert.equal(run.status, "done");
  assert.deepEqual(run.layers, [["a", "b", "c"], ["final"]]);
  assert.ok(run.nodes.every((entry) => entry.status === "done"));
  assert.equal(h.events[0]?.type, "workflow/run-started");
  assert.equal(h.events.at(-1)?.type, "workflow/run-completed");
  assert.ok(h.events.some((event) => event.type === "workflow/node-progress"));
});

test("direct and ancestors pipe modes select the expected prompt context", async () => {
  const prompts = new Map<string, string>();
  const h = harness(async (context) => {
    prompts.set(`${context.workflowId}:${context.node.id}`, context.prompt);
    return { output: `result-${context.node.id}` };
  });
  const create = (name: string, pipe: "direct" | "ancestors") => h.service.create({
    projectId: "p",
    name,
    nodes: [node("a", "Researcher"), node("b", "Writer"), node("c", "Reviewer")],
    edges: [
      { id: "ab", source: "a", target: "b" },
      { id: "bc", source: "b", target: "c" },
    ],
    defaults: { pipe },
  });
  const direct = create("Direct", "direct");
  const directRun = await h.service.start(direct.id, "parent", "Task");
  await terminal(h.service, directRun.id);
  assert.match(prompts.get(`${direct.id}:c`) ?? "", /result-b/);
  assert.doesNotMatch(prompts.get(`${direct.id}:c`) ?? "", /result-a/);

  const all = create("Ancestors", "ancestors");
  const allRun = await h.service.start(all.id, "parent", "Task");
  await terminal(h.service, allRun.id);
  assert.match(prompts.get(`${all.id}:c`) ?? "", /result-a/);
  assert.match(prompts.get(`${all.id}:c`) ?? "", /result-b/);
});

test("node failure skips downstream nodes without blocking independent siblings", async () => {
  const calls: string[] = [];
  const h = harness(async (context) => {
    calls.push(context.node.id);
    if (context.node.id === "bad") throw new Error("boom");
    return { output: "ok" };
  });
  const workflow = h.service.create({
    projectId: "p",
    name: "Failure",
    nodes: [node("bad"), node("independent"), node("downstream"), node("tail")],
    edges: [
      { id: "bd", source: "bad", target: "downstream" },
      { id: "dt", source: "downstream", target: "tail" },
    ],
  });
  const started = await h.service.start(workflow.id, "parent", "Task");
  const run = await terminal(h.service, started.id);
  const statuses = Object.fromEntries(run.nodes.map((entry) => [entry.id, entry.status]));
  assert.deepEqual(statuses, {
    bad: "error",
    independent: "done",
    downstream: "skipped",
    tail: "skipped",
  });
  assert.deepEqual(calls.sort(), ["bad", "independent"]);
  assert.equal(run.status, "error");
});

test("run options reach nodes and stop aborts active work and queued layers", async () => {
  let receivedPolicy = "";
  const h = harness(async (context, onUpdate) => {
    receivedPolicy = context.permissions;
    await onUpdate({ sessionId: "child", activity: "waiting" });
    await new Promise<void>((resolve, reject) => {
      if (context.signal.aborted) {
        const error = new Error("stopped");
        error.name = "AbortError";
        reject(error);
        return;
      }
      context.signal.addEventListener("abort", () => {
        const error = new Error("stopped");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
    return { output: "" };
  });
  const workflow = h.service.create({
    projectId: "p",
    name: "Stop",
    nodes: [node("first"), node("second")],
    edges: [{ id: "edge", source: "first", target: "second" }],
  });
  const started = await h.service.start(workflow.id, "parent", "Task", { permissions: "manual" });
  for (let attempt = 0; attempt < 100 && h.service.getRun(started.id)?.nodes[0]?.status !== "running"; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const stopped = await h.service.stop(started.id);
  assert.equal(receivedPolicy, "manual");
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(stopped.nodes.map((entry) => entry.status), ["stopped", "stopped"]);
  assert.equal(h.events.at(-1)?.type, "workflow/run-completed");
});

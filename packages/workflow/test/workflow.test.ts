import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, ModelRef, SessionEvent, SessionService, WorkflowRunDto } from "@polyth/contracts";
import {
  buildNodePrompt,
  createWorkflowService,
  type RunNodeFn,
  type WorkflowDeps,
  type WorkflowService,
} from "../src/index.ts";
import { workflowPresets } from "../src/presets.ts";
import { createWorkflowRunNode } from "../src/runner.ts";

interface Harness {
  events: Array<{ sessionId: string; type: string; data: JsonObject }>;
  file: string;
  service: WorkflowService;
}

function harness(runNode: RunNodeFn, file?: string, extra: Partial<WorkflowDeps> = {}): Harness {
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
    ...extra,
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

test("finalizer context preserves the verifier conclusion and canonical child reference", () => {
  const prompt = buildNodePrompt(node("finalize", "Finalizer"), "Finish the requested change", [
    { node: node("scout"), output: "Background ".repeat(2_000) },
    { node: node("verify", "Verifier"), output: "Progress ".repeat(2_000) + "Required fix: Gallery still has a box icon.", sessionId: "verifier-child", direct: true },
  ]);
  assert.ok(prompt.length <= 12_000);
  assert.match(prompt, /Required fix: Gallery still has a box icon\./);
  assert.match(prompt, /verifier-child/);
  assert.match(prompt, /[Oo]mitted/);
});

test("a stopped verifier never publishes a successful workflow or starts its finalizer", async () => {
  const calls: string[] = [];
  const h = harness(async (context) => {
    calls.push(context.node.id);
    throw Object.assign(new Error("resume cancelled"), { name: "AbortError" });
  });
  const workflow = h.service.create({
    projectId: "p", name: "Verify and finalize", nodes: [node("verify"), node("finalize")],
    edges: [{ id: "dependency", source: "verify", target: "finalize" }],
  });
  const run = await terminal(h.service, (await h.service.start(workflow.id, "parent", "Task")).id);
  assert.equal(run.status, "stopped");
  assert.deepEqual(calls, ["verify"]);
  assert.equal(run.nodes[1]?.status, "skipped");
  // The parent agent learns the outcome, never a successful result.
  const context = h.events.filter((event) => event.type === "package/context");
  assert.equal(context.length, 1);
  assert.match(String(context[0]?.data.title), /stopped/);
  assert.match(String(context[0]?.data.text), /^Status: stopped/);
  assert.match(String(context[0]?.data.text), /- verify: stopped/);
  assert.doesNotMatch(String(context[0]?.data.text), /Result:/);
});

test("capacity recovery carries completed verification into the finalizer and canonical result", async () => {
  const prompts: string[] = [];
  let children = 0;
  let verifierReads = 0;
  const event = (sessionId: string, seq: number, type: string, data: JsonObject): SessionEvent =>
    ({ id: `${sessionId}:${seq}`, sessionId, seq, type, data, time: seq, v: 1 });
  const sessions = {
    create: async () => ({ id: ++children === 1 ? "verify-child" : "finalize-child" }),
    send: async (_sessionId: string, input: { text: string }) => { prompts.push(input.text); return {}; },
    events: async (sessionId: string) => sessionId === "verify-child" ? ++verifierReads === 1 ? [
      event(sessionId, 1, "turn/stopped", { reason: "error", error: "At capacity", retry: { resumeAt: Date.now(), attempt: 1 } }),
    ] : [
      event(sessionId, 2, "turn/started", { turnId: "recovered" }),
      event(sessionId, 3, "assistant/message", { partId: "report", text: "Required fix: Gallery still has a box icon. Tests: 12 passed." }),
      event(sessionId, 4, "turn/stopped", { reason: "completed" }),
    ] : [
      event(sessionId, 1, "assistant/message", { partId: "result", text: "Gallery icon fixed; final checks passed." }),
      event(sessionId, 2, "turn/stopped", { reason: "completed" }),
    ],
  } as unknown as SessionService;
  const h = harness(createWorkflowRunNode(sessions));
  const workflow = h.service.create({
    projectId: "p", name: "Verify and finalize", nodes: [node("verify", "Verifier"), node("finalize", "Finalizer")],
    edges: [{ id: "dependency", source: "verify", target: "finalize" }],
  });
  const run = await terminal(h.service, (await h.service.start(workflow.id, "parent", "Finish the icon change")).id);
  assert.equal(children, 2);
  assert.equal(prompts.length, 2, "no workflow-owned replay during the capacity wait");
  assert.match(prompts[1]!, /Required fix: Gallery still has a box icon/);
  assert.match(prompts[1]!, /verify-child/);
  assert.deepEqual(run.nodes.map((node) => node.status), ["done", "done"]);
  assert.equal(run.result, "Gallery icon fixed; final checks passed.");
  assert.equal(h.events.at(-1)?.type, "package/context");
  assert.match(String(h.events.at(-1)?.data.text), /Request:\nFinish the icon change/);
  assert.match(String(h.events.at(-1)?.data.text), /- Finalizer: done \(session finalize-child\)/);
  assert.ok(String(h.events.at(-1)?.data.text).endsWith(`Result:\n${run.result}`));
});

test("lead prompts identify every customized worker by its actual execution unit", async () => {
  const prompts = new Map<string, string>();
  const h = harness(async ({ node, prompt }) => {
    prompts.set(node.id, prompt);
    return { output: "assigned" };
  });
  const definition = h.service.create({
    projectId: "p1", name: "Custom team",
    nodes: [{ ...node("lead"), kind: "lead" },
      { ...node("worker-custom"), group: "implementation" },
      { ...node("worker-new"), group: "implementation" }],
    edges: [{ id: "a", source: "lead", target: "worker-custom" },
      { id: "b", source: "lead", target: "worker-new" }],
  });
  await terminal(h.service, (await h.service.start(definition.id, "parent", "Do work")).id);
  assert.match(prompts.get("lead") ?? "", /worker-custom: worker-custom \(group: implementation\)/);
  assert.match(prompts.get("lead") ?? "", /worker-new: worker-new \(group: implementation\)/);
  assert.match(prompts.get("worker-new") ?? "", /# Execution unit\n\nworker-new \(group: implementation\)/);
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
  await assert.rejects(
    () => h.service.start(workflow.id, "session", "Task", { maxParallel: 1.5 }),
    /whole number from 1 to 32/,
  );
  await assert.rejects(
    () => h.service.start(workflow.id, "session", "Task", { maxParallel: 33 }),
    /whole number from 1 to 32/,
  );
  await assert.rejects(
    () => h.service.start(workflow.id, "session", "Task", { nodeTimeoutMs: 1_500.5 }),
    /whole number >= 1000/,
  );
});

test("built-in definitions stay an immutable overlay while remaining runnable", async () => {
  const preset = workflowPresets("p")[0]!;
  const h = createWorkflowService({
    file: join(mkdtempSync(join(tmpdir(), "polyth-workflow-builtins-")), "workflows.json"),
    append: async () => {},
    builtin: (id) => (id === preset.id ? preset : null),
    runNode: async () => ({ output: "ok" }),
  });
  const run = await h.start(preset.id, "parent", "Task");
  assert.equal(run.workflowId, preset.id);
  assert.equal(h.get(preset.id), null);
  const copy = h.create({
    projectId: "p",
    name: "Build + Review copy",
    preset: preset.preset,
    nodes: preset.nodes,
    edges: preset.edges,
  });
  assert.deepEqual(copy.preset, preset.preset);
  assert.equal(copy.builtin, undefined);
});

test("an admitted run hands its task to the parent's namer after the start event", async () => {
  const preset = workflowPresets("p")[0]!;
  const appended: string[] = [];
  const named: Array<{ parent?: string; input: string; started: boolean }> = [];
  const h = createWorkflowService({
    file: join(mkdtempSync(join(tmpdir(), "polyth-workflow-named-")), "workflows.json"),
    append: async (_sessionId, type) => { appended.push(type); },
    builtin: (id) => (id === preset.id ? preset : null),
    runNode: async () => ({ output: "ok" }),
    onRunStarted: (run) => {
      named.push({ parent: run.parentSessionId, input: run.input, started: appended.includes("workflow/run-started") });
      throw new Error("naming failures never fail the run");
    },
  });
  const run = await h.start(preset.id, "parent", "Fix the schedule date picker");
  assert.deepEqual(named, [{ parent: "parent", input: "Fix the schedule date picker", started: true }]);
  assert.equal(run.parentSessionId, "parent");
});

test("launch defaults apply the current chat route only to unassigned nodes", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const h = harness(async (context) => {
    seen.push({
      id: context.node.id,
      model: context.node.model,
      harness: context.node.harness,
      agent: context.node.agent,
    });
    return { output: "ok" };
  });
  const workflow = h.service.create({
    projectId: "p",
    name: "Current route",
    nodes: [
      node("inherited"),
      { ...node("authored"), model: { providerID: "authored", modelID: "model" } },
    ],
    edges: [],
  });
  const run = await h.service.start(workflow.id, "parent", "Task", undefined, {
    model: { providerID: "chat", modelID: "current", variant: "high" },
    harness: { mode: "pinned", harnessId: "chat-harness" },
    agent: "chat-agent",
  });
  await terminal(h.service, run.id);
  assert.deepEqual(seen.find((entry) => entry.id === "inherited"), {
    id: "inherited",
    model: { providerID: "chat", modelID: "current", variant: "high" },
    harness: { mode: "pinned", harnessId: "chat-harness" },
    agent: "chat-agent",
  });
  assert.deepEqual(seen.find((entry) => entry.id === "authored"), {
    id: "authored",
    model: { providerID: "authored", modelID: "model" },
    harness: undefined,
    agent: undefined,
  });
  assert.equal(run.definition?.nodes[0]?.model?.modelID, "current");
  assert.equal(h.service.get(workflow.id)?.nodes[0]?.model, undefined, "saved definitions are not rewritten");
});

test("auto nodes follow the allowed chat model and fall back to the first allowed entry", async () => {
  const seen: Array<{ id: string; model?: ModelRef }> = [];
  const h = harness(async (context) => {
    seen.push({ id: context.node.id, ...(context.node.model ? { model: context.node.model } : {}) });
    return { output: "ok" };
  });
  const workflow = h.service.create({
    projectId: "p",
    name: "Auto route",
    nodes: [
      { ...node("any"), model: { providerID: "old", modelID: "pin" }, allowedModels: [] },
      { ...node("restricted"), allowedModels: [
        { providerID: "a", modelID: "m1" },
        { providerID: "a", modelID: "m2" },
      ] },
      { ...node("keeps-chat"), allowedModels: [{ providerID: "chat", modelID: "current" }] },
      { ...node("stale-allowed"), model: { providerID: "old", modelID: "pin" }, allowedModels: [
        { providerID: "old", modelID: "pin" },
        { providerID: "chat", modelID: "current" },
      ] },
    ],
    edges: [],
  });
  const run = await h.service.start(workflow.id, "parent", "Task", undefined, {
    model: { providerID: "chat", modelID: "current" },
  });
  await terminal(h.service, run.id);
  assert.deepEqual(seen.find((entry) => entry.id === "any")?.model, {
    providerID: "chat", modelID: "current",
  }, "an empty allow-list follows the chat route when the node uses that route");
  assert.deepEqual(seen.find((entry) => entry.id === "restricted")?.model, {
    providerID: "a", modelID: "m1",
  }, "a disallowed chat model falls back to the first allowed entry");
  assert.deepEqual(seen.find((entry) => entry.id === "keeps-chat")?.model, {
    providerID: "chat", modelID: "current",
  }, "an allowed chat model is kept");
  assert.deepEqual(seen.find((entry) => entry.id === "stale-allowed")?.model, {
    providerID: "chat", modelID: "current",
  }, "an API-authored pin does not override Auto even when the pin is allowed");
  assert.deepEqual(h.service.get(workflow.id)?.nodes[0]?.model,
    { providerID: "old", modelID: "pin" },
    "resolution never rewrites the saved definition");
});

test("Auto with no launch model does not carry an old pin into the run", async () => {
  const seen: Array<ModelRef | undefined> = [];
  const h = harness(async (context) => {
    seen.push(context.node.model);
    return { output: "ok" };
  });
  const workflow = h.service.create({
    projectId: "p", name: "Unpinned Auto", edges: [],
    nodes: [{ ...node("auto"), model: { providerID: "old", modelID: "pin" }, allowedModels: [] }],
  });
  const run = await h.service.start(workflow.id, "parent", "Task");
  await terminal(h.service, run.id);
  assert.deepEqual(seen, [undefined]);
  assert.equal(run.definition?.nodes[0]?.model, undefined);
  assert.deepEqual(h.service.get(workflow.id)?.nodes[0]?.model,
    { providerID: "old", modelID: "pin" }, "saved data is untouched");
});

test("Auto with a different pinned harness leaves the model to that harness", async () => {
  const seen: Array<{ model?: ModelRef; harness?: unknown }> = [];
  const h = harness(async ({ node: resolved }) => {
    seen.push({ model: resolved.model, harness: resolved.harness });
    return { output: "ok" };
  });
  const workflow = h.service.create({
    projectId: "p", name: "Auto harness default", edges: [],
    nodes: [{
      ...node("auto"),
      harness: { mode: "pinned", harnessId: "other-harness" },
      allowedModels: [],
    }],
  });
  const run = await h.service.start(workflow.id, "parent", "Task", undefined, {
    model: { providerID: "chat", modelID: "parent-model" },
    harness: { mode: "pinned", harnessId: "chat-harness" },
  });
  await terminal(h.service, run.id);

  assert.deepEqual(seen, [{
    model: undefined,
    harness: { mode: "pinned", harnessId: "other-harness" },
  }]);
  assert.equal(run.definition?.nodes[0]?.model, undefined,
    "the incompatible parent model is omitted from the resolved run");
});

test("malformed allowed-model lists are rejected", () => {
  const h = harness(async () => ({ output: "ok" }));
  assert.throws(
    () => h.service.create({
      projectId: "p", name: "bad", edges: [],
      nodes: [{ ...node("a"), allowedModels: [{ providerID: "", modelID: "x" }] }],
    }),
    /allowedModels is invalid/,
  );
  assert.throws(
    () => h.service.create({
      projectId: "p", name: "bad", edges: [],
      nodes: [{
        ...node("a"),
        allowedModels: Array.from({ length: 25 }, (_, index) => ({ providerID: "p", modelID: `m${index}` })),
      }],
    }),
    /allowedModels is invalid/,
  );
});

test("manual is the safe default while explicit auto remains available", async () => {
  const policies: string[] = [];
  const h = harness(async (context) => {
    policies.push(context.permissions);
    return { output: "ok" };
  });
  const workflow = h.service.create({ projectId: "p", name: "Policy", nodes: [node("a")], edges: [] });
  const manual = await h.service.start(workflow.id, "parent", "Task");
  await terminal(h.service, manual.id);
  const automatic = await h.service.start(workflow.id, "parent", "Task", { permissions: "auto" });
  await terminal(h.service, automatic.id);
  assert.deepEqual(policies, ["manual", "auto"]);
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
  assert.equal(startedRun.projectId, "p");
  assert.equal(startedRun.parentSessionId, "parent");
  assert.equal(startedRun.options?.maxParallel, 2);
  assert.equal(h.service.listRuns("p")[0]?.id, startedRun.id);
  assert.equal(h.service.listRuns("other").length, 0);
  const run = await terminal(h.service, startedRun.id);

  assert.equal(peak, 2);
  assert.equal(started.at(-1), "final");
  assert.equal(run.status, "done");
  assert.deepEqual(run.layers, [["a", "b", "c"], ["final"]]);
  assert.ok(run.nodes.every((entry) => entry.status === "done"));
  assert.equal(h.events[0]?.type, "workflow/run-started");
  assert.equal(h.events[0]?.data.parentSessionId, "parent");
  assert.deepEqual(h.events[0]?.data.options, {
    pipe: "ancestors",
    permissions: "manual",
    maxParallel: 2,
    nodeTimeoutMs: 1_800_000,
    reviewRounds: 2,
  });
  assert.deepEqual(h.events.slice(-2).map((event) => event.type), ["workflow/run-completed", "package/context"]);
  assert.ok(String(h.events.at(-1)?.data.text).endsWith("Result:\noutput-final"), "the final synthesis enters canonical chat context");
  assert.equal(h.events.at(-1)?.data.sourceId, `run:${run.id}`);
  assert.ok(h.events.some((event) => event.type === "workflow/node-progress"));
});

test("progress throttling never drops the start or end of a person's turn", async () => {
  const h = harness(async (_context, onUpdate) => {
    // The harness clock advances 1 ms per read, well inside the 250 ms throttle.
    await onUpdate({ activity: "tool: bash" });
    await onUpdate({ activity: "writing" });
    await onUpdate({ activity: "awaiting permission: bash" });
    await onUpdate({ activity: "thinking" });
    await onUpdate({ activity: "tool: read" });
    return { output: "ok" };
  });
  const workflow = h.service.create({ projectId: "p", name: "One", nodes: [node("a")], edges: [] });
  const run = await terminal(h.service, (await h.service.start(workflow.id, "parent", "Do work")).id);
  assert.equal(run.status, "done");
  const published = h.events
    .filter((event) => event.type === "workflow/node-progress")
    .map((event) => (event.data.node as { activity?: string }).activity)
    .filter(Boolean);
  // Ordinary progress stays throttled; only the wait boundaries always publish.
  assert.deepEqual(published, ["starting session", "awaiting permission: bash", "thinking"]);
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
  assert.deepEqual(h.events.slice(-2).map((event) => event.type), ["workflow/run-completed", "package/context"]);
  assert.match(String(h.events.at(-1)?.data.text), /^Status: stopped/);
});

test("same launch operation coalesces, while a mismatched scope conflicts", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen = new Promise<void>((resolve) => { entered = resolve; });
  const file = join(mkdtempSync(join(tmpdir(), "polyth-workflow-idempotency-")), "workflows.json");
  const service = createWorkflowService({
    file,
    append: async () => {},
    buildContext: async () => {
      entered();
      await gate;
      return undefined;
    },
    runNode: async () => ({ output: "ok" }),
  });
  const workflow = service.create({ projectId: "p", name: "Idempotent", nodes: [node("a")], edges: [] });
  const launch = { clientOperationId: "op-1" };
  const first = service.start(workflow.id, "parent", "Task", undefined, launch);
  await seen;
  const second = service.start(workflow.id, "parent", "Task", undefined, launch);
  await assert.rejects(
    () => service.start(workflow.id, "other-parent", "Task", undefined, launch),
    (cause: unknown) => (cause as { code?: string }).code === "conflict",
  );
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id);
  assert.equal(service.listRuns("p").length, 1);
});

test("a lost start response retries the durable admitted run", async () => {
  let failStart = true;
  const h = harness(async () => ({ output: "ok" }));
  const originalAppend = h.events;
  const file = h.file;
  const workflow = h.service.create({ projectId: "p", name: "Lost response", nodes: [node("a")], edges: [] });
  const service = createWorkflowService({
    file,
    append: async (sessionId, type, data) => {
      if (failStart && type === "workflow/run-started") {
        failStart = false;
        throw new Error("response lost");
      }
      originalAppend.push({ sessionId, type, data });
    },
    runNode: async () => ({ output: "ok" }),
  });
  const launch = { clientOperationId: "lost-1" };
  await assert.rejects(() => service.start(workflow.id, "parent", "Task", undefined, launch), /response lost/);
  const recovered = await service.start(workflow.id, "parent", "Task", undefined, launch);
  assert.equal(service.listRuns("p").length, 1);
  assert.equal(recovered.clientOperationId, "lost-1");
});

test("a lost retry-start response keeps the retry fork and operation binding", async () => {
  let runStarts = 0;
  const events: Array<{ type: string; data: JsonObject }> = [];
  const file = join(mkdtempSync(join(tmpdir(), "polyth-workflow-retry-lost-")), "workflows.json");
  const service = createWorkflowService({
    file,
    append: async (_sessionId, type, data) => {
      events.push({ type, data });
      if (type === "workflow/run-started" && ++runStarts === 2)
        throw new Error("response lost");
    },
    runNode: async () => {
      throw Object.assign(new Error("retryable"), {
        workflow: { retryable: true, phase: "runtime", sessionId: "child" },
      });
    },
  });
  const workflow = service.create({ projectId: "p", name: "Retry lost", nodes: [node("a")], edges: [] });
  const original = await service.start(workflow.id, "parent", "Task");
  await terminal(service, original.id);

  await assert.rejects(
    () => service.retry(original.id, "a", "retry-lost"),
    /response lost/,
  );
  const admitted = service.listRuns("p").find((run) => run.retryOf === original.id);
  assert.ok(admitted, "the uncertain retry admission remains durable");
  const recovered = await service.retry(original.id, "a", "retry-lost");
  assert.equal(recovered.id, admitted.id);
  assert.equal(events.filter((event) => event.type === "workflow/run-started").length, 2);
});

test("a terminal event does not get a contradictory error after projection save failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-workflow-terminal-save-"));
  const file = join(dir, "workflows.json");
  const backup = `${file}.before-terminal`;
  const events: Array<{ type: string; data: JsonObject }> = [];
  let failed = false;
  const service = createWorkflowService({
    file,
    append: async (_sessionId, type, data) => {
      events.push({ type, data });
      if (type === "workflow/run-completed" && !failed) {
        failed = true;
        renameSync(file, backup);
        mkdirSync(file);
      }
    },
    runNode: async () => ({ output: "done" }),
  });
  const workflow = service.create({ projectId: "p", name: "Terminal save", nodes: [node("a")], edges: [] });
  const started = await service.start(workflow.id, "parent", "Task");
  const terminalRun = await terminal(service, started.id);
  assert.equal(terminalRun.status, "done");
  assert.equal(events.filter((event) => event.type === "workflow/run-completed").length, 1);

  rmSync(file, { recursive: true, force: true });
  renameSync(backup, file);
  const reloaded = createWorkflowService({ file, append: async () => {}, runNode: async () => ({ output: "ok" }) });
  assert.equal(reloaded.getRun(started.id)?.status, "stopped");
  assert.equal(reloaded.getRun(started.id)?.interrupted, true);
});

test("an uncertain terminal append stays fenced without a fabricated fallback", async () => {
  let attemptedResolve!: () => void;
  const attempted = new Promise<void>((resolve) => { attemptedResolve = resolve; });
  let calls = 0;
  const events: Array<{ type: string; data: JsonObject }> = [];
  const file = join(mkdtempSync(join(tmpdir(), "polyth-workflow-terminal-lost-")), "workflows.json");
  const service = createWorkflowService({
    file,
    append: async (_sessionId, type, data) => {
      events.push({ type, data });
      if (type === "workflow/run-completed") {
        attemptedResolve();
        throw new Error("response lost");
      }
    },
    runNode: async () => {
      calls++;
      return { output: "done" };
    },
  });
  const workflow = service.create({ projectId: "p", name: "Terminal lost", nodes: [node("a")], edges: [] });
  const started = await service.start(workflow.id, "parent", "Task");
  await attempted;
  assert.equal(service.getRun(started.id)?.status, "running");
  assert.equal(calls, 1);
  assert.equal(events.filter((event) => event.type === "workflow/run-completed").length, 1);

  const reloaded = createWorkflowService({ file, append: async () => {}, runNode: async () => ({ output: "ok" }) });
  assert.equal(reloaded.getRun(started.id)?.status, "stopped");
  assert.equal(reloaded.getRun(started.id)?.interrupted, true);
});

test("malformed persisted workflow state fails closed", () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-workflow-corrupt-")), "workflows.json");
  writeFileSync(file, JSON.stringify({ v: 1, workflows: {}, runs: [] }));
  assert.throws(
    () => createWorkflowService({ file, append: async () => {}, runNode: async () => ({ output: "ok" }) }),
    (cause: unknown) => (cause as { code?: string }).code === "storage-error",
  );
});

test("retry reruns the failed node and blocked descendants only", async () => {
  const attempts = new Map<string, number>();
  const h = harness(async (context) => {
    const attempt = (attempts.get(context.node.id) ?? 0) + 1;
    attempts.set(context.node.id, attempt);
    if (context.node.id === "failed" && attempt === 1) {
      throw Object.assign(new Error("retryable"), {
        workflow: { retryable: true, phase: "runtime", sessionId: "child" },
      });
    }
    if (context.node.id === "independent") {
      throw Object.assign(new Error("independent failure"), {
        workflow: { retryable: true, phase: "runtime", sessionId: "child" },
      });
    }
    return { output: context.node.id };
  });
  const workflow = h.service.create({
    projectId: "p",
    name: "Scoped retry",
    nodes: [node("failed"), node("independent"), node("blocked"), node("tail")],
    edges: [
      { id: "fb", source: "failed", target: "blocked" },
      { id: "bt", source: "blocked", target: "tail" },
    ],
  });
  const first = await h.service.start(workflow.id, "parent", "Task");
  const failed = await terminal(h.service, first.id);
  const retried = await h.service.retry(first.id, "failed");
  const result = await terminal(h.service, retried.id);
  const rows = new Map(result.nodes.map((entry) => [entry.id, entry]));
  assert.equal(rows.get("failed")?.status, "done");
  assert.equal(rows.get("failed")?.attempt, 2);
  assert.equal(rows.get("blocked")?.status, "done");
  assert.equal(rows.get("tail")?.status, "done");
  assert.equal(rows.get("independent")?.status, "error");
  assert.equal(rows.get("independent")?.attempt, failed.nodes.find((entry) => entry.id === "independent")?.attempt);
  assert.deepEqual([...attempts.entries()].map(([id, count]) => `${id}:${count}`).sort(), [
    "blocked:1", "failed:2", "independent:1", "tail:1",
  ]);
});

test("retry admission keeps its durable running row when the start event fails", async () => {
  let starts = 0;
  const dir = mkdtempSync(join(tmpdir(), "polyth-workflow-retry-rollback-"));
  const file = join(dir, "workflows.json");
  const service = createWorkflowService({
    file,
    append: async (_sessionId, type) => {
      if (type === "workflow/run-started" && ++starts === 2)
        throw new Error("event store unavailable");
    },
    runNode: async () => {
      throw Object.assign(new Error("retryable"), {
        workflow: { retryable: true, phase: "runtime", sessionId: "child" },
      });
    },
  });
  const workflow = service.create({ projectId: "p", name: "Rollback", nodes: [node("a")], edges: [] });
  const original = await service.start(workflow.id, "parent", "Task");
  await terminal(service, original.id);
  await assert.rejects(
    () => service.retry(original.id, "a", "retry-failed"),
    /event store unavailable/,
  );
  assert.equal(service.listRuns("p").length, 2);
  const reloaded = createWorkflowService({ file, append: async () => {}, runNode: async () => ({ output: "ok" }) });
  assert.equal(reloaded.listRuns("p").length, 2);
  const recovered = await reloaded.retry(original.id, "a", "retry-failed");
  assert.equal(recovered.retryOf, original.id);
});

test("different retry operation keys cannot concurrently fork one failed run", async () => {
  let starts = 0;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const admitted = new Promise<void>((resolve) => { entered = resolve; });
  const events: Array<{ type: string; data: JsonObject }> = [];
  const file = join(mkdtempSync(join(tmpdir(), "polyth-workflow-retry-lock-")), "workflows.json");
  const service = createWorkflowService({
    file,
    append: async (_sessionId, type, data) => {
      events.push({ type, data });
      if (type === "workflow/run-started" && ++starts === 2) {
        entered();
        await gate;
      }
    },
    runNode: async (context) => {
      if ((context.attempt ?? 1) === 1)
        throw Object.assign(new Error("retryable"), {
          workflow: { retryable: true, phase: "runtime", sessionId: "child" },
        });
      return { output: context.node.id };
    },
  });
  const workflow = service.create({
    projectId: "p",
    name: "Retry lock",
    nodes: [node("a"), node("b")],
    edges: [],
  });
  const original = await service.start(workflow.id, "parent", "Task");
  await terminal(service, original.id);
  const first = service.retry(original.id, "a", "retry-a");
  await admitted;
  await assert.rejects(
    () => service.retry(original.id, "b", "retry-b"),
    (cause: unknown) => (cause as { code?: string }).code === "conflict",
  );
  release();
  const retried = await first;
  await terminal(service, retried.id);
});

test("retry lineage and metadata survive event replay and restart", async () => {
  const events: Array<{ type: string; data: JsonObject }> = [];
  const file = join(mkdtempSync(join(tmpdir(), "polyth-workflow-retry-lineage-")), "workflows.json");
  const service = createWorkflowService({
    file,
    append: async (_sessionId, type, data) => { events.push({ type, data }); },
    buildContext: async () => ({ conversation: "admitted context" }),
    runNode: async (context) => {
      if ((context.attempt ?? 1) === 1)
        throw Object.assign(new Error("retryable"), {
          workflow: { retryable: true, phase: "runtime", sessionId: "child" },
        });
      return { output: "retried" };
    },
  });
  const workflow = service.create({ projectId: "p", name: "Retry lineage", nodes: [node("a")], edges: [] });
  const original = await service.start(workflow.id, "parent", "Task", undefined, { context: "request" });
  await terminal(service, original.id);
  const retried = await service.retry(original.id, "a", "retry-metadata");
  await terminal(service, retried.id);

  const retryStarted = events.filter((event) => event.type === "workflow/run-started")[1]!;
  assert.equal(retryStarted.data.clientOperationId, "retry-metadata");
  assert.deepEqual(retryStarted.data.context, { conversation: "admitted context" });

  const reloaded = createWorkflowService({ file, append: async () => {}, runNode: async () => ({ output: "ok" }) });
  await assert.rejects(
    () => reloaded.retry(original.id, "a", "retry-again"),
    /latest lineage/,
  );
});

test("node progress publishes deltas: the prompt once, output as appended text, cleared fields as null", async () => {
  const h = harness(async (context, onUpdate) => {
    await onUpdate({ activity: "thinking", output: "Hello" });
    await onUpdate({ activity: "tool: bash" }); // activity-only: throttled by the 1 ms test clock
    await onUpdate({ sessionId: "child", activity: "thinking", output: "Hello world" });
    return { output: "Hello world!", sessionId: "child" };
  });
  const workflow = h.service.create({ projectId: "p", name: "Delta", nodes: [node("a")], edges: [] });
  const run = await terminal(h.service, (await h.service.start(workflow.id, "parent", "Task")).id);
  assert.equal(run.status, "done");
  const progress = h.events.filter((event) => event.type === "workflow/node-progress").map((event) => event.data);
  assert.ok(progress.length >= 3);
  const first = progress[0]!;
  assert.equal(first.partial, undefined, "the first publish of a node is a full snapshot");
  const firstNode = first.node as Record<string, unknown>;
  assert.equal(firstNode.status, "running");
  assert.match(String(firstNode.prompt), /Instructions for a/);
  for (const later of progress.slice(1)) {
    assert.equal(later.partial, true);
    const node = later.node as Record<string, unknown>;
    assert.equal(node.id, "a");
    assert.equal(typeof node.status, "string");
    assert.equal("prompt" in node, false, "the static prompt is never repeated");
  }
  const outputs: Array<{ full?: string; delta?: string }> = progress.flatMap((data): Array<{ full?: string; delta?: string }> => {
    const node = data.node as Record<string, unknown>;
    return typeof node.output === "string" ? [{ full: node.output }] : typeof data.outputDelta === "string" ? [{ delta: data.outputDelta }] : [];
  });
  // Replaying the deltas reproduces the final output exactly once each.
  let replayed = "";
  for (const entry of outputs) replayed = entry.full !== undefined ? entry.full : replayed + (entry.delta ?? "");
  assert.equal(replayed, "Hello world!");
  assert.ok(outputs.some((entry) => entry.delta !== undefined), "grown output travels as a delta");
  const last = progress.at(-1)!;
  assert.equal((last.node as Record<string, unknown>).status, "done");
  assert.equal((last.node as Record<string, unknown>).activity, null, "a cleared activity is published as null");
  assert.equal(run.nodes[0]?.activity, undefined);
  assert.equal(run.nodes[0]?.output, "Hello world!");

  // A reloaded process has no published snapshot: its first event is full again.
  const reloaded = harness(async (context, onUpdate) => {
    await onUpdate({ output: "again" });
    return { output: "again" };
  }, h.file);
  const second = await terminal(reloaded.service, (await reloaded.service.start(workflow.id, "parent", "Task 2")).id);
  assert.equal(second.status, "done");
  const firstAgain = reloaded.events.find((event) => event.type === "workflow/node-progress")!;
  assert.equal(firstAgain.data.partial, undefined);
  assert.match(String((firstAgain.data.node as Record<string, unknown>).prompt), /Instructions for a/);
});

test("concurrent progress updates of one node never repeat streamed output", async () => {
  const h = harness(async (context, onUpdate) => {
    await onUpdate({ sessionId: "c1", output: "a" });
    // Two durable updates in flight at once must diff against each other,
    // not both against the "a" snapshot ("b" + "bc" would replay as "abbc").
    await Promise.all([
      onUpdate({ sessionId: "c2", output: "ab" }),
      onUpdate({ sessionId: "c3", output: "abc" }),
    ]);
    return { output: "abc", sessionId: "c3" };
  });
  const workflow = h.service.create({ projectId: "p", name: "Race", nodes: [node("a")], edges: [] });
  const run = await terminal(h.service, (await h.service.start(workflow.id, "parent", "Task")).id);
  assert.equal(run.status, "done");
  let replayed = "";
  for (const event of h.events.filter((entry) => entry.type === "workflow/node-progress")) {
    const node = event.data.node as Record<string, unknown>;
    if (typeof node.output === "string") replayed = node.output;
    else if (typeof event.data.outputDelta === "string") replayed += event.data.outputDelta;
  }
  assert.equal(replayed, "abc");
});

// ---- Review loop ----------------------------------------------------------

type ScriptedCall = { id: string; round: number; resume?: string; prompt: string };
/** Scripts each unit's report by round; unscripted rounds approve/return ok. */
function scripted(reports: Record<string, string[]>, extra: Partial<WorkflowDeps> = {}) {
  const calls: ScriptedCall[] = [];
  const h = harness(async (context) => {
    const round = context.round ?? 1;
    calls.push({ id: context.node.id, round, prompt: context.prompt, ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}) });
    const output = reports[context.node.id]?.[round - 1] ?? `${context.node.id} ok (round ${round})`;
    return { sessionId: `s-${context.node.id}`, output };
  }, undefined, extra);
  return { ...h, calls };
}
/** Waits until the running run holds this review gate for a decision. */
async function held(service: WorkflowService, runId: string, nodeId: string): Promise<WorkflowRunDto> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const run = service.getRun(runId);
    if (run?.nodes.find((entry) => entry.id === nodeId)?.needsDecision) return run;
    if (run && run.status !== "running") throw new Error(`run settled without holding ${nodeId}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("workflow run was never held for a decision");
}
const reviewNode = (id: string, role = id) => ({ ...node(id, role), kind: "review" as const });
const workerNode = (id: string, role = id) => ({ ...node(id, role), kind: "worker" as const });

test("a review that requests changes sends the work back to its builder and re-reviews in the same sessions", async () => {
  const h = scripted({
    builder: ["Built v1.", "Replaced the box icon with the gallery glyph."],
    review: ["1. Gallery icon is still a box.\n\nVerdict: changes requested", "All findings resolved.\n\nVerdict: approved"],
  });
  const workflow = h.service.create({
    projectId: "p", name: "Build + Review",
    nodes: [workerNode("builder", "Builder"), reviewNode("review", "Reviewer")],
    edges: [{ id: "e", source: "builder", target: "review" }],
  });
  const run = await terminal(h.service, (await h.service.start(workflow.id, "parent", "Fix the icon")).id);

  assert.deepEqual(h.calls.map((call) => `${call.id}@${call.round}`), ["builder@1", "review@1", "builder@2", "review@2"]);
  assert.equal(h.calls[2]?.resume, "s-builder", "the builder continues in its own child session");
  assert.equal(h.calls[3]?.resume, "s-review", "so does the reviewer");
  assert.match(h.calls[2]!.prompt, /# Rework \(round 2\)[\s\S]*Gallery icon is still a box/);
  assert.doesNotMatch(h.calls[2]!.prompt, /# Role/, "a resumed unit is not re-briefed");
  assert.match(h.calls[3]!.prompt, /# Re-review \(round 2\)[\s\S]*Replaced the box icon/);
  assert.match(h.calls[1]!.prompt, /# Review verdict/, "the first review already knows it must end with a verdict");

  assert.equal(run.status, "done");
  const builder = run.nodes.find((entry) => entry.id === "builder")!;
  const review = run.nodes.find((entry) => entry.id === "review")!;
  assert.equal(builder.round, 2);
  assert.equal(builder.output, "Replaced the box icon with the gallery glyph.");
  assert.equal(review.round, 2);
  assert.equal(review.verdict, "approved");
  assert.equal(run.result, "All findings resolved.\n\nVerdict: approved");
  // The parent chat sees the loop in the node projection and in its context.
  const verdicts = h.events.filter((event) => event.type === "workflow/node-progress" && event.data.nodeId === "review")
    .map((event) => (event.data.node as { verdict?: unknown }).verdict).filter((value) => value !== undefined);
  assert.deepEqual(verdicts, ["changes-requested", null, "approved"], "the verdict is published, cleared for the re-review, then published again");
  const context = String(h.events.at(-1)?.data.text);
  assert.match(context, /- Builder: done \(round 2\)/);
  assert.match(context, /- Reviewer: done, approved \(round 2\)/);
  assert.doesNotMatch(context, /Review outcome/);
});

test("review rounds are bounded and an unresolved review stays visible to the parent", async () => {
  const changes = "Still wrong.\n\nVerdict: changes requested";
  const h = scripted({ review: [changes, changes, changes, changes] });
  const workflow = h.service.create({
    projectId: "p", name: "Stubborn review",
    nodes: [workerNode("builder", "Builder"), reviewNode("review", "Reviewer"), workerNode("finalize", "Finalizer")],
    edges: [{ id: "a", source: "builder", target: "review" }, { id: "b", source: "review", target: "finalize" }],
  });
  const started = await h.service.start(workflow.id, "parent", "Task", { reviewRounds: 1 });
  // The rounds are spent: the run holds the gate instead of moving on.
  await held(h.service, started.id, "review");
  await h.service.decide(started.id, { nodeId: "review", action: "accept" });
  const run = await terminal(h.service, started.id);
  assert.deepEqual(h.calls.map((call) => `${call.id}@${call.round}`), ["builder@1", "review@1", "builder@2", "review@2", "finalize@1"]);
  assert.equal(run.status, "done");
  assert.equal(run.nodes.find((entry) => entry.id === "review")?.verdict, "changes-requested");
  assert.equal(run.options?.reviewRounds, 1);
  const context = String(h.events.at(-1)?.data.text);
  assert.match(context, /Review outcome: Reviewer still requested changes after the allowed rework rounds/);
  assert.match(context, /- Reviewer: done, changes requested \(round 2\)/);
  await assert.rejects(h.service.start(workflow.id, "parent", "Task", { reviewRounds: 6 }), /reviewRounds/);
});

test("zero review rounds and a review without executors before it never loop", async () => {
  const changes = "Verdict: changes requested";
  const off = scripted({ review: [changes] });
  const linear = off.service.create({
    projectId: "p", name: "No loop",
    nodes: [workerNode("builder"), reviewNode("review")],
    edges: [{ id: "e", source: "builder", target: "review" }],
  });
  await terminal(off.service, (await off.service.start(linear.id, "parent", "Task", { reviewRounds: 0 })).id);
  assert.deepEqual(off.calls.map((call) => call.id), ["builder", "review"]);

  const reviewsOnly = scripted({ reviewer: [changes], verify: [changes] });
  const chain = reviewsOnly.service.create({
    projectId: "p", name: "Review preset",
    nodes: [reviewNode("reviewer"), reviewNode("verify")],
    edges: [{ id: "e", source: "reviewer", target: "verify" }],
  });
  const run = await terminal(reviewsOnly.service, (await reviewsOnly.service.start(chain.id, "parent", "Task")).id);
  assert.deepEqual(reviewsOnly.calls.map((call) => call.id), ["reviewer", "verify"], "a review cannot rework another review");
  assert.equal(run.status, "done");
});

test("a sibling verifier re-runs on the reworked output before the next stage starts", async () => {
  const h = scripted({
    review: ["Missing test.\n\nVerdict: changes requested", "Verdict: approved"],
    verify: ["Verdict: approved", "Verdict: approved"],
  });
  const workflow = h.service.create({
    projectId: "p", name: "Build, review, verify, finalize",
    nodes: [workerNode("implement", "Builder"), reviewNode("review", "Reviewer"), reviewNode("verify", "Verifier"), workerNode("finalize", "Finalizer")],
    edges: [
      { id: "a", source: "implement", target: "review" },
      { id: "b", source: "implement", target: "verify" },
      { id: "c", source: "review", target: "finalize" },
      { id: "d", source: "verify", target: "finalize" },
    ],
  });
  const run = await terminal(h.service, (await h.service.start(workflow.id, "parent", "Task", { maxParallel: 1 })).id);
  assert.deepEqual(
    h.calls.map((call) => `${call.id}@${call.round}`),
    ["implement@1", "review@1", "verify@1", "implement@2", "review@2", "verify@2", "finalize@1"],
    "the verifier already consumed the old implementation, so it re-runs too; the finalizer waits",
  );
  assert.match(h.calls[5]!.prompt, /# Re-review \(round 2\)/);
  assert.equal(run.status, "done");
  assert.equal(run.nodes.find((entry) => entry.id === "verify")?.round, 2);
  assert.equal(run.nodes.find((entry) => entry.id === "finalize")?.round, 1);
});

test("a failed rework blocks the re-review instead of approving stale work", async () => {
  const calls: string[] = [];
  const h = harness(async (context) => {
    calls.push(`${context.node.id}@${context.round ?? 1}`);
    if (context.node.id === "builder" && context.round === 2) throw new Error("provider exploded");
    return { sessionId: `s-${context.node.id}`, output: context.node.id === "review" ? "Verdict: changes requested" : "built" };
  });
  const workflow = h.service.create({
    projectId: "p", name: "Failing rework",
    nodes: [workerNode("builder"), reviewNode("review")],
    edges: [{ id: "e", source: "builder", target: "review" }],
  });
  const run = await terminal(h.service, (await h.service.start(workflow.id, "parent", "Task")).id);
  assert.deepEqual(calls, ["builder@1", "review@1", "builder@2"]);
  assert.equal(run.status, "error");
  assert.equal(run.nodes.find((entry) => entry.id === "builder")?.status, "error");
  assert.equal(run.nodes.find((entry) => entry.id === "review")?.status, "skipped");
});

// ---- A person fixes a unit while the run holds it --------------------------

const refused = (modelID?: string) => Object.assign(
  new Error(`${modelID ?? "the default model"} is not available on this engine. Pick a model from the list.`),
  { workflow: { retryable: true, phase: "pre-admission" } },
);
async function heldUnit(service: WorkflowService, runId: string, nodeId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = service.getRun(runId)?.nodes.find((entry) => entry.id === nodeId);
    if (row?.needsFix) return row;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`unit ${nodeId} was not held for a fix`);
}
const good: ModelRef = { providerID: "openai", modelID: "gpt-good" };

test("a unit refused before admission holds the run; its fix continues the same run and can be saved to the template", async () => {
  const seen: string[] = [];
  const h = harness(async (context) => {
    seen.push(`${context.node.id}:${context.node.model?.modelID ?? "-"}`);
    if (context.node.model?.modelID === "gpt-gone") throw refused("gpt-gone");
    return { output: `${context.node.id} done` };
  });
  const workflow = h.service.create({
    projectId: "p",
    name: "Build & Review",
    nodes: [
      { ...node("scout", "Codebase Scout"), model: { providerID: "openai", modelID: "gpt-gone" } },
      node("builder", "Builder"),
    ],
    edges: [{ id: "sb", source: "scout", target: "builder" }],
  });
  const started = await h.service.start(workflow.id, "parent", "Task");
  const held = await heldUnit(h.service, started.id, "scout");
  assert.equal(held.status, "error");
  assert.equal(held.retryable, true);
  assert.match(held.error ?? "", /not available on this engine/);
  const holding = h.service.getRun(started.id)!;
  assert.equal(holding.status, "running", "the run waits instead of failing");
  assert.equal(holding.nodes.find((entry) => entry.id === "builder")?.status, "queued", "nothing after it was skipped");

  const fixed = await h.service.retry(started.id, "scout", "fix-1", { model: good }, undefined, { saveToWorkflow: true });
  assert.equal(fixed.id, started.id, "the fix continues the same run, not a fork");
  assert.equal(fixed.nodes.find((entry) => entry.id === "scout")?.needsFix, undefined);
  const run = await terminal(h.service, started.id);
  assert.equal(run.status, "done");
  const scout = run.nodes.find((entry) => entry.id === "scout")!;
  assert.deepEqual(scout.model, good);
  assert.equal(scout.attempt, 2);
  assert.deepEqual(seen, ["scout:gpt-gone", "scout:gpt-good", "builder:-"]);
  assert.deepEqual(run.definition?.nodes.find((entry) => entry.id === "scout")?.model, good);
  assert.equal([...h.service.listRuns("p")].length, 1, "no retry fork was created");

  const template = h.service.get(workflow.id)!;
  assert.deepEqual(template.nodes.find((entry) => entry.id === "scout")?.model, good, "later runs use the fix");
  assert.equal(template.revision, (workflow.revision ?? 0) + 1);
  const again = await h.service.retry(started.id, "scout", "fix-1", { model: good }, undefined, { saveToWorkflow: true });
  assert.equal(again.id, started.id, "a repeated request after a lost response changes nothing");
  await assert.rejects(
    () => h.service.retry(started.id, "scout", "fix-1", { model: { providerID: "x", modelID: "other" } }),
    /already used for a different retry/,
  );
});

test("a fix that is not saved leaves the template untouched", async () => {
  const h = harness(async (context) => {
    if (context.node.model?.modelID === "gpt-gone") throw refused("gpt-gone");
    return { output: "ok" };
  });
  const workflow = h.service.create({
    projectId: "p",
    name: "Once",
    nodes: [{ ...node("only"), model: { providerID: "openai", modelID: "gpt-gone" } }],
    edges: [],
  });
  const started = await h.service.start(workflow.id, "parent", "Task");
  await heldUnit(h.service, started.id, "only");
  await h.service.retry(started.id, "only", undefined, { model: good });
  assert.equal((await terminal(h.service, started.id)).status, "done");
  assert.deepEqual(h.service.get(workflow.id)!.nodes[0]!.model, { providerID: "openai", modelID: "gpt-gone" });
});

test("a fix saved to a bundled template becomes this project's route for that unit", async () => {
  const preset = workflowPresets("p").find((entry) => entry.preset?.id === "build-review")!;
  const file = join(mkdtempSync(join(tmpdir(), "polyth-workflow-routes-")), "workflows.json");
  const make = () => createWorkflowService({
    file,
    append: async () => {},
    builtin: (id) => (id === preset.id ? structuredClone(preset) : null),
    runNode: async (context) => {
      if (context.node.id === "builder" && context.node.model?.modelID !== "gpt-good") throw refused(context.node.model?.modelID);
      return { output: "Verdict: approved" };
    },
  });
  const service = make();
  const started = await service.start(preset.id, "parent", "Task");
  await heldUnit(service, started.id, "builder");
  await service.retry(started.id, "builder", undefined, { model: good }, undefined, { saveToWorkflow: true });
  assert.equal((await terminal(service, started.id)).status, "done");
  assert.equal(service.get(preset.id), null, "the bundled template is not copied into the store");
  assert.deepEqual(service.withRoutes(preset).nodes.find((entry) => entry.id === "builder")?.model, good);
  assert.equal(service.withRoutes(preset).nodes.find((entry) => entry.id === "builder")?.prompt,
    preset.nodes.find((entry) => entry.id === "builder")?.prompt, "only the route changes");

  const reloaded = make();
  const next = await reloaded.start(preset.id, "parent", "Next task");
  const result = await terminal(reloaded, next.id);
  assert.equal(result.status, "done", "the next run starts on the saved route without holding");
  assert.deepEqual(result.nodes.find((entry) => entry.id === "builder")?.model, good);
});

test("stopping a held run releases the unit, which stays retryable after the run settles", async () => {
  const h = harness(async (context) => {
    if (context.node.model?.modelID === "gpt-gone") throw refused("gpt-gone");
    return { output: "ok" };
  });
  const workflow = h.service.create({
    projectId: "p",
    name: "Stop while held",
    nodes: [{ ...node("only"), model: { providerID: "openai", modelID: "gpt-gone" } }, node("after")],
    edges: [{ id: "oa", source: "only", target: "after" }],
  });
  const started = await h.service.start(workflow.id, "parent", "Task");
  await heldUnit(h.service, started.id, "only");
  const stopped = await h.service.stop(started.id);
  assert.equal(stopped.status, "stopped");
  const only = stopped.nodes.find((entry) => entry.id === "only")!;
  assert.equal(only.needsFix, undefined, "no fix is pending once the run stopped");
  assert.equal(only.retryable, true);
  const fork = await h.service.retry(started.id, "only", undefined, { model: good });
  assert.notEqual(fork.id, started.id, "a settled run forks as before");
  assert.equal((await terminal(h.service, fork.id)).status, "done");
});

test("only the person who started a run can fix it while it runs", async () => {
  const h = harness(async (context) => {
    if (context.node.model?.modelID === "gpt-gone") throw refused("gpt-gone");
    return { output: "ok" };
  });
  const workflow = h.service.create({
    projectId: "p",
    name: "Someone else's run",
    nodes: [{ ...node("only"), model: { providerID: "openai", modelID: "gpt-gone" } }],
    edges: [],
  });
  const started = await h.service.start(workflow.id, "parent", "Task", undefined, undefined, "alice");
  await heldUnit(h.service, started.id, "only");
  await assert.rejects(() => h.service.retry(started.id, "only", undefined, { model: good }, "bob"), /only the person who started this run/);
  await assert.rejects(() => h.service.retry(started.id, "only", undefined, { model: "nope" as never }, "alice"), /invalid replacement model/);
  await h.service.retry(started.id, "only", undefined, { model: good }, "alice");
  assert.equal((await terminal(h.service, started.id)).status, "done");
});

test("a failure after admission still fails the run without holding it", async () => {
  const h = harness(async () => {
    throw Object.assign(new Error("turn failed"), { workflow: { retryable: false, phase: "runtime", sessionId: "child" } });
  });
  const workflow = h.service.create({ projectId: "p", name: "Runtime failure", nodes: [node("only")], edges: [] });
  const started = await h.service.start(workflow.id, "parent", "Task");
  const run = await terminal(h.service, started.id);
  assert.equal(run.status, "error");
  assert.equal(run.nodes[0]!.needsFix, undefined);
});

test("a restart drops a pending fix with the run it belonged to", () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-workflow-held-restart-")), "workflows.json");
  writeFileSync(file, JSON.stringify({
    v: 1,
    workflows: [],
    runs: [{ id: "r", workflowId: "w", status: "running", startedAt: 1, layers: [["n"]],
      nodes: [{ id: "n", role: "N", status: "error", retryable: true, needsFix: true }] }],
  }));
  const service = createWorkflowService({ file, append: async () => {}, runNode: async () => ({ output: "ok" }) });
  const node = service.getRun("r")!.nodes[0]!;
  assert.equal(node.needsFix, undefined);
  assert.equal(node.status, "stopped");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, WorkflowNodeDto, WorkflowRunDto } from "@polyth/contracts";
import {
  createWorkflowService,
  type RunNodeFn,
  type WorkflowDeps,
  type WorkflowNodeRoute,
  type WorkflowRunAttention,
  type WorkflowService,
} from "../src/index.ts";
import { MAX_UNIT_FACTS, buildNodePrompt, mergeFacts, parseFacts } from "../src/prompt.ts";

interface Harness {
  events: Array<{ sessionId: string; type: string; data: JsonObject }>;
  service: WorkflowService;
}

function harness(runNode: RunNodeFn, extra: Partial<WorkflowDeps> = {}): Harness {
  const events: Harness["events"] = [];
  let clock = 1_000;
  const service = createWorkflowService({
    file: join(mkdtempSync(join(tmpdir(), "polyth-workflow-routing-")), "workflows.json"),
    append: async (sessionId, type, data) => {
      events.push({ sessionId, type, data });
    },
    runNode,
    now: () => clock++,
    ...extra,
  });
  return { events, service };
}

async function settled(service: WorkflowService, id: string): Promise<WorkflowRunDto> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const run = service.getRun(id);
    if (run && run.status !== "running") return run;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("workflow run did not settle");
}

async function until<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

const unit = (id: string, extra: Partial<WorkflowNodeDto> = {}): WorkflowNodeDto =>
  ({ id, role: id, prompt: `Instructions for ${id}`, ...extra });
const route = (harnessId: string, modelID: string): WorkflowNodeRoute =>
  ({ harness: { mode: "pinned", harnessId }, model: { providerID: "p", modelID } });
const keyOf = (value: WorkflowNodeRoute): string =>
  `${value.harness?.mode === "pinned" ? value.harness.harnessId : ""}::${value.model ? `${value.model.providerID}/${value.model.modelID}` : ""}`;
const refused = (message: string) =>
  Object.assign(new Error(message), { workflow: { retryable: true, phase: "pre-admission" } });
const ranOn = (node: WorkflowNodeDto): string => keyOf({ ...(node.harness ? { harness: node.harness } : {}), ...(node.model ? { model: node.model } : {}) });

test("a unit with a routing role runs on the launcher's model for that role and shows it", async () => {
  const seen: string[] = [];
  const asked: Array<{ role: string; launchedBy: string }> = [];
  const { service } = harness(async (context) => {
    seen.push(ranOn(context.node));
    return { sessionId: `child-${context.node.id}`, output: "done" };
  }, {
    routeFor: async (role, context) => {
      asked.push({ role, launchedBy: context.launchedBy });
      return role === "implement" ? route("mid", "sonnet") : undefined;
    },
  });
  const workflow = service.create({
    projectId: "p", name: "Roles",
    nodes: [
      unit("build", { routingRole: "implement", ...route("big", "opus") }),
      unit("plain", route("big", "opus")),
    ],
    edges: [],
  });
  const run = await settled(service, (await service.start(workflow.id, "chat", "task", undefined, undefined, "usr_a")).id);
  assert.equal(run.status, "done");
  assert.deepEqual(seen.sort(), ["big::p/opus", "mid::p/sonnet"]);
  assert.deepEqual(asked, [{ role: "implement", launchedBy: "usr_a" }]);
  const built = run.nodes.find((node) => node.id === "build")!;
  assert.equal(built.routedRole, "implement");
  assert.equal(built.model?.modelID, "sonnet");
  assert.equal(run.nodes.find((node) => node.id === "plain")!.routedRole, undefined);
});

test("a run without a person, and a role with no usable model, keep the unit's own route", async () => {
  const seen: string[] = [];
  let asked = 0;
  const { service } = harness(async (context) => {
    seen.push(ranOn(context.node));
    return { output: "done" };
  }, { routeFor: async () => { asked++; return undefined; } });
  const workflow = service.create({
    projectId: "p", name: "Fallback",
    nodes: [unit("build", { routingRole: "implement", ...route("own", "local") })], edges: [],
  });
  await settled(service, (await service.start(workflow.id, "chat", "task")).id);
  assert.equal(asked, 0, "system work has no person whose policy could apply");
  const run = await settled(service, (await service.start(workflow.id, "chat", "task again", undefined, undefined, "usr_a")).id);
  assert.equal(asked, 1);
  assert.deepEqual(seen, ["own::p/local", "own::p/local"]);
  assert.equal(run.nodes[0]!.routedRole, undefined);
});

test("a role model refused before the unit starts moves to the next one, then to the unit's own route", async () => {
  const chain = [route("a", "first"), route("b", "second")];
  const seen: string[] = [];
  const { service } = harness(async (context) => {
    const key = ranOn(context.node);
    seen.push(key);
    if (key !== "own::p/local") throw refused(`${key} is not available`);
    return { output: "done" };
  }, {
    routeFor: async (_role, context) => chain.find((entry) => !context.exclude.includes(keyOf(entry))),
  });
  const workflow = service.create({
    projectId: "p", name: "Chain",
    nodes: [unit("build", { routingRole: "implement", ...route("own", "local") })], edges: [],
  });
  const run = await settled(service, (await service.start(workflow.id, "chat", "task", undefined, undefined, "usr_a")).id);
  assert.deepEqual(seen, ["a::p/first", "b::p/second", "own::p/local"]);
  assert.equal(run.status, "done");
  assert.equal(run.nodes[0]!.routedRole, undefined, "the row names the route that finally ran");
  assert.equal(run.nodes[0]!.model?.modelID, "local");
});

test("when every route of a role-routed unit is refused the run holds it for a fix exactly once", async () => {
  const seen: string[] = [];
  const notices: WorkflowRunAttention[] = [];
  const { service } = harness(async (context) => {
    seen.push(ranOn(context.node));
    throw refused("nothing runs here");
  }, {
    routeFor: async (_role, context) => [route("a", "first")].find((entry) => !context.exclude.includes(keyOf(entry))),
    onRunAttention: (event) => notices.push(event),
  });
  const workflow = service.create({
    projectId: "p", name: "Held",
    nodes: [unit("build", { routingRole: "implement", ...route("own", "local") })], edges: [],
  });
  const started = await service.start(workflow.id, "chat", "task", undefined, { wake: true }, "usr_a");
  await until(() => service.getRun(started.id)?.nodes[0]?.needsFix ? true : undefined);
  assert.deepEqual(seen, ["a::p/first", "own::p/local"]);
  assert.deepEqual(notices.map((event) => event.kind), ["needs-fix"]);
  assert.match(notices[0]!.text, /unit build .* could not start: nothing runs here/);
  assert.equal(notices[0]!.launchedBy, "usr_a");
  await service.stop(started.id, { quiet: true });
  assert.deepEqual(notices.map((event) => event.kind), ["needs-fix"], "a quiet stop sends no wake");
});

test("a run started with wake tells the parent chat once when it settles; other runs stay silent", async () => {
  const notices: WorkflowRunAttention[] = [];
  const { service, events } = harness(async () => ({ output: "done" }), { onRunAttention: (event) => notices.push(event) });
  const workflow = service.create({ projectId: "p", name: "Wake", nodes: [unit("only")], edges: [] });
  await settled(service, (await service.start(workflow.id, "chat", "silent")).id);
  assert.equal(notices.length, 0);
  const run = await settled(service, (await service.start(workflow.id, "chat", "loud", undefined, { wake: true }, "usr_a")).id);
  assert.equal(run.wake, true);
  assert.deepEqual(notices.map((event) => [event.kind, event.runId, event.parentSessionId]), [["settled", run.id, "chat"]]);
  // Clients fold runs from events, so the card learns from the start event
  // that the chat's agent steers this run.
  const starts = events.filter((entry) => entry.type === "workflow/run-started");
  assert.deepEqual(starts.map((entry) => entry.data.wake), [undefined, true]);
  assert.match(notices[0]!.text, /finished\. .*record "outcome"/);
});

test("located facts travel from the launcher and each unit to the units after it, once", async () => {
  const prompts = new Map<string, string>();
  const { service } = harness(async (context) => {
    prompts.set(context.node.id, context.prompt);
    return {
      output: context.node.id === "scout"
        ? "Mapped the module.\n\n# Located facts\n- src/app/run.ts:42 — start() admits a run\n- just an opinion, no location\n- `src/app/run.ts:90-120` — the retry fork\n"
        : "Built it.",
    };
  });
  const workflow = service.create({
    projectId: "p", name: "Facts",
    nodes: [unit("scout"), unit("build")],
    edges: [{ id: "scout-build", source: "scout", target: "build" }],
  });
  const run = await settled(service, (await service.start(workflow.id, "chat", "task", undefined, {
    facts: ["docs/contract.md:7 — the DTO is frozen", "  docs/contract.md:7 — the DTO is frozen  "],
  })).id);
  assert.deepEqual(run.facts, [
    "docs/contract.md:7 — the DTO is frozen",
    "src/app/run.ts:42 — start() admits a run",
    "src/app/run.ts:90-120 — the retry fork",
  ]);
  const scout = prompts.get("scout")!;
  assert.match(scout, /# Located facts so far\n\n[^\n]+Do not search for them again[^\n]+\n\n- docs\/contract\.md:7 — the DTO is frozen/);
  assert.doesNotMatch(scout, /run\.ts:42/);
  const build = prompts.get("build")!;
  assert.equal(build.split("src/app/run.ts:42 — start() admits a run").length - 1, 1, "the upstream report does not repeat the map");
  assert.match(build, /## scout \(scout\)\n\nMapped the module\./);
  assert.doesNotMatch(build, /just an opinion/);
});

test("parseFacts keeps only located lines, stops at a verdict or heading, and is bounded", () => {
  const many = Array.from({ length: MAX_UNIT_FACTS + 5 }, (_, index) => `- a/b.ts:${index + 1} — fact ${index + 1}`).join("\n");
  const parsed = parseFacts(`Report.\n\n## Located facts\n${many}\nVerdict: approved`);
  assert.equal(parsed.facts.length, MAX_UNIT_FACTS);
  assert.equal(parsed.rest, "Report.\n\nVerdict: approved");
  assert.deepEqual(parseFacts("# Located facts\n- a.ts:1 — x\n# Next\n- b.ts:2 — y").facts, ["a.ts:1 — x"]);
  assert.deepEqual(parseFacts("- a.ts:1 — outside any section").facts, []);
  assert.deepEqual(mergeFacts(["a.ts:1 — x"], ["a.ts:1 — x", "b.ts:2 — y"]), ["a.ts:1 — x", "b.ts:2 — y"]);
});

test("facts serve any project: files without a line, folders and web sources count, and the heading may be written loosely", () => {
  const report = [
    "Звіт українською.",
    "",
    "**Located facts:**",
    "- https://example.org/spec#limits — the limit is 40 requests a minute",
    "- docs/pricing.md — the current price table",
    "- notes/2026/ — interview notes by date",
    "- config/home.yaml:12-30 - the morning automation",
    "- Важлива думка без посилання",
    "- README — no extension and no folder, so not a location",
  ].join("\n");
  assert.deepEqual(parseFacts(report).facts, [
    "https://example.org/spec#limits — the limit is 40 requests a minute",
    "docs/pricing.md — the current price table",
    "notes/2026/ — interview notes by date",
    "config/home.yaml:12-30 - the morning automation",
  ]);
  assert.equal(parseFacts(report).rest, "Звіт українською.");
  assert.deepEqual(parseFacts("Located facts\n- a/b.ts:3 — x").facts, ["a/b.ts:3 — x"]);
  assert.match(buildNodePrompt(unit("only"), "task"), /this exact English heading/);
});

test("a request-only launch does not repeat the input as conversation context", () => {
  const prompt = buildNodePrompt(unit("only"), "Ship it", [], { conversation: "User: Ship it" });
  assert.doesNotMatch(prompt, /Parent conversation context/);
  assert.match(buildNodePrompt(unit("only"), "Ship it", [], { conversation: "User: earlier\nUser: Ship it" }), /Parent conversation context/);
});

test("an outcome is recorded only for a settled run, only by its launcher, and counted per template", async () => {
  let release: (() => void) | undefined;
  const { service, events } = harness(async (context) => {
    if (context.prompt.includes("hold")) await new Promise<void>((resolve) => { release = resolve; });
    return { output: "done" };
  });
  const workflow = service.create({ projectId: "p", name: "Outcome", nodes: [unit("only")], edges: [] });
  const running = await service.start(workflow.id, "chat", "hold", undefined, undefined, "usr_a");
  await assert.rejects(service.recordOutcome(running.id, { value: "accepted" }, "usr_a"), /still running/);
  await until(() => release);
  release!();
  await settled(service, running.id);
  await assert.rejects(service.recordOutcome(running.id, { value: "accepted" }, "usr_b"), /only the person who started this run/);
  await assert.rejects(service.recordOutcome(running.id, { value: "fine" as never }, "usr_a"), /value must be one of/);
  await assert.rejects(service.recordOutcome("missing", { value: "accepted" }, "usr_a"), /not found/);
  const recorded = await service.recordOutcome(running.id, { value: "reworked", note: "  fixed two\n tests  " }, "usr_a", "agent");
  assert.deepEqual({ ...recorded.outcome, at: 0 }, { value: "reworked", note: "fixed two tests", at: 0, by: "agent" });
  const event = events.find((entry) => entry.type === "workflow/run-outcome")!;
  assert.equal(event.sessionId, "chat");
  assert.equal((event.data.outcome as JsonObject).value, "reworked");
  assert.equal(JSON.stringify(event.data).includes("usr_a"), false, "the event names no person");

  const second = await settled(service, (await service.start(workflow.id, "chat", "again", undefined, undefined, "usr_a")).id);
  assert.deepEqual(service.outcomes("p"), [{
    workflowId: workflow.id, name: "Outcome",
    runs: 2, done: 2, error: 0, stopped: 0,
    accepted: 0, reworked: 1, discarded: 0, unrecorded: 1,
    units: 2, reworkedUnits: 0,
  }]);
  assert.deepEqual(service.outcomes("other"), []);
  assert.equal(second.outcome, undefined);
});

test("a routing role must be a role id", () => {
  const { service } = harness(async () => ({ output: "done" }));
  assert.throws(() => service.create({
    projectId: "p", name: "Bad", nodes: [unit("only", { routingRole: "Not A Role" })], edges: [],
  }), /routingRole is invalid for node only/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, SessionProjection, SpaceContext, ToolExecutionContext, WorkflowRunDto } from "@polyth/contracts";
import { createWorkflowService, type RunNodeContext, type WorkflowRunAttention, type WorkflowService } from "../src/index.ts";
import { getWorkflowPreset } from "../src/presets.ts";
import { WORKFLOW_MANAGE_TOOL_NAME, WORKFLOW_TOOL_NAME, createWorkflowTools, workflowSkill } from "../src/agentTool.ts";

const SPACE = "spc_a";
const person = (userId: string, role = "owner"): SpaceContext => ({ spaceId: SPACE, userId, role }) as unknown as SpaceContext;
const chat = (id: string, projectId = "p", extra: Partial<SessionProjection> = {}): SessionProjection =>
  ({ id, projectId, spaceId: SPACE, ...extra }) as unknown as SessionProjection;

interface Rig {
  service: WorkflowService;
  units: RunNodeContext[];
  notices: WorkflowRunAttention[];
  run(input: JsonObject, ctx?: Partial<ToolExecutionContext>): Promise<string>;
  manage(input: JsonObject, ctx?: Partial<ToolExecutionContext>): Promise<string>;
  tools: ReturnType<typeof createWorkflowTools>;
  /** Units of prompts containing "hold" wait until this is called. */
  release(): void;
}

function rig(options: { viewer?: string; fail?: (context: RunNodeContext) => Error | undefined } = {}): Rig {
  const units: RunNodeContext[] = [];
  const notices: WorkflowRunAttention[] = [];
  const waiting: Array<() => void> = [];
  let clock = 1_000;
  const service = createWorkflowService({
    file: join(mkdtempSync(join(tmpdir(), "polyth-workflow-tool-")), "workflows.json"),
    append: async () => undefined,
    builtin: (id) => getWorkflowPreset(id),
    now: () => clock++,
    onRunAttention: (event) => notices.push(event),
    runNode: async (context) => {
      units.push(context);
      const failure = options.fail?.(context);
      if (failure) throw failure;
      if (context.prompt.includes("hold"))
        await new Promise<void>((resolve, reject) => {
          waiting.push(resolve);
          context.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      return { sessionId: `child-${context.node.id}`, output: `Report of ${context.node.id}.\nVerdict: approved` };
    },
  });
  const chats = new Map<string, SessionProjection>([
    ["chat-a", chat("chat-a", "p", { model: { providerID: "anthropic", modelID: "opus" }, resolvedHarnessId: "claude" })],
    ["chat-b", chat("chat-b")],
    ["chat-other", chat("chat-other", "other")],
  ]);
  const tools = createWorkflowTools({
    service: async () => service,
    personSpace: (userId) => userId === "usr_gone" ? undefined : person(userId, userId === options.viewer ? "viewer" : "owner"),
    systemSpace: () => person("system:workflow"),
    session: async (_space, sessionId) => chats.get(sessionId),
  });
  const context = (ctx: Partial<ToolExecutionContext> = {}): ToolExecutionContext =>
    ({ sessionId: "chat-a", projectId: "p", cwd: "/tmp", spaceId: SPACE, actorUserId: "usr_a", ...ctx });
  return {
    service, units, notices, tools,
    run: async (input, ctx) => (await tools.run.execute!(input, context(ctx))).output,
    manage: async (input, ctx) => (await tools.manage.execute!(input, context(ctx))).output,
    release: () => { for (const resolve of waiting.splice(0)) resolve(); },
  };
}

async function settled(service: WorkflowService, id: string): Promise<WorkflowRunDto> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const run = service.getRun(id);
    if (run && run.status !== "running") return run;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("workflow run did not settle");
}
const runIdOf = (output: string): string => /as run ([0-9a-f-]{36})/.exec(output)![1]!;

test("only the run tool is approved by the package; changing templates and deciding a gate follow the chat's approvals", () => {
  const { tools } = rig();
  assert.equal(tools.run.descriptor.kind === "tool" && tools.run.descriptor.name, WORKFLOW_TOOL_NAME);
  assert.equal(tools.manage.descriptor.kind === "tool" && tools.manage.descriptor.name, WORKFLOW_MANAGE_TOOL_NAME);
  assert.equal(typeof tools.run.autoApprove, "function");
  assert.equal(tools.manage.autoApprove, undefined);
  assert.equal(workflowSkill.descriptor.kind, "skill");
});

test("templates lists the project's bundled and saved templates with their routing roles", async () => {
  const tool = rig();
  tool.service.create({ projectId: "p", name: "Mine", nodes: [{ id: "only", role: "Only", prompt: "Do it" }], edges: [] });
  tool.service.create({ projectId: "other", name: "Foreign", nodes: [{ id: "only", role: "Only", prompt: "Do it" }], edges: [] });
  const listed = await tool.run({ action: "templates" });
  assert.match(listed, /^8 workflow templates \(id · name · stages\)/);
  assert.match(listed, /\n- build-review · Build \+ Review · Builder → Reviewer\n/);
  assert.match(listed, / · Mine · Only · saved r0$/);
  assert.ok(listed.length < 700, `the listing stays one line per template (${listed.length} chars)`);
  assert.doesNotMatch(listed, /Foreign/);
  // A template is also found by its name, as long as the name is unique.
  const byName = await tool.run({ action: "template", workflowId: "build + review" });
  assert.match(byName, /"id":"build-review"/);
  // Prompts are previews unless the whole text is asked for.
  assert.match(byName, /…"/);
  assert.match(byName, /Prompts are clipped; pass full/);
  const whole = await tool.run({ action: "template", workflowId: "build-review", full: true });
  assert.doesNotMatch(whole, /Prompts are clipped/);
  assert.ok(whole.length > byName.length);
  tool.service.create({ projectId: "p", name: "mine", nodes: [{ id: "only", role: "Only", prompt: "Do it" }], edges: [] });
  await assert.rejects(tool.run({ action: "template", workflowId: "Mine" }), /No workflow template/, "two templates share the name");
  const one = JSON.parse(await tool.run({ action: "template", workflowId: "build-review", full: true })) as { nodes: Array<{ id: string; after: string[]; routingRole?: string }> };
  assert.deepEqual(one.nodes.map((node) => [node.id, node.after, node.routingRole]), [["builder", [], "implement"], ["review", ["builder"], "review"]]);
});

test("run starts a template on the calling chat for the turn's person, at the chat's own approval level", async () => {
  const tool = rig();
  const auto = tool.service.create({
    projectId: "p", name: "Auto", nodes: [{ id: "only", role: "Only", prompt: "Do it" }], edges: [],
    defaults: { permissions: "auto" },
  });
  const output = await tool.run({
    action: "run", workflowId: auto.id, input: "Add the flag",
    facts: ["src/flags.ts:12 — flags are read here", 7 as never, "  "],
  });
  assert.match(output, /End your turn now/);
  const run = await settled(tool.service, runIdOf(output));
  assert.equal(run.parentSessionId, "chat-a");
  assert.equal(run.options?.permissions, "manual", "an agent never starts units that approve more than its chat");
  assert.deepEqual(run.facts, ["src/flags.ts:12 — flags are read here"]);
  assert.equal(run.wake, true);
  assert.equal(tool.units[0]!.launchedBy, "usr_a");
  assert.deepEqual(tool.units[0]!.node.model, { providerID: "anthropic", modelID: "opus" }, "an unassigned unit inherits the chat route");
  assert.deepEqual(tool.units[0]!.node.harness, { mode: "pinned", harnessId: "claude" });
  assert.doesNotMatch(tool.units[0]!.prompt, /Parent conversation context/);
  assert.deepEqual(tool.notices.map((event) => event.kind), ["settled"]);
});

test("a chat reaches only its own runs, and never another project's template", async () => {
  const tool = rig();
  const foreign = tool.service.create({ projectId: "other", name: "Foreign", nodes: [{ id: "only", role: "Only", prompt: "Do it" }], edges: [] });
  await assert.rejects(tool.run({ action: "run", workflowId: foreign.id, input: "x" }), /No workflow template/);
  await assert.rejects(tool.run({ action: "template", workflowId: `preset:other:build-review` }), /No workflow template/);
  const mine = runIdOf(await tool.run({ action: "run", workflowId: "review", input: "Check the diff", wake: false }));
  await settled(tool.service, mine);
  assert.match(await tool.run({ action: "runs" }), new RegExp(`- ${mine} · “Review” · done · outcome not recorded`));
  assert.equal(await tool.run({ action: "runs" }, { sessionId: "chat-b" }), "This chat has started no workflow runs.");
  for (const action of ["status", "output", "stop", "retry", "outcome"])
    await assert.rejects(tool.run({ action, runId: mine, nodeId: "reviewer", value: "accepted" }, { sessionId: "chat-b" }), /workflow run not found in this chat/, action);
  await assert.rejects(tool.manage({ action: "decide", runId: mine, decision: "accept" }, { sessionId: "chat-b" }), /workflow run not found in this chat/);
  // A chat of another project is not the caller's project at all.
  await assert.rejects(tool.run({ action: "runs" }, { sessionId: "chat-other" }), /not available/);
  await assert.rejects(tool.run({ action: "runs" }, { sessionId: "missing" }), /not available/);
});

test("status, output and outcome describe and settle the chat's run", async () => {
  const tool = rig();
  const id = runIdOf(await tool.run({ action: "run", workflowId: "build-review", input: "Add the flag" }));
  await settled(tool.service, id);
  const status = await tool.run({ action: "status" });
  assert.match(status, new RegExp(`^Run ${id} · “Build \\+ Review” · done`));
  assert.match(status, /Outcome: not recorded yet/);
  assert.match(status, /- builder \(Builder\) · done · claude anthropic\/opus · chat child-builder/);
  assert.match(status, /- review \(Reviewer\) · done · approved/);
  // The result is already in the chat's context; status does not repeat it.
  assert.doesNotMatch(status, /Report of review/);
  assert.match(status, /Result: in this chat's context/);
  assert.match(await tool.run({ action: "output", nodeId: "builder" }), /Report of builder \(Builder\), done:\nReport of builder\./);
  await assert.rejects(tool.run({ action: "output" }), /output needs a nodeId; this run has: builder, review/);
  await assert.rejects(tool.run({ action: "outcome", value: "fine" }), /value must be one of/);
  // A verb in another form is the same value.
  assert.equal(await tool.run({ action: "outcome", value: "Discard" }), `Recorded: run ${id} was discarded.`);
  assert.equal(await tool.run({ action: "outcome", value: "accepted", note: "merged as is" }), `Recorded: run ${id} was accepted.`);
  assert.deepEqual({ ...tool.service.getRun(id)!.outcome, at: 0 }, { value: "accepted", note: "merged as is", at: 0, by: "agent" });
  assert.match(await tool.run({ action: "stats" }), /“Build \+ Review”: 1 run \(1 done, 0 failed, 0 stopped\) · outcome: 1 accepted, 0 reworked, 0 discarded, 0 not recorded · 0 of 2 units sent back/);
  // Another member's turn in the same chat cannot overwrite the launcher's record.
  await assert.rejects(tool.run({ action: "outcome", value: "discarded" }, { actorUserId: "usr_b" }), /only the person who started this run/);
});

test("stop ends the chat's run without waking the chat that asked", async () => {
  const tool = rig();
  const id = runIdOf(await tool.run({ action: "run", workflowId: "review", input: "hold on this" }));
  assert.equal(await tool.run({ action: "stop", runId: id }), `Run ${id} is stopped.`);
  assert.deepEqual(tool.notices, []);
});

test("retry continues a held unit on the route the agent names", async () => {
  const tool = rig({
    fail: (context) => context.node.model?.modelID === "opus"
      ? Object.assign(new Error("opus is not available"), { workflow: { retryable: true, phase: "pre-admission" } })
      : undefined,
  });
  const single = tool.service.create({ projectId: "p", name: "Single", nodes: [{ id: "only", role: "Only", prompt: "Do it" }], edges: [] });
  const id = runIdOf(await tool.run({ action: "run", workflowId: single.id, input: "Do it" }));
  for (let attempt = 0; attempt < 400 && !tool.service.getRun(id)?.nodes[0]?.needsFix; attempt++)
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  assert.match(await tool.run({ action: "status", runId: id }), /waits for a fix: opus is not available → action "retry" with nodeId only/);
  assert.deepEqual(tool.notices.map((event) => event.kind), ["needs-fix"]);
  // A model is written the way agent.models prints it; the provider is the part before the first slash.
  assert.equal(await tool.run({ action: "retry", runId: id, harnessId: "pi", model: "go/flash" }), `Unit only continues in run ${id}.`);
  const run = await settled(tool.service, id);
  assert.equal(run.status, "done");
  assert.deepEqual(run.nodes[0]!.model, { providerID: "go", modelID: "flash" });
});

test("viewers, missing members and turns outside a chat are refused; system turns act for nobody", async () => {
  const tool = rig({ viewer: "usr_v" });
  await assert.rejects(tool.run({ action: "run", workflowId: "review", input: "x" }, { actorUserId: "usr_v" }), /Viewers can't run or change workflows/);
  assert.match(await tool.run({ action: "templates" }, { actorUserId: "usr_v" }), /^7 workflow templates/);
  await assert.rejects(tool.manage({ action: "create", name: "x", nodes: [] }, { actorUserId: "usr_v" }), /Viewers can't/);
  await assert.rejects(tool.run({ action: "templates" }, { actorUserId: "usr_gone" }), /not a member of its Space/);
  await assert.rejects(tool.run({ action: "templates" }, { spaceId: undefined }), /needs a Polyth chat/);
  const id = runIdOf(await tool.run({ action: "run", workflowId: "review", input: "system check" }, { actorUserId: undefined }));
  await settled(tool.service, id);
  assert.equal(tool.units[0]!.launchedBy, undefined);
});

test("manage saves, changes and deletes templates of the project and never saves automatic approvals", async () => {
  const tool = rig();
  const created = await tool.manage({
    action: "create", name: "Scout then build", reviewRounds: 1,
    nodes: [
      { id: "scout", role: "Scout", prompt: "Map the module", routingRole: "explore" },
      { id: "build", role: "Builder", prompt: "Implement", routingRole: "implement", after: ["scout"], harnessId: "claude", model: "anthropic/sonnet" },
      { id: "review", role: "Reviewer", prompt: "Review", kind: "review", routingRole: "review", after: ["build"] },
    ],
  });
  assert.match(created, /Saved template “Scout then build” as [0-9a-f-]{36} \(Scout → Builder → Reviewer\)\./);
  const saved = tool.service.list("p")[0]!;
  assert.deepEqual(saved.edges, [{ id: "scout-build", source: "scout", target: "build" }, { id: "build-review", source: "build", target: "review" }]);
  assert.deepEqual(saved.defaults, { permissions: "manual", reviewRounds: 1 });
  assert.deepEqual(saved.nodes[1], { id: "build", role: "Builder", prompt: "Implement", routingRole: "implement", model: { providerID: "anthropic", modelID: "sonnet" }, harness: { mode: "pinned", harnessId: "claude" } });

  const auto = tool.service.create({ projectId: "p", name: "Auto", nodes: [{ id: "only", role: "Only", prompt: "Do it" }], edges: [], defaults: { permissions: "auto", maxParallel: 3 } });
  await tool.manage({ action: "create", copyOf: auto.id });
  const copy = tool.service.list("p").find((workflow) => workflow.name === "Auto (copy)")!;
  assert.deepEqual(copy.defaults, { permissions: "manual", maxParallel: 3 });
  await tool.manage({ action: "create", copyOf: "build-review", name: "My review" });
  assert.equal(tool.service.list("p").find((workflow) => workflow.name === "My review")!.nodes.length, 2);

  assert.match(await tool.manage({ action: "update", workflowId: saved.id, name: "Renamed", expectedRevision: 0 }), /Updated template “Renamed”/);
  await assert.rejects(tool.manage({ action: "update", workflowId: saved.id, name: "Late", expectedRevision: 0 }), /revision is stale/);
  await assert.rejects(tool.manage({ action: "update", workflowId: "build-review", name: "x" }), /bundled templates are read-only/);
  const foreign = tool.service.create({ projectId: "other", name: "Foreign", nodes: [{ id: "only", role: "Only", prompt: "Do it" }], edges: [] });
  await assert.rejects(tool.manage({ action: "delete", workflowId: foreign.id }), /needs the id of a saved template of this project/);
  assert.equal(tool.service.get(foreign.id)?.name, "Foreign");
  assert.match(await tool.manage({ action: "delete", workflowId: saved.id }), /Deleted template “Renamed”/);
  assert.equal(tool.service.get(saved.id), null);
  await assert.rejects(tool.manage({ action: "create", name: "Bad role", nodes: [{ id: "only", role: "Only", prompt: "Do it", routingRole: "Not A Role" }] }), /routingRole is invalid/);
});

test("what every request carries stays small: both tool schemas and the skill text", () => {
  const { tools } = rig();
  const cost = (contribution: typeof tools.run): number => {
    const descriptor = contribution.descriptor;
    if (descriptor.kind !== "tool") return Number.POSITIVE_INFINITY;
    return descriptor.description.length + JSON.stringify(descriptor.inputSchema).length;
  };
  // Characters, not tokens: a budget that fails loudly when someone adds prose
  // to standing context instead of to the step that needs it.
  assert.ok(cost(tools.run) <= 1_800, `polyth_workflow carries ${cost(tools.run)} characters`);
  assert.ok(cost(tools.manage) <= 2_000, `polyth_workflow_manage carries ${cost(tools.manage)} characters`);
  const skill = workflowSkill.descriptor;
  assert.ok(skill.kind === "skill" && skill.instructions.length <= 900, "the skill text is a short when-to-use note");
});

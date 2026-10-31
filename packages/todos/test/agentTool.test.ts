import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentCapabilityContribution,
  AgentCapabilityContributionRegistry,
  JsonObject,
  SessionEvent,
  ToolExecutionContext,
} from "@polyth/contracts";
import { createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { isTodoToolName } from "../src/index.ts";
import { TODO_SKILL_ID, TODO_TOOL_ID, TODO_TOOL_NAME, createTodoAgentTool, todoSkill } from "../src/agentTool.ts";
import registerPackage from "../src/serverEntry.ts";

const SPACE = "space-a";
const ctx: ToolExecutionContext = { sessionId: "s1", projectId: "p1", cwd: "/repo", spaceId: SPACE };

const snapshot = (seq: number, revision: number, items: JsonObject[]): SessionEvent =>
  ({ seq, time: seq, type: "task/snapshot", data: { listId: "todo", revision, items } }) as unknown as SessionEvent;

const fakeLog = (initial: SessionEvent[] = []) => {
  const log = [...initial];
  return {
    log,
    events: async (spaceId: string, sessionId: string) => {
      if (spaceId !== SPACE || sessionId !== "s1") throw Object.assign(new Error("session not found"), { code: "not-found" });
      return log;
    },
    append: async (_sessionId: string, data: JsonObject) => {
      log.push(snapshot(log.length + 1, data.revision as number, data.items as JsonObject[]));
    },
  };
};

test("the tool name never matches a native todo tool, so adapters do not double-publish", () => {
  assert.equal(isTodoToolName(TODO_TOOL_NAME), false);
  assert.equal(isTodoToolName(`mcp__polyth-agent-tools__${TODO_TOOL_NAME}`), false);
  assert.equal(isTodoToolName(`polyth-agent-tools_${TODO_TOOL_NAME}`), false);
});

test("replace, merge, read and clear publish monotonic snapshots on top of native ones", async () => {
  // A clock-seeded native snapshot already owns the list.
  const store = fakeLog([snapshot(1, 1_700_000_000_000, [{ id: "a", text: "Native", status: "done" }])]);
  const tool = createTodoAgentTool(store);

  const read = await tool.execute!({}, ctx);
  assert.match(read.output, /\[x\] a: Native/);
  assert.equal(store.log.length, 1, "reading does not append");

  await tool.execute!({ todos: [{ id: "a", content: "Native", status: "completed" }, { content: "Next", status: "in_progress" }] }, ctx);
  const merged = await tool.execute!({ merge: true, todos: [{ id: "todo:1", content: "Next", status: "completed" }, { content: "Added" }] }, ctx);
  assert.match(merged.output, /Todos \(2\/3 completed\)/);

  const revisions = store.log.map((event) => event.data.revision as number);
  assert.deepEqual(revisions, [1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002]);
  assert.deepEqual(store.log.at(-1)!.data.items, [
    { id: "a", text: "Native", status: "done" },
    { id: "todo:1", text: "Next", status: "done" },
    { id: "todo:2", text: "Added", status: "pending" },
  ]);

  await tool.execute!({ todos: [] }, ctx);
  assert.deepEqual(store.log.at(-1)!.data.items, []);
});

test("concurrent calls in one session serialize to distinct revisions", async () => {
  const store = fakeLog();
  const tool = createTodoAgentTool(store);
  await Promise.all([
    tool.execute!({ todos: [{ id: "1", content: "One" }] }, ctx),
    tool.execute!({ merge: true, todos: [{ id: "2", content: "Two" }] }, ctx),
  ]);
  assert.deepEqual(store.log.map((event) => event.data.revision), [1, 2]);
  assert.equal((store.log[1]!.data.items as unknown[]).length, 2);
});

test("a session outside the grant Space is rejected without appending", async () => {
  const store = fakeLog();
  const tool = createTodoAgentTool(store);
  await assert.rejects(tool.execute!({ todos: [{ content: "x" }] }, { ...ctx, spaceId: "space-b" }), /not found/);
  await assert.rejects(tool.execute!({ todos: [] }, { ...ctx, sessionId: "" }), /needs a Polyth session/);
  assert.equal(store.log.length, 0);
});

test("the package registers the tool and skill on enable and disposes them on disable", async () => {
  const registered = new Map<string, AgentCapabilityContribution>();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"), {
    register: (_owner, contribution) => {
      registered.set(contribution.descriptor.id, contribution);
      return { dispose: () => { registered.delete(contribution.descriptor.id); } };
    },
  } as AgentCapabilityContributionRegistry);
  const pkg = registerPackage({ storageDir: "/nonexistent", services } as unknown as ServerPackageHost);
  await pkg.onEnable?.();
  await pkg.onEnable?.();
  assert.deepEqual([...registered.keys()].sort(), [TODO_SKILL_ID, TODO_TOOL_ID].sort());
  await pkg.onDisable?.();
  assert.equal(registered.size, 0);
});

test("contributions satisfy real capability registry invariants (pure vs mutating)", async () => {
  const { createCapabilityContributionRegistry } = await import("../../harness-runtime/src/capabilities.ts");
  const registry = createCapabilityContributionRegistry();
  const store = fakeLog();
  const tool = createTodoAgentTool(store);
  assert.doesNotThrow(() => registry.register("todos", todoSkill));
  assert.doesNotThrow(() => registry.register("todos", tool));
});


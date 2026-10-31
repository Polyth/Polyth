import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { createGoalService, parseVerdict, STUCK_STREAK_LIMIT, type GoalContext, type GoalDeps } from "../src/index.ts";

interface Harness {
  events: Array<{ type: string; data: JsonObject }>;
  sends: string[];
  replies: string[];
  service: ReturnType<typeof createGoalService>;
}

function harness(replies: string[]): Harness {
  const events: Array<{ type: string; data: JsonObject }> = [];
  const sends: string[] = [];
  const service = createGoalService({
    append: async (_s, type, data) => {
      events.push({ type, data });
    },
    send: async (_s, text) => {
      sends.push(text);
    },
    complete: async () => replies.shift() ?? '{"verdict":"keep","reason":"more"}',
    now: () => 1000,
  });
  return { events, sends, replies, service };
}

const types = (h: Harness) => h.events.map((e) => e.type);

test("parseVerdict handles json, fenced json and prose", () => {
  assert.equal(parseVerdict('{"verdict":"done","reason":"ok"}').verdict, "done");
  assert.equal(parseVerdict('```json\n{"verdict":"stuck","reason":"x"}\n```').verdict, "stuck");
  assert.equal(parseVerdict("The task is DONE now").verdict, "done");
  assert.equal(parseVerdict("no idea").verdict, "keep");
});

test("attach emits goal/attached and exposes state", async () => {
  const h = harness([]);
  const state = await h.service.attach("s1", { objective: "ship it", maxContinuations: 3 });
  assert.equal(state.status, "active");
  assert.deepEqual(types(h), ["goal/attached"]);
  assert.equal(h.service.get("s1")?.objective, "ship it");
});

test("attach rejects empty objectives and non-positive or fractional limits", async () => {
  const h = harness([]);
  for (const [input, field] of [
    [{ objective: " " }, "objective"],
    [{ objective: "ship", budgetTokens: 0 }, "budgetTokens"],
    [{ objective: "ship", budgetTokens: -1 }, "budgetTokens"],
    [{ objective: "ship", maxContinuations: 0 }, "maxContinuations"],
    [{ objective: "ship", maxContinuations: 1.5 }, "maxContinuations"],
  ] as const) {
    await assert.rejects(
      () => h.service.attach("s1", input),
      (error: Error & { code?: string; field?: string }) =>
        error.code === "invalid-input" && error.field === field,
    );
  }
  assert.deepEqual(h.events, []);
  assert.equal(h.service.get("s1"), null);
});

test("keep verdict continues the session and counts continuations", async () => {
  const h = harness(['{"verdict":"keep","reason":"more work"}']);
  await h.service.attach("s1", { objective: "ship it" });
  await h.service.onTurnCompleted("s1", "did a bit");
  assert.deepEqual(types(h), ["goal/attached", "goal/audit", "goal/continuation-admitted"]);
  assert.equal(h.sends.length, 1);
  assert.equal(h.service.get("s1")?.continuations, 1);
});

test("goal auditor retains the requester for small-model selection", async () => {
  let seenUserId: string | undefined;
  const service = createGoalService({
    append: async () => {},
    send: async () => {},
    complete: async (_sessionId, _prompt, userId) => {
      seenUserId = userId;
      return '{"verdict":"done","reason":"finished"}';
    },
  });
  await service.attach("s1", { objective: "ship it" }, "usr_test");
  await service.onTurnCompleted("s1", "done");
  assert.equal(seenUserId, "usr_test");
});

test("done verdict completes and stops continuing", async () => {
  const h = harness(['{"verdict":"done","reason":"finished"}']);
  await h.service.attach("s1", { objective: "ship it" });
  await h.service.onTurnCompleted("s1", "all done");
  assert.deepEqual(types(h), ["goal/attached", "goal/audit", "goal/completed"]);
  assert.equal(h.sends.length, 0);
  assert.equal(h.service.get("s1")?.status, "completed");
  await h.service.onTurnCompleted("s1", "again");
  assert.equal(h.sends.length, 0);
});

test("stuck only after three consecutive stuck verdicts", async () => {
  const stuck = '{"verdict":"stuck","reason":"blocked"}';
  const h = harness([stuck, stuck, stuck]);
  await h.service.attach("s1", { objective: "ship it" });
  for (let i = 0; i < STUCK_STREAK_LIMIT; i++) await h.service.onTurnCompleted("s1", "hmm");
  assert.equal(h.sends.length, 0);
  assert.equal(types(h).filter((t) => t === "goal/stuck").length, 1);
  assert.equal(h.service.get("s1")?.status, "stuck");
});

test("a keep verdict resets the stuck streak", async () => {
  const h = harness([
    '{"verdict":"stuck","reason":"x"}',
    '{"verdict":"stuck","reason":"x"}',
    '{"verdict":"keep","reason":"progress"}',
    '{"verdict":"stuck","reason":"x"}',
  ]);
  await h.service.attach("s1", { objective: "ship it" });
  for (let i = 0; i < 4; i++) await h.service.onTurnCompleted("s1", "hmm");
  assert.equal(h.service.get("s1")?.status, "active");
  assert.equal(types(h).includes("goal/stuck"), false);
});

test("continuation limit and token budget stop the loop", async () => {
  const keep = '{"verdict":"keep","reason":"more"}';
  const h = harness([keep, keep]);
  await h.service.attach("s1", { objective: "ship it", maxContinuations: 1 });
  await h.service.onTurnCompleted("s1", "step 1");
  await h.service.onTurnCompleted("s1", "step 2");
  assert.equal(h.sends.length, 1);
  assert.equal(h.service.get("s1")?.status, "stuck");

  const h2 = harness([keep]);
  await h2.service.attach("s2", { objective: "ship it", budgetTokens: 100 });
  h2.service.recordUsage("s2", { input: 90, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  await h2.service.onTurnCompleted("s2", "step 1");
  assert.equal(h2.sends.length, 0);
  assert.equal(h2.service.get("s2")?.lastReason, "token budget exhausted");
});

test("token budget counts cached prompt tokens and does not double count reasoning", async () => {
  const keep = '{"verdict":"keep","reason":"more"}';
  // A cache-heavy response: the whole prompt arrives as cacheRead, which must
  // still move the budget, and reasoning is already part of output.
  const h = harness([keep]);
  await h.service.attach("s-cache", { objective: "ship it", budgetTokens: 50_000 });
  h.service.recordUsage("s-cache", { input: 40, output: 5_000, reasoning: 4_000, cacheRead: 90_000, cacheWrite: 1_000 });
  assert.equal(h.service.get("s-cache")?.tokensUsed, 96_040);
  await h.service.onTurnCompleted("s-cache", "step 1");
  assert.equal(h.sends.length, 0);
  assert.equal(h.service.get("s-cache")?.lastReason, "token budget exhausted");

  // Replay must rebuild exactly the same counter from the durable log.
  const replay = harness([]);
  const log: SessionEvent[] = [
    { id: "e1", sessionId: "s-cache", seq: 1, time: 1, v: 1, type: "goal/attached", data: { objective: "ship it", status: "active", continuations: 0, maxContinuations: 3, budgetTokens: 50_000, tokensUsed: 0, stuckStreak: 0, updatedAt: 1 } },
    { id: "e2", sessionId: "s-cache", seq: 2, time: 2, v: 1, type: "usage/recorded", data: { tokens: { input: 40, output: 5_000, reasoning: 4_000, cacheRead: 90_000, cacheWrite: 1_000 } } },
  ];
  assert.equal(replay.service.rehydrate("s-cache", log)?.tokensUsed, 96_040);
});

test("auditor failure is treated as stuck, never as silent continuation", async () => {
  const events: Array<{ type: string; data: JsonObject }> = [];
  const sends: string[] = [];
  const service = createGoalService({
    append: async (_s, type, data) => void events.push({ type, data }),
    send: async (_s, t) => void sends.push(t),
    complete: async () => {
      throw new Error("provider down");
    },
  });
  await service.attach("s1", { objective: "ship it" });
  await service.onTurnCompleted("s1", "reply");
  assert.equal(sends.length, 0);
  assert.equal(service.get("s1")?.lastVerdict, "stuck");
});

test("pause blocks continuation, resume re-enables it", async () => {
  const h = harness(['{"verdict":"keep","reason":"more"}', '{"verdict":"keep","reason":"more"}']);
  await h.service.attach("s1", { objective: "ship it" });
  await h.service.pause("s1");
  await h.service.onTurnCompleted("s1", "reply");
  assert.equal(h.sends.length, 0);
  await h.service.resume("s1");
  await h.service.onTurnCompleted("s1", "reply");
  assert.equal(h.sends.length, 1);
  assert.ok(types(h).includes("goal/paused") && types(h).includes("goal/resumed"));
});

test("rehydrate rebuilds goal state from the durable log", async () => {
  const h = harness(['{"verdict":"keep","reason":"more"}']);
  await h.service.attach("s1", { objective: "ship it", maxContinuations: 5 });
  await h.service.onTurnCompleted("s1", "reply");
  const log: SessionEvent[] = h.events.map((e, i) => ({
    id: `e${i}`,
    sessionId: "s1",
    seq: i + 1,
    time: 1000 + i,
    type: e.type,
    data: e.data,
    v: 1,
  }));

  const fresh = harness([]);
  const state = fresh.service.rehydrate("s1", log);
  assert.equal(state?.objective, "ship it");
  assert.equal(state?.status, "active");
  assert.equal(state?.continuations, 1);
  assert.equal(fresh.service.get("s1")?.maxContinuations, 5);
});

test("rehydrate treats context-restored markers as audit-only", () => {
  const log: SessionEvent[] = [
    {
      id: "e1", sessionId: "s1", seq: 1, time: 1000, type: "goal/attached",
      data: {
        objective: "ship it", status: "active", continuations: 0,
        maxContinuations: 5, tokensUsed: 0, budgetTokens: 1000, updatedAt: 900,
      },
      v: 1,
    },
    {
      id: "e2", sessionId: "s1", seq: 2, time: 2000, type: "goal/context-restored",
      data: { compactionSeq: 8, sourceMessageSeq: 9 },
      ignorable: true, v: 1,
    },
  ];
  const fresh = harness([]);
  const state = fresh.service.rehydrate("s1", log);
  assert.equal(state?.status, "active");
  assert.equal(state?.objective, "ship it");
  assert.equal(state?.updatedAt, 900, "recovery audit does not mutate workflow state");
});

test("stop removes the goal and emits goal/stopped", async () => {
  const h = harness([]);
  await h.service.attach("s1", { objective: "ship it" });
  await h.service.stop("s1");
  assert.equal(h.service.get("s1"), null);
  assert.ok(types(h).includes("goal/stopped"));
});

function treeHarness() {
  let context: GoalContext = {
    revision: "parent:1/child:1", ready: true, reply: "Waiting for the delegated implementation",
    pendingSessionIds: ["child"], omittedChildren: 0,
    children: [{ sessionId: "child", parentId: "parent", title: "Implement", status: "working", prompt: "Implement feature", reply: "" }],
  };
  const events: SessionEvent[] = [];
  const sends: string[] = [];
  const prompts: string[] = [];
  const deps: GoalDeps = {
    append: async (sessionId, type, data) => { events.push({ id: `${events.length}`, seq: events.length + 1, sessionId, time: 100, v: 1, type, data }); },
    send: async (_id, text) => { sends.push(text); },
    complete: async (_id, prompt) => { prompts.push(prompt); return '{"verdict":"done","reason":"all achieved"}'; },
    context: async () => structuredClone(context),
    related: async () => [{ sessionId: "parent", events }],
    waiting: async () => [{ sessionId: "parent", events }],
  };
  const service = createGoalService(deps);
  return { service, deps, events, sends, prompts, setContext: (patch: Partial<GoalContext>) => { context = { ...context, ...patch }; } };
}

test("active descendants defer auditing, completion and continuation without spending the budget", async () => {
  const h = treeHarness();
  await h.service.attach("parent", { objective: "ship feature", maxContinuations: 1 });
  await h.service.onTurnCompleted("parent", "all done");
  await h.service.onTurnCompleted("parent", "all done");
  assert.equal(h.service.get("parent")?.status, "active");
  assert.deepEqual(h.service.get("parent")?.waitingFor, ["child"]);
  assert.equal(h.service.get("parent")?.continuations, 0);
  assert.equal(h.service.get("parent")?.stuckStreak, 0);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.sends.length, 0);
  assert.equal(h.events.filter((event) => event.type === "goal/audit").length, 1);
});

test("the last child wakes the parent once with reports for integration, never auto-completing its goal", async () => {
  const h = treeHarness();
  await h.service.attach("parent", { objective: "ship feature" });
  await h.service.onTurnCompleted("parent", "waiting");
  h.setContext({ revision: "parent:1/child:2", pendingSessionIds: [], children: [
    { sessionId: "child", parentId: "parent", title: "Implement", status: "idle", prompt: "Implement feature", reply: "Feature implemented; tests passed" },
  ] });
  await Promise.all([h.service.onSessionStopped("child"), h.service.onSessionStopped("child")]);
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0]!, /Feature implemented; tests passed/);
  assert.match(h.sends[0]!, /verify the parent objective/);
  assert.equal(h.service.get("parent")?.status, "active");
  assert.equal(h.service.get("parent")?.continuations, 1);
  assert.equal(h.prompts.length, 0);
  h.setContext({ revision: "parent:2/child:2", reply: "Integrated feature and verified all acceptance criteria" });
  await h.service.onTurnCompleted("parent", "integrated");
  assert.equal(h.service.get("parent")?.status, "completed");
  assert.match(h.prompts[0]!, /Feature implemented; tests passed/);
});

test("a child stopping while siblings still work updates the wait without continuing", async () => {
  const h = treeHarness();
  await h.service.attach("parent", { objective: "ship feature" });
  await h.service.onTurnCompleted("parent", "waiting");
  h.setContext({ revision: "siblings:2", pendingSessionIds: ["grandchild"] });
  await h.service.onSessionStopped("child");
  assert.deepEqual(h.service.get("parent")?.waitingFor, ["grandchild"]);
  assert.equal(h.sends.length, 0);
  assert.equal(h.prompts.length, 0);
});

test("durable waits recover after restart and preserve requester model selection", async () => {
  const h = treeHarness();
  await h.service.attach("parent", { objective: "ship feature" }, "user-parent");
  await h.service.onTurnCompleted("parent", "waiting");
  h.setContext({ revision: "restart:2", pendingSessionIds: [] });
  const fresh = createGoalService(h.deps);
  await fresh.recoverWaiting();
  assert.equal(h.sends.length, 1);
  assert.equal(fresh.get("parent")?.continuations, 1);
  let requester: string | undefined;
  h.deps.complete = async (_id, _text, userId) => { requester = userId; return '{"verdict":"done"}'; };
  h.setContext({ revision: "restart:3", reply: "Integrated and verified" });
  await fresh.onTurnCompleted("parent", "integrated");
  assert.equal(requester, "user-parent");
  assert.equal(fresh.get("parent")?.status, "completed");
});

test("paused waits stay paused when children finish and resume reconciles their results", async () => {
  const h = treeHarness();
  await h.service.attach("parent", { objective: "ship feature" });
  await h.service.onTurnCompleted("parent", "waiting");
  await h.service.pause("parent");
  h.setContext({ revision: "pause:2", pendingSessionIds: [] });
  await h.service.onSessionStopped("child");
  assert.equal(h.sends.length, 0);
  await h.service.resume("parent");
  assert.equal(h.sends.length, 1);
});

test("dependency wake respects continuation and token limits", async () => {
  for (const limit of ["tokens", "continuations"] as const) {
    const h = treeHarness();
    await h.service.attach("parent", { objective: "ship feature", budgetTokens: 10, maxContinuations: 1 });
    await h.service.onTurnCompleted("parent", "waiting");
    const g = h.service.get("parent")!;
    if (limit === "tokens") h.service.recordUsage("parent", { input: 10, output: 0 });
    else g.continuations = 1;
    h.setContext({ revision: `limit:${limit}`, pendingSessionIds: [] });
    await h.service.onSessionStopped("child");
    assert.equal(h.sends.length, 0);
    assert.equal(g.status, "stuck");
  }
});

test("busy or queued parents are not woken by child settlement", async () => {
  const h = treeHarness();
  await h.service.attach("parent", { objective: "ship feature" });
  await h.service.onTurnCompleted("parent", "waiting");
  h.setContext({ revision: "parent:working", ready: false, pendingSessionIds: [] });
  await h.service.onSessionStopped("child");
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.service.get("parent")?.waitingFor, ["child"]);
});

test("a child arriving during inference invalidates a done verdict", async () => {
  const h = treeHarness();
  h.setContext({ revision: "no-child", pendingSessionIds: [] });
  h.deps.complete = async () => {
    h.setContext({ revision: "new-child", pendingSessionIds: ["child"] });
    return '{"verdict":"done"}';
  };
  await h.service.attach("parent", { objective: "ship feature" });
  await h.service.onTurnCompleted("parent", "looks done");
  assert.equal(h.service.get("parent")?.status, "active");
  assert.deepEqual(h.service.get("parent")?.waitingFor, ["child"]);
  assert.equal(h.events.some((event) => event.type === "goal/completed"), false);
});

test("pause, pause-resume, stop, replacement and disable invalidate an in-flight auditor", async () => {
  for (const action of ["pause", "pause-resume", "stop", "replace", "disable", "disable-enable"] as const) {
    let release!: (reply: string) => void;
    let started!: () => void;
    let enabled = true;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const h = harness([]);
    const service = createGoalService({
      append: async (_id, type, data) => { h.events.push({ type, data }); },
      send: async (_id, text) => { h.sends.push(text); },
      complete: async () => { started(); return new Promise<string>((resolve) => { release = resolve; }); },
      enabled: () => enabled,
    });
    await service.attach("parent", { objective: "original" });
    const running = service.onTurnCompleted("parent", "done");
    await entered;
    if (action === "pause" || action === "pause-resume") await service.pause("parent");
    if (action === "pause-resume") await service.resume("parent");
    if (action === "stop") await service.stop("parent");
    if (action === "replace") await service.attach("parent", { objective: "replacement" });
    if (action === "disable") enabled = false;
    if (action === "disable-enable") service.invalidateAudits();
    release('{"verdict":"done"}');
    await running;
    assert.equal(h.events.some((event) => event.type === "goal/completed"), false, action);
    assert.equal(h.sends.length, 0, action);
  }
});

test("restart before admission or its receipt recovers the exact continuation intent without duplication", async () => {
  for (const phase of ["before-admission", "before-receipt"] as const) {
    const h = treeHarness();
    const append = h.deps.append;
    let interrupted = true;
    const admitted = new Map<string, string>();
    const attempts: string[] = [];
    h.deps.send = async (_id, text, operationId) => {
      assert.ok(operationId);
      attempts.push(operationId);
      if (admitted.has(operationId)) assert.equal(admitted.get(operationId), text);
      else admitted.set(operationId, text);
    };
    h.deps.append = async (id, type, data) => {
      if (interrupted && phase === "before-receipt" && (type === "goal/continuation-admitted" || type === "goal/stuck")) throw new Error("process interrupted");
      await append(id, type, data);
      if (interrupted && phase === "before-admission" && type === "goal/audit" && data.pendingContinuation) throw new Error("process interrupted");
    };
    await h.service.attach("parent", { objective: "ship feature" });
    await h.service.onTurnCompleted("parent", "waiting");
    h.setContext({ revision: `settled:${phase}`, pendingSessionIds: [] });
    await assert.rejects(() => h.service.onSessionStopped("child"), /process interrupted/);
    const saved = h.events.findLast((event) => event.type === "goal/audit")!.data.pendingContinuation as { operationId: string; text: string };
    interrupted = false;
    const fresh = createGoalService(h.deps);
    await fresh.recoverWaiting();
    await fresh.recoverWaiting();
    assert.equal(admitted.size, 1, phase);
    assert.ok(attempts.every((id) => id === saved.operationId));
    assert.equal(admitted.get(saved.operationId), saved.text);
    assert.equal(fresh.get("parent")?.continuations, 1);
    assert.equal(fresh.get("parent")?.pendingContinuation, undefined);
  }
});

test("an uncertain continuation admission stays stopped through restart", async () => {
  const h = treeHarness();
  let sends = 0;
  h.deps.send = async () => { sends += 1; throw Object.assign(new Error("admission unresolved"), { code: "unknown" }); };
  await h.service.attach("parent", { objective: "ship feature" });
  await h.service.onTurnCompleted("parent", "waiting");
  h.setContext({ revision: "uncertain:2", pendingSessionIds: [] });
  await h.service.onSessionStopped("child");
  assert.equal(h.service.get("parent")?.status, "stuck");
  assert.ok(h.service.get("parent")?.pendingContinuation);
  const fresh = createGoalService(h.deps);
  await fresh.recoverWaiting();
  assert.equal(sends, 1);
  assert.equal(fresh.get("parent")?.status, "stuck");
});

test("a failed intent append cannot admit a continuation until persistence succeeds", async () => {
  const h = treeHarness();
  const append = h.deps.append;
  let persist = false;
  h.deps.append = async (id, type, data) => {
    if (!persist && data.pendingContinuation) throw new Error("storage unavailable");
    return append(id, type, data);
  };
  await h.service.attach("parent", { objective: "ship feature" });
  await h.service.onTurnCompleted("parent", "waiting");
  h.setContext({ revision: "settled:storage", pendingSessionIds: [] });
  await assert.rejects(h.service.onSessionStopped("child"), /storage unavailable/);
  const intent = h.service.get("parent")!.pendingContinuation!;
  await assert.rejects(h.service.onSessionStopped("child"), /storage unavailable/);
  assert.equal(h.sends.length, 0);
  persist = true;
  await h.service.onSessionStopped("child");
  assert.equal(h.sends.length, 1);
  assert.equal(h.service.get("parent")?.continuations, 1);
  const saved = h.events.findLast((event) => event.type === "goal/audit")?.data.pendingContinuation as { operationId: string };
  assert.equal(saved.operationId, intent.operationId);
});

test("receipt markers without a matching goal intent are safe to replay", () => {
  const h = harness([]);
  assert.equal(h.service.rehydrate("s1", [{ id: "receipt", sessionId: "s1", seq: 1, time: 1, v: 1, type: "goal/continuation-admitted", data: {} }]), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoAcceptSetting, SessionEvent } from "@polyth/contracts";
import { parseAgentFile, serializeAgentFile, type AgentFileSpec } from "../src/agentFile.ts";
import {
  agentSpecOf,
  createScheduleService,
  scheduleExecutionRoutes,
  validateFallbackModels,
  type ScheduleExecutionSelection,
  type ScheduleRunner,
} from "../src/index.ts";
import { settleScheduledRun } from "../src/runSettlement.ts";
import { applyPermissions, withRouteFailover } from "../src/serverEntry.ts";

const sonnet = { providerID: "anthropic", modelID: "claude-sonnet", harnessId: "claude" };
const gpt = { providerID: "openai", modelID: "gpt-5", variant: "high", harnessId: "codex" };

function make(runner: ScheduleRunner = { async run() { return { sessionId: "s", markerSeq: 1 }; } }) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-backups-"));
  return createScheduleService({ file: join(dir, "schedule.json"), runner });
}

test("backups are harness-qualified, unique and bounded; null or [] removes them", () => {
  assert.deepEqual(validateFallbackModels([sonnet, { ...gpt, extra: 1 }]), [sonnet, gpt]);
  assert.throws(() => validateFallbackModels([{ providerID: "a", modelID: "b" }]), /needs a harness/);
  assert.throws(() => validateFallbackModels([{ providerID: "a", harnessId: "h" }]), /provider and a model/);
  assert.throws(() => validateFallbackModels([sonnet, { ...sonnet }]), /listed twice/);
  assert.throws(() => validateFallbackModels(Array.from({ length: 9 }, (_, i) => ({ ...sonnet, modelID: `m${i}` }))), /at most 8/);
  assert.throws(() => validateFallbackModels("nope"), /must be a list/);

  const svc = make();
  const task = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, model: { providerID: "x", modelID: "main", harnessId: "pi" }, fallbackModels: [gpt, sonnet], permissions: "all" });
  assert.deepEqual(task.fallbackModels, [gpt, sonnet], "kept in priority order");
  assert.equal(task.permissions, "all");
  assert.throws(() => svc.update(task.id, { permissions: "root" as never }), /permissions must be/);
  const cleared = svc.update(task.id, { fallbackModels: [], permissions: null });
  assert.equal(cleared.fallbackModels, undefined);
  assert.equal(cleared.permissions, undefined);
});

test("a run tries the main route first, then each backup pinned to its own harness; a profile has no backups", () => {
  const routes = scheduleExecutionRoutes({ model: { providerID: "x", modelID: "main" }, harness: { mode: "pinned", harnessId: "pi" }, fallbackModels: [gpt, sonnet] });
  assert.deepEqual(routes.map((route) => [route.harness, route.model?.modelID]), [
    [{ mode: "pinned", harnessId: "pi" }, "main"],
    [{ mode: "pinned", harnessId: "codex" }, "gpt-5"],
    [{ mode: "pinned", harnessId: "claude" }, "claude-sonnet"],
  ]);
  assert.equal(scheduleExecutionRoutes({ fallbackModels: [gpt], agentProfile: "prof" }).length, 1);
});

test("only a refused route moves on; an error that may have landed is never retried on a backup", async () => {
  const routes: ScheduleExecutionSelection[] = [{ model: sonnet }, { model: gpt }, { model: { ...gpt, modelID: "third" } }];
  const tried: string[] = [];
  const refusing = (code: string | undefined, okAt: string) => async (route: ScheduleExecutionSelection) => {
    tried.push(route.model!.modelID);
    if (route.model!.modelID !== okAt) throw Object.assign(new Error("no"), code ? { code } : {});
    return route.model!.modelID;
  };
  assert.deepEqual(await withRouteFailover(routes, 0, refusing("quota-exhausted", "third")), { value: "third", route: 2 });
  assert.deepEqual(tried, ["claude-sonnet", "gpt-5", "third"]);

  tried.length = 0;
  await assert.rejects(withRouteFailover(routes, 0, refusing(undefined, "third")), /no/);
  assert.deepEqual(tried, ["claude-sonnet"], "an uncoded failure is uncertain: no backup");
  tried.length = 0;
  await assert.rejects(withRouteFailover(routes, 0, refusing("outcome-unknown", "third")), /no/);
  assert.deepEqual(tried, ["claude-sonnet"]);
  tried.length = 0;
  await assert.rejects(withRouteFailover(routes, 1, refusing("auth", "none")), /no/);
  assert.deepEqual(tried, ["gpt-5", "third"], "the last refusal is reported");
});

test("the run record says which backup admitted the run", async () => {
  const svc = make({ async run() { return { sessionId: "s", markerSeq: 1, backup: 2 }; } });
  const task = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, fallbackModels: [gpt, sonnet] });
  await svc.runNow(task.id);
  assert.equal(svc.get(task.id)!.history![0]!.backup, 2);
});

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): SessionEvent =>
  ({ id: `e${seq}`, seq, type, data, sessionId: "s1", time: seq } as unknown as SessionEvent);

test("a turn stopped by its route continues on the next backup; other failures stay failures", async () => {
  const log = [
    ev(11, "turn/started"),
    ev(12, "turn/stopped", { reason: "error", code: "quota-exhausted", error: "out of quota" }),
  ];
  const moves: number[] = [];
  const settled = settleScheduledRun({ sessionId: "s1", markerSeq: 10, startedAt: Date.now() }, {
    signal: new AbortController().signal,
    sleep: async () => {},
    events: async (_id, after) => log.filter((event) => event.seq > after),
    backup: 0,
    onRouteFailure: async (next) => {
      moves.push(next);
      log.push(ev(13, "user/message"), ev(14, "turn/started"), ev(15, "assistant/message", { text: "done" }), ev(16, "turn/stopped", { reason: "completed" }));
      return true;
    },
  });
  assert.deepEqual(await settled, { status: "ok", backup: 1, summary: "done" });
  assert.deepEqual(moves, [1]);

  let asked = 0;
  const plain = await settleScheduledRun({ sessionId: "s1", markerSeq: 10, startedAt: Date.now() }, {
    signal: new AbortController().signal,
    sleep: async () => {},
    events: async () => [ev(11, "turn/started"), ev(12, "turn/stopped", { reason: "error", error: "tool exploded" })],
    onRouteFailure: async () => { asked += 1; return true; },
  });
  assert.deepEqual(plain, { status: "failed", error: "tool exploded" });
  assert.equal(asked, 0, "a failure of the work itself is not the route's");

  const exhausted = await settleScheduledRun({ sessionId: "s1", markerSeq: 10, startedAt: Date.now() }, {
    signal: new AbortController().signal,
    sleep: async () => {},
    events: async () => [ev(11, "turn/started"), ev(12, "turn/stopped", { reason: "error", code: "model-unavailable", error: "refused" })],
    onRouteFailure: async () => false,
  });
  assert.deepEqual(exhausted, { status: "failed", error: "refused" });
});

test("the approval level reaches the session; raising it needs an owner, and a chosen chat changes only when set", async () => {
  const set: Array<[string, AutoAcceptSetting]> = [];
  const sessions = { autoAcceptSet: async (id: string, setting: AutoAcceptSetting) => { set.push([id, setting]); return { setting, effective: setting !== "off" }; } };
  await applyPermissions(sessions, "s1", "all", { ownSession: true, owned: true });
  await applyPermissions(sessions, "s1", "routine", { ownSession: true, owned: true });
  await applyPermissions(sessions, "s1", "ask", { ownSession: true, owned: false });
  await applyPermissions(sessions, "s1", undefined, { ownSession: true, owned: true });
  await applyPermissions(sessions, "chat", undefined, { ownSession: false, owned: true });
  assert.deepEqual(set, [["s1", "all"], ["s1", "on"], ["s1", "off"], ["s1", "inherit"]]);
  await assert.rejects(applyPermissions(sessions, "s1", "all", { ownSession: true, owned: false }), { code: "forbidden" });
  // The owner's guarded service refuses for an account that may not auto-approve.
  const guarded = { autoAcceptSet: async () => { throw Object.assign(new Error("Auto-Approve is not available for this account"), { code: "forbidden" }); } };
  await assert.rejects(applyPermissions(guarded, "s1", "all", { ownSession: true, owned: true }), { code: "forbidden" });
});

test("backups live in agent files; the approval level never does", () => {
  const spec: AgentFileSpec = {
    id: "helper",
    name: "helper",
    enabled: true,
    model: "x/main",
    harness: "pi",
    fallbackModels: [{ model: "openai/gpt-5#high", harness: "codex" }, { model: "anthropic/claude-sonnet", harness: "claude" }],
    charter: "Help.",
  };
  const text = serializeAgentFile(spec);
  assert.match(text, /^fallbackModels: \[\{"model":"openai\/gpt-5#high","harness":"codex"\}/m);
  assert.deepEqual(parseAgentFile(text).spec, spec);
  assert.match(parseAgentFile("---\nid: a\nfallbackModels: [{\"model\":\"opus\",\"harness\":\"c\"}]\n---\nx").error!, /provider\/model/);
  assert.match(parseAgentFile("---\nid: a\nfallbackModels: [{\"model\":\"a/b\"}]\n---\nx").error!, /harness is required/);
  assert.match(parseAgentFile("---\nid: a\npermissions: all\n---\nx").error!, /unknown key "permissions"/);

  const svc = make();
  const task = svc.create({ projectId: "p", prompt: "Help.", kind: "every", everyMinutes: 60, manualOnly: true, fallbackModels: [gpt], permissions: "all" });
  const exported = agentSpecOf(task, "helper");
  assert.deepEqual(exported.fallbackModels, [{ model: "openai/gpt-5#high", harness: "codex" }]);
  assert.equal("permissions" in exported, false);
});

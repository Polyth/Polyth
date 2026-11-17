import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RouteHandler, SessionEvent, SessionProjection, SpaceContext, SpaceStorage } from "@polyth/contracts";
import { createServerServiceRegistry, SERVER_TOOL_QUIET_BUS, type ServerPackageHost, type ServerToolQuietEvent } from "@polyth/plugins";
import registerJudgment from "../../judgment/src/serverEntry.ts";
import { JUDGMENT_SERVICE } from "@polyth/judgment/server";
import { createFakeJudgmentEngine } from "@polyth/judgment/testing";
import { JudgmentExecutionError, type ProviderJudgmentRequest, type ProviderJudgmentResponse } from "@polyth/judgment";
import registerJudges from "../src/serverEntry.ts";
import { callInputText, QUIET_COMMAND_USE, runQuietCommand } from "../src/quietCommand.ts";
import { ASSESSMENT_EVENT } from "../src/types.ts";

const scratch = resolve(import.meta.dirname, "../../../.scratch/judgment-judges");
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
type Answer = ProviderJudgmentResponse | JudgmentExecutionError;
const answer = (probabilities: Record<string, number>): ProviderJudgmentResponse => {
  const value = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0]![0];
  return { answers: { status: { type: "choice", value, confidence: 0.9, probabilities } } };
};

function fixture(t: test.TestContext, reply: (request: ProviderJudgmentRequest) => Answer) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "quiet-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = { spaceId: "space-a", userId: "user-a" } as SpaceContext;
  const services = createServerServiceRegistry();
  const listeners = new Set<(event: ServerToolQuietEvent) => void | Promise<void>>();
  services.provide(SERVER_TOOL_QUIET_BUS, { subscribe(listener) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; } });
  const sessions = new Map<string, { spaceId: string; events: SessionEvent[] }>();
  const appended: Array<{ sessionId: string; type: string; data: Record<string, unknown> }> = [];
  const kept: Array<{ sessionId: string; callId: string; options: unknown; spaceId: string }> = [];
  const reads: Array<{ sessionId: string; spaceId: string }> = [];
  let keepError: unknown;
  const ev = (sessionId: string, seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
    ({ id: `${sessionId}-${seq}`, sessionId, seq, time: seq, type, data: data as never, v: 1 });
  const addSession = (id: string, spaceId: string, input: Record<string, unknown> = { command: `deploy --token=${SECRET} && make all`, description: "Build everything" }) => {
    sessions.set(id, { spaceId, events: [
      ev(id, 1, "user/message", { text: "build it" }),
      ev(id, 2, "assistant/message", { text: `Running the build now. Authorization: bearer ${SECRET}` }),
      ev(id, 3, "tool/call", { callId: "c1", tool: "bash", input }),
    ] });
  };
  const host = {
    services,
    spaceStorage(space: SpaceContext): SpaceStorage {
      return { root: join(root, space.spaceId), packageDir(id) { const path = join(root, space.spaceId, id); mkdirSync(path, { recursive: true }); return path; }, path(relative) { return join(root, space.spaceId, relative); } };
    },
    deployment: "local-trusted",
    projects: { async get(id: string) { return id.startsWith("project-") ? { id, spaceId: id.slice("project-".length) } : undefined; } },
    systemSpaceContext: (spaceId: string) => ({ spaceId, userId: "system:polyth-runtime", storageDir: join(root, spaceId) }) as SpaceContext,
    forSpace(space: SpaceContext) {
      const own = (id: string) => { const s = sessions.get(id); if (!s || s.spaceId !== space.spaceId) throw Object.assign(new Error("not found"), { code: "not-found" }); return s; };
      return { projects: { async get(id: string) { return id === `project-${space.spaceId}` ? { id } : undefined; } }, sessions: {
        async events(id: string) { reads.push({ sessionId: id, spaceId: space.spaceId }); return [...own(id).events]; },
        async keepToolRunning(id: string, callId: string, options: unknown) {
          own(id);
          if (keepError) throw keepError;
          kept.push({ sessionId: id, callId, options, spaceId: space.spaceId });
        },
      } };
    },
    store: {
      async projection(id: string) { const s = sessions.get(id); return s && { id, spaceId: s.spaceId, projectId: `project-${s.spaceId}`, status: "running" } as unknown as SessionProjection; },
      async events(id: string) { return [...(sessions.get(id)?.events ?? [])]; },
    },
    events: { async append(sessionId: string, type: string, data: Record<string, unknown>) { appended.push({ sessionId, type, data }); return {} as SessionEvent; } },
  } as unknown as ServerPackageHost;
  const judgmentPkg = registerJudgment(host);
  const service = services.require(JUDGMENT_SERVICE);
  const engine = createFakeJudgmentEngine({ id: "agent", acceptAnyTarget: true, script: Array.from({ length: 50 }, () => async (request: ProviderJudgmentRequest) => {
    const response = reply(request);
    if (response instanceof JudgmentExecutionError) throw response;
    return response;
  }) });
  service.registerEngine({ metadata: engine.metadata, create: () => engine, catalog: () => [] });
  const pkg = registerJudges(host);
  t.after(() => { pkg.onDisable?.(); judgmentPkg.onDisable?.(); });
  const settings = async (uses: Record<string, unknown>) => {
    let revision = 0;
    const base = { space: a, path: "/api/judgment/settings", url: new URL("http://localhost/api/judgment/settings?projectId=project-space-a"), body: async () => ({}) };
    await judgmentPkg.routes!({ ...base, method: "GET", json: (_: number, data: { revision: number }) => { revision = data.revision; } } as unknown as Parameters<RouteHandler>[0]);
    await judgmentPkg.routes!({ ...base, method: "PUT", body: async () => ({ revision, level: "global", config: { enabled: true, uses } }), json: () => {} } as unknown as Parameters<RouteHandler>[0]);
  };
  const fire = async (patch: Partial<ServerToolQuietEvent> = {}) => {
    const now = Date.now();
    const event: ServerToolQuietEvent = { sessionId: "s1", callId: "c1", tool: "bash", startedAt: now - 9.5 * 60_000, quietSince: now - 9 * 60_000,
      stopsAt: now + 60_000, spaceId: "space-a", projectId: "project-space-a", ...patch };
    for (const listener of listeners) await listener(event);
    await new Promise((resolve) => setTimeout(resolve, 60));
  };
  return { a, pkg, judgmentPkg, engine, appended, kept, reads, listeners, addSession, settings, fire, failKeep: (error: unknown) => { keepError = error; } };
}
const on = (extra: Record<string, unknown> = {}) => ({ [QUIET_COMMAND_USE]: { enabled: true, ...(Object.keys(extra).length ? { params: extra } : {}) } });

test("a confident working answer keeps the call with exactly the judge attribution and records it", async (t) => {
  const f = fixture(t, () => answer({ working: 0.9, stuck: 0.05, cannot_tell: 0.05 }));
  f.addSession("s1", "space-a");
  await f.pkg.onEnable?.(); await f.judgmentPkg.onEnable?.();
  await f.settings(on());
  await f.fire();
  assert.deepEqual(f.kept.map(({ sessionId, callId, options, spaceId }) => ({ sessionId, callId, options, spaceId })),
    [{ sessionId: "s1", callId: "c1", options: { via: "judge", useId: "judges.quiet-command" }, spaceId: "space-a" }]);
  assert.equal(f.appended.length, 1);
  assert.equal(f.appended[0]!.type, ASSESSMENT_EVENT);
  assert.equal(f.appended[0]!.data.useId, "judges.quiet-command");
});

test("only a working answer at or above the threshold keeps; everything else leaves the stop to run", async (t) => {
  for (const [label, reply, params] of [
    ["stuck", answer({ working: 0.1, stuck: 0.85, cannot_tell: 0.05 }), {}],
    ["cannot_tell", answer({ working: 0.2, stuck: 0.1, cannot_tell: 0.7 }), {}],
    ["low probability", answer({ working: 0.6, stuck: 0.3, cannot_tell: 0.1 }), {}],
    ["below a raised threshold", answer({ working: 0.9, stuck: 0.05, cannot_tell: 0.05 }), { threshold: 0.95 }],
    ["engine error", new JudgmentExecutionError("provider-unavailable"), {}],
    ["engine timeout", new JudgmentExecutionError("timeout"), {}],
  ] as const) {
    const f = fixture(t, () => reply);
    f.addSession("s1", "space-a");
    await f.pkg.onEnable?.(); await f.judgmentPkg.onEnable?.();
    await f.settings(on(params));
    await f.fire();
    assert.equal(f.engine.calls.length, 1, `${label}: the judge was asked`);
    assert.deepEqual(f.kept, [], label);
    assert.deepEqual(f.appended, [], label);
  }
});

test("a disabled use, a missing spaceId and too little time ask nothing and keep nothing", async (t) => {
  const off = fixture(t, () => answer({ working: 1, stuck: 0, cannot_tell: 0 }));
  off.addSession("s1", "space-a");
  await off.pkg.onEnable?.(); await off.judgmentPkg.onEnable?.();
  await off.fire();
  assert.deepEqual(off.kept, []);
  assert.deepEqual(off.reads, []);
  const f = fixture(t, () => answer({ working: 1, stuck: 0, cannot_tell: 0 }));
  f.addSession("s1", "space-a");
  await f.pkg.onEnable?.(); await f.judgmentPkg.onEnable?.();
  await f.settings(on());
  await f.fire({ spaceId: undefined });
  await f.fire({ stopsAt: Date.now() + 9_000 });
  assert.equal(f.engine.calls.length, 0);
  assert.deepEqual(f.kept, []);
  assert.deepEqual(f.reads, []);
  await f.fire({ stopsAt: Date.now() + 60_000 });
  assert.equal(f.kept.length, 1, "control: the same call with time left is kept");
});

test("a conflict (the call already ended) is swallowed without a warning", async (t) => {
  const f = fixture(t, () => answer({ working: 0.95, stuck: 0.03, cannot_tell: 0.02 }));
  f.addSession("s1", "space-a");
  f.failKeep(Object.assign(new Error("call ended"), { code: "conflict" }));
  await f.pkg.onEnable?.(); await f.judgmentPkg.onEnable?.();
  await f.settings(on());
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  await f.fire();
  assert.deepEqual(f.kept, []);
  assert.deepEqual(f.appended, [], "nothing was kept, so nothing is recorded");
  assert.deepEqual(warnings, []);
});

test("evidence is redacted and read only from the event's own Space", async (t) => {
  const f = fixture(t, () => answer({ working: 0.9, stuck: 0.05, cannot_tell: 0.05 }));
  f.addSession("s1", "space-a");
  // A foreign Space holds a session with the same id shape and a distinctive command.
  f.addSession("s2", "space-b", { command: "FOREIGN-SPACE-COMMAND" });
  await f.pkg.onEnable?.(); await f.judgmentPkg.onEnable?.();
  await f.settings(on());
  await f.fire();
  await f.fire({ sessionId: "s2", spaceId: "space-a" });
  const sent = JSON.stringify(f.engine.calls);
  assert.ok(f.engine.calls.length >= 1);
  assert.ok(!sent.includes(SECRET), "the token never reaches the engine");
  assert.ok(sent.includes("[redacted]"));
  assert.ok(sent.includes("make all") && sent.includes("Build everything") && sent.includes("Running the build now"));
  assert.ok(!sent.includes("FOREIGN-SPACE-COMMAND"), "another Space's session is unreadable through this Space's facade");
  assert.ok(f.reads.every((read) => read.spaceId === "space-a"));
  const state = f.engine.calls[0]!.state as Record<string, unknown>;
  assert.equal(state.tool, "bash");
  assert.equal(state.everShowedActivity, true);
  assert.equal(state.minutesQuiet, 9);
});

test("call input reads shell and Antigravity shapes", () => {
  assert.equal(callInputText({ command: "npm test" }), "npm test");
  assert.equal(callInputText({ CommandLine: "make", Description: "Build" }), "make (Build)");
  assert.equal(callInputText({ command: ["ls", "-la"] }), "ls -la");
  assert.equal(callInputText(undefined), "");
});

test("a facade that cannot keep a call asks no judge and never records a keep", async () => {
  const untouched = new Proxy({}, { get() { throw new Error("the judge was consulted"); } });
  const now = Date.now();
  const outcome = await runQuietCommand({
    judgment: untouched as never,
    sessions: { async events() { throw new Error("events were read"); } } as never,
    space: { spaceId: "space-a", userId: "system:polyth-runtime" } as SpaceContext,
  }, { sessionId: "s1", callId: "c1", tool: "bash", startedAt: now - 9.5 * 60_000, quietSince: now - 9 * 60_000, stopsAt: now + 60_000, spaceId: "space-a" });
  assert.deepEqual(outcome, { kept: false, reason: "ended" });
});

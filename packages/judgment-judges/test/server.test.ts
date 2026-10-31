import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RouteHandler, SessionEvent, SessionProjection, SpaceContext, SpaceStorage } from "@polyth/contracts";
import { createServerServiceRegistry, discoverServerPackages, SERVER_TURN_COMPLETION_BUS, type ServerPackageHost, type ServerTurnCompletedEvent } from "@polyth/plugins";
// The discovered Judgment server entry is not an export; tests compose it like the host does.
import registerJudgment from "../../judgment/src/serverEntry.ts";
import { JUDGMENT_SERVICE } from "@polyth/judgment/server";
import { createFakeJudgmentEngine } from "@polyth/judgment/testing";
import { JudgmentExecutionError, type ProviderJudgmentRequest, type ProviderJudgmentResponse } from "@polyth/judgment";
import registerJudges from "../src/serverEntry.ts";
import { reserveCall, usageToday } from "../src/store.ts";
import { KEEP_ALIVE_PROMPT } from "../src/keepWarm.ts";
import { ASSESSMENT_EVENT, type BacktestResult, type JudgeInput, type JudgesSnapshot } from "../src/types.ts";

const scratch = resolve(import.meta.dirname, "../../../.scratch/judgment-judges");
type Answer = ProviderJudgmentResponse | JudgmentExecutionError;

function turn(sessionId: string, base: number, answer = "Done. I updated composer.css and all tests pass."): SessionEvent[] {
  const event = (offset: number, type: string, data: Record<string, unknown>, ignorable = false): SessionEvent =>
    ({ id: `${sessionId}-${base + offset}`, sessionId, seq: base + offset, time: 1_000 + base + offset, type, data: data as never, v: 1, ...(ignorable ? { ignorable } : {}) });
  return [
    event(0, "user/message", { text: "Fix the composer padding. My token=supersecretvalue123" }),
    event(1, "turn/started", { turnId: `t${base}` }),
    event(2, "tool/call", { callId: `c${base}`, tool: "bash", input: { command: "npm test -- composer" } }),
    event(3, "tool/result", { callId: `c${base}`, tool: "bash", output: "ok" }),
    event(4, "tool/call", { callId: `e${base}`, tool: "edit", input: { filePath: "apps/web/composer.css" } }),
    event(5, "task/snapshot", { listId: "l", revision: 1, items: [{ id: "1", text: "Check phone width", status: "pending" }, { id: "2", text: "Done item", status: "done" }] }),
    event(6, "assistant/message", { text: answer }),
    event(7, "turn/stopped", { reason: "completed" }),
  ];
}

function fixture(t: test.TestContext, answers: (request: ProviderJudgmentRequest) => Answer) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "server-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = { spaceId: "space-a", userId: "user-a" } as SpaceContext, b = { spaceId: "space-b", userId: "user-b" } as SpaceContext;
  const services = createServerServiceRegistry();
  const listeners = new Set<(event: ServerTurnCompletedEvent) => void | Promise<void>>();
  services.provide(SERVER_TURN_COMPLETION_BUS, { subscribe(listener) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; } });
  const sessions = new Map<string, { projection: SessionProjection; events: SessionEvent[] }>();
  const appended: Array<{ sessionId: string; type: string; data: Record<string, unknown>; opts: unknown }> = [];
  const sent: Array<{ sessionId: string; input: Record<string, unknown> }> = [];
  const addSession = (id: string, space: SpaceContext, patch: Partial<SessionProjection> = {}, events = turn(id, 1)) => {
    sessions.set(id, { projection: { id, projectId: `project-${space.spaceId}`, spaceId: space.spaceId, title: `Chat ${id}`, status: "idle",
      createdAt: 1, updatedAt: 2, lastTurnAt: 2, ...patch } as SessionProjection, events });
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
      return {
        projects: { async get(id: string) { return id === `project-${space.spaceId}` ? { id } : undefined; } },
        sessions: {
          async list(projectId: string) { return [...sessions.values()].map((s) => s.projection).filter((p) => p.spaceId === space.spaceId && p.projectId === projectId); },
          async queueList() { return []; },
          async send(sessionId: string, input: Record<string, unknown>) { sent.push({ sessionId, input }); return {}; },
        },
      };
    },
    store: {
      async projection(id: string) { return sessions.get(id)?.projection; },
      async events(id: string) { return [...(sessions.get(id)?.events ?? [])]; },
    },
    events: {
      async append(sessionId: string, type: string, data: Record<string, unknown>, opts: unknown) {
        appended.push({ sessionId, type, data, opts });
        const session = sessions.get(sessionId)!;
        const event = { id: `x${appended.length}`, sessionId, seq: session.events.length + 100, time: 9_999, type, data, v: 1, ignorable: true } as SessionEvent;
        session.events.push(event);
        return event;
      },
    },
  } as unknown as ServerPackageHost;
  const judgmentPkg = registerJudgment(host);
  const service = services.require(JUDGMENT_SERVICE);
  const engine = createFakeJudgmentEngine({ id: "agent", acceptAnyTarget: true, script: Array.from({ length: 200 }, () => async (request: ProviderJudgmentRequest) => {
    const answer = answers(request);
    if (answer instanceof JudgmentExecutionError) throw answer;
    return answer;
  }) });
  service.registerEngine({ metadata: engine.metadata, create: () => engine, catalog: () => [] });
  const pkg = registerJudges(host);
  t.after(() => { pkg.onDisable?.(); judgmentPkg.onDisable?.(); });
  const call = async <T = JudgesSnapshot>(space: SpaceContext, path: string, method = "GET", body: unknown = {}, projectId = `project-${space.spaceId}`) => {
    let value: unknown, status = 0;
    const [pathname, search = ""] = path.split("?");
    const handled = await pkg.routes!({ space, path: pathname!, method, url: new URL(`http://localhost${pathname}?projectId=${projectId}${search ? `&${search}` : ""}`),
      body: async () => body, json: (code: number, data: unknown) => { status = code; value = data; } } as unknown as Parameters<RouteHandler>[0]);
    assert.equal(handled, true, `${method} ${path} handled`);
    assert.equal(status, 200);
    return value as T;
  };
  const judgmentSettings = async (uses: Record<string, unknown>) => {
    let revision = 0;
    await judgmentPkg.routes!({ space: a, path: "/api/judgment/settings", method: "GET", url: new URL(`http://localhost/api/judgment/settings?projectId=project-space-a`),
      body: async () => ({}), json: (_: number, data: { revision: number }) => { revision = data.revision; } } as unknown as Parameters<RouteHandler>[0]);
    await judgmentPkg.routes!({ space: a, path: "/api/judgment/settings", method: "PUT", url: new URL(`http://localhost/api/judgment/settings?projectId=project-space-a`),
      body: async () => ({ revision, level: "global", config: { enabled: true, uses } }), json: () => {} } as unknown as Parameters<RouteHandler>[0]);
  };
  const complete = async (sessionId: string) => { for (const listener of listeners) await listener({ sessionId, assistantText: "" }); };
  return { root, a, b, pkg, judgmentPkg, engine, appended, sent, listeners, addSession, sessions, call, judgmentSettings, complete };
}

const until = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), label);
};
const quiet = () => new Promise((resolve) => setTimeout(resolve, 60));
const choiceAnswer = (probabilities: Record<string, number>) => {
  const value = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0]![0];
  return { type: "choice" as const, value, confidence: 0.9, probabilities };
};
const noulAnswer = (probability: number) => ({ type: "noul" as const, probability, confidence: 0.9 });
const judge = (patch: Partial<JudgeInput> = {}): JudgeInput => ({ name: "Scope creep", enabled: true, trigger: "turn-completed", filters: {},
  evidence: [{ pick: "last-request", maxChars: 300 }, { pick: "changed-files", maxChars: 300 }],
  question: { type: "noul", text: "Did the assistant change files it was not asked to touch?" }, fire: { threshold: 0.6, margin: 0.1 },
  effects: [{ kind: "timeline-marker" }, { kind: "suggest-follow-up", text: "Explain why each file changed." }], dailyCap: 40, ...patch });

test("the package is discovered from its manifest without host registries", async () => {
  const entries = await discoverServerPackages(resolve(import.meta.dirname, "../.."));
  const entry = entries.find((candidate) => candidate.id === "judgment-judges");
  assert.ok(entry);
  assert.equal(entry.descriptor.settingsGroup, "Engineering");
});

test("judges persist per Space with revision CAS, safe ids and project validation", async (t) => {
  const f = fixture(t, () => ({ answers: {} }));
  await f.pkg.onEnable?.();
  assert.deepEqual((await f.call(f.a, "/api/judges")).judges, []);
  const created = await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: judge() });
  assert.equal(created.revision, 1);
  const id = created.judges[0]!.id;
  assert.match(id, /^j[0-9a-f]{12}$/);
  await assert.rejects(f.call(f.a, "/api/judges", "POST", { revision: 0, judge: judge({ name: "Stale" }) }), /changed; reload/);
  const updated = await f.call(f.a, `/api/judges/${id}`, "PUT", { revision: 1, judge: judge({ name: "Renamed", enabled: false }) });
  assert.equal(updated.judges[0]!.name, "Renamed"); assert.equal(updated.judges[0]!.enabled, false);
  assert.equal(updated.judges[0]!.createdAt, created.judges[0]!.createdAt);
  // Another Space sees nothing and cannot address this Space's project or judge.
  assert.deepEqual((await f.call(f.b, "/api/judges")).judges, []);
  await assert.rejects(f.call(f.a, "/api/judges", "GET", {}, "project-space-b"), /Project not found/);
  await assert.rejects(f.call(f.b, `/api/judges/${id}`, "PUT", { revision: 0, judge: judge() }), /Judge not found/);
  await assert.rejects(f.call(f.a, "/api/judges", "POST", { revision: 2, judge: judge({ filters: { projectId: "project-space-b" } }) }), /Project not found/);
  // Ids that are not server-generated never reach storage.
  const unhandled = await f.pkg.routes!({ space: f.a, path: "/api/judges/..%2Fescape", method: "PUT", url: new URL("http://localhost/api/judges/x?projectId=project-space-a"),
    body: async () => ({}), json: () => {} } as unknown as Parameters<RouteHandler>[0]);
  assert.equal(unhandled, false);
  await assert.rejects(f.call(f.a, `/api/judges/${id}`, "DELETE", {}), /changed; reload/, "a delete without the revision is refused");
  const removed = await f.call(f.a, `/api/judges/${id}?revision=2`, "DELETE");
  assert.deepEqual(removed.judges, []);
  assert.deepEqual(f.pkg.remoteAccess, { routeScopes: ["judges"], http: [] });
  // Corrupt storage fails loudly instead of resetting the list.
  writeFileSync(join(f.root, "space-a", "judgment-judges", "judges.json"), "{not json");
  await assert.rejects(f.call(f.a, "/api/judges"), /unreadable/);
});

test("effects come only from the fixed allowlist", async (t) => {
  const f = fixture(t, () => ({ answers: {} }));
  for (const kind of ["approve", "execute", "merge", "send", "send-prompt"]) {
    await assert.rejects(f.call(f.a, "/api/judges", "POST", { revision: 0, judge: judge({ effects: [{ kind } as never] }) }), /Unknown effect/, kind);
  }
  await assert.rejects(f.call(f.a, "/api/judges", "POST", { revision: 0, judge: judge({ effects: [{ kind: "timeline-marker", command: "rm -rf" } as never] }) }), /unknown field/);
  await assert.rejects(f.call(f.a, "/api/judges", "POST", { revision: 0, judge: { ...judge(), autoSend: true } }), /unknown field/);
  await assert.rejects(f.call(f.a, "/api/judges", "POST", { revision: 0, judge: judge({ evidence: [{ pick: "environment" as never, maxChars: 300 }] }) }), /evidence/i);
  await assert.rejects(f.call(f.a, "/api/judges", "POST", { revision: 0, judge: judge({ question: { type: "choice", text: "Which?", labels: [{ label: "only", description: "One." }] } }) }), /2–8/);
  assert.equal(existsSync(join(f.root, "space-a", "judgment-judges", "judges.json")), false);
});

test("the daily cap is enforced server-side and survives a new package instance", (t) => {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "usage.json"), day = Date.UTC(2026, 9, 11, 12);
  assert.equal(reserveCall(file, "jaaaaaaaaaaaa", 2, day), true);
  assert.equal(reserveCall(file, "jaaaaaaaaaaaa", 2, day), true);
  assert.equal(reserveCall(file, "jaaaaaaaaaaaa", 2, day), false);
  assert.equal(reserveCall(file, "jbbbbbbbbbbbb", 2, day), true, "each judge has its own cap");
  assert.deepEqual(usageToday(file, day).jaaaaaaaaaaaa, { day: "2026-10-11", count: 2 });
  assert.equal(reserveCall(file, "jaaaaaaaaaaaa", 2, day + 86_400_000), true, "a new UTC day starts at zero");
  writeFileSync(file, "garbage");
  assert.equal(reserveCall(file, "jaaaaaaaaaaaa", 2, day), false, "an unreadable ledger never lifts the cap");
});

test("backtest answers the newest turns, records nothing and counts toward the cap", async (t) => {
  const f = fixture(t, (request) => ({ answers: { answer: noulAnswer(request.state && JSON.stringify(request.state).includes("composer.css") ? 0.9 : 0.2) } }));
  await f.pkg.onEnable?.(); await f.judgmentPkg.onEnable?.();
  f.addSession("s1", f.a, { lastTurnAt: 10 });
  f.addSession("s2", f.a, { lastTurnAt: 20 }, [...turn("s2", 1), ...turn("s2", 20, "Answered your question.")]);
  f.addSession("child", f.a, { parentId: "s1", lastTurnAt: 30 });
  f.addSession("old", f.a, { status: "archived", lastTurnAt: 40 });
  f.addSession("foreign", f.b, { lastTurnAt: 50 });
  const { judges: [saved] } = await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: judge({ dailyCap: 3, evidence: [{ pick: "changed-files", maxChars: 300 }] }) });
  const result = await f.call<BacktestResult>(f.a, `/api/judges/${saved!.id}/backtest`, "POST", { limit: 25 });
  assert.equal(result.rows.length, 3, "three completed top-level turns in this Space's project");
  assert.deepEqual(result.rows.map((row) => row.sessionId).sort(), ["s1", "s2", "s2"]);
  assert.ok(result.rows.every((row) => row.wouldFire && row.probability === 0.9));
  assert.deepEqual(f.appended, [], "a backtest records nothing");
  assert.deepEqual(result.usage.count, 3);
  const capped = await f.call<BacktestResult>(f.a, `/api/judges/${saved!.id}/backtest`, "POST", { limit: 2 });
  assert.ok(capped.rows.every((row) => row.skipped === "cap" && !row.wouldFire));
  assert.equal(f.engine.calls.length, 3, "nothing is asked once the cap is spent");
  await assert.rejects(f.call(f.a, `/api/judges/${saved!.id}/backtest`, "POST", { limit: 26 }), /1–25/);
  // Evidence is bounded to the picks: the request text never left.
  assert.doesNotMatch(JSON.stringify(f.engine.calls), /supersecretvalue|Fix the composer/);
});

test("completion check records an ignorable assessment only on a confident claimed-only", async (t) => {
  let outcome: Answer = { answers: { outcome: choiceAnswer({ verified: 0.1, claimed_only: 0.8, cannot_tell: 0.1 }) } };
  const f = fixture(t, (request) => (request.questions.outcome ? outcome : new JudgmentExecutionError("invalid-request")));
  await f.pkg.onEnable?.(); await f.judgmentPkg.onEnable?.();
  f.addSession("s1", f.a);
  await f.complete("s1"); await quiet();
  assert.equal(f.engine.calls.length, 0, "an opt-in use that is off asks nothing");
  await f.judgmentSettings({ "judges.completion-check": { enabled: true, params: { suggestFollowUp: true } } });
  // A turn is considered once: the earlier turn stays unjudged, the next one is asked.
  f.sessions.get("s1")!.events.push(...turn("s1", 20));
  await f.complete("s1");
  await until(() => f.appended.length === 1, "assessment recorded");
  const [entry] = f.appended;
  assert.equal(entry!.type, ASSESSMENT_EVENT);
  assert.deepEqual(entry!.opts, { ignorable: true, producerPlugin: "judgment-judges" });
  assert.equal(entry!.data.label, "claimed_only"); assert.equal(entry!.data.useId, "judges.completion-check");
  assert.equal(entry!.data.scope, "judges.completion-check.v1");
  assert.match(entry!.data.followUp as string, /verify/);
  const request = f.engine.calls.find((call) => call.questions.outcome)!;
  const state = request.state as Record<string, unknown>;
  assert.deepEqual(state.commandsRun, ["[ok] npm test -- composer"]);
  assert.deepEqual(state.changedFiles, ["apps/web/composer.css"]);
  assert.deepEqual(state.openTodos, ["Check phone width"]);
  assert.doesNotMatch(JSON.stringify(state), /supersecretvalue123/, "credentials are redacted before judging");
  // The same turn is never judged twice.
  await f.complete("s1"); await quiet();
  assert.equal(f.appended.length, 1);

  for (const [label, next] of [
    ["low margin", { answers: { outcome: choiceAnswer({ verified: 0.05, claimed_only: 0.5, cannot_tell: 0.45 }) } }],
    ["below threshold", { answers: { outcome: choiceAnswer({ verified: 0.35, claimed_only: 0.6, cannot_tell: 0.05 }) } }],
    ["verified", { answers: { outcome: choiceAnswer({ verified: 0.9, claimed_only: 0.05, cannot_tell: 0.05 }) } }],
    ["provider failure", new JudgmentExecutionError("provider-unavailable")],
    ["invalid response", { answers: { outcome: { type: "noul", probability: 1, confidence: 1 } } } as never],
  ] as Array<[string, Answer]>) {
    outcome = next;
    const id = `s-${label.replace(/\s/g, "-")}`;
    f.addSession(id, f.a);
    const before = f.engine.calls.length;
    await f.complete(id);
    await until(() => f.engine.calls.length > before, `${label} asked`); await quiet();
    assert.equal(f.appended.length, 1, `${label} records nothing`);
  }
});

test("needs-you records the probability, and failure or skipped sessions record nothing", async (t) => {
  let waiting: Answer = { answers: { waiting: noulAnswer(0.92) } };
  const f = fixture(t, (request) => (request.questions.waiting ? waiting : new JudgmentExecutionError("invalid-request")));
  await f.pkg.onEnable?.(); await f.judgmentPkg.onEnable?.();
  await f.judgmentSettings({ "judges.needs-you": { enabled: true } });
  f.addSession("s1", f.a, {}, turn("s1", 1, `${"x".repeat(900)} Should I also update the tablet layout, or leave it?`));
  await f.complete("s1");
  await until(() => f.appended.length === 1, "assessment recorded");
  assert.equal(f.appended[0]!.data.kind, "needs-you"); assert.equal(f.appended[0]!.data.probability, 0.92); assert.equal(f.appended[0]!.data.attention, true);
  const state = f.engine.calls[0]!.state as string;
  assert.equal(typeof state, "string"); assert.ok(state.length <= 400, "short evidence: the tail of the final answer");
  assert.match(state, /tablet layout, or leave it\?$/);

  // Delegated children, archived sessions and pending imports are never judged.
  f.addSession("child", f.a, { parentId: "s1" });
  f.addSession("archived", f.a, { status: "archived" });
  f.addSession("importing", f.a, { historyImport: { state: "in-progress", count: 3 } });
  for (const id of ["child", "archived", "importing"]) await f.complete(id);
  await quiet();
  assert.equal(f.engine.calls.length, 1);

  waiting = new JudgmentExecutionError("timeout");
  f.addSession("s2", f.a);
  await f.complete("s2");
  await until(() => f.engine.calls.length === 2, "asked"); await quiet();
  assert.equal(f.appended.length, 1, "failure means no event, so notifications stay as they are");
  waiting = { answers: { waiting: noulAnswer(0.3) } };
  f.addSession("s3", f.a);
  await f.complete("s3");
  await until(() => f.engine.calls.length === 3, "asked"); await quiet();
  assert.equal(f.appended.length, 1, "below the threshold records nothing");
});

test("custom judges fire live with allowlisted effects; disabling unsubscribes", async (t) => {
  const f = fixture(t, (request) => request.questions.answer
    ? { answers: { answer: choiceAnswer({ creep: 0.85, fine: 0.15 }) } }
    : new JudgmentExecutionError("invalid-request"));
  await f.pkg.onEnable?.(); await f.judgmentPkg.onEnable?.();
  const { judges: [saved] } = await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: judge({
    question: { type: "choice", text: "Scope?", labels: [{ label: "creep", description: "Touched unrelated files." }, { label: "fine", description: "Stayed in scope." }] },
    fire: { label: "creep", threshold: 0.7, margin: 0.3 }, effects: [{ kind: "needs-attention" }, { kind: "suggest-follow-up", text: "Explain each changed file." }] }) });
  f.addSession("s1", f.a);
  await f.complete("s1");
  await until(() => f.appended.length === 1, "custom assessment recorded");
  const data = f.appended[0]!.data;
  assert.equal(data.kind, "custom"); assert.equal(data.judgeId, saved!.id); assert.equal(data.scope, `judges.custom.${saved!.id}.v1`);
  assert.equal(data.label, "creep"); assert.equal(data.attention, true); assert.equal(data.followUp, "Explain each changed file.");
  assert.equal(f.engine.calls.at(-1)!.scope, `judges.custom.${saved!.id}.v1`);
  assert.equal((await f.call(f.a, "/api/judges")).usage[saved!.id]!.count, 1);

  await f.pkg.onDisable?.();
  assert.equal(f.listeners.size, 0, "the completion subscription is disposed on disable");
  await f.pkg.onEnable?.();
  assert.equal(f.listeners.size, 1);
  assert.ok(readFileSync(join(f.root, "space-a", "judgment-judges", "judges.json"), "utf8").includes('"version":1'));
});

test("keep warm pings a clearly unfinished chat with a hidden keep-alive, and not a finished one", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let unfinished = 0.9;
  const f = fixture(t, (request) => request.questions.work
    ? { answers: { work: choiceAnswer({ unfinished, finished: 1 - unfinished - 0.02, cannot_tell: 0.02 }) } }
    : new JudgmentExecutionError("invalid-request"));
  await f.pkg.onEnable?.(); await f.judgmentPkg.onEnable?.();
  await f.judgmentSettings({ "judges.keep-warm": { enabled: true } });
  // Anthropic's 5-minute cache, last written 4.5 minutes ago: a keep-alive is due now.
  const cached = (sessionId: string, seq: number): SessionEvent => ({ id: `${sessionId}-u${seq}`, sessionId, seq, time: Date.now() - 270_000, type: "usage/recorded", v: 1,
    data: { tokens: { input: 10, output: 5, cacheRead: 60_000, cacheWrite: 2_000 }, model: { providerID: "anthropic", modelID: "claude" } } as never });
  f.addSession("s1", f.a, {}, [...turn("s1", 1, "Should I also update the tablet layout, or leave it?"), cached("s1", 50)]);
  await f.complete("s1");
  await until(() => f.engine.calls.length === 1, "asked whether the work is unfinished");
  assert.equal(f.engine.calls[0]!.scope, "judges.keep-warm.v1");
  assert.doesNotMatch(JSON.stringify(f.engine.calls[0]!.state), /supersecretvalue123/);
  await quiet();
  t.mock.timers.tick(15_000);
  await until(() => f.sent.length === 1, "keep-alive sent");
  assert.deepEqual(f.sent[0], { sessionId: "s1", input: { text: KEEP_ALIVE_PROMPT, hiddenUserMessage: true, memory: { read: "off", remember: "off" } } });
  assert.deepEqual(f.appended, [], "keeping warm records nothing in the chat");

  // The keep-alive's own turn is not judged and does not re-arm.
  const events = f.sessions.get("s1")!.events;
  events.push({ id: "k1", sessionId: "s1", seq: 60, time: Date.now(), type: "user/message", v: 1, data: { text: KEEP_ALIVE_PROMPT, hiddenUserMessage: true } as never },
    { id: "k2", sessionId: "s1", seq: 61, time: Date.now(), type: "assistant/message", v: 1, data: { text: "OK" } as never },
    { ...cached("s1", 62), time: Date.now() },
    { id: "k3", sessionId: "s1", seq: 63, time: Date.now(), type: "turn/stopped", v: 1, data: { reason: "completed" } as never });
  await f.complete("s1"); await quiet();
  assert.equal(f.engine.calls.length, 1);

  // A finished chat, and one without cache telemetry, are never pinged.
  unfinished = 0.1;
  f.addSession("s2", f.a, {}, [...turn("s2", 1, "Done; everything is merged."), cached("s2", 50)]);
  f.addSession("s3", f.a, {}, turn("s3", 1, "Should I continue?"));
  await f.complete("s2"); await f.complete("s3");
  await until(() => f.engine.calls.length === 2, "only the cached chat is asked"); await quiet();
  t.mock.timers.tick(15_000); await quiet();
  assert.deepEqual(f.sent.map((entry) => entry.sessionId), ["s1"]);

  await f.pkg.onDisable?.();
  t.mock.timers.tick(60_000); await quiet();
  assert.equal(f.sent.length, 1, "disabling stops keeping warm");
});

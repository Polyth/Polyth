// Judge actions: triggers, owner-scoped access and every action's guard,
// through the real Judgment server entry with a scripted fake engine. No
// network, no paid calls, no real session service.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RouteHandler, SessionEvent, SessionProjection, SpaceContext, SpaceStorage, TurnAdmission, UserTurnInput } from "@polyth/contracts";
import {
  createServerServiceRegistry, SERVER_MODEL_ROUTING, SERVER_PERMISSION_WAITING_BUS, SERVER_SESSION_ISOLATION, SERVER_TURN_COMPLETION_BUS,
  SERVER_TURN_STOPPED_BUS, type ServerModelRoutingReport, type ServerPackageHost, type ServerPermissionWaitingEvent,
  type ServerTurnCompletedEvent, type ServerTurnStoppedEvent,
} from "@polyth/plugins";
import registerJudgment from "../../judgment/src/serverEntry.ts";
import { JUDGMENT_SERVICE } from "@polyth/judgment/server";
import { createFakeJudgmentEngine } from "@polyth/judgment/testing";
import { JudgmentExecutionError, type ProviderJudgmentRequest, type ProviderJudgmentResponse } from "@polyth/judgment";
import registerJudges from "../src/serverEntry.ts";
import { runAction } from "../src/actions.ts";
import {
  ASSESSMENT_EVENT, MESSAGE_PRESETS, REQUEST_CHECK_EVENT, REQUEST_VERDICT_EVENT, type AssessmentData, type BacktestResult, type JudgeInput,
  type JudgesSnapshot, type RequestCheckData, type RequestVerdictData,
} from "../src/types.ts";

const scratch = resolve(import.meta.dirname, "../../../.scratch/judgment-judges");
type Answer = ProviderJudgmentResponse | JudgmentExecutionError;
const CONTINUE = MESSAGE_PRESETS[0].text;

const ev = (sessionId: string, seq: number, type: string, data: Record<string, unknown>): SessionEvent =>
  ({ id: `${sessionId}-${seq}`, sessionId, seq, time: 1_000 + seq, type, data: data as never, v: 1 });
function turn(sessionId: string, base: number, answer: string, author?: Record<string, unknown>): SessionEvent[] {
  return [
    ev(sessionId, base, "user/message", { text: author ? CONTINUE : "Build the export button.", ...(author ? { author } : {}) }),
    ev(sessionId, base + 1, "turn/started", { turnId: `t${base}` }),
    ev(sessionId, base + 2, "assistant/message", { text: answer }),
    ev(sessionId, base + 3, "turn/stopped", { reason: "completed" }),
  ];
}
const permissionRequest = (sessionId: string, seq: number, requestId: string): SessionEvent[] => [
  ev(sessionId, 1, "user/message", { text: "Run the test suite." }),
  ev(sessionId, 2, "turn/started", { turnId: "t1" }),
  ev(sessionId, seq, "permission/requested", { requestId, permission: "bash", tool: "shell", patterns: ["npm test"],
    preview: { title: "bash via shell", lines: ["npm test", "token=abcd1234secret"], risk: "medium" } }),
];

function fixture(t: test.TestContext, answers: (request: ProviderJudgmentRequest) => Answer) {
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "actions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const person = (userId: string) => ({ spaceId: "space-a", userId, role: "member", storageDir: join(root, "space-a") }) as SpaceContext;
  const a = person("user-a"), c = person("user-c");
  const system = { spaceId: "space-a", userId: "system:polyth-runtime", storageDir: join(root, "space-a"), authority: { kind: "system" } } as unknown as SpaceContext;
  const services = createServerServiceRegistry();
  const bus = <E>() => {
    const listeners = new Set<(event: E) => void | Promise<void>>();
    return { listeners, service: { subscribe(listener: (event: E) => void | Promise<void>) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; } } };
  };
  const completion = bus<ServerTurnCompletedEvent>(), permissions = bus<ServerPermissionWaitingEvent>(), stops = bus<ServerTurnStoppedEvent>();
  services.provide(SERVER_TURN_COMPLETION_BUS, completion.service);
  services.provide(SERVER_PERMISSION_WAITING_BUS, permissions.service);
  services.provide(SERVER_TURN_STOPPED_BUS, stops.service);
  const log: string[] = [];
  const merges: string[] = [];
  let mergeStatus: { canMerge: boolean; isolated: boolean } = { canMerge: true, isolated: true };
  services.provide(SERVER_SESSION_ISOLATION, {
    async getStatus(sessionId: string) {
      return { isolation: mergeStatus.isolated ? { kind: "git-worktree", state: "merge-ready" } : null, suggestion: null,
        actions: { canReview: true, canMerge: mergeStatus.canMerge, canKeep: true, canResolve: false, canDiscard: true, canRecover: false, canAbandon: false } } as never;
    },
    async mergeBack(sessionId: string) { merges.push(sessionId); log.push(`merge:${sessionId}`); return { ok: true, commit: "abc1234def", targetBranch: "master", finalized: true } as never; },
  } as never);
  const routingCalls: Array<{ space: SpaceContext; pairs?: readonly string[] }> = [];
  let report: ServerModelRoutingReport | undefined;
  services.provide(SERVER_MODEL_ROUTING, {
    async candidates(space: SpaceContext, options: { pairs?: readonly string[] } = {}) {
      routingCalls.push({ space, ...(options.pairs ? { pairs: options.pairs } : {}) });
      if (!report) throw new Error("usage off");
      return report;
    },
  });

  const sessions = new Map<string, { projection: SessionProjection; events: SessionEvent[] }>();
  /** Chats each person cannot open; anyone not in `members` has left the Space. */
  const hiddenFrom = new Map<string, Set<string>>();
  const members = new Set(["user-a", "user-c"]);
  const sent: Array<{ sessionId: string; input: UserTurnInput; admission?: TurnAdmission; as: string }> = [];
  const replies: Array<{ sessionId: string; requestId: string; reply: string; as: string }> = [];
  const approvals: Array<{ sessionId: string; setting: string; as: string }> = [];
  let replyError: Error | undefined;
  /** Event types whose next append fails, once each. */
  const failingAppends = new Set<string>();
  const resumes: Array<{ sessionId: string; options: unknown; as: string }> = [];
  const appended: Array<{ sessionId: string; type: string; data: AssessmentData }> = [];
  const addSession = (id: string, patch: Partial<SessionProjection> = {}, events: SessionEvent[] = turn(id, 1, "Halfway there; the export still needs tests.")) => {
    sessions.set(id, { projection: { id, projectId: "project-space-a", spaceId: "space-a", title: `Chat ${id}`, status: "idle",
      createdAt: 1, updatedAt: 2, lastTurnAt: 2, ...patch } as SessionProjection, events });
  };
  const notFound = () => Object.assign(new Error("session not found"), { code: "not-found" });
  const facade = (space: SpaceContext) => {
    const visible = (id: string) => {
      const session = sessions.get(id);
      if (!session || hiddenFrom.get(space.userId)?.has(id)) throw notFound();
      return session;
    };
    return {
      async list(projectId: string) { return [...sessions.values()].map((s) => s.projection).filter((p) => p.projectId === projectId && !hiddenFrom.get(space.userId)?.has(p.id)); },
      async snapshot(id: string) { return structuredClone(visible(id).projection); },
      async queueList() { return []; },
      async send(id: string, input: UserTurnInput, admission?: TurnAdmission) {
        visible(id); log.push(`send:${id}`);
        sent.push({ sessionId: id, input, ...(admission ? { admission } : {}), as: space.userId }); return {} as never;
      },
      async replyPermission(id: string, requestId: string, reply: string) {
        const session = visible(id); log.push(`reply:${id}`);
        if (replyError) throw replyError;
        replies.push({ sessionId: id, requestId, reply, as: space.userId });
        session.events.push(ev(id, session.events.length + 500, "permission/resolved", { requestId, reply }));
      },
      async autoAcceptGet(id: string) { visible(id); return { setting: "inherit", effective: false }; },
      async autoAcceptSet(id: string, setting: string) { visible(id); approvals.push({ sessionId: id, setting, as: space.userId }); return { setting, effective: true }; },
      async resumeNow(id: string, options: unknown) {
        const session = visible(id); resumes.push({ sessionId: id, options, as: space.userId });
        delete session.projection.resume; return {} as never;
      },
    };
  };
  const host = {
    services,
    spaceStorage(space: SpaceContext): SpaceStorage {
      return { root: join(root, space.spaceId), packageDir(id) { const path = join(root, space.spaceId, id); mkdirSync(path, { recursive: true }); return path; }, path(relative) { return join(root, space.spaceId, relative); } };
    },
    deployment: "local-trusted",
    projects: { async get(id: string) { return id === "project-space-a" ? { id, spaceId: "space-a" } : undefined; } },
    systemSpaceContext: () => system,
    personSpaceContext: (userId: string, spaceId: string) => (members.has(userId) && spaceId === "space-a" ? person(userId) : undefined),
    forSpace(space: SpaceContext) {
      return { projects: { async get(id: string) { return id === "project-space-a" ? { id } : undefined; } }, sessions: facade(space) };
    },
    store: {
      async projection(id: string) { return sessions.get(id)?.projection; },
      async events(id: string) { return [...(sessions.get(id)?.events ?? [])]; },
    },
    events: {
      async append(sessionId: string, type: string, data: AssessmentData) {
        if (failingAppends.delete(type)) throw new Error("store unavailable");
        log.push(`record:${sessionId}`);
        appended.push({ sessionId, type, data });
        const session = sessions.get(sessionId)!;
        const event = { id: `x${appended.length}`, sessionId, seq: session.events.length + 100, time: 9_999, type, data, v: 1, ignorable: true } as unknown as SessionEvent;
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
  // Whose context each run was created for: an owned judge asks as its owner.
  const askedAs: string[] = [];
  service.registerEngine({ metadata: engine.metadata, create: (ctx) => { askedAs.push(ctx.space.userId); return engine; }, catalog: () => [] });
  const pkg = registerJudges(host);
  t.after(() => { pkg.onDisable?.(); judgmentPkg.onDisable?.(); });
  const call = async <T = JudgesSnapshot>(space: SpaceContext, path: string, method = "GET", body: unknown = {}) => {
    let value: unknown, status = 0;
    const [pathname, search = ""] = path.split("?");
    const handled = await pkg.routes!({ space, path: pathname!, method, url: new URL(`http://localhost${pathname}?projectId=project-space-a${search ? `&${search}` : ""}`),
      body: async () => body, json: (code: number, data: unknown) => { status = code; value = data; } } as unknown as Parameters<RouteHandler>[0]);
    assert.equal(handled, true, `${method} ${path} handled`);
    assert.equal(status, 200);
    return value as T;
  };
  const complete = async (sessionId: string) => { for (const listener of completion.listeners) await listener({ sessionId, assistantText: "" }); };
  const waitFor = async (sessionId: string, requestId: string, automaticAllowed = true) => {
    for (const listener of permissions.listeners) await listener({ sessionId, requestId, automaticAllowed });
  };
  const stop = async (sessionId: string, reason: ServerTurnStoppedEvent["reason"] = "error") => { for (const listener of stops.listeners) await listener({ sessionId, reason }); };
  const enable = async () => { await pkg.onEnable?.(); await judgmentPkg.onEnable?.(); };
  // Markers and request verdicts are separate events; each check reads its own.
  const assessments = () => appended.filter((entry) => entry.type === ASSESSMENT_EVENT);
  const verdicts = () => appended.filter((entry) => entry.type === REQUEST_VERDICT_EVENT)
    .map((entry) => ({ sessionId: entry.sessionId, data: entry.data as unknown as RequestVerdictData }));
  const checks = () => appended.filter((entry) => entry.type === REQUEST_CHECK_EVENT)
    .map((entry) => ({ sessionId: entry.sessionId, data: entry.data as unknown as RequestCheckData }));
  return { a, c, system, engine, askedAs, root, sessions, hiddenFrom, members, sent, replies, approvals, resumes, appended, merges, log, routingCalls,
    assessments, verdicts, checks, addSession, call, complete, waitFor, stop, enable, pkg,
    setMerge(next: typeof mergeStatus) { mergeStatus = next; }, setReport(next: ServerModelRoutingReport | undefined) { report = next; },
    setReplyError(next: Error | undefined) { replyError = next; }, failNextAppend(type: string) { failingAppends.add(type); } };
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
/** A permission judge with three answers: approve the safe, deny the dangerous, leave the rest to the person. */
const gatekeeper = (effects: JudgeInput["effects"] = [{ kind: "approve-request", when: "safe" }, { kind: "deny-request", when: "dangerous" }],
  patch: Partial<JudgeInput> = {}): JudgeInput => ({ name: "Gatekeeper", enabled: true, trigger: "permission-requested", filters: {},
  evidence: [{ pick: "permission-request", maxChars: 1_000 }],
  question: { type: "choice", text: "How safe is this step?", labels: [{ label: "safe", description: "Routine." },
    { label: "unsure", description: "A person should look." }, { label: "dangerous", description: "Destructive or out of scope." }] },
  fire: { threshold: 0.8, margin: 0.3 }, effects, dailyCap: 40, ...patch });
const autopilot = (patch: Partial<JudgeInput> = {}): JudgeInput => ({ name: "Finish the work", enabled: true, trigger: "turn-completed", filters: {},
  evidence: [{ pick: "last-request", maxChars: 600 }, { pick: "last-answer", maxChars: 600 }],
  question: { type: "choice", text: "Is the work finished?", labels: [{ label: "unfinished", description: "Work remains." }, { label: "done", description: "Finished and verified." }] },
  fire: { threshold: 0.6, margin: 0.2 },
  effects: [{ kind: "send-message", text: CONTINUE, when: "unfinished" }, { kind: "merge-isolated", when: "done" }], dailyCap: 40, ...patch });

test("acting judges need a signed-in person, act as whoever saved them and validate per trigger", async (t) => {
  const f = fixture(t, () => ({ answers: {} }));
  await assert.rejects(f.call(f.system, "/api/judges", "POST", { revision: 0, judge: autopilot() }), /signed-in person/);
  // Markers alone never needed a person.
  const marker = autopilot({ question: { type: "noul", text: "Done?" }, effects: [{ kind: "timeline-marker" }] });
  const unowned = await f.call(f.system, "/api/judges", "POST", { revision: 0, judge: marker });
  assert.equal(unowned.judges[0]!.ownerUserId, undefined);
  const created = await f.call(f.a, "/api/judges", "POST", { revision: 1, judge: autopilot() });
  const id = created.judges[1]!.id;
  assert.equal(created.judges[1]!.ownerUserId, "user-a"); assert.equal(created.viewer, "user-a");
  // Saving is lending one's access: whoever saves an acting judge becomes its owner.
  const taken = await f.call(f.c, `/api/judges/${id}`, "PUT", { revision: 2, judge: autopilot({ maxRounds: 5 }) });
  assert.equal(taken.judges[1]!.ownerUserId, "user-c"); assert.equal(taken.judges[1]!.maxRounds, 5);
  // An owner id in the input is never trusted.
  await assert.rejects(f.call(f.a, "/api/judges", "POST", { revision: 3, judge: { ...autopilot(), ownerUserId: "user-c" } }), /unknown field ownerUserId/);

  const rejects: Array<[string, Partial<JudgeInput> | JudgeInput, RegExp]> = [
    ["an action on a choice needs its answer", { effects: [{ kind: "send-message", text: CONTINUE }] }, /Choose the answer/],
    ["an unknown answer", { effects: [{ kind: "merge-isolated", when: "maybe" }] }, /Choose the answer/],
    ["approving is for permission judges", { effects: [{ kind: "approve-request", when: "done" }] }, /not available for this trigger/],
    ["a bad Auto-Approve level", { effects: [{ kind: "set-approval", level: "always" as never, when: "done" }] }, /on, all or off/],
    ["rounds within bounds", { maxRounds: 0 }, /Messages in a row/],
    ["a route question is for limit judges", { question: { type: "route", text: "Wait or go?" } }, /Only a limit judge/],
    ["routes are for limit judges", { routes: ["codex::openai/gpt-x"] }, /Only a limit judge/],
    ["a long message", { effects: [{ kind: "send-message", text: "x".repeat(1_001), when: "unfinished" }] }, /Message must be/],
    ["a permission judge reads the request", { trigger: "permission-requested", question: { type: "noul", text: "Safe?" },
      evidence: [{ pick: "last-request", maxChars: 300 }], effects: [{ kind: "approve-request" }] }, /must read the permission request/],
    ["a limit judge needs allowed models", { trigger: "limit-reached", question: { type: "route", text: "Wait or go?" }, evidence: [],
      effects: [{ kind: "switch-route" }] }, /Allow 1–8 models/],
    ["a limit judge switches", { trigger: "limit-reached", question: { type: "route", text: "Wait or go?" }, evidence: [], routes: ["codex::openai/gpt-x"],
      effects: [{ kind: "timeline-marker" }] }, /switches the model/],
    ["a malformed route", { trigger: "limit-reached", question: { type: "route", text: "Wait or go?" }, evidence: [], routes: ["gpt-x"],
      effects: [{ kind: "switch-route" }] }, /Invalid model route/],
    ["denying is for permission judges", { effects: [{ kind: "deny-request", when: "done" }] }, /not available for this trigger/],
    ["one answer both approves and denies", gatekeeper([{ kind: "approve-request", when: "safe" }, { kind: "deny-request", when: "safe" }]),
      /An answer cannot both allow and deny/],
    ["Full access and a denial on one answer", gatekeeper([{ kind: "set-approval", level: "all", when: "dangerous" }, { kind: "deny-request", when: "dangerous" }]),
      /An answer cannot both allow and deny/],
    ["a yes/no judge both approves and denies", { ...gatekeeper([{ kind: "approve-request" }, { kind: "deny-request" }]),
      question: { type: "noul", text: "Is this safe?" } }, /cannot both allow and deny/],
  ];
  for (const [label, patch, error] of rejects) {
    await assert.rejects(f.call(f.a, "/api/judges", "POST", { revision: 3, judge: { ...autopilot(), ...patch } }), error, label);
  }
});

test("a choice judge sends its answer's message as a judge, after its marker, and stops after its rounds", async (t) => {
  let probabilities: Record<string, number> = { unfinished: 0.85, done: 0.15 };
  const f = fixture(t, (request) => request.questions.answer ? { answers: { answer: choiceAnswer(probabilities) } } : new JudgmentExecutionError("invalid-request"));
  await f.enable();
  await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: autopilot({ maxRounds: 2 }) });
  f.addSession("s1");
  await f.complete("s1");
  await until(() => f.sent.length === 1, "the message is sent");
  assert.deepEqual(f.sent[0], { sessionId: "s1", input: { text: CONTINUE, delivery: "normal" }, admission: { author: { userId: "user-a", via: "judge" } }, as: "user-a" });
  assert.deepEqual(f.log, ["record:s1", "send:s1"], "the note is durable before the message it announces");
  assert.deepEqual(f.appended[0]!.data.actions, [{ kind: "send-message", status: "sending", detail: CONTINUE }]);
  assert.equal(f.appended[0]!.data.label, "unfinished"); assert.equal(f.appended[0]!.data.trigger, "turn-completed");

  // The judge's own turns are judged too, until its rounds run out.
  const events = f.sessions.get("s1")!.events;
  events.push(...turn("s1", 200, "More done; tests still missing.", { userId: "user-a", via: "judge" }));
  await f.complete("s1");
  await until(() => f.sent.length === 2, "a second round");
  events.push(...turn("s1", 300, "Still missing tests.", { userId: "user-a", via: "judge" }));
  await f.complete("s1");
  await until(() => f.appended.length === 3, "the third answer is recorded"); await quiet();
  assert.equal(f.sent.length, 2, "two judge messages in a row: the chat is handed back");
  assert.deepEqual(f.appended[2]!.data.actions, [{ kind: "send-message", status: "skipped", detail: "2 judge messages in a row; waiting for you" }]);
  // The evidence is the person's request, not the judge's own nudge.
  assert.match(JSON.stringify(f.engine.calls.at(-1)!.state), /Build the export button/);
  assert.doesNotMatch(JSON.stringify(f.engine.calls.at(-1)!.state), /You have not finished/);

  // A person's message starts a fresh count; a busy chat is never interrupted.
  events.push(...turn("s1", 400, "Half done."));
  f.sessions.get("s1")!.projection.status = "working";
  await f.complete("s1");
  await until(() => f.appended.length === 4, "recorded"); await quiet();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.appended[3]!.data.actions, [{ kind: "send-message", status: "skipped", detail: "the chat is busy" }]);

  // Someone who may only read a shared chat cannot have a judge write in it.
  f.addSession("viewer", { sharing: { visibility: "space", access: "view" } as never });
  await f.complete("viewer");
  await until(() => f.appended.length === 5, "recorded");
  assert.deepEqual(f.appended[4]!.data.actions, [{ kind: "send-message", status: "skipped", detail: "you cannot work in this chat" }]);
  assert.equal(f.sent.length, 2);

  // A close call runs nothing and records nothing.
  probabilities = { unfinished: 0.55, done: 0.45 };
  f.addSession("s2");
  f.sessions.get("s1")!.projection.status = "idle";
  await f.complete("s2");
  await until(() => f.engine.calls.length === 6, "asked"); await quiet();
  assert.equal(f.appended.length, 5); assert.equal(f.sent.length, 2);
});

test("a done answer merges the isolated work like the Merge button, only for someone who manages the chat", async (t) => {
  const f = fixture(t, (request) => request.questions.answer ? { answers: { answer: choiceAnswer({ unfinished: 0.1, done: 0.9 }) } } : new JudgmentExecutionError("invalid-request"));
  await f.enable();
  await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: autopilot() });
  f.addSession("s1");
  await f.complete("s1");
  await until(() => f.appended.length === 1, "recorded");
  assert.deepEqual(f.merges, ["s1"]);
  assert.deepEqual(f.appended[0]!.data.actions, [{ kind: "merge-isolated", status: "done", detail: "Merged into master (abc1234)" }]);
  assert.deepEqual(f.log, ["merge:s1", "record:s1"], "the merge's outcome is what the note records");

  f.setMerge({ canMerge: false, isolated: true });
  f.addSession("s2");
  await f.complete("s2");
  await until(() => f.appended.length === 2, "recorded");
  assert.deepEqual(f.appended[1]!.data.actions, [{ kind: "merge-isolated", status: "skipped", detail: "nothing to merge yet" }]);
  f.setMerge({ canMerge: true, isolated: false });
  f.addSession("s3");
  await f.complete("s3");
  await until(() => f.appended.length === 3, "recorded");
  assert.deepEqual(f.appended[2]!.data.actions, [{ kind: "merge-isolated", status: "skipped", detail: "the chat is not isolated" }]);
  // Someone who can work in a shared chat but not manage it cannot merge it through a judge.
  f.setMerge({ canMerge: true, isolated: true });
  f.addSession("s4", { sharing: { visibility: "space", access: "collaborate" } as never });
  await f.complete("s4");
  await until(() => f.appended.length === 4, "recorded");
  assert.deepEqual(f.appended[3]!.data.actions, [{ kind: "merge-isolated", status: "skipped", detail: "you do not manage this chat" }]);
  assert.deepEqual(f.merges, ["s1"]);
});

test("an owned judge reads only chats its owner can open, and nothing once its owner left", async (t) => {
  const f = fixture(t, (request) => request.questions.answer ? { answers: { answer: choiceAnswer({ unfinished: 0.9, done: 0.1 }) } } : new JudgmentExecutionError("invalid-request"));
  await f.enable();
  await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: autopilot() });
  f.addSession("private-c");
  f.hiddenFrom.set("user-a", new Set(["private-c"]));
  await f.complete("private-c"); await quiet();
  assert.equal(f.engine.calls.length, 0, "another person's private chat is never sent to Judgment");
  f.members.delete("user-a");
  f.addSession("s1");
  await f.complete("s1"); await quiet();
  assert.equal(f.engine.calls.length, 0, "a judge whose owner left neither reads nor acts");
  assert.deepEqual(f.sent, []); assert.deepEqual(f.appended, []);
});

test("permission judges approve the waiting request or change Auto-Approve with their owner's access", async (t) => {
  let safe = 0.9;
  const f = fixture(t, (request) => request.questions.answer
    ? { answers: { answer: choiceAnswer({ safe, unsure: 1 - safe }) } } : new JudgmentExecutionError("invalid-request"));
  await f.enable();
  const judge: JudgeInput = { name: "Routine approvals", enabled: true, trigger: "permission-requested", filters: {},
    evidence: [{ pick: "permission-request", maxChars: 1_000 }, { pick: "last-request", maxChars: 300 }],
    question: { type: "choice", text: "Is this a safe step of the request?", labels: [{ label: "safe", description: "Safe." }, { label: "unsure", description: "Unsure." }] },
    fire: { threshold: 0.8, margin: 0.3 }, effects: [{ kind: "approve-request", when: "safe" }, { kind: "set-approval", level: "all", when: "safe" }, { kind: "needs-attention" }, { kind: "timeline-marker" }],
    dailyCap: 40 };
  await assert.rejects(f.call(f.a, "/api/judges", "POST", { revision: 0, judge }), /Choose which answer fires/, "markers need the answer they follow");
  await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: { ...judge, fire: { ...judge.fire, label: "unsure" } } });
  // A delegated child's request is judged too.
  f.addSession("child", { parentId: "parent" }, permissionRequest("child", 3, "req-1"));
  await f.waitFor("child", "req-1");
  await until(() => f.assessments().length === 1, "recorded"); await quiet();
  const state = JSON.stringify(f.engine.calls[0]!.state);
  assert.match(state, /Asks for: bash via shell/); assert.match(state, /Risk: medium/); assert.match(state, /Run the test suite/);
  assert.doesNotMatch(state, /abcd1234secret/, "preview secrets stay redacted");
  assert.deepEqual(f.replies, [{ sessionId: "child", requestId: "req-1", reply: "once", as: "user-a" }]);
  assert.deepEqual(f.approvals, [{ sessionId: "child", setting: "all", as: "user-a" }]);
  assert.deepEqual(f.assessments()[0]!.data.actions, [
    { kind: "approve-request", status: "done", detail: "Approved bash via shell" },
    { kind: "set-approval", status: "done", detail: "Full access on" },
  ]);
  assert.equal(f.assessments()[0]!.data.attention, undefined, "markers follow their own answer");
  // The approval closed the request, so no card is left for a verdict: the marker records it.
  assert.equal(f.verdicts().length, 0);
  // The same request published again asks nothing.
  await f.waitFor("child", "req-1"); await quiet();
  assert.equal(f.engine.calls.length, 1);

  // A Space that never answers automatically: the judge does not either.
  f.addSession("s2", {}, permissionRequest("s2", 3, "req-2"));
  await f.waitFor("s2", "req-2", false);
  await until(() => f.verdicts().length === 1, "recorded");
  assert.equal(f.replies.length, 1);
  assert.deepEqual(f.assessments()[1]!.data.actions![0], { kind: "approve-request", status: "skipped", detail: "this Space never approves automatically" });
  // The card still waits, so its verdict, recorded after the actions, says why the approval did not happen.
  const [skipped] = f.verdicts();
  assert.equal(skipped!.sessionId, "s2");
  assert.deepEqual({ ...skipped!.data, judgeId: "", ts: 0 }, { judgeId: "", title: "Routine approvals", requestId: "req-2", verdict: "approve",
    safety: 0.9, label: "safe", probability: 0.9, ts: 0,
    action: { kind: "approve-request", status: "skipped", detail: "this Space never approves automatically", reason: "space-never-approves" } });
  assert.match(skipped!.data.judgeId, /^j[0-9a-f]{12}$/);
  assert.ok(f.appended.findLastIndex((entry) => entry.type === REQUEST_VERDICT_EVENT) > f.appended.findLastIndex((entry) => entry.type === ASSESSMENT_EVENT));

  // An answered request is not judged; an unsure answer only flags.
  f.addSession("s3", {}, [...permissionRequest("s3", 3, "req-3"), ev("s3", 4, "permission/resolved", { requestId: "req-3", reply: "once" })]);
  await f.waitFor("s3", "req-3"); await quiet();
  assert.equal(f.engine.calls.length, 2);
  assert.equal(f.verdicts().length, 1, "an answered request gets no verdict");
  safe = 0.05;
  f.addSession("s4", {}, permissionRequest("s4", 3, "req-4"));
  await f.waitFor("s4", "req-4");
  await until(() => f.verdicts().length === 2, "recorded");
  assert.equal(f.assessments()[2]!.data.attention, true); assert.equal(f.assessments()[2]!.data.actions, undefined);
  assert.equal(f.replies.length, 1);
  // A confident answer against approving is advice on the card, with the chance it is safe.
  assert.deepEqual({ ...f.verdicts()[1]!.data, judgeId: "", ts: 0 }, { judgeId: "", title: "Routine approvals", requestId: "req-4", verdict: "against",
    safety: 0.05, label: "unsure", probability: 0.95, ts: 0 });
});

test("a permission judge's verdict reaches the request's card, a mirrored parent card included", async (t) => {
  let safe = 0.7;
  let onAsk: (() => void) | undefined;
  const f = fixture(t, (request) => {
    onAsk?.();
    return request.questions.answer
      ? { answers: { answer: request.questions.answer.type === "noul" ? { type: "noul" as const, probability: safe, confidence: 0.9 }
        : choiceAnswer({ safe, unsure: 1 - safe }) } } : new JudgmentExecutionError("invalid-request");
  });
  await f.enable();
  const judge: JudgeInput = { name: "Routine approvals", enabled: true, trigger: "permission-requested", filters: {},
    evidence: [{ pick: "permission-request", maxChars: 1_000 }],
    question: { type: "choice", text: "Is this a safe step of the request?", labels: [{ label: "safe", description: "Safe." }, { label: "unsure", description: "Unsure." }] },
    fire: { threshold: 0.8, margin: 0.3, label: "safe" }, effects: [{ kind: "approve-request", when: "safe" }, { kind: "timeline-marker" }], dailyCap: 40 };
  const saved = await f.call(f.a, "/api/judges", "POST", { revision: 0, judge });

  // A close call fires nothing and records no marker, but the card says the judge did not approve.
  f.addSession("s1", {}, permissionRequest("s1", 3, "req-1"));
  await f.waitFor("s1", "req-1");
  await until(() => f.verdicts().length === 1, "verdict recorded"); await quiet();
  assert.equal(f.assessments().length, 0, "a close call is no marker");
  assert.equal(f.replies.length, 0, "and no approval");
  assert.deepEqual({ ...f.verdicts()[0]!.data, ts: 0 }, { judgeId: saved.judges[0]!.id, title: "Routine approvals", requestId: "req-1", verdict: "unsure",
    safety: 0.7, label: "safe", probability: 0.7, ts: 0 });

  // A delegated child's card is mirrored in its parent: the open mirror gets a copy naming the child.
  safe = 0.1;
  f.addSession("parent", {}, [ev("parent", 1, "user/message", { text: "Delegate the tests." }),
    ev("parent", 5, "permission/requested", { requestId: "req-2", permission: "bash", patterns: ["npm test"], sourceSessionId: "child" })]);
  f.addSession("child", { parentId: "parent" }, permissionRequest("child", 3, "req-2"));
  await f.waitFor("child", "req-2");
  await until(() => f.verdicts().length === 3, "verdict and its copy recorded");
  const [own, copy] = f.verdicts().slice(1);
  assert.equal(own!.sessionId, "child"); assert.equal(own!.data.sourceSessionId, undefined);
  assert.equal(own!.data.verdict, "against"); assert.equal(own!.data.safety, 0.1);
  assert.equal(copy!.sessionId, "parent");
  assert.deepEqual(copy!.data, { ...own!.data, sourceSessionId: "child" });

  // The copy goes only where the judge's owner can open the chat.
  f.hiddenFrom.set("user-a", new Set(["parent-3"]));
  f.addSession("parent-3", {}, [ev("parent-3", 5, "permission/requested", { requestId: "req-6", permission: "bash", patterns: [], sourceSessionId: "child-4" })]);
  f.addSession("child-4", { parentId: "parent-3" }, permissionRequest("child-4", 3, "req-6"));
  await f.waitFor("child-4", "req-6");
  await until(() => f.verdicts().length === 4, "verdict recorded"); await quiet();
  assert.deepEqual(f.verdicts().slice(3).map((entry) => entry.sessionId), ["child-4"], "no copy in a chat the owner cannot open");

  // A mirror someone already answered, or another child's request, gets no copy.
  f.addSession("parent-2", {}, [ev("parent-2", 5, "permission/requested", { requestId: "req-3", permission: "bash", patterns: [], sourceSessionId: "child-2" }),
    ev("parent-2", 6, "permission/resolved", { requestId: "req-3", reply: "reject" }),
    ev("parent-2", 7, "permission/requested", { requestId: "req-4", permission: "bash", patterns: [], sourceSessionId: "someone-else" })]);
  f.addSession("child-2", { parentId: "parent-2" }, permissionRequest("child-2", 3, "req-3"));
  await f.waitFor("child-2", "req-3");
  await until(() => f.verdicts().length === 5, "verdict recorded"); await quiet();
  f.addSession("child-3", { parentId: "parent-2" }, permissionRequest("child-3", 3, "req-4"));
  await f.waitFor("child-3", "req-4");
  await until(() => f.verdicts().length === 6, "verdict recorded"); await quiet();
  assert.deepEqual(f.verdicts().map((entry) => entry.sessionId).slice(4), ["child-2", "child-3"]);

  // A yes/no judge: P(yes) is the safety; confident "no" advises against.
  const noul = { ...judge, name: "Yes or no", question: { type: "noul" as const, text: "Is this safe?" }, fire: { threshold: 0.8, margin: 0.3 },
    effects: [{ kind: "approve-request" as const }] };
  const both = await f.call(f.a, `/api/judges/${saved.judges[0]!.id}`, "PUT", { revision: saved.revision, judge: { ...judge, enabled: false } });
  await f.call(f.a, "/api/judges", "POST", { revision: both.revision, judge: noul });
  safe = 0.1;
  f.addSession("s5", {}, permissionRequest("s5", 3, "req-5"));
  await f.waitFor("s5", "req-5");
  await until(() => f.verdicts().length === 7, "verdict recorded");
  assert.deepEqual({ ...f.verdicts()[6]!.data, judgeId: "", ts: 0 }, { judgeId: "", title: "Yes or no", requestId: "req-5", verdict: "against",
    safety: 0.1, label: "no", probability: 0.9, ts: 0 });

  // The person answered while the judge was thinking: no card is left for a verdict.
  f.addSession("s7", {}, permissionRequest("s7", 3, "req-7"));
  onAsk = () => { f.sessions.get("s7")!.events.push(ev("s7", 50, "permission/resolved", { requestId: "req-7", reply: "reject" })); };
  await f.waitFor("s7", "req-7");
  await until(() => f.engine.calls.length === 7, "asked"); await quiet();
  assert.equal(f.verdicts().length, 7);
});

test("a permission judge that cannot approve leaves no verdict on the card", async (t) => {
  const f = fixture(t, () => ({ answers: { answer: choiceAnswer({ risky: 0.9, fine: 0.1 }) } }));
  await f.enable();
  await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: { name: "Risk flag", enabled: true, trigger: "permission-requested", filters: {},
    evidence: [{ pick: "permission-request", maxChars: 1_000 }],
    question: { type: "choice", text: "Is this risky?", labels: [{ label: "risky", description: "Risky." }, { label: "fine", description: "Fine." }] },
    fire: { threshold: 0.8, margin: 0.3, label: "risky" }, effects: [{ kind: "needs-attention" }], dailyCap: 40 } satisfies JudgeInput });
  f.addSession("s1", {}, permissionRequest("s1", 3, "req-1"));
  await f.waitFor("s1", "req-1");
  await until(() => f.assessments().length === 1, "marker recorded"); await quiet();
  assert.equal(f.verdicts().length, 0, "it marks the request; it does not decide on it");
});

test("a permission judge denies the request it is sure is dangerous, with its owner's access", async (t) => {
  let probabilities: Record<string, number> = { dangerous: 0.9, unsure: 0.07, safe: 0.03 };
  const f = fixture(t, (request) => request.questions.answer ? { answers: { answer: choiceAnswer(probabilities) } } : new JudgmentExecutionError("invalid-request"));
  await f.enable();
  const saved = await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: gatekeeper() });

  // Denying is the card's Deny button; a Space that never approves automatically still denies, as its own deny rules do.
  f.addSession("s1", {}, permissionRequest("s1", 3, "req-1"));
  await f.waitFor("s1", "req-1", false);
  await until(() => f.assessments().length === 1, "the denial is recorded"); await quiet();
  assert.deepEqual(f.replies, [{ sessionId: "s1", requestId: "req-1", reply: "reject", as: "user-a" }]);
  assert.deepEqual(f.assessments()[0]!.data.actions, [{ kind: "deny-request", status: "done", detail: "Denied bash via shell" }]);
  // The card said the judge was checking; the denial closed it, so no verdict follows and the check needs no end.
  assert.deepEqual(f.checks().map((entry) => [entry.sessionId, entry.data.state]), [["s1", "checking"]]);
  assert.equal(f.verdicts().length, 0);
  assert.ok(f.appended.findIndex((entry) => entry.type === REQUEST_CHECK_EVENT) < f.appended.findIndex((entry) => entry.type === ASSESSMENT_EVENT));

  // A confident answer that neither approves nor denies leaves the request to the person, advising against it.
  probabilities = { unsure: 0.88, safe: 0.07, dangerous: 0.05 };
  f.addSession("s2", {}, permissionRequest("s2", 3, "req-2"));
  await f.waitFor("s2", "req-2");
  await until(() => f.verdicts().length === 1, "verdict recorded"); await quiet();
  assert.equal(f.replies.length, 1);
  assert.deepEqual({ ...f.verdicts()[0]!.data, ts: 0 }, { judgeId: saved.judges[0]!.id, title: "Gatekeeper", requestId: "req-2", verdict: "against",
    safety: 0.07, label: "unsure", probability: 0.88, ts: 0 });

  // A denial that does not go through leaves the card waiting, and says why.
  probabilities = { dangerous: 0.95, unsure: 0.03, safe: 0.02 };
  f.setReplyError(new Error("Only people who work in this chat can do that"));
  f.addSession("s3", {}, permissionRequest("s3", 3, "req-3"));
  await f.waitFor("s3", "req-3");
  await until(() => f.verdicts().length === 2, "verdict recorded"); await quiet();
  f.setReplyError(undefined);
  assert.deepEqual(f.assessments()[1]!.data.actions, [{ kind: "deny-request", status: "failed", detail: "Only people who work in this chat can do that" }]);
  // The verdict, recorded after the check, is what ends it: no stray "no answer" follows.
  assert.deepEqual(f.appended.filter((entry) => entry.sessionId === "s3" && entry.type !== ASSESSMENT_EVENT).map((entry) => entry.type),
    [REQUEST_CHECK_EVENT, REQUEST_VERDICT_EVENT]);
  const failed = f.verdicts()[1]!.data;
  assert.equal(failed.verdict, "deny"); assert.ok(Math.abs(failed.safety - 0.02) < 1e-9);
  assert.deepEqual(failed.action, { kind: "deny-request", status: "failed", detail: "Only people who work in this chat can do that" });

  // A judge that can only deny: its confident other answer is "no objection", and safety is what it does not deny.
  const denyOnly = await f.call(f.a, `/api/judges/${saved.judges[0]!.id}`, "PUT", { revision: saved.revision,
    judge: gatekeeper([{ kind: "deny-request", when: "dangerous" }], { name: "Brakes" }) });
  probabilities = { safe: 0.85, unsure: 0.1, dangerous: 0.05 };
  f.addSession("s4", {}, permissionRequest("s4", 3, "req-4"));
  await f.waitFor("s4", "req-4");
  await until(() => f.verdicts().length === 3, "verdict recorded"); await quiet();
  assert.equal(denyOnly.judges[0]!.name, "Brakes");
  assert.equal(f.replies.length, 1, "no objection is not an approval");
  const clear = f.verdicts()[2]!.data;
  assert.equal(clear.verdict, "clear"); assert.ok(Math.abs(clear.safety - 0.95) < 1e-9);
});

test("a deciding judge tells the card it is checking, and when it got no answer", async (t) => {
  let fail = false, answeredMeanwhile: string | undefined;
  const seenWhileAsking: Array<Array<[string, string]>> = [];
  let f: ReturnType<typeof fixture>;
  f = fixture(t, (request) => {
    // What the card has heard by the time the model is asked.
    seenWhileAsking.push(f.checks().map((entry) => [entry.sessionId, entry.data.state]));
    if (answeredMeanwhile) f.sessions.get(answeredMeanwhile)!.events.push(ev(answeredMeanwhile, 60, "permission/resolved", { requestId: "req-3", reply: "once" }));
    if (!request.questions.answer) return new JudgmentExecutionError("invalid-request");
    return fail ? new JudgmentExecutionError("timeout") : { answers: { answer: choiceAnswer({ safe: 0.6, unsure: 0.3, dangerous: 0.1 }) } };
  });
  await f.enable();
  const saved = await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: gatekeeper() });

  // Checking first, then the verdict ends it.
  f.addSession("s1", {}, permissionRequest("s1", 3, "req-1"));
  await f.waitFor("s1", "req-1");
  await until(() => f.verdicts().length === 1, "verdict recorded"); await quiet();
  assert.deepEqual(seenWhileAsking[0], [["s1", "checking"]]);
  assert.deepEqual({ ...f.checks()[0]!.data, ts: 0 }, { judgeId: saved.judges[0]!.id, title: "Gatekeeper", requestId: "req-1", state: "checking", ts: 0 });
  assert.equal(f.verdicts()[0]!.data.verdict, "unsure");
  // The request still waits, so a stray "no answer" after the verdict would show: there is none.
  assert.deepEqual(f.appended.filter((entry) => entry.sessionId === "s1").map((entry) => entry.type), [REQUEST_CHECK_EVENT, REQUEST_VERDICT_EVENT]);

  // No answer: the card hears why, and the request stays the person's. A mirrored parent card hears the same.
  fail = true;
  f.addSession("parent", {}, [ev("parent", 1, "user/message", { text: "Delegate the tests." }),
    ev("parent", 5, "permission/requested", { requestId: "req-2", permission: "bash", patterns: ["npm test"], sourceSessionId: "child" })]);
  f.addSession("child", { parentId: "parent" }, permissionRequest("child", 3, "req-2"));
  await f.waitFor("child", "req-2");
  await until(() => f.checks().length === 5, "checking and no answer, each with its copy"); await quiet();
  assert.deepEqual(f.checks().slice(1).map((entry) => [entry.sessionId, entry.data.state, entry.data.reason ?? "", entry.data.sourceSessionId ?? ""]), [
    ["child", "checking", "", ""], ["parent", "checking", "", "child"], ["child", "no-answer", "timeout", ""], ["parent", "no-answer", "timeout", "child"]]);
  assert.equal(f.verdicts().length, 1, "no answer is no verdict");
  assert.equal(f.replies.length, 0);

  // Answered while the judge was asking: the card is gone, so nothing more is said about it.
  fail = false; answeredMeanwhile = "s3";
  f.addSession("s3", {}, permissionRequest("s3", 3, "req-3"));
  const asked = f.engine.calls.length;
  await f.waitFor("s3", "req-3");
  await until(() => f.engine.calls.length > asked, "asked"); await quiet();
  answeredMeanwhile = undefined;
  assert.deepEqual(f.checks().slice(5).map((entry) => entry.data.state), ["checking"]);
  assert.equal(f.verdicts().length, 1);

  // A judge that only marks requests never says it is checking: it decides nothing.
  await f.call(f.a, `/api/judges/${saved.judges[0]!.id}`, "PUT", { revision: saved.revision,
    judge: gatekeeper([{ kind: "needs-attention" }], { fire: { threshold: 0.5, margin: 0, label: "dangerous" } }) });
  f.addSession("s4", {}, permissionRequest("s4", 3, "req-4"));
  await f.waitFor("s4", "req-4");
  await until(() => f.engine.calls.length > asked + 1, "asked"); await quiet();
  assert.equal(f.checks().length, 6);
});

test("a check is closed even when its verdict cannot be recorded, or the package is turned off meanwhile", async (t) => {
  let onAsk: (() => void) | undefined;
  const f = fixture(t, (request) => {
    onAsk?.();
    return request.questions.answer ? { answers: { answer: choiceAnswer({ safe: 0.6, unsure: 0.3, dangerous: 0.1 }) } } : new JudgmentExecutionError("invalid-request");
  });
  await f.enable();
  await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: gatekeeper() });

  // The store refuses the verdict: the card hears "no answer" rather than "checking" forever.
  f.failNextAppend(REQUEST_VERDICT_EVENT);
  f.addSession("s1", {}, permissionRequest("s1", 3, "req-1"));
  await f.waitFor("s1", "req-1");
  await until(() => f.checks().length === 2, "closed"); await quiet();
  assert.deepEqual(f.checks().map((entry) => [entry.data.state, entry.data.reason ?? ""]), [["checking", ""], ["no-answer", "failed"]]);
  assert.equal(f.verdicts().length, 0);

  // Turned off while the model thinks: the check it already opened is closed, and nothing else is recorded.
  onAsk = () => { onAsk = undefined; f.pkg.onDisable?.(); };
  f.addSession("s2", {}, permissionRequest("s2", 3, "req-2"));
  await f.waitFor("s2", "req-2");
  await until(() => f.checks().length === 4, "closed"); await quiet();
  assert.deepEqual(f.checks().slice(2).map((entry) => [entry.sessionId, entry.data.state, entry.data.reason ?? ""]),
    [["s2", "checking", ""], ["s2", "no-answer", "cancelled"]]);
  assert.equal(f.verdicts().length, 0);
});

test("a permission judge asks an agent model as its owner, and says why it got no answer", async (t) => {
  let fail = true;
  const f = fixture(t, () => fail ? new JudgmentExecutionError("model-unavailable")
    : { answers: { answer: choiceAnswer({ safe: 0.95, unsure: 0.05 }) } });
  await f.enable();
  const judge: JudgeInput = { name: "Routine approvals", enabled: true, trigger: "permission-requested", filters: {},
    evidence: [{ pick: "permission-request", maxChars: 1_000 }],
    question: { type: "choice", text: "Is this a safe step of the request?", labels: [{ label: "safe", description: "Safe." }, { label: "unsure", description: "Unsure." }] },
    fire: { threshold: 0.8, margin: 0.3 }, effects: [{ kind: "approve-request", when: "safe" }], dailyCap: 40 };
  await assert.rejects(f.call(f.a, "/api/judges", "POST", { revision: 0, judge: { ...judge, model: "not a route" } }), /Invalid model/);
  const saved = await f.call(f.a, "/api/judges", "POST", { revision: 0, judge });
  const id = saved.judges[0]!.id;
  f.addSession("s1", {}, permissionRequest("s1", 3, "req-1"));
  await f.waitFor("s1", "req-1");
  await until(() => f.engine.calls.length === 1, "asked"); await quiet();
  // No key and no Space engine: the owner's Small Model through the Agent model engine.
  assert.deepEqual(f.engine.calls[0]!.target, { engineId: "agent", providerId: "small-model", modelId: "default" });
  assert.equal(f.askedAs.at(-1), "user-a");
  assert.equal(f.replies.length, 0, "no answer is never a decision");
  const failed = await f.call(f.a, "/api/judges");
  assert.equal(failed.usage[id]!.failure?.reason, "model-unavailable");
  assert.equal(failed.usage[id]!.count, 1);

  // A judge that names a model asks that harness model; an answer clears the failure.
  fail = false;
  await f.call(f.a, `/api/judges/${id}`, "PUT", { revision: failed.revision, judge: { ...judge, model: "codex::openai/gpt-5-mini" } });
  f.addSession("s2", {}, permissionRequest("s2", 3, "req-2"));
  await f.waitFor("s2", "req-2");
  await until(() => f.replies.length === 1, "approved");
  assert.deepEqual(f.engine.calls[1]!.target, { engineId: "agent", providerId: "codex", modelId: "openai/gpt-5-mini" });
  const answered = await f.call(f.a, "/api/judges");
  assert.equal(answered.usage[id]!.failure, undefined);
  assert.equal(answered.usage[id]!.count, 2);
});

test("limit judges switch to an allowed model with headroom, and leave the chat waiting otherwise", async (t) => {
  let pick = "route_1";
  const f = fixture(t, (request) => {
    if (!request.questions.route) return new JudgmentExecutionError("invalid-request");
    const labels = Object.keys((request.questions.route as { criteria: Record<string, string> }).criteria);
    return { answers: { route: choiceAnswer(Object.fromEntries(labels.map((label) => [label, label === pick ? 0.8 : 0.2 / (labels.length - 1)]))) } };
  });
  await f.enable();
  const routes = ["codex::openai/gpt-x", "opencode::zai/glm", "claude::anthropic/opus"];
  await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: {
    name: "Keep going", enabled: true, trigger: "limit-reached", filters: {}, evidence: [{ pick: "last-request", maxChars: 300 }],
    question: { type: "route", text: "Switch when the wait is over 20 minutes." }, fire: { threshold: 0.6, margin: 0.2 },
    effects: [{ kind: "switch-route" }, { kind: "timeline-marker" }], routes, dailyCap: 40 } satisfies JudgeInput });
  const now = Date.now();
  f.setReport({ windowDays: 30, generatedAt: now, omitted: 0, unlisted: 0, text: "", candidates: [
    { harnessId: "codex", providerID: "openai", modelID: "gpt-x", listed: true, favorite: true, turns: 3, sessions: 1, failed: 0, available: true, quotaUsed: 0.3, blocked: false },
    { harnessId: "opencode", providerID: "zai", modelID: "glm", listed: true, favorite: false, turns: 0, sessions: 0, failed: 0, available: true, quotaUsed: 1, blocked: true, blockedUntil: now + 3_600_000 },
    { harnessId: "claude", providerID: "anthropic", modelID: "opus", listed: true, favorite: true, turns: 9, sessions: 2, failed: 1, available: true, quotaUsed: 1, blocked: true },
    // Not on the judge's list: never offered, whatever the shortlist returns.
    { harnessId: "grok", providerID: "xai", modelID: "grok-5", listed: true, favorite: true, turns: 1, sessions: 1, failed: 0, available: true, quotaUsed: 0, blocked: false },
  ], quotas: [{ sourceId: "codex", windows: [{ id: "5h", label: "5 hours", used: 0.3, resetsAt: now + 7_200_000 }], stale: false, fetchedAt: now }] });
  const limited = (id: string, attempt = 1): Partial<SessionProjection> => ({ resolvedHarnessId: "claude", model: { providerID: "anthropic", modelID: "opus" },
    resume: { resumeAt: now + 40 * 60_000, scope: "account" as never, attempt, userMessageSeq: 1, resetAt: now + 40 * 60_000 } });
  f.addSession("s1", limited("s1"));
  await f.stop("s1");
  await until(() => f.resumes.length === 1, "switched");
  assert.deepEqual(f.routingCalls[0]!.pairs, routes); assert.equal(f.routingCalls[0]!.space.userId, "user-a", "the owner's own shortlist");
  const request = f.engine.calls[0]!;
  assert.deepEqual(Object.keys((request.questions.route as { criteria: Record<string, string> }).criteria), ["wait", "route_1"],
    "blocked, current and unlisted models are never offered");
  const state = request.state as { stopped: { waitMinutes: number; model: string }; options: unknown[]; quotas: unknown[]; lastRequest: string; now: string };
  assert.equal(state.stopped.model, "claude::anthropic/opus"); assert.ok(state.stopped.waitMinutes >= 39 && state.stopped.waitMinutes <= 40);
  assert.deepEqual(state.options, [{ answer: "route_1", model: "codex · openai/gpt-x", quotaUsed: "30%", favorite: true }]);
  assert.equal((state.quotas[0] as { windows: Array<{ used: string }> }).windows[0]!.used, "30%");
  assert.equal(state.lastRequest, "Build the export button.");
  assert.deepEqual(f.resumes[0], { sessionId: "s1", as: "user-a",
    options: { model: { providerID: "openai", modelID: "gpt-x" }, harness: { mode: "pinned", harnessId: "codex" } } });
  await until(() => f.appended.length === 1, "recorded");
  assert.deepEqual(f.appended[0]!.data.actions, [{ kind: "switch-route", status: "done", detail: "Switched to codex · openai/gpt-x" }]);
  assert.equal(f.appended[0]!.data.label, "codex · openai/gpt-x");
  // The same stop published again is not asked twice.
  f.sessions.get("s1")!.projection.resume = limited("s1").resume;
  await f.stop("s1"); await quiet();
  assert.equal(f.engine.calls.length, 1);

  // "wait" leaves the automatic resume alone and records nothing.
  pick = "wait";
  f.addSession("s2", limited("s2"));
  await f.stop("s2");
  await until(() => f.engine.calls.length === 2, "asked"); await quiet();
  assert.equal(f.resumes.length, 1); assert.equal(f.appended.length, 1);
  // A completed or aborted stop, or one without a pending resume, asks nothing.
  pick = "route_1";
  f.addSession("s3", limited("s3"));
  await f.stop("s3", "completed"); await f.stop("s3", "aborted");
  f.addSession("s4");
  await f.stop("s4"); await quiet();
  assert.equal(f.engine.calls.length, 2);
  // Nothing allowed is usable: waiting is the only answer, so nothing is asked.
  f.setReport({ windowDays: 30, generatedAt: now, omitted: 0, unlisted: 0, text: "", candidates: [], quotas: [] });
  f.addSession("s5", limited("s5"));
  await f.stop("s5"); await quiet();
  assert.equal(f.engine.calls.length, 2);
  // Without Usage the allowed list is offered as written, headroom unknown.
  f.setReport(undefined);
  f.addSession("s6", { ...limited("s6"), resolvedHarnessId: "codex", model: { providerID: "openai", modelID: "gpt-x" } });
  await f.stop("s6");
  await until(() => f.resumes.length === 2, "switched without headroom facts");
  assert.match(JSON.stringify(f.engine.calls.at(-1)!.questions), /quota headroom unknown/);
  assert.deepEqual((f.resumes[1]!.options as { harness: unknown }).harness, { mode: "pinned", harnessId: "opencode" }, "the current model is never offered");
});

test("backtest covers judges that run after a turn and lists the actions an answer would run", async (t) => {
  const f = fixture(t, (request) => request.questions.answer ? { answers: { answer: choiceAnswer({ unfinished: 0.9, done: 0.1 }) } } : new JudgmentExecutionError("invalid-request"));
  await f.enable();
  const { judges: [saved] } = await f.call(f.a, "/api/judges", "POST", { revision: 0, judge: autopilot() });
  f.addSession("s1");
  const result = await f.call<BacktestResult>(f.a, `/api/judges/${saved!.id}/backtest`, "POST", { limit: 5 });
  assert.deepEqual(result.rows.map((row) => [row.wouldFire, row.wouldDo]), [[true, ["send-message"]]]);
  assert.deepEqual(f.sent, []); assert.deepEqual(f.appended, []); assert.deepEqual(f.merges, [], "a backtest runs no action");
  // Another member's backtest of this owned judge never reads a chat its owner cannot open.
  f.addSession("only-c");
  f.hiddenFrom.set("user-a", new Set(["only-c"]));
  const before = f.engine.calls.length;
  const theirs = await f.call<BacktestResult>(f.c, `/api/judges/${saved!.id}/backtest`, "POST", { limit: 5 });
  assert.deepEqual(theirs.rows.map((row) => row.sessionId), ["s1"]);
  assert.equal(f.engine.calls.length, before + 1);
  assert.doesNotMatch(JSON.stringify(f.engine.calls.slice(before)), /only-c/);
  const { judges } = await f.call(f.a, "/api/judges", "POST", { revision: 1, judge: { name: "Approvals", enabled: true, trigger: "permission-requested", filters: {},
    evidence: [{ pick: "permission-request", maxChars: 600 }], question: { type: "noul", text: "Safe?" }, fire: { threshold: 0.9, margin: 0.5 },
    effects: [{ kind: "approve-request" }], dailyCap: 5 } satisfies JudgeInput });
  await assert.rejects(f.call(f.a, `/api/judges/${judges[1]!.id}/backtest`, "POST", { limit: 5 }), /covers judges that run after a turn/);
});

test("an Auto-Approve change is done once the level is saved, even if answering open cards then fails", async () => {
  let setting = "inherit";
  const target = (fail: "after-save" | "before-save") => ({
    sessionId: "s1", ownerUserId: "u1", events: async () => [],
    sessions: {
      autoAcceptGet: async () => ({ setting }),
      autoAcceptSet: async (_id: string, level: string) => {
        if (fail === "after-save") setting = level;
        throw new Error("runtime replacement is pending a durable epoch transition");
      },
    } as never,
  });
  assert.deepEqual(await runAction({ kind: "set-approval", level: "all" }, target("before-save")),
    { kind: "set-approval", status: "failed", detail: "runtime replacement is pending a durable epoch transition" });
  assert.deepEqual(await runAction({ kind: "set-approval", level: "all" }, target("after-save")),
    { kind: "set-approval", status: "done", detail: "Full access on" });
});

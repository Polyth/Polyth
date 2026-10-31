// The person's messages to an agent: which conversation they continue, the
// files they carry, messages waiting for a run in progress, the run's live
// activity, and the owner's `followUp` preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, SessionEvent, SpaceContext } from "@polyth/contracts";
import { RUNTIME_SYSTEM_PRINCIPAL_ID, serverServiceKey } from "@polyth/plugins";
import {
  AGENT_INPUT_LIMIT,
  AGENT_SESSION_PURPOSE,
  composeAgentPrompt,
  createScheduleService,
  exchangeAt,
  followUpRun,
  FOLLOW_UP_WINDOW_MS,
  rollingKeyOf,
  settleScheduledRun,
  threadDecision,
  validateRunAttachments,
  type AgentRunActivity,
  type AgentWake,
  type ScheduleRunner,
  type ScheduleRunRecord,
  type ScheduleRunSettlement,
  type ScheduleService,
  type ScheduleTask,
  type ThreadInput,
} from "../src/index.ts";
import registerPackage, { scheduleRoutes } from "../src/serverEntry.ts";

const HOUR = 60 * 60_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function tempFile(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-continuation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "schedule.json");
}

const inbox = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `att-${name}`, name, mime: "image/png", size: 10, kind: "image", path: `_inbox/${name}`, ...extra,
});

// ---- the decision ------------------------------------------------------------

test("a follow-up answers the newest exchange the person could see", () => {
  const run = (over: Partial<ScheduleRunRecord>): ScheduleRunRecord => ({ runId: "r", startedAt: 1, status: "ok", ...over });
  const history = [
    run({ runId: "now", status: "running", input: "hi" }), // this run: no session yet
    run({ runId: "quiet", sessionId: "s-quiet", signal: "quiet" }),
    run({ runId: "skip", status: "skipped", sessionId: "s-skip" }),
    run({ runId: "lost", status: "unknown", sessionId: "s-lost" }),
    run({ runId: "report", sessionId: "s-report", signal: "update", startedAt: 10, finishedAt: 20 }),
    run({ runId: "older", sessionId: "s-older", input: "earlier" }),
  ];
  assert.equal(followUpRun(history)?.runId, "report");
  assert.equal(exchangeAt(history[4]!), 20);
  assert.equal(exchangeAt({ startedAt: 5 }), 5);
  assert.equal(followUpRun([run({ status: "failed", sessionId: "s-failed" })])?.sessionId, "s-failed", "a failure is something to reply to");
  assert.equal(followUpRun([run({ status: "running", sessionId: "s-busy" })])?.sessionId, "s-busy");
  assert.equal(followUpRun(undefined), undefined);
});

test("a fresh agent continues the person's exchange only while it is recent, healthy and current", () => {
  const now = 100 * HOUR;
  const base: ThreadInput = {
    mode: "fresh", continuation: "auto", personal: true, now, currentKey: "k",
    candidate: { sessionId: "s", at: now - HOUR, key: "k" },
    session: { status: "idle", purpose: AGENT_SESSION_PURPOSE, contextWindow: { fraction: 0.2 } },
  };
  assert.deepEqual(threadDecision(base), { continue: true, sessionId: "s", resendCharter: false });
  assert.deepEqual(threadDecision({ ...base, personal: false }), { continue: false, reason: "none" }, "a scheduled run never follows up");
  assert.deepEqual(threadDecision({ ...base, continuation: "new" }), { continue: false, reason: "asked" });
  assert.deepEqual(threadDecision({ ...base, candidate: undefined }), { continue: false, reason: "none" });
  assert.deepEqual(threadDecision({ ...base, session: undefined }), { continue: false, reason: "unavailable" });
  assert.deepEqual(threadDecision({ ...base, session: { status: "archived" } }), { continue: false, reason: "unavailable" });
  assert.deepEqual(threadDecision({ ...base, currentKey: "k2" }), { continue: false, reason: "instructions-changed" });
  assert.deepEqual(threadDecision({ ...base, currentKey: "k2", candidate: { sessionId: "s", at: now - HOUR } }),
    { continue: true, sessionId: "s", resendCharter: false },
    "a report filed before runs kept their key is answered in its own session, not called changed");
  const own = (contextWindow: NonNullable<ThreadInput["session"]>["contextWindow"]) => ({ purpose: AGENT_SESSION_PURPOSE, contextWindow });
  assert.deepEqual(threadDecision({ ...base, session: { status: "idle", contextWindow: { fraction: 0.2 } } }), { continue: false, reason: "unavailable" },
    "a chat the agent once posted into is not its conversation");
  assert.deepEqual(threadDecision({ ...base, session: own({ fraction: 0.7 }) }), { continue: false, reason: "context-full" });
  assert.deepEqual(threadDecision({ ...base, session: own({ fraction: 0.1, compaction: { lastAt: 5 } }) }),
    { continue: true, sessionId: "s", resendCharter: true }, "a compacted exchange goes on, with the charter again");
  // Rolling-only settings never steer a fresh agent: it neither compacts nor waits for a later threshold.
  assert.deepEqual(threadDecision({ ...base, whenFull: "compact", rotateAt: 0.9, session: own({ fraction: 0.7 }) }),
    { continue: false, reason: "context-full" });
  const stale = { ...base, candidate: { sessionId: "s", at: now - FOLLOW_UP_WINDOW_MS - 1, key: "k" } };
  assert.deepEqual(threadDecision(stale), { continue: false, reason: "idle" });
  assert.equal(threadDecision({ ...stale, continuation: "continue" }).continue, true, "the person may continue an old exchange");
  assert.deepEqual(threadDecision({ ...stale, continuation: "continue", currentKey: "k2" }),
    { continue: false, reason: "instructions-changed" }, "continue overrides only the idle window");
  assert.deepEqual(threadDecision({ ...stale, continuation: "continue", session: own({ fraction: 0.9 }) }),
    { continue: false, reason: "context-full" });
});

test("a rolling agent has no idle window, repeats the charter when unsure and may compact first", () => {
  const now = 100 * HOUR;
  const base: ThreadInput = {
    mode: "rolling", continuation: "auto", personal: false, now, currentKey: "k",
    candidate: { sessionId: "s", at: 0, key: "k" }, session: { contextWindow: { fraction: 0.3 } },
  };
  assert.deepEqual(threadDecision(base), { continue: true, sessionId: "s", resendCharter: false });
  assert.deepEqual(threadDecision({ ...base, session: {} }), { continue: true, sessionId: "s", resendCharter: true });
  assert.deepEqual(threadDecision({ ...base, whenFull: "compact", session: { contextWindow: { fraction: 0.7 } } }),
    { continue: true, sessionId: "s", resendCharter: true, compactFirst: true });
  assert.deepEqual(threadDecision({ ...base, continuation: "new" }), { continue: false, reason: "asked" });
  assert.deepEqual(threadDecision({ ...base, candidate: { sessionId: "s", at: 0 } }), { continue: false, reason: "instructions-changed" },
    "a rolling session without a recorded key is started over, as before");
});

test("attachments are uploads in the project's _inbox, nothing else", () => {
  assert.deepEqual(validateRunAttachments([inbox("a.png", { url: "https://evil.example/x", repositoryId: "r" })]),
    [{ id: "att-a.png", name: "a.png", mime: "image/png", size: 10, kind: "image", path: "_inbox/a.png" }], "unknown fields are dropped");
  assert.equal(validateRunAttachments([{ ...inbox("b.txt"), kind: undefined, mime: "text/plain" }])[0]!.kind, "file");
  assert.deepEqual(validateRunAttachments(undefined), []);
  for (const bad of [
    { path: "src/index.ts" }, { path: "/etc/passwd" }, { path: "_inbox/../.env" }, { path: "_inbox/" },
    { path: "_inbox//x" }, { path: "_inbox/a\\b" }, { path: "_inbox/a\0b" }, { path: "C:/x" },
    { kind: "url" }, { kind: "range" }, { mime: "not a mime" }, { size: -1 }, { size: 1.5 }, { name: "" }, { id: "" },
  ]) {
    assert.throws(() => validateRunAttachments([inbox("x.png", bad)]), (error: { code?: string }) => error.code === "invalid-input", JSON.stringify(bad));
  }
  assert.throws(() => validateRunAttachments(Array.from({ length: 17 }, (_, i) => inbox(`${i}.png`))), /at most 16/);
  assert.throws(() => validateRunAttachments("x"), /must be a list/);
});

// ---- the engine --------------------------------------------------------------

/** Admits at once; each run's turn ends when the test says so. */
function heldRunner(extra: Pick<ScheduleRunner, "thread"> & {
  onRun?: () => void;
  /** Admission of the nth run waits for this (a never-settling one hangs). */
  admit?: (n: number) => Promise<void> | undefined;
} = {}) {
  const wakes: AgentWake[] = [];
  const pending: Array<(result: ScheduleRunSettlement) => void> = [];
  let activity: ((activity: AgentRunActivity, steps: number) => void) | undefined;
  const runner: ScheduleRunner = {
    ...(extra.thread ? { thread: extra.thread } : {}),
    async run(task, _runId, wake) {
      extra.onRun?.();
      wakes.push(wake);
      const n = wakes.length;
      await extra.admit?.(n);
      return { sessionId: `s${n}`, markerSeq: 1, key: rollingKeyOf(task) };
    },
    settle(_task, _run, signal, _onWaiting, onActivity) {
      activity = onActivity;
      return new Promise((resolve, reject) => {
        const detached = () => reject(Object.assign(new Error("detached"), { name: "AbortError" }));
        if (signal.aborted) return detached();
        pending.push(resolve);
        // A released observer no longer holds a turn the test could end.
        signal.addEventListener("abort", () => {
          pending.splice(pending.indexOf(resolve), 1);
          detached();
        }, { once: true });
      });
    },
  };
  return {
    runner,
    wakes,
    activity: (next: AgentRunActivity, steps: number) => activity!(next, steps),
    finish: async (result: ScheduleRunSettlement = { status: "ok" }) => {
      pending.shift()!(result);
      for (let i = 0; i < 6; i += 1) await flush();
    },
  };
}

test("messages sent while the agent works wait together, saved until the save that records their run", async (t) => {
  const file = tempFile(t);
  // What the file says when the waiting messages' run is handed to the session.
  const onFile: Array<{ waiting: boolean; input?: string }> = [];
  const held = heldRunner({
    onRun: () => {
      const task = JSON.parse(readFileSync(file, "utf8")).tasks[0];
      onFile.push({ waiting: "queuedStart" in task || "queued" in task, input: task.history[0].input });
    },
  });
  let clock = 1_000;
  const svc = createScheduleService({ file, runner: held.runner, now: () => clock });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id);
  await svc.runNow(agent.id, { input: "First", attachments: [inbox("a.png")] });
  clock = 2_000;
  await svc.runNow(agent.id, { input: "Second", continuation: "new" });
  clock = 3_000;
  await svc.runNow(agent.id, { attachments: [inbox("b.png"), inbox("c.png")], continuation: "auto" });
  assert.equal(held.wakes.length, 1, "they wait for the run in progress");
  assert.equal(svc.runsOf(agent.id).filter((run) => run.status === "skipped").length, 0, "nothing the person said is dropped");
  const queued = [
    { text: "First", at: 1_000, attachments: 1 },
    { text: "Second", at: 2_000, continuation: "new" },
    { text: "", at: 3_000, attachments: 2 },
  ];
  assert.deepEqual(svc.get(agent.id)!.queued, queued, "the page places each by the person's explicit choice; auto is no choice");
  const saved = JSON.parse(readFileSync(file, "utf8")).tasks[0];
  assert.deepEqual(saved.queued, queued, "a restart keeps them");
  assert.equal(saved.queuedStart.input, "First\n\nSecond");
  assert.deepEqual(saved.queuedStart.attachments.map((ref: { name: string }) => ref.name), ["a.png", "b.png", "c.png"]);

  await held.finish();
  assert.equal(held.wakes.length, 2, "one run answers all of them");
  assert.deepEqual(onFile.at(-1), { waiting: false, input: "First\n\nSecond" }, "the save that records the run removes the wait");
  const wake = held.wakes[1]!;
  assert.equal(wake.trigger, "manual");
  assert.equal(wake.input, "First\n\nSecond");
  assert.deepEqual(wake.attachments!.map((ref) => ref.name), ["a.png", "b.png", "c.png"]);
  assert.equal(wake.continuation, "new", "a later auto never overrides the person's choice");
  assert.equal(svc.get(agent.id)!.queued, undefined, "cleared once their run starts");
  const [run] = svc.runsOf(agent.id);
  assert.equal(run!.input, "First\n\nSecond");
  assert.deepEqual(run!.attachments, ["a.png", "b.png", "c.png"].map((name) => ({ name, mime: "image/png", size: 10, kind: "image", path: `_inbox/${name}` })));
  await held.finish();

  // Files from older processes: stray messages without a start, or a start
  // that is not the person's, load without them.
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.tasks[0].queued = [{ text: "stale", at: 1 }];
  writeFileSync(file, JSON.stringify(doc));
  assert.equal(createScheduleService({ file, runner: heldRunner().runner }).get(agent.id)!.queued, undefined);
  doc.tasks[0].queuedStart = { trigger: "schedule" };
  writeFileSync(file, JSON.stringify(doc));
  const reloaded = createScheduleService({ file, runner: heldRunner().runner }).get(agent.id)!;
  assert.equal(reloaded.queued, undefined);
  assert.equal(reloaded.queuedStart, undefined);
});

test("a waiting message survives a restart and is sent once; stopping sends nothing", async (t) => {
  const file = tempFile(t);
  const first = heldRunner({ thread: async () => ({ sessionId: "s1", key: "k", at: 5 }) });
  const svc = createScheduleService({ file, runner: first.runner, now: () => 1_000 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id);
  await svc.runNow(agent.id, { input: "Later", attachments: [inbox("a.png")], continuation: "continue" });
  assert.deepEqual(svc.get(agent.id)!.queued, [{ text: "Later", at: 1_000, attachments: 1, continuation: "continue", sessionId: "s1" }]);
  svc.stop(); // the disable path: releases the run it waits for
  for (let i = 0; i < 6; i += 1) await flush();
  assert.equal(first.wakes.length, 1, "stopping starts nothing");
  assert.equal(svc.runsOf(agent.id)[0]!.status, "running");

  const second = heldRunner();
  const again = createScheduleService({ file, runner: second.runner, now: () => 2_000 });
  t.after(() => again.stop());
  again.start();
  for (let i = 0; i < 6; i += 1) await flush();
  assert.equal(second.wakes.length, 0, "it waits for the resumed run");
  assert.equal(again.get(agent.id)!.queued!.length, 1);
  await second.finish();
  assert.equal(second.wakes.length, 1);
  const wake = second.wakes[0]!;
  assert.equal(wake.input, "Later");
  assert.deepEqual(wake.attachments!.map((ref) => ref.name), ["a.png"]);
  assert.equal(wake.continuation, "continue");
  assert.deepEqual(wake.thread, { sessionId: "s1", key: "k", at: 5 }, "the conversation promised before the restart");
  assert.equal("queuedStart" in JSON.parse(readFileSync(file, "utf8")).tasks[0], false);
  again.stop();

  const third = heldRunner();
  const last = createScheduleService({ file, runner: third.runner, now: () => 3_000 });
  t.after(() => last.stop());
  last.start();
  for (let i = 0; i < 6; i += 1) await flush();
  assert.equal(third.wakes.length, 0, "sent exactly once: the next start only follows its run");
  assert.equal(last.runsOf(agent.id)[0]!.input, "Later");
  last.stop();

  // Polyth stopped while the run it waited for was being admitted: that run
  // cannot be followed, so the message starts with the next start().
  const doc = JSON.parse(readFileSync(file, "utf8"));
  delete doc.tasks[0].history[0].sessionId;
  doc.tasks[0].queuedStart = { trigger: "manual", input: "Still waiting" };
  doc.tasks[0].queued = [{ text: "Still waiting", at: 1 }];
  writeFileSync(file, JSON.stringify(doc));
  const fourth = heldRunner();
  const restarted = createScheduleService({ file, runner: fourth.runner, now: () => 4_000 });
  t.after(() => restarted.stop());
  restarted.start();
  for (let i = 0; i < 6; i += 1) await flush();
  assert.deepEqual(fourth.wakes.map((w) => w.input), ["Still waiting"]);
  assert.deepEqual(restarted.runsOf(agent.id).slice(0, 2).map((run) => run.status), ["running", "unknown"],
    "the unconfirmed run is never replayed");
  restarted.stop();
});

const saved = (file: string) => JSON.parse(readFileSync(file, "utf8")).tasks[0] as ScheduleTask;
const settle = async () => { for (let i = 0; i < 8; i += 1) await flush(); };

test("while stopped nothing runs: a message joins the saved one, even while the run before it is still being admitted", async (t) => {
  const file = tempFile(t);
  let admitFirst!: () => void;
  const firstAdmitted = new Promise<void>((resolve) => { admitFirst = resolve; });
  const held = heldRunner({ admit: (n) => n === 1 ? firstAdmitted : undefined });
  const svc = createScheduleService({ file, runner: held.runner, now: () => 1_000 });
  t.after(() => svc.stop());
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  const first = svc.runNow(agent.id); // run 1 is still being admitted
  await flush();
  await svc.runNow(agent.id, { input: "A" });
  svc.stop();
  await svc.runNow(agent.id, { input: "B" });
  assert.equal(saved(file).queuedStart!.input, "A\n\nB", "B joins A on disk, in order");
  assert.deepEqual(saved(file).queued!.map((message) => message.text), ["A", "B"]);
  await assert.rejects(svc.runNow(agent.id), (error: { code?: string }) => error.code === "unavailable",
    "a wake without the person's words cannot be saved, so it is refused");
  admitFirst();
  await first;
  await settle();
  assert.equal(held.wakes.length, 1, "run 1 settles detached; nothing starts while stopped");
  assert.equal(saved(file).queuedStart!.input, "A\n\nB");

  svc.start();
  await settle();
  assert.equal(held.wakes.length, 1, "they wait for run 1, followed again");
  await held.finish();
  assert.deepEqual(held.wakes.map((wake) => wake.input), [undefined, "A\n\nB"], "sent once, together, in order");
  assert.equal(saved(file).queuedStart, undefined);
  assert.equal(svc.runsOf(agent.id)[1]!.status, "ok");
  await held.finish();
});

test("while stopped a message never jumps ahead of the saved one", async (t) => {
  const file = tempFile(t);
  const held = heldRunner();
  const svc = createScheduleService({ file, runner: held.runner, now: () => 1_000 });
  t.after(() => svc.stop());
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id); // run 1, admitted
  await svc.runNow(agent.id, { input: "A" });
  svc.stop();
  await svc.runNow(agent.id, { input: "B" });
  await settle();
  assert.equal(held.wakes.length, 1, "B did not run at once");
  assert.equal(saved(file).queuedStart!.input, "A\n\nB");
  svc.start();
  await settle();
  assert.equal(held.wakes.length, 1);
  await held.finish();
  assert.deepEqual(held.wakes.map((wake) => wake.input), [undefined, "A\n\nB"]);
  await held.finish();
});

test("a restart before the released observers let go follows their runs again; saved messages wait behind them", async (t) => {
  const file = tempFile(t);
  const held = heldRunner();
  const svc = createScheduleService({ file, runner: held.runner, now: () => 1_000 });
  t.after(() => svc.stop());
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id); // run 1, admitted and followed
  await svc.runNow(agent.id, { input: "A" });
  svc.stop();
  svc.start(); // at once: run 1's observer has not let go yet
  svc.start(); // a second call while starting changes nothing
  await settle();
  assert.equal(held.wakes.length, 1, "the saved message waits: run 1 still works");
  assert.equal(svc.runsOf(agent.id)[0]!.status, "running");
  await held.finish({ status: "ok", summary: "Done." });
  assert.equal(svc.runsOf(agent.id)[1]!.status, "ok", "run 1 was followed again from its session");
  assert.deepEqual(held.wakes.map((wake) => wake.input), [undefined, "A"]);
  await held.finish();
});

test("an observer that lets go only after the restart's wait is followed again once it has; saved messages still wait", async (t) => {
  const file = tempFile(t);
  const wakes: AgentWake[] = [];
  const turns: Array<(result: ScheduleRunSettlement) => void> = [];
  let letGo!: () => void;
  const late = new Promise<void>((resolve) => { letGo = resolve; });
  let followed = 0;
  const runner: ScheduleRunner = {
    async run(task, _runId, wake) {
      wakes.push(wake);
      return { sessionId: `s${wakes.length}`, markerSeq: 1, key: rollingKeyOf(task) };
    },
    settle(_task, _run, signal) {
      followed += 1;
      return new Promise((resolve, reject) => {
        turns.push(resolve);
        // This observer lets go of its run only when the test says so.
        signal.addEventListener("abort", () => { void late.then(() => reject(new Error("detached"))); }, { once: true });
      });
    },
  };
  const svc = createScheduleService({ file, runner, now: () => 1_000, releaseWaitMs: 10 });
  t.after(() => svc.stop());
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id); // run 1, admitted and followed
  await svc.runNow(agent.id, { input: "A" });
  svc.stop();
  svc.start();
  await new Promise((resolve) => setTimeout(resolve, 40)); // past the wait
  await settle();
  assert.equal(wakes.length, 1, "A waits: run 1 still counts as at work");
  assert.equal(followed, 1);
  letGo();
  await settle();
  assert.equal(followed, 2, "run 1 is followed again once its old observer let go");
  assert.equal(wakes.length, 1);
  turns.at(-1)!({ status: "ok" });
  await settle();
  assert.equal(svc.runsOf(agent.id)[1]!.status, "ok");
  assert.deepEqual(wakes.map((wake) => wake.input), [undefined, "A"]);
  turns.at(-1)!({ status: "ok" });
  await settle();
});

test("two restarts past the wait still keep saved messages behind the run they follow again", async (t) => {
  const file = tempFile(t);
  const wakes: AgentWake[] = [];
  const turns: Array<(result: ScheduleRunSettlement) => void> = [];
  let letGo!: () => void;
  const late = new Promise<void>((resolve) => { letGo = resolve; });
  const runner: ScheduleRunner = {
    async run(task, _runId, wake) {
      wakes.push(wake);
      return { sessionId: `s${wakes.length}`, markerSeq: 1, key: rollingKeyOf(task) };
    },
    settle(_task, _run, signal) {
      return new Promise((resolve, reject) => {
        turns.push(resolve);
        signal.addEventListener("abort", () => { void late.then(() => reject(new Error("detached"))); }, { once: true });
      });
    },
  };
  const svc = createScheduleService({ file, runner, now: () => 1_000, releaseWaitMs: 10 });
  t.after(() => svc.stop());
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id);
  await svc.runNow(agent.id, { input: "A" });
  for (let i = 0; i < 2; i += 1) {
    svc.stop();
    svc.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  letGo();
  await settle();
  assert.equal(wakes.length, 1, "A still waits: run 1 is followed again and works");
  turns.at(-1)!({ status: "ok" });
  await settle();
  assert.deepEqual(wakes.map((wake) => wake.input), [undefined, "A"]);
  turns.at(-1)!({ status: "ok" });
  await settle();
});

test("a stop while a message is being queued keeps it as the person's: no skip, sent after start", async (t) => {
  const file = tempFile(t);
  let answer!: () => void;
  const reading = new Promise<void>((resolve) => { answer = resolve; });
  const held = heldRunner({ thread: async () => { await reading; return { sessionId: "s1", key: "k", at: 5 }; } });
  const svc = createScheduleService({ file, runner: held.runner, now: () => 1_000 });
  t.after(() => svc.stop());
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id); // run 1
  const queueing = svc.runNow(agent.id, { input: "A" });
  await settle();
  svc.stop(); // while A's conversation is being read
  answer();
  await queueing;
  assert.equal(svc.runsOf(agent.id).filter((run) => run.status === "skipped").length, 0, "no skip for a message that still goes");
  assert.equal(saved(file).queuedStart!.input, "A");
  svc.start();
  await settle();
  await held.finish();
  assert.deepEqual(held.wakes.map((wake) => wake.input), [undefined, "A"]);
  await held.finish();
});

test("a wake that waited in memory only is not lost silently when the agents stop", async (t) => {
  const file = tempFile(t);
  const held = heldRunner();
  const svc = createScheduleService({ file, runner: held.runner, now: () => 1_000 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true, overlapPolicy: "queue" });
  await svc.runNow(agent.id); // run 1
  await svc.runNow(agent.id); // a plain wake queues behind it
  svc.stop();
  await settle();
  const [skip] = svc.runsOf(agent.id);
  assert.equal(skip!.status, "skipped");
  assert.match(skip!.error ?? "", /stopped the agents before this queued wake/);
  assert.equal(saved(file).history![0]!.status, "skipped", "on disk");
  assert.equal(held.wakes.length, 1);

  // An event wake that waited the same way names its trigger and events.
  const events = heldRunner();
  const watcher = createScheduleService({ file: tempFile(t), runner: events.runner, now: () => 5_000 });
  const pace = { quietMs: 0, coalesce: "batch" as const, maxPerHour: 60 };
  const agent2 = watcher.create({
    projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true, overlapPolicy: "queue",
    eventTriggers: [{ id: "fails", kind: "session", on: ["failed"], pace }],
  });
  await watcher.runNow(agent2.id);
  watcher.dispatchEvent({ id: "e1", kind: "session", at: 4_999, projectId: "p", outcome: "failed", chainDepth: 0, fields: { title: "Deploy api" } });
  await watcher.flushEvents();
  watcher.stop();
  await settle();
  const [dropped] = watcher.runsOf(agent2.id);
  assert.equal(dropped!.status, "skipped");
  assert.equal(dropped!.trigger, "event");
  assert.equal(dropped!.events?.length, 1);
});

test("a hung admission holds the message lock only for its bound", async (t) => {
  const file = tempFile(t);
  const held = heldRunner({ admit: (n) => n === 1 ? new Promise<void>(() => {}) : undefined });
  const svc = createScheduleService({ file, runner: held.runner, now: () => 1_000, admissionWaitMs: 20 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  const within = (work: Promise<unknown>) => Promise.race([
    work.then(() => "answered"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
  ]);
  assert.equal(await within(svc.runNow(agent.id, { input: "First" })), "answered");
  assert.equal(await within(svc.runNow(agent.id, { input: "Second" })), "answered", "the next message is not stuck behind it");
  assert.equal(saved(file).queuedStart!.input, "Second", "and it is saved to wait");
  assert.equal(held.wakes.length, 1);
});

test("a saved message to a repository agent whose file changed meanwhile is not sent, and says so", async (t) => {
  const held = heldRunner();
  const schedule = createScheduleService({ file: tempFile(t), runner: held.runner, now: () => 1_700_000_000_000 });
  const spec = { id: "nightly", title: "Nightly", cron: "0 2 * * *", timeZone: "UTC", enabled: true, prompt: "review" };
  const current = { path: "/repo/.agents/loops/nightly.md", digest: "a".repeat(64), loop: spec };
  const task = schedule.syncLoops("project-1", [current]).tasks[0]!;
  schedule.trustLoopVersion(task.id, "space-1", current);
  await schedule.runNow(task.id);
  await schedule.runNow(task.id, { input: "and the docs?", attachments: [inbox("a.png")] });
  schedule.syncLoops("project-1", [{ ...current, digest: "b".repeat(64), loop: { ...spec, prompt: "review more" } }]);
  assert.equal(schedule.get(task.id)!.trustState, "changed-since-trust");
  await held.finish();
  assert.equal(held.wakes.length, 1, "nothing ran the unreviewed version");
  const [skip] = schedule.runsOf(task.id);
  assert.equal(skip!.status, "skipped");
  assert.equal(skip!.input, "and the docs?", "the journal shows what was not delivered");
  assert.deepEqual(skip!.attachments!.map((file) => file.name), ["a.png"]);
  assert.match(skip!.error!, /changed/);
  assert.equal(schedule.get(task.id)!.queuedStart, undefined);
  assert.equal(schedule.get(task.id)!.queued, undefined);
});

test("saved waiting messages are checked on load: bad entries and malformed events are dropped", async (t) => {
  const file = tempFile(t);
  const svc = createScheduleService({ file, runner: heldRunner().runner, now: () => 1 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  svc.markSeen(agent.id, 1);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.tasks[0].queuedStart = { trigger: "manual", input: "Hi" };
  doc.tasks[0].queued = [{ text: "Hi", at: 5, sessionId: "s1", attachments: "two" }, { text: 3, at: 5 }, { text: "x" }, null];
  writeFileSync(file, JSON.stringify(doc));
  assert.deepEqual(createScheduleService({ file, runner: heldRunner().runner }).get(agent.id)!.queued, [{ text: "Hi", at: 5, sessionId: "s1" }]);
  doc.tasks[0].queuedStart = { trigger: "event", input: "Hi", events: ["not an event"] };
  writeFileSync(file, JSON.stringify(doc));
  const reloaded = createScheduleService({ file, runner: heldRunner().runner }).get(agent.id)!;
  assert.equal(reloaded.queuedStart, undefined);
  assert.equal(reloaded.queued, undefined);
});

test("a message is refused, not dropped, when it cannot join the waiting run", async (t) => {
  const held = heldRunner();
  const svc = createScheduleService({ file: tempFile(t), runner: held.runner, now: () => 1_000 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id);
  await svc.runNow(agent.id, { input: "a".repeat(5_000), attachments: Array.from({ length: 10 }, (_, i) => inbox(`${i}.png`)) });
  const tooLarge = (error: { code?: string }) => error.code === "payload-too-large";
  await assert.rejects(svc.runNow(agent.id, { input: "b".repeat(AGENT_INPUT_LIMIT - 5_000 - 1) }), tooLarge);
  await assert.rejects(svc.runNow(agent.id, { attachments: Array.from({ length: 7 }, (_, i) => inbox(`x${i}.png`)) }), tooLarge);
  await svc.runNow(agent.id, { input: "c".repeat(AGENT_INPUT_LIMIT - 5_000 - 2), attachments: [inbox("last.png")] });
  assert.equal(svc.get(agent.id)!.queued!.length, 2, "only the messages it kept are listed");
  await held.finish();
  assert.equal(held.wakes[1]!.input!.length, AGENT_INPUT_LIMIT, "nothing was cut");
  assert.equal(held.wakes[1]!.attachments!.length, 11);
  assert.equal(svc.runsOf(agent.id).filter((run) => run.status === "skipped").length, 0);
  await held.finish();
  svc.update(agent.id, { target: { mode: "existing-session", sessionId: "chat" } });
  await assert.rejects(svc.runNow(agent.id, { input: "x", continuation: "new" }),
    (error: { code?: string; message: string }) => error.code === "invalid-input" && /chosen for it/.test(error.message),
    "an agent bound to one session has no new conversation to start");
  assert.equal(held.wakes.length, 2);
});

test("a loop's waiting one-off version refuses the person's message instead of logging a skip", async (t) => {
  const held = heldRunner();
  const schedule = createScheduleService({ file: tempFile(t), runner: held.runner, now: () => 1_700_000_000_000 });
  const current = { path: "/repo/.agents/loops/nightly.md", digest: "a".repeat(64), loop: {
    id: "nightly", title: "Nightly", cron: "0 2 * * *", timeZone: "UTC", enabled: true, prompt: "review",
  } };
  const task = schedule.syncLoops("project-1", [current]).tasks[0]!;
  schedule.trustLoopVersion(task.id, "space-1", current);
  schedule.get(task.id)!.overlapPolicy = "queue";
  await schedule.runNow(task.id);
  await schedule.runLoopVersionOnce(task.id, "space-1", current);
  await assert.rejects(schedule.runNow(task.id, { input: "and the docs?" }), (error: { code?: string; message: string }) =>
    error.code === "conflict" && /one-off run/.test(error.message));
  assert.equal(schedule.runsOf(task.id).filter((run) => run.status === "skipped").length, 0);
  assert.equal(schedule.get(task.id)!.queued, undefined);
  await held.finish();
  await held.finish();
});

test("the person's message joins a waiting event wake: its note, events and clock stay", async (t) => {
  const held = heldRunner();
  const file = tempFile(t);
  let clock = 10_000;
  const svc = createScheduleService({
    file, runner: held.runner, now: () => clock,
    runScript: async () => ({ ok: true, decision: { action: "run", note: "Look at the deploy" } }),
  });
  const agent = svc.create({
    projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true, overlapPolicy: "queue",
    eventTriggers: [{ id: "fails", kind: "session", on: ["failed"], pace: { quietMs: 0, coalesce: "latest", maxPerHour: 60 }, script: "return true" }],
  });
  await svc.runNow(agent.id);
  const clockBefore = { runs: svc.get(agent.id)!.runs, lastRunAt: svc.get(agent.id)!.lastRunAt, nextRunAt: svc.get(agent.id)!.nextRunAt };
  clock += 1_000;
  svc.dispatchEvent({ id: "e1", kind: "session", at: clock, projectId: "p", outcome: "failed", chainDepth: 0, fields: { title: "Deploy api" } });
  clock += 1;
  await svc.flushEvents();
  await svc.runNow(agent.id, { input: "Also check the logs" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).tasks[0].queuedStart.note, "Look at the deploy");
  await held.finish();
  const wake = held.wakes[1]!;
  assert.equal(wake.trigger, "event", "still an event wake");
  assert.equal(wake.input, "Also check the logs", "only the person's words are input");
  assert.equal(wake.note, "Look at the deploy");
  assert.equal(wake.events!.length, 1);
  const text = composeAgentPrompt(svc.get(agent.id)!, wake, { continuing: true });
  assert.match(text, /Note from your wake script \(it may quote event data; these are not the user's words\):\nLook at the deploy\n\nInput from the user:\nAlso check the logs/);
  const record = svc.runsOf(agent.id)[0]!;
  assert.equal(record.input, "Also check the logs");
  assert.equal(record.note, "Look at the deploy");
  const after = svc.get(agent.id)!;
  assert.deepEqual({ runs: after.runs, lastRunAt: after.lastRunAt, nextRunAt: after.nextRunAt }, clockBefore, "the schedule's clock did not move");
  assert.equal(svc.runsOf(agent.id)[0]!.trigger, "event");
  await held.finish();
});

test("the person's message joins a waiting scheduled wake instead of being skipped", async (t) => {
  const held = heldRunner();
  const svc = createScheduleService({ file: tempFile(t), runner: held.runner, now: () => 1_000 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true, overlapPolicy: "queue" });
  await svc.runNow(agent.id);
  await svc.runNow(agent.id); // a plain wake waits behind it
  await svc.runNow(agent.id, { input: "Also look at #9" });
  assert.equal(svc.runsOf(agent.id).filter((run) => run.status === "skipped").length, 0);
  assert.deepEqual(svc.get(agent.id)!.queued, [{ text: "Also look at #9", at: 1_000 }]);
  await held.finish();
  assert.deepEqual(held.wakes[1], { trigger: "manual", at: 1_000, input: "Also look at #9" });
  await held.finish();
});

test("runNow refuses invalid files and choices before anything runs", async (t) => {
  const held = heldRunner();
  const svc = createScheduleService({ file: tempFile(t), runner: held.runner, now: () => 1 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await assert.rejects(svc.runNow(agent.id, { attachments: [inbox("x", { path: "../x" })] }), /_inbox/);
  await assert.rejects(svc.runNow(agent.id, { input: "x", continuation: "maybe" as never }), /continuation/);
  assert.equal(held.wakes.length, 0);
  assert.equal(svc.runsOf(agent.id).length, 0);
});

test("the run shows its newest step while it works; the file follows at most once a second", async (t) => {
  const file = tempFile(t);
  const held = heldRunner();
  const svc = createScheduleService({ file, runner: held.runner, now: () => 1 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id);
  await flush();
  for (let i = 1; i <= 40; i += 1) held.activity({ kind: "text", at: i, text: `line ${i}` }, 2);
  held.activity({ kind: "tool", at: 41, tool: "bash", input: { command: "npm test" } }, 3);
  const live = svc.runsOf(agent.id)[0]!;
  assert.deepEqual(live.activity, { kind: "tool", at: 41, tool: "bash", input: { command: "npm test" } });
  assert.equal(live.steps, 3);
  assert.doesNotMatch(readFileSync(file, "utf8"), /"activity"/, "a burst of steps does not write the file each time");
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  const saved = JSON.parse(readFileSync(file, "utf8")).tasks[0].history[0];
  assert.equal(saved.activity.tool, "bash", "the newest step reaches the file shortly after");

  await held.finish({ status: "ok", summary: "Done." });
  const [run] = svc.runsOf(agent.id);
  assert.equal(run!.activity, undefined, "a finished run has no current step");
  assert.equal(run!.steps, 3, "the count of steps stays");
  assert.doesNotMatch(readFileSync(file, "utf8"), /"activity"/);
});

test("an event run's script note is not the person's words, also in records saved before schema 5", async (t) => {
  const quiet: ScheduleRunRecord = { runId: "q", startedAt: 1, status: "ok", trigger: "event", sessionId: "s-q", signal: "quiet", note: "Look at the deploy" };
  assert.equal(followUpRun([quiet]), undefined, "a quiet run with only a note is no exchange with the person");

  const file = tempFile(t);
  const svc = createScheduleService({ file, runner: heldRunner().runner, now: () => 1 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  svc.markSeen(agent.id, 1);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(doc.v, 5);
  doc.v = 4;
  doc.tasks[0].history = [
    { runId: "e", startedAt: 1, status: "ok", trigger: "event", input: "Look at the deploy" },
    { runId: "m", startedAt: 1, status: "ok", trigger: "manual", input: "Hello" },
  ];
  writeFileSync(file, JSON.stringify(doc));
  const migrated = createScheduleService({ file, runner: heldRunner().runner }).runsOf(agent.id);
  assert.deepEqual(migrated.map((run) => [run.input, run.note]), [[undefined, "Look at the deploy"], ["Hello", undefined]]);
  const rewritten = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(rewritten.v, 5, "migrated once, then saved under the new schema");
  assert.equal(rewritten.tasks[0].history[0].note, "Look at the deploy");

  // Written by this schema: an event run's input is the person's words and stays.
  rewritten.tasks[0].history = [{ runId: "j", startedAt: 1, status: "ok", trigger: "event", input: "Also the logs" }];
  writeFileSync(file, JSON.stringify(rewritten));
  const kept = createScheduleService({ file, runner: heldRunner().runner }).runsOf(agent.id)[0]!;
  assert.equal(kept.input, "Also the logs");
  assert.equal(kept.note, undefined);
});

// ---- settlement --------------------------------------------------------------

test("settlement reports the run's own steps: tools with bounded input, the newest line, distinct calls", async () => {
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>): SessionEvent =>
    ({ seq: ++seq, type, data, time: 100 + seq, sessionId: "s" }) as unknown as SessionEvent;
  const before = ev("tool/started", { callId: "old", tool: "read", input: { path: "a" } });
  const marker = ev("schedule/run-started", {});
  const events = [
    before, marker,
    ev("tool/call", { callId: "early", tool: "x", input: {} }), // admitted, but not in the turn yet
    ev("turn/started", {}),
    ev("tool/call", { callId: "c1", tool: "bash", input: { command: "ls" }, status: "pending" }),
    ev("tool/started", {
      callId: "c1", tool: "bash",
      input: {
        command: `echo ${"x".repeat(400)}`, nested: { a: 1 }, list: [1, 2], timeout: 30, background: false, empty: "",
        k1: "1", k2: "2", k3: "3", k4: "4", k5: "5", k6: "6", k7: "7",
      },
    }),
    ev("tool/result", { callId: "c1", tool: "bash", output: "ok" }),
    ev("assistant/reasoning-chunk", { partId: "r1", text: "Thinking about\nthe tes" }),
    ev("assistant/reasoning-chunk", { partId: "r1", text: "ts" }),
    ev("tool/result", { callId: "c2", tool: "read", output: "…" }),
    ev("assistant/chunk", { partId: "p1", text: "All good.\nNext line" }),
    ev("assistant/message", { partId: "p1", text: "All good.\nNext line\n\n" }),
    ev("turn/stopped", { reason: "completed" }),
  ];
  const seen: Array<{ activity: AgentRunActivity; steps: number }> = [];
  const result = await settleScheduledRun({ sessionId: "s", markerSeq: marker.seq, startedAt: 0 }, {
    signal: new AbortController().signal,
    events: async (_id, after) => events.filter((event) => event.seq > after),
    onActivity: (activity, steps) => seen.push({ activity, steps }),
  });
  assert.equal(result.status, "ok");
  const tool = seen[0]!.activity;
  assert.equal(tool.kind, "tool");
  assert.equal(tool.tool, "bash");
  assert.equal(tool.at, events[5]!.time);
  assert.deepEqual(Object.keys(tool.input!), ["command", "timeout", "background", "k1", "k2", "k3", "k4", "k5"],
    "primitive values only, at most eight keys");
  assert.ok((tool.input!.command as string).length <= 240 && (tool.input!.command as string).endsWith("…"));
  assert.equal(seen[0]!.steps, 1, "the pending call and its start are one step");
  assert.deepEqual(seen.map((entry) => entry.activity.kind === "tool" ? "tool" : `${entry.activity.kind}:${entry.activity.text}`), [
    "tool", "thinking:the tes", "thinking:the tests", "thinking:the tests", "text:Next line",
  ]);
  assert.equal(seen.at(-1)!.steps, 2, "steps counts distinct tool calls of this turn");
  assert.ok(!seen.some((entry) => entry.activity.tool === "read" || entry.activity.tool === "x"), "nothing before the turn counts");
});

test("a step keeps its id and the time it began while its words grow", async () => {
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>): SessionEvent =>
    ({ seq: ++seq, type, data, time: 100 + seq, sessionId: "s" }) as unknown as SessionEvent;
  const marker = ev("schedule/run-started", {});
  const events = [
    marker,
    ev("turn/started", {}),
    ev("tool/started", { callId: "c1", tool: "bash", input: { command: "ls" } }), // 103
    ev("assistant/reasoning-chunk", { partId: "r1", text: "Thinking" }), // 104
    ev("assistant/reasoning-chunk", { partId: "r1", text: " more\nNext" }),
    ev("assistant/chunk", { text: "Hello" }), // 106, no part id
    ev("assistant/chunk", { text: " world" }),
    ev("assistant/message", { text: "Hello world" }), // the same step, ended
    ev("assistant/chunk", { partId: "p2", text: "Bye" }), // 109
    ev("assistant/message", { partId: "p2", text: "Bye now" }),
    ev("turn/stopped", { reason: "completed" }),
  ];
  const seen: AgentRunActivity[] = [];
  await settleScheduledRun({ sessionId: "s", markerSeq: marker.seq, startedAt: 0 }, {
    signal: new AbortController().signal,
    events: async (_id, after) => events.filter((event) => event.seq > after),
    onActivity: (activity) => seen.push(activity),
  });
  assert.deepEqual(seen.map((step) => [step.id, step.at, step.text ?? step.tool]), [
    ["c1", 103, "bash"],
    ["r1", 104, "Thinking"],
    ["r1", 104, "Next"],
    ["step-1", 106, "Hello"],
    ["step-1", 106, "Hello world"],
    ["p2", 109, "Bye"],
    ["p2", 109, "Bye now"],
  ]);
});

// ---- the runner and routes -----------------------------------------------------

interface SessionState { status?: string; fraction?: number; compactedAt?: number }

async function host(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-continuation-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = { id: "prj", path: dir, name: "P", createdAt: 1, spaceId: "spc" };
  const logs = new Map<string, SessionEvent[]>();
  const states = new Map<string, SessionState>();
  const sent: Array<{ sessionId: string; text: string; attachments?: unknown[] }> = [];
  const replies: string[] = [];
  const purposes = new Map<string, string>();
  // While `hold.on`, a sent turn starts and waits for `release`.
  const hold = { on: false };
  const holding: Array<(text: string) => void> = [];
  const append = (sessionId: string, type: string, data: JsonObject): SessionEvent => {
    const log = logs.get(sessionId) ?? [];
    logs.set(sessionId, log);
    const event = { id: `${sessionId}-${log.length + 1}`, seq: log.length + 1, sessionId, type, data, time: Date.now() } as unknown as SessionEvent;
    log.push(event);
    return event;
  };
  const sessions = {
    async create(input: { purpose?: string }) {
      const id = `ses${logs.size + 1}`;
      logs.set(id, []);
      if (input.purpose) purposes.set(id, input.purpose);
      return { id };
    },
    async snapshot(id: string) { return { id, projectId: "prj", status: states.get(id)?.status ?? "idle", purpose: purposes.get(id) }; },
    async send(sessionId: string, input: { text: string; attachments?: unknown[] }) {
      sent.push({ sessionId, text: input.text, ...(input.attachments ? { attachments: input.attachments } : {}) });
      const n = sent.length;
      append(sessionId, "turn/started", {});
      append(sessionId, "tool/started", { callId: `call-${n}`, tool: "read", input: { path: "README.md" } });
      const end = (text: string) => {
        append(sessionId, "assistant/message", { text });
        append(sessionId, "turn/stopped", { reason: "completed" });
      };
      if (hold.on) holding.push(end);
      else end(replies.shift() ?? `Answer ${n}\nReport: update — answer ${n}`);
      return { turnId: `t${n}` };
    },
  };
  const services = new Map<string, unknown>();
  const fake = {
    pluginId: "agents",
    deployment: "local-trusted",
    storageDir: join(dir, "shared"),
    projects: { list: async () => [project], get: async (id: string) => id === project.id ? project : undefined },
    systemSpaceContext: (spaceId: string) => ({ spaceId, userId: RUNTIME_SYSTEM_PRINCIPAL_ID, storageDir: join(dir, spaceId) }),
    spaceStorage: (ctx: { spaceId: string }) => ({
      root: join(dir, ctx.spaceId),
      packageDir: (id: string) => join(dir, ctx.spaceId, "packages", id),
      path: (relative: string) => join(dir, ctx.spaceId, relative),
    }),
    forSpace: () => ({ projects: fake.projects, sessions }),
    store: {
      projection: async (id: string) => {
        if (!logs.has(id)) return undefined;
        const state = states.get(id) ?? {};
        return {
          id, projectId: "prj", spaceId: "spc", status: state.status ?? "idle",
          ...(purposes.has(id) ? { purpose: purposes.get(id) } : {}),
          contextWindow: {
            source: "native", updatedAt: 1, fraction: state.fraction ?? 0.2,
            ...(state.compactedAt ? { compaction: { lastAt: state.compactedAt } } : {}),
          },
        };
      },
      events: async (id: string, afterSeq = 0) => (logs.get(id) ?? []).filter((event) => event.seq > afterSeq),
    },
    events: { append: async (id: string, type: string, data: JsonObject) => append(id, type, data) },
    services: {
      provide: (key: { id: string }, value: unknown) => { services.set(key.id, value); },
      get: (key: { id: string }) => services.get(key.id),
    },
  };
  const pkg = registerPackage(fake as never);
  await pkg.onEnable!();
  t.after(() => pkg.onDisable!());
  const agents = services.get(serverServiceKey<ScheduleService>("agents").id) as ScheduleService;
  const settled = async (id: string) => {
    for (let i = 0; i < 200 && agents.runsOf(id)[0]?.status === "running"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await flush();
  };
  const call = async (path: string, method: string, body?: Record<string, unknown>) => {
    let payload: Record<string, unknown> = {};
    let status = 0;
    await pkg.routes!({
      path, method, url: new URL(`http://x${path}`), body: async () => body ?? {},
      json: (code: number, value: Record<string, unknown>) => { status = code; payload = value; },
      space: { spaceId: "spc", userId: "u", role: "owner" },
    } as never);
    return { status, payload };
  };
  /** Talk to the agent the way its page does, and wait for the answer. */
  const say = async (id: string, input?: string, extra: Record<string, unknown> = {}) => {
    const response = await call(`/api/schedule/${id}/run`, "POST", { ...(input ? { input } : {}), ...extra });
    await settled(id);
    return response;
  };
  const followUp = async (id: string) => {
    const { payload } = await call("/api/schedule", "GET");
    return (payload.tasks as Array<ScheduleTask & { followUp?: Record<string, unknown> }>).find((task) => task.id === id)!.followUp;
  };
  /** Wait (the runner polls a held turn about once a second) until `ready`. */
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 1_000 && !ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(ready(), "timed out");
  };
  /** End the oldest held turn with `text`. */
  const release = (text: string) => holding.shift()!(text);
  /** An ordinary chat in the project, not one of an agent's sessions. */
  const chat = (id: string) => { logs.set(id, []); };
  return { agents, sent, states, replies, call, say, followUp, settled, hold, release, until, chat };
}

const fresh = (agents: ScheduleService, over: Record<string, unknown> = {}) => agents.create({
  projectId: "prj", spaceId: "spc", prompt: "You review merged pull requests.", kind: "every", everyMinutes: 60,
  manualOnly: true, target: { mode: "new-session-per-run" }, ...over,
});

/** The exchange ended `hours` ago. */
const age = (run: ScheduleRunRecord, hours: number) => {
  run.startedAt = Date.now() - hours * HOUR - 1_000;
  run.finishedAt = Date.now() - hours * HOUR;
};

test("a fresh agent's report can be answered in its own conversation", async (t) => {
  const { agents, sent, say, followUp } = await host(t);
  const agent = fresh(agents, { notebook: "Prefers short reports." });
  assert.deepEqual(await followUp(agent.id), { reason: "none" });

  await say(agent.id);
  const report = agents.runsOf(agent.id)[0]!;
  assert.equal(report.sessionId, "ses1");
  assert.equal(report.key, rollingKeyOf(agents.get(agent.id)!));
  assert.equal(report.fresh, undefined, "a run nobody wrote to has nothing to explain");
  assert.deepEqual(await followUp(agent.id), { sessionId: "ses1", at: report.finishedAt, until: report.finishedAt! + FOLLOW_UP_WINDOW_MS });

  agents.update(agent.id, { notebook: "Prefers very short reports." });
  await say(agent.id, "What about the flaky test?");
  assert.equal(sent[1]!.sessionId, "ses1", "the reply continues the conversation it answers");
  assert.doesNotMatch(sent[1]!.text, /^You review merged pull requests/);
  assert.match(sent[1]!.text, /Your notebook changed[^\n]*\nPrefers very short reports\./);
  assert.match(sent[1]!.text, /Input from the user:\nWhat about the flaky test\?/);
  assert.match(sent[1]!.text, /Continue following your standing instructions/);
  const reply = agents.runsOf(agent.id)[0]!;
  assert.equal(reply.continued, true);
  assert.equal(reply.key, report.key);
  assert.equal(reply.fresh, undefined);

  await say(agent.id, "And the deploy?");
  assert.equal(sent[2]!.sessionId, "ses1");
  assert.doesNotMatch(sent[2]!.text, /notebook/i, "the session has seen the notebook now");

  await say(agent.id);
  assert.equal(sent[3]!.sessionId, "ses2", "a run nobody wrote to still starts its own session");
  assert.match(sent[3]!.text, /^You review merged pull requests/);
});

test("the person's message starts a new conversation when the exchange is old, gone, full, changed or they ask", async (t) => {
  const { agents, sent, states, say, followUp } = await host(t);
  const agent = fresh(agents);
  await say(agent.id);
  const last = () => agents.runsOf(agent.id)[0]!;

  age(last(), 9);
  assert.deepEqual(await followUp(agent.id), { reason: "idle" });
  await say(agent.id, "Still there?");
  assert.equal(sent[1]!.sessionId, "ses2");
  assert.equal(last().fresh, "idle");
  assert.equal(last().continued, undefined);
  assert.match(sent[1]!.text, /^You review merged pull requests/, "a new conversation gets the charter");

  age(last(), 9);
  await say(agent.id, "Pick it up anyway", { continuation: "continue" });
  assert.equal(sent[2]!.sessionId, "ses2", "continue overrides the idle window");
  assert.equal(last().continued, true);

  await say(agent.id, "Start over", { continuation: "new" });
  assert.equal(sent[3]!.sessionId, "ses3");
  assert.equal(last().fresh, "asked");

  states.set("ses3", { fraction: 0.7 });
  assert.deepEqual(await followUp(agent.id), { reason: "context-full" });
  await say(agent.id, "More");
  assert.equal(sent[4]!.sessionId, "ses4");
  assert.equal(last().fresh, "context-full");

  states.set("ses4", { status: "archived" });
  await say(agent.id, "Hello again");
  assert.equal(sent[5]!.sessionId, "ses5");
  assert.equal(last().fresh, "unavailable");

  agents.update(agent.id, { prompt: "You review merged pull requests and releases." });
  assert.deepEqual(await followUp(agent.id), { reason: "instructions-changed" });
  await say(agent.id, "Carry on", { continuation: "continue" });
  assert.equal(sent[6]!.sessionId, "ses6", "continue never keeps a conversation with stale instructions");
  assert.equal(last().fresh, "instructions-changed");
  assert.equal(last().key, rollingKeyOf(agents.get(agent.id)!));
});

test("a rolling agent starts a new conversation when the person asks, then keeps it", async (t) => {
  const { agents, sent, say, followUp } = await host(t);
  const agent = agents.create({
    projectId: "prj", spaceId: "spc", prompt: "You watch the build.", kind: "every", everyMinutes: 60,
    manualOnly: true, target: { mode: "dedicated-session" },
  });
  await say(agent.id);
  assert.equal(agents.runsOf(agent.id)[0]!.fresh, undefined, "the first session has nothing to explain");
  const first = agents.runsOf(agent.id)[0]!;
  assert.deepEqual(await followUp(agent.id), { sessionId: "ses1", at: first.finishedAt, until: null });

  await say(agent.id, "check #7");
  assert.equal(sent[1]!.sessionId, "ses1");
  assert.equal(agents.runsOf(agent.id)[0]!.continued, true);

  await say(agent.id, "Forget all that", { continuation: "new" });
  const rotatedRun = agents.runsOf(agent.id)[0]!;
  assert.equal(sent[2]!.sessionId, "ses2");
  assert.match(sent[2]!.text, /^You watch the build\./);
  assert.equal(rotatedRun.fresh, "asked");
  assert.equal(rotatedRun.rotated, undefined, "the legacy field keeps its three reasons");
  assert.equal(agents.get(agent.id)!.rollingKey, rollingKeyOf(agents.get(agent.id)!));
  assert.equal(agents.get(agent.id)!.lastSessionId, "ses2");

  await say(agent.id);
  assert.equal(sent[3]!.sessionId, "ses2", "the new conversation is the agent's ongoing one");
  assert.equal(agents.runsOf(agent.id)[0]!.continued, true);
  assert.equal(agents.runsOf(agent.id)[0]!.key, rotatedRun.key);
});

test("a message that waited goes where the page promised, even after a quiet run; only that session's health is checked again", async (t) => {
  const { agents, sent, states, call, say, followUp, settled, hold, release, until } = await host(t);
  const agent = fresh(agents);
  const runPath = `/api/schedule/${agent.id}/run`;
  const sessionsOf = (payload: Record<string, unknown>) => (payload.queued as Array<{ sessionId?: string }>).map((message) => message.sessionId);
  await say(agent.id, "First question"); // ses1: an older exchange

  // A plain wake works in ses2; the page offers to follow it up.
  hold.on = true;
  await call(runPath, "POST");
  await until(() => sent.length === 2);
  assert.equal(sent[1]!.sessionId, "ses2");
  assert.equal((await followUp(agent.id))!.sessionId, "ses2");
  const queued = await call(runPath, "POST", { input: "About that" });
  assert.equal(queued.status, 200);
  assert.deepEqual(sessionsOf(queued.payload), ["ses2"]);
  assert.equal((queued.payload.followUp as { sessionId?: string }).sessionId, "ses2");
  assert.equal((queued.payload.followUp as { until?: unknown }).until, null, "the next message joins the waiting one");
  const tooLong = await call(runPath, "POST", { input: "x".repeat(AGENT_INPUT_LIMIT) });
  assert.equal(tooLong.status, 413, "the waiting run could not carry it whole");
  assert.equal(tooLong.payload.error, "payload-too-large");
  hold.on = false;
  release("Nothing new.\nReport: quiet — nothing new");
  await until(() => sent.length === 3);
  await settled(agent.id);
  assert.equal(sent[2]!.sessionId, "ses2", "the quiet run's session, as promised; not the older exchange");
  assert.equal(agents.runsOf(agent.id)[0]!.input, "About that");
  assert.equal(agents.runsOf(agent.id)[0]!.continued, true);

  // A later explicit choice moves the waiting run.
  hold.on = true;
  await call(runPath, "POST");
  await until(() => sent.length === 4); // ses3
  assert.deepEqual(sessionsOf((await call(runPath, "POST", { input: "One" })).payload), ["ses3"]);
  const moved = await call(runPath, "POST", { input: "Two", continuation: "new" });
  assert.deepEqual(sessionsOf(moved.payload), [undefined, undefined]);
  assert.deepEqual(moved.payload.followUp, { reason: "asked" });
  hold.on = false;
  release("Done.\nReport: update — done");
  await until(() => sent.length === 5);
  await settled(agent.id);
  assert.equal(sent[4]!.sessionId, "ses4");
  assert.equal(agents.runsOf(agent.id)[0]!.input, "One\n\nTwo");
  assert.equal(agents.runsOf(agent.id)[0]!.fresh, "asked");

  // The promised session was archived while the message waited.
  hold.on = true;
  await call(runPath, "POST");
  await until(() => sent.length === 6); // ses5
  assert.deepEqual(sessionsOf((await call(runPath, "POST", { input: "Three" })).payload), ["ses5"]);
  states.set("ses5", { status: "archived" });
  hold.on = false;
  release("Done.\nReport: update — done");
  await until(() => sent.length === 7);
  await settled(agent.id);
  assert.equal(sent[6]!.sessionId, "ses6");
  assert.equal(agents.runsOf(agent.id)[0]!.fresh, "unavailable");
});

test("an agent bound to a chosen session refuses a new conversation; switched to fresh, it never follows up that chat", async (t) => {
  const { agents, sent, call, say, followUp, chat } = await host(t);
  chat("chat1");
  const agent = agents.create({
    projectId: "prj", spaceId: "spc", prompt: "You triage.", kind: "every", everyMinutes: 60,
    manualOnly: true, target: { mode: "existing-session", sessionId: "chat1" },
  });
  const refused = await call(`/api/schedule/${agent.id}/run`, "POST", { input: "Start over", continuation: "new" });
  assert.equal(refused.status, 400);
  assert.equal(refused.payload.error, "invalid-input");
  assert.match(String(refused.payload.message), /chosen for it/);
  assert.equal(sent.length, 0);
  assert.equal(agents.runsOf(agent.id).length, 0);

  await say(agent.id, "Look at this");
  assert.equal(sent[0]!.sessionId, "chat1");
  agents.update(agent.id, { target: { mode: "new-session-per-run" } });
  assert.deepEqual(await followUp(agent.id), { reason: "unavailable" }, "a person's chat is not the agent's conversation");
  await say(agent.id, "And now?");
  assert.notEqual(sent[1]!.sessionId, "chat1");
  assert.equal(agents.runsOf(agent.id)[0]!.fresh, "unavailable");
});

test("a fresh agent never compacts on its own; a compacted exchange gets the charter again", async (t) => {
  const { agents, sent, states, say, followUp } = await host(t);
  // Rolling-only settings left over from an earlier mode.
  const agent = fresh(agents, { whenFull: "compact", rotateAt: 0.9 });
  await say(agent.id, "First");
  states.set("ses1", { fraction: 0.7 });
  assert.deepEqual(await followUp(agent.id), { reason: "context-full" });
  await say(agent.id, "Second");
  assert.equal(sent[1]!.sessionId, "ses2", "a full session means a new conversation, not a compaction");
  assert.equal(agents.runsOf(agent.id)[0]!.fresh, "context-full");
  states.set("ses2", { fraction: 0.2, compactedAt: 5 });
  await say(agent.id, "Third");
  assert.equal(sent[2]!.sessionId, "ses2");
  assert.match(sent[2]!.text, /^You review merged pull requests/, "the charter again after a compaction");
  assert.equal(agents.runsOf(agent.id)[0]!.continued, true);
});

test("files reach the session with the message; bad ones are refused before anything runs", async (t) => {
  const { agents, sent, call, say } = await host(t);
  const agent = fresh(agents);
  const bad = await call(`/api/schedule/${agent.id}/run`, "POST", { input: "look", attachments: [inbox("x.png", { path: "src/x.png" })] });
  assert.equal(bad.status, 400);
  assert.equal(bad.payload.error, "invalid-input");
  assert.equal((await call(`/api/schedule/${agent.id}/run`, "POST", { input: "look", continuation: "later" })).status, 400);
  assert.equal(sent.length, 0);
  assert.equal(agents.runsOf(agent.id).length, 0);

  const ok = await say(agent.id, undefined, { attachments: [inbox("shot.png"), inbox("log.txt", { mime: "text/plain", kind: "file" })] });
  assert.equal(ok.status, 200);
  assert.ok("followUp" in ok.payload, "the owner's answer says where the next message goes");
  assert.deepEqual(sent[0]!.attachments, [
    { id: "att-shot.png", name: "shot.png", mime: "image/png", size: 10, kind: "image", path: "_inbox/shot.png" },
    { id: "att-log.txt", name: "log.txt", mime: "text/plain", size: 10, kind: "file", path: "_inbox/log.txt" },
  ]);
  const [run] = agents.runsOf(agent.id);
  assert.equal(run!.input, undefined, "a message may be files alone");
  assert.equal(run!.fresh, "none", "the person's first message had nothing to continue");
  assert.deepEqual(run!.attachments!.map((item) => item.name), ["shot.png", "log.txt"]);
  assert.equal(run!.steps, 1, "the run counted its tool step");
  assert.equal(run!.activity, undefined, "and dropped its live step once it finished");
});

test("only the owner sees where their next message goes and what waits", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-agent-continuation-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = { id: "prj_a", path: "/a", name: "A", createdAt: 1, spaceId: "spc_a" };
  const held = heldRunner();
  const schedule = createScheduleService({ file: join(root, "schedule.json"), runner: held.runner });
  const bob = schedule.create({
    projectId: project.id, spaceId: "spc_a", ownerUserId: "usr_bob", prompt: "bob's charter", kind: "every", everyMinutes: 60,
    manualOnly: true, target: { mode: "new-session-per-run" },
  });
  await schedule.runNow(bob.id);
  await schedule.runNow(bob.id, { input: "waiting words" });
  const routes = scheduleRoutes({
    schedule,
    forSpace: () => ({
      projects: { list: async () => [project], get: async (id: string) => id === project.id ? project : undefined },
      sessions: { snapshot: async (id: string) => ({ id, projectId: project.id, status: "idle", purpose: AGENT_SESSION_PURPOSE }) },
    }) as never,
  });
  const as = (userId: string, role: "member" | "admin"): SpaceContext =>
    ({ spaceId: "spc_a", spaceSlug: "a", userId, role, deployment: "server-trusted", storageDir: "/tmp/a" });
  const call = async (space: SpaceContext, path: string, method: string) => {
    let payload: Record<string, unknown> = {};
    await routes({
      path, method, url: new URL(`http://localhost${path}`), body: async () => ({}),
      json(_code: number, value: Record<string, unknown>) { payload = value; }, space,
    } as never);
    return payload;
  };
  const listed = async (space: SpaceContext) =>
    ((await call(space, "/api/schedule", "GET")).tasks as Array<Record<string, unknown>>).find((task) => task.id === bob.id)!;

  const own = await listed(as("usr_bob", "member"));
  assert.deepEqual(own.followUp, { sessionId: "s1", at: (own.history as ScheduleRunRecord[])[0]!.startedAt, until: (own.history as ScheduleRunRecord[])[0]!.startedAt + FOLLOW_UP_WINDOW_MS },
    "a report in progress can already be answered");
  assert.deepEqual(own.queued, [{ text: "waiting words", at: (own.queued as Array<{ at: number }>)[0]!.at }]);
  assert.equal("queuedStart" in own, false, "the server's record of the waiting run stays on the server");

  const admin = as("usr_admin", "admin");
  for (const view of [await listed(admin), await call(admin, `/api/schedule/${bob.id}/pause`, "POST")]) {
    for (const key of ["followUp", "queued", "queuedStart", "history", "notebook"]) assert.equal(key in view, false, key);
    assert.equal(view.prompt, "");
  }
  await held.finish();
  await held.finish();
});

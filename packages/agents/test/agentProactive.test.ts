// Proactive agents: the report protocol, the notebook, heartbeats, feedback
// and the person's read state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendToNotebook,
  beatsPerDay,
  composeAgentPrompt,
  computeNextBeat,
  createScheduleService,
  inActiveHours,
  minuteOfDay,
  NOTEBOOK_LIMIT,
  parseAgentReport,
  reportNotifies,
  validateHeartbeat,
  type AgentEvent,
  type AgentWake,
  type ScheduleRunner,
  type ScheduleRunSettlement,
  type ScheduleTask,
} from "../src/index.ts";
import { parseAgentFile, serializeAgentFile } from "../src/agentFile.ts";

function tempFile(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "polyth-proactive-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "schedule.json");
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Admits at once into one rolling session; each run settles with the next result. */
function rollingRunner(results: ScheduleRunSettlement[]) {
  const wakes: AgentWake[] = [];
  const prompts: string[] = [];
  let release: (() => void) | null = null;
  const runner: ScheduleRunner = {
    async run(task, _runId, wake) {
      wakes.push(wake);
      const continuing = wakes.length > 1;
      const notebookRev = task.notebookRev ?? 0;
      const notebookChanged = continuing && notebookRev > 0 && task.notebookSentRev !== notebookRev;
      prompts.push(composeAgentPrompt(task, wake, { continuing, notebookChanged }));
      return { sessionId: "s-rolling", markerSeq: 1, ...(!continuing || notebookChanged ? { notebookRev } : {}) };
    },
    async settle() {
      if (results[0] === undefined) await new Promise<void>((resolve) => { release = resolve; });
      return results.shift() ?? { status: "ok" };
    },
  };
  return { runner, wakes, prompts, finish: () => release?.() };
}

const heartbeat = { everyMinutes: 30, timeZone: "UTC", checklist: "Look at CI and open PRs." };

test("the last Report line sets the signal and headline; Remember lines become notes", () => {
  const report = parseAgentReport([
    "Checked the nightly build.",
    "",
    "```",
    "Report: alert — inside a code sample",
    "Remember: inside a code sample",
    "```",
    "Remember: the user wants PR #412 tracked until it merges",
    "- **Remember:** staging deploys on Fridays only",
    "**Report:** update — 3 commits landed, CI green",
  ].join("\n"));
  assert.equal(report.signal, "update");
  assert.equal(report.headline, "3 commits landed, CI green");
  assert.deepEqual(report.remember, ["the user wants PR #412 tracked until it merges", "staging deploys on Fridays only"]);
  assert.match(report.body, /Checked the nightly build\./);
  assert.match(report.body, /inside a code sample/, "fenced protocol text is content");
  assert.doesNotMatch(report.body, /3 commits landed/);

  assert.deepEqual(parseAgentReport("Report: quiet"), { signal: "quiet", body: "", remember: [] });
  assert.equal(parseAgentReport("All good.").signal, undefined);
});

test("the notebook keeps a person's prose and drops the oldest notes first", () => {
  const start = "# About the user\nPrefers short reports.\n- note one\n- note two";
  const first = appendToNotebook(start, ["note two", "note three"]);
  assert.deepEqual(first.added, ["note three"], "a known note is not repeated");
  assert.equal(first.notebook, `${start}\n- note three`);

  const crowded = appendToNotebook(`Keep this line.\n${"- old note\n".repeat(10).trim()}`, ["x".repeat(200)], 260);
  assert.ok(crowded.notebook.startsWith("Keep this line."));
  assert.ok(crowded.notebook.length <= 260);
  assert.ok(crowded.notebook.endsWith(`- ${"x".repeat(200)}`));
  assert.ok(NOTEBOOK_LIMIT >= 4_000);
});

test("heartbeats respect active hours, also across midnight", () => {
  const beat = validateHeartbeat({ everyMinutes: 60, activeFrom: 8 * 60, activeTo: 22 * 60, timeZone: "UTC", checklist: " CI " });
  assert.equal(beat.checklist, "CI");
  assert.equal(inActiveHours(7 * 60 + 59, beat), false);
  assert.equal(inActiveHours(8 * 60, beat), true);
  assert.equal(inActiveHours(22 * 60, beat), false);
  const night = { activeFrom: 22 * 60, activeTo: 6 * 60 };
  assert.equal(inActiveHours(23 * 60, night), true);
  assert.equal(inActiveHours(3 * 60, night), true);
  assert.equal(inActiveHours(12 * 60, night), false);
  assert.equal(beatsPerDay(beat), 14);

  const evening = Date.UTC(2026, 9, 13, 21, 30);
  const next = computeNextBeat({ heartbeat: beat, enabled: true, lastBeatAt: evening }, evening);
  assert.equal(next, Date.UTC(2026, 9, 14, 8, 0), "a beat due at 22:30 waits for the morning");
  assert.equal(computeNextBeat({ heartbeat: beat, enabled: false }, evening), null);
  assert.equal(computeNextBeat({ heartbeat: beat, enabled: true, tripped: { reason: "budget" } }, evening), null);
  assert.equal(minuteOfDay(Date.UTC(2026, 9, 13, 5, 7), "Europe/Kyiv"), 8 * 60 + 7);
  assert.throws(() => validateHeartbeat({ everyMinutes: 5, timeZone: "UTC" }), /from 10/);
  assert.throws(() => validateHeartbeat({ everyMinutes: 30, timeZone: "Mars/Base" }), /time zone/);
  assert.throws(() => validateHeartbeat({ everyMinutes: 30, timeZone: "UTC", activeFrom: 60 }), /go together/);
});

test("a heartbeat needs the agent's rolling conversation", (t) => {
  const svc = createScheduleService({ file: tempFile(t), runner: rollingRunner([]).runner, now: () => 0 });
  assert.throws(() => svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, heartbeat }), /rolling/);
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, heartbeat, target: { mode: "dedicated-session" } });
  assert.equal(agent.nextBeatAt, 30 * 60_000);
  assert.throws(() => svc.update(agent.id, { target: { mode: "new-session-per-run" } }), /rolling/);
  assert.equal(svc.update(agent.id, { heartbeat: null }).nextBeatAt, undefined);
});

test("beats fire inside the rolling session, skip silently while the agent works and never move the schedule", async (t) => {
  const { runner, wakes, prompts, finish } = rollingRunner([]);
  let now = 0;
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => now });
  const agent = svc.create({
    projectId: "p", prompt: "You watch CI.", cadence: { kind: "cron", expression: "0 9 * * *", timeZone: "UTC" },
    heartbeat, target: { mode: "dedicated-session" }, title: "Watcher",
  });
  const scheduled = agent.nextRunAt;

  now = 30 * 60_000;
  assert.equal(await svc.tick(), 1);
  assert.equal(wakes[0]!.trigger, "heartbeat");
  assert.match(prompts[0]!, /Heartbeat checklist:\nLook at CI and open PRs\./);
  assert.match(prompts[0]!, /Report: quiet\|update\|alert/);
  assert.equal(svc.get(agent.id)!.nextRunAt, scheduled, "a beat leaves the schedule alone");
  assert.equal(svc.get(agent.id)!.runs, 0);

  now = 60 * 60_000; // the first beat is still working
  assert.equal(await svc.tick(), 0);
  assert.equal(wakes.length, 1);
  assert.equal(svc.runsOf(agent.id).filter((run) => run.status === "skipped").length, 0, "no journal noise");
  assert.equal(svc.get(agent.id)!.nextBeatAt, 90 * 60_000);
  finish();
  await flush();
  await flush();
});

test("a quiet run is filed without a headline, wakes nobody and notifies nobody", async (t) => {
  const notified: string[] = [];
  const events: AgentEvent[] = [];
  const { runner } = rollingRunner([
    { status: "ok", summary: "Nothing new.\nReport: quiet" },
    { status: "ok", summary: "PR #412 broke the build.\nRemember: the user owns PR #412\nReport: alert — Build broken by PR #412" },
  ]);
  let now = 1_000;
  const svc = createScheduleService({
    file: tempFile(t), runner, now: () => now,
    notify: (task, run, reason) => notified.push(`${task.title}:${reason}:${run.headline ?? ""}`),
  });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true, title: "Watcher", target: { mode: "dedicated-session" } });
  const listener = svc.create({
    projectId: "p", prompt: "y", kind: "every", everyMinutes: 60, manualOnly: true,
    eventTriggers: [{ id: "after", kind: "agent", agentId: agent.id, on: ["ok"] }],
  });
  const original = svc.dispatchEvent.bind(svc);
  svc.dispatchEvent = (event) => { events.push(event); original(event); };

  await svc.runNow(agent.id);
  await flush(); await flush();
  const [quiet] = svc.runsOf(agent.id);
  assert.equal(quiet!.signal, "quiet");
  assert.equal(quiet!.headline, undefined);
  assert.equal(quiet!.summary, "Nothing new.");
  assert.deepEqual(notified, []);
  assert.equal(svc.get(listener.id)!.paceState?.after?.pending.length ?? 0, 0, "a quiet run wakes no other agent");

  now = 2_000;
  await svc.runNow(agent.id);
  await flush(); await flush();
  const [alert] = svc.runsOf(agent.id);
  assert.equal(alert!.signal, "alert");
  assert.equal(alert!.headline, "Build broken by PR #412");
  assert.deepEqual(alert!.remembered, ["the user owns PR #412"]);
  assert.equal(svc.get(agent.id)!.notebook, "- the user owns PR #412");
  assert.deepEqual(notified, ["Watcher:report:Build broken by PR #412"]);
  assert.equal(svc.get(listener.id)!.paceState?.after?.pending.length, 1);
});

test("notify policy: alerts by default, every update on request, never when off", () => {
  assert.equal(reportNotifies(undefined, { status: "ok", signal: "alert" }), true);
  assert.equal(reportNotifies(undefined, { status: "ok", signal: "update" }), false);
  assert.equal(reportNotifies("updates", { status: "ok", signal: "update" }), true);
  assert.equal(reportNotifies("updates", { status: "ok", signal: "quiet" }), false);
  assert.equal(reportNotifies("off", { status: "ok", signal: "alert" }), false);
  assert.equal(reportNotifies("alerts", { status: "failed" }), false);
});

test("an answer without a Report line counts as an update headed by its first line", async (t) => {
  const { runner } = rollingRunner([{ status: "ok", summary: "## Digest\n- 3 commits" }]);
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => 1 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true });
  await svc.runNow(agent.id);
  await flush(); await flush();
  const [run] = svc.runsOf(agent.id);
  assert.equal(run!.signal, "update");
  assert.equal(run!.headline, "Digest");
});

test("the notebook reaches a continuing session only after the person changed it", async (t) => {
  const { runner, prompts } = rollingRunner([
    { status: "ok", summary: "Remember: the user is on holiday until Monday\nReport: update — noted" },
    { status: "ok", summary: "Report: quiet" },
    { status: "ok", summary: "Report: quiet" },
  ]);
  let now = 1;
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => now });
  const agent = svc.create({
    projectId: "p", prompt: "You watch.", kind: "every", everyMinutes: 60, manualOnly: true,
    target: { mode: "dedicated-session" }, notebook: "Prefers Ukrainian.",
  });
  assert.equal(agent.notebookRev, 1);
  await svc.runNow(agent.id);
  await flush(); await flush();
  assert.match(prompts[0]!, /Your notebook \(durable notes[^)]*\):\nPrefers Ukrainian\./);
  assert.equal(svc.get(agent.id)!.notebookRev, 2);
  assert.equal(svc.get(agent.id)!.notebookSentRev, 2, "the session wrote the new note itself");

  now = 2;
  await svc.runNow(agent.id);
  await flush(); await flush();
  assert.doesNotMatch(prompts[1]!, /notebook/i);

  svc.update(agent.id, { notebook: "Prefers English now." });
  now = 3;
  await svc.runNow(agent.id);
  await flush(); await flush();
  assert.match(prompts[2]!, /Your notebook changed \(the user edited it\); this is its current text:\nPrefers English now\./);
  assert.equal(svc.get(agent.id)!.notebookEditedBy, "user");
});

test("feedback reaches the next run once, and the person's read mark only moves forward", async (t) => {
  const { runner, prompts } = rollingRunner([
    { status: "ok", summary: "Report: update — 7 commits" },
    { status: "ok", summary: "Report: quiet" },
    { status: "ok", summary: "Report: quiet" },
  ]);
  let now = 10;
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => now });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true, target: { mode: "dedicated-session" } });
  await svc.runNow(agent.id);
  await flush(); await flush();
  const [first] = svc.runsOf(agent.id);
  svc.setFeedback(agent.id, first!.runId, { verdict: "down", note: "  skip docs-only commits  " });
  assert.deepEqual(svc.runsOf(agent.id)[0]!.feedback, { verdict: "down", note: "skip docs-only commits", at: 10 });

  now = 20;
  await svc.runNow(agent.id);
  await flush(); await flush();
  assert.match(prompts[1]!, /Feedback from the user on your earlier reports[^\n]*\n- [^\n]*“7 commits”: not useful — skip docs-only commits/);
  assert.equal(svc.runsOf(agent.id)[1]!.feedback!.delivered, true);
  now = 30;
  await svc.runNow(agent.id);
  await flush(); await flush();
  assert.doesNotMatch(prompts[2]!, /Feedback from the user/);

  assert.throws(() => svc.setFeedback(agent.id, "nope", { verdict: "up" }), /run not found/);
  assert.equal(svc.markSeen(agent.id, 25).seenAt, 25);
  assert.equal(svc.markSeen(agent.id, 5).seenAt, 25);
  assert.equal(svc.markSeen(agent.id, 999).seenAt, 30, "never ahead of the clock");
});

test("a heartbeat and notify policy round-trip through an agent file", () => {
  const text = serializeAgentFile({
    id: "watcher", name: "Watcher", enabled: true, context: "rolling", notify: "updates",
    heartbeat: { everyMinutes: 30, activeFrom: 480, activeTo: 1320, timeZone: "Europe/Kyiv", checklist: "CI\nPRs" },
    charter: "You watch CI.",
  });
  const parsed = parseAgentFile(text);
  assert.ok(parsed.spec, parsed.error);
  assert.deepEqual(parsed.spec!.heartbeat, { everyMinutes: 30, activeFrom: 480, activeTo: 1320, timeZone: "Europe/Kyiv", checklist: "CI\nPRs" });
  assert.equal(parsed.spec!.notify, "updates");
  assert.match(parseAgentFile(text.replace("context: rolling\n", "")).error ?? "", /needs context: rolling/);
});

test("a new session's prompt still starts with the charter", () => {
  const task: Pick<ScheduleTask, "prompt" | "cadence" | "history" | "notebook"> = {
    prompt: "You review merged pull requests.", cadence: { kind: "every", everyMinutes: 60 }, history: [], notebook: "- prefers short",
  };
  const text = composeAgentPrompt(task, { trigger: "heartbeat", at: 1 }, { continuing: false });
  assert.ok(text.startsWith("You review merged pull requests.\n\n---\nWake: heartbeat check"));
  assert.ok(text.trimEnd().endsWith("Keep notes short; they go into your notebook."));
});

test("a message sent while the agent works waits for the run instead of being dropped", async (t) => {
  const { runner, wakes, finish } = rollingRunner([]);
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => 1 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true, target: { mode: "dedicated-session" } });
  await svc.runNow(agent.id);
  await flush();
  await svc.runNow(agent.id, { input: "Also check PR #412" });
  await flush();
  assert.equal(wakes.length, 1, "the message waits for the run in progress");
  assert.equal(svc.runsOf(agent.id).filter((run) => run.status === "skipped").length, 0);
  finish();
  for (let i = 0; i < 6; i += 1) await flush();
  assert.equal(wakes.length, 2);
  assert.equal(wakes[1]!.input, "Also check PR #412");
  finish();
  for (let i = 0; i < 4; i += 1) await flush();
});

test("runs the person stops are marked and never trip the agent as failures", async (t) => {
  const results: ScheduleRunSettlement[] = [];
  const { runner, finish } = rollingRunner(results);
  const svc = createScheduleService({ file: tempFile(t), runner, now: () => 1 });
  const agent = svc.create({ projectId: "p", prompt: "x", kind: "every", everyMinutes: 60, manualOnly: true, pauseAfterFailures: 1, target: { mode: "dedicated-session" } });
  assert.deepEqual(svc.requestStop(agent.id), [], "nothing runs yet");
  await svc.runNow(agent.id);
  await flush();
  assert.deepEqual(svc.requestStop(agent.id), ["s-rolling"], "the caller aborts this session");
  results.push({ status: "failed", error: "Stopped before it finished." });
  finish();
  for (let i = 0; i < 4; i += 1) await flush();
  const [run] = svc.runsOf(agent.id);
  assert.equal(run!.status, "failed");
  assert.equal(run!.stopped, true);
  assert.equal(svc.get(agent.id)!.tripped, undefined, "one failure would trip it, but a stop is not a failure");
  const { failureStreakReached } = await import("../src/agentPrompt.ts");
  assert.equal(failureStreakReached([{ ...run!, runId: "x" }, { runId: "y", startedAt: 0, status: "failed" }], 1), true,
    "a real failure after it still counts");
});

// What an agent's page says when a run did not finish, and what it lists as
// waiting for the person. The page draws these functions' answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScheduleRunDto, ScheduleTaskDto } from "@polyth/session/web-api";
import { agentAttention, failureDetail, failureTitle, plainError, runCause } from "../widgets/agentFailure.ts";

const NOW = Date.UTC(2026, 10, 19, 8);
const run = (over: Partial<ScheduleRunDto>): ScheduleRunDto =>
  ({ runId: "r", startedAt: NOW - 3_600_000, finishedAt: NOW - 3_000_000, status: "failed", sessionId: "s", ...over });
const agent = (over: Partial<ScheduleTaskDto>): ScheduleTaskDto => ({
  id: "a", projectId: "p", prompt: "x", kind: "cron", enabled: true, createdAt: 0, updatedAt: 0, nextRunAt: NOW + 1, runs: 3, history: [],
  ...over,
} as ScheduleTaskDto);

test("a failed run's headline says what happened, never just that it failed", () => {
  assert.equal(failureTitle(run({ cause: "cut" })), "Cut off before it finished");
  assert.equal(failureTitle(run({ cause: "cut", resumed: 2 })), "Cut off again after continuing itself 2×");
  assert.equal(failureTitle(run({ cause: "route", error: "x" })), "The model refused the request");
  assert.equal(failureTitle(run({ cause: "approval" })), "Stopped on a request nobody answered");
  assert.equal(failureTitle(run({ cause: "start", sessionId: undefined })), "Could not start");
  assert.equal(failureTitle(run({ stopped: true, cause: "person" })), "Stopped by you");
  assert.equal(failureTitle(run({ cause: "error", error: "tool exploded" })), "The run failed");
});

test("records from before causes were kept say only what their error does", () => {
  assert.equal(runCause(run({ error: "Stopped before it finished." })), "unsaid");
  assert.equal(failureTitle(run({ error: "Stopped before it finished." })), "Stopped before it finished");
  assert.equal(failureDetail(run({ error: "Stopped before it finished." })), "", "the headline said it all");
  assert.equal(runCause(run({ error: 'commandcode API error (401): {"message":"Your API key has expired."}' })), "route");
  assert.equal(runCause(run({ error: "runtime replacement is pending a durable epoch transition", sessionId: undefined })), "start");
  assert.equal(runCause(run({ error: "tool exploded" })), "error");
  assert.equal(runCause(run({ status: "ok" })), undefined);
});

test("a provider's JSON error reads as its message, then where it came from", () => {
  assert.equal(
    plainError('commandcode API error (401): {"message":"Your API key has expired. Log in again.","type":"authentication_error","code":"UNAUTHORIZED"}'),
    "Your API key has expired. Log in again. (commandcode API error 401)",
  );
  assert.equal(plainError('{"error":{"message":"Overloaded"}}'), "Overloaded");
  assert.equal(plainError("socket hang up"), "socket hang up");
  assert.equal(plainError("bad {not json}"), "bad {not json}");
  assert.equal(failureDetail(run({ cause: "cut" })), "A restart or an overlong tool call ended its turn. Nobody stopped it.");
});

test("the page lists what waits for the person: why the agent stopped, what blocked its newest run, what it asked", () => {
  const cut = run({ runId: "r2", cause: "cut", resumed: 2 });
  const stopped = agentAttention(agent({
    pauseAfterFailures: 2,
    tripped: { reason: "failures", message: "Stopped after 2 failed runs in a row.", at: NOW },
    history: [cut, run({ runId: "r1", cause: "cut" })],
  }), NOW);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0]!.kind, "stopped");
  assert.equal(stopped[0]!.kind === "stopped" && stopped[0]!.last?.runId, "r2");
  assert.equal(stopped[0]!.kind === "stopped" && stopped[0]!.count, 2);

  // The newest run alone speaks for the route: a later finished run cleared it.
  const refused = run({ runId: "r3", cause: "route", error: 'x (401): {"message":"Your API key has expired."}' });
  const blocked = agentAttention(agent({ history: [refused] }), NOW);
  assert.deepEqual(blocked.map((item) => item.kind), ["route"]);
  assert.equal(blocked[0]!.kind === "route" && blocked[0]!.detail, "Your API key has expired. (x 401)");
  assert.deepEqual(agentAttention(agent({ history: [run({ runId: "r4", status: "ok" }), refused] }), NOW), []);
  assert.deepEqual(agentAttention(agent({ history: [run({ runId: "r5", status: "running", finishedAt: undefined }), refused] }), NOW), [],
    "a run in progress is the agent trying again");
  assert.deepEqual(agentAttention(agent({ history: [run({ runId: "r6", cause: "approval" })] }), NOW).map((item) => item.kind), ["approval"]);

  // A run that was merely cut asks nothing of the person: it continues itself.
  assert.deepEqual(agentAttention(agent({ history: [cut] }), NOW), []);

  const asks = agentAttention(agent({
    history: [
      run({ runId: "r8", status: "ok", needs: [{ text: "Nightly #86 feed step fails", url: "https://example.test/run/1" }] }),
      run({ runId: "r7", status: "ok", startedAt: NOW - 90_000_000, finishedAt: NOW - 86_400_000, needs: [
        { text: "Electron 45 desktop smoke test" }, { text: "Rotate the deploy key", done: { at: NOW, by: "user" } },
      ] }),
    ],
  }), NOW);
  assert.deepEqual(asks.map((item) => item.kind === "need" && item.need.text), ["Nightly #86 feed step fails", "Electron 45 desktop smoke test"]);
  assert.equal(asks[1]!.kind === "need" && asks[1]!.need.since, NOW - 86_400_000);
});

// Pure studio decisions: what the agent is doing, what the person should do
// next, how requests are phrased, and how a chat-less start is adopted.
import test from "node:test";
import assert from "node:assert/strict";
import { applyStudioPatch, createStudioState, type StudioState } from "../src/index.ts";
import {
  agentNotes,
  agentState,
  clockTime,
  CONTINUE_REQUEST,
  fixRequest,
  isDelivered,
  nextMoment,
  sceneAt,
  sortedScenes,
  stageProgress,
  studioRequest,
  viewForStage,
} from "../widgets/studioModel.ts";
import { adoptable, pendingStarts, PENDING_START_TTL_MS } from "../widgets/start.ts";
import { defaultSpec } from "../src/brief.ts";

const ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function studio(): StudioState {
  let state = createStudioState(ID, { idea: "A neon city dances to the beat", durationSec: 12, effort: "balanced", audioPath: "song.mp3" }, 1000);
  state = applyStudioPatch(state, {
    scenes: [
      { id: "drop", title: "Drop", start: 4, end: 12, renderer: "svg", description: "Towers jump with the chorus beat" },
      { id: "intro", title: "Skyline", start: 0, end: 4, renderer: "svg", description: "Vector skyline wakes up on the downbeat" },
    ],
    styleGuide: { palette: ["#0b0b14", "#f4f1ea", "#7c6cff"] },
  }, { now: 2000 });
  return state;
}

test("agent state reads the session as the person sees it", () => {
  assert.equal(agentState(undefined), "offline");
  assert.equal(agentState({ status: "archived" }), "offline");
  assert.equal(agentState({ status: "working" }), "working");
  assert.equal(agentState({ status: "epoch-pending" }), "working");
  assert.equal(agentState({ status: "waiting" }), "needs-you");
  assert.equal(agentState({ status: "idle", attention: { permissions: 1 } }), "needs-you", "a pending approval outranks idle");
  for (const status of ["idle", "finished", "failed", "unknown"]) assert.equal(agentState({ status }), "idle", status);
});

test("the next step follows one priority: you, approval, render, delivery, issues, failure, pause", () => {
  const state = studio();
  assert.equal(nextMoment(state, "working"), null, "a working agent needs no prompt");
  assert.equal(nextMoment(state, "idle")?.kind, "paused");
  assert.equal(nextMoment(state, "needs-you")?.kind, "needs-you");

  const awaiting = applyStudioPatch(state, { stages: { concept: { status: "awaiting-approval" } } });
  const approve = nextMoment(awaiting, "idle");
  assert.equal(approve?.kind, "approve");
  assert.deepEqual(approve?.values, { count: 2, length: "0:12" });
  assert.equal(nextMoment(awaiting, "needs-you")?.kind, "needs-you", "a pending question still comes first");
  const autonomous = { ...awaiting, autonomy: "autonomous" as const };
  assert.notEqual(nextMoment(autonomous, "idle")?.kind, "approve", "autonomous studios never wait for approval");

  const rendering = { ...state, renders: [{ id: "r", kind: "preview" as const, status: "running" as const, progress: 0.42, framesDone: 1, framesTotal: 2, width: 640, height: 360, fps: 15, startedAt: 1, heartbeatAt: 1 }] };
  assert.deepEqual(nextMoment(rendering, "working")?.values, { percent: 42 });

  const issues = applyStudioPatch(state, { findings: [{ id: "f", severity: "error", message: "Flat frame", source: "qa" }] });
  assert.equal(nextMoment(issues, "idle")?.kind, "issues");
  assert.equal(nextMoment(issues, "working"), null, "the agent may be fixing it already");

  const failed = { ...state, renders: [{ id: "r", kind: "final" as const, status: "failed" as const, progress: 0.1, framesDone: 1, framesTotal: 9, width: 1, height: 1, fps: 1, startedAt: 1, heartbeatAt: 1, error: "ffmpeg exited" }] };
  assert.deepEqual(nextMoment(failed, "idle"), { kind: "failed", values: { error: "ffmpeg exited" }, job: failed.renders[0] });

  const delivered = applyStudioPatch(state, { stages: { brief: { status: "skipped" }, concept: { status: "skipped" }, production: { status: "skipped" }, assembly: { status: "skipped" }, review: { status: "skipped" } } });
  delivered.stages.export = { status: "done" };
  assert.equal(isDelivered(delivered), true);
  assert.equal(nextMoment(delivered, "idle")?.kind, "delivered");
});

test("stage progress, scene lookup, clock text and views", () => {
  const state = studio();
  assert.deepEqual(sortedScenes(state).map((scene) => scene.id), ["intro", "drop"]);
  assert.deepEqual(stageProgress(state, "concept"), { done: 2, total: 2 });
  assert.deepEqual(stageProgress(state, "production"), { done: 0, total: 2 });
  assert.equal(sceneAt(sortedScenes(state), 0)?.id, "intro");
  assert.equal(sceneAt(sortedScenes(state), 3.99)?.id, "intro");
  assert.equal(sceneAt(sortedScenes(state), 4)?.id, "drop");
  assert.equal(sceneAt(sortedScenes(state), 30)?.id, "drop");
  assert.equal(sceneAt([], 3), undefined);
  assert.equal(clockTime(42.7), "0:42");
  assert.equal(clockTime(125), "2:05");
  assert.equal(clockTime(-3), "0:00");
  assert.equal(viewForStage("brief"), "sound");
  assert.equal(viewForStage("concept"), "scenes");
  assert.equal(viewForStage("review"), "review");
  assert.equal(viewForStage("export"), "export");
});

test("requests typed in the studio name the scene they are about", () => {
  assert.equal(studioRequest("  warmer colours  "), "[Creative Studio] warmer colours");
  assert.equal(
    studioRequest("make the moon bigger", { id: "moon", title: "The moon", start: 12, end: 16 }),
    "[Creative Studio] Change scene \"The moon\" (moon, 0:12–0:16): make the moon bigger",
  );
  assert.equal(fixRequest("Flat frame", "drop, 0:05"), "[Creative Studio] Fix this issue: Flat frame (drop, 0:05)");
  assert.match(CONTINUE_REQUEST, /^\[Creative Studio\] Continue/);
});

test("agent notes are the assistant's finished replies, newest first", () => {
  const events = [
    { id: "u1", seq: 1, type: "user/message", time: 1, data: { text: "[Creative Studio] New media" } },
    { id: "a1", seq: 2, type: "assistant/message", time: 2, data: { partId: "p1", text: "Storyboard drafted." } },
    { id: "a2", seq: 3, type: "assistant/message", time: 3, data: { partId: "p2", text: "Six scenes built." } },
  ] as never[];
  assert.deepEqual(agentNotes(events).map((note) => note.text), ["Six scenes built.", "Storyboard drafted."]);
  assert.deepEqual(agentNotes(events, 1).map((note) => note.seq), [3]);
  assert.deepEqual(agentNotes([]), []);
});

test("a chat-less start adopts only a fresh studio-lane chat without a studio", () => {
  const start = { projectId: "p1", at: 10_000, spec: defaultSpec(), song: null, lyricsFile: null, lyricsText: "", phase: "submitted" as const };
  assert.equal(adoptable(start, { createdAt: 10_500, purpose: "creative-studio" }, false, 11_000), true);
  assert.equal(adoptable(start, { createdAt: 10_500, purpose: "creative-studio" }, true, 11_000), false, "never over an existing studio");
  assert.equal(adoptable(start, { createdAt: 10_500 }, false, 11_000), false, "an ordinary chat is not the studio's");
  assert.equal(adoptable(start, { createdAt: 5_000, purpose: "creative-studio" }, false, 11_000), false, "a chat older than the start");
  assert.equal(adoptable(start, { createdAt: 10_500, purpose: "creative-studio" }, false, 10_000 + PENDING_START_TTL_MS + 1), false, "expired");
  assert.equal(adoptable(null, { createdAt: 10_500, purpose: "creative-studio" }, false, 11_000), false);

  let calls = 0;
  const off = pendingStarts.subscribe(() => { calls += 1; });
  pendingStarts.set({ ...start, at: Date.now() });
  assert.equal(pendingStarts.get("p1")?.phase, "submitted");
  assert.equal(pendingStarts.get("p2"), null, "a start belongs to one project");
  pendingStarts.update({ phase: "manual" });
  assert.equal(pendingStarts.get("p1")?.phase, "manual");
  pendingStarts.clear();
  assert.equal(pendingStarts.get("p1"), null);
  off();
  assert.equal(calls, 3);
});

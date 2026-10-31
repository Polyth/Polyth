// Pure presentation rules shared by every surface: what a tile shows and
// which actions a toolbar bar offers.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { ActionRunDto, CustomActionDto } from "../src/actionModel.ts";

register("./tsxHooks.mjs", import.meta.url);
const { tileView, DONE_MS, FAILURE_MS } = await import("../widgets/tileState.ts");
const { availabilityKey, barActions, barConfig } = await import("../widgets/ActionWidgets.tsx");

const run = (patch: Partial<ActionRunDto>): ActionRunDto => ({
  id: "r1", actionId: "a1", projectId: "p1", sessionId: null, name: "Tests", icon: "flask", color: "green",
  mode: "background", status: "running", phase: "command", exitCode: null, startedAt: 1_000, finishedAt: null,
  chatSessionId: null, chatSkipped: false, error: null, outputEnd: 0, truncated: false, ...patch,
});
const snapshot = (runs: ActionRunDto[], extra: { launches?: Record<string, { state: "starting" | "opened" | "failed"; at: number }>; seen?: string[] } = {}) => ({
  runs, launches: extra.launches ?? {}, seen: new Set(extra.seen ?? []),
});

test("a tile follows its newest run in the chosen project", () => {
  assert.equal(tileView(snapshot([]), "a1", "p1", 5_000).state, "idle");
  assert.equal(tileView(snapshot([run({})]), "a1", null, 5_000).state, "idle", "no project, nothing to show");
  assert.equal(tileView(snapshot([run({})]), "a1", "p2", 5_000).state, "idle", "another project's run is not this tile's");
  assert.equal(tileView(snapshot([run({})]), "a1", "p1", 5_000).state, "running");
  assert.equal(tileView(snapshot([run({ phase: "chat" })]), "a1", "p1", 5_000).state, "chat");
  const done = run({ status: "succeeded", phase: "done", exitCode: 0, finishedAt: 4_000 });
  assert.equal(tileView(snapshot([done]), "a1", "p1", 4_000 + DONE_MS - 1).state, "done");
  assert.equal(tileView(snapshot([done]), "a1", "p1", 4_000 + DONE_MS + 1).state, "idle", "a success check fades");
  const failed = run({ status: "failed", phase: "done", exitCode: 1, finishedAt: 4_000 });
  assert.equal(tileView(snapshot([failed]), "a1", "p1", 9_000).state, "failed");
  assert.equal(tileView(snapshot([failed], { seen: ["r1"] }), "a1", "p1", 9_000).state, "idle", "a looked-at failure stops shouting");
  assert.equal(tileView(snapshot([failed]), "a1", "p1", 4_000 + FAILURE_MS + 1).state, "idle", "an old failure fades too");
  assert.equal(tileView(snapshot([run({ status: "stopped", phase: "done", finishedAt: 4_000 })]), "a1", "p1", 4_500).state, "idle");
});

test("client launches show until a newer run takes over", () => {
  assert.equal(tileView(snapshot([], { launches: { "a1@p1": { state: "starting", at: 1 } } }), "a1", "p1", 2).state, "starting");
  assert.equal(tileView(snapshot([], { launches: { "a1@p1": { state: "opened", at: 1_000 } } }), "a1", "p1", 2_000).state, "opened");
  assert.equal(tileView(snapshot([], { launches: { "a1@p1": { state: "opened", at: 1_000 } } }), "a1", "p1", 1_000 + DONE_MS + 1).state, "idle");
  assert.equal(tileView(snapshot([], { launches: { "a1@p1": { state: "failed", at: 1_000 } } }), "a1", "p1", 3_000).state, "failed");
  const newer = run({ startedAt: 5_000 });
  assert.equal(tileView(snapshot([newer], { launches: { "a1@p1": { state: "failed", at: 1_000 } } }), "a1", "p1", 6_000).state, "running");
});

const action = (id: string, projectId: string | null): CustomActionDto => ({
  id, name: id, icon: "zap", color: "accent", command: "ls", mode: "background", projectId, createdAt: 1, updatedAt: 1,
});

test("a bar shows the project's actions, or the chosen ones in the chosen order", () => {
  const actions = [action("g1", null), action("a1", "p1"), action("b1", "p2"), action("g2", null)];
  assert.deepEqual(barActions(actions, "p1", barConfig({})).map((item) => item.id), ["g1", "a1", "g2"]);
  assert.deepEqual(barActions(actions, "p1", barConfig({ actionIds: ["g2", "b1", "a1"] })).map((item) => item.id), ["g2", "a1"], "a chosen action from another project stays hidden");
  assert.deepEqual(barActions(actions, null, barConfig({})), []);
  assert.deepEqual(barConfig({ max: 99, labels: true, actionIds: [] }), { actionIds: null, max: 12, labels: true });
  assert.deepEqual(barConfig({ max: 0.5 }), { actionIds: null, max: 4, labels: false });
});

test("widget availability changes only when the library's shape does", () => {
  assert.equal(availabilityKey({ status: "loading", actions: [] }), "pending");
  assert.equal(availabilityKey({ status: "ready", actions: [] }), "none");
  const key = availabilityKey({ status: "ready", actions: [action("a1", "p1")] });
  assert.equal(availabilityKey({ status: "ready", actions: [{ ...action("a1", "p1"), name: "Renamed" }] }), key, "a rename does not re-register widgets");
  assert.notEqual(availabilityKey({ status: "ready", actions: [action("a1", null)] }), key, "a scope change does");
});

test("result cards left no bespoke toast styles behind (the host notification stack draws them)", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../widgets/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.ca-results?\s*[{[]|ca-result-life|ca-result-in/);
});

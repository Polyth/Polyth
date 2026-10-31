import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyStudioPatch,
  createStudioState,
  currentStage,
  effectiveDuration,
  estimateCost,
  frameSize,
  isCssColor,
  normalizeStudioId,
  parseStudioState,
  renderIsCurrent,
  sameStudioModel,
  stageCriteria,
  STUDIO_WORK_ROLES,
  studioModelLabel,
  studioPaths,
  studioTurnContext,
  timelineProblems,
  type StudioScene,
} from "../src/index.ts";

const ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const base = () => createStudioState(ID, { idea: "A neon city dances to the beat of the song", durationSec: 12, effort: "balanced" }, 1000);
const scene = (id: string, start: number, end: number): Partial<StudioScene> & { id: string } =>
  ({ id, title: id, start, end, renderer: "canvas2d", description: `Scene ${id} with enough words` });

test("ids and paths cannot escape the studio folder", () => {
  assert.equal(normalizeStudioId(ID.toUpperCase()), ID);
  for (const bad of ["../x", "", "6f1c2b3a", `${ID}/..`]) assert.throws(() => normalizeStudioId(bad), /canonical id/);
  const paths = studioPaths(ID);
  assert.equal(paths.state, `.polyth/creative-studio/${ID}/studio.json`);
  assert.throws(() => paths.scene("../evil"), /invalid scene id/);
  assert.equal(paths.scene("intro-1"), `.polyth/creative-studio/${ID}/scenes/intro-1.js`);
});

test("patches upsert scenes, keep them ordered and validate inputs", () => {
  let state = applyStudioPatch(base(), {
    scenes: [scene("b", 6, 12), scene("a", 0, 6)],
    styleGuide: { palette: ["#000", "red", "url(javascript:1)", "hsl(10, 50%, 50%)"] },
    activity: [{ role: "planner", message: "Planned two scenes" }],
  }, { now: 2000, sessionId: ID });
  assert.deepEqual(state.scenes.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(state.styleGuide!.palette, ["#000", "red", "hsl(10, 50%, 50%)"], "unsafe colour dropped");
  assert.equal(state.activity.at(-1)!.role, "planner");
  assert.equal(state.activity.at(-1)!.sessionId, ID);
  state = applyStudioPatch(state, { scenes: [{ id: "a", remove: true }] });
  assert.deepEqual(state.scenes.map((item) => item.id), ["b"]);
  assert.throws(() => applyStudioPatch(state, { scenes: [{ id: "Bad Id" }] }), /invalid scene id/);
  assert.throws(() => applyStudioPatch(state, { format: { durationSec: Number.NaN } }), /expected a number/);
  // Server-maintained fields cannot be forged through a patch.
  const forged = applyStudioPatch(state, { scenes: [{ id: "b", revision: 99, hasCode: true } as never] });
  assert.equal(forged.scenes[0]!.revision, 0);
  assert.equal(forged.scenes[0]!.hasCode, undefined);
});

test("timeline problems find gaps, overlaps and a short tail", () => {
  assert.deepEqual(timelineProblems([scene("a", 0, 6), scene("b", 6, 12)] as StudioScene[], 12), []);
  const problems = timelineProblems([scene("a", 0, 5), scene("b", 6, 11), scene("c", 10.5, 11)] as StudioScene[], 12);
  assert.ok(problems.some((problem) => problem.startsWith("gap 0:05")));
  assert.ok(problems.some((problem) => /c: overlaps/.test(problem)));
  assert.ok(problems.some((problem) => problem.startsWith("gap 0:11")));
});

test("a stage closes only when its criteria hold", () => {
  let state = applyStudioPatch(base(), { scenes: [scene("a", 0, 6), scene("b", 6, 12)], styleGuide: { palette: ["#000", "#fff", "#f0f"] } });
  assert.throws(() => applyStudioPatch(state, { stages: { concept: { status: "done" } } }), /not ready: approved/);
  state = applyStudioPatch(state, { approve: "concept" }, { now: 3000 });
  state = applyStudioPatch(state, { stages: { concept: { status: "done" } } }, { now: 3100 });
  assert.equal(state.stages.concept.status, "done");
  assert.equal(state.stages.concept.finishedAt, 3100);
  // brief needs an analyzed song
  assert.throws(() => applyStudioPatch(state, { stages: { brief: { status: "done" } } }), /audio/);
  assert.equal(currentStage(state), "brief");
  state = applyStudioPatch(state, { stages: { brief: { status: "skipped" } } });
  assert.equal(currentStage(state), "production");
  // sketch effort needs no approval
  const sketch = applyStudioPatch(createStudioState(ID, { idea: "quick idea for a video", effort: "sketch", durationSec: 6 }), {
    scenes: [scene("a", 0, 6)], styleGuide: { palette: ["#000", "#fff", "#f0f"] },
  });
  assert.ok(!stageCriteria(sketch, "concept").some((criterion) => criterion.id === "approved"));
});

test("renders are current only for the scene revisions they were made from", () => {
  const state = applyStudioPatch(base(), { scenes: [scene("a", 0, 12)] });
  const job = { id: "r1", kind: "preview" as const, status: "done" as const, progress: 1, framesDone: 1, framesTotal: 1, width: 2, height: 2, fps: 1, startedAt: 0, heartbeatAt: 0, sceneRevisions: { a: 0 } };
  assert.equal(renderIsCurrent(state, job), true);
  state.scenes[0]!.revision = 1;
  assert.equal(renderIsCurrent(state, job), false);
  assert.equal(renderIsCurrent(state, { ...job, status: "failed" }), false);
});

test("duration follows a shorter song; frame sizes stay even", () => {
  const state = base();
  assert.equal(effectiveDuration(state), 12);
  state.audio = { path: "song.mp3", durationSec: 9.5 };
  assert.equal(effectiveDuration(state), 9.5);
  assert.deepEqual(frameSize("16:9", 1080), { width: 1920, height: 1080 });
  assert.deepEqual(frameSize("9:16", 1080), { width: 1080, height: 1920 });
  assert.deepEqual(frameSize("16:9", 361), { width: 642, height: 362 });
});

test("cost estimate grows with effort and length", () => {
  const sketch = estimateCost({ effort: "sketch", durationSec: 60 });
  const balanced = estimateCost({ effort: "balanced", durationSec: 60 });
  const max = estimateCost({ effort: "max", durationSec: 180 });
  assert.ok(sketch.tokens[1] < balanced.tokens[0] * 2);
  assert.ok(balanced.tokens[0] < max.tokens[0]);
  assert.ok(balanced.tokens[0] < balanced.tokens[1]);
  assert.equal(balanced.scenes, 8);
  assert.equal(balanced.parallelBuilders, 3);
  assert.ok(max.minutes[1] > balanced.minutes[1]);
});

test("parsing tolerates old or hand-edited files", () => {
  const parsed = parseStudioState(JSON.stringify({ id: ID, brief: { idea: "x" }, stages: { brief: { status: "nonsense" } }, scenes: [{ id: "ok" }, { id: "../bad" }], effort: "ultra" }));
  assert.equal(parsed.effort, "balanced");
  assert.equal(parsed.stages.brief.status, "active");
  assert.deepEqual(parsed.scenes.map((item) => item.id), ["ok"]);
  assert.deepEqual(parsed.renders, []);
  assert.throws(() => parseStudioState("{\"id\":\"nope\"}"), /canonical id/);
});

test("colours accept only inert forms", () => {
  for (const ok of ["#abc", "#aabbccdd", "rebeccapurple", "rgb(1, 2, 3)", "oklch(0.7 0.1 200)"]) assert.ok(isCssColor(ok), ok);
  for (const bad of ["url(x)", "red;background:url(x)", "expression(alert(1))", "#12"]) assert.ok(!isCssColor(bad), bad);
});

test("turn context carries the studio contract", () => {
  const context = studioTurnContext({ id: ID });
  assert.match(context, new RegExp(`studioId: ${ID}`));
  assert.ok(context.length < 900, `turn context stays small (${context.length})`);
});

test("model routes validate, merge and survive a round trip", () => {
  const flash = { harnessId: "opencode", providerID: "anthropic", modelID: "claude-haiku-4-5" };
  const opus = { harnessId: "claude", providerID: "anthropic", modelID: "opus", variant: "high" };
  let state = applyStudioPatch(base(), {
    models: { default: opus, roles: { code: { ...opus, variant: "max" }, descriptions: flash } },
  }, { now: 2000 });
  assert.deepEqual(state.models?.default, opus);
  assert.deepEqual(state.models?.roles?.code, { ...opus, variant: "max" });
  assert.deepEqual(state.models?.roles?.descriptions, flash);

  // A later patch replaces the session route and clears one part with null.
  state = applyStudioPatch(state, { models: { default: flash, roles: { descriptions: null } } }, { now: 3000 });
  assert.deepEqual(state.models?.default, flash);
  assert.equal(state.models?.roles?.descriptions, undefined);
  assert.deepEqual(state.models?.roles?.code, { ...opus, variant: "max" }, "untouched parts survive");

  // Clearing the session route with nothing left drops the whole object.
  state = applyStudioPatch(state, { models: { default: null, roles: { code: null } } }, { now: 4000 });
  assert.equal(state.models, undefined);

  // Junk is rejected instead of being rewritten into a lookalike route.
  state = applyStudioPatch(base(), { models: { default: { harnessId: "Bad Id!", providerID: "p", modelID: "m" } } }, { now: 5000 });
  assert.equal(state.models, undefined);
  state = applyStudioPatch(base(), { models: { roles: { plan: { harnessId: "codex", providerID: "", modelID: "m" } } } }, { now: 5000 });
  assert.equal(state.models, undefined);
});

test("model routes persist through createStudioState and parseStudioState", () => {
  const route = { harnessId: "codex", providerID: "openai", modelID: "gpt-5", variant: "low" };
  const created = createStudioState(ID, { idea: "A city of paper lanterns follows the bass line", models: { default: route, roles: { review: route } } }, 1000);
  const parsed = parseStudioState(JSON.stringify(created));
  assert.deepEqual(parsed.models?.default, route);
  assert.deepEqual(parsed.models?.roles?.review, route);
  // An older file without models stays valid and simply has none.
  assert.equal(parseStudioState(JSON.stringify({ id: ID, brief: { idea: "x" } })).models, undefined);
});

test("model labels and work roles are stable", () => {
  assert.equal(STUDIO_WORK_ROLES.length, 5);
  assert.deepEqual([...STUDIO_WORK_ROLES], ["plan", "descriptions", "code", "review", "report"]);
  assert.equal(studioModelLabel({ harnessId: "claude", providerID: "anthropic", modelID: "opus", variant: "high" }), "claude anthropic/opus (high)");
  assert.equal(studioModelLabel({ harnessId: "codex", providerID: "openai", modelID: "gpt-5" }), "codex openai/gpt-5");
  assert.equal(sameStudioModel({ harnessId: "a", providerID: "p", modelID: "m", variant: "x" }, { harnessId: "a", providerID: "p", modelID: "m" }), true);
  assert.equal(sameStudioModel(undefined, undefined), true);
  assert.equal(sameStudioModel(undefined, { harnessId: "a", providerID: "p", modelID: "m" }), false);
});

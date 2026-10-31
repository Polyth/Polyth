import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPreset, buildBrief, defaultSpec, modelRoutingLines, specProblems, specToInit, type MediaSpec } from "../src/brief.ts";
import { createStudioState, effectiveDuration, finalSpec, needsConceptApproval, normalizeDelivery, stageCriteria } from "../src/index.ts";
import { canStart, readLevel, reachableSteps, stepBlocker, stepsFor, writeLevel } from "../widgets/wizardModel.ts";

const ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function danceSpec(): MediaSpec {
  return {
    ...applyPreset(defaultSpec(), "dance"),
    idea: "Neon silhouettes learn one move per bar and finish in a perfectly synced finale.",
    audioPath: "song/song.mp3",
    songNotesPath: "song/README.md",
    toolsNotesPath: "tools/README.md",
    autonomy: "autonomous",
  };
}

test("the brief reproduces a complete hand-written production request", () => {
  const brief = buildBrief(danceSpec(), { studioId: ID });
  for (const phrase of [
    "full music video like a real official music video with a lot of dance",
    "made as motion graphics only. No filmed footage. It can be 2D, 3D or both. What matters to me is that it's creative and unique.",
    "> Neon silhouettes learn one move per bar",
    "The song file is song/song.mp3.",
    "Read song/README.md first.",
    "tools/README.md lists ready-made tools and what is installed on this machine. Using them is optional.",
    "One finished video: final/music-video.mp4, 1920×1080, 30 fps, H.264 yuv420p with AAC audio, the same length as the song file.",
    "Work on your own from start to finish. Don't stop to ask me for approval; deliver the finished video.",
    "Keep all your work inside this folder.",
    "Use only free tools already installed on this machine.",
    "Don't download footage or artwork",
    "Fonts must be open-licensed (for example OFL), with the licence file kept",
    "You can't hear the audio or watch the video. Don't say you listened to or watched something you didn't",
    "Check that the file plays to the end and that the music is in sync with the song file",
    "report.md: what you made and the idea behind it, how you made it, what you checked",
  ]) assert.ok(brief.includes(phrase), `missing: ${phrase}`);
  const settings = JSON.parse(brief.split("```json")[1]!.split("```")[0]!);
  assert.deepEqual(settings, { studioId: ID, ...JSON.parse(JSON.stringify(specToInit(danceSpec()))) });
  assert.equal(settings.delivery.matchSongLength, true);
});

test("every section follows the choices", () => {
  const spec = { ...danceSpec(), autonomy: "checkpoints" as const, report: false, audioPath: undefined, songNotesPath: undefined, toolsNotesPath: undefined };
  spec.rules = { ...spec.rules, openFonts: false, honestPerception: false, verifyPlayback: false };
  const brief = buildBrief({ ...spec, dimension: "2d", moods: ["dark", "surreal"], styleNotes: "ink and grain", extraInstructions: "No red." });
  assert.match(brief, /wait for my approval before building scenes/);
  assert.match(brief, /It should be 2D\./);
  assert.match(brief, /Mood: dark, surreal\./);
  assert.match(brief, /Look and feel: ink and grain/);
  assert.match(brief, /The song will be added in the Studio panel/);
  assert.match(brief, /Also:\nNo red\./);
  for (const gone of ["report.md", "OFL", "can't hear", "Before you finish", "Read song/README.md"]) assert.ok(!brief.includes(gone), `should not mention ${gone}`);

  // A studio started without a chat uploads the song right after the brief creates it.
  const uploading = buildBrief({ ...spec }, { uploading: { song: true, lyrics: true } });
  assert.match(uploading, /The Studio is uploading the song into this studio's audio folder right now/);
  assert.match(uploading, /The Studio is adding the lyrics/);
  assert.ok(!uploading.includes("The song will be added in the Studio panel"));

  const teaser = applyPreset({ ...defaultSpec(), idea: "Hook line smashes in" }, "teaser");
  const teaserBrief = buildBrief(teaser);
  assert.match(teaserBrief, /final\/teaser\.mp4, 1080×1920, 30 fps, H\.264 yuv420p with AAC audio, exactly 0:15 long/);
  assert.equal(teaser.idea, "Hook line smashes in", "presets keep what the user wrote");
  assert.ok(buildBrief({ ...teaser, lyricsOverlay: true }).includes("Show the lyrics on screen"));
});

test("spec validation and delivery paths", () => {
  assert.deepEqual(specProblems(defaultSpec()).map((problem) => problem.field), ["idea"]);
  const ok = { ...defaultSpec(), idea: "A long enough idea for a video" };
  assert.deepEqual(specProblems(ok), []);
  for (const outputPath of ["../out.mp4", "/abs/out.mp4", "out.mov", "a/../b.mp4"]) {
    assert.ok(specProblems({ ...ok, outputPath }).some((problem) => problem.field === "outputPath"), outputPath);
  }
  assert.ok(specProblems({ ...ok, durationMode: "custom", durationSec: 2 }).some((problem) => problem.field === "durationSec"));
  for (const outputPath of ["../x.mp4", "/x.mp4", ".git/x.mp4", "x.mov", "a//b.mp4"]) {
    assert.throws(() => normalizeDelivery({ outputPath }), /outputPath must be a relative/, outputPath);
  }
  assert.deepEqual(normalizeDelivery({ height: 999, fps: 25, outputPath: "./final/v.mp4", reportPath: "report.md" }), {
    height: 1080, fps: 30, matchSongLength: true, outputPath: "final/v.mp4", reportPath: "report.md",
  });
});

test("studio state honours the delivery spec and autonomy", () => {
  const state = createStudioState(ID, specToInit({ ...danceSpec(), height: 720, fps: 24 }));
  assert.deepEqual(finalSpec(state), { width: 1280, height: 720, fps: 24 });
  assert.equal(needsConceptApproval(state), false, "autonomous never waits");
  assert.equal(needsConceptApproval({ ...state, autonomy: "checkpoints" }), true);
  state.audio = { path: "song.mp3", durationSec: 201.4 };
  assert.equal(effectiveDuration(state), 201.4, "whole song even beyond the chosen preset length");
  assert.deepEqual(stageCriteria(state, "export").map((criterion) => criterion.id), ["final", "verified", "delivered", "report"]);
});

test("wizard levels: steps, blockers, reachability and persistence", () => {
  assert.deepEqual(stepsFor("quick"), ["kind"]);
  assert.deepEqual(stepsFor("guided"), ["kind", "song", "style", "format", "review"]);
  assert.deepEqual(stepsFor("expert"), ["kind", "song", "style", "format", "models", "delivery", "review"]);
  const empty = defaultSpec();
  assert.equal(stepBlocker("kind", empty), "idea");
  assert.deepEqual([...reachableSteps("guided", empty)], ["kind"]);
  const ready = { ...empty, idea: "A long enough idea for a video" };
  assert.equal(reachableSteps("expert", ready).size, 7);
  // The models step never blocks: every part is optional.
  assert.equal(stepBlocker("models", { ...ready, models: {} }), null);
  assert.equal(canStart(ready, "quick"), true);
  assert.equal(stepBlocker("delivery", { ...ready, outputPath: "x.mov" }), "path");
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  assert.equal(readLevel(storage), "guided");
  writeLevel("expert", storage);
  assert.equal(readLevel(storage), "expert");
  store.set("polyth.creative-studio.level", "bogus");
  assert.equal(readLevel(storage), "guided");
});

test("the brief routes work parts to their models and stays silent without routes", () => {
  const route = { harnessId: "opencode", providerID: "anthropic", modelID: "claude-sonnet-4-5" };
  const spec: MediaSpec = {
    ...danceSpec(),
    models: { default: route, roles: { code: { ...route, modelID: "claude-opus-4-5" }, review: { harnessId: "codex", providerID: "openai", modelID: "gpt-5" } } },
  };
  const brief = buildBrief(spec, { studioId: ID });
  assert.match(brief, /Models \(use agent\.models for the live catalog/);
  assert.match(brief, /The session itself runs on opencode anthropic\/claude-sonnet-4-5\./);
  assert.match(brief, /scene code: opencode anthropic\/claude-opus-4-5\./);
  assert.match(brief, /review and fixes: codex openai\/gpt-5\./);
  assert.doesNotMatch(brief, /scene descriptions:/);
  assert.match(brief, /do not substitute another model/);
  // The routing table is part of the init block the agent replays.
  assert.match(brief, /"models":/);
  assert.deepEqual(specToInit(spec).models, spec.models);

  // No routes: the brief is exactly the previous contract.
  const plain = buildBrief({ ...danceSpec(), models: {} }, { studioId: ID });
  assert.doesNotMatch(plain, /Models \(use agent\.models/);
  assert.equal(specToInit({ ...danceSpec(), models: {} }).models, undefined);
});

test("modelRoutingLines lists only routed parts", () => {
  const route = { harnessId: "pi", providerID: "anthropic", modelID: "sonnet" };
  assert.deepEqual(modelRoutingLines({}), []);
  assert.deepEqual(modelRoutingLines({ default: route }), [
    "- The session itself runs on pi anthropic/sonnet.",
    "- Give each delegated worker its part's route on agent.spawn; do not substitute another model.",
  ]);
  const lines = modelRoutingLines({ roles: { plan: route } });
  assert.equal(lines[0], "- plan and storyboard: pi anthropic/sonnet.");
});

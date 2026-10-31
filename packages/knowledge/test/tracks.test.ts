import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnowledgeStore, createTrackStore } from "../src/index.ts";

const passingTest = (command = "node --test focused.test.ts") => ({
  command,
  exitCode: 0,
  timedOut: false,
  truncated: false,
  output: "ok",
  completedAt: 2_000,
});

test("track creation saves feature spec and managed plan knowledge records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-tracks-"));
  let clock = 1_000;
  const knowledge = createKnowledgeStore(join(dir, "knowledge.db"), { now: () => clock++ });
  const tracks = createTrackStore({ file: join(dir, "tracks.json"), knowledge, now: () => clock++ });

  const track = await tracks.create({
    projectId: "p1",
    title: "Offline sync",
    spec: "# Problem\nUsers need offline changes.",
    steps: [
      { title: "Add storage", prompt: "Create the durable store.", testCommand: "node --test store.test.ts" },
      { title: "Wire UI", testCommand: "node --test ui.test.ts", commitMessage: "feat: wire offline UI" },
    ],
    maxContinuations: 4,
  });

  const spec = await knowledge.get(track.specKnowledgeId);
  const plan = await knowledge.get(track.planKnowledgeId);
  assert.equal(spec?.kind, "spec");
  assert.equal(spec?.body, "# Problem\nUsers need offline changes.");
  assert.ok(spec?.tags.includes(`track:${track.id}`));
  assert.equal(plan?.kind, "plan");
  assert.match(plan?.body ?? "", /- \[ \].*Add storage/);
  assert.match(plan?.body ?? "", /node --test ui\.test\.ts/);
  assert.equal(track.status, "draft");
  assert.equal(track.steps.length, 2);
  knowledge.close();
});

test("track progress is sequential, durable, and records one commit hash per completed step", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-tracks-"));
  let clock = 5_000;
  const knowledge = createKnowledgeStore(join(dir, "knowledge.db"), { now: () => clock++ });
  const file = join(dir, "tracks.json");
  const tracks = createTrackStore({ file, knowledge, now: () => clock++ });
  const created = await tracks.create({
    projectId: "p1",
    title: "Two commits",
    spec: "Acceptance criteria",
    steps: [
      { title: "First", testCommand: "node --test first.test.ts" },
      { title: "Second", testCommand: "node --test second.test.ts" },
    ],
  });

  const first = tracks.begin(created.id, "s1");
  assert.equal(first.currentStep, 0);
  assert.equal(first.steps[0]?.status, "running");
  assert.throws(() => tracks.begin(created.id, "s1"), /running step/);
  tracks.bindSchedule(created.id, 0, "task-1");
  const firstSha = "a".repeat(40);
  const afterFirst = await tracks.complete(created.id, 0, firstSha, passingTest("node --test first.test.ts"));
  assert.equal(afterFirst.status, "draft");
  assert.equal(afterFirst.currentStep, 1);
  assert.equal(afterFirst.steps[0]?.commitSha, firstSha);

  const second = tracks.begin(created.id, "s1");
  assert.equal(second.currentStep, 1);
  const secondSha = "b".repeat(40);
  const completed = await tracks.complete(created.id, 1, secondSha, passingTest("node --test second.test.ts"));
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.steps.map((step) => step.commitSha), [firstSha, secondSha]);

  const reopened = createTrackStore({ file, knowledge, now: () => clock++ });
  assert.deepEqual(reopened.get(created.id)?.steps.map((step) => step.commitSha), [firstSha, secondSha]);
  const plan = await knowledge.get(completed.planKnowledgeId);
  assert.match(plan?.body ?? "", /- \[x\].*First/);
  assert.match(plan?.body ?? "", new RegExp(firstSha));
  assert.match(plan?.body ?? "", new RegExp(secondSha));
  assert.ok((plan?.revision ?? 0) > 1);
  knowledge.close();
});

test("failed steps block until retry and invalid tracks are rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-tracks-"));
  const knowledge = createKnowledgeStore(join(dir, "knowledge.db"));
  const tracks = createTrackStore({ file: join(dir, "tracks.json"), knowledge });
  const track = await tracks.create({
    projectId: "p",
    title: "Retry",
    spec: "Spec",
    steps: [{ title: "Step", testCommand: "npm test" }],
  });
  tracks.begin(track.id, "s");
  const failed = tracks.fail(track.id, 0, "tests failed", {
    ...passingTest("npm test"),
    exitCode: 1,
  });
  assert.equal(failed.status, "blocked");
  assert.equal(failed.steps[0]?.status, "failed");
  assert.equal(tracks.begin(track.id, "s").steps[0]?.status, "running");

  await assert.rejects(
    () => tracks.create({ projectId: "p", title: "No plan", spec: "Spec", steps: [] }),
    /at least one plan step/,
  );
  await assert.rejects(
    () => tracks.create({
      projectId: "p",
      title: "No test",
      spec: "Spec",
      steps: [{ title: "Step", testCommand: "" }],
    }),
    /testCommand is required/,
  );
  knowledge.close();
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, Project, ProjectService, SessionProjection } from "@polyth/contracts";
import { createGitService } from "@polyth/git";
import { createGoalService } from "@polyth/goals";
import { createKnowledgeStore, createTrackStore } from "@polyth/knowledge";
import { createScheduleService, type ScheduleTask } from "@polyth/schedule";
import { createTerminalService } from "@polyth/terminal";
import { trackRoutes } from "../../knowledge/src/serverEntry.ts";
import { createTrackWorkflow } from "../src/tracks.ts";

const dirs: string[] = [];
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function harness(testCommand = `node -e "process.exit(0)"`) {
  const parent = mkdtempSync(join(tmpdir(), "polyth-track-flow-"));
  dirs.push(parent);
  const root = join(parent, "repo");
  const state = join(parent, "state");
  mkdirSync(root);
  mkdirSync(state);
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  runGit("init", "-q", "-b", "main");
  runGit("config", "user.email", "track@example.com");
  runGit("config", "user.name", "Track Test");
  runGit("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "baseline\n");
  runGit("add", ".");
  runGit("commit", "-qm", "baseline");

  const project: Project = { id: "p1", path: root, name: "project", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => id === project.id ? project : undefined,
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const session: SessionProjection = {
    id: "s1",
    projectId: "p1",
    title: "track",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  };
  const sessions = { snapshot: async (id: string) => {
    if (id !== session.id) throw Object.assign(new Error("not found"), { code: "not-found" });
    return session;
  } };
  const events: Array<{ type: string; data: JsonObject }> = [];
  const goalReplies = [
    '{"verdict":"done","reason":"first ready"}',
    '{"verdict":"done","reason":"second ready"}',
  ];
  const goals = createGoalService({
    append: async (_sessionId, type, data) => { events.push({ type, data }); },
    send: async () => {},
    complete: async () => goalReplies.shift() ?? '{"verdict":"done","reason":"ready"}',
  });
  const dispatched: ScheduleTask[] = [];
  const schedule = createScheduleService({
    file: join(state, "schedule.json"),
    runner: { run: async (task) => { dispatched.push(structuredClone(task)); } },
  });
  const knowledge = createKnowledgeStore(join(state, "knowledge.db"));
  const trackStore = createTrackStore({ file: join(state, "tracks.json"), knowledge });
  const git = createGitService();
  const workflow = createTrackWorkflow({
    tracks: trackStore,
    goals,
    schedule,
    git,
    terminals: createTerminalService(),
    projects,
    sessions: sessions as never,
    append: async (_sessionId, type, data) => { events.push({ type, data }); },
  });
  return {
    root,
    state,
    runGit,
    goals,
    workflow,
    trackStore,
    knowledge,
    events,
    dispatched,
    testCommand,
  };
}

test("workflow executes steps sequentially and commits each verified step atomically", async () => {
  const h = harness();
  const created = await h.workflow.create({
    projectId: "p1",
    title: "Sequential",
    spec: "Each step must be independently verified.",
    steps: [
      { title: "Add first file", testCommand: h.testCommand },
      { title: "Add second file", testCommand: h.testCommand },
    ],
  });

  const started = await h.workflow.start(created.id, "s1");
  assert.equal(started.status, "running");
  assert.equal(h.dispatched.length, 1);
  assert.equal(h.goals.get("s1")?.status, "active");
  writeFileSync(join(h.root, "first.txt"), "first\n");
  await h.goals.onTurnCompleted("s1", "first step done");
  const afterFirst = await h.workflow.completeForSession("s1");
  assert.equal(afterFirst?.status, "running", "next step starts automatically");
  assert.equal(afterFirst?.currentStep, 1);
  assert.match(afterFirst?.steps[0]?.commitSha ?? "", /^[0-9a-f]{40}$/);
  assert.equal(h.dispatched.length, 2);
  assert.equal(h.runGit("status", "--porcelain").toString(), "");

  writeFileSync(join(h.root, "second.txt"), "second\n");
  await h.goals.onTurnCompleted("s1", "second step done");
  const completed = await h.workflow.completeForSession("s1");
  assert.equal(completed?.status, "completed");
  const hashes = completed?.steps.map((step) => step.commitSha) ?? [];
  assert.equal(new Set(hashes).size, 2);
  assert.ok(hashes.every((sha) => /^[0-9a-f]{40}$/.test(sha ?? "")));
  assert.deepEqual(
    h.runGit("log", "-2", "--format=%s").toString().trim().split("\n"),
    ["track(Sequential): Add second file", "track(Sequential): Add first file"],
  );
  assert.ok(h.events.some((event) => event.type === "track/step-started"));
  assert.equal(h.events.filter((event) => event.type === "track/step-completed").length, 2);
  assert.ok(h.events.some((event) => event.type === "track/completed"));

  const reopened = createTrackStore({ file: join(h.state, "tracks.json"), knowledge: h.knowledge });
  assert.deepEqual(reopened.get(created.id)?.steps.map((step) => step.commitSha), hashes);
  h.knowledge.close();
});

test("failed declared tests block the track and create no commit", async () => {
  const h = harness(`node -e "process.exit(7)"`);
  const created = await h.workflow.create({
    projectId: "p1",
    title: "Fail closed",
    spec: "Never commit a failing step.",
    steps: [{ title: "Broken step", testCommand: h.testCommand }],
  });
  await h.workflow.start(created.id, "s1");
  writeFileSync(join(h.root, "broken.txt"), "not ready\n");
  await h.goals.onTurnCompleted("s1", "done");
  const blocked = await h.workflow.completeForSession("s1");
  assert.equal(blocked?.status, "blocked");
  assert.equal(blocked?.steps[0]?.test?.exitCode, 7);
  assert.equal(blocked?.steps[0]?.commitSha, undefined);
  assert.equal(h.runGit("log", "--format=%s").toString().trim(), "baseline");
  assert.ok(h.events.some((event) => event.type === "track/step-failed"));
  h.knowledge.close();
});

test("track RouteHandler exposes create, list, and start through the API seam", async () => {
  const h = harness();
  const route = trackRoutes(h.workflow);
  let response: unknown;
  const invoke = (path: string, method: string, body: Record<string, unknown> = {}) =>
    route({
      req: {} as never,
      res: {} as never,
      path,
      method,
      url: new URL(`http://x${path}`),
      body: async () => body,
      json: (_status, value) => { response = value; },
    });

  assert.equal(await invoke("/api/tracks", "POST", {
    projectId: "p1",
    title: "Via API",
    spec: "API acceptance",
    steps: [{ title: "Step one", testCommand: h.testCommand }],
  }), true);
  const created = response as { id: string; specKnowledgeId: string; planKnowledgeId: string };
  assert.ok(created.id && created.specKnowledgeId && created.planKnowledgeId);

  assert.equal(await route({
    req: {} as never,
    res: {} as never,
    path: "/api/tracks",
    method: "GET",
    url: new URL("http://x/api/tracks?projectId=p1"),
    body: async () => ({}),
    json: (_status, value) => { response = value; },
  }), true);
  assert.equal((response as unknown[]).length, 1);

  assert.equal(await invoke(`/api/tracks/${created.id}/start`, "POST", { sessionId: "s1" }), true);
  assert.equal((response as { status: string }).status, "running");
  assert.equal(h.dispatched.length, 1);
  h.knowledge.close();
});

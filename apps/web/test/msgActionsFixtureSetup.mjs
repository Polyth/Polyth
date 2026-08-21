// UX-MSG-ACTIONS live-gate fixture: isolated, synthetic, disposable.
// Builds a throwaway git project, an isolated Polyth data dir with seeded
// session logs covering every gate state (completed / failed / empty /
// active-turn / queued / waiting / active-revert / fork-failure /
// backend-mismatch), a matching seed for the fake model-runtime backend, and
// a bin dir whose `opencode` wrapper launches that fake. Existing fixture
// paths are wiped only when they carry the sentinel — anything else refuses.
//
// Usage: imported by messageActions.live.ts (buildMsgActionsFixture()), or
//        run directly: node apps/web/test/msgActionsFixtureSetup.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

export const FIXTURE_ROOT = "/tmp/polyth-msgact-fixture-58a2";
export const FIXTURE_DATA = "/tmp/polyth-msgact-data-58a2";
export const FIXTURE_HOME = "/tmp/polyth-msgact-home-58a2";
export const FIXTURE_BIN = "/tmp/polyth-msgact-bin-58a2";
export const OC_SEED = join(FIXTURE_DATA, "oc-seed.json");
export const OC_STATE = join(FIXTURE_DATA, "oc-state.json");
export const PROJECT_ID = "msgact-project";

export const SESSIONS = {
  copy: "msgact-copy",
  revert: "msgact-revert",
  fork: "msgact-fork",
  forkFail: "msgact-fork-fail",
  forkMismatch: "msgact-fork-mismatch",
  failed: "msgact-failed",
  empty: "msgact-empty",
  active: "msgact-active",
  waiting: "msgact-waiting",
  queued: "msgact-queued",
  revertActive: "msgact-revert-active",
};

// Deterministic synthetic conversation shared by all two-turn sessions.
export const TEXTS = {
  u1: "First synthetic prompt: outline the fixture module.",
  a1: "First synthetic answer: the fixture module exports one pure helper.",
  u2: "Second synthetic prompt: explain the helper in more depth.",
  a2: "Second synthetic answer: the helper doubles its numeric input.",
  reasoning: "Synthetic reasoning: compare the helper against the doubling contract before answering.",
};

const SENTINEL = ".ux-fixture-sentinel";

const resetDir = (path) => {
  if (existsSync(path)) {
    if (!existsSync(join(path, SENTINEL))) {
      throw new Error(`refusing to wipe non-fixture path: ${path}`);
    }
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, SENTINEL), "UX-MSG-ACTIONS 58a2\n");
};

export async function buildMsgActionsFixture() {
  for (const p of [FIXTURE_ROOT, FIXTURE_DATA, FIXTURE_HOME, FIXTURE_BIN]) resetDir(p);

  // --- synthetic project repository (no remote, synthetic identity) --------
  writeFileSync(join(FIXTURE_ROOT, "README.md"), "# MSG-ACTIONS synthetic fixture\n\nDisposable repository for the message-actions live gate.\n");
  writeFileSync(join(FIXTURE_ROOT, "helper.ts"), "export const twice = (n: number): number => n * 2;\n");
  const git = (...args) => execFileSync("git", ["-C", FIXTURE_ROOT, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "MSG Actions Fixture Bot");
  git("config", "user.email", "msgact-fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-m", "chore: seed synthetic msg-actions fixture");

  // --- fake backend binary on PATH ------------------------------------------
  const fake = join(here, "msgActionsFakeBackend.mjs");
  const wrapper = join(FIXTURE_BIN, "opencode");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(wrapper, 0o755);

  // --- backend seed: histories the adapter aligns fork requests against ----
  const twoTurnMessages = (prefix) => [
    { id: `${prefix}_u1`, role: "user", text: TEXTS.u1 },
    { id: `${prefix}_a1`, role: "assistant", text: TEXTS.a1 },
    { id: `${prefix}_u2`, role: "user", text: TEXTS.u2 },
    { id: `${prefix}_a2`, role: "assistant", text: TEXTS.a2 },
  ];
  writeFileSync(OC_SEED, JSON.stringify({
    sessions: [
      { id: "oc_copy", title: "Completed synthetic session", messages: twoTurnMessages("c") },
      { id: "oc_revert", title: "Revert flow session", messages: twoTurnMessages("r") },
      { id: "oc_fork", title: "Fork flow session", messages: twoTurnMessages("f") },
      { id: "oc_forkfail", title: "Fork failure session", forkBehavior: "fail", messages: twoTurnMessages("x") },
      { id: "oc_mismatch", title: "Fork mismatch session", forkBehavior: "mismatch", messages: twoTurnMessages("m") },
      // "hang": prompts to this session never complete, so the live gate can
      // hold a truthful active-turn state with a durable queued delivery.
      { id: "oc_queued", title: "Queued session", turnBehavior: "hang", messages: twoTurnMessages("q") },
      { id: "oc_revert_active", title: "Active revert session", messages: twoTurnMessages("v") },
    ],
  }, null, 2));

  // --- isolated Polyth data: project registry + seeded session logs --------
  writeFileSync(join(FIXTURE_DATA, "projects.json"), JSON.stringify([{
    id: PROJECT_ID,
    path: FIXTURE_ROOT,
    name: "MSG Actions Fixture",
    createdAt: Date.now(),
  }], null, 2));

  const { createStore } = await import(join(REPO_ROOT, "packages/session/src/index.ts"));
  const store = createStore(join(FIXTURE_DATA, "sessions.db"));
  const now = Date.now();

  const projection = (id, title, status, extra = {}) => ({
    id, projectId: PROJECT_ID, title, status,
    createdAt: now - 3_600_000, updatedAt: now, ...extra,
  });

  /** Two finished turns; the second one carries reasoning + usage. Returns
   *  the seq of the second user prompt (the revert/fork target). */
  const seedTwoTurns = async (id, title) => {
    await store.append(id, "session/created", { title }, { ignorable: true });
    await store.append(id, "user/message", { text: TEXTS.u1 });
    await store.append(id, "turn/started", { turnId: `${id}-t1` }, { ignorable: true });
    await store.append(id, "assistant/message", { partId: `${id}-p1`, text: TEXTS.a1 });
    await store.append(id, "turn/stopped", { turnId: `${id}-t1`, reason: "completed" }, { ignorable: true });
    const u2 = await store.append(id, "user/message", { text: TEXTS.u2 });
    await store.append(id, "turn/started", { turnId: `${id}-t2` }, { ignorable: true });
    await store.append(id, "assistant/message", { partId: `${id}-p2r`, text: "", reasoning: TEXTS.reasoning });
    await store.append(id, "assistant/message", { partId: `${id}-p2`, text: TEXTS.a2 });
    await store.append(id, "usage/recorded", {
      model: { providerID: "synthetic", modelID: "fable-mini" },
      tokens: { input: 420, output: 96 },
      cost: 0.0123,
    }, { ignorable: true });
    await store.append(id, "turn/stopped", { turnId: `${id}-t2`, reason: "completed" }, { ignorable: true });
    return u2.seq;
  };

  const targets = {};
  targets.copy = await seedTwoTurns(SESSIONS.copy, "Completed synthetic session");
  await store.upsertProjection(projection(SESSIONS.copy, "Completed synthetic session", "idle", { backendSessionId: "oc_copy" }));

  targets.revert = await seedTwoTurns(SESSIONS.revert, "Revert flow session");
  await store.upsertProjection(projection(SESSIONS.revert, "Revert flow session", "idle", { backendSessionId: "oc_revert" }));

  targets.fork = await seedTwoTurns(SESSIONS.fork, "Fork flow session");
  await store.upsertProjection(projection(SESSIONS.fork, "Fork flow session", "idle", { backendSessionId: "oc_fork" }));

  targets.forkFail = await seedTwoTurns(SESSIONS.forkFail, "Fork failure session");
  await store.upsertProjection(projection(SESSIONS.forkFail, "Fork failure session", "idle", { backendSessionId: "oc_forkfail" }));

  targets.forkMismatch = await seedTwoTurns(SESSIONS.forkMismatch, "Fork mismatch session");
  await store.upsertProjection(projection(SESSIONS.forkMismatch, "Fork mismatch session", "idle", { backendSessionId: "oc_mismatch" }));

  // Failed: the turn ended with an error.
  await store.append(SESSIONS.failed, "session/created", { title: "Failed synthetic turn" }, { ignorable: true });
  await store.append(SESSIONS.failed, "user/message", { text: TEXTS.u1 });
  await store.append(SESSIONS.failed, "turn/started", { turnId: "fail-t1" }, { ignorable: true });
  await store.append(SESSIONS.failed, "turn/stopped", { turnId: "fail-t1", reason: "error", error: "synthetic model failure" }, { ignorable: true });
  await store.upsertProjection(projection(SESSIONS.failed, "Failed synthetic turn", "failed"));

  // Empty: created, zero messages.
  await store.append(SESSIONS.empty, "session/created", { title: "Empty synthetic session" }, { ignorable: true });
  await store.upsertProjection(projection(SESSIONS.empty, "Empty synthetic session", "idle"));

  // Active turn: inert replay data — no real model runs.
  await store.append(SESSIONS.active, "session/created", { title: "Active synthetic turn" }, { ignorable: true });
  await store.append(SESSIONS.active, "user/message", { text: TEXTS.u1 });
  await store.append(SESSIONS.active, "turn/started", { turnId: "active-t1" }, { ignorable: true });
  await store.append(SESSIONS.active, "assistant/chunk", { partId: "active-p1", text: "Analyzing synthetic files…" });
  await store.upsertProjection(projection(SESSIONS.active, "Active synthetic turn", "working"));

  // Waiting: one unresolved question.
  await store.append(SESSIONS.waiting, "session/created", { title: "Waiting synthetic question" }, { ignorable: true });
  await store.append(SESSIONS.waiting, "user/message", { text: TEXTS.u1 });
  await store.append(SESSIONS.waiting, "turn/started", { turnId: "wait-t1" }, { ignorable: true });
  await store.append(SESSIONS.waiting, "question/asked", {
    requestId: "q-msgact-view",
    questions: [{
      id: "view",
      prompt: "Choose the synthetic view",
      type: "single",
      required: true,
      options: [{ label: "Files", value: "files" }, { label: "Git", value: "git" }],
    }],
  }, { ignorable: true });
  await store.upsertProjection(projection(SESSIONS.waiting, "Waiting synthetic question", "waiting"));

  // Queued: complete log; the live gate then starts a hanging turn and queues
  // a follow-up through the real send path (an idle session's queue would
  // self-dispatch on subscribe — queued-and-idle is transient by design).
  targets.queued = await seedTwoTurns(SESSIONS.queued, "Queued synthetic session");
  await store.upsertProjection(projection(SESSIONS.queued, "Queued synthetic session", "idle", { backendSessionId: "oc_queued" }));

  // Active revert: the second prompt is already reverted; replay must derive
  // the draft (the marker carries only atSeq — never the prompt text).
  targets.revertActive = await seedTwoTurns(SESSIONS.revertActive, "Active revert session");
  await store.append(SESSIONS.revertActive, "session/rewound", { atSeq: targets.revertActive });
  await store.upsertProjection(projection(SESSIONS.revertActive, "Active revert session", "idle", { backendSessionId: "oc_revert_active" }));

  await store.close();

  // Deterministic, distinct event times (append stamps "now"): base one hour
  // ago, 5s apart by seq. Durations and <time dateTime> values become stable.
  const db = new DatabaseSync(join(FIXTURE_DATA, "sessions.db"));
  const base = now - 3_600_000;
  db.prepare("UPDATE events SET time = ? + seq * 5000").run(base);
  db.close();

  return { targets };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { targets } = await buildMsgActionsFixture();
  console.log("MSG-ACTIONS fixture ready.");
  console.log(`# project: ${PROJECT_ID}  data: ${FIXTURE_DATA}  home: ${FIXTURE_HOME}  bin: ${FIXTURE_BIN}`);
  console.log(`# revert/fork target seqs: ${JSON.stringify(targets)}`);
}

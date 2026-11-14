import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentRuntime,
  JsonObject,
  Project,
  ProjectService,
  RuntimeEvent,
  SessionEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createWorkspaceCheckpoints } from "../../git/src/checkpoints.ts";
import { editedPaths, rewindCheckpointTurns, WORKSPACE_CHECKPOINT_EVENT } from "../src/rewindFiles.ts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

const makeEvent = (seq: number, type: string, data: Record<string, unknown> = {}): SessionEvent => ({
  id: `ev-${seq}`,
  sessionId: "s1",
  seq,
  time: 1000 + seq,
  type,
  data: data as unknown as JsonObject,
});

const flush = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCheckpoints(
  store: { events: (id: string) => Promise<SessionEvent[]> },
  sessionId: string,
  count = 2,
): Promise<SessionEvent[]> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const events = await store.events(sessionId);
    const cp = events.filter((e) => e.type === WORKSPACE_CHECKPOINT_EVENT);
    if (cp.length >= count) return events;
    await flush(25);
  }
  return store.events(sessionId);
}

function fakeRuntime() {
  const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
  const startedTexts: string[] = [];
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const rt: AgentRuntime = {
    capabilities: async () => ({
      streaming: true,
      permissions: true,
      questions: true,
      compaction: false,
      subagents: false,
      steering: false,
      attachments: { modalities: { file: "native" } },
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    discardSession: async () => {},
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => {
      startedTexts.push(req.text);
      emit(req.sessionId, { type: "turn/started", turnId: `t${startedTexts.length}` });
    },
    abort: async (sessionId) => {
      emit(sessionId, { type: "turn/stopped", reason: "aborted" });
    },
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return { rt, emit, startedTexts };
}

async function createTestGitRepo(): Promise<{ repoDir: string; cleanup: () => void }> {
  const repoDir = mkdtempSync(join(tmpdir(), "polyth-test-git-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "Initial README\n");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "initial commit", "--no-gpg-sign"], { cwd: repoDir });

  const cleanup = () => {
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
  return { repoDir, cleanup };
}

function makeTestService(
  fake: ReturnType<typeof fakeRuntime>,
  repoDir: string,
  options?: { withoutCheckpoints?: boolean },
) {
  const dbDir = mkdtempSync(join(tmpdir(), "polyth-test-db-"));
  const store = createStore(join(dbDir, "s.db"));
  const project: Project = { id: "p1", path: repoDir, name: "test-proj", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "allow",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const checkpoints = options?.withoutCheckpoints ? undefined : () => createWorkspaceCheckpoints();
  const sessions = createSessionService({
    store,
    projects,
    permissions,
    broadcast,
    queue: store,
    runtimes: { forProject: async () => fake.rt },
    ...(checkpoints ? { checkpoints } : {}),
  });

  const cleanup = async () => {
    try {
      await store.close();
    } catch {
      // ignore
    }
    try {
      rmSync(dbDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { sessions, store, cleanup };
}

// ============================================================================
// A. Pure (no service) tests
// ============================================================================

test("rewindCheckpointTurns: target not a user/message returns mid-turn", () => {
  const visible = [
    makeEvent(1, "user/message", { text: "hello" }),
    makeEvent(2, "assistant/message", { text: "hi" }),
  ];
  const all = [...visible];

  const midTurn = rewindCheckpointTurns(visible, all, 2, { running: false });
  assert.deepEqual(midTurn, { ok: false, reason: "mid-turn" });

  const notFound = rewindCheckpointTurns(visible, all, 999, { running: false });
  assert.deepEqual(notFound, { ok: false, reason: "mid-turn" });
});

test("rewindCheckpointTurns: target without a before checkpoint returns no-snapshot", () => {
  const visible = [
    makeEvent(1, "user/message", { text: "hello" }),
    makeEvent(2, "assistant/message", { text: "hi" }),
  ];
  const noBefore = rewindCheckpointTurns(visible, visible, 1, { running: false });
  assert.deepEqual(noBefore, { ok: false, reason: "no-snapshot" });
});

test("rewindCheckpointTurns: two prompts with before/after return two turns oldest first with touched paths", () => {
  const visible = [
    makeEvent(1, "user/message", { text: "first" }),
    makeEvent(2, "tool/call", { callId: "c1", tool: "write", input: { path: "src/a.ts" } }),
    makeEvent(3, "tool/result", { callId: "c1", tool: "write", input: { path: "src/a.ts" } }),
    makeEvent(4, "assistant/message", { text: "done first" }),
    makeEvent(5, "user/message", { text: "second" }),
    makeEvent(6, "tool/call", { callId: "c2", tool: "write", input: { path: "src/b.ts" } }),
    makeEvent(7, "tool/result", { callId: "c2", tool: "write", input: { path: "src/b.ts" } }),
    makeEvent(8, "assistant/message", { text: "done second" }),
  ];
  const checkpoints = [
    makeEvent(100, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 1, phase: "before", commit: "c1_before", root: "/app" }),
    makeEvent(101, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 1, phase: "after", commit: "c1_after", root: "/app" }),
    makeEvent(102, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 5, phase: "before", commit: "c2_before", root: "/app" }),
    makeEvent(103, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 5, phase: "after", commit: "c2_after", root: "/app" }),
  ];
  const all = [...visible, ...checkpoints];

  const res = rewindCheckpointTurns(visible, all, 1, { running: false });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.root, "/app");
  assert.equal(res.turns.length, 2);
  assert.deepEqual(res.turns[0], {
    promptSeq: 1,
    before: "c1_before",
    after: "c1_after",
    touched: ["src/a.ts"],
  });
  assert.deepEqual(res.turns[1], {
    promptSeq: 5,
    before: "c2_before",
    after: "c2_after",
    touched: ["src/b.ts"],
  });
});

test("rewindCheckpointTurns: a steered prompt without checkpoints is folded into the previous turn", () => {
  const visible = [
    makeEvent(1, "user/message", { text: "first" }),
    makeEvent(2, "tool/call", { callId: "c1", tool: "write", input: { path: "src/a.ts" } }),
    makeEvent(3, "tool/result", { callId: "c1", tool: "write", input: { path: "src/a.ts" } }),
    makeEvent(4, "user/message", { text: "steered message" }),
    makeEvent(5, "tool/call", { callId: "c2", tool: "write", input: { path: "src/b.ts" } }),
    makeEvent(6, "tool/result", { callId: "c2", tool: "write", input: { path: "src/b.ts" } }),
    makeEvent(7, "assistant/message", { text: "done all" }),
  ];
  const checkpoints = [
    makeEvent(100, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 1, phase: "before", commit: "c1_before", root: "/app" }),
    makeEvent(101, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 1, phase: "after", commit: "c1_after", root: "/app" }),
  ];
  const all = [...visible, ...checkpoints];

  const res = rewindCheckpointTurns(visible, all, 1, { running: false });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.turns.length, 1);
  assert.equal(res.turns[0]?.promptSeq, 1);
  assert.equal(res.turns[0]?.before, "c1_before");
  assert.equal(res.turns[0]?.after, "c1_after");
  assert.deepEqual(res.turns[0]?.touched.sort(), ["src/a.ts", "src/b.ts"]);
});

test("rewindCheckpointTurns: newest turn without after checkpoint handles running flag", () => {
  const visible = [
    makeEvent(1, "user/message", { text: "first" }),
    makeEvent(2, "user/message", { text: "second" }),
  ];
  const checkpoints = [
    makeEvent(100, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 1, phase: "before", commit: "c1_before", root: "/app" }),
    makeEvent(101, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 1, phase: "after", commit: "c1_after", root: "/app" }),
    makeEvent(102, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 2, phase: "before", commit: "c2_before", root: "/app" }),
  ];
  const all = [...visible, ...checkpoints];

  const runningRes = rewindCheckpointTurns(visible, all, 1, { running: true });
  assert.equal(runningRes.ok, true);
  if (runningRes.ok) {
    assert.equal(runningRes.runningPromptSeq, 2);
    assert.equal(runningRes.turns.length, 2);
    assert.equal(runningRes.turns[1]?.promptSeq, 2);
    assert.equal(runningRes.turns[1]?.before, "c2_before");
    assert.equal(runningRes.turns[1]?.after, "");
  }

  const stoppedRes = rewindCheckpointTurns(visible, all, 1, { running: false });
  assert.deepEqual(stoppedRes, { ok: false, reason: "no-snapshot" });
});

test("rewindCheckpointTurns: checkpoints with different roots return no-snapshot", () => {
  const visible = [
    makeEvent(1, "user/message", { text: "first" }),
    makeEvent(2, "user/message", { text: "second" }),
  ];
  const diffRoots = [
    makeEvent(100, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 1, phase: "before", commit: "c1_b", root: "/repo-1" }),
    makeEvent(101, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 1, phase: "after", commit: "c1_a", root: "/repo-1" }),
    makeEvent(102, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 2, phase: "before", commit: "c2_b", root: "/repo-2" }),
    makeEvent(103, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 2, phase: "after", commit: "c2_a", root: "/repo-2" }),
  ];
  const res1 = rewindCheckpointTurns(visible, [...visible, ...diffRoots], 1, { running: false });
  assert.deepEqual(res1, { ok: false, reason: "no-snapshot" });

  const mismatchedPhase = [
    makeEvent(100, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 1, phase: "before", commit: "c1_b", root: "/repo-1" }),
    makeEvent(101, WORKSPACE_CHECKPOINT_EVENT, { promptSeq: 1, phase: "after", commit: "c1_a", root: "/repo-2" }),
  ];
  const res2 = rewindCheckpointTurns([visible[0]!], [...visible, ...mismatchedPhase], 1, { running: false });
  assert.deepEqual(res2, { ok: false, reason: "no-snapshot" });
});

test("editedPaths: joins tool/call input to tool/result by callId even when the result tool name is generic tool", () => {
  const events = [
    makeEvent(1, "tool/call", {
      callId: "call_join_1",
      tool: "write",
      input: { path: "src/foo.ts" },
    }),
    makeEvent(2, "tool/result", {
      callId: "call_join_1",
      tool: "tool",
      output: "ok",
    }),
  ];
  const paths = editedPaths(events);
  assert.deepEqual(paths, ["src/foo.ts"]);
});

test("editedPaths: a result repeating an empty input keeps the call's input", () => {
  const events = [
    makeEvent(1, "tool/call", { callId: "call_empty_1", tool: "write", input: { path: "a.ts" } }),
    makeEvent(2, "tool/result", { callId: "call_empty_1", tool: "tool", input: {} }),
  ];
  assert.deepEqual(editedPaths(events), ["a.ts"]);
});

// ============================================================================
// B. Integration tests with real git repo and createWorkspaceCheckpoints
// ============================================================================

test("rewind integration: checkpoints capture, preview, restore, and clear-rewind round-trip", async () => {
  const { repoDir, cleanup: cleanupRepo } = await createTestGitRepo();
  const fake = fakeRuntime();
  const { sessions, store, cleanup: cleanupService } = makeTestService(fake, repoDir);

  try {
    const { id } = await sessions.create({ projectId: "p1", title: "Integration Session 1" });

    // 1. send prompt 1; while turn runs, write src/a.txt, modify README.md, emit tool call/result, stop turn
    await sessions.send(id, { text: "first prompt" });
    await flush();

    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "a.txt"), "hello from a\n");
    await writeFile(join(repoDir, "README.md"), "Modified README content\n");

    fake.emit(id, {
      type: "tool/call",
      callId: "call_write_1",
      tool: "write",
      input: { path: "src/a.txt" },
    });
    await flush();
    fake.emit(id, {
      type: "tool/result",
      callId: "call_write_1",
      tool: "tool",
      input: { path: "src/a.txt" },
    });
    await flush();

    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    const events = await waitForCheckpoints(store, id, 2);

    // Assert two workspace/checkpoint events (before/after) with commits for prompt 1's seq
    const prompt1Seq = events.find((e) => e.type === "user/message")!.seq;
    const cpEvents = events.filter((e) => e.type === WORKSPACE_CHECKPOINT_EVENT);
    assert.equal(cpEvents.length, 2);
    assert.equal(cpEvents[0]!.data.phase, "before");
    assert.equal(cpEvents[0]!.data.promptSeq, prompt1Seq);
    assert.ok(cpEvents[0]!.data.commit);
    assert.equal(cpEvents[1]!.data.phase, "after");
    assert.equal(cpEvents[1]!.data.promptSeq, prompt1Seq);
    assert.ok(cpEvents[1]!.data.commit);

    // 2. previewRewindFiles(session, prompt1Seq)
    const preview = await sessions.previewRewindFiles!(id, prompt1Seq);
    assert.equal(preview.available, true);
    assert.equal(preview.turnRunning, false);
    const restoreA = preview.restore.find((r) => r.path === "src/a.txt");
    const restoreReadme = preview.restore.find((r) => r.path === "README.md");
    assert.ok(restoreA, "src/a.txt must be in restore list");
    assert.equal(restoreA.kind, "added");
    assert.ok(restoreReadme, "README.md must be in restore list");
    assert.equal(restoreReadme.kind, "modified");

    // 3. rewind(session, prompt1Seq, { files: "restore" })
    const rewindMarker = await sessions.rewind!(id, prompt1Seq, { files: "restore" });
    assert.equal(rewindMarker.type, "session/rewound");
    const filesOutcome = (rewindMarker.data as any).files;
    assert.equal(filesOutcome?.mode, "restored");
    assert.equal(filesOutcome?.restored, 2);
    assert.equal(existsSync(join(repoDir, "src", "a.txt")), false, "src/a.txt must be removed from disk");
    const readmeOnDisk = await readFile(join(repoDir, "README.md"), "utf8");
    assert.equal(readmeOnDisk, "Initial README\n", "README.md must be restored to its initial content");

    // 4. previewRewindRestore and clearRewind
    const restorePreview = await sessions.previewRewindRestore!(id);
    assert.equal(restorePreview.restore, 2);

    const clearMarker = await sessions.clearRewind!(id);
    assert.equal(clearMarker.type, "session/rewind-cleared");
    const clearFiles = (clearMarker.data as any).files;
    assert.equal(clearFiles?.restored, 2);

    assert.equal(existsSync(join(repoDir, "src", "a.txt")), true, "src/a.txt must be restored back");
    const aContent = await readFile(join(repoDir, "src", "a.txt"), "utf8");
    assert.equal(aContent, "hello from a\n");
    const readmeContentBack = await readFile(join(repoDir, "README.md"), "utf8");
    assert.equal(readmeContentBack, "Modified README content\n");
  } finally {
    await cleanupService();
    cleanupRepo();
  }
});

test("rewind integration: file edited by test after turn is kept as changed-after", async () => {
  const { repoDir, cleanup: cleanupRepo } = await createTestGitRepo();
  const fake = fakeRuntime();
  const { sessions, store, cleanup: cleanupService } = makeTestService(fake, repoDir);

  try {
    const { id } = await sessions.create({ projectId: "p1", title: "Integration Session 2" });
    await sessions.send(id, { text: "prompt changes" });
    await flush();

    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(join(repoDir, "src", "a.txt"), "agent created a\n");
    await writeFile(join(repoDir, "README.md"), "agent modified readme\n");

    fake.emit(id, {
      type: "tool/call",
      callId: "c1",
      tool: "write",
      input: { path: "src/a.txt" },
    });
    await flush();
    fake.emit(id, {
      type: "tool/result",
      callId: "c1",
      tool: "tool",
      input: { path: "src/a.txt" },
    });
    await flush();
    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    const events = await waitForCheckpoints(store, id, 2);
    const promptSeq = events.find((e) => e.type === "user/message")!.seq;

    // 5. Test edits README itself after the turn
    await writeFile(join(repoDir, "README.md"), "test modified readme after turn\n");

    const marker = await sessions.rewind!(id, promptSeq, { files: "restore" });
    assert.equal(marker.type, "session/rewound");
    const files = (marker.data as any).files;
    assert.equal(files?.mode, "restored");
    assert.equal(files?.restored, 1);
    assert.equal(files?.kept, 1);
    const keptReadme = files?.keptFiles?.find((f: any) => f.path === "README.md");
    assert.ok(keptReadme);
    assert.equal(keptReadme.reason, "changed-after");

    // README untouched on disk
    const readmeDisk = await readFile(join(repoDir, "README.md"), "utf8");
    assert.equal(readmeDisk, "test modified readme after turn\n");

    // src/a.txt removed
    assert.equal(existsSync(join(repoDir, "src", "a.txt")), false);
  } finally {
    await cleanupService();
    cleanupRepo();
  }
});

test("rewind integration: files keep mode and default rewind without options", async () => {
  const { repoDir, cleanup: cleanupRepo } = await createTestGitRepo();
  const fake = fakeRuntime();
  const { sessions, store, cleanup: cleanupService } = makeTestService(fake, repoDir);

  try {
    const { id } = await sessions.create({ projectId: "p1", title: "Integration Session 3" });
    await sessions.send(id, { text: "prompt changes" });
    await flush();

    await writeFile(join(repoDir, "README.md"), "work in progress readme\n");
    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    const events = await waitForCheckpoints(store, id, 2);
    const promptSeq = events.find((e) => e.type === "user/message")!.seq;

    // 6. rewind with files: "keep"
    const markerKeep = await sessions.rewind!(id, promptSeq, { files: "keep" });
    assert.equal(markerKeep.type, "session/rewound");
    const keepFiles = (markerKeep.data as any).files;
    assert.equal(keepFiles?.mode, "kept");
    assert.equal(await readFile(join(repoDir, "README.md"), "utf8"), "work in progress readme\n");

    // Clear rewind to test rewind with no options
    await sessions.clearRewind!(id);

    // rewind with no options
    const markerDefault = await sessions.rewind!(id, promptSeq);
    assert.equal(markerDefault.type, "session/rewound");
    assert.equal("files" in markerDefault.data, false, "marker data must not have files when options are omitted");
    assert.equal(await readFile(join(repoDir, "README.md"), "utf8"), "work in progress readme\n");
  } finally {
    await cleanupService();
    cleanupRepo();
  }
});

test("rewind integration: missing checkpoints dependency skips checkpoints and returns service-missing", async () => {
  const { repoDir, cleanup: cleanupRepo } = await createTestGitRepo();
  const fake = fakeRuntime();
  // 7. with no checkpoints dep
  const { sessions, store, cleanup: cleanupService } = makeTestService(fake, repoDir, { withoutCheckpoints: true });

  try {
    const { id } = await sessions.create({ projectId: "p1", title: "Integration Session 4" });
    await sessions.send(id, { text: "hello without checkpoints" });
    await flush();

    await writeFile(join(repoDir, "README.md"), "new content\n");
    fake.emit(id, { type: "turn/stopped", reason: "completed" });
    await flush();

    const events = await store.events(id);
    const cpEvents = events.filter((e) => e.type === WORKSPACE_CHECKPOINT_EVENT);
    assert.equal(cpEvents.length, 0, "no workspace/checkpoint events should be recorded when checkpoints service is missing");

    const promptSeq = events.find((e) => e.type === "user/message")!.seq;
    const preview = await sessions.previewRewindFiles!(id, promptSeq);
    assert.equal(preview.available, false);
    assert.equal(preview.reason, "service-missing");
  } finally {
    await cleanupService();
    cleanupRepo();
  }
});

test("rewind integration: active turn rejects rewind restore with conflict and reports turnRunning", async () => {
  const { repoDir, cleanup: cleanupRepo } = await createTestGitRepo();
  const fake = fakeRuntime();
  const { sessions, store, cleanup: cleanupService } = makeTestService(fake, repoDir);

  try {
    const { id } = await sessions.create({ projectId: "p1", title: "Integration Session 5" });
    // 8. while a turn is running
    await sessions.send(id, { text: "running turn prompt" });
    await flush();

    await writeFile(join(repoDir, "README.md"), "running edit\n");

    const events = await store.events(id);
    const promptSeq = events.find((e) => e.type === "user/message")!.seq;

    const preview = await sessions.previewRewindFiles!(id, promptSeq);
    assert.equal(preview.turnRunning, true, "previewRewindFiles must return turnRunning: true while turn is active");

    await assert.rejects(
      async () => {
        await sessions.rewind!(id, promptSeq, { files: "restore" });
      },
      (err: any) => {
        assert.equal(err?.code, "conflict");
        return true;
      },
    );

    const eventsAfterReject = await store.events(id);
    const rewindMarkers = eventsAfterReject.filter((e) => e.type === "session/rewound");
    assert.equal(rewindMarkers.length, 0, "no session/rewound marker must be written when rollback rejects");

    fake.emit(id, { type: "turn/stopped", reason: "aborted" });
    await waitForCheckpoints(store, id, 2);
  } finally {
    await cleanupService();
    cleanupRepo();
  }
});

// WP5: session rename/organize, idempotent archive/restore, attention badges
// derived from events, bulk ops with partial failures, project PATCH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type { AgentRuntime, FeatureSupport, Project, ProjectDefaults, ProjectService, RuntimeEvent, SessionEvent, SessionProjection } from "@polyth/contracts";
import { titleFromPrompt } from "@polyth/harness-runtime";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import { createProjectService } from "../src/projects.ts";
import type { PermissionService } from "@polyth/permissions";

function fakeRuntime(generatedTitle?: string, polledTitle?: string, polledTitleAfter = 0, harnessId = "opencode", titleSupport: FeatureSupport = "native"): AgentRuntime {
  const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
  let sessionId = "";
  let sessionReads = 0;
  return {
    harnessId,
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false,
      title: titleSupport,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => {
      sessionReads += 1;
      return polledTitle && sessionReads > polledTitleAfter ? [{
        id: `be_${sessionId}`, title: polledTitle, createdAt: 0, updatedAt: 0,
      }] : [];
    },
    history: async () => [],
    startTurn: async (req) => {
      sessionId = req.sessionId;
      for (const listener of listeners) {
        listener(req.sessionId, { type: "turn/started", turnId: "t1" });
        listener(req.sessionId, { type: "turn/stopped", reason: "completed" });
        if (generatedTitle) {
          listener(req.sessionId, {
            type: "session/title-generated",
            title: "New session - 2026-08-26T05:00:55.897Z",
          });
          listener(req.sessionId, { type: "session/title-generated", title: generatedTitle });
        }
      }
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) { listeners.add(cb); return { dispose: () => listeners.delete(cb) }; },
    dispose: async () => {},
  };
}

function makeService(opts: {
  worktrees?: { list(root: string): Promise<Array<{ path: string; branch: string | null }>> };
  onRuntimeCwd?: (cwd: string | undefined) => void;
  generatedTitle?: string;
  polledTitle?: string;
  polledTitleAfter?: number;
  harnessId?: string;
  titleSupport?: FeatureSupport;
  defaults?: ProjectDefaults;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-orgsvc-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1, ...(opts.defaults ? { defaults: opts.defaults } : {}) };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = { evaluate: () => "ask", addRule: () => {}, rules: () => [] } as unknown as PermissionService;
  const broadcastEvents: SessionEvent[] = [];
  const broadcastProjections: SessionProjection[] = [];
  const broadcast: Broadcaster = {
    event: (event) => { broadcastEvents.push(event); },
    projection: (projection) => { broadcastProjections.push(projection); },
  };
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store, org: store,
    ...(opts.worktrees ? { worktrees: opts.worktrees } : {}),
    runtimes: {
      forProject: async (_projectId, cwd) => {
        opts.onRuntimeCwd?.(cwd);
        return fakeRuntime(opts.generatedTitle, opts.polledTitle, opts.polledTitleAfter, opts.harnessId, opts.titleSupport);
      },
    },
  });
  return { sessions, store, dir, broadcastEvents, broadcastProjections };
}

async function waitForTitle(
  sessions: ReturnType<typeof makeService>["sessions"],
  sessionId: string,
  title: string,
): Promise<void> {
  const started = Date.now();
  while ((await sessions.snapshot(sessionId)).title !== title) {
    if (Date.now() - started > 2_000) throw new Error(`timed out waiting for title: ${title}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("rename validates and appends session/metadata-changed before projection", async () => {
  const { sessions, store } = makeService();
  const { id } = await sessions.create({ projectId: "p1", title: "Old" });

  await sessions.rename!(id, "  New title  ");
  const snap = await sessions.snapshot(id);
  assert.equal(snap.title, "New title");
  const evs = await store.events(id);
  const meta = evs.find((e) => e.type === "session/metadata-changed");
  assert.ok(meta, "metadata event must be in the durable log");
  assert.equal((meta!.data as { title?: string }).title, "New title");

  await assert.rejects(() => sessions.rename!(id, "   "), /title required/);
  await assert.rejects(() => sessions.rename!("nope", "x"), /not found/);
});

test("verified in-place worktree branch rename persists before projection", async () => {
  const worktreePath = "/repo-worktrees/temp-red-panther";
  const { sessions, store } = makeService({
    worktrees: {
      list: async () => [
        { path: worktreePath, branch: "temp/red-panther-4821" },
      ],
    },
  });
  const { id } = await sessions.create({ projectId: "p1", worktreePath });

  await sessions.renameWorktreeBranch!(id, {
    worktreePath,
    from: "temp/red-panther-4821",
    to: "feat/branch-picker",
  });

  assert.equal((await sessions.snapshot(id)).branch, "feat/branch-picker");
  const renamed = (await store.events(id)).find((event) => event.type === "session/worktree-branch-renamed");
  assert.deepEqual(renamed?.data, {
    worktreePath,
    from: "temp/red-panther-4821",
    to: "feat/branch-picker",
  });
  await assert.rejects(
    () => sessions.renameWorktreeBranch!(id, {
      worktreePath: "/different",
      from: "feat/branch-picker",
      to: "feat/other",
    }),
    /worktree changed/,
  );
  await store.close();
});

test("draft CAS preserves the authoritative projection on a stale writer", async () => {
  const { sessions, store } = makeService();
  try {
    const { id } = await sessions.create({ projectId: "p1", title: "Draft" });
    const first = await sessions.saveDraft!(id, "first", null);
    assert.ok(first.draftUpdatedAt > 0);
    await assert.rejects(
      () => sessions.saveDraft!(id, "stale", null),
      (error: Error & { code?: string }) => error.code === "draft-conflict",
    );
    assert.equal((await store.projection(id))?.draft, "first");
    const cleared = await sessions.saveDraft!(id, "", first.draftUpdatedAt);
    assert.ok(cleared.draftUpdatedAt > first.draftUpdatedAt);
    assert.equal((await store.projection(id))?.draft, undefined);
  } finally {
    await store.close();
  }
});

test("auto title persists OpenCode's generated title after its source prompt", async () => {
  const generatedTitle = "Stabilize intermittent login test";
  const { sessions, store } = makeService({ generatedTitle });
  const { id } = await sessions.create({ projectId: "p1" });

  await sessions.send(id, { text: "  Fix the intermittent login test\nwith a deterministic clock", autoTitle: true });
  await waitForTitle(sessions, id, generatedTitle);

  const snapshot = await sessions.snapshot(id);
  assert.equal(snapshot.title, generatedTitle);
  const events = await store.events(id);
  const userIndex = events.findIndex((event) => event.type === "user/message");
  const titleIndex = events.findIndex((event) => event.type === "session/metadata-changed");
  assert.ok(userIndex >= 0, "the prompt is durable");
  assert.ok(titleIndex > userIndex, "the durable title follows its source prompt");
  assert.equal(events.filter((event) => event.type === "session/metadata-changed").length, 1);
  assert.deepEqual(events[titleIndex]!.data, { title: generatedTitle, source: "opencode" });
  assert.equal(events[titleIndex]!.producerPlugin, "backend-opencode");
});

test("Codex prompt title is persisted then broadcast when native generation is unavailable", async () => {
  const prompt = "Repair Codex session naming";
  const { sessions, store, broadcastEvents, broadcastProjections } = makeService({
    harnessId: "codex",
    titleSupport: "emulated",
  });
  const { id } = await sessions.create({ projectId: "p1" });

  await sessions.send(id, { text: prompt, autoTitle: true });
  await waitForTitle(sessions, id, titleFromPrompt(prompt));

  const events = await store.events(id);
  const promptIndex = events.findIndex((event) => event.type === "user/message");
  const titleIndex = events.findIndex((event) => event.type === "session/metadata-changed");
  assert.ok(titleIndex > promptIndex, "the durable title must follow its source prompt");
  assert.deepEqual(events[titleIndex]?.data, { title: titleFromPrompt(prompt), source: "polyth" });
  assert.ok(broadcastEvents.some((event) => event.seq === events[titleIndex]?.seq));
  assert.equal(broadcastProjections.findLast((projection) => projection.id === id)?.title, titleFromPrompt(prompt));
  await store.close();
});

test("auto title falls back to OpenCode's session list when its title event is absent", async () => {
  const generatedTitle = "Stabilize intermittent login test";
  const { sessions } = makeService({ polledTitle: generatedTitle });
  const { id } = await sessions.create({ projectId: "p1" });

  await sessions.send(id, { text: "Fix the intermittent login test", autoTitle: true });
  await waitForTitle(sessions, id, generatedTitle);
});

test("auto title retries the session list while OpenCode writes its title", async () => {
  const generatedTitle = "Stabilize intermittent login test";
  const { sessions } = makeService({ polledTitle: generatedTitle, polledTitleAfter: 1 });
  const { id } = await sessions.create({ projectId: "p1" });

  await sessions.send(id, { text: "Fix the intermittent login test", autoTitle: true });
  await waitForTitle(sessions, id, generatedTitle);
});

test("auto title preserves an explicit title and respects the client preference", async () => {
  const { sessions, store } = makeService({ generatedTitle: "Generated replacement" });
  const explicit = await sessions.create({ projectId: "p1", title: "Release checklist" });
  const disabled = await sessions.create({ projectId: "p1" });

  await sessions.send(explicit.id, { text: "Replace this title", autoTitle: true });
  await sessions.send(disabled.id, { text: "Do not title this session" });

  assert.equal((await sessions.snapshot(explicit.id)).title, "Release checklist");
  assert.equal((await sessions.snapshot(disabled.id)).title, "New session");
  assert.equal((await store.events(explicit.id)).filter((event) => event.type === "session/metadata-changed").length, 0);
  assert.equal((await store.events(disabled.id)).filter((event) => event.type === "session/metadata-changed").length, 0);
});

test("organize assigns folders/labels; unknown or cross-project folder rejected", async () => {
  const { sessions, store } = makeService();
  const { id } = await sessions.create({ projectId: "p1", title: "S" });
  const folder = await store.folderCreate("p1", "Inbox");
  const foreign = await store.folderCreate("p2", "Elsewhere");

  await sessions.organize!(id, { folderId: folder.id, labelIds: ["l1", "l2"] });
  let snap = await sessions.snapshot(id);
  assert.equal(snap.folderId, folder.id);
  assert.deepEqual(snap.labelIds, ["l1", "l2"]);

  await assert.rejects(() => sessions.organize!(id, { folderId: foreign.id }), /not found in this project/);
  await assert.rejects(() => sessions.organize!(id, { folderId: "ghost" }), /not found in this project/);

  await sessions.organize!(id, { folderId: null });
  snap = await sessions.snapshot(id);
  assert.equal(snap.folderId, undefined);
  assert.deepEqual(snap.labelIds, ["l1", "l2"]); // untouched by folder-only patch
});

test("pin organization persists on projections without adding model history", async () => {
  const { sessions, store } = makeService();
  const { id } = await sessions.create({ projectId: "p1", title: "Pinned" });
  const before = await store.events(id);

  await sessions.organize!(id, { pinned: { position: 3 } });
  assert.deepEqual((await sessions.snapshot(id)).pinned, { position: 3 });
  assert.equal((await store.events(id)).length, before.length, "pin state must stay out of the event log");

  await assert.rejects(
    () => sessions.organize!(id, { pinned: { position: -1 } }),
    (error: Error & { code?: string }) => error.code === "invalid-input",
  );
  await sessions.organize!(id, { pinned: null });
  assert.equal((await sessions.snapshot(id)).pinned, undefined);
  assert.equal((await store.events(id)).length, before.length);
});

test("worktree session validates project ownership, persists branch metadata, and uses the worktree cwd", async () => {
  let runtimeCwd: string | undefined;
  let linkedPath = "";
  const { sessions, store, dir } = makeService({
    onRuntimeCwd: (cwd) => { runtimeCwd = cwd; },
    worktrees: {
      list: async () => [{ path: linkedPath, branch: "feat/isolated" }],
    },
  });
  linkedPath = join(dir, "linked");

  const { id } = await sessions.create({ projectId: "p1", title: "Isolated", worktreePath: linkedPath });
  const projection = await sessions.snapshot(id);
  assert.equal(runtimeCwd, linkedPath);
  assert.equal(projection.worktreePath, linkedPath);
  assert.equal(projection.worktreeId, linkedPath);
  assert.equal(projection.branch, "feat/isolated");
  assert.equal(projection.worktreeState, "ready");

  const eventCount = (await store.events(id)).length;
  await sessions.markWorktreeMissing!("p1", linkedPath);
  assert.equal((await sessions.snapshot(id)).worktreeState, "missing");
  assert.equal((await store.events(id)).length, eventCount, "worktree state is projection metadata");

  await assert.rejects(
    () => sessions.create({ projectId: "p1", worktreePath: join(dir, "..", "foreign") }),
    (error: Error & { code?: string }) => error.code === "invalid-input",
  );
});

test("archive/restore are idempotent: repeats do not append duplicate events", async () => {
  const { sessions, store } = makeService();
  const { id } = await sessions.create({ projectId: "p1", title: "S" });

  await sessions.archive(id);
  await sessions.archive(id);
  await sessions.archive(id);
  assert.equal((await store.events(id)).filter((e) => e.type === "session/archived").length, 1);
  assert.equal((await sessions.snapshot(id)).status, "archived");

  await sessions.restore(id);
  await sessions.restore(id);
  assert.equal((await store.events(id)).filter((e) => e.type === "session/restored").length, 1);
  assert.equal((await sessions.snapshot(id)).status, "idle");
});

test("list derives attention badges from unresolved request events", async () => {
  const { sessions, store } = makeService();
  const { id } = await sessions.create({ projectId: "p1", title: "S" });
  await store.append(id, "permission/requested", { requestId: "pm1" });
  await store.append(id, "question/asked", { requestId: "q1" });
  await store.append(id, "question/asked", { requestId: "q2" });
  await store.append(id, "question/answered", { requestId: "q1" });

  const listed = await sessions.list("p1");
  const s = listed.find((x) => x.id === id)!;
  assert.deepEqual(s.attention, { questions: 1, permissions: 1, unread: 0 });
});

test("list counts assistant messages past the read cursor as unread; markRead clears them", async () => {
  const { sessions, store } = makeService();
  const { id } = await sessions.create({ projectId: "p1", title: "S" });
  const ev1 = await store.append(id, "user/message", { text: "hi" });
  await store.append(id, "assistant/message", { text: "one" });
  const ev3 = await store.append(id, "assistant/message", { text: "two" });

  // No cursor (never opened since the feature shipped): everything counts as read.
  const fresh = (await sessions.list("p1")).find((x) => x.id === id)!;
  assert.equal(fresh.attention?.unread, 0);

  // A cursor behind the tail makes the newer assistant messages unread.
  await sessions.markRead!(id, ev1.seq);
  const partial = (await sessions.list("p1")).find((x) => x.id === id)!;
  assert.equal(partial.attention?.unread, 2);

  // Reading to the tail clears the badge.
  await sessions.markRead!(id, ev3.seq);
  const read = (await sessions.list("p1")).find((x) => x.id === id)!;
  assert.equal(read.attention?.unread, 0);
});

test("bulk semantics: mixed ids report partial failures without aborting", async () => {
  const { sessions } = makeService();
  const a = await sessions.create({ projectId: "p1", title: "A" });
  const b = await sessions.create({ projectId: "p1", title: "B" });

  // Simulates the /api/sessions/bulk loop: valid ids succeed, ghosts report codes.
  const ids = [a.id, "ghost", b.id];
  const result = { succeeded: [] as string[], failed: [] as Array<{ id: string; code: string }> };
  for (const sid of ids) {
    try {
      await sessions.archive(sid);
      result.succeeded.push(sid);
    } catch (err) {
      result.failed.push({ id: sid, code: (err as { code?: string }).code ?? "internal" });
    }
  }
  assert.deepEqual(result.succeeded, [a.id, b.id]);
  assert.deepEqual(result.failed, [{ id: "ghost", code: "not-found" }]);
});

test("project PATCH updates metadata and merges defaults; bad values rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-proj-"));
  const projects = createProjectService(dir);
  const p = await projects.add(dir, "orig");

  const upd = await projects.update!(p.id, { name: "renamed", color: "#a1b2c3", icon: "🚀" });
  assert.equal(upd.name, "renamed");
  assert.equal(upd.color, "#a1b2c3");
  assert.equal(upd.icon, "🚀");

  await projects.update!(p.id, { defaults: { agent: "build" } });
  const merged = await projects.update!(p.id, { defaults: { groupingMode: "folders" } });
  assert.deepEqual(merged.defaults, { agent: "build", groupingMode: "folders" });

  await assert.rejects(() => projects.update!(p.id, { color: "red" }), /hex/);
  await assert.rejects(() => projects.update!(p.id, { name: "" }), /name required/);
  await assert.rejects(() => projects.update!("ghost", { name: "x" }), /not found/);

  // persisted across a reload
  const reloaded = createProjectService(dir);
  assert.equal((await reloaded.get(p.id))!.name, "renamed");
});

test("auto title falls back to prompt when native title never arrives", async () => {
  const prompt = "Add auth middleware to the API";
  const { sessions, store } = makeService({ harnessId: "claude" });
  const { id } = await sessions.create({ projectId: "p1" });
  await sessions.send(id, { text: prompt, autoTitle: true });
  const started = Date.now();
  while ((await sessions.snapshot(id)).title !== titleFromPrompt(prompt)) {
    if (Date.now() - started > 15_000) throw new Error("timed out waiting for fallback title");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const meta = (await store.events(id)).find((e) => e.type === "session/metadata-changed");
  assert.deepEqual(meta?.data, { title: titleFromPrompt(prompt), source: "polyth" });
});

test("native title polling works for any harness with title native", async () => {
  const generatedTitle = "Claude session title";
  const { sessions } = makeService({ polledTitle: generatedTitle, harnessId: "claude" });
  const { id } = await sessions.create({ projectId: "p1" });
  await sessions.send(id, { text: "Name this session", autoTitle: true });
  await waitForTitle(sessions, id, generatedTitle);
});

test("manual title prevents native overwrite", async () => {
  const { sessions } = makeService({ generatedTitle: "Generated replacement", polledTitle: "Polled title" });
  const { id } = await sessions.create({ projectId: "p1", title: "Manual title" });
  await sessions.send(id, { text: "Do not rename", autoTitle: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await sessions.snapshot(id)).title, "Manual title");
});

test("session create inherits the project default model and agent", async () => {
  const { sessions } = makeService({
    defaults: {
      model: { providerID: "openrouter", modelID: "deepseek/deepseek-v4.1-flash" },
      agent: "build",
    },
  });
  const { id } = await sessions.create({ projectId: "p1", title: "Resolve git conflicts" });
  const snap = await sessions.snapshot(id);
  assert.deepEqual(snap.model, { providerID: "openrouter", modelID: "deepseek/deepseek-v4.1-flash" });
  assert.equal(snap.agent, "build");

  // An explicit caller choice still wins over the project default.
  const explicit = await sessions.create({
    projectId: "p1",
    title: "Explicit",
    model: { providerID: "openrouter", modelID: "other-model" },
    agent: "plan",
  });
  const explicitSnap = await sessions.snapshot(explicit.id);
  assert.deepEqual(explicitSnap.model, { providerID: "openrouter", modelID: "other-model" });
  assert.equal(explicitSnap.agent, "plan");

  // A caller that pins its own harness does not inherit a harness-qualified
  // project default model.
  const pinned = await sessions.create({
    projectId: "p1",
    title: "Pinned elsewhere",
    harness: { mode: "pinned", harnessId: "claude" },
  });
  assert.equal((await sessions.snapshot(pinned.id)).model, undefined);
});

test("a stored project model is not a default while model memory is off", async () => {
  const { sessions } = makeService({
    defaults: {
      model: { providerID: "openrouter", modelID: "deepseek/deepseek-v4.1-flash" },
      rememberModelSelection: false,
    },
  });
  const { id } = await sessions.create({ projectId: "p1", title: "No memory" });
  assert.equal((await sessions.snapshot(id)).model, undefined);
});

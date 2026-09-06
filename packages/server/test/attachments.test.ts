// F2: attachment sanitation + send-path persistence and runtime handoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore, deriveMessages } from "@polyth/session";
import { createFileService, type FileService } from "@polyth/files";
import { createAttachmentSourceService } from "../../files/src/serverEntry.ts";
import type {
  AgentRuntime, AttachmentRef, CanonicalTurnRequest, Project, ProjectService, RuntimeEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import { sanitizeAttachments } from "../src/attachments.ts";

const OPTS = { maxBytes: 1024 * 1024, projectId: "p1" };

test("sanitizeAttachments: valid refs pass and the file url is recomputed", () => {
  const out = sanitizeAttachments([
    { id: "a1", name: "notes.md", mime: "text/plain", size: 10, path: "docs/notes.md", url: "https://evil.example/x" },
    { id: "a2", name: "sel", mime: "text/plain", size: 5, kind: "range", path: "src/i.ts", range: [3, 9] },
    { id: "a3", name: "PR #4", mime: "text/uri-list", size: 0, kind: "url", url: "https://github.com/o/r/pull/4" },
  ], OPTS);
  assert.equal(out.length, 3);
  assert.equal(out[0]?.kind, "file");
  // caller-supplied URL for a file kind never survives into the log
  assert.equal(out[0]?.url, "/api/files/raw?projectId=p1&path=docs%2Fnotes.md");
  assert.deepEqual(out[1]?.range, [3, 9]);
  assert.equal(out[2]?.url, "https://github.com/o/r/pull/4");
});

test("sanitizeAttachments: typed rejections", () => {
  const bad = (refs: unknown, re: RegExp) => {
    assert.throws(() => sanitizeAttachments(refs, OPTS), (err: Error & { code?: string }) => {
      assert.equal(err.code, "invalid-input");
      assert.match(err.message, re);
      return true;
    });
  };
  bad("nope", /must be an array/);
  bad([{ id: "x", name: "a", mime: "text/plain", size: 1, path: "../etc/passwd" }], /path invalid/);
  bad([{ id: "x", name: "a", mime: "text/plain", size: 1, path: "/etc/passwd" }], /path invalid/);
  bad([{ id: "x", name: "a", mime: "text/plain", size: 1, kind: "url", url: "ftp://files.example/x" }], /http/);
  bad([{ id: "x", name: "a", mime: "text/plain", size: 1, kind: "url", url: "javascript:alert(1)" }], /http/);
  bad([{ id: "x", name: "a", mime: "text/plain", size: OPTS.maxBytes + 1, path: "big.bin" }], /too large/);
  bad([{ id: "x", name: "a", mime: "not a mime", size: 1, path: "f.txt" }], /mime/);
  bad([{ id: "x", name: "a", mime: "text/plain", size: 1, kind: "blob", path: "f.txt" }], /kind/);
  bad([{ id: "x", name: "a", mime: "text/plain", size: 1, kind: "range", path: "f.txt", range: [0, 4] }], /range/);
  bad(Array.from({ length: 17 }, (_, i) => ({ id: `i${i}`, name: "a", mime: "text/plain", size: 1, path: "f.txt" })), /too many/);
});

// ---------------------------------------------------------------- send path

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const started: CanonicalTurnRequest[] = [];
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const rt: AgentRuntime = {
    capabilities: async () => ({ streaming: true, permissions: true, questions: true, compaction: false, subagents: false, steering: true }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => {
      started.push(req);
      emit(req.sessionId, { type: "turn/started", turnId: `t${started.length}` });
    },
    steer: async () => true,
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return { rt, emit, started };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function makeService(
  fake: ReturnType<typeof fakeRuntime>,
  opts: { withWorktree?: boolean; filesFor?: (projectId: string | null) => Promise<FileService> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-att-send-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "notes.md"), "hello attachments");
  // A linked worktree lives outside the project root — the exact shape that
  // strands a hero-composer `_inbox/*` upload written at the project root.
  const worktree = mkdtempSync(join(tmpdir(), "polyth-att-wt-"));
  const store = createStore(join(dir, "s.db"));
  const files = createFileService();
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = { evaluate: () => "allow", addRule: () => {}, rules: () => [] } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => fake.rt },
    ...(opts.withWorktree
      ? { worktrees: { list: async () => [{ path: worktree, branch: "wt" }] } }
      : {}),
    attachments: createAttachmentSourceService(opts.filesFor ?? (async () => files)),
  });
  return { sessions, store, dir, worktree, files };
}

const fileRef = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "a1", name: "notes.md", mime: "text/plain", size: 1, kind: "file", path: "docs/notes.md", ...over,
});

test("send persists attachments in user/message before the runtime sees them", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  await sessions.send(id, { text: "look", attachments: [fileRef(), { id: "u1", name: "PR #4", mime: "text/uri-list", size: 0, kind: "url", url: "https://github.com/o/r/pull/4" }] });
  await flush();

  // durable log first: user/message carries sanitized refs with disk-true size
  const evs = await store.events(id);
  const um = evs.find((e) => e.type === "user/message");
  assert.ok(um, "user/message appended");
  const logged = (um!.data as { attachments?: AttachmentRef[] }).attachments;
  assert.equal(logged?.length, 2);
  assert.equal(logged?.[0]?.size, "hello attachments".length);
  assert.equal(logged?.[0]?.url, "/api/files/raw?projectId=p1&path=docs%2Fnotes.md");

  // runtime received the same refs on startTurn
  assert.equal(fake.started.length, 1);
  assert.equal(fake.started[0]?.attachments?.length, 2);
  assert.equal(fake.started[0]?.attachments?.[0]?.path, "docs/notes.md");

  // replay: model history keeps the file parts
  const msgs = deriveMessages(evs);
  const files = msgs[0]!.parts.filter((p) => p.type === "file");
  assert.equal(files.length, 2);
  await store.close();
});

test("deleted files refuse attachment; nothing reaches the log", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  await assert.rejects(
    sessions.send(id, { text: "gone", attachments: [fileRef({ path: "docs/deleted.md" })] }),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "invalid-input");
      assert.match(err.message, /could not be prepared/);
      return true;
    },
  );
  const evs = await store.events(id);
  assert.ok(!evs.some((e) => e.type === "user/message"));
  assert.equal(fake.started.length, 0);
  await store.close();
});

test("queued attachments survive dispatch; steer with attachments falls back to queue", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  await sessions.send(id, { text: "first" });
  await flush();

  // active turn + steer + attachments → queued with a fallback reason
  const res = await sessions.send(id, { text: "with file", delivery: "steer", attachments: [fileRef()] });
  assert.ok(res.queued);
  const reasons = (await store.events(id))
    .filter((e) => e.type === "delivery/fallback-queued")
    .map((e) => (e.data as { reason?: string }).reason);
  assert.deepEqual(reasons, ["steer-attachments"]);

  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.equal(fake.started.length, 2);
  assert.equal(fake.started[1]?.attachments?.[0]?.path, "docs/notes.md");
  const ums = (await store.events(id)).filter((e) => e.type === "user/message");
  assert.equal((ums[1]?.data as { attachments?: AttachmentRef[] }).attachments?.length, 1);
  await store.close();
});

// -------------------------------------------- _inbox materialization (F2 bug)

/** Simulate the hero/new-session composer: the file is uploaded before a
 *  session exists, so it lands under `_inbox/` at the PROJECT ROOT. */
function stageInbox(dir: string, name: string, body: string): string {
  const rel = `_inbox/${Date.now().toString(36)}-${name}`;
  mkdirSync(join(dir, "_inbox"), { recursive: true });
  writeFileSync(join(dir, rel), body);
  return rel;
}

const inboxRef = (rel: string, over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "in1", name: rel.split("/").pop()!, mime: "text/plain", size: 1, kind: "file", path: rel, ...over,
});

test("_inbox upload is materialized into the session worktree on first send", async () => {
  const fake = fakeRuntime();
  const { sessions, store, dir, worktree } = makeService(fake, { withWorktree: true });
  const body = "pasted from the hero composer";
  const rel = stageInbox(dir, "note.txt", body);

  const { id } = await sessions.create({ projectId: "p1", title: "T", worktreePath: worktree });
  // No artificial delay: send immediately, exactly as the real repro.
  await sessions.send(id, { text: "look", attachments: [inboxRef(rel)] });
  await flush();

  assert.equal(fake.started.length, 1, "send succeeded and the turn started");
  assert.equal(statSync(join(worktree, rel)).size, body.length, "bytes copied into the worktree");
  const um = (await store.events(id)).find((e) => e.type === "user/message");
  assert.equal((um!.data as { attachments?: AttachmentRef[] }).attachments?.[0]?.size, body.length);
  await store.close();
});

test("_inbox pasted-context upload is materialized the same way", async () => {
  const fake = fakeRuntime();
  const { sessions, store, dir, worktree } = makeService(fake, { withWorktree: true });
  const body = "x".repeat(4096);
  const rel = stageInbox(dir, "pasted-context.txt", body);

  const { id } = await sessions.create({ projectId: "p1", title: "T", worktreePath: worktree });
  await sessions.send(id, { text: "context", attachments: [inboxRef(rel)] });
  await flush();

  assert.equal(fake.started.length, 1);
  assert.equal(statSync(join(worktree, rel)).size, body.length);
  await store.close();
});

test("two _inbox attachments in one send both materialize", async () => {
  const fake = fakeRuntime();
  const { sessions, store, dir, worktree } = makeService(fake, { withWorktree: true });
  const relA = stageInbox(dir, "a.txt", "aaa");
  const relB = stageInbox(dir, "b.txt", "bbbb");

  const { id } = await sessions.create({ projectId: "p1", title: "T", worktreePath: worktree });
  await sessions.send(id, {
    text: "both",
    attachments: [inboxRef(relA, { id: "a" }), inboxRef(relB, { id: "b" })],
  });
  await flush();

  assert.equal(fake.started.length, 1);
  assert.equal(statSync(join(worktree, relA)).size, 3);
  assert.equal(statSync(join(worktree, relB)).size, 4);
  await store.close();
});

test("_inbox on the main workspace (no worktree) needs no copy", async () => {
  const fake = fakeRuntime();
  const { sessions, store, dir } = makeService(fake);
  const body = "main workspace staging";
  const rel = stageInbox(dir, "note.txt", body);

  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "look", attachments: [inboxRef(rel)] });
  await flush();

  assert.equal(fake.started.length, 1);
  assert.equal(fake.started[0]?.attachments?.[0]?.path, rel);
  const um = (await store.events(id)).find((e) => e.type === "user/message");
  assert.equal((um!.data as { attachments?: AttachmentRef[] }).attachments?.[0]?.size, body.length);
  await store.close();
});

test("missing _inbox source → typed error with no path or _inbox in the message", async () => {
  const fake = fakeRuntime();
  const { sessions, store, worktree } = makeService(fake, { withWorktree: true });
  const { id } = await sessions.create({ projectId: "p1", title: "T", worktreePath: worktree });

  await assert.rejects(
    sessions.send(id, {
      text: "gone",
      attachments: [inboxRef("_inbox/deadbeef-secret-brief.txt", { name: "secret-brief.txt" })],
    }),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, "invalid-input");
      assert.ok(!err.message.includes("_inbox"), "no _inbox in message");
      assert.ok(!err.message.includes("deadbeef-secret-brief"), "no rel path in message");
      assert.match(err.message, /secret-brief\.txt/, "display name is present");
      return true;
    },
  );
  assert.equal(fake.started.length, 0);
  assert.ok(!(await store.events(id)).some((e) => e.type === "user/message"));
  await store.close();
});

test("remote/SSH project routes _inbox materialize through the remote FileService", async () => {
  const fake = fakeRuntime();
  // Stand-in for the remote host: a FileService rooted anywhere, wrapped so we
  // can assert every read/write for the staged file went through it (not local
  // disk). No SSH harness needed — filesFor is the seam that picks the store.
  const remoteImpl = createFileService();
  const calls: string[] = [];
  const remote: FileService = new Proxy(remoteImpl, {
    get(target, prop: string) {
      const value = (target as unknown as Record<string, unknown>)[prop];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const { sessions, store, dir, worktree } = makeService(fake, {
    withWorktree: true,
    filesFor: async () => remote,
  });
  const body = "remote staged bytes";
  const rel = stageInbox(dir, "note.txt", body);

  const { id } = await sessions.create({ projectId: "p1", title: "T", worktreePath: worktree });
  await sessions.send(id, { text: "look", attachments: [inboxRef(rel)] });
  await flush();

  assert.equal(fake.started.length, 1);
  assert.ok(calls.includes("readRaw") && calls.includes("writeBytes"), "copy went through the remote FileService");
  assert.equal(statSync(join(worktree, rel)).size, body.length);
  await store.close();
});

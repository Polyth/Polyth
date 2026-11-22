import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject, ToolExecutionContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createWaitPackage, waitInstruction } from "../src/serverEntry.ts";
import { createWaitManager, MAX_PENDING_PER_CHAT, uuidFromHash } from "../src/manager.ts";
import type { WaitConditionProvider } from "../src/index.ts";

interface Rig {
  host: ServerPackageHost;
  dir: string;
  project: string;
  sent: Array<{ sessionId: string; text: string; id: string | undefined; via: string | undefined }>;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  holds: string[];
  releases: string[];
  state: { status: string; failSends: number; projectId: string; remote: boolean; notified: number };
  ctx(over?: Partial<ToolExecutionContext>): ToolExecutionContext;
  cleanup(): void;
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "wait-test-"));
  const project = join(dir, "project");
  mkdirSync(project);
  const r = {
    dir, project, sent: [], events: [], holds: [], releases: [],
    state: { status: "idle", failSends: 0, projectId: "p1", remote: false, notified: 0 },
  } as unknown as Rig;
  const space = (spaceId: string, userId = "system") => ({ spaceId, userId, role: "member" });
  r.host = {
    pluginId: "wait",
    spaceStorage: (ctx: { spaceId: string }) => ({ packageDir: (id: string) => join(dir, "spaces", ctx.spaceId, id) }),
    systemSpaceContext: (spaceId: string) => space(spaceId),
    personSpaceContext: (userId: string, spaceId: string) => space(spaceId, userId),
    forSpace: () => ({
      sessions: {
        async send(sessionId: string, input: { text: string; clientOperationId?: string }, opts: { author?: { via?: string } }) {
          if (r.state.failSends > 0) { r.state.failSends -= 1; throw new Error("send failed"); }
          r.sent.push({ sessionId, text: input.text, id: input.clientOperationId, via: opts.author?.via });
          return {};
        },
      },
    }),
    projects: {
      get: async () => ({ id: "p1", path: project, spaceId: "s1", ...(r.state.remote ? { remote: { kind: "ssh", connectionId: "c" } } : {}) }),
      list: async () => [{ id: "p1", path: project, spaceId: "s1" }],
    },
    sessions: {
      holdRuntime: (sessionId: string, holdId: string) => { r.holds.push(`${sessionId}:${holdId}`); },
      releaseRuntimeHold: (sessionId: string, holdId: string) => { r.releases.push(`${sessionId}:${holdId}`); },
    },
    store: {
      projection: async (sessionId: string) => sessionId === "gone" ? null : { projectId: r.state.projectId, spaceId: "s1", status: r.state.status },
    },
    events: { append: async (_id: string, type: string, data: Record<string, unknown>) => { r.events.push({ type, data }); } },
    services: { get: () => ({ notify: () => { r.state.notified += 1; } }), provide: () => undefined },
  } as unknown as ServerPackageHost;
  r.ctx = (over = {}) => ({ sessionId: "c1", projectId: "p1", cwd: project, spaceId: "s1", actorUserId: "u1", ...over });
  r.cleanup = () => rmSync(dir, { recursive: true, force: true });
  return r;
}

const until = async (check: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("a pid wait wakes exactly once with outcome exited, and holds then releases the runtime", async () => {
  const r = rig();
  const manager = createWaitManager({ host: r.host, tickMs: 50 });
  try {
    const child = spawn("sleep", ["0.3"], { stdio: "ignore", cwd: r.ctx().cwd });
    const answer = await manager.runTool({ pid: child.pid!, note: "read the log" }, r.ctx());
    const id = /id (w_\w+)/.exec(answer)![1]!;
    assert.match(answer, /End your turn now; do not poll/);
    assert.deepEqual(r.holds, [`c1:${id}`]);
    await until(() => r.sent.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(r.sent.length, 1);
    assert.match(r.sent[0]!.text, /has exited; its exit status is not known/);
    assert.match(r.sent[0]!.text, /Your note: read the log\nContinue your task\.$/);
    assert.equal(r.sent[0]!.via, "schedule");
    assert.equal(r.sent[0]!.id, uuidFromHash(`polyth-wait:${id}`));
    assert.match(r.sent[0]!.id!, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(manager.records("s1")[0]!.outcome, "exited");
    assert.deepEqual(r.releases, [`c1:${id}`]);
    assert.deepEqual(r.events.map((e) => e.type), ["wait/started", "wait/ended"]);
  } finally { manager.dispose(); r.cleanup(); }
});

test("an unknown, reused-looking or invalid pid is rejected at start", async () => {
  const r = rig();
  const manager = createWaitManager({ host: r.host });
  try {
    await assert.rejects(manager.runTool({ pid: 4194000 }, r.ctx()), /No process with pid/);
    await assert.rejects(manager.runTool({ pid: 1 }, r.ctx()), /greater than 1/);
    await assert.rejects(manager.runTool({ pid: process.pid }, r.ctx()), /server itself/);
    await assert.rejects(manager.runTool({ pid: 12, file: "x" }, r.ctx()), /exactly one/);
  } finally { manager.dispose(); r.cleanup(); }
});

test("a file wait wakes once the file exists; escapes and symlinks out are refused", async () => {
  const r = rig();
  const manager = createWaitManager({ host: r.host, tickMs: 50 });
  try {
    await manager.runTool({ file: ".polyth-wait/build.exit" }, r.ctx());
    mkdirSync(join(r.project, ".polyth-wait"));
    writeFileSync(join(r.project, ".polyth-wait", "build.exit"), "0\n");
    await until(() => r.sent.length > 0);
    assert.match(r.sent[0]!.text, /now exists \(2 bytes, modified \d{4}-/);
    assert.doesNotMatch(r.sent[0]!.text, /^0$/m);
    await assert.rejects(manager.runTool({ file: "../../../../../../../../etc/passwd" }, r.ctx()), /outside this chat's workspace/);
    await assert.rejects(manager.runTool({ file: "/etc/passwd" }, r.ctx()), /outside/);
    const outside = mkdtempSync("/var/tmp/wait-outside-");
    try {
      symlinkSync(outside, join(r.project, "link"));
      await assert.rejects(manager.runTool({ file: "link/secret.txt" }, r.ctx()), /outside/);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { manager.dispose(); r.cleanup(); }
});

test("seconds elapses and a deadline times out", async () => {
  const r = rig();
  let t = 1_000_000;
  const manager = createWaitManager({ host: r.host, now: () => t, tickMs: 3_600_000 });
  try {
    await manager.runTool({ seconds: 30 }, r.ctx());
    await manager.runTool({ file: "never.txt", timeoutMinutes: 5, note: "retry" }, r.ctx());
    await manager.tick();
    assert.equal(r.sent.length, 0);
    t += 31_000;
    await manager.tick();
    assert.match(r.sent[0]!.text, /timer elapsed/);
    t += 5 * 60_000;
    await manager.tick();
    assert.equal(r.sent.length, 2);
    assert.match(r.sent[1]!.text, /still not done after 5 minutes; the wait has ended/);
    assert.deepEqual(manager.records("s1").map((row) => row.outcome), ["elapsed", "timed-out"]);
    assert.equal(r.releases.length, 1);
  } finally { manager.dispose(); r.cleanup(); }
});

test("cancel and list act on this chat only, and the limits hold", async () => {
  const r = rig();
  const manager = createWaitManager({ host: r.host, tickMs: 3_600_000 });
  try {
    const first = await manager.runTool({ seconds: 600 }, r.ctx());
    const id = /id (w_\w+)/.exec(first)![1]!;
    assert.match(await manager.runTool({ action: "list" }, r.ctx()), new RegExp(id));
    assert.match(await manager.runTool({ action: "list" }, r.ctx({ sessionId: "c2" })), /no pending waits/);
    await assert.rejects(manager.runTool({ action: "cancel", id }, r.ctx({ sessionId: "c2" })), /no pending wait with that id/);
    for (let i = 1; i < MAX_PENDING_PER_CHAT; i++) await manager.runTool({ seconds: 600 }, r.ctx());
    await assert.rejects(manager.runTool({ seconds: 600 }, r.ctx()), /already has 8 pending waits/);
    assert.match(await manager.runTool({ action: "cancel", id }, r.ctx()), /Cancelled/);
    await manager.runTool({ seconds: 600 }, r.ctx());
    await assert.rejects(manager.runTool({ seconds: 5 }, r.ctx({ actorUserId: undefined })), /acts for no one/);
    await assert.rejects(manager.runTool({ seconds: 5 }, r.ctx({ projectId: "other" })), /not available/);
  } finally { manager.dispose(); r.cleanup(); }
});

test("a remote workspace refuses pid and file but allows seconds", async () => {
  const r = rig();
  r.state.remote = true;
  const manager = createWaitManager({ host: r.host, tickMs: 3_600_000 });
  try {
    await assert.rejects(manager.runTool({ file: "a" }, r.ctx()), /remote host/);
    await assert.rejects(manager.runTool({ pid: 5000 }, r.ctx()), /remote host/);
    assert.match(await manager.runTool({ seconds: 5 }, r.ctx()), /Waiting for 5 seconds/);
    assert.deepEqual(r.holds, []);
  } finally { manager.dispose(); r.cleanup(); }
});

test("restart: a firing record re-sends the same operation id; a gone pid fires as exited", async () => {
  const r = rig();
  const first = createWaitManager({ host: r.host, tickMs: 3_600_000 });
  r.state.failSends = 1;
  let id = "";
  try {
    id = /id (w_\w+)/.exec(await first.runTool({ seconds: 1 }, r.ctx()))![1]!;
    // Backdate through the clock seam of a second manager instead.
  } finally { first.dispose(); }
  let t = Date.now() + 2000;
  const second = createWaitManager({ host: r.host, now: () => t, tickMs: 3_600_000 });
  try {
    await second.resume();
    await second.tick();
    assert.equal(r.sent.length, 0, "first send failed");
    assert.equal(second.records("s1")[0]!.state, "firing");
    const third = createWaitManager({ host: r.host, now: () => t, tickMs: 3_600_000 });
    try {
      await third.resume();
      await third.tick();
      assert.equal(r.sent.length, 1);
      assert.equal(r.sent[0]!.id, uuidFromHash(`polyth-wait:${id}`));
      assert.equal(third.records("s1")[0]!.state, "done");
    } finally { third.dispose(); }

    const child = spawn("sleep", ["30"], { stdio: "ignore", cwd: r.ctx().cwd });
    const answer = await second.runTool({ pid: child.pid! }, r.ctx());
    const pidId = /id (w_\w+)/.exec(answer)![1]!;
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const restarted = createWaitManager({ host: r.host, now: () => t, tickMs: 3_600_000 });
    try {
      await restarted.resume();
      await restarted.tick();
      const row = restarted.records("s1").find((x) => x.id === pidId)!;
      assert.equal(row.outcome, "exited");
      assert.match(r.sent.at(-1)!.text, /Polyth restarted while you waited, so its exit status is unknown/);
      assert.ok(r.holds.filter((h) => h === `c1:${pidId}`).length >= 2, "hold re-applied on resume");
    } finally { restarted.dispose(); }
  } finally { second.dispose(); r.cleanup(); }
});

test("an archived or moved chat cancels the wait without a wake", async () => {
  const r = rig();
  let t = 5_000_000;
  const manager = createWaitManager({ host: r.host, now: () => t, tickMs: 3_600_000 });
  try {
    await manager.runTool({ seconds: 10 }, r.ctx());
    r.state.status = "archived";
    t += 20_000;
    await manager.tick();
    assert.equal(r.sent.length, 0);
    assert.equal(manager.records("s1")[0]!.state, "cancelled");
    r.state.status = "idle";
    await manager.runTool({ seconds: 10 }, r.ctx());
    r.state.projectId = "p2";
    t += 20_000;
    await manager.tick();
    assert.equal(r.sent.length, 0);
  } finally { manager.dispose(); r.cleanup(); }
});

test("ten failed sends mark the wait wake-failed and notify", async () => {
  const r = rig();
  let t = 9_000_000;
  const manager = createWaitManager({ host: r.host, now: () => t, tickMs: 3_600_000 });
  r.state.failSends = 100;
  try {
    await manager.runTool({ seconds: 1 }, r.ctx());
    for (let i = 0; i < 12; i++) { t += 20 * 60_000; await manager.tick(); }
    const row = manager.records("s1")[0]!;
    assert.equal(row.state, "done");
    assert.equal(row.outcome, "wake-failed");
    assert.equal(r.state.notified, 1);
    assert.equal(r.sent.length, 0);
  } finally { manager.dispose(); r.cleanup(); }
});

test("a registered provider drives a custom kind; without one the start is refused", async () => {
  const r = rig();
  let t = 20_000_000;
  const manager = createWaitManager({ host: r.host, now: () => t, tickMs: 3_600_000 });
  try {
    await assert.rejects(manager.runTool({ github_run: { id: 5 } }, r.ctx()), /GitHub support is not available/);
    let finished = false;
    const provider: WaitConditionProvider = {
      kind: "github_run", intervalMs: 5000,
      async start(input: JsonObject) { return { label: `run #${input.id}`, target: { id: input.id as number } }; },
      async poll() { return finished ? { done: true, outcome: "completed", text: "The run finished." } : { done: false }; },
    };
    const registration = manager.register(provider);
    await manager.runTool({ github_run: { id: 5 } }, r.ctx());
    await manager.tick();
    assert.equal(r.sent.length, 0);
    finished = true;
    t += 6000;
    await manager.tick();
    assert.equal(r.sent.length, 1);
    assert.match(r.sent[0]!.text, /The run finished\./);
    assert.equal(manager.records("s1")[0]!.outcome, "completed");
    registration.dispose();
  } finally { manager.dispose(); r.cleanup(); }
});

test("the package registers the tool, skill and instruction and disposes them", async () => {
  const r = rig();
  const registered: Array<{ owner: string; id: string; kind: string; trust?: string; mutating?: boolean }> = [];
  let disposed = 0;
  const provided: string[] = [];
  (r.host.services as unknown as { get: unknown }).get = () => ({
    register: (owner: string, c: { descriptor: { id: string; kind: string; trust?: string; mutating?: boolean } }) => {
      registered.push({ owner, id: c.descriptor.id, kind: c.descriptor.kind, trust: c.descriptor.trust, mutating: c.descriptor.mutating });
      return { dispose: () => { disposed += 1; } };
    },
  });
  (r.host.services as unknown as { provide: unknown }).provide = (key: { id?: string }) => { provided.push(String(key?.id ?? key)); };
  const pkg = createWaitPackage(r.host, { tickMs: 3_600_000 });
  assert.equal(provided.length, 1, "wait.conditions is published at load time");
  try {
    await pkg.onEnable?.();
    assert.deepEqual(registered.map((c) => c.kind).sort(), ["instruction", "skill", "tool"]);
    assert.equal(registered.find((c) => c.kind === "tool")!.mutating, true);
    assert.match(waitInstruction.descriptor.text, /register polyth_wait before ending the turn/);
    await pkg.onDisable?.();
    assert.equal(disposed, 3);
  } finally { r.cleanup(); }
});

test("a process started outside the chat's workspace cannot be waited on, nor its command line read", { skip: process.platform !== "linux" }, async () => {
  const r = rig();
  const manager = createWaitManager({ host: r.host, tickMs: 3_600_000 });
  const child = spawn("sleep", ["5"], { stdio: "ignore", cwd: "/" });
  try {
    await assert.rejects(manager.runTool({ pid: child.pid! }, r.ctx()), /not started from this chat's workspace/);
    assert.equal(manager.records("s1").length, 0);
  } finally {
    child.kill("SIGKILL");
    manager.dispose();
    r.cleanup();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import type { SpaceContext } from "@polyth/contracts";
import { normalizeActionInput, type CustomActionDto } from "../src/actionModel.ts";
import { createRunManager, type RunTerminals, type StartChatInput } from "../src/runManager.ts";

const space = (userId = "u1", spaceId = "s1"): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId,
  role: "owner",
  deployment: "local-trusted",
  storageDir: `/tmp/${spaceId}`,
});

const action = (patch: Record<string, unknown> = {}): CustomActionDto => ({
  id: String(patch.id ?? "a1"),
  ...normalizeActionInput({ name: "Run tests", command: "npm test", ...patch }),
  createdAt: 1,
  updatedAt: 1,
});

interface FakeTerminal {
  id: string;
  input: Parameters<RunTerminals["create"]>[0];
  closed: boolean;
}

function fakeTerminals(options: { exitOnClose?: boolean; failClose?: boolean; failCreate?: string; emitEarly?: string } = {}) {
  const dataListeners = new Set<(id: string, data: string) => void>();
  const exitListeners = new Set<(id: string, code: number | null) => void>();
  const created: FakeTerminal[] = [];
  let next = 0;
  const terminals: RunTerminals = {
    async create(input) {
      if (options.failCreate) throw Object.assign(new Error(options.failCreate), { code: "forbidden" });
      const id = `t${++next}`;
      created.push({ id, input, closed: false });
      // Output that arrives before the id is known must not be lost.
      if (options.emitEarly) for (const listener of dataListeners) listener(id, options.emitEarly);
      return { id };
    },
    async close(id) {
      if (options.failClose) throw Object.assign(new Error("not confirmed"), { code: "outcome-unknown" });
      const terminal = created.find((item) => item.id === id);
      if (terminal && !terminal.closed) {
        terminal.closed = true;
        if (options.exitOnClose !== false) for (const listener of exitListeners) listener(id, null);
      }
    },
    onData(cb) { dataListeners.add(cb); return { dispose: () => dataListeners.delete(cb) }; },
    onExit(cb) { exitListeners.add(cb); return { dispose: () => exitListeners.delete(cb) }; },
  };
  return {
    terminals,
    created,
    emit: (id: string, data: string) => { for (const listener of dataListeners) listener(id, data); },
    exit: (id: string, code: number | null) => { for (const listener of exitListeners) listener(id, code); },
    listeners: () => dataListeners.size + exitListeners.size,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a background run captures output incrementally and finishes with the exit code", async () => {
  const fake = fakeTerminals();
  let clock = 100;
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => "never", now: () => clock, id: () => "r1" });
  const { run, joined } = await runs.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  assert.equal(joined, false);
  assert.equal(run.status, "running");
  assert.deepEqual(fake.created[0]!.input, { projectId: "p1", cwd: "/repo", cmd: "npm test", cols: 140, rows: 40, hidden: true });

  fake.emit("t1", "hello ");
  fake.emit("other", "not mine");
  fake.emit("t1", "world\n");
  const first = runs.output(space(), "r1", 0);
  assert.equal(first.text, "hello world\n");
  assert.equal(first.command, "npm test");
  fake.emit("t1", "more");
  const delta = runs.output(space(), "r1", first.end);
  assert.deepEqual({ start: delta.start, text: delta.text }, { start: 12, text: "more" });

  clock = 2_100;
  fake.exit("t1", 0);
  const [done] = runs.list(space());
  assert.equal(done!.status, "succeeded");
  assert.equal(done!.exitCode, 0);
  assert.equal(done!.finishedAt, 2_100);
  assert.equal(done!.phase, "done");
  assert.equal(fake.created[0]!.closed, true, "the exited process's boundary is released");

  const failing = createRunManager({ terminals: () => fake.terminals, startChat: async () => "never" });
  const started = await failing.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  fake.exit(fake.created.at(-1)!.id, 2);
  assert.equal(failing.list(space()).find((item) => item.id === started.run.id)!.status, "failed");
});

test("a second press joins the running instance instead of starting another", async () => {
  const fake = fakeTerminals();
  let ids = 0;
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => "x", id: () => `r${++ids}` });
  const first = await runs.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  const again = await runs.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  assert.equal(again.joined, true);
  assert.equal(again.run.id, first.run.id);
  assert.equal(fake.created.length, 1);
  // The same action in another project is a separate run.
  const other = await runs.start({ space: space(), action: action(), projectId: "p2", sessionId: null, cwd: "/repo2" });
  assert.equal(other.joined, false);
  assert.equal(fake.created.length, 2);
});

test("runs are private to the person and Space that started them", async () => {
  const fake = fakeTerminals();
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => "x", id: () => "r1" });
  await runs.start({ space: space("u1"), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  assert.equal(runs.list(space("u2")).length, 0);
  assert.equal(runs.list(space("u1", "s2")).length, 0);
  assert.throws(() => runs.output(space("u2"), "r1", 0), { code: "not-found" });
  await assert.rejects(runs.stop(space("u1", "s2"), "r1"), { code: "not-found" });
});

test("stop ends the process and reports it as stopped", async () => {
  const fake = fakeTerminals();
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => "x", id: () => "r1" });
  await runs.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  const stopped = await runs.stop(space(), "r1");
  assert.equal(stopped.status, "stopped");
  assert.equal(fake.created[0]!.closed, true);
});

test("an unconfirmed stop keeps the run honest instead of pretending it ended", async () => {
  const fake = fakeTerminals({ failClose: true });
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => "x", id: () => "r1" });
  await runs.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  await assert.rejects(runs.stop(space(), "r1"), { code: "unavailable" });
  assert.equal(runs.list(space())[0]!.status, "running");
});

test("the time limit stops a run, and an unconfirmed stop is reported as such", async () => {
  const fake = fakeTerminals();
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => "x", id: () => "r1", timeoutMs: 5 });
  await runs.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs.list(space())[0]!.status, "timed-out");

  const stuck = fakeTerminals({ failClose: true });
  const stuckRuns = createRunManager({ terminals: () => stuck.terminals, startChat: async () => "x", id: () => "r2", timeoutMs: 5 });
  await stuckRuns.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [run] = stuckRuns.list(space());
  assert.equal(run!.status, "error");
  assert.match(run!.error ?? "", /may still be running/);
});

test("output that arrives before the terminal id is known is kept", async () => {
  const fake = fakeTerminals({ emitEarly: "early bytes\n" });
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => "x", id: () => "r1" });
  await runs.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  assert.equal(runs.output(space(), "r1", 0).text, "early bytes\n");
});

test("the output buffer keeps the end of long logs and marks the cut", async () => {
  const fake = fakeTerminals();
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => "x", id: () => "r1", outputLimit: 1_000 });
  await runs.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  fake.emit("t1", "a".repeat(900));
  fake.emit("t1", "b".repeat(300));
  const output = runs.output(space(), "r1", 0);
  assert.equal(output.start, 200, "the client learns where the retained text begins");
  assert.equal(output.end, 1_200);
  assert.equal(output.text.length, 1_000);
  assert.equal(output.run.truncated, true);
  assert.equal(runs.output(space(), "r1", 5_000).text, "");
});

test("a run that cannot start reports why", async () => {
  const fake = fakeTerminals({ failCreate: "Polyth agent beta is read-only" });
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => "x", id: () => "r1" });
  const { run } = await runs.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  assert.equal(run.status, "error");
  assert.equal(run.error, "Polyth agent beta is read-only");
  const missing = createRunManager({ terminals: () => undefined, startChat: async () => "x" });
  await assert.rejects(missing.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" }), { code: "unavailable" });
  await assert.rejects(missing.start({ space: space(), action: action({ mode: "terminal" }), projectId: "p1", sessionId: null, cwd: "/repo" }), { code: "invalid-input" });
});

test("concurrency is bounded per person", async () => {
  const fake = fakeTerminals();
  let ids = 0;
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => "x", id: () => `r${++ids}`, maxRunning: 2 });
  await runs.start({ space: space(), action: action({ id: "a1" }), projectId: "p1", sessionId: null, cwd: "/repo" });
  await runs.start({ space: space(), action: action({ id: "a2" }), projectId: "p1", sessionId: null, cwd: "/repo" });
  await assert.rejects(
    runs.start({ space: space(), action: action({ id: "a3" }), projectId: "p1", sessionId: null, cwd: "/repo" }),
    { code: "resource-limit", status: 429 },
  );
  await runs.start({ space: space("u2"), action: action({ id: "a3" }), projectId: "p1", sessionId: null, cwd: "/repo" });
});

test("a chat run hands the result to a new chat after the command ends", async () => {
  const fake = fakeTerminals();
  const chats: StartChatInput[] = [];
  const runs = createRunManager({
    terminals: () => fake.terminals,
    startChat: async (input) => { chats.push(input); return "chat-1"; },
    id: () => "r1",
  });
  const chatAction = action({
    mode: "chat",
    chat: { harnessId: "codex", model: { providerID: "openai", modelID: "gpt" }, prompt: "Fix it.", when: "failure" },
  });
  await runs.start({ space: space(), action: chatAction, projectId: "p1", sessionId: "s-ctx", cwd: "/repo" });
  fake.emit("t1", "1 failed\n");
  fake.exit("t1", 1);
  assert.equal(runs.list(space())[0]!.phase, "chat");
  await settle();
  const [run] = runs.list(space());
  assert.equal(run!.status, "succeeded");
  assert.equal(run!.chatSessionId, "chat-1");
  assert.equal(run!.exitCode, 1, "the command's own result stays visible");
  assert.equal(chats.length, 1);
  assert.equal(chats[0]!.contextSessionId, "s-ctx");
  assert.equal(chats[0]!.projectId, "p1");
  assert.deepEqual(chats[0]!.chat.model, { providerID: "openai", modelID: "gpt" });
  assert.ok(chats[0]!.text.startsWith("Fix it.\n\nResult of the custom action \"Run tests\" (exit code 1"));
  assert.match(chats[0]!.text, /1 failed/);
});

test("the chat condition can skip the hand-off", async () => {
  const fake = fakeTerminals();
  let chats = 0;
  let ids = 0;
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => { chats += 1; return "c"; }, id: () => `r${++ids}` });
  await runs.start({ space: space(), action: action({ id: "a1", mode: "chat", chat: { when: "failure" } }), projectId: "p1", sessionId: null, cwd: "/repo" });
  fake.exit("t1", 0);
  await runs.start({ space: space(), action: action({ id: "a2", mode: "chat", chat: { when: "success" } }), projectId: "p1", sessionId: null, cwd: "/repo" });
  fake.exit("t2", 3);
  await settle();
  assert.equal(chats, 0);
  const byAction = new Map(runs.list(space()).map((run) => [run.actionId, run]));
  assert.equal(byAction.get("a1")!.chatSkipped, true);
  assert.equal(byAction.get("a1")!.status, "succeeded");
  assert.equal(byAction.get("a2")!.chatSkipped, true);
  // A stopped command never starts a chat.
  await runs.start({ space: space(), action: action({ id: "a3", mode: "chat" }), projectId: "p1", sessionId: null, cwd: "/repo" });
  await runs.stop(space(), "r3");
  await settle();
  assert.equal(chats, 0);
  assert.equal(runs.list(space()).find((run) => run.id === "r3")!.status, "stopped");
});

test("a chat whose message was not confirmed keeps its id and is never resent", async () => {
  const fake = fakeTerminals();
  let attempts = 0;
  const runs = createRunManager({
    terminals: () => fake.terminals,
    startChat: async () => {
      attempts += 1;
      throw Object.assign(new Error("runtime unavailable"), { sessionId: "chat-partial" });
    },
    id: () => "r1",
  });
  await runs.start({ space: space(), action: action({ mode: "chat" }), projectId: "p1", sessionId: null, cwd: "/repo" });
  fake.exit("t1", 0);
  await settle();
  const [run] = runs.list(space());
  assert.equal(attempts, 1);
  assert.equal(run!.status, "error");
  assert.equal(run!.chatSessionId, "chat-partial");
  assert.match(run!.error ?? "", /The chat could not be started: runtime unavailable/);
});

test("disposing stops running commands and detaches from the terminal service", async () => {
  const fake = fakeTerminals();
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => "x", id: () => "r1" });
  await runs.start({ space: space(), action: action(), projectId: "p1", sessionId: null, cwd: "/repo" });
  assert.equal(fake.listeners(), 2);
  await runs.dispose();
  assert.equal(fake.created[0]!.closed, true);
  assert.equal(fake.listeners(), 0);
});

test("finished runs are forgotten after the retention window", async () => {
  const fake = fakeTerminals();
  let clock = 0;
  let ids = 0;
  const runs = createRunManager({ terminals: () => fake.terminals, startChat: async () => "x", now: () => clock, id: () => `r${++ids}`, retentionMs: 1_000, keepFinished: 1 });
  await runs.start({ space: space(), action: action({ id: "a1" }), projectId: "p1", sessionId: null, cwd: "/repo" });
  clock = 10;
  fake.exit("t1", 0);
  await runs.start({ space: space(), action: action({ id: "a2" }), projectId: "p1", sessionId: null, cwd: "/repo" });
  clock = 20;
  fake.exit("t2", 0);
  assert.deepEqual(runs.list(space()).map((run) => run.id), ["r2"], "only the newest finished run is kept");
  clock = 5_000;
  assert.deepEqual(runs.list(space()), []);
});

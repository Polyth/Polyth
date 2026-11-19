import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntime, RuntimeEndpoint, RuntimeEvent } from "@polyth/contracts";
import { createBackgroundShells, shellDescription } from "../src/backgroundShells.ts";
import { createOpenCodeRuntimeFacade } from "../src/index.ts";

const info = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: "running", command: "npm run build", cwd: "/w", shell: "bash", file: `/tmp/${id}.log`,
  metadata: { sessionID: "ses_1" }, time: { started: 1 }, ...over,
});

const harness = (admitted = false) => {
  const events: Array<[string, RuntimeEvent]> = [];
  const state = { admitted };
  const woke: string[] = [];
  const shells = createBackgroundShells({
    canonicalOf: (id) => (id === "ses_1" ? "canon-1" : undefined),
    turnAdmitted: () => state.admitted,
    emit: (canonical, event) => { events.push([canonical, event]); },
    onWake: (_c, id) => { woke.push(id); },
  });
  return { shells, events, state, woke };
};
const types = (events: Array<[string, RuntimeEvent]>) => events.map(([, e]) => e.type);

test("a background shell is published with a one-line bounded description and removed when it exits", () => {
  const { shells, events } = harness(true);
  shells.created(info("sh_a", { command: `echo ${"x".repeat(300)}\nsecond line` }));
  const first = events[0]![1] as Extract<RuntimeEvent, { type: "runtime/background-tasks" }>;
  assert.equal(first.tasks.length, 1);
  assert.equal(first.tasks[0]!.kind, "shell");
  assert.ok(first.tasks[0]!.description!.length <= 200);
  assert.ok(!first.tasks[0]!.description!.includes("\n"));
  shells.exited({ id: "sh_a", status: "exited", exit: 0 });
  const last = events.at(-1)![1] as Extract<RuntimeEvent, { type: "runtime/background-tasks" }>;
  assert.deepEqual(last.tasks, []);
  assert.equal(shellDescription("a\n b"), "a b");
});

test("shells of unmapped sessions, other commands and non-running rows are not tracked", () => {
  const { shells, events } = harness();
  shells.created(info("sh_x", { metadata: { sessionID: "ses_other" } }));
  shells.created(info("sh_y", { metadata: {} }));
  shells.created(info("sh_z", { status: "exited" }));
  assert.equal(events.length, 0);
  assert.equal(shells.size(), 0);
});

test("exit with no admitted turn requests one wake carrying command, status, exit code and output file", () => {
  const { shells, events, woke } = harness(false);
  shells.created(info("sh_a"));
  shells.exited({ id: "sh_a", status: "exited", exit: 2 });
  shells.exited({ id: "sh_a", status: "exited", exit: 2 });
  const wakes = events.map(([, e]) => e).filter((e) => e.type === "runtime/wake-requested") as Array<Extract<RuntimeEvent, { type: "runtime/wake-requested" }>>;
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.wakeId, "opencode-shell:sh_a");
  assert.equal(wakes[0]!.reason, "background-task");
  for (const part of ["npm run build", "Status: exited", "Exit code: 2", "/tmp/sh_a.log"]) assert.ok(wakes[0]!.text.includes(part), part);
  assert.deepEqual(woke, ["sh_a"]);
});

test("exit inside an admitted turn only updates the set", () => {
  const { shells, events } = harness(true);
  shells.created(info("sh_a"));
  shells.exited({ id: "sh_a", status: "exited", exit: 0 });
  assert.deepEqual(types(events), ["runtime/background-tasks", "runtime/background-tasks"]);
});

test("reconcile drops missing shells as lost, adopts missed ones and settles ones that exited unseen", () => {
  const { shells, events } = harness(false);
  shells.created(info("sh_gone"));
  shells.created(info("sh_done"));
  events.length = 0;
  shells.reconcile([info("sh_done", { status: "exited", exit: 0 }), info("sh_new")]);
  const bg = events.map(([, e]) => e).filter((e) => e.type === "runtime/background-tasks") as Array<Extract<RuntimeEvent, { type: "runtime/background-tasks" }>>;
  assert.deepEqual(bg[0]!.lost!.map((t) => t.id), ["sh_gone"]);
  assert.ok(events.some(([, e]) => e.type === "runtime/wake-requested"));
  assert.deepEqual(bg.at(-1)!.tasks.map((t) => t.id), ["sh_new"]);
});

test("a new server generation loses the shells; the same generation (a mere reconnect) does not", () => {
  const { shells, events } = harness();
  shells.generation("auth\u00001");
  shells.created(info("sh_a"));
  events.length = 0;
  shells.generation("auth\u00001");
  assert.equal(events.length, 0);
  shells.generation("auth\u00002");
  const e = events[0]![1] as Extract<RuntimeEvent, { type: "runtime/background-tasks" }>;
  assert.deepEqual(e.tasks, []);
  assert.deepEqual(e.lost!.map((t) => t.id), ["sh_a"]);
});

test("a killed shell removed by the user is dropped without a wake", () => {
  const { shells, events } = harness();
  shells.created(info("sh_a"));
  shells.deleted("sh_a");
  assert.ok(!events.some(([, e]) => e.type === "runtime/wake-requested"));
  assert.equal(shells.size(), 0);
});

// Facade wiring: shell events arrive on the V2 stream with no session id of
// their own and must neither be dropped as unmapped nor reach history.
test("facade turns V2 shell events into background-tasks and a wake, and stops OpenCode's own loop", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "a", continuity: "verified", generation: 1, url: "http://127.0.0.1:1",
    location: { directory: "/w" }, control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" }, authentication: { kind: "none" },
  };
  let push!: (data: unknown) => void;
  let opened!: () => void;
  const aborts: string[] = [];
  const listing: { rows: unknown[] } = { rows: [info("sh_a")] };
  const lifecycle = {
    control: endpoint.control,
    async endpoint() { return endpoint; },
    async protocol() { return "v2"; },
    async usingProtocol(op: (p: unknown, e: RuntimeEndpoint) => Promise<unknown>) {
      return op({ shells: async () => listing.rows }, endpoint);
    },
    async abort(binding: { backendSessionId?: string }) { aborts.push(binding.backendSessionId ?? ""); return { kind: "confirmed", value: {} }; },
    async streamEvents(o: { signal: AbortSignal; onOpen(): void; onEvent(x: unknown): void }) {
      push = (data) => o.onEvent({ authorityId: "a", generation: 1, location: endpoint.location, value: { data } });
      o.onOpen();
      opened();
      await new Promise<void>((resolve) => o.signal.addEventListener("abort", () => resolve()));
    },
    async reconcile() { throw new Error("unused"); },
    async dispose() {},
  };
  const map = new Map([["canon-1", "ses_1"]]);
  const got: RuntimeEvent[] = [];
  const openedP = new Promise<void>((r) => { opened = r; });
  const facade = createOpenCodeRuntimeFacade({
    cwd: "/w", lifecycle: lifecycle as never, sessionIdMap: map, log: () => undefined,
  }) as AgentRuntime;
  facade.onEvent((_s, ev) => { got.push(ev); });
  await openedP;
  await new Promise((r) => setTimeout(r, 20));
  // Reconcile at connect adopted the listed shell.
  assert.deepEqual((got.find((e) => e.type === "runtime/background-tasks") as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id), ["sh_a"]);
  push({ type: "shell.exited", data: { id: "sh_a", status: "exited", exit: 0 } });
  assert.equal(got.filter((e) => e.type === "runtime/wake-requested").length, 1);
  // OpenCode's own notification loop: refused and interrupted, never emitted.
  const before = got.length;
  push({ type: "session.status", data: { sessionID: "ses_1", status: { type: "busy" } } });
  push({ type: "session.step.started", data: { sessionID: "ses_1", assistantMessageID: "msg_1" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, before);
  assert.ok(aborts.includes("ses_1"));
  await facade.dispose();
});

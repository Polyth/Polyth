import assert from "node:assert/strict";
import { test } from "node:test";
import type { DelegatedIsolationDto, QueueItemDto, SessionProjection, SessionService, UserTurnInput } from "@polyth/contracts";
import {
  createServerServiceRegistry,
  SERVER_SESSION_ISOLATION,
  SERVER_TURN_STOPPED_BUS,
  type ServerPackageHost,
  type ServerSessionIsolationService,
  type ServerTurnStoppedEvent,
} from "@polyth/plugins";
import { delegationNextStep, registerDelegationMergeReminder } from "../src/delegationMerge.ts";

const child = (id: string, overrides: Partial<DelegatedIsolationDto> = {}): DelegatedIsolationDto => ({
  sessionId: id,
  title: `Worker ${id}`,
  status: "idle",
  state: "merge-ready",
  hasChanges: true,
  revision: `${id}-r1`,
  worktreePath: `/repo-polyth-isolate/${id}`,
  worktreeBranch: `polyth/isolate/${id}`,
  targetBranch: "polyth/isolate/parent",
  ...overrides,
});

function harness() {
  const listeners = new Set<(event: ServerTurnStoppedEvent) => void | Promise<void>>();
  const services = createServerServiceRegistry();
  services.provide(SERVER_TURN_STOPPED_BUS, {
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  });
  const pending = new Map<string, DelegatedIsolationDto[]>();
  const scans: string[] = [];
  services.provide(SERVER_SESSION_ISOLATION, {
    async delegatedChildren(parentSessionId: string) {
      scans.push(parentSessionId);
      return pending.get(parentSessionId) ?? [];
    },
  } as unknown as ServerSessionIsolationService);
  const statuses = new Map<string, SessionProjection["status"]>();
  const sends: Array<{ sessionId: string; input: UserTurnInput }> = [];
  // Mirrors the canonical send path: with `queueing` on (a turn is being
  // admitted), a normal send waits in the queue under its client operation id.
  const queue = new Map<string, QueueItemDto[]>();
  const queueing = new Set<string>();
  const removed: string[] = [];
  const sessions = {
    async snapshot(id: string) {
      return { id, projectId: "p1", title: id, status: statuses.get(id) ?? "idle", createdAt: 1, updatedAt: 1 };
    },
    async send(sessionId: string, input: UserTurnInput) {
      sends.push({ sessionId, input });
      if (!queueing.has(sessionId)) return {};
      const id = input.clientOperationId ?? `q${sends.length}`;
      const rows = queue.get(sessionId) ?? [];
      if (!rows.some((row) => row.id === id)) {
        rows.push({
          id, sessionId, position: rows.length, text: input.text, delivery: "normal", createdAt: 1,
          ...(input.hiddenUserMessage ? { hiddenUserMessage: true } : {}),
        });
      }
      queue.set(sessionId, rows);
      return { queueId: id, queued: true };
    },
    async queueList(sessionId: string) {
      return [...(queue.get(sessionId) ?? [])];
    },
    async queueRemove(sessionId: string, queueId: string) {
      const rows = queue.get(sessionId) ?? [];
      if (!rows.some((row) => row.id === queueId)) throw Object.assign(new Error("queue item not found"), { code: "not-found" });
      queue.set(sessionId, rows.filter((row) => row.id !== queueId));
      removed.push(queueId);
    },
  } as unknown as SessionService;
  const host = { services, sessions } as unknown as ServerPackageHost;
  const reminder = registerDelegationMergeReminder(host);
  const stop = async (sessionId: string, reason: ServerTurnStoppedEvent["reason"] = "completed") => {
    for (const listener of [...listeners]) await listener({ sessionId, reason });
  };
  return { reminder, pending, scans, statuses, sends, stop, listeners, queue, queueing, removed };
}

test("a completed turn with settled unmerged isolated children wakes the delegator once per pending state", async () => {
  const h = harness();
  h.pending.set("parent", [child("a"), child("b", { hasChanges: false, state: "active" })]);
  await h.stop("parent");
  assert.equal(h.sends.length, 1);
  const [first] = h.sends;
  assert.equal(first!.sessionId, "parent");
  assert.equal(first!.input.hiddenUserMessage, true);
  assert.equal(first!.input.delivery, "normal");
  assert.match(first!.input.text, /Worker a/);
  assert.match(first!.input.text, /agent\.merge/);
  assert.match(first!.input.text, /no changes: agent\.merge releases its worktree/);
  assert.match(first!.input.clientOperationId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  // Unchanged pending state replays the same canonical operation (deduped by
  // the session service); new child work earns a new reminder.
  await h.stop("parent");
  assert.equal(h.sends[1]!.input.clientOperationId, first!.input.clientOperationId);
  h.pending.set("parent", [child("a", { revision: "a-r2" }), child("b", { hasChanges: false, state: "active" })]);
  await h.stop("parent");
  assert.notEqual(h.sends[2]!.input.clientOperationId, first!.input.clientOperationId);
  await h.reminder.dispose();
  assert.equal(h.listeners.size, 0);
});

test("no reminder while a child still runs, after an aborted or failed turn, or when the delegator is busy again", async () => {
  const h = harness();
  h.pending.set("parent", [child("a"), child("b", { status: "working", hasChanges: false, revision: "" })]);
  await h.stop("parent");
  await h.stop("parent", "aborted");
  await h.stop("parent", "error");
  h.pending.set("parent", [child("a")]);
  h.statuses.set("parent", "working");
  await h.stop("parent");
  assert.equal(h.sends.length, 0);
  h.statuses.set("parent", "idle");
  await h.stop("parent");
  assert.equal(h.sends.length, 1);
  await h.reminder.dispose();
});

test("sessions that never delegated in isolation are scanned once, until they delegate", async () => {
  const h = harness();
  await h.stop("plain");
  await h.stop("plain");
  assert.deepEqual(h.scans, ["plain"]);
  h.reminder.noteDelegation("plain");
  h.pending.set("plain", [child("c")]);
  await h.stop("plain");
  assert.deepEqual(h.scans, ["plain", "plain"]);
  assert.equal(h.sends.length, 1);
  await h.reminder.dispose();
});

test("a reminder queued behind a turn that merges its children is withdrawn before it is delivered", async () => {
  // 2026-11-27: the parent's turn stopped with its child settled and
  // unmerged while the child's watch wake was already being admitted, so the
  // reminder queued behind it. That turn merged the child, and the queue then
  // delivered the stale reminder as a new server turn.
  const h = harness();
  h.pending.set("parent", [child("c11")]);
  h.queueing.add("parent");
  await h.stop("parent");
  const queued = h.queue.get("parent") ?? [];
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.id, h.sends[0]!.input.clientOperationId);

  // The woken turn merges the child (agent.merge revalidates).
  h.pending.set("parent", []);
  await h.reminder.revalidate("parent");
  assert.deepEqual(h.queue.get("parent"), [], "the stale reminder never reaches the parent");
  assert.deepEqual(h.removed, [queued[0]!.id]);

  // Its turn ends with nothing unmerged: no new reminder either.
  h.queueing.delete("parent");
  await h.stop("parent");
  assert.equal(h.sends.length, 1);
  await h.reminder.dispose();
});

test("a queued reminder that still holds is kept; one listing a merged sibling is replaced by a fresh one", async () => {
  const h = harness();
  h.pending.set("parent", [child("a"), child("b")]);
  h.queueing.add("parent");
  await h.stop("parent");
  await h.reminder.revalidate("parent");
  assert.equal(h.queue.get("parent")?.length, 1, "unchanged state keeps the queued reminder");
  assert.deepEqual(h.removed, []);

  // Only "a" is merged: the queued list is wrong, and the turn's own end
  // sends one naming just "b".
  h.pending.set("parent", [child("b")]);
  await h.reminder.revalidate("parent");
  assert.equal(h.queue.get("parent")?.length, 0);
  h.queueing.delete("parent");
  await h.stop("parent");
  assert.equal(h.sends.length, 2);
  assert.doesNotMatch(h.sends[1]!.input.text, /Worker a/);
  assert.match(h.sends[1]!.input.text, /Worker b/);
  assert.notEqual(h.sends[1]!.input.clientOperationId, h.sends[0]!.input.clientOperationId);
  await h.reminder.dispose();
});

test("any later turn stop withdraws a queued reminder that went stale outside agent.merge", async () => {
  const h = harness();
  h.pending.set("parent", [child("a")]);
  h.queueing.add("parent");
  await h.stop("parent");
  assert.equal(h.queue.get("parent")?.length, 1);
  // The child was merged elsewhere (its isolation card) and the turn ahead
  // of the reminder was aborted.
  h.pending.set("parent", []);
  await h.stop("parent", "aborted");
  assert.equal(h.queue.get("parent")?.length, 0);
  assert.equal(h.sends.length, 1);
  await h.reminder.dispose();
});

test("a withdrawn reminder whose state returns is sent again instead of replaying the withdrawn operation", async () => {
  const h = harness();
  h.pending.set("parent", [child("a")]);
  h.queueing.add("parent");
  await h.stop("parent");
  const first = h.sends[0]!.input.clientOperationId;
  // The delegator sends the child more work: running, so the queued list is wrong.
  h.pending.set("parent", [child("a", { status: "working" })]);
  await h.reminder.revalidate("parent");
  assert.deepEqual(h.removed, [first]);
  // It finishes without changing anything: the same state as before.
  h.queueing.delete("parent");
  h.pending.set("parent", [child("a")]);
  await h.stop("parent");
  assert.equal(h.sends.length, 2);
  assert.notEqual(h.sends[1]!.input.clientOperationId, first, "a fresh operation, not a replay of the withdrawn one");
  await h.stop("parent");
  assert.equal(h.sends[2]!.input.clientOperationId, h.sends[1]!.input.clientOperationId, "repeats still dedupe");
  await h.reminder.dispose();
});

test("next steps name the right action for each delegated state", () => {
  assert.match(delegationNextStep(child("x", { state: "conflict" })), /agent\.resolve/);
  assert.match(delegationNextStep(child("x", { state: "cleanup-pending", hasChanges: false })), /resumes/);
  assert.match(delegationNextStep(child("x", { status: "archived" })), /session\.restore/);
  assert.match(delegationNextStep(child("x", { state: "missing" })), /report it/);
  assert.match(delegationNextStep(child("x", { status: "waiting" })), /still running/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DelegatedIsolationDto, SessionProjection, SessionService, UserTurnInput } from "@polyth/contracts";
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
  const sessions = {
    async snapshot(id: string) {
      return { id, projectId: "p1", title: id, status: statuses.get(id) ?? "idle", createdAt: 1, updatedAt: 1 };
    },
    async send(sessionId: string, input: UserTurnInput) {
      sends.push({ sessionId, input });
      return {};
    },
  } as unknown as SessionService;
  const host = { services, sessions } as unknown as ServerPackageHost;
  const reminder = registerDelegationMergeReminder(host);
  const stop = async (sessionId: string, reason: ServerTurnStoppedEvent["reason"] = "completed") => {
    for (const listener of [...listeners]) await listener({ sessionId, reason });
  };
  return { reminder, pending, scans, statuses, sends, stop, listeners };
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

test("next steps name the right action for each delegated state", () => {
  assert.match(delegationNextStep(child("x", { state: "conflict" })), /agent\.resolve/);
  assert.match(delegationNextStep(child("x", { state: "cleanup-pending", hasChanges: false })), /resumes/);
  assert.match(delegationNextStep(child("x", { status: "archived" })), /session\.restore/);
  assert.match(delegationNextStep(child("x", { state: "missing" })), /report it/);
  assert.match(delegationNextStep(child("x", { status: "waiting" })), /still running/);
});

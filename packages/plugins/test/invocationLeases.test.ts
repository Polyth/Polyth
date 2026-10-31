import test from "node:test";
import assert from "node:assert/strict";
import { createInvocationLeaseStore } from "../src/invocationLeases.ts";

const identity = {
  packageId: "task-tools",
  spaceId: "space-a",
  generation: "install-1",
};

const messageInvocation = {
  kind: "message-action" as const,
  contributionId: "create-task",
  projectId: "project-a",
  sessionId: "session-a",
  message: {
    id: "message-42",
    role: "assistant" as const,
    text: "Ship the release",
  },
};

test("invocation leases bind package, Space, generation, and invocation id", () => {
  const store = createInvocationLeaseStore();
  const invocation = store.issue(identity, messageInvocation);

  const record = store.authorize({
    ...identity,
    invocationId: invocation.invocationId,
    lease: invocation.lease,
  });
  assert.equal(record.messageId, "message-42");
  assert.equal(record.sessionId, "session-a");

  assert.throws(() => store.authorize({
    ...identity,
    packageId: "other-package",
    invocationId: invocation.invocationId,
    lease: invocation.lease,
  }), /another package/);
  assert.throws(() => store.authorize({
    ...identity,
    spaceId: "space-b",
    invocationId: invocation.invocationId,
    lease: invocation.lease,
  }), /another Space/);
  assert.throws(() => store.authorize({
    ...identity,
    generation: "install-2",
    invocationId: invocation.invocationId,
    lease: invocation.lease,
  }), /obsolete package generation/);
  assert.throws(() => store.authorize({
    ...identity,
    invocationId: "different-invocation",
    lease: invocation.lease,
  }), /does not match/);
});

test("completion consumes a lease and blocks replay", () => {
  const store = createInvocationLeaseStore();
  const invocation = store.issue(identity, messageInvocation);
  const completion = {
    invocationId: invocation.invocationId,
    lease: invocation.lease,
    ok: true,
  };

  const completed = store.complete(identity, completion);
  assert.equal(completed.contributionId, "create-task");
  assert.equal(store.size(), 0);
  assert.throws(() => store.complete(identity, completion), /expired or no longer active/);
});

test("expired and revoked leases fail closed", () => {
  let now = 1_000;
  const store = createInvocationLeaseStore({ now: () => now, ttlMs: 1_000 });
  const first = store.issue(identity, messageInvocation);
  now = 2_001;
  assert.throws(() => store.authorize({
    ...identity,
    invocationId: first.invocationId,
    lease: first.lease,
  }), /expired or no longer active/);

  now = 3_000;
  const second = store.issue(identity, messageInvocation);
  store.revokePackage(identity.packageId);
  assert.throws(() => store.authorize({
    ...identity,
    invocationId: second.invocationId,
    lease: second.lease,
  }), /expired or no longer active/);
});

test("lease store bounds active invocations and payload bytes", () => {
  const store = createInvocationLeaseStore();
  assert.throws(() => store.issue(identity, {
    ...messageInvocation,
    message: { ...messageInvocation.message, text: "x".repeat(70 * 1024) },
  }), /size limit/);

  for (let index = 0; index < 256; index++) {
    store.issue(identity, {
      ...messageInvocation,
      contributionId: `action-${index}`,
      message: { ...messageInvocation.message, id: `message-${index}` },
    });
  }
  assert.equal(store.size(), 256);
  assert.throws(() => store.issue(identity, messageInvocation), /too many active/);
});

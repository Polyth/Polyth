import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_MUTATION_EVENT_TYPES,
  CANONICAL_RECONCILIATION_EVENT_TYPES,
} from "@polyth/contracts";
import type {
  BorrowedRuntimeEndpointLease,
  DurableOperation,
  MutationOutcome,
  OpenCodeTransport,
  OwnedRuntimeEndpointLease,
  ProtocolAdapter,
  RuntimeEndpoint,
  RuntimeSnapshot,
  SessionProjection,
} from "@polyth/contracts";

test("canonical hardening vocabulary is protocol-neutral and ignorable", () => {
  assert.deepEqual([...CANONICAL_MUTATION_EVENT_TYPES], [
    "mutation/prepared",
    "mutation/claimed",
    "mutation/confirmed",
    "mutation/rejected",
    "mutation/uncertainty-recorded",
    "mutation/nonapplication-confirmed",
    "mutation/fenced",
  ]);
  assert.deepEqual([...CANONICAL_RECONCILIATION_EVENT_TYPES], [
    "reconciliation/started",
    "reconciliation/completed",
    "reconciliation/blocked",
  ]);
  for (const name of [
    ...CANONICAL_MUTATION_EVENT_TYPES,
    ...CANONICAL_RECONCILIATION_EVENT_TYPES,
  ]) {
    assert.match(name, /^[a-z-]+\/[a-z-]+$/);
  }
});

test("owned and borrowed endpoint leases have distinct runtime control", async () => {
  const ownedEndpoint: RuntimeEndpoint = {
    authorityId: "authority-a",
    continuity: "verified",
    generation: 3,
    url: "http://runtime.invalid",
    location: { directory: "/workspace/project", workspace: "worktree-a" },
    control: { kind: "owned", instanceToken: "instance-token" },
    config: { kind: "writable", targetId: "local-config" },
    authentication: {
      kind: "basic-env",
      usernameEnv: "RUNTIME_USERNAME",
      passwordEnv: "RUNTIME_PASSWORD",
    },
  };
  const owned: OwnedRuntimeEndpointLease = {
    control: ownedEndpoint.control,
    async endpoint() { return ownedEndpoint; },
    async refresh() { return ownedEndpoint; },
    async restart() { return ownedEndpoint; },
    async dispose() {},
  };
  assert.equal((await owned.restart("manual")).control.kind, "owned");

  const borrowedEndpoint: RuntimeEndpoint = {
    ...ownedEndpoint,
    continuity: "generation-only",
    control: { kind: "borrowed", source: "shared" },
    config: { kind: "read-only" },
    authentication: { kind: "endpoint-headers", async resolve() { return {}; } },
  };
  const borrowed: BorrowedRuntimeEndpointLease = {
    control: borrowedEndpoint.control,
    async endpoint() { return borrowedEndpoint; },
    async refresh() { return borrowedEndpoint; },
    async dispose() {},
  };
  assert.equal((await borrowed.refresh("disconnect")).control.kind, "borrowed");
  assert.equal("restart" in borrowed, false);
});

test("transport, adapter, snapshot, and operation shapes expose no wire DTO", async () => {
  const transport: OpenCodeTransport = {
    async query<T>() { return { healthy: true } as T; },
    async mutate<T>(request) {
      return {
        kind: "unknown",
        operationId: request.operationId,
        message: "response unavailable",
      };
    },
    async stream() {},
  };
  const transportResult = await transport.mutate({
    method: "POST",
    path: "adapter-selected",
    operationId: "operation-a",
    deadlineMs: 1_000,
    replay: { kind: "never" },
  });
  assert.deepEqual(transportResult, {
    kind: "unknown",
    operationId: "operation-a",
    message: "response unavailable",
  });

  const snapshot: RuntimeSnapshot = {
    authorityId: "authority-a",
    generation: 1,
    location: { directory: "/workspace/project" },
    backendSessionId: "backend-a",
    reconciliationOrdinal: 2,
    state: { value: "unknown" },
    completeness: {
      events: "partial",
      permissions: "unverifiable",
      questions: "unverifiable",
    },
    permissions: [],
    questions: [],
    events: [],
  };
  const adapter: ProtocolAdapter = {
    protocol: "legacy",
    async capabilities() {
      return {
        eventReplay: "none",
        pendingSnapshot: "partial",
        idempotentMutations: new Set(),
      };
    },
    async ensureSession(_binding, operationId) {
      return {
        kind: "unknown",
        operationId,
        message: "create outcome unavailable",
      };
    },
    async submit() {
      return { kind: "rejected", code: "invalid", message: "invalid input" };
    },
    async reconcile() { return snapshot; },
  };
  const outcome: MutationOutcome<{ backendSessionId: string }> =
    await adapter.ensureSession({
      canonicalSessionId: "canonical-a",
      authorityId: "authority-a",
      generation: 1,
      continuity: "verified",
      location: { directory: "/workspace/project" },
    }, "operation-a");
  assert.equal(outcome.kind, "unknown");

  const operation: DurableOperation = {
    operationId: "operation-a",
    sessionId: "canonical-a",
    ordinal: 1,
    mutationKind: "session-create",
    state: "prepared",
    replay: { kind: "never" },
    createdAt: 1,
    updatedAt: 1,
  };
  assert.equal(operation.state, "prepared");

  const projection: SessionProjection = {
    id: "canonical-a",
    projectId: "project-a",
    title: "Recovering",
    status: "reconciling",
    createdAt: 1,
    updatedAt: 1,
  };
  assert.equal(projection.status, "reconciling");
});

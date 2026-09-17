import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  JsonObject,
  ObservationCursorKey,
  ObservationEntityKey,
  ObservationIdentity,
  PersistedRuntimeBinding,
  SessionProjection,
  SnapshotIngestionInput,
} from "@polyth/contracts";
import { createStore } from "@polyth/session";

const fresh = (prefix: string): { dir: string; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, path: join(dir, "sessions.db") };
};

test("operation claim is single-executor and crash recovery never replays an unkeyed unknown", async () => {
  const { dir, path } = fresh("polyth-operations-");
  let store = createStore(path);
  try {
    const prepared = await store.prepareOperation({
      sessionId: "session-a",
      mutationKind: "turn-submit",
      intentEvent: { type: "user/message", data: { text: "run once" } },
    });
    assert.match(prepared.operation.operationId, /^[0-9a-f-]{36}$/);
    assert.equal(prepared.operation.ordinal, 1);
    assert.equal(prepared.operation.state, "prepared");
    assert.equal(prepared.operation.replay.kind, "never");
    assert.equal(prepared.operation.ownerEventSeq, prepared.intentEvent.seq);
    assert.equal(prepared.stateEvent.type, "mutation/prepared");

    const claim = await store.claimOperation(prepared.operation.operationId);
    assert.equal(claim.kind, "claimed");
    assert.equal(claim.operation.state, "executing");
    const competingClaim = await store.claimOperation(prepared.operation.operationId);
    assert.equal(competingClaim.kind, "not-claimed");
    assert.equal(competingClaim.operation?.state, "executing");

    await store.close();
    store = createStore(path);
    const recovered = await store.operation(prepared.operation.operationId);
    assert.equal(recovered?.state, "unknown");
    assert.equal(recovered?.code, "process-restarted");

    const ordinaryClaim = await store.claimOperation(prepared.operation.operationId);
    assert.equal(ordinaryClaim.kind, "not-claimed");
    const forbiddenReplay = await store.replayUnknownOperation(
      prepared.operation.operationId,
      "not-pinned",
    );
    assert.equal(forbiddenReplay.kind, "not-claimed");
    assert.equal((await store.operation(prepared.operation.operationId))?.state, "unknown");

    const confirmed = await store.settleOperation(prepared.operation.operationId, {
      kind: "confirmed",
      receipt: "receipt-a",
    });
    assert.equal(confirmed.state, "confirmed");
    assert.equal(confirmed.receipt, "receipt-a");

    const local = await store.prepareOperation({
      sessionId: "session-a",
      mutationKind: "turn-abort",
      intentEvent: {
        type: "turn/abort-intended",
        data: { reason: "user-requested" },
        ignorable: true,
      },
    });
    assert.equal(local.operation.ordinal, 2);
    const rejected = await store.settleOperation(local.operation.operationId, {
      kind: "rejected",
      code: "invalid-state",
      message: "nothing is running",
    });
    assert.equal(rejected.state, "rejected");

    const events = await store.events("session-a");
    assert.ok(events.some((event) => event.type === "mutation/uncertainty-recorded"));
    assert.ok(events.every((event) => event.type.includes("/")));
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same-ID replay requires the exact pinned operation contract", async () => {
  const { dir, path } = fresh("polyth-idempotent-");
  const store = createStore(path);
  try {
    const prepared = await store.prepareOperation({
      sessionId: "session-a",
      mutationKind: "turn-submit",
      replay: { kind: "same-operation-id", contract: "prompt-id-v2-build-1" },
      intentEvent: { type: "user/message", data: { text: "idempotent" } },
    });
    assert.equal((await store.claimOperation(prepared.operation.operationId)).kind, "claimed");
    await store.settleOperation(prepared.operation.operationId, {
      kind: "unknown",
      message: "response was lost",
    });
    assert.equal(
      (await store.replayUnknownOperation(prepared.operation.operationId, "wrong-contract")).kind,
      "not-claimed",
    );
    const replay = await store.replayUnknownOperation(
      prepared.operation.operationId,
      "prompt-id-v2-build-1",
    );
    assert.equal(replay.kind, "claimed");
    assert.equal(replay.operation.operationId, prepared.operation.operationId);
    assert.equal(replay.operation.ordinal, prepared.operation.ordinal);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical session shell and prepared create commit together", async () => {
  const { dir, path } = fresh("polyth-shell-");
  let store = createStore(path);
  const projection: SessionProjection = {
    id: "session-a",
    projectId: "project-a",
    title: "New session",
    status: "reconciling",
    createdAt: 1,
    updatedAt: 1,
  };
  try {
    const prepared = await store.prepareSessionCreate({
      projection,
      createdEvent: {
        type: "session/created",
        data: { projectId: "project-a", title: "New session" },
        ignorable: true,
      },
    });
    assert.equal(prepared.operation.mutationKind, "session-create");
    assert.equal(prepared.operation.state, "prepared");
    assert.deepEqual(await store.projection("session-a"), projection);
    assert.deepEqual(
      (await store.events("session-a")).map((event) => event.type),
      ["session/created", "mutation/prepared"],
    );

    await store.close();
    store = createStore(path);
    assert.equal((await store.operation(prepared.operation.operationId))?.state, "prepared");
    assert.deepEqual(await store.projection("session-a"), projection);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observation claim, canonical events, checkpoint, and cursor are one durable transaction", async () => {
  const { dir, path } = fresh("polyth-observation-");
  let store = createStore(path);
  const identity: ObservationIdentity = {
    authorityId: "authority-a",
    generation: 1,
    location: { directory: "/workspace/project", workspace: "worktree-a" },
    backendSessionId: "backend-a",
    artifactKind: "part",
    entityId: "message-a/part-a",
    revision: "1",
  };
  const entityKey: ObservationEntityKey = {
    authorityId: identity.authorityId,
    location: identity.location,
    backendSessionId: identity.backendSessionId,
    artifactKind: identity.artifactKind,
    entityId: identity.entityId,
  };
  const cursorKey: ObservationCursorKey = {
    authorityId: identity.authorityId,
    location: identity.location,
    backendSessionId: identity.backendSessionId,
    channel: "events",
  };
  try {
    const projection: SessionProjection = {
      id: "session-a",
      projectId: "project-a",
      title: "Observation test",
      status: "reconciling",
      backendSessionId: identity.backendSessionId,
      runtimeBinding: {
        backendSessionId: identity.backendSessionId,
        authorityId: identity.authorityId,
        generation: identity.generation,
        continuity: "verified",
        protocol: "legacy",
        location: identity.location,
      },
      createdAt: 1,
      updatedAt: 1,
    };
    await store.upsertProjection(projection);
    const firstReconciliation = await store.startReconciliation("session-a");
    const applied = await store.ingestObservation({
      sessionId: "session-a",
      identity,
      reconciliationOrdinal: firstReconciliation.ordinal,
      events: [{
        type: "assistant/message",
        data: { partId: "part-a", text: "hello" },
      }],
      checkpoint: { value: { text: "hello" } },
      cursor: { key: cursorKey, after: "cursor-1" },
    });
    assert.equal(applied.kind, "applied");
    assert.equal(applied.events.length, 1);
    assert.equal((await store.observationCheckpoint(entityKey))?.revision, "1");
    assert.deepEqual((await store.observationCheckpoint(entityKey))?.value, { text: "hello" });
    assert.equal(await store.observationCursor(cursorKey), "cursor-1");

    await store.settleReconciliation(
      "session-a",
      firstReconciliation.ordinal,
      "ready",
    );
    await store.upsertProjection({
      ...projection,
      runtimeBinding: {
        ...projection.runtimeBinding!,
        generation: 2,
      },
      updatedAt: 2,
    });
    const secondReconciliation = await store.startReconciliation("session-a");
    await assert.rejects(
      () => store.ingestObservation({
        sessionId: "session-a",
        identity,
        reconciliationOrdinal: secondReconciliation.ordinal,
        events: [],
      }),
      (error: Error & { code?: string }) => error.code === "stale-evidence",
    );
    await assert.rejects(
      () => store.ingestObservation({
        sessionId: "session-a",
        identity: { ...identity, generation: 2, revision: "stale-ordinal" },
        reconciliationOrdinal: firstReconciliation.ordinal,
        events: [],
      }),
      (error: Error & { code?: string }) => error.code === "stale-evidence",
    );

    const duplicate = await store.ingestObservation({
      sessionId: "session-a",
      identity: { ...identity, generation: 2 },
      reconciliationOrdinal: secondReconciliation.ordinal,
      events: [{
        type: "assistant/message",
        data: { partId: "part-a", text: "must not duplicate" },
      }],
      checkpoint: { value: { text: "must not duplicate" } },
      cursor: { key: cursorKey, after: "cursor-2" },
    });
    assert.equal(duplicate.kind, "duplicate");
    assert.deepEqual(duplicate.events.map((event) => event.seq), applied.events.map((event) => event.seq));
    assert.equal((await store.events("session-a"))
      .filter((event) => event.type === "assistant/message").length, 1);
    assert.equal(await store.observationCursor(cursorKey), "cursor-2");

    const failingIdentity: ObservationIdentity = {
      ...identity,
      entityId: "message-a/part-b",
      revision: "1",
    };
    await assert.rejects(
      () => store.ingestObservation({
        sessionId: "session-a",
        identity: { ...failingIdentity, generation: 2 },
        reconciliationOrdinal: secondReconciliation.ordinal,
        events: [{
          type: "assistant/message",
          data: { partId: "part-b", text: "rolled back" },
        }],
        checkpoint: {
          value: { impossible: BigInt(1) } as unknown as JsonObject,
        },
        cursor: { key: cursorKey, after: "must-not-commit" },
      }),
      /BigInt/,
    );
    assert.equal((await store.events("session-a"))
      .filter((event) => event.type === "assistant/message").length, 1);
    assert.equal(await store.observationCursor(cursorKey), "cursor-2");
    assert.equal(await store.observationCheckpoint({
      ...entityKey,
      entityId: failingIdentity.entityId,
    }), undefined);

    await store.close();
    store = createStore(path);
    assert.deepEqual((await store.observationCheckpoint(entityKey))?.value, { text: "hello" });
    assert.equal(await store.observationCursor(cursorKey), "cursor-2");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("whole snapshot transaction replays every artifact after an injected rollback", async () => {
  const { dir, path } = fresh("polyth-snapshot-transaction-");
  const store = createStore(path);
  const location = { directory: "/workspace/project" };
  const cursorKey: ObservationCursorKey = {
    authorityId: "authority-snapshot",
    location,
    backendSessionId: "backend-snapshot",
    channel: "runtime",
  };
  try {
    await store.upsertProjection({
      id: "session-snapshot",
      projectId: "project-a",
      title: "Snapshot transaction",
      status: "reconciling",
      backendSessionId: "backend-snapshot",
      runtimeBinding: {
        backendSessionId: "backend-snapshot",
        authorityId: "authority-snapshot",
        generation: 3,
        continuity: "verified",
        protocol: "legacy",
        location,
      },
      createdAt: 1,
      updatedAt: 1,
    });
    const reconciliation = await store.startReconciliation("session-snapshot");
    const observations: SnapshotIngestionInput["observations"] = [
      {
        sessionId: "session-snapshot",
        identity: {
          authorityId: "authority-snapshot",
          generation: 3,
          location,
          backendSessionId: "backend-snapshot",
          artifactKind: "part",
          entityId: "part-1",
          revision: "1",
        },
        reconciliationOrdinal: reconciliation.ordinal,
        events: [{
          type: "assistant/message",
          data: { partId: "part-1", text: "first" },
        }],
        checkpoint: { value: { text: "first" } },
      },
      {
        sessionId: "session-snapshot",
        identity: {
          authorityId: "authority-snapshot",
          generation: 3,
          location,
          backendSessionId: "backend-snapshot",
          artifactKind: "part",
          entityId: "part-2",
          revision: "1",
        },
        reconciliationOrdinal: reconciliation.ordinal,
        events: [{
          type: "assistant/message",
          data: { partId: "part-2", text: "second" },
        }],
        checkpoint: {
          value: { injectedFailure: BigInt(1) } as unknown as JsonObject,
        },
        cursor: { key: cursorKey, after: "cursor-after-snapshot" },
      },
    ];
    await assert.rejects(
      () => store.ingestSnapshot({
        sessionId: "session-snapshot",
        observations,
      }),
      /BigInt/,
    );
    assert.equal((await store.events("session-snapshot"))
      .filter((event) => event.type === "assistant/message").length, 0);
    assert.equal(await store.observationCursor(cursorKey), undefined);
    assert.equal(await store.observationCheckpoint({
      authorityId: "authority-snapshot",
      location,
      backendSessionId: "backend-snapshot",
      artifactKind: "part",
      entityId: "part-1",
    }), undefined);

    observations[1]!.checkpoint = { value: { text: "second" } };
    const replay = await store.ingestSnapshot({
      sessionId: "session-snapshot",
      observations,
    });
    assert.deepEqual(replay.observations.map((result) => result.kind), ["applied", "applied"]);
    assert.deepEqual(
      (await store.events("session-snapshot"))
        .filter((event) => event.type === "assistant/message")
        .map((event) => (event.data as { text?: string }).text),
      ["first", "second"],
    );
    assert.equal(await store.observationCursor(cursorKey), "cursor-after-snapshot");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("response intent compare-and-set records one winner and reopens only after proven absence", async () => {
  const { dir, path } = fresh("polyth-response-");
  let store = createStore(path);
  try {
    await store.append("session-a", "permission/requested", {
      requestId: "permission-a",
      permission: "filesystem",
      patterns: ["src/**"],
    });
    const winner = await store.chooseResponseIntent({
      kind: "permission",
      sessionId: "session-a",
      requestId: "permission-a",
      reply: "once",
      auto: true,
    });
    const loser = await store.chooseResponseIntent({
      kind: "permission",
      sessionId: "session-a",
      requestId: "permission-a",
      reply: "reject",
    });
    assert.equal(winner.kind, "chosen");
    assert.equal(loser.kind, "existing");
    assert.equal(loser.operation.operationId, winner.operation.operationId);
    assert.deepEqual(loser.intent.payload, { reply: "once", auto: true });

    await store.claimOperation(winner.operation.operationId);
    await store.settleResponseIntent(winner.operation.operationId, {
      kind: "unknown",
      message: "response receipt was lost",
    });
    await store.close();
    store = createStore(path);
    assert.equal(
      (await store.responseIntent("session-a", "permission", "permission-a"))?.operationId,
      winner.operation.operationId,
    );

    await store.settleResponseIntent(winner.operation.operationId, {
      kind: "not-applied",
      message: "complete pending snapshot still contains the request",
    });
    assert.equal(
      await store.responseIntent("session-a", "permission", "permission-a"),
      undefined,
    );
    const next = await store.chooseResponseIntent({
      kind: "permission",
      sessionId: "session-a",
      requestId: "permission-a",
      reply: "reject",
    });
    assert.equal(next.kind, "chosen");
    assert.notEqual(next.operation.operationId, winner.operation.operationId);

    await store.append("session-a", "question/asked", {
      requestId: "question-a",
      questions: [{ prompt: "Continue?" }],
    });
    const questionWinner = await store.chooseResponseIntent({
      kind: "question",
      sessionId: "session-a",
      requestId: "question-a",
      answers: { answer: "yes" },
    });
    const questionLoser = await store.chooseResponseIntent({
      kind: "question",
      sessionId: "session-a",
      requestId: "question-a",
      answers: { answer: "no" },
    });
    assert.equal(questionWinner.kind, "chosen");
    assert.equal(questionLoser.kind, "existing");
    assert.deepEqual(questionLoser.intent.payload, { answers: { answer: "yes" } });
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deletion tombstone and unknown delete survive canonical deletion and restart", async () => {
  const { dir, path } = fresh("polyth-tombstone-");
  let store = createStore(path);
  const binding = {
    canonicalSessionId: "session-a",
    authorityId: "authority-a",
    generation: 3,
    location: { directory: "/workspace/project", workspace: "worktree-a" },
    backendSessionId: "backend-a",
  };
  try {
    await store.upsertProjection({
      id: "session-a",
      projectId: "project-a",
      title: "Delete me",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    await store.append("session-a", "session/created", { projectId: "project-a" });
    await store.enqueue("session-a", "queued", "queue");
    const prepared = await store.prepareSessionDeletion({ binding });
    assert.equal(prepared.operation.state, "prepared");
    assert.equal(await store.projection("session-a"), undefined);
    assert.deepEqual(await store.events("session-a"), []);
    assert.deepEqual(await store.queueList("session-a"), []);
    assert.equal(await store.hasDeletionTombstone(binding), true);

    const claim = await store.claimOperation(prepared.operation.operationId);
    assert.equal(claim.kind, "claimed");
    assert.equal(claim.event, undefined);
    await store.close();
    store = createStore(path);
    assert.equal((await store.operation(prepared.operation.operationId))?.state, "unknown");
    assert.deepEqual(await store.events("session-a"), []);

    await store.deleteSession("session-a");
    assert.equal((await store.deletionTombstone("session-a"))?.operationId, prepared.operation.operationId);
    assert.equal(await store.hasDeletionTombstone(binding), true);

    await assert.rejects(
      () => store.ingestObservation({
        sessionId: "different-canonical-session",
        identity: {
          authorityId: binding.authorityId,
          generation: 4,
          location: binding.location,
          backendSessionId: binding.backendSessionId,
          artifactKind: "message",
          entityId: "message-a",
          revision: "1",
        },
        reconciliationOrdinal: 1,
        events: [],
      }),
      (error: Error & { code?: string }) => error.code === "tombstoned",
    );

    await store.settleOperation(prepared.operation.operationId, { kind: "confirmed" });
    const retired = await store.retireDeletionTombstone("session-a", { kind: "confirmed" });
    assert.equal(retired.retirement?.kind, "confirmed");
    assert.equal(await store.hasDeletionTombstone(binding), false);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconciliation ordinals reject superseded completion", async () => {
  const { dir, path } = fresh("polyth-reconciliation-");
  const store = createStore(path);
  try {
    const first = await store.startReconciliation("session-a");
    const second = await store.startReconciliation("session-a");
    assert.equal(first.ordinal, 1);
    assert.equal(second.ordinal, 2);
    const stale = await store.settleReconciliation(
      "session-a",
      first.ordinal,
      "ready",
    );
    assert.equal(stale.kind, "superseded");
    assert.equal(stale.reconciliation.state, "reconciling");
    const current = await store.settleReconciliation(
      "session-a",
      second.ordinal,
      "unknown",
      "snapshot is incomplete",
    );
    assert.equal(current.kind, "accepted");
    assert.equal(current.reconciliation.state, "unknown");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const epochBinding = (
  backendSessionId: string,
  authorityId: string,
): PersistedRuntimeBinding => ({
  backendSessionId,
  authorityId,
  generation: 4,
  epoch: 0,
  continuity: "verified",
  protocol: "legacy",
  location: { directory: "/project" },
});

const epochProjection = (
  sessionId: string,
  binding: PersistedRuntimeBinding,
): SessionProjection => ({
  id: sessionId,
  projectId: "project-a",
  title: "Epoch pending ops",
  status: "epoch-pending",
  backendSessionId: binding.backendSessionId,
  runtimeBinding: binding,
  createdAt: 1,
  updatedAt: 1,
});

test("owned epoch fences executing operations so a late confirm cannot land", async () => {
  const { dir, path } = fresh("polyth-epoch-executing-owned-");
  const store = createStore(path);
  try {
    const sessionId = "session-a";
    const oldBinding = epochBinding("backend-old", "owned:destroyed");
    await store.upsertProjection(epochProjection(sessionId, oldBinding));
    const turn = await store.prepareOperation({
      sessionId,
      mutationKind: "turn-submit",
      intentEvent: { type: "user/message", data: { text: "in flight" } },
    });
    assert.equal((await store.claimOperation(turn.operation.operationId)).kind, "claimed");
    const prepared = await store.prepareOperation({
      sessionId,
      mutationKind: "permission-reply",
      intentEvent: {
        type: "permission/response-intended",
        data: { requestId: "permission-1", reply: "once" },
        ignorable: true,
      },
    });
    const reset = await store.prepareOperation({
      sessionId,
      mutationKind: "session-reset",
      intentEvent: {
        type: "session/reset-intended",
        data: { reason: "runtime-epoch" },
        ignorable: true,
      },
    });
    assert.equal((await store.claimOperation(reset.operation.operationId)).kind, "claimed");
    await store.settleOperation(reset.operation.operationId, {
      kind: "confirmed",
      receipt: "backend-new",
    });

    const replacement = {
      ...oldBinding,
      backendSessionId: "backend-new",
      authorityId: "owned:new",
      generation: 1,
      epoch: 1,
      historyBaseline: "empty" as const,
    };
    const result = await store.transitionRuntimeEpoch({
      sessionId,
      expectedBinding: oldBinding,
      replacementBinding: replacement,
      resetOperationId: reset.operation.operationId,
      reason: "owned runtime authority changed",
      fence: { mode: "destroyed", authorityId: oldBinding.authorityId, generation: oldBinding.generation },
    });

    assert.equal((await store.operation(turn.operation.operationId))?.state, "fenced");
    assert.equal((await store.operation(prepared.operation.operationId))?.state, "rejected");
    assert.equal(result.fencedOperations.length, 1);
    assert.equal(result.fencedOperations[0]?.operationId, turn.operation.operationId);
    assert.equal(result.heldQueueItems.length, 1);
    assert.equal(result.heldQueueItems[0]?.text, "in flight");
    await assert.rejects(
      () => store.settleOperation(turn.operation.operationId, {
        kind: "confirmed",
        receipt: "late-receipt",
      }),
      (error: Error & { code?: string }) => error.code === "invalid-transition",
    );
    assert.equal(
      (await store.claimOperation(turn.operation.operationId)).kind,
      "not-claimed",
    );
    assert.equal(
      (await store.replayUnknownOperation(turn.operation.operationId, "never")).kind,
      "not-claimed",
    );
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("borrowed epoch interrupts executing operations without fencing them", async () => {
  const { dir, path } = fresh("polyth-epoch-executing-borrowed-");
  const store = createStore(path);
  try {
    const sessionId = "session-b";
    const oldBinding = epochBinding("backend-old", "external:old");
    await store.upsertProjection(epochProjection(sessionId, oldBinding));
    const turn = await store.prepareOperation({
      sessionId,
      mutationKind: "turn-submit",
      intentEvent: { type: "user/message", data: { text: "borrowed in flight" } },
    });
    assert.equal((await store.claimOperation(turn.operation.operationId)).kind, "claimed");
    const prepared = await store.prepareOperation({
      sessionId,
      mutationKind: "turn-abort",
      intentEvent: {
        type: "turn/abort-intended",
        data: { reason: "user-requested" },
        ignorable: true,
      },
    });
    const reset = await store.prepareOperation({
      sessionId,
      mutationKind: "session-reset",
      intentEvent: {
        type: "session/reset-intended",
        data: { reason: "runtime-epoch" },
        ignorable: true,
      },
    });
    assert.equal((await store.claimOperation(reset.operation.operationId)).kind, "claimed");
    await store.settleOperation(reset.operation.operationId, {
      kind: "confirmed",
      receipt: "backend-new",
    });

    const result = await store.transitionRuntimeEpoch({
      sessionId,
      expectedBinding: oldBinding,
      replacementBinding: {
        ...oldBinding,
        backendSessionId: "backend-new",
        authorityId: "external:new",
        generation: 2,
        epoch: 1,
        historyBaseline: "empty",
      },
      resetOperationId: reset.operation.operationId,
      reason: "user confirmed replacement of an external runtime",
    });

    assert.deepEqual(result.fencedOperations, []);
    assert.deepEqual(result.heldQueueItems, []);
    assert.equal((await store.operation(turn.operation.operationId))?.state, "unknown");
    assert.equal((await store.operation(prepared.operation.operationId))?.state, "rejected");
    const confirmed = await store.settleOperation(turn.operation.operationId, {
      kind: "confirmed",
      receipt: "borrowed-protocol-evidence",
    });
    assert.equal(confirmed.state, "confirmed");
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fenced and rejected operations refuse every settlement and claim path", async () => {
  const { dir, path } = fresh("polyth-epoch-terminal-ops-");
  const store = createStore(path);
  try {
    const sessionId = "session-c";
    const oldBinding = epochBinding("backend-old", "owned:destroyed");
    await store.upsertProjection(epochProjection(sessionId, oldBinding));
    const turn = await store.prepareOperation({
      sessionId,
      mutationKind: "turn-submit",
      replay: { kind: "same-operation-id", contract: "turn-submit-v1" },
      intentEvent: { type: "user/message", data: { text: "fenced later" } },
    });
    await store.claimOperation(turn.operation.operationId);
    await store.settleOperation(turn.operation.operationId, {
      kind: "unknown",
      message: "lost",
    });
    const reset = await store.prepareOperation({
      sessionId,
      mutationKind: "session-reset",
      intentEvent: {
        type: "session/reset-intended",
        data: { reason: "runtime-epoch" },
        ignorable: true,
      },
    });
    await store.claimOperation(reset.operation.operationId);
    await store.settleOperation(reset.operation.operationId, {
      kind: "confirmed",
      receipt: "backend-new",
    });
    await store.transitionRuntimeEpoch({
      sessionId,
      expectedBinding: oldBinding,
      replacementBinding: {
        ...oldBinding,
        backendSessionId: "backend-new",
        authorityId: "owned:new",
        generation: 1,
        epoch: 1,
        historyBaseline: "empty",
      },
      resetOperationId: reset.operation.operationId,
      reason: "owned runtime authority changed",
      fence: { mode: "destroyed", authorityId: oldBinding.authorityId, generation: oldBinding.generation },
    });
    assert.equal((await store.operation(turn.operation.operationId))?.state, "fenced");
    await assert.rejects(
      () => store.settleOperation(turn.operation.operationId, {
        kind: "confirmed",
        receipt: "late",
      }),
      (error: Error & { code?: string }) => error.code === "invalid-transition",
    );
    await assert.rejects(
      () => store.settleOperation(turn.operation.operationId, {
        kind: "rejected",
        code: "nope",
        message: "late reject",
      }),
      (error: Error & { code?: string }) => error.code === "invalid-transition",
    );
    await assert.rejects(
      () => store.settleOperation(turn.operation.operationId, {
        kind: "unknown",
        message: "late unknown",
      }),
      (error: Error & { code?: string }) => error.code === "invalid-transition",
    );
    await assert.rejects(
      () => store.settleOperation(turn.operation.operationId, {
        kind: "not-applied",
        message: "late non-application",
      }),
      (error: Error & { code?: string }) => error.code === "invalid-transition",
    );
    assert.equal((await store.claimOperation(turn.operation.operationId)).kind, "not-claimed");
    assert.equal(
      (await store.replayUnknownOperation(turn.operation.operationId, "turn-submit-v1")).kind,
      "not-claimed",
    );
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

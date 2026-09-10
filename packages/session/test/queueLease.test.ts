import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";

test("queue reservation survives ambiguity and blocks later FIFO entries across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-queue-lease-"));
  const path = join(dir, "sessions.db");
  let store = createStore(path);
  try {
    const first = (await store.enqueue("session-a", "first", "queue")).item;
    const second = (await store.enqueue("session-a", "second", "queue")).item;

    const reserved = await store.reserveQueueHead({ sessionId: "session-a" });
    assert.equal(reserved.kind, "reserved");
    assert.equal(reserved.reservation.queueItem.id, first.id);
    assert.equal(reserved.reservation.operation.state, "prepared");
    const operationId = reserved.reservation.operation.operationId;

    const blocked = await store.reserveQueueHead({ sessionId: "session-a" });
    assert.equal(blocked.kind, "blocked");
    assert.equal(blocked.reservation.operation.operationId, operationId);
    assert.equal(blocked.reservation.queueItem.id, first.id);
    assert.equal(await store.queueRemove("session-a", first.id), false);
    await assert.rejects(
      () => store.queueReorder("session-a", [second.id, first.id]),
      (error: Error & { code?: string }) => error.code === "queue-reserved",
    );

    assert.equal((await store.claimOperation(operationId)).kind, "claimed");
    await store.settleOperation(operationId, {
      kind: "unknown",
      message: "admission response was lost",
    });
    await store.close();

    store = createStore(path);
    const afterRestart = await store.reserveQueueHead({ sessionId: "session-a" });
    assert.equal(afterRestart.kind, "blocked");
    assert.equal(afterRestart.reservation.operation.operationId, operationId);
    assert.equal(afterRestart.reservation.operation.state, "unknown");
    assert.deepEqual(
      (await store.queueList("session-a")).map((item) => item.text),
      ["first", "second"],
    );

    const confirmed = await store.confirmQueueReservation(operationId, "admission-a");
    assert.equal(confirmed.id, first.id);
    assert.deepEqual(
      (await store.queueList("session-a")).map((item) => item.text),
      ["second"],
    );
    assert.equal((await store.operation(operationId))?.state, "confirmed");
    assert.ok(
      (await store.events("session-a")).some((event) =>
        event.type === "queue/dispatched"
        && (event.data as { queueId?: string }).queueId === first.id),
    );

    const next = await store.reserveQueueHead({ sessionId: "session-a" });
    assert.equal(next.kind, "reserved");
    assert.equal(next.reservation.queueItem.id, second.id);
    assert.equal((await store.claimOperation(next.reservation.operation.operationId)).kind, "claimed");
    const released = await store.releaseQueueReservation(
      next.reservation.operation.operationId,
      {
        kind: "rejected",
        code: "not-admitted",
        message: "the runtime rejected admission",
      },
    );
    assert.equal(released.id, second.id);
    assert.deepEqual((await store.queueList("session-a")).map((item) => item.text), ["second"]);

    const retriedByNewOperation = await store.reserveQueueHead({ sessionId: "session-a" });
    assert.equal(retriedByNewOperation.kind, "reserved");
    assert.notEqual(
      retriedByNewOperation.reservation.operation.operationId,
      next.reservation.operation.operationId,
    );
    assert.equal(
      retriedByNewOperation.reservation.operation.ordinal,
      next.reservation.operation.ordinal + 1,
    );
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crash-stranded executing queue claim becomes unknown and stays reserved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-queue-crash-"));
  const path = join(dir, "sessions.db");
  let store = createStore(path);
  try {
    await store.enqueue("session-a", "first", "queue");
    await store.enqueue("session-a", "second", "queue");
    const reserved = await store.reserveQueueHead({ sessionId: "session-a" });
    assert.equal(reserved.kind, "reserved");
    const operationId = reserved.reservation.operation.operationId;
    assert.equal((await store.claimOperation(operationId)).kind, "claimed");
    await store.close();

    store = createStore(path);
    assert.equal((await store.operation(operationId))?.state, "unknown");
    const blocked = await store.reserveQueueHead({ sessionId: "session-a" });
    assert.equal(blocked.kind, "blocked");
    assert.equal(blocked.reservation.operation.operationId, operationId);
    assert.deepEqual(
      (await store.queueList("session-a")).map((item) => item.text),
      ["first", "second"],
    );

    await store.releaseQueueReservation(operationId, {
      kind: "not-applied",
      message: "complete operation lookup proves absence",
    });
    const fresh = await store.reserveQueueHead({ sessionId: "session-a" });
    assert.equal(fresh.kind, "reserved");
    assert.notEqual(fresh.reservation.operation.operationId, operationId);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

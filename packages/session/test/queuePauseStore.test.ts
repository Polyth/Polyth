import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStore } from "@polyth/session";

test("user Stop pauses automatic queue reservation across restart until a new turn starts", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "polyth-queue-pause-")), "session.db");

  {
    const store = createStore(dbPath);
    const queued = await store.enqueue("s1", "follow-up", "queue");
    await store.append("s1", "queue/enqueued", { queueId: queued.item.id });
    await store.append("s1", "turn/abort-requested", { reason: "user" });

    const paused = await store.reserveQueueHead({ sessionId: "s1" });
    assert.equal(paused.kind, "empty");
    assert.equal((await store.queueList("s1")).length, 1);
    await store.close();
  }

  {
    const store = createStore(dbPath);
    const stillPaused = await store.reserveQueueHead({ sessionId: "s1" });
    assert.equal(stillPaused.kind, "empty");

    await store.append("s1", "turn/started", {});
    const resumed = await store.reserveQueueHead({ sessionId: "s1" });
    assert.equal(resumed.kind, "reserved");
    if (resumed.kind === "reserved") {
      await store.releaseQueueReservation(resumed.reservation.operation.operationId, {
        kind: "rejected",
        code: "test-cleanup",
        message: "test cleanup",
      });
    }
    await store.close();
  }
});

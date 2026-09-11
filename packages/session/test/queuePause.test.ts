import assert from "node:assert/strict";
import test from "node:test";
import type { QueueItemDto, SessionEvent } from "@polyth/contracts";
import { queuePausedAfterUserInterrupt } from "../src/queuePause.ts";

const sessionId = "session-1";

const event = (seq: number, type: string, data: Record<string, unknown> = {}): SessionEvent => ({
  id: `event-${seq}`,
  sessionId,
  seq,
  time: seq,
  type,
  data,
}) as SessionEvent;

const item = (id: string, position = 0): QueueItemDto => ({
  id,
  sessionId,
  position,
  text: id,
  delivery: "queue",
  createdAt: position + 1,
});

test("user Stop pauses queued follow-ups that already existed", () => {
  const queued = [item("q1"), item("q2", 1)];
  const events = [
    event(1, "queue/enqueued", { queueId: "q1" }),
    event(2, "queue/enqueued", { queueId: "q2" }),
    event(3, "turn/abort-requested", { reason: "user" }),
  ];

  assert.equal(queuePausedAfterUserInterrupt(events, queued), true);
});

test("starting another turn resumes the paused queue", () => {
  const queued = [item("q1")];
  const events = [
    event(1, "queue/enqueued", { queueId: "q1" }),
    event(2, "turn/abort-requested", { reason: "user" }),
    event(3, "turn/started"),
  ];

  assert.equal(queuePausedAfterUserInterrupt(events, queued), false);
});

test("interrupt delivery does not pause queued follow-ups", () => {
  const queued = [item("q1")];
  const events = [
    event(1, "queue/enqueued", { queueId: "q1" }),
    event(2, "turn/abort-requested", { reason: "interrupt" }),
  ];

  assert.equal(queuePausedAfterUserInterrupt(events, queued), false);
});

test("a stale Stop does not pause wholly new queue work", () => {
  const queued = [item("q2")];
  const events = [
    event(1, "queue/enqueued", { queueId: "q1" }),
    event(2, "turn/abort-requested", { reason: "user" }),
    event(3, "queue/removed", { queueId: "q1" }),
    event(4, "queue/enqueued", { queueId: "q2" }),
  ];

  assert.equal(queuePausedAfterUserInterrupt(events, queued), false);
});

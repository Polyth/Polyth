import assert from "node:assert/strict";
import test from "node:test";
import type { DurableOperation, SessionEvent } from "@polyth/contracts";
import {
  admissionBlockingOperation,
  admissionBlockingOperations,
  latestConfirmedEpochResetOrdinal,
  restartRecoveredOperationIds,
  type OperationAdmissionStore,
} from "../src/operationAdmission.ts";

const operation = (ordinal: number, state: DurableOperation["state"], mutationKind = "turn-submit"): DurableOperation => ({
  operationId: `op-${ordinal}`,
  sessionId: "s1",
  ordinal,
  mutationKind,
  state,
  replayKind: "never",
  createdAt: ordinal,
  updatedAt: ordinal,
} as unknown as DurableOperation);

const event = (seq: number, type: string, data: Record<string, unknown> = {}): SessionEvent => ({
  id: `e-${seq}`,
  sessionId: "s1",
  seq,
  time: seq,
  type,
  data,
} as unknown as SessionEvent);

function fakeStore(
  operations: DurableOperation[],
  events: SessionEvent[],
  options: { indexed?: boolean; onRead?: (kind: "events" | "eventsOfTypes" | "latestSeq") => void } = {},
): OperationAdmissionStore {
  const indexed = options.indexed ?? true;
  const store: OperationAdmissionStore = {
    operations: async () => operations,
    events: async () => { options.onRead?.("events"); return events; },
    latestSeq: async () => { options.onRead?.("latestSeq"); return events.at(-1)?.seq ?? 0; },
  };
  if (indexed) {
    store.eventsOfTypes = async (_sessionId, types, afterSeq, throughSeq, limit = 500) => {
      options.onRead?.("eventsOfTypes");
      return events.filter((row) => types.includes(row.type) && row.seq > afterSeq && row.seq <= throughSeq).slice(0, limit);
    };
  }
  return store;
}

test("prepared and executing operations always block", async () => {
  const store = fakeStore([operation(1, "confirmed"), operation(2, "prepared")], []);
  assert.equal((await admissionBlockingOperation(store, "s1"))?.ordinal, 2);
});

test("an unknown outcome blocks until something supersedes it", async () => {
  const store = fakeStore([operation(1, "unknown")], [event(1, "turn/started")]);
  assert.equal((await admissionBlockingOperation(store, "s1"))?.ordinal, 1);
});

test("an unknown older than the latest confirmed epoch reset no longer gates the session", async () => {
  // Exactly the 2026-10-06 remnant shape: reset 5 unknown, resets 6 and 7 confirmed
  // and named by epoch-replaced markers.
  const operations = [
    operation(4, "confirmed"),
    operation(5, "unknown", "session-reset"),
    operation(6, "confirmed", "session-reset"),
    operation(7, "confirmed", "session-reset"),
  ];
  const events = [
    event(10, "session/reset-intended"),
    event(11, "runtime/epoch-replaced", { resetOperationId: "op-6" }),
    event(12, "runtime/epoch-replaced", { resetOperationId: "op-7" }),
  ];
  for (const indexed of [true, false]) {
    const store = fakeStore(operations, events, { indexed });
    assert.equal(await latestConfirmedEpochResetOrdinal(store, "s1"), 7, `indexed=${indexed}`);
    assert.deepEqual(await admissionBlockingOperations(store, "s1"), [], `indexed=${indexed}`);
    assert.equal(await admissionBlockingOperation(store, "s1"), undefined, `indexed=${indexed}`);
  }
});

test("an unknown newer than the last confirmed epoch reset still blocks", async () => {
  const store = fakeStore(
    [operation(6, "confirmed", "session-reset"), operation(8, "unknown")],
    [event(11, "runtime/epoch-replaced", { resetOperationId: "op-6" })],
  );
  assert.equal((await admissionBlockingOperation(store, "s1"))?.ordinal, 8);
});

test("an epoch-replaced marker naming an unconfirmed reset proves nothing", async () => {
  const store = fakeStore(
    [operation(5, "unknown"), operation(6, "unknown", "session-reset")],
    [event(11, "runtime/epoch-replaced", { resetOperationId: "op-6" })],
  );
  assert.equal(await latestConfirmedEpochResetOrdinal(store, "s1"), undefined);
  assert.equal((await admissionBlockingOperation(store, "s1"))?.ordinal, 5);
});

test("restart-recovered unknowns are exempt while other unknowns keep blocking", async () => {
  const store = fakeStore(
    [operation(3, "unknown"), operation(4, "unknown")],
    [event(9, "runtime/restart-recovered", { recoveredOperationIds: ["op-3", 42] })],
  );
  assert.deepEqual([...await restartRecoveredOperationIds(store, "s1")], ["op-3"]);
  assert.deepEqual((await admissionBlockingOperations(store, "s1")).map((row) => row.ordinal), [4]);
});

test("durable event reads happen only when an unknown operation needs evidence", async () => {
  const reads: string[] = [];
  const quiet = fakeStore([operation(1, "confirmed"), operation(2, "prepared")], [event(1, "turn/started")], { onRead: (kind) => reads.push(kind) });
  await admissionBlockingOperation(quiet, "s1");
  assert.deepEqual(reads, []);
  const uncertain = fakeStore([operation(1, "unknown")], [event(1, "turn/started")], { onRead: (kind) => reads.push(kind) });
  await admissionBlockingOperation(uncertain, "s1");
  assert.ok(reads.includes("eventsOfTypes"), "indexed type reads are used");
  assert.ok(!reads.includes("events"), "the whole log is never loaded when an indexed read exists");
});

test("indexed reads page through the whole log", async () => {
  // 600 matching rows need two 500-row pages; the naming marker sits on the second page.
  const events = Array.from({ length: 1200 }, (_, index) => index % 2 === 0
    ? event(index + 1, "runtime/epoch-replaced", { resetOperationId: index === 1150 ? "op-2" : "op-missing" })
    : event(index + 1, "assistant/message"));
  const store = fakeStore([operation(1, "unknown"), operation(2, "confirmed", "session-reset")], events);
  assert.equal(await latestConfirmedEpochResetOrdinal(store, "s1"), 2);
  assert.equal(await admissionBlockingOperation(store, "s1"), undefined);
});

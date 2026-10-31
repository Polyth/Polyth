// Real OpenCode 2.0.30 V2 streams close a turn with `session.execution.*`,
// not a legacy `session.idle`. These frames are copied from a captured live
// stream (free `opencode` provider, one prompt): a step-free answer ends with
// succeeded; a tool-using answer still ends with exactly one succeeded.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ObservationCheckpoint } from "@polyth/contracts";
import {
  admitTranslateTurn,
  asOcEvent,
  claimTerminalStateEvidence,
  createTranslateState,
  errorMessageOf,
  indexObservationCheckpoints,
  normalizeOcObservation,
  translateOcEvent,
} from "../src/events.ts";

const SESSION = "ses_live_1";

const frame = (type: string, data: Record<string, unknown>, seq: number, id = `${type}:${seq}`) => ({
  id,
  created: 1792310792394,
  type,
  data: { sessionID: SESSION, ...data },
  durable: { aggregateID: SESSION, seq, version: 1 },
});

test("R-V2-001: a real session.execution.succeeded frame is terminal evidence", () => {
  const ev = asOcEvent(frame("session.execution.succeeded", {}, 14));
  assert.ok(ev, "the V2 frame normalizes");
  assert.equal(ev.type, "session.status", "execution terminal maps to the reducer's status vocabulary");

  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1");
  assert.deepEqual(claimTerminalStateEvidence(ev, state), {
    state: "idle",
    watermark: "14",
    comparison: { domain: "legacy-status:revision", order: 14 },
  });
});

test("R-V2-002: a live V2 turn closes without any legacy session.idle frame", () => {
  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1");

  // The whole live stream: text part, step end, execution succeeded. No idle.
  const frames = [
    frame("session.text.started", { assistantMessageID: "msg_1", ordinal: 0 }, 9),
    frame("session.text.delta", { assistantMessageID: "msg_1", ordinal: 0, delta: "hello" }, 10),
    frame("session.text.ended", { assistantMessageID: "msg_1", ordinal: 0, text: "hello" }, 11),
    frame("session.step.ended", {
      assistantMessageID: "msg_1",
      finish: "stop",
      rawFinish: "stop",
      tokens: { input: 5226, output: 9, reasoning: 15, cache: { read: 1536, write: 0 } },
    }, 13),
    frame("session.execution.succeeded", {}, 14),
  ];

  let terminal: ReturnType<typeof claimTerminalStateEvidence>;
  const assistant: string[] = [];
  for (const raw of frames) {
    const ev = asOcEvent(raw);
    assert.ok(ev, `frame ${raw.type} normalizes`);
    for (const runtimeEvent of translateOcEvent(ev, state)) {
      if (runtimeEvent.type === "assistant/message") assistant.push(runtimeEvent.text);
    }
    terminal ??= claimTerminalStateEvidence(ev, state);
  }

  assert.deepEqual(assistant, ["hello"], "the answer text is finalized once");
  assert.ok(terminal, "the turn terminalizes on the execution frame");
  assert.equal(terminal.state, "idle");
});

test("R-V2-003: session.execution.failed yields a failed terminal with its error", () => {
  const ev = asOcEvent(frame("session.execution.failed", { error: { type: "provider", message: "boom" } }, 20));
  assert.ok(ev);
  assert.equal(ev.type, "session.error");
  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1");
  const evidence = claimTerminalStateEvidence(ev, state);
  assert.ok(evidence);
  assert.equal(evidence.state, "failed");
  assert.equal(errorMessageOf(ev), "boom", "the provider failure message survives normalization");
});

test("R-V2-004: session.execution.interrupted yields an interrupted terminal", () => {
  const ev = asOcEvent(frame("session.execution.interrupted", { reason: "user" }, 30));
  assert.ok(ev);
  assert.equal(ev.type, "session.status");
  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1");
  const evidence = claimTerminalStateEvidence(ev, state);
  assert.ok(evidence);
  assert.equal(evidence.state, "interrupted");
});

test("R-V2-005: successive executions terminalize on their own durable sequence", () => {
  const first = asOcEvent(frame("session.execution.succeeded", {}, 14));
  assert.ok(first);
  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1");
  assert.deepEqual(claimTerminalStateEvidence(first, state), {
    state: "idle",
    watermark: "14",
    comparison: { domain: "legacy-status:revision", order: 14 },
  });

  const next = createTranslateState();
  admitTranslateTurn(next, "turn-2");
  const second = asOcEvent(frame("session.execution.succeeded", {}, 15));
  assert.ok(second);
  assert.deepEqual(claimTerminalStateEvidence(second, next), {
    state: "idle",
    watermark: "15",
    comparison: { domain: "legacy-status:revision", order: 15 },
  });
});

test("R-V2-006: the live SSE observation path carries the same status comparison", () => {
  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1");
  const raw = frame("session.execution.succeeded", {}, 14);
  const ev = asOcEvent(raw);
  assert.ok(ev);
  const observation = {
    authorityId: "v2-live",
    generation: 1,
    location: { directory: "/workspace/project" },
    backendSessionId: SESSION,
    reconciliationOrdinal: 1,
  };
  const normalized = normalizeOcObservation({
    data: raw,
    channel: "sse",
    observed: observation,
    current: observation,
    state,
  });
  assert.equal(normalized.kind, "accepted");
  if (normalized.kind !== "accepted") assert.fail("the execution frame was not accepted");
  assert.equal(normalized.observation.identity.entityId, SESSION);
  assert.deepEqual(normalized.observation.checkpoint?.value, {
    state: "idle",
    watermark: "14",
    comparison: { domain: "legacy-status:revision", order: 14 },
  });
});

test("R-V2-007: a live step.ended records usage with the model named by step.started", () => {
  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1", { providerID: "opencode", modelID: "fallback-model" });
  const usage = [
    frame("session.step.started", { assistantMessageID: "msg_1", model: { providerID: "opencode", id: "deepseek-v4.1-flash-free" } }, 8),
    frame("session.step.ended", {
      assistantMessageID: "msg_1",
      finish: "stop",
      tokens: { input: 5226, output: 9, reasoning: 15, cache: { read: 1536, write: 0 } },
    }, 13),
  ].flatMap((raw) => translateOcEvent(asOcEvent(raw)!, state))
    .filter((event) => event.type === "usage/recorded");
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0]?.type === "usage/recorded" && usage[0].model, {
    providerID: "opencode",
    modelID: "deepseek-v4.1-flash-free",
  });
});

test("R-V2-008: a step.ended without a named model falls back to the admitted turn model", () => {
  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1", { providerID: "opencode", modelID: "deepseek-v4.1-flash-free", variant: "max" });
  const ev = asOcEvent(frame("session.step.ended", {
    assistantMessageID: "msg_1",
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  }, 13));
  assert.ok(ev);
  const usage = translateOcEvent(ev, state).find((event) => event.type === "usage/recorded");
  assert.deepEqual(usage?.type === "usage/recorded" && usage.model, {
    providerID: "opencode",
    modelID: "deepseek-v4.1-flash-free",
  });
});

test("R-V2-009: pull reconstruction does not re-record usage of a message completed live", () => {
  const binding = {
    authorityId: "v2-live",
    generation: 1,
    location: { directory: "/workspace/project" },
    backendSessionId: SESSION,
    reconciliationOrdinal: 2,
  };
  const pulled = {
    type: "message.updated",
    properties: {
      sessionID: SESSION,
      info: {
        id: "msg_1",
        role: "assistant",
        sessionID: SESSION,
        time: { created: 1, completed: 2 },
        providerID: "opencode",
        modelID: "deepseek-v4.1-flash-free",
        tokens: { input: 5226, output: 9, reasoning: 15, cache: { read: 1536, write: 0 } },
      },
    },
  };
  const usageOf = (checkpoints?: Map<string, ObservationCheckpoint>) => {
    const normalized = normalizeOcObservation({
      data: pulled,
      channel: "pull",
      observed: binding,
      current: binding,
      state: createTranslateState(),
      ...(checkpoints ? { checkpoints } : {}),
    });
    assert.equal(normalized.kind, "accepted");
    if (normalized.kind !== "accepted") return [];
    return normalized.observation.events.filter((event) => event.type === "usage/recorded");
  };
  assert.equal(usageOf().length, 1, "an unseen completed message still records its usage");
  const checkpoints = indexObservationCheckpoints([{
    key: { ...binding, artifactKind: "message", entityId: "msg_1" },
    revision: "durable:1:13",
    value: { role: "assistant", completed: true },
    updatedAt: 1,
  }]);
  assert.equal(usageOf(new Map(checkpoints)).length, 0, "the live completion already recorded it");
});

// OpenCode 1.18.18 legacy terminal payloads carry no comparable revision.
import { test } from "node:test";
import assert from "node:assert";
import type { OpenCodeTransport, RuntimeEndpoint } from "@polyth/contracts";
import {
  admitTranslateTurn,
  claimTerminalStateEvidence,
  createTranslateState,
  normalizeOcObservation,
  terminalStateEvidenceOf,
  translateOcEvent,
} from "../src/events.ts";
import { createLegacyProtocolAdapter } from "../src/protocolLegacy.ts";

const REAL_SESSION_IDLE = {
  type: "session.idle",
  properties: { sessionID: "ses_fb92xxxxxxxxxxxxxxxxxxxxxx" },
} as const;

const REAL_SESSION_ERROR = {
  type: "session.error",
  properties: {
    sessionID: "ses_fb92xxxxxxxxxxxxxxxxxxxxxx",
    error: { name: "APIError", data: { message: "API key not valid." } },
  },
} as const;

const assistantCompletion = (
  state: ReturnType<typeof createTranslateState>,
  messageId: string,
  completed: number,
): void => {
  translateOcEvent({
    type: "message.updated",
    properties: {
      sessionID: REAL_SESSION_IDLE.properties.sessionID,
      info: {
        id: messageId,
        role: "assistant",
        time: { created: completed - 10, completed },
      },
    },
  }, state);
};

test("OC-REAL-020: real 1.18.18 session.idle (no revision) must yield terminal evidence", () => {
  const evidence = terminalStateEvidenceOf(REAL_SESSION_IDLE as never);
  assert.ok(
    evidence && evidence.state === "idle",
    "real legacy session.idle has no revision field, so terminalStateEvidenceOf returns undefined "
      + "and no turn ever terminalizes against a real backend (missed completion)",
  );
});

test("OC-REAL-021: real 1.18.18 session.error (no revision) must yield terminal evidence", () => {
  const evidence = terminalStateEvidenceOf(REAL_SESSION_ERROR as never);
  assert.ok(
    evidence && evidence.state === "failed",
    "real legacy session.error has no revision field, so failed turns are never terminalized locally",
  );
});

test("duplicate idle cannot terminate a later admitted turn", () => {
  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1");
  assistantCompletion(state, "assistant-1", 101);
  assert.deepEqual(claimTerminalStateEvidence(REAL_SESSION_IDLE as never, state), {
    state: "idle",
  });

  admitTranslateTurn(state, "turn-2");
  assert.equal(claimTerminalStateEvidence(REAL_SESSION_IDLE as never, state), undefined);
});

test("old idle after reconnect has no admitted turn to terminate", () => {
  const state = createTranslateState();
  assistantCompletion(state, "assistant-before-reconnect", 101);
  assert.equal(claimTerminalStateEvidence(REAL_SESSION_IDLE as never, state), undefined);
  const binding = {
    authorityId: "legacy-authority",
    generation: 1,
    location: { directory: "/project" },
    backendSessionId: REAL_SESSION_IDLE.properties.sessionID,
    reconciliationOrdinal: 1,
  };
  const normalized = normalizeOcObservation({
    data: REAL_SESSION_IDLE,
    channel: "sse",
    observed: binding,
    current: binding,
    state,
  });
  assert.equal(normalized.kind, "accepted");
  if (normalized.kind !== "accepted") assert.fail("old idle was not normalized");
  assert.equal(normalized.observation.checkpoint, undefined);
});

test("assistant completion from a previous turn cannot terminate a new submit", () => {
  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1");
  assistantCompletion(state, "assistant-1", 101);

  admitTranslateTurn(state, "turn-2");
  assert.equal(claimTerminalStateEvidence(REAL_SESSION_IDLE as never, state), undefined);
});

test("revision-less error is consumed once by its admitted turn", () => {
  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1");
  assert.deepEqual(claimTerminalStateEvidence(REAL_SESSION_ERROR as never, state), {
    state: "failed",
  });
  assert.equal(claimTerminalStateEvidence(REAL_SESSION_ERROR as never, state), undefined);
});

test("OC-REAL-023: status absence terminalizes only with durable assistant completion", async () => {
  let history: unknown[] = [];
  const transport: OpenCodeTransport = {
    async query<T>(request: {
      method: "GET" | "HEAD";
      path: string;
      deadlineMs: number;
    }): Promise<T> {
      if (request.path.startsWith("/session/status")) return {} as T;
      if (request.path.includes("/message?")) return history as T;
      if (request.path.startsWith("/permission") || request.path.startsWith("/question")) {
        return [] as T;
      }
      throw new Error(`unexpected query ${request.path}`);
    },
    async mutate() {
      throw new Error("reconciliation must not mutate");
    },
    async stream() {},
  };
  const endpoint: RuntimeEndpoint = {
    authorityId: "real-legacy-test",
    continuity: "generation-only",
    generation: 1,
    url: "http://opencode.test",
    location: { directory: "/workspace/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const adapter = createLegacyProtocolAdapter({
    transport,
    endpoint,
    promptPaths: ["prompt_async"],
  });
  const binding = {
    canonicalSessionId: "canonical-real",
    backendSessionId: "ses_fb92xxxxxxxxxxxxxxxxxxxxxx",
    authorityId: endpoint.authorityId,
    generation: endpoint.generation,
    continuity: endpoint.continuity,
    location: endpoint.location,
  };

  assert.deepEqual(
    (await adapter.reconcile({ ...binding, reconciliationOrdinal: 1 })).state,
    { value: "unknown" },
    "successful absence from the busy map is not terminal evidence by itself",
  );

  history = [{
    info: {
      id: "msg_assistant",
      role: "assistant",
      time: { created: 1787894837582, completed: 1787894839755 },
    },
    parts: [{
      id: "part_text",
      type: "text",
      text: "DONE-MARKER-020",
      time: { start: 1787894839719, end: 1787894839746 },
    }],
  }];
  const pulledState = (await adapter.reconcile({
    ...binding,
    reconciliationOrdinal: 2,
  })).state;
  assert.deepEqual(pulledState, {
    value: "idle",
    watermark: "1787894839755",
    comparison: {
      domain: "legacy-history:assistant-completed",
      order: 1787894839755,
    },
  });

  const state = createTranslateState();
  admitTranslateTurn(state, "turn-1");
  assistantCompletion(state, "msg_assistant", 1787894839755);
  const live = normalizeOcObservation({
    data: REAL_SESSION_IDLE,
    channel: "sse",
    observed: {
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId,
      reconciliationOrdinal: 2,
    },
    current: {
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId,
      reconciliationOrdinal: 2,
    },
    state,
  });
  assert.equal(live.kind, "accepted");
  if (live.kind !== "accepted") assert.fail("live idle was not normalized");
  assert.equal(
    live.observation.identity.revision,
    `${pulledState.comparison?.domain}:${pulledState.comparison?.order}`,
  );
  assert.deepEqual(live.observation.checkpoint?.value, {
    state: pulledState.value,
    watermark: pulledState.watermark,
    comparison: pulledState.comparison,
  });
});

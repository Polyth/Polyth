import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  MutationTransportResult,
  OpenCodeTransport,
  RuntimeEndpoint,
  RuntimeSnapshot,
} from "@polyth/contracts";
import { createStore } from "@polyth/session";
import {
  createTranslateState,
  isCurrentSnapshot,
  normalizeAndIngestOcObservation,
  normalizeOcObservation,
  snapshotAbsenceIsAuthoritative,
  terminalStateEvidenceOf,
  type ObservationBinding,
} from "../src/events.ts";
import { createLegacyProtocolAdapter } from "../src/protocolLegacy.ts";

const endpoint: RuntimeEndpoint = {
  authorityId: "authority-a",
  continuity: "generation-only",
  generation: 4,
  url: "http://opencode.test",
  location: { directory: "/workspace/project", workspace: "worktree-a" },
  control: { kind: "borrowed", source: "external" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
};

const persistObservationBinding = async (
  store: ReturnType<typeof createStore>,
  sessionId: string,
  binding: ObservationBinding,
): Promise<ObservationBinding> => {
  await store.upsertProjection({
    id: sessionId,
    projectId: "project-a",
    title: "Observation test",
    status: "reconciling",
    backendSessionId: binding.backendSessionId,
    runtimeBinding: {
      backendSessionId: binding.backendSessionId,
      authorityId: binding.authorityId,
      generation: binding.generation,
      continuity: "verified",
      protocol: "legacy",
      location: binding.location,
    },
    createdAt: 1,
    updatedAt: 1,
  });
  const reconciliation = await store.startReconciliation(sessionId);
  return { ...binding, reconciliationOrdinal: reconciliation.ordinal };
};

const transportForPull = (): OpenCodeTransport => ({
  async query<T>(request: {
    method: "GET" | "HEAD";
    path: string;
    deadlineMs: number;
  }): Promise<T> {
    assert.match(request.path, /directory=%2Fworkspace%2Fproject/);
    assert.match(request.path, /workspace=worktree-a/);
    if (request.path.startsWith("/session/status")) {
      return { "session-a": { type: "busy" } } as T;
    }
    if (request.path.startsWith("/session/session-a/message")) {
      return [
        {
          info: { id: "message-user", role: "user" },
          parts: [
            {
              id: "part-user",
              messageID: "message-user",
              sessionID: "session-a",
              type: "text",
              text: "same text as local prompt",
              time: { start: 1, end: 2 },
            },
          ],
        },
      ] as T;
    }
    if (request.path.startsWith("/permission")) {
      return [
        {
          id: "permission-a",
          sessionID: "session-a",
          permission: "bash",
          patterns: ["npm test"],
        },
      ] as T;
    }
    if (request.path.startsWith("/question")) {
      return [
        {
          id: "question-a",
          sessionID: "session-a",
          questions: [{ header: "Continue", question: "Continue?", options: [] }],
        },
      ] as T;
    }
    throw new Error(`unexpected query ${request.path}`);
  },
  async mutate<T>(_request: {
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
    operationId: string;
    deadlineMs: number;
    replay: { kind: "never" } | { kind: "same-operation-id"; contract: string };
  }): Promise<MutationTransportResult<T>> {
    throw new Error("reconciliation must not mutate");
  },
  async stream(_request: {
    path: string;
    after?: string;
    signal: AbortSignal;
    onEvent(value: unknown): void;
  }): Promise<void> {},
});

const binding = {
  canonicalSessionId: "canonical-a",
  backendSessionId: "session-a",
  authorityId: "authority-a",
  generation: 4,
  continuity: "generation-only" as const,
  location: { directory: "/workspace/project", workspace: "worktree-a" },
};

test("pull reconciliation recovers identified pending permission and question", async () => {
  const adapter = createLegacyProtocolAdapter({
    transport: transportForPull(),
    endpoint,
    promptPaths: ["prompt_async"],
  });
  const requestedBinding = { ...binding, reconciliationOrdinal: 17 };
  const snapshot = await adapter.reconcile(requestedBinding);
  assert.equal(snapshot.reconciliationOrdinal, 17);
  assert.equal(snapshot.state.value, "running");
  assert.deepEqual(snapshot.completeness, {
    events: "partial",
    permissions: "partial",
    questions: "partial",
  });
  assert.deepEqual(snapshot.permissions, [{
    requestId: "permission-a",
    permission: "bash",
    patterns: ["npm test"],
    revision: "pending",
  }]);
  assert.equal(snapshot.questions[0]?.requestId, "question-a");
  assert.ok(
    snapshot.events.every((entry) => entry.event.type !== "assistant/message"),
    "unmapped user history is never re-appended as recovered model output",
  );
});

test("legacy terminal status requires a numeric comparable revision", async () => {
  let reportedStatus: Record<string, unknown> = { type: "idle" };
  const transport: OpenCodeTransport = {
    async query<T>(request: {
      method: "GET" | "HEAD";
      path: string;
      deadlineMs: number;
    }): Promise<T> {
      if (request.path.startsWith("/session/status")) {
        return { "session-a": reportedStatus } as T;
      }
      return [] as T;
    },
    async mutate<T>(request: {
      method: "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      body?: unknown;
      operationId: string;
      deadlineMs: number;
      replay: { kind: "never" } | { kind: "same-operation-id"; contract: string };
    }): Promise<MutationTransportResult<T>> {
      return {
        kind: "unknown",
        operationId: request.operationId,
        message: "unused",
      };
    },
    async stream() {},
  };
  const adapter = createLegacyProtocolAdapter({
    transport,
    endpoint,
    promptPaths: ["prompt_async"],
  });

  let snapshot = await adapter.reconcile({
    ...binding,
    reconciliationOrdinal: 3,
  });

  assert.deepEqual(snapshot.state, { value: "unknown" });

  reportedStatus = { type: "idle", revision: "opaque-status-123" };
  snapshot = await adapter.reconcile({
    ...binding,
    reconciliationOrdinal: 4,
  });
  assert.deepEqual(
    snapshot.state,
    { value: "unknown" },
    "a numeric suffix does not make an opaque revision ordered",
  );

  reportedStatus = { type: "idle", revision: 123 };
  snapshot = await adapter.reconcile({
    ...binding,
    reconciliationOrdinal: 5,
  });
  assert.deepEqual(snapshot.state, {
    value: "idle",
    watermark: "123",
    comparison: {
      domain: "legacy-status:revision",
      order: 123,
    },
  });

  assert.equal(
    terminalStateEvidenceOf({
      type: "session.idle",
      properties: { sessionID: "session-a" },
    }),
    undefined,
    "an unversioned SSE idle event cannot terminalize a turn",
  );
  assert.deepEqual(
    terminalStateEvidenceOf({
      type: "session.idle",
      properties: { sessionID: "session-a", revision: 124 },
    }),
    {
      state: "idle",
      watermark: "124",
      comparison: {
        domain: "legacy-status:revision",
        order: 124,
      },
    },
  );
});

test("SSE and pull claim one semantic fact through SessionStore ingestion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-observation-"));
  const store = createStore(join(directory, "sessions.db"));
  let observation: ObservationBinding = {
    authorityId: "authority-a",
    generation: 4,
    location: { directory: "/workspace/project", workspace: "worktree-a" },
    backendSessionId: "session-a",
    reconciliationOrdinal: 8,
  };
  const event = {
    id: "transport-event-a",
    type: "permission.asked",
    properties: {
      id: "permission-a",
      sessionID: "session-a",
      permission: "bash",
      patterns: ["npm test"],
    },
  };
  try {
    observation = await persistObservationBinding(store, "canonical-a", observation);
    const fromSse = await normalizeAndIngestOcObservation({
      store,
      sessionId: "canonical-a",
      data: event,
      channel: "sse",
      observed: observation,
      current: observation,
      cursorAfter: "sse-1",
    });
    assert.equal(fromSse.kind, "ingested");
    if (fromSse.kind === "ingested") {
      assert.equal(fromSse.result.kind, "applied");
      assert.equal(fromSse.observation.entityKey, "permission-a");
      assert.equal(fromSse.observation.identity.revision, "pending");
    }

    const fromPull = await normalizeAndIngestOcObservation({
      store,
      sessionId: "canonical-a",
      data: {
        ...event,
        id: "different-pull-envelope",
      },
      channel: "pull",
      observed: observation,
      current: observation,
      cursorAfter: "pull-1",
    });
    assert.equal(fromPull.kind, "ingested");
    if (fromPull.kind === "ingested") {
      assert.equal(fromPull.result.kind, "duplicate");
      assert.equal(fromPull.observation.entityKey, "permission-a");
      assert.equal(fromPull.observation.identity.revision, "pending");
    }

    const facts = (await store.events("canonical-a"))
      .filter((stored) => stored.type === "permission/requested");
    assert.equal(facts.length, 1);
    assert.equal(
      await store.observationCursor({
        authorityId: "authority-a",
        location: observation.location,
        backendSessionId: "session-a",
        channel: "pull",
      }),
      "pull-1",
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale generations are discarded before translation mutates state", () => {
  const state = createTranslateState();
  const stale: ObservationBinding = {
    authorityId: "authority-a",
    generation: 3,
    location: endpoint.location,
    backendSessionId: "session-a",
    reconciliationOrdinal: 2,
  };
  const current: ObservationBinding = { ...stale, generation: 4 };
  const result = normalizeOcObservation({
    data: {
      type: "message.updated",
      properties: {
        sessionID: "session-a",
        info: { id: "message-user", role: "user" },
      },
    },
    channel: "sse",
    observed: stale,
    current,
    state,
  });
  assert.deepEqual(result, { kind: "stale" });
  assert.equal(state.userMessageIds.size, 0);
});

test("partial snapshot absence cannot close durable attention", () => {
  const snapshot: RuntimeSnapshot = {
    authorityId: "authority-a",
    generation: 4,
    location: endpoint.location,
    backendSessionId: "session-a",
    reconciliationOrdinal: 5,
    state: { value: "idle", watermark: "11" },
    completeness: {
      events: "partial",
      permissions: "partial",
      questions: "partial",
    },
    permissions: [],
    questions: [],
    events: [],
  };
  const current: ObservationBinding = {
    authorityId: "authority-a",
    generation: 4,
    location: endpoint.location,
    backendSessionId: "session-a",
    reconciliationOrdinal: 5,
  };
  assert.equal(isCurrentSnapshot(snapshot, current), true);
  assert.equal(
    snapshotAbsenceIsAuthoritative(snapshot, "permissions", "10", (next, prior) =>
      Number(next) - Number(prior)),
    false,
  );
  assert.equal(
    snapshot.events.some(
      (entry) =>
        entry.event.type === "permission/requested"
        || entry.event.type === "question/asked",
    ),
    false,
  );
});

test("divergent recovery records uncertainty without duplicate model output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "polyth-divergence-"));
  const store = createStore(join(directory, "sessions.db"));
  let observation: ObservationBinding = {
    authorityId: "authority-a",
    generation: 4,
    location: endpoint.location,
    backendSessionId: "session-a",
    reconciliationOrdinal: 9,
  };
  try {
    observation = await persistObservationBinding(store, "canonical-a", observation);
    const first = await normalizeAndIngestOcObservation({
      store,
      sessionId: "canonical-a",
      channel: "sse",
      observed: observation,
      current: observation,
      data: {
        type: "message.part.updated",
        properties: {
          sessionID: "session-a",
          part: {
            id: "part-a",
            messageID: "assistant-a",
            sessionID: "session-a",
            type: "text",
            text: "durable answer",
            time: { start: 1, end: 2 },
          },
        },
      },
    });
    assert.equal(first.kind, "ingested");

    const divergent = await normalizeAndIngestOcObservation({
      store,
      sessionId: "canonical-a",
      channel: "pull",
      observed: observation,
      current: observation,
      data: {
        type: "message.part.updated",
        properties: {
          sessionID: "session-a",
          part: {
            id: "part-a",
            messageID: "assistant-a",
            sessionID: "session-a",
            type: "text",
            text: "different answer",
            time: { start: 1, end: 3 },
          },
        },
      },
    });
    assert.equal(divergent.kind, "ingested");
    const events = await store.events("canonical-a");
    assert.equal(events.filter((event) => event.type === "assistant/message").length, 1);
    assert.equal(
      events.filter((event) => event.type === "reconciliation/uncertainty-recorded").length,
      1,
    );
    assert.deepEqual(
      (await store.observationCheckpoint({
        authorityId: "authority-a",
        location: endpoint.location,
        backendSessionId: "session-a",
        artifactKind: "part",
        entityId: "part-a",
      }))?.value,
      { type: "text", text: "durable answer", complete: true },
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

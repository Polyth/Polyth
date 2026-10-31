import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  HarnessContext,
  JsonObject,
  ProjectService,
  SessionEvent,
  SessionProjection,
  SessionService,
  SpaceContext,
  ToolExecutionContext,
} from "@polyth/contracts";
import {
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createCapabilityContributionRegistry } from "../src/contextualCapabilities.ts";
import { registerPeerObservationTool } from "../src/peerObservationTool.ts";

const space: SpaceContext = {
  spaceId: "space-a",
  spaceSlug: "space-a",
  userId: "user-a",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/tmp/polyth-space-a",
};

const projection = (
  id: string,
  projectId = "p1",
  parentId?: string,
): SessionProjection => ({
  id,
  projectId,
  title: id,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...(parentId ? { parentId } : {}),
});

const harnessContext: HarnessContext = {
  space,
  spaceId: space.spaceId,
  projectId: "p1",
  cwd: "/projects/p1",
};

const toolContext = (sessionId: string): ToolExecutionContext => ({
  sessionId,
  spaceId: space.spaceId,
  projectId: "p1",
  cwd: "/projects/p1",
});

test("peer observations persist as bounded canonical events and can be explicitly inspected by the parent", async () => {
  const rows = new Map<string, SessionProjection>([
    ["parent", projection("parent")],
    ["worker-a", projection("worker-a", "p1", "parent")],
    ["worker-b", projection("worker-b", "p1", "parent")],
    ["other-root", projection("other-root")],
    ["foreign", projection("foreign", "p2")],
  ]);
  const eventLog = new Map<string, SessionEvent[]>();
  const appendCalls: Array<{
    sessionId: string;
    type: string;
    data: JsonObject;
    options: unknown;
  }> = [];

  const sessions = {
    async snapshot(id: string) {
      const row = rows.get(id);
      if (!row) throw Object.assign(new Error("not found"), { code: "not-found" });
      return row;
    },
    async events(id: string) {
      return eventLog.get(id) ?? [];
    },
  } as unknown as SessionService;

  const services = createServerServiceRegistry();
  const registry = createCapabilityContributionRegistry();
  services.provide(serverServiceKey("harness.capabilities"), registry);

  const host = {
    services,
    events: {
      async append(sessionId: string, type: string, data: JsonObject, options: unknown) {
        const existing = eventLog.get(sessionId) ?? [];
        const event: SessionEvent = {
          id: `ev-${sessionId}-${existing.length + 1}`,
          sessionId,
          seq: existing.length + 1,
          time: 100 + existing.length,
          type,
          data,
          ignorable: true,
          producerPlugin: "harness-runtime",
          v: 1,
        };
        eventLog.set(sessionId, [...existing, event]);
        appendCalls.push({ sessionId, type, data, options });
        return event;
      },
    },
    forSpace(ctx: SpaceContext) {
      assert.equal(ctx.spaceId, space.spaceId);
      return {
        projects: {} as ProjectService,
        sessions,
      };
    },
  } as unknown as ServerPackageHost;

  const registration = registerPeerObservationTool(host);
  const [descriptor] = registry.resolve(harnessContext);
  assert.equal(descriptor?.id, "harness-runtime.peer-observations");
  assert.equal(descriptor?.kind, "tool");
  assert.equal(descriptor?.kind === "tool" ? descriptor.name : undefined, "polyth_peer");

  const execute = registry.executor("harness-runtime.peer-observations");
  assert.ok(execute);

  const observed = JSON.parse((await execute!({
    action: "session.observe",
    parameters: {
      sessionId: "worker-b",
      kind: "finding",
      content: "The retry path is missing a stale-generation guard.",
      taskId: "retry-audit",
      artifacts: ["packages/server/src/retry.ts#L20-L40"],
    },
  }, toolContext("worker-a"))).output) as {
    observation: { seq: number; sourceSessionId: string; targetSessionId: string };
  };

  assert.equal(observed.observation.seq, 1);
  assert.equal(observed.observation.sourceSessionId, "worker-a");
  assert.equal(observed.observation.targetSessionId, "worker-b");
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0]?.sessionId, "worker-b");
  assert.equal(appendCalls[0]?.type, "session/observation");
  assert.deepEqual(appendCalls[0]?.options, {
    ignorable: true,
    producerPlugin: "harness-runtime",
  });
  assert.equal(appendCalls[0]?.data.sourceSessionId, "worker-a");
  assert.equal(appendCalls[0]?.data.rootSessionId, "parent");
  assert.equal(appendCalls[0]?.data.projectId, "p1");

  const parentRead = JSON.parse((await execute!({
    action: "session.observations",
    parameters: { sessionId: "worker-b", afterSeq: 0, limit: 10 },
  }, toolContext("parent"))).output) as {
    observations: Array<Record<string, unknown>>;
    unreadCount: number;
    latestSeq: number;
  };
  assert.equal(parentRead.unreadCount, 1);
  assert.equal(parentRead.latestSeq, 1);
  assert.deepEqual(parentRead.observations, [{
    seq: 1,
    time: 100,
    kind: "finding",
    content: "The retry path is missing a stale-generation guard.",
    sourceSessionId: "worker-a",
    targetSessionId: "worker-b",
    rootSessionId: "parent",
    projectId: "p1",
    taskId: "retry-audit",
    artifacts: ["packages/server/src/retry.ts#L20-L40"],
  }]);

  // Observation events are separate ignorable facts; no ordinary user/assistant
  // messages are synthesized into the target session's model-visible history.
  assert.equal(
    (eventLog.get("worker-b") ?? []).some((event) =>
      event.type === "user/message" || event.type === "assistant/message"),
    false,
  );

  await assert.rejects(
    () => execute!({
      action: "session.observe",
      parameters: { sessionId: "foreign", kind: "finding", content: "nope" },
    }, toolContext("worker-a")),
    (error: unknown) => (error as { code?: string }).code === "forbidden",
  );
  await assert.rejects(
    () => execute!({
      action: "session.observe",
      parameters: { sessionId: "other-root", kind: "finding", content: "nope" },
    }, toolContext("worker-a")),
    (error: unknown) => (error as { code?: string }).code === "forbidden",
  );
  await assert.rejects(
    () => execute!({
      action: "session.observe",
      parameters: { sessionId: "worker-b", kind: "finding", content: "x".repeat(4097) },
    }, toolContext("worker-a")),
    (error: unknown) => (error as { code?: string }).code === "invalid-input",
  );

  await registration.dispose();
  assert.equal(registry.resolve(harnessContext).length, 0);
});

// Live destructive session checks against a REAL OpenCode process. Kept
// outside the default `*.test.ts` glob; run explicitly:
//
//   node --experimental-strip-types --test packages/server/test/opencodeDestructive.live.ts
//
// Provider credentials are not required. Session create is a confirmed
// operation; a provider-free prompt is admitted and then fails the model
// turn. Never opens the user global OpenCode DB.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentRuntime,
  Project,
  ProjectService,
  SessionEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import {
  LIVE_OPENCODE_SKIP,
  assertGlobalOpenCodeDbUntouched,
  createRealOwnedLiveFixture,
  waitFor,
  type RealOwnedLiveFixture,
} from "../../backend-opencode/test/realOpenCodeLiveHarness.ts";
import { canRebindPersistedSession, createSessionService, type Broadcaster } from "../src/sessions.ts";
import { latestRecoveryContext } from "./runtimeReliabilityHelpers.ts";

const LIVE = { skip: LIVE_OPENCODE_SKIP, timeout: 180_000 };

const AFTER_COMPLETION_SKIP =
  "OpenCode 1.18.18 without provider credentials never produces a successful assistant completion. "
  + "A provider-free prompt is admitted and then ends as turn/stopped(error=missing API key). "
  + "There is no separate post-completion transport ack to interpose; skipping rather than faking that boundary.";

const permissionService = {
  evaluate: () => "allow",
  addRule: () => undefined,
  rules: () => [],
} as unknown as PermissionService;

const projectServices = (project: Project): ProjectService => ({
  list: async () => [project],
  get: async (id) => id === project.id ? project : undefined,
  add: async () => project,
  create: async () => project,
  remove: async () => undefined,
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const createLiveSessionHarness = (
  fixture: RealOwnedLiveFixture,
  runtime: AgentRuntime,
  store = createStore(`${fixture.directory}/sessions.db`),
) => {
  const project: Project = {
    id: "project-live-destructive",
    name: "Live destructive",
    path: fixture.directory,
    createdAt: 1,
  };
  const events: SessionEvent[] = [];
  const broadcast: Broadcaster = {
    event: (event) => {
      events.push(event);
    },
    projection: () => undefined,
  };
  const sessions = createSessionService({
    store,
    projects: projectServices(project),
    permissions: permissionService,
    broadcast,
    queue: store,
    runtimes: { forProject: async () => runtime },
  });
  return {
    store,
    project,
    events,
    sessions,
    async waitForIdle(sessionId: string): Promise<void> {
      await waitFor(async () => {
        const projection = await store.projection(sessionId);
        return projection?.status === "idle" && Boolean(projection.backendSessionId);
      }, `session ${sessionId} idle`);
    },
  };
};

test("live: delete DB while stopped → new epoch, preserved history, no duplicate turn", LIVE, async () => {
  const fixture = await createRealOwnedLiveFixture({ prefix: "polyth-oc-live-stopped-" });
  let store: ReturnType<typeof createStore> | undefined;
  try {
    const first = await fixture.boot();
    const firstHarness = createLiveSessionHarness(fixture, first.runtime);
    store = firstHarness.store;
    const created = await firstHarness.sessions.create({
      projectId: firstHarness.project.id,
      title: "Stopped DB delete",
    });
    await firstHarness.waitForIdle(created.id);
    const firstProjection = (await store.projection(created.id))!;
    const firstBackend = firstProjection.backendSessionId;
    const firstAuthority = first.endpoint.authorityId;
    assert.ok(firstBackend);

    await firstHarness.sessions.send(created.id, { text: "confirmed canonical fact" });
    await waitFor(async () => {
      const events = await store!.events(created.id);
      return events.some((event) => event.type === "turn/stopped");
    }, "first turn terminal");

    await fixture.disposeActive();
    await fixture.inject({ kind: "delete-database" });
    const second = await fixture.boot();
    assert.notEqual(second.endpoint.authorityId, firstAuthority);
    assert.notEqual(second.metadata?.storageId, first.metadata?.storageId);

    const secondHarness = createLiveSessionHarness(fixture, second.runtime, store);
    await secondHarness.sessions.send(created.id, { text: "continue after stopped delete" });

    const projection = (await store.projection(created.id))!;
    assert.equal(projection.runtimeBinding?.epoch, 1);
    assert.equal(projection.runtimeBinding?.authorityId, second.endpoint.authorityId);
    assert.notEqual(projection.backendSessionId, firstBackend);
    const log = await store.events(created.id);
    assert.equal(log.filter((event) => event.type === "runtime/epoch-replaced").length, 1);
    assert.equal(
      log.filter((event) =>
        event.type === "user/message"
        && (event.data as { text?: unknown }).text === "continue after stopped delete").length,
      1,
    );
    assert.match(latestRecoveryContext(log), /confirmed canonical fact/);
    await waitFor(async () => {
      const events = await store!.events(created.id);
      return events.some((event) =>
        event.type === "turn/stopped"
        && events.filter((candidate) => candidate.type === "user/message").length >= 2);
    }, "continue turn terminal");
    const backendHistory = await second.runtime.history(created.id);
    const backendTexts = backendHistory.map((message) => message.text ?? "");
    assert.equal(
      backendTexts.filter((text) => text === "confirmed canonical fact").length,
      0,
      "canonical fact must not be replayed as a second native backend turn",
    );
    const continueOnBackend = backendTexts.filter((text) =>
      text.includes("continue after stopped delete"));
    assert.ok(
      continueOnBackend.length <= 1,
      `continue must not be duplicated on the fresh backend, got ${JSON.stringify(backendTexts)}`,
    );
    assertGlobalOpenCodeDbUntouched(fixture.globalDbBefore);
  } finally {
    await fixture.dispose();
    await sleep(100);
    await store?.close();
  }
});

test("live: crash before backend receives prompt leaves no confirmed turn", LIVE, async () => {
  const fixture = await createRealOwnedLiveFixture({ prefix: "polyth-oc-live-crash-before-" });
  let store: ReturnType<typeof createStore> | undefined;
  let harness: ReturnType<typeof createLiveSessionHarness> | undefined;
  try {
    const boot = await fixture.boot();
    harness = createLiveSessionHarness(fixture, boot.runtime);
    store = harness.store;
    const created = await harness.sessions.create({
      projectId: harness.project.id,
      title: "Crash before prompt",
    });
    await harness.waitForIdle(created.id);
    await fixture.disposeActive();

    await assert.rejects(
      () => harness!.sessions.send(created.id, { text: "must not reach a live backend" }),
    );
    const operations = await harness.store.operations(created.id);
    const turn = operations.find((operation) => operation.mutationKind === "turn-submit");
    assert.notEqual(turn?.state, "confirmed");
    if (turn?.state === "unknown") {
      await assert.rejects(
        () => harness!.sessions.send(created.id, { text: "must not replay unknown" }),
        (error: Error & { code?: string }) => error.code === "conflict" || error.code === "outcome-unknown",
      );
      assert.equal(
        (await harness.store.operations(created.id))
          .find((operation) => operation.operationId === turn.operationId)?.state,
        "unknown",
      );
    }
    assertGlobalOpenCodeDbUntouched(fixture.globalDbBefore);
  } finally {
    await store?.close();
    await fixture.dispose();
  }
});

test("live: crash after receive before confirmation keeps insufficient evidence unknown", LIVE, async () => {
  const fixture = await createRealOwnedLiveFixture({ prefix: "polyth-oc-live-crash-admit-" });
  let store: ReturnType<typeof createStore> | undefined;
  let harness: ReturnType<typeof createLiveSessionHarness> | undefined;
  try {
    const boot = await fixture.boot();
    harness = createLiveSessionHarness(fixture, boot.runtime);
    store = harness.store;
    const created = await harness.sessions.create({
      projectId: harness.project.id,
      title: "Crash during admission",
    });
    await harness.waitForIdle(created.id);

    const pid = await fixture.childPid();
    assert.ok(pid);
    process.kill(pid, "SIGSTOP");
    const sending = harness.sessions.send(created.id, { text: "admission window" });
    await sleep(250);
    process.kill(pid, "SIGKILL");

    const result = await sending.then(
      (value) => ({ kind: "confirmed" as const, value }),
      (error: Error & { code?: string }) => ({ kind: "failed" as const, code: error.code, message: error.message }),
    );
    const operations = await harness.store.operations(created.id);
    const turn = operations.find((operation) => operation.mutationKind === "turn-submit");
    if (result.kind === "failed" && result.code === "outcome-unknown") {
      assert.equal(turn?.state, "unknown");
      await assert.rejects(
        () => harness!.sessions.send(created.id, { text: "must not replay unknown" }),
        (error: Error & { code?: string }) => error.code === "conflict" || error.code === "outcome-unknown",
      );
      assert.equal(
        (await harness.store.operations(created.id))
          .find((operation) => operation.operationId === turn?.operationId)?.state,
        "unknown",
      );
    } else if (result.kind === "confirmed") {
      assert.equal(turn?.state, "confirmed");
    } else {
      assert.ok(
        turn === undefined || turn.state !== "confirmed",
        `insufficient evidence must not become confirmed; outcome=${JSON.stringify(result)} state=${turn?.state}`,
      );
    }
    assertGlobalOpenCodeDbUntouched(fixture.globalDbBefore);
  } finally {
    await store?.close();
    await fixture.dispose();
  }
});

test("live: crash during streaming after admission does not invent a completed turn", LIVE, async () => {
  const fixture = await createRealOwnedLiveFixture({ prefix: "polyth-oc-live-crash-stream-" });
  let store: ReturnType<typeof createStore> | undefined;
  let harness: ReturnType<typeof createLiveSessionHarness> | undefined;
  try {
    const boot = await fixture.boot();
    harness = createLiveSessionHarness(fixture, boot.runtime);
    store = harness.store;
    const created = await harness.sessions.create({
      projectId: harness.project.id,
      title: "Crash during stream",
    });
    await harness.waitForIdle(created.id);

    await harness.sessions.send(created.id, { text: "stream then die" });
    const admitted = (await harness.store.operations(created.id))
      .find((operation) => operation.mutationKind === "turn-submit");
    assert.equal(admitted?.state, "confirmed");

    const pid = await fixture.childPid();
    assert.ok(pid);
    process.kill(pid, "SIGKILL");
    await sleep(400);
    await fixture.disposeActive();

    const events = await harness.store.events(created.id);
    const stopped = events.filter((event) => event.type === "turn/stopped");
    assert.equal(
      stopped.filter((event) => (event.data as { reason?: unknown }).reason === "completed").length,
      0,
    );
    assert.equal(
      events.filter((event) => event.type === "assistant/message").length,
      0,
    );
    assert.equal(
      (await harness.store.operations(created.id))
        .find((operation) => operation.operationId === admitted?.operationId)?.state,
      "confirmed",
    );
    assertGlobalOpenCodeDbUntouched(fixture.globalDbBefore);
  } finally {
    await store?.close();
    await fixture.dispose();
  }
});

test(
  "live: crash after assistant completion before transport ack",
  { skip: AFTER_COMPLETION_SKIP, timeout: 180_000 },
  async () => {
    throw new Error("unreachable: skipped provider-free completion boundary");
  },
);

test("live: compatible reopen through the session service keeps the binding", LIVE, async () => {
  const fixture = await createRealOwnedLiveFixture({ prefix: "polyth-oc-live-session-warm-" });
  let store: ReturnType<typeof createStore> | undefined;
  try {
    const first = await fixture.boot();
    const firstHarness = createLiveSessionHarness(fixture, first.runtime);
    store = firstHarness.store;
    const created = await firstHarness.sessions.create({
      projectId: firstHarness.project.id,
      title: "Warm session reopen",
    });
    await firstHarness.waitForIdle(created.id);
    const before = (await store.projection(created.id))!;
    await fixture.disposeActive();
    await sleep(400);
    const second = await fixture.boot();
    assert.equal(second.endpoint.authorityId, first.endpoint.authorityId);
    assert.equal(second.endpoint.generation, 2);
    // A provider-free create has no completed-assistant watermark. OpenCode
    // 1.18.18 omits idle sessions from /session/status, so a brand-new
    // session service cannot prove idle after attach and send() 409s
    // `unknown`. That is reconcile evidence, not an identity break: authority
    // is unchanged and canRebind stays true. A send after create-only is
    // therefore not asserted here.
    assert.ok(before.runtimeBinding);
    assert.ok(before.backendSessionId);
    assert.equal(
      canRebindPersistedSession(before.runtimeBinding, {
        backendSessionId: before.backendSessionId,
        endpoint: second.endpoint,
        protocol: before.runtimeBinding.protocol,
      }),
      true,
    );
    assert.equal(
      (await store.events(created.id))
        .filter((event) => event.type === "runtime/epoch-replaced").length,
      0,
    );
    assertGlobalOpenCodeDbUntouched(fixture.globalDbBefore);
  } finally {
    await fixture.dispose();
    await sleep(100);
    await store?.close();
  }
});

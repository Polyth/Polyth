import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { createBorrowedExternalEndpointLease } from "@polyth/backend-opencode";
import type { RuntimeEndpoint } from "@polyth/contracts";
import { canRebindPersistedSession } from "../src/sessions.ts";
import {
  createLocalOwnedFixture,
  TEST_LOCAL_DIGEST_B,
} from "../../backend-opencode/test/localRuntimeFailure.ts";
import { createRemoteOwnedFixture } from "../../backend-opencode/test/remoteRuntimeFailure.ts";
import { TEST_REMOTE_DIGEST_B } from "../../backend-opencode/test/fakeRemoteRuntime.ts";
import { runtimeFailureActions } from "../../backend-opencode/test/runtimeFailureActions.ts";
import { createFakeOpenCode } from "../../backend-opencode/test/fakeOpenCode.ts";
import {
  admitUnknownTurn,
  assertCanRebindUnchanged,
  createEpochRuntime,
  createSessionReliabilityHarness,
  latestRecoveryContext,
  persistBoundSession,
  prepareUnclaimedTurn,
  reopenStore,
} from "./runtimeReliabilityHelpers.ts";

const sendAfterBreak = async (
  first: RuntimeEndpoint,
  second: RuntimeEndpoint,
  options: {
    unknownText?: string;
    preparedText?: string;
    confirmedText?: string;
    continueText?: string;
  } = {},
) => {
  const submitted: string[] = [];
  const firstHarness = createSessionReliabilityHarness({
    runtime: createEpochRuntime(first, submitted, "backend-old"),
    prefix: "polyth-matrix-session-",
  });
  const sessionId = "session-matrix";
  try {
    await persistBoundSession(
      firstHarness.store,
      firstHarness.project,
      first,
      sessionId,
      "backend-old",
      first.authorityId,
      options.unknownText ? "unknown" : "idle",
    );
    if (options.confirmedText) {
      await firstHarness.store.append(sessionId, "user/message", { text: options.confirmedText });
      await firstHarness.store.append(sessionId, "assistant/message", { text: "ack" });
    }
    const unknown = options.unknownText
      ? await admitUnknownTurn(firstHarness.store, sessionId, options.unknownText)
      : undefined;
    const prepared = options.preparedText
      ? await prepareUnclaimedTurn(firstHarness.store, sessionId, options.preparedText)
      : undefined;
    const secondHarness = createSessionReliabilityHarness({
      runtime: createEpochRuntime(second, submitted, "backend-new"),
      directory: firstHarness.directory,
      store: firstHarness.store,
    });
    await secondHarness.sessions.send(sessionId, { text: options.continueText ?? "continue after break" });
    return {
      directory: firstHarness.directory,
      store: firstHarness.store,
      sessionId,
      submitted,
      unknown,
      prepared,
      dispose: () => firstHarness.dispose(),
    };
  } catch (error) {
    await firstHarness.dispose();
    throw error;
  }
};

test("matrix: owned local / DB missing → automatic fresh epoch", async () => {
  const fixture = await createLocalOwnedFixture();
  try {
    const first = await fixture.boot();
    await fixture.inject({ kind: "delete-database" });
    const second = await fixture.boot();
    assert.notEqual(second.endpoint.authorityId, first.endpoint.authorityId);
    const result = await sendAfterBreak(first.endpoint, second.endpoint, {
      confirmedText: "confirmed canonical fact",
    });
    try {
      const projection = await result.store.projection(result.sessionId);
      assert.equal(projection?.runtimeBinding?.epoch, 1);
      assert.equal(projection?.runtimeBinding?.authorityId, second.endpoint.authorityId);
      assert.equal(
        (await result.store.events(result.sessionId))
          .filter((event) => event.type === "runtime/epoch-replaced").length,
        1,
      );
      assert.match(latestRecoveryContext(await result.store.events(result.sessionId)), /confirmed canonical fact/);
    } finally {
      await result.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("matrix: owned local / identity mismatch → quarantine + epoch", async () => {
  const fixture = await createLocalOwnedFixture();
  try {
    const first = await fixture.boot();
    await fixture.inject({ kind: "change-binary-identity", digest: TEST_LOCAL_DIGEST_B });
    const second = await fixture.boot();
    assert.ok(fixture.diagnostics.some((message) => /quarantined/i.test(message)));
    const result = await sendAfterBreak(first.endpoint, second.endpoint);
    try {
      assert.equal((await result.store.projection(result.sessionId))?.runtimeBinding?.epoch, 1);
    } finally {
      await result.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("matrix: owned local / unknown admitted turn → fence, no replay", async () => {
  const fixture = await createLocalOwnedFixture();
  try {
    const first = await fixture.boot();
    await fixture.inject({ kind: "wipe-runtime" });
    const second = await fixture.boot();
    const result = await sendAfterBreak(first.endpoint, second.endpoint, {
      confirmedText: "keep this",
      unknownText: "uncertain request must stay held",
    });
    try {
      assert.equal((await result.store.operation(result.unknown!.operationId))?.state, "fenced");
      const held = await result.store.queueList(result.sessionId);
      assert.deepEqual(
        held.map((item) => ({ text: item.text, held: item.heldForReview })),
        [{ text: "uncertain request must stay held", held: true }],
      );
      const context = latestRecoveryContext(await result.store.events(result.sessionId));
      assert.match(context, /keep this/);
      assert.doesNotMatch(context, /uncertain request must stay held/);
      assert.equal(result.submitted.length, 1);
    } finally {
      await result.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("matrix: owned SSH / DB missing → automatic fresh epoch", async () => {
  const fixture = await createRemoteOwnedFixture();
  try {
    const first = await fixture.boot();
    fixture.inject({ kind: "delete-database" });
    const second = await fixture.boot();
    const result = await sendAfterBreak(first.endpoint, second.endpoint, {
      confirmedText: "remote confirmed fact",
    });
    try {
      assert.equal((await result.store.projection(result.sessionId))?.runtimeBinding?.epoch, 1);
      assert.match(latestRecoveryContext(await result.store.events(result.sessionId)), /remote confirmed fact/);
    } finally {
      await result.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("matrix: owned SSH / metadata missing → recover then epoch", async () => {
  const fixture = await createRemoteOwnedFixture();
  try {
    const first = await fixture.boot();
    fixture.inject({ kind: "delete-metadata" });
    const second = await fixture.boot();
    assert.notEqual(second.prepared.storageId, first.prepared.storageId);
    const result = await sendAfterBreak(first.endpoint, second.endpoint);
    try {
      assert.equal((await result.store.projection(result.sessionId))?.status, "idle");
      assert.equal((await result.store.projection(result.sessionId))?.runtimeBinding?.epoch, 1);
    } finally {
      await result.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("matrix: owned SSH / engine mismatch → no silent reuse", async () => {
  const fixture = await createRemoteOwnedFixture();
  try {
    const first = await fixture.boot();
    fixture.inject({ kind: "digest-change", digest: TEST_REMOTE_DIGEST_B });
    const second = await fixture.boot();
    assert.notEqual(second.endpoint.authorityId, first.endpoint.authorityId);
    const result = await sendAfterBreak(first.endpoint, second.endpoint);
    try {
      assert.equal((await result.store.projection(result.sessionId))?.runtimeBinding?.authorityId, second.endpoint.authorityId);
      assert.equal(
        canRebindPersistedSession(
          (await result.store.projection(result.sessionId))!.runtimeBinding!,
          {
            backendSessionId: (await result.store.projection(result.sessionId))!.backendSessionId!,
            endpoint: first.endpoint,
            protocol: "legacy",
          },
        ),
        false,
      );
    } finally {
      await result.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("matrix: borrowed / identity mismatch → user confirmation", async () => {
  const oldEndpoint: RuntimeEndpoint = {
    authorityId: "external:destroyed",
    continuity: "generation-only",
    generation: 2,
    url: "http://runtime.old",
    location: { directory: "/external/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const newEndpoint: RuntimeEndpoint = {
    ...oldEndpoint,
    authorityId: "external:replacement",
    generation: 3,
    url: "http://runtime.new",
  };
  const submitted: string[] = [];
  const harness = createSessionReliabilityHarness({
    runtime: createEpochRuntime(newEndpoint, submitted, "backend-borrowed-new"),
    prefix: "polyth-matrix-borrowed-",
  });
  const sessionId = "session-borrowed";
  try {
    await persistBoundSession(
      harness.store,
      harness.project,
      oldEndpoint,
      sessionId,
      "backend-old",
      oldEndpoint.authorityId,
      "idle",
    );
    const unknown = await admitUnknownTurn(harness.store, sessionId, "borrowed uncertain");
    await harness.sessions.events(sessionId, 0);
    const pending = await harness.store.projection(sessionId);
    assert.equal(pending?.status, "epoch-pending");
    assert.equal(pending?.runtimeControl, "borrowed");
    await assert.rejects(
      () => harness.sessions.send(sessionId, { text: "must not auto-recover" }),
      (error: Error & { code?: string }) =>
        error.code === "confirmation-required" || error.code === "epoch-pending",
    );
    assert.equal(
      (await harness.store.events(sessionId)).some((event) => event.type === "runtime/epoch-replaced"),
      false,
    );
    const ready = await harness.sessions.confirmBorrowedRuntimeEpoch(sessionId);
    assert.equal(ready.status, "idle");
    assert.equal(ready.runtimeBinding?.epoch, 1);
    assert.equal((await harness.store.operation(unknown.operationId))?.state, "unknown");
    await harness.sessions.send(sessionId, { text: "after confirm" });
    assert.equal((await harness.store.operation(unknown.operationId))?.state, "unknown");
    assert.equal(submitted.length, 1);
  } finally {
    await harness.dispose();
  }
});

test("matrix: borrowed / disconnect only → reconnect, no epoch", async () => {
  const lease = await createBorrowedExternalEndpointLease({
    url: "http://127.0.0.1:59999",
    location: { directory: "/external/project" },
    authorityId: "external:stable",
  });
  try {
    const first = await lease.endpoint();
    const second = await lease.refresh("disconnect");
    assert.equal(second.authorityId, first.authorityId);
    assert.equal(second.generation, first.generation);
    const submitted: string[] = [];
    const harness = createSessionReliabilityHarness({
      runtime: createEpochRuntime(second, submitted, "backend-stable"),
      prefix: "polyth-matrix-disconnect-",
    });
    const sessionId = "session-disconnect";
    try {
      await persistBoundSession(
        harness.store,
        harness.project,
        first,
        sessionId,
        "backend-stable",
      );
      await harness.sessions.send(sessionId, { text: "still the same runtime" });
      assert.equal((await harness.store.projection(sessionId))?.runtimeBinding?.epoch ?? 0, 0);
      assert.equal((await harness.store.projection(sessionId))?.status, "idle");
      assert.equal(
        (await harness.store.events(sessionId)).some((event) => event.type === "runtime/epoch-replaced"),
        false,
      );
      assert.equal(submitted.length, 1);
      assert.equal(canRebindPersistedSession((await harness.store.projection(sessionId))!.runtimeBinding!, {
        backendSessionId: "backend-stable",
        endpoint: second,
        protocol: "legacy",
      }), true);
    } finally {
      await harness.dispose();
    }
  } finally {
    await lease.dispose();
  }
});

test("matrix: any / Polyth restart → canonical history intact", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "owned:stable",
    continuity: "verified",
    generation: 2,
    url: "http://runtime.invalid",
    location: { directory: "/project" },
    control: { kind: "owned", instanceToken: "stable" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const first = createSessionReliabilityHarness({
    runtime: createEpochRuntime(endpoint, [], "backend-stable"),
    prefix: "polyth-matrix-restart-",
  });
  const sessionId = "session-restart";
  try {
    await persistBoundSession(first.store, first.project, endpoint, sessionId, "backend-stable");
    await first.store.append(sessionId, "user/message", { text: "canonical before restart" });
    await first.store.append(sessionId, "assistant/message", { text: "remembered" });
    const before = await first.store.events(sessionId);
    const store = await reopenStore(first.directory, first.store);
    const second = createSessionReliabilityHarness({
      runtime: createEpochRuntime({ ...endpoint, generation: 3 }, [], "backend-stable"),
      directory: first.directory,
      store,
    });
    const after = await store.events(sessionId);
    assert.deepEqual(
      after.map((event) => ({ type: event.type, text: (event.data as { text?: string }).text })),
      before.map((event) => ({ type: event.type, text: (event.data as { text?: string }).text })),
    );
    assert.equal((await store.projection(sessionId))?.runtimeBinding?.authorityId, "owned:stable");
    await second.sessions.send(sessionId, { text: "after restart" });
    assert.equal((await store.projection(sessionId))?.runtimeBinding?.epoch ?? 0, 0);
    await store.close();
  } finally {
    try { rmSync(first.directory, { recursive: true, force: true }); } catch { /* already removed */ }
  }
});

test("matrix: any owned / epoch recovery → confirmed history only", async () => {
  const fixture = await createLocalOwnedFixture();
  try {
    const first = await fixture.boot();
    await fixture.inject({ kind: "wipe-runtime" });
    const second = await fixture.boot();
    const result = await sendAfterBreak(first.endpoint, second.endpoint, {
      confirmedText: "only confirmed history may return",
      unknownText: "fenced tail must not leak",
      continueText: "new epoch prompt",
    });
    try {
      const events = await result.store.events(result.sessionId);
      const context = latestRecoveryContext(events);
      const continueText = (events.filter((event) => event.type === "user/message").at(-1)?.data as {
        text?: string;
      }).text ?? "";
      assert.equal(continueText, "new epoch prompt");
      assert.match(context, /only confirmed history may return/);
      assert.doesNotMatch(context, /new epoch prompt/);
      assert.doesNotMatch(context, /fenced tail must not leak/);
      await fixture.inject({ kind: "wipe-runtime" });
      const third = await fixture.boot();
      const submitted: string[] = [];
      const later = createSessionReliabilityHarness({
        runtime: createEpochRuntime(third.endpoint, submitted, "backend-third"),
        directory: result.directory,
        store: result.store,
      });
      await later.sessions.send(result.sessionId, { text: "second epoch prompt" });
      const secondContext = latestRecoveryContext(await result.store.events(result.sessionId));
      assert.doesNotMatch(secondContext, /fenced tail must not leak/);
      assert.match(secondContext, /only confirmed history may return|new epoch prompt/);
      assert.equal(
        (await result.store.events(result.sessionId))
          .filter((event) => event.type === "runtime/epoch-replaced").length,
        2,
      );
    } finally {
      await result.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("matrix: unclaimed prepared turns do not block owned recovery forever", async () => {
  const fixture = await createLocalOwnedFixture();
  try {
    const first = await fixture.boot();
    await fixture.inject({ kind: "delete-database" });
    const second = await fixture.boot();
    const result = await sendAfterBreak(first.endpoint, second.endpoint, {
      preparedText: "prepared but never admitted",
      continueText: "new epoch prompt",
    });
    try {
      const prepared = await result.store.operation(result.prepared!.operationId);
      assert.equal(prepared?.state, "rejected");
      assert.equal(prepared?.code, "runtime-epoch-replaced-before-execution");
      assert.equal((await result.store.projection(result.sessionId))?.runtimeBinding?.epoch, 1);
      assert.doesNotMatch(
        latestRecoveryContext(await result.store.events(result.sessionId)),
        /prepared but never admitted/,
      );
    } finally {
      await result.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("matrix: binding-mismatch marks epoch-pending without auto-replace", async () => {
  const endpoint: RuntimeEndpoint = {
    authorityId: "owned:replacement",
    continuity: "verified",
    generation: 1,
    url: "http://runtime.invalid",
    location: { directory: "/project" },
    control: { kind: "owned", instanceToken: "replacement" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const harness = createSessionReliabilityHarness({
    runtime: createEpochRuntime(endpoint),
    prefix: "polyth-matrix-pending-",
  });
  const sessionId = "session-pending";
  try {
    await persistBoundSession(
      harness.store,
      harness.project,
      endpoint,
      sessionId,
      "backend-old",
      "owned:destroyed",
    );
    await harness.sessions.events(sessionId, 0);
    const pending = await harness.store.projection(sessionId);
    assert.equal(pending?.status, "epoch-pending");
    assert.equal(pending?.runtimeControl, "owned");
    assert.equal(
      (await harness.store.events(sessionId)).some((event) => event.type === "runtime/epoch-replaced"),
      false,
    );
    const debug = await harness.sessions.debug?.(sessionId);
    assert.equal(debug?.status, "epoch-pending");
  } finally {
    await harness.dispose();
  }
});

test("matrix: canRebindPersistedSession stays epoch-unaware", () => {
  assertCanRebindUnchanged();
});

test("race: concurrent owned sends after authority loss commit one epoch", async () => {
  const fixture = await createLocalOwnedFixture();
  try {
    const first = await fixture.boot();
    await fixture.inject({ kind: "wipe-runtime" });
    const second = await fixture.boot();
    const submitted: string[] = [];
    const harness = createSessionReliabilityHarness({
      runtime: createEpochRuntime(second.endpoint, submitted, "backend-new"),
      prefix: "polyth-matrix-race-send-",
    });
    const sessionId = "session-race";
    try {
      await persistBoundSession(
        harness.store,
        harness.project,
        first.endpoint,
        sessionId,
        "backend-old",
        first.endpoint.authorityId,
      );
      const results = await Promise.allSettled([
        harness.sessions.send(sessionId, { text: "first racer" }),
        harness.sessions.send(sessionId, { text: "second racer" }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length >= 1, true);
      assert.equal(
        (await harness.store.events(sessionId))
          .filter((event) => event.type === "runtime/epoch-replaced").length,
        1,
      );
      const projection = await harness.store.projection(sessionId);
      assert.equal(projection?.runtimeBinding?.epoch, 1);
      assert.equal(projection?.runtimeBinding?.authorityId, second.endpoint.authorityId);
    } finally {
      await harness.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test("race: hold backend then crash after admission stays unknown until owned epoch", async () => {
  const fake = await createFakeOpenCode();
  try {
    const barrier = runtimeFailureActions.holdBackend(fake, "POST", "/session/ses_hold/prompt_async");
    runtimeFailureActions.crashAfterAdmission(fake, "POST", "/session/ses_hold/prompt_async");
    assert.equal(typeof barrier.release, "function");
    await runtimeFailureActions.killTransport(fake);
  } finally {
    await fake.close().catch(() => undefined);
  }
});

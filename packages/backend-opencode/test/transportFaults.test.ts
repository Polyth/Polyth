import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOpenCodeTransport,
  OpenCodeDeadlineError,
  type OpenCodeSseEvent,
  type TransportHttpResponse,
} from "../src/transport.ts";
import {
  createFakeBarrier,
  createFakeOpenCode,
  httpFaults,
} from "./fakeOpenCode.ts";

test("POST accepted then closed is one attempt with an unknown outcome", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptHttp({
    method: "POST",
    path: "/session",
    steps: [httpFaults.acceptThenClose({ backendSessionId: "ses_committed" })],
  });
  const transport = createOpenCodeTransport({
    baseUrl: fake.baseUrl,
    retryDelayMs: 0,
  });

  try {
    const result = await transport.mutate<{ id: string }>({
      method: "POST",
      path: "/session",
      body: { title: "one logical session" },
      operationId: "op_create_1",
      deadlineMs: 500,
      replay: { kind: "never" },
    });

    assert.deepEqual(result.kind, "unknown");
    assert.equal(
      result.kind === "unknown" ? result.operationId : undefined,
      "op_create_1",
    );
    assert.equal(fake.requestCount("POST", "/session"), 1);
    assert.equal(fake.commits().length, 1);
    assert.deepEqual(fake.commits()[0]?.persisted, {
      backendSessionId: "ses_committed",
    });
  } finally {
    await fake.close();
  }
});

test("queries retry transient socket failures but default mutations do not", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptHttp({
    method: "GET",
    path: "/provider",
    steps: [
      httpFaults.connectionReset(),
      httpFaults.connectionReset(),
      httpFaults.success({ ok: true }),
    ],
  });
  fake.scriptHttp({
    method: "PATCH",
    path: "/session/ses_1",
    steps: [httpFaults.connectionReset(), httpFaults.success({ ok: true })],
  });
  const transport = createOpenCodeTransport({
    baseUrl: fake.baseUrl,
    queryAttempts: 3,
    retryDelayMs: 0,
  });

  try {
    const response = await transport.query<TransportHttpResponse<{ ok: boolean }>>({
      method: "GET",
      path: "/provider",
      deadlineMs: 1_000,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
    assert.equal(fake.requestCount("GET", "/provider"), 3);

    const mutation = await transport.mutate<{ ok: boolean }>({
      method: "PATCH",
      path: "/session/ses_1",
      operationId: "op_patch_never",
      deadlineMs: 1_000,
      replay: { kind: "never" },
    });
    assert.equal(mutation.kind, "unknown");
    assert.equal(fake.requestCount("PATCH", "/session/ses_1"), 1);
  } finally {
    await fake.close();
  }
});

test("only pinned PUT/PATCH contracts replay; POST stays one-shot", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptHttp({
    method: "PUT",
    path: "/v2/session/ses_1",
    steps: [httpFaults.connectionReset(), httpFaults.success({ ok: true })],
  });
  fake.scriptHttp({
    method: "POST",
    path: "/v2/session",
    steps: [httpFaults.connectionReset(), httpFaults.success({ ok: true })],
  });
  const transport = createOpenCodeTransport({
    baseUrl: fake.baseUrl,
    retryDelayMs: 0,
    pinnedReplayContracts: new Set(["v2-session-update@1.2.3"]),
  });

  try {
    const put = await transport.mutate<{ ok: boolean }>({
      method: "PUT",
      path: "/v2/session/ses_1",
      operationId: "op_put_1",
      deadlineMs: 1_000,
      replay: {
        kind: "same-operation-id",
        contract: "v2-session-update@1.2.3",
      },
    });
    assert.equal(put.kind, "response");
    assert.equal(fake.requestCount("PUT", "/v2/session/ses_1"), 2);

    const post = await transport.mutate<{ ok: boolean }>({
      method: "POST",
      path: "/v2/session",
      operationId: "op_post_pinned",
      deadlineMs: 1_000,
      replay: {
        kind: "same-operation-id",
        contract: "v2-session-update@1.2.3",
      },
    });
    assert.equal(post.kind, "unknown");
    assert.equal(fake.requestCount("POST", "/v2/session"), 1);
  } finally {
    await fake.close();
  }
});

test("a REST endpoint that never sends headers is bounded by one overall deadline", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptHttp({
    method: "GET",
    path: "/health",
    steps: [httpFaults.delayForever()],
  });
  const transport = createOpenCodeTransport({
    baseUrl: fake.baseUrl,
    queryAttempts: 3,
    retryDelayMs: 0,
  });
  const started = Date.now();

  try {
    await assert.rejects(
      transport.query<TransportHttpResponse>({
        method: "GET",
        path: "/health",
        deadlineMs: 80,
      }),
      (error: Error) => error instanceof OpenCodeDeadlineError,
    );
    assert.ok(Date.now() - started < 1_000);
    assert.equal(fake.requestCount("GET", "/health"), 1);
  } finally {
    await fake.close();
  }
});

test("headers followed by a stalled body remain inside the REST deadline", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptHttp({
    method: "GET",
    path: "/session",
    steps: [httpFaults.headersThenStall(`{"partial":`)],
  });
  const transport = createOpenCodeTransport({
    baseUrl: fake.baseUrl,
    queryAttempts: 1,
  });
  const started = Date.now();

  try {
    await assert.rejects(
      transport.query<TransportHttpResponse>({
        method: "GET",
        path: "/session",
        deadlineMs: 80,
      }),
      (error: Error) => error instanceof OpenCodeDeadlineError,
    );
    assert.ok(Date.now() - started < 1_000);
    assert.equal(fake.requestCount("GET", "/session"), 1);
  } finally {
    await fake.close();
  }
});

test("mutation deadline is unknown after one attempt", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptHttp({
    method: "DELETE",
    path: "/session/ses_1",
    steps: [httpFaults.delayForever({ commit: true })],
  });
  const transport = createOpenCodeTransport({ baseUrl: fake.baseUrl });

  try {
    const result = await transport.mutate({
      method: "DELETE",
      path: "/session/ses_1",
      operationId: "op_delete_1",
      deadlineMs: 80,
      replay: { kind: "never" },
    });
    assert.deepEqual(result.kind, "unknown");
    assert.equal(fake.requestCount("DELETE", "/session/ses_1"), 1);
    assert.equal(fake.commits().length, 1);
  } finally {
    await fake.close();
  }
});

test("complete HTTP errors are returned without status interpretation or retry", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptHttp({
    method: "POST",
    path: "/session",
    steps: [httpFaults.status(500, { error: "ambiguous to protocol" })],
  });
  const transport = createOpenCodeTransport({ baseUrl: fake.baseUrl });

  try {
    const result = await transport.mutate<{ error: string }>({
      method: "POST",
      path: "/session",
      operationId: "op_http_500",
      deadlineMs: 500,
      replay: { kind: "never" },
    });
    assert.equal(result.kind, "response");
    if (result.kind === "response") {
      assert.equal(result.status, 500);
      assert.equal(result.headers["content-type"], "application/json");
      assert.deepEqual(result.body, { error: "ambiguous to protocol" });
    }
    assert.equal(fake.requestCount("POST", "/session"), 1);
  } finally {
    await fake.close();
  }
});

test("SSE remains live beyond a finite REST deadline and ends on cancellation", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptHttp({
    method: "GET",
    path: "/health",
    steps: [httpFaults.delayForever()],
  });
  const transport = createOpenCodeTransport({
    baseUrl: fake.baseUrl,
    queryAttempts: 1,
  });
  const controller = new AbortController();
  let resolveEvent!: (event: OpenCodeSseEvent) => void;
  const received = new Promise<OpenCodeSseEvent>((resolve) => {
    resolveEvent = resolve;
  });
  const stream = transport.stream({
    path: "/event",
    signal: controller.signal,
    onEvent(value) {
      resolveEvent(value as OpenCodeSseEvent);
    },
  });

  try {
    await fake.waitForSseConnections();
    await assert.rejects(
      transport.query<TransportHttpResponse>({
        method: "GET",
        path: "/health",
        deadlineMs: 80,
      }),
      OpenCodeDeadlineError,
    );

    fake.emitSse({ id: "evt_after_deadline", data: { type: "still.live" } });
    assert.deepEqual(await received, {
      id: "evt_after_deadline",
      data: { type: "still.live" },
    });

    controller.abort();
    await assert.rejects(stream, (error: Error) => error.name === "AbortError");
    await fake.waitForSseDisconnects();
  } finally {
    controller.abort();
    await fake.close();
  }
});

test("fault fake scripts dropped, duplicated, disconnected, and non-replayed SSE", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptSse(
    {
      replay: "none",
      dropEventTypes: ["drop.me"],
      duplicateEventTypes: ["duplicate.me"],
      disconnectAfterEvent: 2,
    },
    { replay: "none" },
  );
  const transport = createOpenCodeTransport({ baseUrl: fake.baseUrl });
  const firstController = new AbortController();
  const firstEvents: OpenCodeSseEvent[] = [];
  const firstStream = transport.stream({
    path: "/event",
    signal: firstController.signal,
    onEvent(value) {
      firstEvents.push(value as OpenCodeSseEvent);
    },
  });

  try {
    await fake.waitForSseConnections(1);
    fake.emitSse({ id: "drop", data: { type: "drop.me" } });
    fake.emitSse({ id: "duplicate", data: { type: "duplicate.me" } });
    fake.emitSse({ id: "disconnect", data: { type: "normal" } });
    await firstStream;
    assert.deepEqual(
      firstEvents.map((event) => event.id),
      ["duplicate", "duplicate", "disconnect"],
    );

    fake.emitSse({ id: "missed", data: { type: "while.disconnected" } });
    const secondController = new AbortController();
    const secondEvents: OpenCodeSseEvent[] = [];
    const secondStream = transport.stream({
      path: "/event",
      signal: secondController.signal,
      onEvent(value) {
        secondEvents.push(value as OpenCodeSseEvent);
        secondController.abort();
      },
    });
    await fake.waitForSseConnections(2);
    fake.emitSse({ id: "fresh", data: { type: "after.reconnect" } });
    await assert.rejects(secondStream, (error: Error) => error.name === "AbortError");
    assert.deepEqual(
      secondEvents.map((event) => event.id),
      ["fresh"],
    );
  } finally {
    firstController.abort();
    await fake.close();
  }
});

test("fault fake retains missed attention and turn state for pull reconciliation", async () => {
  const fake = await createFakeOpenCode();
  try {
    const session = fake.lifecycle.createSession({ id: "ses_state" });
    fake.lifecycle.addPermission(
      session.id,
      { id: "per_missed", permission: "bash", patterns: ["npm test"] },
      { emit: false },
    );
    fake.lifecycle.addQuestion(
      session.id,
      { id: "que_missed", questions: [{ question: "Continue?" }] },
      { emit: false },
    );
    fake.lifecycle.acceptMessage(session.id, { text: "accepted offline" }, {
      emit: false,
    });
    assert.equal(fake.lifecycle.session(session.id)?.status, "busy");
    assert.equal(fake.lifecycle.pendingPermissions()[0]?.id, "per_missed");
    assert.equal(fake.lifecycle.pendingQuestions()[0]?.id, "que_missed");

    fake.lifecycle.finishTurn(session.id, { emit: false });
    assert.equal(fake.lifecycle.session(session.id)?.status, "idle");
    assert.equal(fake.lifecycle.session(session.id)?.messages[0]?.finished, true);
  } finally {
    await fake.close();
  }
});

test("fault fake exposes legacy doc/status and deterministic delayed snapshots", async () => {
  const fake = await createFakeOpenCode();
  const delayed = createFakeBarrier();
  fake.lifecycle.createSession({ id: "ses_snapshot" });
  fake.lifecycle.setBusy("ses_snapshot", { emit: false });
  fake.scriptHttp({
    method: "GET",
    path: "/session/status",
    steps: [
      httpFaults.barrier(
        delayed,
        httpFaults.success({
          ses_snapshot: { type: "busy", revision: "status:old-generation" },
        }),
      ),
    ],
  });
  const client = createOpenCodeTransport({
    baseUrl: fake.baseUrl,
    queryAttempts: 1,
  });
  try {
    const document = await client.query<TransportHttpResponse<{ paths?: unknown }>>({
      method: "GET",
      path: "/doc",
      deadlineMs: 500,
    });
    assert.equal(document.status, 200);
    assert.ok(document.body.paths);

    const snapshot = client.query<TransportHttpResponse>({
      method: "GET",
      path: "/session/status",
      deadlineMs: 500,
    });
    await delayed.reached;
    assert.equal(fake.requestCount("GET", "/session/status"), 1);
    delayed.release();
    assert.deepEqual((await snapshot).body, {
      ses_snapshot: { type: "busy", revision: "status:old-generation" },
    });
  } finally {
    delayed.release();
    await fake.close();
  }
});

test("fault fake reorders replay, supports silent streams, and restarts on a new endpoint", async () => {
  const fake = await createFakeOpenCode();
  const session = fake.lifecycle.createSession({
    id: "ses_restart",
    operationId: "op_create_restart",
  });
  fake.lifecycle.acceptMessage(
    session.id,
    { parts: [{ type: "text", text: "retained" }] },
    { emit: false, operationId: "op_message_restart" },
  );
  fake.emitSse({ id: "one", data: { type: "first" } });
  fake.emitSse({ id: "two", data: { type: "second" } });
  fake.scriptSse({ replay: "all", reorder: [1, 0] }, { silent: true });
  const transport = createOpenCodeTransport({ baseUrl: fake.baseUrl });
  const firstController = new AbortController();
  const replayed: string[] = [];
  const first = transport.stream({
    path: "/event",
    signal: firstController.signal,
    onEvent(value) {
      replayed.push((value as OpenCodeSseEvent).id ?? "");
      if (replayed.length === 2) firstController.abort();
    },
  });
  let restarted: Awaited<ReturnType<typeof createFakeOpenCode>> | undefined;
  try {
    await assert.rejects(first, (error: Error) => error.name === "AbortError");
    assert.deepEqual(replayed, ["two", "one"]);

    const silentController = new AbortController();
    const silent = transport.stream({
      path: "/event",
      signal: silentController.signal,
      onEvent() {
        assert.fail("silent SSE script emitted an event");
      },
    });
    await fake.waitForSseConnections(2);
    silentController.abort();
    await assert.rejects(silent, (error: Error) => error.name === "AbortError");

    await fake.crash();
    restarted = await fake.restart();
    assert.notEqual(restarted.baseUrl, fake.baseUrl);
    assert.equal(restarted.lifecycle.session("ses_restart")?.messages.length, 1);
    assert.equal(
      restarted.lifecycle.session("ses_restart")?.messages[0]?.operationId,
      "op_message_restart",
    );
  } finally {
    firstController.abort();
    await fake.close();
    if (restarted) await restarted.close();
  }
});

test("fault fake rotates endpoint auth and survives consumer shutdown", async () => {
  const authorization = (username: string, password: string): string =>
    `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const fake = await createFakeOpenCode({
    basicAuth: { username: "first-user", password: "first-password" },
  });
  fake.lifecycle.createSession({ id: "ses_auth_rotation" });
  const firstTransport = createOpenCodeTransport({
    baseUrl: fake.baseUrl,
    headers: {
      authorization: authorization("first-user", "first-password"),
    },
  });
  const consumer = new AbortController();
  const stream = firstTransport.stream({
    path: "/event",
    signal: consumer.signal,
    onEvent() {},
  });
  let restarted: Awaited<ReturnType<typeof createFakeOpenCode>> | undefined;
  try {
    await fake.waitForSseConnections();
    consumer.abort();
    await assert.rejects(stream, (error: Error) => error.name === "AbortError");

    // Disconnecting the Polyth-side consumer does not stop the borrowed
    // service: its real HTTP endpoint remains available.
    const stillRunning = await firstTransport.query<
      TransportHttpResponse<{ healthy: boolean }>
    >({
      method: "GET",
      path: "/global/health",
      deadlineMs: 500,
    });
    assert.equal(stillRunning.status, 200);
    assert.equal(stillRunning.body.healthy, true);

    await fake.crash();
    restarted = await fake.restart({
      basicAuth: { username: "second-user", password: "second-password" },
    });
    assert.notEqual(restarted.baseUrl, fake.baseUrl);
    assert.ok(restarted.lifecycle.session("ses_auth_rotation"));

    const staleCredentials = createOpenCodeTransport({
      baseUrl: restarted.baseUrl,
      headers: {
        authorization: authorization("first-user", "first-password"),
      },
      queryAttempts: 1,
    });
    const rejected = await staleCredentials.query<TransportHttpResponse>({
      method: "GET",
      path: "/global/health",
      deadlineMs: 500,
    });
    assert.equal(rejected.status, 401);

    const rotatedCredentials = createOpenCodeTransport({
      baseUrl: restarted.baseUrl,
      headers: {
        authorization: authorization("second-user", "second-password"),
      },
      queryAttempts: 1,
    });
    const accepted = await rotatedCredentials.query<TransportHttpResponse>({
      method: "GET",
      path: "/global/health",
      deadlineMs: 500,
    });
    assert.equal(accepted.status, 200);
  } finally {
    consumer.abort();
    await fake.close();
    if (restarted) await restarted.close();
  }
});

test("generic transport never inherits legacy environment credentials", async () => {
  const previousUsername = process.env.OPENCODE_SERVER_USERNAME;
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
  process.env.OPENCODE_SERVER_USERNAME = "must-not-leak";
  process.env.OPENCODE_SERVER_PASSWORD = "transport-secret";
  const fake = await createFakeOpenCode();
  const transport = createOpenCodeTransport({
    baseUrl: fake.baseUrl,
    queryAttempts: 1,
  });
  try {
    await transport.query<TransportHttpResponse>({
      method: "GET",
      path: "/global/health",
      deadlineMs: 500,
    });
    const request = fake.requests().find((candidate) =>
      candidate.method === "GET" && candidate.path === "/global/health");
    assert.ok(request);
    assert.equal(request.headers.authorization, undefined);
  } finally {
    if (previousUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME;
    else process.env.OPENCODE_SERVER_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = previousPassword;
    await fake.close();
  }
});

test("malformed and truncated responses exercise distinct real-socket body faults", async () => {
  const fake = await createFakeOpenCode();
  fake.scriptHttp({
    method: "GET",
    path: "/malformed",
    steps: [httpFaults.malformedJson()],
  });
  fake.scriptHttp({
    method: "GET",
    path: "/truncated",
    steps: [httpFaults.truncateBody(`{"complete":true}`, 5)],
  });
  const transport = createOpenCodeTransport({
    baseUrl: fake.baseUrl,
    queryAttempts: 1,
  });
  try {
    const malformed = await transport.query<TransportHttpResponse>({
      method: "GET",
      path: "/malformed",
      deadlineMs: 500,
    });
    assert.equal(malformed.body, `{"broken":`);
    await assert.rejects(
      transport.query({
        method: "GET",
        path: "/truncated",
        deadlineMs: 500,
      }),
      /terminated|closed|fetch failed/i,
    );
  } finally {
    await fake.close();
  }
});

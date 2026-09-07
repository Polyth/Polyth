import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type {
  MutationTransportResult,
  OpenCodeTransport,
  RuntimeEndpoint,
  RuntimeSessionBinding,
} from "@polyth/contracts";
import {
  asOcEvent,
  createTranslateState,
  translateOcEvent,
} from "../src/events.ts";
import {
  createV2ProtocolAdapter,
  flattenV2Models,
} from "../src/protocolV2.ts";

const endpoint: RuntimeEndpoint = {
  authorityId: "v2-test",
  continuity: "generation-only",
  generation: 1,
  url: "http://opencode.test",
  location: { directory: "/workspace/project", workspace: "worktree-a" },
  control: { kind: "borrowed", source: "external" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
};

const binding = (backendSessionId?: string): RuntimeSessionBinding => ({
  canonicalSessionId: "canonical-a",
  ...(backendSessionId ? { backendSessionId } : {}),
  authorityId: endpoint.authorityId,
  generation: endpoint.generation,
  continuity: "generation-only",
  location: endpoint.location,
});

const httpResponse = (
  body: unknown,
  status = 200,
): { status: number; headers: Record<string, string>; body: unknown } => ({
  status,
  headers: {},
  body,
});

interface MutationCall {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  operationId: string;
  deadlineMs: number;
  replay: { kind: "never" } | { kind: "same-operation-id"; contract: string };
}

interface QueryCall {
  method: "GET" | "HEAD";
  path: string;
  deadlineMs: number;
}

interface TransportMutationCall extends MutationCall {
  deadlineMs: number;
  replay: { kind: "never" } | { kind: "same-operation-id"; contract: string };
}

const transportDouble = (options: {
  query: (path: string) => unknown | Promise<unknown>;
  mutate?: (
    call: MutationCall,
  ) => MutationTransportResult<unknown> | Promise<MutationTransportResult<unknown>>;
}) => {
  const queries: string[] = [];
  const mutations: MutationCall[] = [];
  const transport: OpenCodeTransport = {
    async query<T>(request: QueryCall): Promise<T> {
      queries.push(request.path);
      return await options.query(request.path) as T;
    },
    async mutate<T>(request: TransportMutationCall): Promise<MutationTransportResult<T>> {
      mutations.push(request);
      if (!options.mutate) throw new Error("mutation not scripted");
      return await options.mutate(request) as MutationTransportResult<T>;
    },
    async stream(): Promise<void> {},
  };
  return { transport, queries, mutations };
};

const fixture = async (): Promise<unknown> =>
  JSON.parse(
    await readFile(new URL("./fixtures/v2-models.json", import.meta.url), "utf8"),
  ) as unknown;

const providerBody = {
  location: { directory: "/workspace" },
  data: [
    { id: "opencode", name: "OpenCode Zen" },
    { id: "google", name: "Google" },
  ],
};

test("captured V2 model fixture flattens to a non-empty protocol-neutral catalog", async () => {
  const models = flattenV2Models(await fixture(), providerBody);
  assert.equal(models.length, 2, "enabled:false models are excluded");
  assert.deepEqual(models[0], {
    providerID: "opencode",
    modelID: "big-pickle",
    name: "Big Pickle",
    providerName: "OpenCode Zen",
    context: 200000,
    cost: { input: 0, output: 0 },
    capabilities: ["toolcall", "input:text", "output:text"],
    connected: true,
  });
  assert.deepEqual(models[1]?.variants, ["high"]);
  assert.deepEqual(models[1]?.capabilities, [
    "input:image",
    "input:text",
    "output:image",
    "output:text",
  ]);
});

test("healthy V2 model discovery queries native endpoints and never loses upstream models", async () => {
  const modelBody = await fixture();
  const fake = transportDouble({
    query: (path) => path.startsWith("/api/model?")
      ? httpResponse(modelBody)
      : httpResponse(providerBody),
  });
  const adapter = createV2ProtocolAdapter({
    transport: fake.transport,
    endpoint,
    deadlineMs: 50,
  });

  const models = await adapter.models();
  assert.equal(models.length, 2);
  assert.ok(models.every((model) => model.providerID && model.modelID && model.name));
  assert.match(fake.queries[0]!, /^\/api\/model\?/);
  assert.match(fake.queries[0]!, /location%5Bdirectory%5D=%2Fworkspace%2Fproject/);
  assert.match(fake.queries[0]!, /location%5Bworkspace%5D=worktree-a/);
  assert.match(fake.queries[1]!, /^\/api\/provider\?/);
});

test("V2 model discovery distinguishes empty upstream data from failures", async (t) => {
  await t.test("an empty catalog is authoritative when no provider is connected", async () => {
    const fake = transportDouble({
      query: (path) => httpResponse(path.startsWith("/api/model?")
        ? { location: endpoint.location, data: [] }
        : { location: endpoint.location, data: [] }),
    });
    const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint });
    assert.deepEqual(await adapter.models(), []);
  });

  await t.test("a transient empty catalog from connected providers is retried", async () => {
    let modelQueries = 0;
    const modelBody = await fixture();
    const fake = transportDouble({
      query: (path) => {
        if (!path.startsWith("/api/model?")) return httpResponse(providerBody);
        modelQueries += 1;
        return httpResponse(modelQueries === 1
          ? { location: endpoint.location, data: [] }
          : modelBody);
      },
    });
    const adapter = createV2ProtocolAdapter({
      transport: fake.transport,
      endpoint,
    });

    assert.equal((await adapter.models()).length, 2);
    assert.equal(modelQueries, 2);
  });

  await t.test("a persistently empty connected catalog surfaces backend-not-ready", async () => {
    const fake = transportDouble({
      query: (path) => httpResponse(path.startsWith("/api/model?")
        ? { location: endpoint.location, data: [] }
        : providerBody),
    });
    const adapter = createV2ProtocolAdapter({
      transport: fake.transport,
      endpoint,
    });

    await assert.rejects(
      () => adapter.models(),
      (error: Error & { code?: string }) =>
        error.code === "backend-not-ready"
        && /connected providers returned no models/.test(error.message),
    );
  });

  await t.test("HTTP 500 throws with status and path", async () => {
    const fake = transportDouble({
      query: () => httpResponse({ message: "catalog unavailable" }, 500),
    });
    const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint });
    await assert.rejects(
      () => adapter.models(),
      (error: Error & { code?: string; status?: number; path?: string }) =>
        error.code === "http-500"
        && error.status === 500
        && error.path?.startsWith("/api/model?") === true,
    );
  });

  await t.test("provider discovery failure is explicit and never becomes an empty catalog", async () => {
    const fake = transportDouble({
      query: async (path) => path.startsWith("/api/model?")
        ? httpResponse(await fixture())
        : httpResponse({ message: "provider catalog unavailable" }, 503),
    });
    const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint });
    await assert.rejects(
      () => adapter.models(),
      (error: Error & { code?: string; status?: number; path?: string }) =>
        error.message === "provider catalog unavailable"
        && error.code === "http-503"
        && error.status === 503
        && error.path?.startsWith("/api/provider?") === true,
    );
  });

  await t.test("model without an active provider is retained but disconnected", async () => {
    const models = flattenV2Models(await fixture(), {
      location: endpoint.location,
      data: [{ id: "google", name: "Google" }],
    });
    assert.equal(models.find((model) => model.providerID === "opencode")?.connected, false);
    assert.equal(models.find((model) => model.providerID === "google")?.connected, true);
  });

  await t.test("timeout or connection failure throws", async () => {
    const fake = transportDouble({
      query: () => {
        throw Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" });
      },
    });
    const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint });
    await assert.rejects(() => adapter.models(), /connection timed out/);
  });

  await t.test("successful non-JSON response throws", async () => {
    const fake = transportDouble({ query: () => httpResponse("<html>bad gateway</html>") });
    const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint });
    await assert.rejects(
      () => adapter.models(),
      (error: Error & { code?: string }) => error.code === "protocol-response-invalid",
    );
  });
});

test("V2 provider listing and auth methods use native endpoints", async () => {
  const fake = transportDouble({
    query: (path) => path.startsWith("/provider/auth?")
      ? httpResponse({ cursor: [{ type: "oauth", label: "Sign in" }] })
      : httpResponse({
          all: [
            { id: "cursor", name: "Cursor" },
            { id: "bad", name: "" },
          ],
        }),
    mutate: (call) => ({
      kind: "response",
      status: 200,
      headers: {},
      body: call.path.includes("/oauth/authorize?")
        ? { url: "https://cursor.test/login", method: "code", instructions: "Sign in" }
        : true,
    }),
  });
  const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint });

  assert.deepEqual(await adapter.listAllProviders!(), [{ id: "cursor", name: "Cursor" }]);
  assert.deepEqual(await adapter.providerAuthMethods!(), {
    cursor: [{ type: "oauth", label: "Sign in", upstreamIndex: 0 }],
  });
  assert.deepEqual(
    await adapter.providerAuthorize!("cursor", 0, { instance: "cloud" }),
    { url: "https://cursor.test/login", method: "code", instructions: "Sign in" },
  );
  assert.equal(await adapter.providerAuthCallback!("cursor", 0, "auth-code"), true);
  assert.equal(await adapter.providerAuthCallback!("cursor", 0), true);
  assert.equal(await adapter.setProviderApiKey!("openai", "sk-test", { region: "us" }), true);
  assert.equal(await adapter.setProviderAuth!("https://org.example", { type: "wellknown", key: "OPENCODE_ORG_TOKEN", token: "tok" }), true);
  assert.equal(await adapter.removeProviderAuth!("openai"), true);

  assert.deepEqual(fake.mutations.map(({ method, path, body, replay }) => ({ method, path, body, replay })), [
    {
      method: "POST",
      path: "/provider/cursor/oauth/authorize?directory=%2Fworkspace%2Fproject&workspace=worktree-a",
      body: { method: 0, inputs: { instance: "cloud" } },
      replay: { kind: "never" },
    },
    {
      method: "POST",
      path: "/provider/cursor/oauth/callback?directory=%2Fworkspace%2Fproject&workspace=worktree-a",
      body: { method: 0, code: "auth-code" },
      replay: { kind: "never" },
    },
    {
      method: "POST",
      path: "/provider/cursor/oauth/callback?directory=%2Fworkspace%2Fproject&workspace=worktree-a",
      body: { method: 0 },
      replay: { kind: "never" },
    },
    {
      method: "PUT",
      path: "/auth/openai?directory=%2Fworkspace%2Fproject&workspace=worktree-a",
      body: { type: "api", key: "sk-test", metadata: { region: "us" } },
      replay: { kind: "never" },
    },
    {
      method: "PUT",
      path: "/auth/https%3A%2F%2Forg.example?directory=%2Fworkspace%2Fproject&workspace=worktree-a",
      body: { type: "wellknown", key: "OPENCODE_ORG_TOKEN", token: "tok" },
      replay: { kind: "never" },
    },
    {
      method: "DELETE",
      path: "/auth/openai?directory=%2Fworkspace%2Fproject&workspace=worktree-a",
      body: undefined,
      replay: { kind: "never" },
    },
  ]);
  assert.equal(fake.mutations[2]?.deadlineMs, 15 * 60 * 1000);
});

test("V2 auth method parsing keeps original upstream indices and ignores unknown types", async () => {
  const fake = transportDouble({
    query: (path) => path.startsWith("/provider/auth?")
      ? httpResponse({
          acme: [
            { type: "mystery", label: "Future" },
            { type: "oauth", label: "Browser" },
            { label: "missing type" },
            { type: "api", label: "API key", prompts: [{ type: "text", key: "region", message: "Region" }] },
          ],
        })
      : httpResponse({ all: [] }),
  });
  const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint });
  const methods = await adapter.providerAuthMethods!();
  assert.deepEqual(methods.acme?.map((item) => ({ type: item.type, index: item.upstreamIndex, label: item.label })), [
    { type: "oauth", index: 1, label: "Browser" },
    { type: "api", index: 3, label: "API key" },
  ]);
  assert.equal("providerAuthEntries" in adapter, false);
  assert.equal(fake.queries.some((path) => path.startsWith("/auth?") || path === "/auth"), false);
});

test("V2 core session methods use native paths and reconcile pending requests", async () => {
  let created = 0;
  const messageData = [
    { id: "msg_user", type: "user", text: "hello", time: { created: 1 } },
    {
      id: "msg_assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "opencode", id: "big-pickle" },
      time: { created: 2, completed: 3 },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      content: [{ id: "txt_1", type: "text", text: "world" }],
    },
  ];
  const fake = transportDouble({
    query: (path) => {
      if (path.startsWith("/api/agent?")) {
        return httpResponse({
          location: endpoint.location,
          data: [
            {
              id: "build",
              description: "Build agent",
              system: "Build things",
              mode: "primary",
              hidden: false,
            },
            { id: "internal", mode: "primary", hidden: true },
          ],
        });
      }
      if (path.startsWith("/api/session?")) {
        return httpResponse({
          data: [{
            id: "ses_existing",
            title: "Existing",
            time: { created: 1, updated: 2 },
          }],
          cursor: {},
        });
      }
      if (path.includes("/message?")) {
        return httpResponse({ data: messageData, cursor: {} });
      }
      if (path.startsWith("/api/session/active?")) {
        return httpResponse({ data: {} });
      }
      if (path.startsWith("/api/permission/request?")) {
        return httpResponse({
          location: endpoint.location,
          data: [{
            id: "per_1",
            sessionID: "ses_created_1",
            action: "edit",
            resources: ["src/a.ts"],
          }],
        });
      }
      if (path.startsWith("/api/question/request?")) {
        return httpResponse({
          location: endpoint.location,
          data: [{
            id: "que_1",
            sessionID: "ses_created_1",
            questions: [{ header: "Proceed?", options: [] }],
          }],
        });
      }
      if (path.startsWith("/api/session/ses_created_1?")) {
        return httpResponse({
          data: {
            id: "ses_created_1",
            title: "Created",
            time: { created: 1, updated: 1 },
          },
        });
      }
      throw new Error(`unexpected query ${path}`);
    },
    mutate: (call) => {
      if (call.path.startsWith("/api/session?")) {
        created += 1;
        return {
          kind: "response",
          status: 200,
          headers: {},
          body: { data: { id: `ses_created_${created}` } },
        };
      }
      if (call.path.includes("/prompt?")) {
        return {
          kind: "response",
          status: 200,
          headers: {},
          body: { data: { id: "msg_admitted" } },
        };
      }
      return { kind: "response", status: 204, headers: {}, body: undefined };
    },
  });
  const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint });

  assert.equal((await adapter.agents())[0]?.name, "build");
  assert.equal((await adapter.agents()).length, 1, "hidden internal agents stay hidden");
  assert.equal((await adapter.sessions())[0]?.id, "ses_existing");
  assert.deepEqual(await adapter.history(binding("ses_created_1")), [
    { role: "user", text: "hello" },
    { role: "assistant", text: "world" },
  ]);

  const ensured = await adapter.ensureSession(binding(), "op-create");
  assert.equal(ensured.kind, "confirmed");
  if (ensured.kind !== "confirmed") throw new Error("session was not created");
  assert.equal(ensured.value.backendSessionId, "ses_created_1");
  assert.deepEqual(fake.mutations[0]?.body, {
    location: { directory: "/workspace/project", workspaceID: "worktree-a" },
  });

  const live = binding(ensured.value.backendSessionId);
  const submitted = await adapter.submit({ session: live, text: "hello V2" }, "op-submit");
  assert.deepEqual(submitted, {
    kind: "confirmed",
    value: { admissionId: "msg_admitted" },
  });
  const steered = await adapter.steer({ session: live, text: "focus" }, "op-steer");
  assert.equal(steered.kind, "confirmed");
  assert.equal((fake.mutations.find((call) => call.operationId === "op-submit")?.body as {
    delivery?: string;
  }).delivery, "queue");
  assert.equal((fake.mutations.find((call) => call.operationId === "op-steer")?.body as {
    delivery?: string;
  }).delivery, "steer");

  assert.equal((await adapter.abort(live, "op-abort")).kind, "confirmed");
  assert.equal(
    (await adapter.replyPermission(live, "per_1", "once", "op-permission")).kind,
    "confirmed",
  );
  assert.equal(
    (await adapter.replyQuestion(
      live,
      "que_1",
      { answers: [["yes"]] },
      "op-question",
    )).kind,
    "confirmed",
  );
  assert.equal((await adapter.resetSession(live, undefined, "op-reset")).kind, "confirmed");

  const snapshot = await adapter.reconcile({
    ...live,
    reconciliationOrdinal: 7,
  });
  assert.equal(snapshot.reconciliationOrdinal, 7);
  assert.equal(snapshot.permissions[0]?.requestId, "per_1");
  assert.deepEqual(snapshot.permissions[0]?.patterns, ["src/a.ts"]);
  assert.equal(snapshot.questions[0]?.requestId, "que_1");
  assert.ok(snapshot.events.some((event) => event.event.type === "assistant/message"));
  assert.equal(
    snapshot.state.value,
    "unknown",
    "a submitted turn invalidates fresh-create idle evidence without a comparable terminal state",
  );
  assert.equal(adapter.eventStreamPath(), "/api/event");

  const branch = await adapter.branchSession({
    source: live,
    target: binding(),
    history: [],
  }, "op-branch");
  assert.deepEqual(branch, {
    kind: "rejected",
    code: "capability-unsupported",
    message: "OpenCode V2 does not expose a session fork/branch endpoint",
  });
  assert.equal((await adapter.deleteSession(live, "op-delete")).kind, "rejected");
});

test("V2 session and history reads follow cursor.next pagination", async () => {
  const fake = transportDouble({
    query: (path) => {
      if (path.startsWith("/api/session?") && !path.includes("cursor=")) {
        return httpResponse({
          data: [{ id: "ses_2", title: "Second", time: { created: 2, updated: 2 } }],
          cursor: { next: "session-page-2" },
        });
      }
      if (path.startsWith("/api/session?") && path.includes("cursor=session-page-2")) {
        return httpResponse({
          data: [{ id: "ses_1", title: "First", time: { created: 1, updated: 1 } }],
          cursor: {},
        });
      }
      if (path.includes("/message?") && !path.includes("cursor=")) {
        return httpResponse({
          data: [{ id: "msg_1", type: "user", text: "first" }],
          cursor: { next: "message-page-2" },
        });
      }
      if (path.includes("/message?") && path.includes("cursor=message-page-2")) {
        return httpResponse({
          data: [{
            id: "msg_2",
            type: "assistant",
            content: [{ id: "prt_2", type: "text", text: "second" }],
          }],
          cursor: {},
        });
      }
      throw new Error(`unexpected query ${path}`);
    },
  });
  const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint });

  assert.deepEqual((await adapter.sessions()).map((session) => session.id), ["ses_2", "ses_1"]);
  assert.deepEqual(await adapter.history(binding("ses_1")), [
    { role: "user", text: "first" },
    { role: "assistant", text: "second" },
  ]);
  const sessionPage = fake.queries.find((path) => path.includes("cursor=session-page-2"));
  const messagePage = fake.queries.find((path) => path.includes("cursor=message-page-2"));
  assert.ok(sessionPage);
  assert.ok(messagePage);
  assert.match(fake.queries[0]!, /[?&]limit=200(?:&|$)/);
  assert.match(
    fake.queries.find((path) => path.includes("/message?") && !path.includes("cursor="))!,
    /[?&]limit=200(?:&|$)/,
  );
  assert.doesNotMatch(sessionPage, /[?&]order=/);
  assert.doesNotMatch(messagePage, /[?&]order=/);
});

test("V2 history and reconcile never send OpenCode's rejected message limit", async () => {
  const realLimitError = {
    message: 'Expected a value less than or equal to 200, got 1000\n  at ["limit"]',
  };
  const fake = transportDouble({
    query: (path) => {
      if (path.includes("/message?")) {
        const limit = Number(new URL(path, "http://opencode.test").searchParams.get("limit"));
        if (limit > 200) return httpResponse(realLimitError, 400);
        return httpResponse({
          data: [{
            id: "msg_completed",
            type: "assistant",
            time: { created: 1, completed: 2 },
            content: [{ id: "part_completed", type: "text", text: "done" }],
          }],
          cursor: {},
        });
      }
      if (path.startsWith("/api/session/active?")) return httpResponse({ data: {} });
      if (path.startsWith("/api/permission/request?")) return httpResponse({ data: [] });
      if (path.startsWith("/api/question/request?")) return httpResponse({ data: [] });
      if (path.startsWith("/api/session/ses_limit?")) {
        return httpResponse({ data: { id: "ses_limit" } });
      }
      throw new Error(`unexpected query ${path}`);
    },
  });
  const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint });
  const live = binding("ses_limit");

  assert.deepEqual(await adapter.history(live), [{ role: "assistant", text: "done" }]);
  const snapshot = await adapter.reconcile({ ...live, reconciliationOrdinal: 4 });
  assert.ok(snapshot.events.some((event) => event.event.type === "assistant/message"));
  const messageQueries = fake.queries.filter((path) => path.includes("/message?"));
  assert.equal(messageQueries.length, 2);
  for (const path of messageQueries) {
    assert.equal(new URL(path, "http://opencode.test").searchParams.get("limit"), "200");
  }
});

test("V2 SSE frames normalize data payloads and native text events", () => {
  const direct = asOcEvent({
    id: "evt_direct",
    type: "message.part.delta",
    durable: { aggregateID: "ses_1", seq: 2, version: 2 },
    data: {
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "hi",
    },
  });
  assert.equal(direct?.properties?.sessionID, "ses_1");
  assert.deepEqual(direct?.durable, { aggregateID: "ses_1", seq: 2, version: 2 });
  assert.equal(asOcEvent({
    type: "permission.v2.asked",
    data: { sessionID: "ses_1", id: "permission_1" },
  })?.type, "permission.asked");
  assert.equal(asOcEvent({
    type: "question.v2.asked",
    data: { sessionID: "ses_1", id: "question_1" },
  })?.type, "question.asked");

  const state = createTranslateState();
  const started = asOcEvent({
    id: "evt_started",
    type: "session.next.text.started",
    data: {
      timestamp: 1,
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      textID: "txt_1",
    },
  });
  const delta = asOcEvent({
    id: "evt_delta",
    type: "session.next.text.delta",
    data: {
      timestamp: 2,
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      textID: "txt_1",
      delta: "hello",
    },
  });
  assert.ok(started);
  assert.ok(delta);
  assert.deepEqual(translateOcEvent(started, state), []);
  assert.deepEqual(translateOcEvent(delta, state), [{
    type: "assistant/chunk",
    partId: "txt_1",
    text: "hello",
  }]);
});

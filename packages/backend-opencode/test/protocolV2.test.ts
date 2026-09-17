import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type {
  MutationTransportResult,
  ObservationCheckpoint,
  OpenCodeTransport,
  RuntimeEndpoint,
  RuntimeSessionBinding,
} from "@polyth/contracts";
import {
  asOcEvent,
  createTranslateState,
  normalizeOcObservation,
  translateOcEvent,
} from "../src/events.ts";
import {
  createV2ProtocolAdapter,
  flattenV2Models,
} from "../src/protocolV2.ts";
import { pulledV2MessageEvents } from "../src/v2Reconciliation.ts";
import { v2FormAnswerOf, v2FormInfoOf } from "../src/v2Forms.ts";

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
      if (!options.mutate && request.path.startsWith("/api/plugin/await-activation?")) return { kind: "response", status: 204, headers: {}, body: undefined as T };
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
        if (path.startsWith("/api/integration?")) return httpResponse({ data: [] });
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
      query: (path) => httpResponse(path.startsWith("/api/model?") || path.startsWith("/api/integration?")
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
        error.message.includes("/api/provider")
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
      if (path.startsWith("/api/session/ses_created_1/permission?")) {
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
      if (path.startsWith("/api/session/ses_created_1/form?")) {
        return httpResponse({
          data: [{
            id: "frm_1",
            sessionID: "ses_created_1",
            title: "Release checklist",
            fields: [
              { key: "count", type: "integer", title: "Count", required: true },
              { key: "proceed", type: "boolean", title: "Proceed", required: true },
            ],
          }],
        });
      }
      if (path.startsWith("/api/session/ses_created_1/form/frm_1?")) {
        return httpResponse({
          data: {
            id: "frm_1",
            sessionID: "ses_created_1",
            title: "Release checklist",
            fields: [
              { key: "count", type: "integer", title: "Count", required: true },
              { key: "proceed", type: "boolean", title: "Proceed", required: true },
            ],
          },
        });
      }
      if (path.startsWith("/api/session/ses_created_1/todo?")) {
        return httpResponse({
          data: [{
            id: "todo-v2",
            content: "Render current tasks on mobile",
            status: "in_progress",
            priority: "high",
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
      if (call.path.includes("/interrupt?")) {
        return { kind: "response", status: 200, headers: {}, body: { interrupted: true } };
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
  assert.deepEqual(fake.mutations.find((call) => call.operationId === "op-create")?.body, {
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
  }).delivery, "steer");
  assert.equal((fake.mutations.find((call) => call.operationId === "op-steer")?.body as {
    delivery?: string;
  }).delivery, "steer");
  assert.deepEqual(fake.mutations.find((call) => call.operationId === "op-submit")?.body, {
    text: "hello V2",
    delivery: "steer",
  });

  assert.equal((await adapter.abort(live, "op-abort")).kind, "confirmed");
  assert.equal(
    (await adapter.replyPermission(live, "per_1", "once", "op-permission")).kind,
    "confirmed",
  );
  assert.equal(
    (await adapter.replyQuestion(
      live,
      "frm_1",
      { answers: [["42"], ["true"]] },
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
  assert.equal(snapshot.questions[0]?.requestId, "frm_1");
  assert.deepEqual(snapshot.questions[0]?.questions.map((question) => question.id), ["count", "proceed"]);
  assert.deepEqual(
    snapshot.events.flatMap((entry) => entry.events).find((event) => event.type === "task/snapshot"),
    {
      type: "task/snapshot",
      listId: "todo",
      revision: 1,
      items: [{ id: "todo-v2", text: "Render current tasks on mobile", status: "active" }],
    },
  );
  assert.ok(snapshot.events.some((entry) => entry.events.some((event) => event.type === "assistant/message")));
  assert.equal(
    snapshot.state.value,
    "idle",
    "an inactive V2 session plus a completed assistant message is comparable terminal evidence",
  );
  assert.equal(adapter.eventStreamPath(), "/api/event");

  assert.equal((await adapter.deleteSession(live, "op-delete")).kind, "confirmed");
  assert.deepEqual(
    fake.mutations.find((call) => call.operationId === "op-question")?.body,
    { answer: { count: 42, proceed: true } },
  );
});

test("V2 fork and native command preserve exact released request and history evidence", async () => {
  const sourceRows = [
    { id: "msg_user", type: "user", text: "one", time: { created: 1 } },
    {
      id: "msg_assistant",
      type: "assistant",
      time: { created: 2, completed: 3 },
      content: [{ id: "txt_1", type: "text", text: "two" }],
    },
  ];
  const childRows = [sourceRows[0]];
  const fake = transportDouble({
    query: (path) => {
      if (path.startsWith("/api/session/ses_source/message?")) return httpResponse({ data: sourceRows, cursor: {} });
      if (path.startsWith("/api/session/ses_child/message?")) return httpResponse({ data: childRows, cursor: {} });
      throw new Error(`unexpected query ${path}`);
    },
    mutate: (call) => {
      if (call.path.startsWith("/api/session/ses_source/fork?")) {
        return { kind: "response", status: 200, headers: {}, body: { data: { id: "ses_child" } } };
      }
      if (call.path.startsWith("/api/session/ses_source/command?")) {
        return { kind: "response", status: 204, headers: {}, body: undefined };
      }
      throw new Error(`unexpected mutation ${call.path}`);
    },
  });
  const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint });
  const source = { ...binding("ses_source"), canonicalSessionId: "canonical-source" };
  const target = { ...binding(), canonicalSessionId: "canonical-child" };

  const branch = await adapter.branchSession({
    source,
    target,
    history: [{ role: "user", parts: [{ type: "text", text: "one" }] }],
  }, "op-fork");
  assert.equal(branch.kind, "confirmed");
  assert.deepEqual(fake.mutations[0]?.body, {
    boundary: { type: "before", messageID: "msg_assistant" },
  });
  assert.deepEqual(await adapter.submit({
    session: source,
    text: "/deploy production",
    command: { id: "native:deploy", owner: "native", name: "deploy", args: "production" },
  }, "op-command"), { kind: "confirmed", value: {} });
  assert.deepEqual(fake.mutations[1]?.body, {
    command: "deploy",
    text: "production",
    delivery: "queue",
  });
});

test("V2 mutation responses require their released response shape", async () => {
  const fake = transportDouble({
    query: () => httpResponse({ data: [] }),
    mutate: () => ({ kind: "response", status: 200, headers: {}, body: { unexpected: true } }),
  });
  const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint });
  const outcome = await adapter.deleteSession(binding("ses_1"), "op-delete-malformed");
  assert.equal(outcome.kind, "unknown");
});

test("V2 runtime attachments stay on their host and never read matching local files", async () => {
  const scopedEndpoint = { ...endpoint, location: { directory: "/remote/project" } };
  const fake = transportDouble({
    query: () => httpResponse({ data: [] }),
    mutate: () => ({ kind: "response", status: 200, headers: {}, body: { data: { id: "msg_1" } } }),
  });
  const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint: scopedEndpoint });
  const live = { ...binding("ses_1"), location: scopedEndpoint.location };
  assert.equal((await adapter.submit({
    session: live,
    text: "read this",
    attachments: [{ id: "attachment_1", name: "note.txt", mime: "text/plain", size: 5, path: "note.txt" }],
  }, "op-file")).kind, "confirmed");
  assert.deepEqual(fake.mutations[0]?.body, {
    text: "read this",
    files: [{ uri: "file:///remote/project/note.txt", name: "note.txt" }],
    delivery: "steer",
  });
});

test("V2 form replies recover typed answers and discard inactive generic rows", () => {
  const form = v2FormInfoOf({
    id: "frm_1",
    sessionID: "ses_1",
    title: "Conditional form",
    fields: [
      {
        key: "mode",
        type: "string",
        required: true,
        options: [{ value: "simple", label: "Simple" }, { value: "advanced", label: "Advanced" }],
      },
      { key: "detail", type: "integer", required: true, when: [{ key: "mode", op: "eq", value: "advanced" }] },
      { key: "visited", type: "external", url: "https://example.test/confirm" },
    ],
  }, "ses_1");
  assert.ok(form);
  assert.deepEqual(v2FormAnswerOf(form!, {
    answers: [["simple"], ["99"], ["true"]],
  }), {
    answer: { mode: "simple", visited: true },
  });
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
            // Released V2 AssistantText has no content id; recovery derives a
            // stable part key from the owning message and content position.
            content: [{ type: "text", text: "done" }],
          }],
          cursor: {},
        });
      }
      if (path.startsWith("/api/session/active?")) return httpResponse({ data: {} });
      if (path.startsWith("/api/session/ses_limit/todo?")) return httpResponse({ message: "not available" }, 404);
      if (path.startsWith("/api/session/ses_limit/permission?")) return httpResponse({ data: [] });
      if (path.startsWith("/api/session/ses_limit/form?")) return httpResponse({ data: [] });
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
  assert.ok(snapshot.events.some((entry) => entry.events.some((event) => event.type === "assistant/message")));
  const messageQueries = fake.queries.filter((path) => path.includes("/message?"));
  assert.equal(messageQueries.length, 2);
  for (const path of messageQueries) {
    assert.equal(new URL(path, "http://opencode.test").searchParams.get("limit"), "200");
  }
});

test("released V2 pull identities use the text and reasoning ordinals independently", () => {
  const events = pulledV2MessageEvents({
    id: "msg_parts",
    type: "assistant",
    time: { created: 1, completed: 2 },
    content: [
      { type: "reasoning", text: "plan" },
      { type: "text", text: "one" },
      { type: "text", text: "two" },
      { type: "reasoning", text: "check" },
    ],
  }, "ses_parts");
  assert.deepEqual(events.slice(1).map((event) => {
    const part = event.properties?.part as { id?: unknown } | undefined;
    return part?.id;
  }), [
    "msg_parts:reasoning:0",
    "msg_parts:text:0",
    "msg_parts:text:1",
    "msg_parts:reasoning:1",
  ]);
});

test("released V2 tool terminal checkpoints agree between SSE and pull", () => {
  const observed = {
    authorityId: endpoint.authorityId,
    generation: endpoint.generation,
    location: endpoint.location,
    backendSessionId: "ses_tools",
    reconciliationOrdinal: 1,
  };
  const normalize = (data: unknown, state = createTranslateState(), checkpoint?: unknown) =>
    normalizeOcObservation({
      data,
      channel: "sse",
      observed,
      current: observed,
      state,
      ...(checkpoint ? { checkpoint: checkpoint as never } : {}),
    });
  const native = (type: string, data: Record<string, unknown>) => ({
    id: `evt_${type.replaceAll(".", "_")}`,
    created: 1,
    type,
    durable: { aggregateID: "ses_tools", seq: 1, version: 2 },
    data: { sessionID: "ses_tools", assistantMessageID: "msg_tools", ...data },
  });
  const liveState = createTranslateState();
  normalize(native("session.tool.input.started", { id: "call_1", name: "read" }), liveState);
  normalize(native("session.tool.called", { id: "call_1", input: { path: "foo" }, executed: false }), liveState);
  const live = normalize(native("session.tool.success", {
    id: "call_1",
    content: [{ type: "text", text: "hello" }],
    executed: true,
  }), liveState);
  assert.equal(live.kind, "accepted");
  if (live.kind !== "accepted") throw new Error("live tool observation was not accepted");

  const pulled = pulledV2MessageEvents({
    id: "msg_tools",
    type: "assistant",
    time: { created: 1, completed: 2 },
    content: [{
      type: "tool",
      id: "call_1",
      name: "read",
      state: { status: "completed", input: { path: "foo" }, content: [{ type: "text", text: "hello" }] },
    }],
  }, "ses_tools").at(-1);
  assert.ok(pulled);
  const recovered = normalizeOcObservation({
    data: pulled,
    channel: "pull",
    observed,
    current: observed,
    state: createTranslateState(),
    checkpoint: live.observation.checkpoint as ObservationCheckpoint | undefined,
  });
  assert.equal(recovered.kind, "accepted");
  if (recovered.kind !== "accepted") throw new Error("pull tool observation was not accepted");
  assert.deepEqual(recovered.observation.checkpoint, live.observation.checkpoint);

  const errorState = createTranslateState();
  normalize(native("session.tool.input.started", { id: "call_2", name: "write" }), errorState);
  normalize(native("session.tool.called", { id: "call_2", input: { path: "bar" }, executed: false }), errorState);
  const liveError = normalize(native("session.tool.failed", {
    id: "call_2",
    error: { type: "tool.execution", message: "denied" },
    content: [{ type: "text", text: "partial result" }],
    executed: false,
  }), errorState);
  assert.equal(liveError.kind, "accepted");
  if (liveError.kind !== "accepted") throw new Error("live failed tool observation was not accepted");
  const pulledError = pulledV2MessageEvents({
    id: "msg_tools",
    type: "assistant",
    time: { created: 1, completed: 2 },
    content: [{
      type: "tool",
      id: "call_2",
      name: "write",
      state: { status: "error", input: { path: "bar" }, error: { type: "tool.execution", message: "denied" }, content: [{ type: "text", text: "partial result" }] },
    }],
  }, "ses_tools").at(-1);
  assert.ok(pulledError);
  const recoveredError = normalizeOcObservation({
    data: pulledError,
    channel: "pull",
    observed,
    current: observed,
    state: createTranslateState(),
    checkpoint: liveError.observation.checkpoint as ObservationCheckpoint | undefined,
  });
  assert.equal(recoveredError.kind, "accepted");
  if (recoveredError.kind !== "accepted") throw new Error("pull failed tool observation was not accepted");
  assert.deepEqual(recoveredError.observation.checkpoint, liveError.observation.checkpoint);
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
    type: "permission.asked",
    data: { sessionID: "ses_1", id: "permission_1" },
  })?.type, "permission.asked");
  const createdForm = asOcEvent({
    id: "evt_form",
    type: "form.created",
    data: {
      form: {
        id: "frm_1",
        sessionID: "ses_1",
        title: "Confirm",
        fields: [{ key: "approved", type: "boolean", title: "Approved", required: true }],
      },
    },
  });
  assert.ok(createdForm);
  assert.deepEqual(translateOcEvent(createdForm!, createTranslateState()), [{
    type: "question/asked",
    requestId: "frm_1",
    questions: [{
      id: "approved",
      title: "Approved",
      prompt: "Approved",
      type: "single",
      options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }],
      required: true,
    }],
  }]);

  const state = createTranslateState();
  const started = asOcEvent({
    id: "evt_started",
    created: 1,
    type: "session.text.started",
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      ordinal: 0,
    },
  });
  const delta = asOcEvent({
    id: "evt_delta",
    created: 2,
    type: "session.text.delta",
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      ordinal: 0,
      delta: "hello",
    },
  });
  const ended = asOcEvent({
    id: "evt_ended",
    created: 3,
    type: "session.text.ended",
    data: {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      ordinal: 0,
      text: "hello",
    },
  });
  assert.ok(started);
  assert.ok(delta);
  assert.ok(ended);
  assert.deepEqual(translateOcEvent(started, state), []);
  assert.deepEqual(translateOcEvent(delta, state), [{
    type: "assistant/chunk",
    partId: "msg_1:text:0",
    text: "hello",
  }]);
  assert.deepEqual(translateOcEvent(ended, state), [{
    type: "assistant/message",
    partId: "msg_1:text:0",
    text: "hello",
    tokens: undefined,
    cost: undefined,
  }]);
});

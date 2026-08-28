import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  MutationTransportResult,
  OpenCodeTransport,
  RuntimeEndpoint,
  RuntimeSessionBinding,
} from "@polyth/contracts";
import { createProtocolAdapter } from "../src/protocol.ts";
import { createLegacyProtocolAdapter } from "../src/protocolLegacy.ts";
import { createV2ProtocolAdapter } from "../src/protocolV2.ts";

const endpoint = (generation = 1): RuntimeEndpoint => ({
  authorityId: "authority-a",
  continuity: "generation-only",
  generation,
  url: "http://opencode.test",
  location: { directory: "/workspace/project", workspace: "worktree-a" },
  control: { kind: "borrowed", source: "external" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
});

const binding = (generation = 1): RuntimeSessionBinding => ({
  canonicalSessionId: "canonical-a",
  backendSessionId: "session-a",
  authorityId: "authority-a",
  generation,
  continuity: "generation-only",
  location: { directory: "/workspace/project", workspace: "worktree-a" },
});

interface MutationCall {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  operationId: string;
  replay: { kind: "never" } | { kind: "same-operation-id"; contract: string };
}

const transportDouble = (options: {
  query?: (path: string) => unknown | Promise<unknown>;
  mutate?: (call: MutationCall) => MutationTransportResult<unknown> | Promise<MutationTransportResult<unknown>>;
}) => {
  const queries: string[] = [];
  const mutations: MutationCall[] = [];
  const transport: OpenCodeTransport = {
    async query<T>(request: {
      method: "GET" | "HEAD";
      path: string;
      deadlineMs: number;
    }): Promise<T> {
      queries.push(request.path);
      if (!options.query) throw new Error("query not scripted");
      return await options.query(request.path) as T;
    },
    async mutate<T>(request: {
      method: "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      body?: unknown;
      operationId: string;
      deadlineMs: number;
      replay: { kind: "never" } | { kind: "same-operation-id"; contract: string };
    }): Promise<MutationTransportResult<T>> {
      mutations.push(request);
      if (!options.mutate) throw new Error("mutation not scripted");
      return await options.mutate(request) as MutationTransportResult<T>;
    },
    async stream(_request: {
      path: string;
      after?: string;
      signal: AbortSignal;
      onEvent(value: unknown): void;
    }): Promise<void> {},
  };
  return { transport, queries, mutations };
};

const legacyDocument = {
  paths: {
    "/session/{id}/prompt_async": { post: {} },
    "/session/{id}/message": { post: {} },
  },
};

test("auto negotiation prefers legacy when the document advertises both contracts", async () => {
  const fake = transportDouble({
    query: () => ({
      paths: {
        ...legacyDocument.paths,
        "/api/session": { post: {} },
        "/api/session/{id}/prompt": { post: {} },
      },
    }),
    mutate: () => ({ kind: "response", status: 204, headers: {}, body: undefined }),
  });
  const adapter = await createProtocolAdapter({
    protocol: "auto",
    transport: fake.transport,
    endpoint: endpoint(),
  });

  assert.equal(adapter.protocol, "legacy");
  const outcome = await adapter.submit(
    {
      session: binding(),
      text: "use the supported contract",
      model: { providerID: "opencode", modelID: "model-a" },
    },
    "operation-mixed-document",
  );
  assert.equal(outcome.kind, "confirmed");
  assert.equal(fake.mutations.length, 1);
  assert.match(fake.mutations[0]!.path, /^\/session\/session-a\/prompt_async\?/);
  assert.deepEqual(fake.mutations[0]!.body, {
    parts: [{ type: "text", text: "use the supported contract" }],
    model: { providerID: "opencode", modelID: "model-a" },
  });
});

test("read-only negotiation selects one prompt endpoint and never falls through", async () => {
  let attempts = 0;
  const fake = transportDouble({
    query: (path) => {
      assert.match(path, /directory=%2Fworkspace%2Fproject/);
      assert.match(path, /workspace=worktree-a/);
      return legacyDocument;
    },
    mutate: (request) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          kind: "response",
          status: 404,
          headers: {},
          body: { code: "unsupported", message: "prompt_async is unsupported" },
        };
      }
      return { kind: "response", status: 204, headers: {}, body: undefined };
    },
  });
  const adapter = await createProtocolAdapter({
    protocol: "auto",
    transport: fake.transport,
    endpoint: endpoint(),
  });

  const first = await adapter.submit(
    { session: binding(), text: "first" },
    "operation-first",
  );
  assert.deepEqual(first, {
    kind: "rejected",
    code: "capability-unsupported",
    message: "prompt_async is unsupported",
  });
  assert.equal(fake.mutations.length, 1);
  assert.match(fake.mutations[0]!.path, /\/prompt_async\?/);

  const second = await adapter.submit(
    { session: binding(), text: "second" },
    "operation-second",
  );
  assert.equal(second.kind, "confirmed");
  assert.equal(fake.mutations.length, 2);
  assert.match(fake.mutations[1]!.path, /\/message\?/);
  assert.ok(fake.mutations.every((request) => request.replay.kind === "never"));
});

test("legacy mutation classification keeps 5xx unknown and validation rejected", async () => {
  const responses: Array<MutationTransportResult<unknown>> = [
    {
      kind: "response",
      status: 503,
      headers: {},
      body: { message: "temporarily unavailable" },
    },
    {
      kind: "response",
      status: 422,
      headers: {},
      body: { message: "text is required" },
    },
  ];
  const fake = transportDouble({
    mutate: () => responses.shift()!,
  });
  const adapter = createLegacyProtocolAdapter({
    transport: fake.transport,
    endpoint: endpoint(),
    promptPaths: ["prompt_async"],
  });

  const ambiguous = await adapter.submit(
    { session: binding(), text: "one" },
    "operation-503",
  );
  assert.deepEqual(ambiguous, {
    kind: "unknown",
    operationId: "operation-503",
    message: "temporarily unavailable",
  });

  const rejected = await adapter.submit(
    { session: binding(), text: "" },
    "operation-422",
  );
  assert.deepEqual(rejected, {
    kind: "rejected",
    code: "validation",
    message: "text is required",
  });
  assert.equal(fake.mutations.length, 2, "each logical mutation is sent exactly once");
  assert.ok(fake.mutations.every((request) => request.replay.kind === "never"));
});

test("protocol probe cache is isolated by endpoint generation", async () => {
  const fake = transportDouble({ query: () => legacyDocument });
  await createProtocolAdapter({
    protocol: "auto",
    transport: fake.transport,
    endpoint: endpoint(1),
  });
  await createProtocolAdapter({
    protocol: "auto",
    transport: fake.transport,
    endpoint: endpoint(1),
  });
  assert.equal(fake.queries.length, 1, "same generation reuses read-only evidence");

  await createProtocolAdapter({
    protocol: "auto",
    transport: fake.transport,
    endpoint: endpoint(2),
  });
  assert.equal(fake.queries.length, 2, "new generation is negotiated independently");
});

test("V2 prompt admission uses the native session prompt contract", async () => {
  const fake = transportDouble({
    mutate: () => ({
      kind: "response",
      status: 200,
      headers: {},
      body: { data: { id: "msg_v2" } },
    }),
  });
  const adapter = createV2ProtocolAdapter({
    transport: fake.transport,
    endpoint: endpoint(),
  });
  const outcome = await adapter.submit(
    { session: binding(), text: "send through V2" },
    "operation-v2",
  );
  assert.deepEqual(outcome, {
    kind: "confirmed",
    value: { admissionId: "msg_v2" },
  });
  assert.equal(fake.mutations.length, 1);
  assert.match(fake.mutations[0]!.path, /^\/api\/session\/session-a\/prompt\?/);
  assert.deepEqual(fake.mutations[0]!.body, {
    prompt: { text: "send through V2" },
    delivery: "queue",
  });
});

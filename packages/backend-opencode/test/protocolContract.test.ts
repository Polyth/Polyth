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

test("V2 branches an empty canonical prefix from an empty native session without inventing history", async () => {
  const fake = transportDouble({
    query: () => ({ data: [], cursor: {} }),
    mutate: () => ({ kind: "response", status: 200, headers: {}, body: { data: { id: "ses_empty_child" } } }),
  });
  const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint: endpoint() });
  const source = binding();
  const target = { ...binding(), canonicalSessionId: "empty-child", backendSessionId: undefined };
  assert.equal((await adapter.branchSession({ source, target, history: [] }, "empty-branch")).kind, "confirmed");
  assert.match(fake.mutations[0]!.path, /^\/api\/session\?/);
  const missing = await adapter.branchSession({ source, target, history: [{ role: "user", parts: [{ type: "text", text: "absent" }] }] }, "missing-history");
  assert.equal(missing.kind, "rejected");
  assert.equal(fake.mutations.length, 1);
});

test("V2 catalog reads await one activation barrier per adapter and retry failed discovery", async () => {
  let activations = 0;
  const fake = transportDouble({
    query: () => ({ data: [] }),
    mutate: (call) => {
      assert.match(call.path, /^\/api\/plugin\/await-activation\?location%5Bdirectory%5D=/);
      activations += 1;
      return activations === 1
        ? { kind: "unknown", operationId: call.operationId, message: "deadline" }
        : { kind: "response", status: 204, headers: {}, body: undefined };
    },
  });
  const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint: endpoint() });
  await assert.rejects(adapter.models(), { code: "backend-not-ready" });
  assert.equal(fake.queries.length, 0);
  await Promise.all([adapter.models(), adapter.agents(), adapter.listAllProviders!()]);
  assert.equal(activations, 2);
});

test("V2 protocol failures do not echo private backend response bodies", async () => {
  const secret = "test-private-provider-key";
  const fake = transportDouble({
    query: () => ({ status: 401, body: { message: secret } }),
    mutate: (call) => call.path.startsWith("/api/plugin/await-activation?")
      ? { kind: "response", status: 204, headers: {}, body: undefined }
      : { kind: "response", status: 422, headers: {}, body: { message: secret } },
  });
  const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint: endpoint() });
  await assert.rejects(adapter.listAllProviders!(), (error: Error) =>
    error.message.includes("/api/provider") && !error.message.includes(secret));
  const rejected = await adapter.deleteSession(binding(), "private-body");
  assert.equal(rejected.kind, "rejected");
  assert.ok(!JSON.stringify(rejected).includes(secret));
});

const dualProtocolDocument = {
  paths: {
    ...legacyDocument.paths,
    "/api/session": { post: {} },
    "/api/session/{sessionID}/prompt": { post: {} },
  },
};

const legacyNativeDocument = {
  paths: {
    ...legacyDocument.paths,
    "/command": { get: {} },
    "/session/{sessionID}/command": { post: {} },
    "/session/{sessionID}/summarize": { post: {} },
  },
};

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

test("legacy prompt submission uses the compatible async endpoint when /doc lacks a contract", async () => {
  const fake = transportDouble({
    query: () => ({ paths: {} }),
    mutate: () => ({ kind: "response", status: 204, headers: {}, body: undefined }),
  });
  const adapter = createLegacyProtocolAdapter({ transport: fake.transport, endpoint: endpoint() });

  const result = await adapter.submit({ session: binding(), text: "generate a next action" }, "operation-fallback");

  assert.equal(result.kind, "confirmed");
  assert.match(fake.mutations[0]!.path, /\/session\/session-a\/prompt_async/);
});

test("auto legacy discovery keeps the compatible prompt fallback when /doc is absent", async () => {
  const fake = transportDouble({
    query: (path) => path.startsWith("/global/health") ? { healthy: true, version: "1.18.30" } : undefined,
    mutate: () => ({ kind: "response", status: 204, headers: {}, body: undefined }),
  });
  const adapter = await createProtocolAdapter({ protocol: "auto", transport: fake.transport, endpoint: endpoint() });

  const result = await adapter.submit({ session: binding(), text: "generate a next action" }, "operation-auto-fallback");

  assert.equal(result.kind, "confirmed");
  assert.match(fake.mutations[0]!.path, /\/session\/session-a\/prompt_async/);
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

test("legacy native commands and compaction use negotiated OpenCode routes", async () => {
  const fake = transportDouble({
    query: (path) => path.startsWith("/doc?")
      ? legacyNativeDocument
      : [{ name: "review", description: "Review changes", hints: ["$ARGUMENTS"] }],
    mutate: (request) => request.path.includes("/command?")
      ? { kind: "response", status: 200, headers: {}, body: { info: { id: "msg-command" } } }
      : { kind: "response", status: 200, headers: {}, body: true },
  });
  const adapter = createLegacyProtocolAdapter({ transport: fake.transport, endpoint: endpoint() });

  const capabilities = await adapter.capabilities();
  assert.equal(capabilities.commands, true);
  assert.equal(capabilities.compaction, true);
  assert.deepEqual(await adapter.commands?.(), [{
    id: "native:opencode:review",
    name: "review",
    description: "Review changes",
    argumentHint: "$ARGUMENTS",
    owner: "native",
    harnessId: "opencode",
    invocation: "raw-native-input",
    availability: "runtime",
    acceptsArguments: true,
  }]);

  const command = await adapter.submit({
    session: binding(),
    text: "recovery context\n\n/review src\n\ncapability context",
    command: {
      id: "native:opencode:review",
      owner: "native",
      name: "review",
      args: "src",
    },
    model: { providerID: "opencode", modelID: "big-pickle", variant: "high" },
    agent: "build",
  }, "operation-command");
  assert.deepEqual(command, {
    kind: "confirmed",
    value: { admissionId: "msg-command" },
  });
  assert.deepEqual(fake.mutations[0], {
    method: "POST",
    path: "/session/session-a/command?directory=%2Fworkspace%2Fproject&workspace=worktree-a",
    body: {
      command: "review",
      arguments: "recovery context\n\nsrc\n\ncapability context",
      model: "opencode/big-pickle",
      variant: "high",
      agent: "build",
    },
    operationId: "operation-command",
    deadlineMs: 10_000,
    replay: { kind: "never" },
  });

  const compact = await adapter.compact?.(
    binding(),
    "operation-compact",
    { providerID: "opencode", modelID: "big-pickle" },
  );
  assert.deepEqual(compact, { kind: "confirmed", value: {} });
  assert.deepEqual(fake.mutations[1], {
    method: "POST",
    path: "/session/session-a/summarize?directory=%2Fworkspace%2Fproject&workspace=worktree-a",
    body: { providerID: "opencode", modelID: "big-pickle" },
    operationId: "operation-compact",
    deadlineMs: 10_000,
    replay: { kind: "never" },
  });
  assert.equal(fake.queries.filter((path) => path.startsWith("/doc?")).length, 1);
});

test("legacy native features require the documented HTTP methods", async () => {
  const fake = transportDouble({
    query: () => ({ paths: {
      "/command": { post: {} },
      "/session/{sessionID}/command": { get: {} },
      "/session/{sessionID}/summarize": { get: {} },
    } }),
  });
  const capabilities = await createLegacyProtocolAdapter({
    transport: fake.transport,
    endpoint: endpoint(),
  }).capabilities();
  assert.equal(capabilities.commands, false);
  assert.equal(capabilities.compaction, false);
});

test("protocol probe cache is isolated by endpoint generation", async () => {
  const fake = transportDouble({ query: () => ({ healthy: true, version: "1.18.30" }) });
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

test("auto protocol uses /global/health and does not fetch /doc", async () => {
  const fake = transportDouble({
    query: (path) => {
      if (path.startsWith("/global/health")) return { healthy: true, version: "1.18.18" };
      throw new Error(`unexpected probe ${path}`);
    },
  });
  const adapter = await createProtocolAdapter({
    protocol: "auto",
    transport: fake.transport,
    endpoint: endpoint(),
  });
  assert.equal(adapter.protocol, "legacy");
  assert.equal(fake.queries.length, 1);
  assert.match(fake.queries[0]!, /\/global\/health/);
});

test("explicit legacy adapter skips protocol probing", async () => {
  const fake = transportDouble({
    query: () => {
      throw new Error("protocol probe should not run for an explicit legacy selection");
    },
  });
  const adapter = await createProtocolAdapter({
    protocol: "legacy",
    transport: fake.transport,
    endpoint: endpoint(),
  });
  assert.equal(adapter.protocol, "legacy");
  assert.equal(fake.queries.length, 0);
});

test("released V2 health selects V2 without an OpenAPI download", async () => {
  const fake = transportDouble({ query: (path) => {
    if (path.startsWith("/global/health")) return { status: 404, body: "missing" };
    if (path.startsWith("/api/health")) return { healthy: true, version: "2.0.3", pid: 123 };
    throw new Error(`unexpected probe ${path}`);
  } });
  const adapter = await createProtocolAdapter({ protocol: "auto", transport: fake.transport, endpoint: endpoint() });
  assert.equal(adapter.protocol, "v2");
  assert.equal(fake.queries.length, 2);
});

test("arbitrary successful pages cannot identify an OpenCode protocol", async () => {
  for (const response of ["<html>login</html>", {}, { healthy: false, version: "2.0.3" }, { healthy: true }, { healthy: true, version: "2.0.3", pid: -1 }]) {
    const fake = transportDouble({ query: () => response });
    await assert.rejects(createProtocolAdapter({ protocol: "auto", transport: fake.transport, endpoint: endpoint() }), { code: "protocol-unsupported" });
  }
});

test("stable legacy health wins when experimental V2 health is available", async () => {
  const fake = transportDouble({ query: (path) => path.startsWith("/global/health")
    ? { healthy: true, version: "1.18.30" }
    : { healthy: true, version: "1.18.30", pid: 123 } });
  const adapter = await createProtocolAdapter({ protocol: "auto", transport: fake.transport, endpoint: endpoint() });
  assert.equal(adapter.protocol, "legacy");
  assert.equal(fake.queries.length, 1);
});

test("protocol discovery preserves auth/transport failures and does not cache failures", async () => {
  for (const status of [401, 403, 503]) {
    let healthy = false;
    const fake = transportDouble({ query: () => healthy ? { healthy: true, version: "1.18.30" } : { status, body: "private response" } });
    await assert.rejects(createProtocolAdapter({ protocol: "auto", transport: fake.transport, endpoint: endpoint() }), {
      code: status === 503 ? "unavailable" : "auth-rejected",
    });
    assert.equal(fake.queries.length, 1);
    healthy = true;
    assert.equal((await createProtocolAdapter({ protocol: "auto", transport: fake.transport, endpoint: endpoint() })).protocol, "legacy");
  }
});

test("auto negotiation prefers the complete legacy contract when V2 is also advertised", async () => {
  const fake = transportDouble({
    query: () => dualProtocolDocument,
    mutate: () => ({ kind: "response", status: 204, headers: {}, body: undefined }),
  });
  const adapter = await createProtocolAdapter({
    protocol: "auto",
    transport: fake.transport,
    endpoint: endpoint(),
  });

  assert.equal(adapter.protocol, "legacy");
  const outcome = await adapter.submit({ session: binding(), text: "use legacy" }, "operation-legacy");
  assert.equal(outcome.kind, "confirmed");
  assert.match(fake.mutations[0]!.path, /^\/session\/session-a\/prompt_async\?/);
});

test("V2 prompt admission starts the released native session drain", async () => {
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
    text: "send through V2",
    delivery: "steer",
  });
});

test("V2 does not advertise command discovery or compaction, but maps released native command submit", async () => {
  const fake = transportDouble({
    query: () => ({}),
    mutate: () => ({ kind: "response", status: 204, headers: {}, body: undefined }),
  });
  const adapter = createV2ProtocolAdapter({ transport: fake.transport, endpoint: endpoint() });
  const capabilities = await adapter.capabilities();
  assert.notEqual(capabilities.commands, true);
  assert.notEqual(capabilities.compaction, true);
  assert.equal(adapter.commands, undefined);
  assert.equal(adapter.compact, undefined);
  assert.equal((await adapter.submit({
    session: binding(),
    text: "/review",
    command: { id: "native:opencode:review", owner: "native", name: "review" },
  }, "operation-command")).kind, "confirmed");
  assert.match(fake.mutations[0]!.path, /^\/api\/session\/session-a\/command\?/);
  assert.deepEqual(fake.mutations[0]!.body, {
    command: "review",
    text: "",
    delivery: "queue",
  });
});

// The server owns two decisions that used to be made twice, differently: which
// (model, variant) a turn may carry, and how each attachment is delivered.
// Both are settled at admission, before anything is materialized, logged or
// queued, so an adapter only ever sees a request it can actually route.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentRuntime,
  CanonicalTurnRequest,
  ModelDescriptor,
  ProjectService,
  RuntimeCapabilities,
  RuntimeEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService } from "../src/sessions.ts";
import { createRuntimeCatalog } from "../src/runtimeCatalog.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

const CATALOG: ModelDescriptor[] = [{
  providerID: "fake",
  modelID: "thinker",
  name: "Thinker",
  variants: ["low", "high"],
  defaultVariant: "low",
  capabilities: ["input:text", "input:image", "toolcall"],
}, {
  providerID: "fake",
  modelID: "plain",
  name: "Plain",
}];

function fixture(options: {
  capabilities?: Partial<RuntimeCapabilities>;
  files?: Record<string, Uint8Array | Error>;
  remote?: boolean;
} = {}) {
  const store = createStore(":memory:");
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const requests: CanonicalTurnRequest[] = [];
  const materialized: string[] = [];
  const reads: string[] = [];
  const runtime: AgentRuntime = {
    harnessId: "fake",
    capabilities: async () => ({
      streaming: true,
      permissions: false,
      questions: false,
      compaction: false,
      subagents: false,
      ...options.capabilities,
    }),
    commands: async () => [],
    models: async () => CATALOG,
    agents: async () => [],
    ensureSession: async ({ sessionId }) => `native-${sessionId}`,
    sessions: async () => [],
    history: async () => [],
    async startTurn(request) {
      requests.push(request);
      for (const listener of listeners) {
        listener(request.sessionId, { type: "turn/started", turnId: `turn-${requests.length}` });
      }
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    dispose: async () => {},
  };
  const projects = {
    get: async (id: string) => id === "p"
      ? { id: "p", name: "p", path: "/tmp", spaceId: "space", createdAt: 0, ...(options.remote ? { remote: { host: "h" } } : {}) }
      : undefined,
    list: async () => [],
  } as unknown as ProjectService;
  const sessions = createSessionService({
    store,
    projects,
    runtimes: { forProject: async () => runtime },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store,
    harnesses: {
      staticFeatures: () => ({
        streaming: true,
        permissions: false,
        questions: false,
        compaction: false,
        subagents: false,
        ...options.capabilities,
      }) as RuntimeCapabilities,
      displayName: () => "Fake Engine",
    },
    attachments: {
      maxBytes: 1_000_000,
      stat: async () => ({ kind: "file", size: 1 }),
      async materialize({ rel }) {
        materialized.push(rel);
        return { kind: "file", size: 1 };
      },
      async read(_root, rel) {
        reads.push(rel);
        const found = options.files?.[rel];
        if (found === undefined) throw new Error(`no such file ${rel}`);
        if (found instanceof Error) throw found;
        return found;
      },
    },
  });
  return {
    store,
    sessions,
    requests,
    materialized,
    reads,
    emit: (sessionId: string, event: RuntimeEvent) => {
      for (const listener of listeners) listener(sessionId, event);
    },
  };
}

const text = (value: string) => new TextEncoder().encode(value);

test("an undeliverable attachment is refused at send, before materialize or queue", async () => {
  const f = fixture({ capabilities: { attachments: { modalities: { file: "unsupported", image: "native" } } } });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(
    f.sessions.send(id, {
      text: "read this",
      attachments: [{ id: "a", name: "notes.txt", mime: "text/plain", size: 4, kind: "file", path: "notes.txt" }],
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "unsupported");
      assert.match(error.message, /Fake Engine/);
      return true;
    },
  );
  assert.deepEqual(f.materialized, [], "nothing may be materialized for a refused send");
  assert.equal(f.requests.length, 0);
  assert.deepEqual((await f.store.events(id)).filter((event) => event.type === "user/message"), []);
  await f.store.close();
});

test("an emulated file becomes exactly one projected prompt section, and no adapter ref", async () => {
  const f = fixture({
    capabilities: { attachments: { modalities: { file: "emulated" } } },
    files: { "notes.txt": text("first line\nsecond line\n") },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, {
    text: "summarize",
    attachments: [{ id: "a", name: "notes.txt", mime: "text/plain", size: 23, kind: "file", path: "notes.txt" }],
  });
  const request = f.requests[0]!;
  assert.match(request.text, /summarize/);
  assert.match(request.text, /notes\.txt/);
  assert.match(request.text, /second line/);
  // Exactly once: a second copy would double the file's cost in the window.
  assert.equal(request.text.match(/second line/g)?.length, 1);
  // The adapter never receives a ref its harness cannot deliver.
  assert.deepEqual(request.attachments ?? [], []);
  assert.deepEqual(f.reads, ["notes.txt"]);
  // The log keeps the ref, not the projection: it is a delivery detail.
  const logged = (await f.store.events(id)).find((event) => event.type === "user/message")!;
  assert.equal((logged.data as { attachments?: unknown[] }).attachments?.length, 1);
  assert.doesNotMatch(JSON.stringify(logged.data), /second line/);
  await f.store.close();
});

test("a natively delivered file is forwarded untouched and never also projected", async () => {
  const f = fixture({
    capabilities: { attachments: { modalities: { file: "native" } } },
    files: { "notes.txt": text("native content") },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, {
    text: "summarize",
    attachments: [{ id: "a", name: "notes.txt", mime: "text/plain", size: 14, kind: "file", path: "notes.txt" }],
  });
  const request = f.requests[0]!;
  assert.equal(request.attachments?.length, 1);
  assert.doesNotMatch(request.text, /native content/);
  assert.deepEqual(f.reads, [], "a native harness reads the file itself");
  await f.store.close();
});

test("a range attachment projects only the lines that were asked for", async () => {
  const f = fixture({
    capabilities: { attachments: { modalities: { file: "emulated" } } },
    files: { "src/app.ts": text("one\ntwo\nthree\nfour\nfive\n") },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, {
    text: "explain",
    attachments: [{
      id: "a",
      name: "app.ts",
      mime: "text/plain",
      size: 24,
      kind: "range",
      path: "src/app.ts",
      range: [2, 3],
    }],
  });
  const request = f.requests[0]!;
  assert.match(request.text, /two/);
  assert.match(request.text, /three/);
  assert.doesNotMatch(request.text, /\bfive\b/);
  await f.store.close();
});

test("a binary file is refused rather than projected as mojibake", async () => {
  const f = fixture({
    capabilities: { attachments: { modalities: { file: "emulated" } } },
    files: { "blob.bin": new Uint8Array([0x89, 0x50, 0x00, 0x01, 0x02]) },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(
    f.sessions.send(id, {
      text: "read",
      attachments: [{ id: "a", name: "blob.bin", mime: "application/octet-stream", size: 5, kind: "file", path: "blob.bin" }],
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "invalid-attachment");
      return true;
    },
  );
  assert.equal(f.requests.length, 0);
  await f.store.close();
});

test("a remote project with no way to read the file says so instead of guessing", async () => {
  const store = createStore(":memory:");
  const requests: CanonicalTurnRequest[] = [];
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const runtime: AgentRuntime = {
    harnessId: "fake",
    capabilities: async () => ({
      streaming: true, permissions: false, questions: false, compaction: false, subagents: false,
      attachments: { modalities: { file: "emulated" } },
    }),
    commands: async () => [],
    models: async () => CATALOG,
    agents: async () => [],
    ensureSession: async ({ sessionId }) => `native-${sessionId}`,
    sessions: async () => [],
    history: async () => [],
    async startTurn(request) { requests.push(request); },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(listener) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    dispose: async () => {},
  };
  // No `attachments` dependency at all: nothing can be materialized or read.
  const sessions = createSessionService({
    store,
    projects: {
      get: async () => ({ id: "p", name: "p", path: "/tmp", spaceId: "space", createdAt: 0, remote: { host: "h" } }),
      list: async () => [],
    } as unknown as ProjectService,
    runtimes: { forProject: async () => runtime },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store,
    harnesses: { staticFeatures: () => runtime.capabilities() as never, displayName: () => "Fake Engine" },
  });
  const { id } = await sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(
    sessions.send(id, {
      text: "read",
      attachments: [{ id: "a", name: "notes.txt", mime: "text/plain", size: 4, kind: "file", path: "notes.txt" }],
    }),
    (error: Error & { code?: string }) => {
      assert.ok(error.code === "unsupported" || error.code === "invalid-attachment");
      return true;
    },
  );
  assert.equal(requests.length, 0);
  await store.close();
});

test("an advertised variant reaches the adapter as the turn's model variant", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, {
    text: "think hard",
    model: { providerID: "fake", modelID: "thinker", variant: "high" },
  });
  assert.deepEqual(f.requests[0]!.model, { providerID: "fake", modelID: "thinker", variant: "high" });
  await f.store.close();
});

test("a variant the model never advertised is rejected before the turn is logged", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(
    f.sessions.send(id, {
      text: "think harder",
      model: { providerID: "fake", modelID: "thinker", variant: "ultra" },
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "invalid-variant");
      assert.match(error.message, /low, high/);
      return true;
    },
  );
  assert.equal(f.requests.length, 0);
  await f.store.close();
});

test("a variant on a model with no thinking levels is rejected, not silently dropped", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(
    f.sessions.send(id, { text: "x", model: { providerID: "fake", modelID: "plain", variant: "high" } }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "invalid-variant");
      return true;
    },
  );
  await f.store.close();
});

test("a model the harness does not have is rejected as an unknown model", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(
    f.sessions.send(id, { text: "x", model: { providerID: "fake", modelID: "not-mine" } }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "invalid-model");
      return true;
    },
  );
  await f.store.close();
});

test("runtime features publish the same delivery inputs the composer computes with", async () => {
  const f = fixture({
    capabilities: { attachments: { modalities: { file: "emulated", image: "native", pdf: "unsupported" } } },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  const features = await f.sessions.runtimeFeatures!(id);
  assert.equal(features.attachmentSupport.image, "native");
  assert.equal(features.attachmentSupport.file, "emulated");
  // A modality the harness refuses is absent from the map, which is how the
  // composer disables that one picker without touching the others.
  assert.equal("pdf" in features.attachmentSupport, false);
  // The two flags that used to be hardcoded to false in the composer.
  assert.equal(features.remote, false);
  assert.equal(features.materializeAvailable, true);
  await f.store.close();
});

test("runtime features report a remote project as remote", async () => {
  const f = fixture({ remote: true, capabilities: { attachments: { modalities: { file: "emulated" } } } });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  assert.equal((await f.sessions.runtimeFeatures!(id)).remote, true);
  await f.store.close();
});

// ---- catalog aggregation ---------------------------------------------------

const catalogRuntime = (harnessId: string, models: ModelDescriptor[] | Error): AgentRuntime => ({
  harnessId,
  capabilities: async () => ({ streaming: true, permissions: false, questions: false, compaction: false, subagents: false }),
  commands: async () => [],
  models: async () => { if (models instanceof Error) throw models; return models; },
  agents: async () => [],
  ensureSession: async () => "native",
  sessions: async () => [],
  history: async () => [],
  startTurn: async () => {},
  abort: async () => {},
  replyPermission: async () => {},
  replyQuestion: async () => {},
  onEvent: () => ({ dispose: () => {} }),
  dispose: async () => {},
});

const catalogFixture = (answers: () => Array<ModelDescriptor[] | Error>) => {
  const invalidations: number[] = [];
  const projects = {
    list: async () => answers().map((_, index) => ({ id: `p${index}`, name: `p${index}`, path: `/tmp/p${index}`, spaceId: "space", createdAt: 0 })),
    get: async (id: string) => ({ id, name: id, path: `/tmp/${id}`, spaceId: "space", createdAt: 0 }),
  } as unknown as ProjectService;
  const catalog = createRuntimeCatalog({
    projects,
    runtimes: {
      forProject: async (projectId: string) => {
        const index = Number(projectId.slice(1));
        return catalogRuntime(`h${index}`, answers()[index]!);
      },
    } as never,
    onModelsInvalidated: () => invalidations.push(Date.now()),
  });
  return { catalog, invalidations };
};

test("a harness that could not answer is never frozen into the catalog as empty", async () => {
  let answers: Array<ModelDescriptor[] | Error> = [
    [{ providerID: "a", modelID: "a1", name: "A1" }],
    new Error("still warming up"),
  ];
  const f = catalogFixture(() => answers);
  const first = await f.catalog.models();
  assert.deepEqual(first.map((model) => model.modelID), ["a1"]);
  await flush();
  // The slow harness comes up. A frozen snapshot would hide it until restart.
  answers = [answers[0]!, [{ providerID: "b", modelID: "b1", name: "B1" }]];
  await flush();
  const second = await f.catalog.models();
  assert.deepEqual(second.map((model) => model.modelID).sort(), ["a1", "b1"]);
});

test("a complete fan-out is cached, so opening the picker does not re-fan-out", async () => {
  let calls = 0;
  const answers = () => {
    calls++;
    return [[{ providerID: "a", modelID: "a1", name: "A1" }]];
  };
  const f = catalogFixture(answers);
  await f.catalog.models();
  await flush();
  const before = calls;
  await f.catalog.models();
  assert.equal(calls, before, "a cached complete catalog must not re-fan-out");
});

test("invalidating the model catalog invalidates the harness snapshot with it", async () => {
  const f = catalogFixture(() => [[{ providerID: "a", modelID: "a1", name: "A1" }]]);
  await f.catalog.models();
  await flush();
  f.catalog.invalidateModels();
  assert.equal(f.invalidations.length, 1, "the two discovery caches must expire together");
});

test("the harness identity of every model survives aggregation", async () => {
  const f = catalogFixture(() => [
    [{ providerID: "shared", modelID: "same-id", name: "From h0" }],
    [{ providerID: "shared", modelID: "same-id", name: "From h1" }],
  ]);
  await flush();
  const models = await f.catalog.models();
  await flush();
  const all = await f.catalog.models();
  // Two harnesses may expose the same provider/model id; they stay distinct.
  assert.ok(models.length >= 1);
  assert.deepEqual([...new Set(all.map((model) => model.harnessId))].sort(), ["h0", "h1"]);
});

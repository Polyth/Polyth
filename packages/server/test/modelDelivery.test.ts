// The server owns two decisions that used to be made twice, differently: which
// (model, variant) a turn may carry, and how each attachment is delivered.
// Both are settled at admission, before anything is materialized, logged or
// queued, so an adapter only ever sees a request it can actually route.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentRuntime,
  AttachmentRef,
  CanonicalTurnRequest,
  ModelDescriptor,
  ProjectService,
  RuntimeCapabilities,
  RuntimeEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService, type MemoryRuntimeService } from "../src/sessions.ts";
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
  capabilities: ["input:text"],
}];

function fixture(options: {
  capabilities?: Partial<RuntimeCapabilities>;
  files?: Record<string, Uint8Array | Error>;
  remote?: boolean;
  models?: Error;
  memory?: MemoryRuntimeService;
  operationReceipt?: string;
  browserArtifacts?: Parameters<typeof createSessionService>[0]["browserArtifacts"];
} = {}) {
  const store = createStore(":memory:");
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const requests: CanonicalTurnRequest[] = [];
  const materialized: string[] = [];
  const reads: string[] = [];
  const readProjects: Array<string | undefined> = [];
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
    models: async () => {
      if (options.models) throw options.models;
      return CATALOG;
    },
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
    ...(options.operationReceipt ? {
      async startTurnOperation(request: CanonicalTurnRequest) {
        requests.push(request);
        return { kind: "confirmed" as const, value: {}, receipt: options.operationReceipt! };
      },
    } : {}),
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
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.browserArtifacts ? { browserArtifacts: options.browserArtifacts } : {}),
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
      async read(_root, rel, projectId) {
        reads.push(rel);
        readProjects.push(projectId);
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
    readProjects,
    emit: (sessionId: string, event: RuntimeEvent) => {
      for (const listener of listeners) listener(sessionId, event);
    },
  };
}

const memoryContribution = (overrides: Partial<Awaited<ReturnType<NonNullable<MemoryRuntimeService["recall"]>>>> = {}) => ({
  status: "selected" as const,
  modelVisibleText: "<polyth-project-memory>\n[remembered rev 3]\nUse the durable seam.\n</polyth-project-memory>",
  selected: [{ memoryId: "remembered", revision: 3, digest: "digest-3", reason: "fts", text: "Use the durable seam." }],
  omittedCount: 0,
  estimate: { bytes: 92, estimated: true },
  dataRevision: "7",
  settingsRevision: "4",
  generation: "generation-4",
  digest: "package-4",
  reasons: ["fts"],
  ...overrides,
});

test("production admission persists the exact memory package before runtime and reuses confirmed admission", async () => {
  let recalls = 0;
  const f = fixture({
    memory: {
      recall: () => { recalls += 1; return memoryContribution(); },
      checkFence: () => true,
    },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, { text: "Continue", clientOperationId: "memory-op-1" });
  const events = await f.store.events(id);
  const prepared = events.find((event) => event.type === "context/memory-prepared")!;
  const turnPrepared = events.find((event) =>
    event.type === "mutation/prepared"
    && (event.data as { operationId?: string }).operationId === "memory-op-1",
  );
  assert.ok(turnPrepared, "the turn operation must have its own preparation event");
  assert.equal((prepared.data as { operationId?: string }).operationId, (turnPrepared.data as { operationId?: string }).operationId);
  assert.equal((prepared.data as { modelVisibleText?: string }).modelVisibleText, memoryContribution().modelVisibleText);
  const delivery = events.find((event) => event.type === "context/memory-delivery")!;
  assert.deepEqual(delivery.data, {
    operationId: (prepared.data as { operationId: string }).operationId,
    preparedEventSeq: prepared.seq,
    harnessId: "fake",
    mode: "text",
    status: "degraded",
  });
  assert.match(f.requests[0]!.text, /Use the durable seam/);
  assert.equal(recalls, 1);
  await f.sessions.send(id, { text: "Continue", clientOperationId: "memory-op-1" });
  assert.equal(recalls, 1, "confirmed client retry must not recall a changed package");
  assert.equal(f.requests.length, 1);
  await f.store.close();
});

test("strict memory policy allows an empty project to start a turn", async () => {
  for (const status of ["empty", "degraded"] as const) {
    const f = fixture({
      memory: {
        recall: () => memoryContribution({ status, modelVisibleText: undefined, selected: [], requiresMemory: true }),
        checkFence: () => true,
      },
    });
    const session = await f.sessions.create({ projectId: "p", title: "T" });
    await f.sessions.send(session.id, { text: "First turn" });
    assert.equal(f.requests.length, 1, `${status} recall must not block the first turn`);
    const events = await f.store.events(session.id);
    assert.equal((events.find((event) => event.type === "context/memory-prepared")?.data as { status?: string })?.status, status);
    assert.equal((events.find((event) => event.type === "context/memory-delivery")?.data as { status?: string })?.status, "unsupported");
    await f.store.close();
  }
});

test("strict memory policy and fence failure stop production delivery", async () => {
  for (const status of ["blocked", "unavailable"] as const) {
    const strict = fixture({
      memory: {
        recall: () => memoryContribution({ status, modelVisibleText: undefined, selected: [], requiresMemory: true }),
        checkFence: () => true,
      },
    });
    const strictSession = await strict.sessions.create({ projectId: "p", title: "T" });
    await assert.rejects(strict.sessions.send(strictSession.id, { text: "blocked" }), (error: Error & { code?: string }) => error.code === "memory-required");
    assert.equal(strict.requests.length, 0);
    assert.equal((await strict.store.events(strictSession.id)).find((event) => event.type === "context/memory-delivery")?.data.status, "failed");
    await strict.store.close();
  }

  const fenced = fixture({
    memory: {
      recall: () => memoryContribution(),
      checkFence: () => false,
    },
  });
  const fencedSession = await fenced.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(fenced.sessions.send(fencedSession.id, { text: "stale" }), (error: Error & { code?: string }) => error.code === "conflict");
  assert.equal(fenced.requests.length, 0);
  assert.equal((await fenced.store.events(fencedSession.id)).find((event) => event.type === "context/memory-delivery")?.data.status, "failed");
  await fenced.store.close();
});

test("memory controls are validated and passed as narrowing-only recall context", async () => {
  let received: unknown;
  const f = fixture({
    memory: {
      recall: (_scope, input) => {
        received = input.memory;
        return memoryContribution({ modelVisibleText: undefined, selected: [], status: "empty" });
      },
      checkFence: () => true,
    },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  const projection = await f.store.projection(id);
  await f.store.upsertProjection({ ...projection!, memoryPolicy: { read: "off" } });
  await f.sessions.send(id, { text: "skip memory", memory: { read: "inherit", remember: "off" } });
  assert.deepEqual(received, { read: "off", remember: "off" });
  await assert.rejects(
    f.sessions.send(id, { text: "invalid", memory: { read: "enable" } as never }),
    (error: Error & { code?: string }) => error.code === "invalid-input",
  );
  await f.store.close();
});

test("project-off memory status remains fail-open and cannot add context", async () => {
  const f = fixture({
    memory: {
      recall: () => memoryContribution({ status: "blocked", modelVisibleText: undefined, selected: [], reasons: ["project-off"] }),
      checkFence: () => true,
    },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, { text: "continue", memory: { read: "inherit" } });
  assert.doesNotMatch(f.requests[0]!.text, /polyth-project-memory/);
  assert.equal((await f.store.events(id)).find((event) => event.type === "context/memory-delivery")?.data.status, "unsupported");
  await f.store.close();
});

test("operation transport receipt is recorded as confirmed without implying model use", async () => {
  const f = fixture({
    operationReceipt: "transport-1",
    memory: {
      recall: () => memoryContribution(),
      checkFence: () => true,
    },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, { text: "receipt" });
  const delivery = (await f.store.events(id)).find((event) => event.type === "context/memory-delivery")!;
  assert.equal(delivery.data.status, "confirmed");
  assert.equal(delivery.data.transportReceipt, "transport-1");
  await f.store.close();
});

test("memory preparation append failure never reaches the runtime", async () => {
  const f = fixture({
    memory: {
      recall: () => memoryContribution(),
      checkFence: () => true,
    },
  });
  const originalAppend = f.store.append.bind(f.store);
  f.store.append = async (sessionId, type, data, options) => {
    if (type === "context/memory-prepared") throw Object.assign(new Error("disk unavailable"), { code: "storage-unavailable" });
    return originalAppend(sessionId, type, data, options);
  };
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(f.sessions.send(id, { text: "must not dispatch" }), /disk unavailable/);
  assert.equal(f.requests.length, 0);
  await f.store.close();
});

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

test("remote emulated text reads through the project-qualified attachment store", async () => {
  const f = fixture({
    remote: true,
    capabilities: { attachments: { modalities: { file: "emulated" } } },
    files: { "notes.txt": text("remote bytes") },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, {
    text: "summarize",
    attachments: [{ id: "a", name: "notes.txt", mime: "text/plain", size: 12, kind: "file", path: "notes.txt" }],
  });
  assert.deepEqual(f.readProjects, ["p"]);
  assert.match(f.requests[0]!.text, /remote bytes/);
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

/** One-page PDF around an ASCII content stream; the extractor ignores the xref. */
const tinyPdf = (content: string): Uint8Array => text([
  "%PDF-1.4",
  "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
  "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
  "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
  `5 0 obj << /Length ${content.length} >> stream`,
  content,
  "endstream endobj",
  "trailer << /Root 1 0 R >>",
  "%%EOF",
].join("\n"));

test("a PDF the harness cannot take arrives as its extracted text, not an adapter ref", async () => {
  const f = fixture({
    capabilities: { attachments: { modalities: { file: "emulated", image: "native", pdf: "unsupported" } } },
    files: { "_inbox/brief.pdf": tinyPdf("BT /F1 12 Tf 72 720 Td (Project brief) Tj 0 -14 Td (Launch on Friday) Tj ET") },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, {
    text: "summarize",
    attachments: [{ id: "a", name: "brief.pdf", mime: "application/pdf", size: 600, kind: "file", path: "_inbox/brief.pdf" }],
  });
  const request = f.requests[0]!;
  assert.match(request.text, /^summarize\n\nAttached PDF: _inbox\/brief\.pdf \(1 page;/);
  assert.match(request.text, /Project brief\nLaunch on Friday/);
  assert.deepEqual(request.attachments ?? [], []);
  assert.deepEqual(f.reads, ["_inbox/brief.pdf"]);
  const logged = (await f.store.events(id)).find((event) => event.type === "user/message")!;
  assert.equal((logged.data as { attachments?: unknown[] }).attachments?.length, 1);
  assert.doesNotMatch(JSON.stringify(logged.data), /Launch on Friday/);
  await f.store.close();
});

test("a PDF with no text layer is refused before the runtime sees the turn", async () => {
  const f = fixture({
    capabilities: { attachments: { modalities: { image: "native" } } },
    files: { "scan.pdf": tinyPdf("q 1 0 0 1 0 0 cm Q") },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(
    f.sessions.send(id, {
      text: "read",
      attachments: [{ id: "a", name: "scan.pdf", mime: "application/pdf", size: 300, kind: "file", path: "scan.pdf" }],
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "invalid-attachment");
      assert.match(error.message, /no text layer/);
      return true;
    },
  );
  assert.equal(f.requests.length, 0);
  await f.store.close();
});

test("final admission omits images for an explicitly text-only model without losing canonical history", async () => {
  const f = fixture({
    capabilities: { attachments: { modalities: { image: "native" } } },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, {
    text: "read",
    model: { providerID: "fake", modelID: "plain" },
    attachments: [{ id: "a", name: "shot.png", mime: "image/png", size: 5, kind: "image", path: "shot.png" }],
  });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0]!.attachments ?? [], []);
  assert.match(f.requests[0]!.text, /\[Attached image: shot\.png \(omitted: model lacks vision support\)\]/);
  const logged = (await f.store.events(id)).find((event) => event.type === "user/message")!;
  assert.equal((logged.data as { attachments?: unknown[] }).attachments?.length, 1);
  await f.store.close();
});

test("text-only fallback keeps browser context text but strips its visual evidence", async () => {
  const f = fixture({
    capabilities: { attachments: { modalities: { image: "native" } } },
    // Capture artifacts resolve through the managed store, never a client path.
    browserArtifacts: {
      // Resolution is per project: the browser package maps it to the Space.
      resolve: async (artifactId, projectId) => artifactId === "shot-1" && projectId === "p"
        ? { id: "shot-1", mime: "image/jpeg", size: 120, localPath: "/tmp/shot.jpg" }
        : null,
    },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, {
    text: "inspect",
    model: { providerID: "fake", modelID: "plain" },
    attachments: [{
      id: "browser-1",
      name: "Browser · Save",
      mime: "application/vnd.polyth.browser-context+json",
      size: 120,
      kind: "browser-context",
      browserContext: {
        id: "browser-1",
        type: "element",
        browserSessionId: "b1",
        projectId: "p",
        frameRevision: 3,
        url: "http://localhost:3000/settings",
        title: "Settings",
        viewport: { width: 390, height: 844 },
        capturedAt: "2026-09-22T00:00:00.000Z",
        textSummary: "Settings Save",
        element: { tag: "button", name: "Save", selector: "button.save" },
        screenshot: { id: "shot-1", mime: "image/jpeg", size: 120, localPath: "/tmp/shot.jpg" },
      },
    }],
  });
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0]!.text, /omitted: model lacks vision support/);
  const delivered = f.requests[0]!.attachments?.[0];
  assert.equal(delivered?.kind, "browser-context");
  assert.equal(delivered?.browserContext?.element?.name, "Save");
  assert.equal(delivered?.browserContext?.textSummary, "Settings Save");
  assert.equal(delivered?.browserContext?.screenshot, undefined);
  assert.equal(delivered?.browserContext?.crop, undefined);
  const logged = (await f.store.events(id)).find((event) => event.type === "user/message")!;
  const canonical = (logged.data as { attachments?: AttachmentRef[] }).attachments?.[0];
  assert.equal(canonical?.browserContext?.screenshot?.id, "shot-1");
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

test("a wrong provider with a valid model id is rejected before the turn log", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(
    f.sessions.send(id, { text: "x", model: { providerID: "other", modelID: "thinker" } }),
    (error: Error & { code?: string }) => error.code === "invalid-model",
  );
  assert.equal(f.requests.length, 0);
  assert.deepEqual((await f.store.events(id)).filter((event) => event.type === "user/message"), []);
  await f.store.close();
});

test("a model catalog failure rejects before the turn is logged", async () => {
  const f = fixture({ models: new Error("vendor-specific catalog failure") });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(
    f.sessions.send(id, {
      text: "think",
      model: { providerID: "fake", modelID: "thinker", variant: "high" },
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "discovery-unavailable");
      assert.match(error.message, /Fake Engine could not verify/i);
      assert.doesNotMatch(error.message, /vendor-specific/i);
      return true;
    },
  );
  assert.equal(f.requests.length, 0);
  assert.deepEqual((await f.store.events(id)).filter((event) => event.type === "user/message"), []);
  await f.store.close();
});

test("runtime features publish the same delivery inputs the composer computes with", async () => {
  const f = fixture({
    capabilities: { attachments: { modalities: { file: "emulated", image: "native", audio: "unsupported", pdf: "unsupported" } } },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  const features = await f.sessions.runtimeFeatures!(id);
  assert.equal(features.attachmentSupport.image, "native");
  assert.equal(features.attachmentSupport.file, "emulated");
  // A modality the harness refuses is absent from the map, which is how the
  // composer disables that one picker without touching the others.
  assert.equal("audio" in features.attachmentSupport, false);
  // A PDF is the exception: Polyth projects its text for any harness.
  assert.equal(features.attachmentSupport.pdf, "emulated");
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
    // One representative per harness selection: each project pins its own
    // harness, the way distinct engines reach the aggregate in production.
    list: async () => answers().map((_, index) => ({
      id: `p${index}`, name: `p${index}`, path: `/tmp/p${index}`, spaceId: "space", createdAt: 0,
      defaults: { harness: { mode: "pinned", harnessId: `h${index}` } },
    })),
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

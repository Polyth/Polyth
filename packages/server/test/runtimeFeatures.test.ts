import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentRuntime,
  CanonicalTurnRequest,
  ProjectService,
  RuntimeCapabilities,
  RuntimeCommandDescriptor,
  RuntimeEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService } from "../src/sessions.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

function fixture(capabilities?: Partial<RuntimeCapabilities>) {
  const store = createStore(":memory:");
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const requests: CanonicalTurnRequest[] = [];
  let expandCalls = 0;
  const commands: RuntimeCommandDescriptor[] = [{
    id: "native:fake:review",
    name: "review",
    owner: "native",
    harnessId: "fake",
    invocation: "raw-native-input",
  }];
  const runtime: AgentRuntime = {
    harnessId: "fake",
    capabilities: async () => ({
      streaming: true,
      permissions: false,
      questions: false,
      compaction: false,
      subagents: false,
      ...capabilities,
    }),
    commands: async () => commands,
    models: async () => [{
      providerID: "fake",
      modelID: "m",
      name: "m",
      capabilities: ["input:text", "input:image", "output:text", "toolcall"],
    }],
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
      ? { id: "p", name: "p", path: "/tmp", spaceId: "space", createdAt: 0 }
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
    expand: async (_projectId, text) => {
      expandCalls++;
      return {
        text: text === "/compact" ? "expanded compact prompt" : `expanded:${text}`,
        raw: text,
      };
    },
  });
  const emit = (sessionId: string, event: RuntimeEvent) => {
    for (const listener of listeners) listener(sessionId, event);
  };
  return {
    store,
    sessions,
    runtime,
    requests,
    commands,
    emit,
    expandCalls: () => expandCalls,
  };
}

test("native commands bypass Polyth expansion while unselected /compact still expands", async () => {
  const f = fixture({ commands: { discovery: "native", invoke: "raw-native-input" } });
  const native = await f.sessions.create({ projectId: "p", title: "Native" });
  await f.sessions.send(native.id, {
    text: "/review src",
    command: { id: "native:fake:review", owner: "native", name: "review", args: "src" },
  });
  assert.equal(f.requests[0]?.text, "/review src");
  assert.equal(f.expandCalls(), 0);
  f.emit(native.id, { type: "turn/stopped", reason: "completed" });
  await flush();

  const polyth = await f.sessions.create({ projectId: "p", title: "Polyth" });
  await f.sessions.send(polyth.id, { text: "/compact" });
  assert.equal(f.requests.at(-1)?.text, "expanded compact prompt");
  assert.equal(f.expandCalls(), 1);
  f.emit(polyth.id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await f.store.close();
});

test("declared attachment modalities fail closed before runtime admission", async () => {
  const f = fixture({
    attachments: { modalities: { image: "unsupported", url: "unsupported" } },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(
    f.sessions.send(id, {
      text: "look",
      attachments: [{
        id: "link",
        name: "image",
        mime: "text/uri-list",
        size: 0,
        kind: "url",
        url: "https://example.com/image.png",
      }],
    }),
    (error: Error & { code?: string }) => {
      // A modality the harness declares unsupported is `unsupported` — the
      // engine cannot do it. `invalid-attachment` is reserved for a ref that
      // is itself unusable. The message names the engine, not the adapter.
      assert.equal(error.code, "unsupported");
      assert.match(error.message, /Link attachments are not supported by the .* engine\./);
      return true;
    },
  );
  assert.equal(f.requests.length, 0);
  await f.store.close();
});

test("context occupancy and compaction never overwrite additive lifetime totals", async () => {
  const f = fixture({ usage: true, contextOccupancy: "native", compaction: true });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, { text: "measure" });
  f.emit(id, {
    type: "usage/recorded",
    model: { providerID: "fake", modelID: "m" },
    tokens: { input: 900_000, output: 10 },
  });
  f.emit(id, {
    type: "usage/recorded",
    model: { providerID: "fake", modelID: "m" },
    tokens: { input: 5, output: 2 },
  });
  f.emit(id, {
    type: "context/updated",
    source: "native",
    updatedAt: Date.now(),
    usedTokens: 80_000,
    limitTokens: 200_000,
  });
  await flush();
  let projection = await f.store.projection(id);
  assert.equal(projection?.tokenTotals?.input, 900_005);
  assert.equal(projection?.contextWindow, undefined);
  const features = await f.sessions.runtimeFeatures!(id);
  assert.equal(features.contextWindow?.fraction, 0.4);

  f.emit(id, { type: "session/compacted" });
  await flush();
  projection = await f.store.projection(id);
  assert.equal(projection?.tokenTotals?.input, 900_005);
  assert.equal(projection?.contextWindow, undefined);
  const afterCompact = await f.sessions.runtimeFeatures!(id);
  assert.equal(afterCompact.contextWindow?.source, "unknown");
  await f.store.close();
});

test("occupancy-unknown compaction keeps unknown window instead of deleting it", async () => {
  const f = fixture({ usage: true, contextOccupancy: "unknown", compaction: true });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, { text: "measure" });
  f.emit(id, {
    type: "context/updated",
    source: "native",
    updatedAt: Date.now(),
    usedTokens: 80_000,
    limitTokens: 200_000,
  });
  await flush();
  f.emit(id, { type: "session/compacted" });
  f.emit(id, { type: "context/updated", source: "unknown", updatedAt: Date.now(), compaction: { active: false, lastAt: Date.now() } });
  await flush();
  let projection = await f.store.projection(id);
  assert.equal(projection?.contextWindow, undefined);
  const features = await f.sessions.runtimeFeatures!(id);
  assert.equal(features.contextWindow?.source, "unknown");
  f.emit(id, {
    type: "usage/recorded",
    model: { providerID: "fake", modelID: "m" },
    tokens: { input: 10, output: 1 },
  });
  await flush();
  projection = await f.store.projection(id);
  assert.equal(projection?.contextWindow, undefined);
  assert.equal((await f.sessions.runtimeFeatures!(id)).contextWindow?.source, "unknown");
  assert.equal(projection?.tokenTotals?.input, 10);
  await f.store.close();
});

test("manual title wins and unsupported native titles fall back from the prompt", async () => {
  const manual = fixture({ title: "native" });
  const existing = await manual.sessions.create({ projectId: "p", title: "Manual title" });
  await manual.sessions.send(existing.id, { text: "prompt", autoTitle: true });
  manual.emit(existing.id, { type: "session/title-generated", title: "Generated title" });
  manual.emit(existing.id, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.equal((await manual.store.projection(existing.id))?.title, "Manual title");
  await manual.store.close();

  const fallback = fixture({ title: "unsupported" });
  const untitled = await fallback.sessions.create({ projectId: "p" });
  await fallback.sessions.send(untitled.id, { text: "Implement truthful fallback title", autoTitle: true });
  fallback.emit(untitled.id, { type: "turn/stopped", reason: "completed" });
  await flush();
  assert.equal((await fallback.store.projection(untitled.id))?.title, "Implement truthful fallback title");
  fallback.emit(untitled.id, { type: "session/title-generated", title: "Native arrives later" });
  await flush();
  assert.equal((await fallback.store.projection(untitled.id))?.title, "Native arrives later");
  await fallback.store.close();
});

test("runtimeFeatures exposes the active runtime command catalog", async () => {
  const f = fixture({ commands: { discovery: "native", invoke: "raw-native-input" } });
  const { id } = await f.sessions.create({ projectId: "p" });
  const features = await f.sessions.runtimeFeatures!(id);
  assert.equal(features.commands[0]?.id, "native:fake:review");
  assert.equal(features.capabilities.commands?.invoke, "raw-native-input");
  await f.store.close();
});

test("OpenCode-style model capability tags still admit harness file attachments", async () => {
  const f = fixture({
    attachments: { modalities: { image: "native", file: "native", url: "emulated" } },
  });
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await f.sessions.send(id, {
    text: "read this",
    model: { providerID: "fake", modelID: "m" },
    attachments: [{
      id: "notes",
      name: "notes.md",
      mime: "text/plain",
      size: 10,
      kind: "file",
      path: "notes.md",
    }],
  });
  assert.equal(f.requests[0]?.attachments?.[0]?.name, "notes.md");
  f.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await f.store.close();
});

test("native commands are rejected when the runtime does not advertise invocation", async () => {
  const f = fixture();
  const { id } = await f.sessions.create({ projectId: "p", title: "T" });
  await assert.rejects(
    f.sessions.send(id, {
      text: "/review",
      command: { id: "native:fake:review", owner: "native", name: "review" },
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "unsupported");
      return true;
    },
  );
  assert.equal(f.requests.length, 0);
  await f.store.close();
});

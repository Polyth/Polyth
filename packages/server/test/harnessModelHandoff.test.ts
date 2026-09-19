// Production-shaped end-to-end: one canonical session moves between two
// harnesses that expose different models, different reasoning variants and
// different attachment support. The handoff is where a stale control leaks, so
// this asserts what each native adapter actually received.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type {
  AgentRuntime,
  CanonicalTurnRequest,
  HarnessContext,
  HarnessProvider,
  ModelDescriptor,
  ProjectService,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSnapshot,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createHarnessPool, createHarnessRegistry } from "@polyth/harness-runtime";
import { createSessionService } from "../src/sessions.ts";

const until = async (condition: () => Promise<boolean>) => {
  for (let n = 0; n < 200; n++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};

/** Harness A: two models, one with reasoning levels; files ride natively. */
const A_MODELS: ModelDescriptor[] = [
  { providerID: "prov-a", modelID: "a-deep", name: "A Deep", variants: ["low", "high"], defaultVariant: "low", capabilities: ["input:text", "input:file"] },
  { providerID: "prov-a", modelID: "a-fast", name: "A Fast", capabilities: ["input:text"] },
];

/** Harness B: different models, different variant vocabulary, emulated files. */
const B_MODELS: ModelDescriptor[] = [
  { providerID: "prov-b", modelID: "b-think", name: "B Think", variants: ["quick", "thorough"], defaultVariant: "quick", capabilities: ["input:text", "input:file"] },
];

const CAPABILITIES: Record<string, Partial<RuntimeCapabilities>> = {
  "fake-a": { attachments: { modalities: { file: "native", image: "native" } } },
  "fake-b": { attachments: { modalities: { file: "emulated", image: "native", pdf: "unsupported" } } },
};

function fixture(files: Record<string, Uint8Array>) {
  const store = createStore(":memory:");
  const detach: Array<() => void> = [];
  const registry = createHarnessRegistry();
  const engines: Array<AgentRuntime & {
    complete(): void;
    requests: CanonicalTurnRequest[];
    harnessId: string;
    launchModel: HarnessContext["model"];
  }> = [];
  const executing = new Set<string>();
  const reads: string[] = [];

  const provider = (id: string, models: ModelDescriptor[]): HarnessProvider => ({
    descriptor: { id, name: id === "fake-a" ? "Engine A" : "Engine B", integration: "fake", priority: id === "fake-a" ? 0 : 1 },
    staticFeatures: {
      streaming: true, permissions: false, questions: false, compaction: false, subagents: false,
      ...CAPABILITIES[id],
    } as RuntimeCapabilities,
    probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
    async createRuntime(context: HarnessContext) {
      const authorityId = randomUUID();
      const endpoint = {
        authorityId, generation: 1, continuity: "verified" as const, url: "http://fake",
        location: { directory: context.cwd }, control: { kind: "owned" as const, instanceToken: authorityId },
        config: { kind: "read-only" as const }, authentication: { kind: "none" as const },
      };
      const listeners = new Set<(sid: string, event: RuntimeEvent) => void>();
      detach.push(() => listeners.clear());
      const emit = (event: RuntimeEvent) => { for (const cb of listeners) cb(context.sessionId!, event); };
      let nativeId = "";
      let order = 0;
      let lastCreateId = "";
      const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
      const create = async (_request: { sessionId: string }, operationId: string) => {
        nativeId = randomUUID();
        lastCreateId = operationId;
        accepted.push({ operationId, mutationKind: "session-reset", backendSessionId: nativeId, receipt: nativeId });
        return { kind: "confirmed" as const, value: { backendSessionId: nativeId }, receipt: nativeId };
      };
      const runtime: AgentRuntime & {
        complete(): void;
        requests: CanonicalTurnRequest[];
        harnessId: string;
        launchModel: HarnessContext["model"];
      } = {
        harnessId: id,
        launchModel: context.model,
        requests: [],
        capabilities: async () => ({
          streaming: true, permissions: false, questions: false, compaction: false, subagents: false,
          resume: true, ...CAPABILITIES[id],
        }),
        commands: async () => [],
        models: async () => models,
        agents: async () => [],
        ensureSession: async (input) => nativeId = input.backendSessionId ?? nativeId,
        createSessionOperation: create,
        resetSessionOperation: create,
        sessions: async () => nativeId ? [{ id: nativeId, operationId: lastCreateId, title: "fake", createdAt: 0, updatedAt: 0 }] : [],
        history: async () => [],
        endpoint: async () => endpoint,
        protocol: async () => "legacy",
        reconcile: async (binding) => ({
          ...endpoint, backendSessionId: binding.backendSessionId!, reconciliationOrdinal: binding.reconciliationOrdinal ?? 0,
          state: { value: executing.has(authorityId) ? "running" : "idle", comparison: { domain: authorityId, order: ++order }, causalOperationId: lastCreateId },
          completeness: { events: "complete", permissions: "complete", questions: "complete" },
          permissions: [], questions: [], events: [], acceptedOperations: accepted,
        }),
        async startTurnOperation(request, operationId) {
          runtime.requests.push(request);
          executing.add(authorityId);
          order++;
          accepted.push({ operationId, mutationKind: "turn-submit", receipt: operationId });
          emit({ type: "turn/started", turnId: operationId });
          return { kind: "confirmed", value: {}, receipt: operationId };
        },
        startTurn: async () => {},
        complete() {
          emit({ type: "assistant/message", partId: randomUUID(), text: `answer from ${id}` });
          executing.delete(authorityId);
          order++;
          emit({ type: "turn/stopped", reason: "completed" });
        },
        abort: async () => {},
        abortOperation: async () => ({ kind: "confirmed", value: {} }),
        releaseExecution: async (binding, operationId) => {
          if (executing.has(authorityId)) return { kind: "unknown", operationId, message: "not proven idle" };
          return {
            kind: "confirmed",
            value: { authorityId: binding.authorityId, generation: binding.generation, backendSessionId: binding.backendSessionId! },
          };
        },
        replyPermission: async () => {},
        replyQuestion: async () => {},
        onEvent: (cb) => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; },
        dispose: async () => {},
      };
      engines.push(runtime);
      return runtime;
    },
  });

  registry.register(provider("fake-a", A_MODELS));
  registry.register(provider("fake-b", B_MODELS));
  const pool = createHarnessPool({
    registry,
    legacyHarnessId: "fake-a",
    context: async (projectId, cwd, sessionId) => ({ projectId, cwd: cwd ?? "/same/worktree", sessionId, spaceId: "space-a" }),
  });
  const projects = {
    get: async () => ({ id: "p", name: "p", path: "/same/worktree", spaceId: "space-a", createdAt: 0 }),
    list: async () => [],
  } as unknown as ProjectService;
  const sessions = createSessionService({
    store,
    projects,
    runtimes: pool,
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store,
    harnesses: {
      staticFeatures: (harnessId) => registry.providers().find((p) => p.descriptor.id === harnessId)?.staticFeatures,
      displayName: (harnessId) => registry.providers().find((p) => p.descriptor.id === harnessId)?.descriptor.name,
    },
    attachments: {
      maxBytes: 1_000_000,
      stat: async () => ({ kind: "file", size: 1 }),
      materialize: async () => ({ kind: "file", size: 1 }),
      async read(_root, rel) {
        reads.push(rel);
        const found = files[rel];
        if (!found) throw new Error(`no such file ${rel}`);
        return found;
      },
    },
  });
  return {
    store,
    sessions,
    engines,
    reads,
    engineFor: (harnessId: string) => engines.filter((engine) => engine.harnessId === harnessId),
    async idle(id: string) {
      await until(async () => {
        const events = await store.events(id);
        return (await store.projection(id))?.status === "idle"
          && (events.findLast((e) => e.type === "turn/stopped")?.seq ?? 0)
            > (events.findLast((e) => e.type === "user/message")?.seq ?? 0);
      });
    },
    async close() {
      await new Promise((resolve) => setTimeout(resolve, 40));
      detach.forEach((off) => off());
      await store.close();
    },
  };
}

test("a model and variant chosen on one harness never reach the next one", async () => {
  const f = fixture({ "notes.txt": new TextEncoder().encode("shared project notes\n") });
  const { id } = await f.sessions.create({ projectId: "p" });

  // Harness A: a model with reasoning levels, delivered natively.
  await f.sessions.send(id, { text: "A turn", model: { providerID: "prov-a", modelID: "a-deep", variant: "high" } });
  const engineA = f.engineFor("fake-a").at(-1)!;
  assert.deepEqual(engineA.requests.at(-1)!.model, { providerID: "prov-a", modelID: "a-deep", variant: "high" });
  engineA.complete();
  await f.idle(id);

  await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  const engineB = f.engineFor("fake-b").at(-1)!;
  assert.equal(engineB.launchModel, undefined, "the new harness must not launch with the previous harness model");
  assert.equal((await f.store.projection(id))?.model, undefined, "cross-harness publication clears the stale model");

  // A's model is meaningless on B, and is refused rather than routed.
  await assert.rejects(
    f.sessions.send(id, { text: "B turn", model: { providerID: "prov-a", modelID: "a-deep", variant: "high" } }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "invalid-model");
      return true;
    },
  );
  // A's variant vocabulary is meaningless on B's model too.
  await assert.rejects(
    f.sessions.send(id, { text: "B turn", model: { providerID: "prov-b", modelID: "b-think", variant: "high" } }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "invalid-variant");
      return true;
    },
  );

  // B's own model, B's own variant, plus a text file B can only emulate.
  await f.sessions.send(id, {
    text: "B turn",
    model: { providerID: "prov-b", modelID: "b-think", variant: "thorough" },
    attachments: [{ id: "att", name: "notes.txt", mime: "text/plain", size: 21, kind: "file", path: "notes.txt" }],
  });
  const request = engineB.requests.at(-1)!;
  assert.deepEqual(request.model, { providerID: "prov-b", modelID: "b-think", variant: "thorough" });
  // The file was projected into the prompt, so B sees no ref it cannot deliver.
  assert.match(request.text, /shared project notes/);
  assert.deepEqual(request.attachments ?? [], []);
  assert.deepEqual(f.reads, ["notes.txt"]);
  // The prior harness received nothing further.
  assert.equal(engineA.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(engineA.requests), /b-think/);
  engineB.complete();
  await f.idle(id);
  await f.close();
});

test("the same text file rides natively on the harness that supports it", async () => {
  const f = fixture({ "notes.txt": new TextEncoder().encode("shared project notes\n") });
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, {
    text: "A turn",
    attachments: [{ id: "att", name: "notes.txt", mime: "text/plain", size: 21, kind: "file", path: "notes.txt" }],
  });
  const request = f.engineFor("fake-a").at(-1)!.requests.at(-1)!;
  assert.equal(request.attachments?.length, 1);
  assert.doesNotMatch(request.text, /shared project notes/);
  assert.deepEqual(f.reads, [], "a native harness must not be handed a projection too");
  f.engineFor("fake-a").at(-1)!.complete();
  await f.idle(id);
  await f.close();
});

test("attachment support is re-evaluated against the harness that will run the turn", async () => {
  const f = fixture({ "paper.pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
  const { id } = await f.sessions.create({ projectId: "p" });
  const pdf = {
    id: "att",
    name: "paper.pdf",
    mime: "application/pdf",
    size: 4,
    kind: "file" as const,
    path: "paper.pdf",
  };
  // A declares file support but says nothing about pdf, so it is refused.
  await assert.rejects(f.sessions.send(id, { text: "read", attachments: [pdf] }), /Engine A/);
  await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  // B refuses pdf explicitly, and names itself while doing so.
  await assert.rejects(f.sessions.send(id, { text: "read", attachments: [pdf] }), /Engine B/);
  await f.close();
});

test("runtime features and the model catalog belong to the current harness", async () => {
  const f = fixture({});
  const { id } = await f.sessions.create({ projectId: "p" });
  const before = await f.sessions.runtimeFeatures!(id);
  assert.equal(before.attachmentSupport.file, "native");
  await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  const after = await f.sessions.runtimeFeatures!(id);
  assert.equal(after.attachmentSupport.file, "emulated");
  assert.equal("pdf" in after.attachmentSupport, false);
  await f.close();
});

test("queued attachments are re-evaluated against a later selected model", async () => {
  const f = fixture({});
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "active", model: { providerID: "prov-a", modelID: "a-deep" } });
  const engine = f.engineFor("fake-a").at(-1)!;
  await f.sessions.send(id, {
    text: "queued image", delivery: "queue",
    model: { providerID: "prov-a", modelID: "a-deep" },
    attachments: [{ id: "att", name: "shot.png", mime: "image/png", size: 13, kind: "image", path: "shot.png" }],
  });
  // A later queued choice changes the session's actual next-turn model.
  await f.sessions.send(id, {
    text: "switch model", delivery: "queue",
    model: { providerID: "prov-a", modelID: "a-fast" },
  });
  engine.complete();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(engine.requests.map((request) => ({ text: request.text, model: request.model, attachments: request.attachments })), [{
    text: "active",
    model: { providerID: "prov-a", modelID: "a-deep" },
    attachments: undefined,
  }], "the image-incompatible model receives no turn");
  assert.equal((await f.store.queueList(id)).length, 2, "the rejected head remains reviewable");
  assert.deepEqual(f.reads, [], "no delivery work is generated for a rejected eventual target");
  await f.close();
});

test("queued attachments are projected once for the harness selected before dispatch", async () => {
  const f = fixture({ "notes.txt": new TextEncoder().encode("queued notes\n") });
  const { id } = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(id, { text: "active" });
  const engineA = f.engineFor("fake-a").at(-1)!;
  await f.sessions.send(id, {
    text: "queued attachment", delivery: "queue",
    attachments: [{ id: "att", name: "notes.txt", mime: "text/plain", size: 13, kind: "file", path: "notes.txt" }],
  });
  await f.sessions.switchHarness!(id, { mode: "pinned", harnessId: "fake-b" });
  engineA.complete();
  await until(async () => f.engineFor("fake-b").some((engine) => engine.requests.length > 0));
  const request = f.engineFor("fake-b").at(-1)!.requests[0]!;
  assert.match(request.text, /queued notes/);
  assert.deepEqual(request.attachments ?? [], []);
  assert.equal(f.reads.length, 1, "the eventual harness projects exactly once");
  f.engineFor("fake-b").at(-1)!.complete();
  await f.idle(id);
  await f.close();
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentRuntime,
  CanonicalTurnRequest,
  ProjectService,
  RuntimeEvent,
  RuntimeSession,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService, type SessionTitlePolicy } from "../src/sessions.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> => {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("condition was not met");
    await sleep(20);
  }
};

function fixture(
  policy: SessionTitlePolicy | undefined,
  options: { generationFails?: boolean; admissionDelayMs?: number; generationDelayMs?: number } = {},
) {
  const store = createStore(":memory:");
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  let backendSessionId = "";
  let nativeTitle = "";
  let generated = 0;
  let generatedPrompt = "";

  const runtime: AgentRuntime = {
    harnessId: "fake",
    capabilities: async () => ({
      streaming: true,
      permissions: false,
      questions: false,
      compaction: false,
      subagents: false,
      title: "native",
    }),
    commands: async () => [],
    models: async () => [],
    agents: async () => [],
    ensureSession: async ({ sessionId }) => {
      backendSessionId = `native-${sessionId}`;
      return backendSessionId;
    },
    sessions: async (): Promise<RuntimeSession[]> => backendSessionId ? [{
      id: backendSessionId,
      title: nativeTitle || "New session",
      createdAt: 1,
      updatedAt: 1,
    }] : [],
    history: async () => [],
    async startTurn(request: CanonicalTurnRequest) {
      for (const listener of listeners) {
        listener(request.sessionId, { type: "turn/started", turnId: `turn-${request.sessionId}` });
      }
      if (options.admissionDelayMs) await sleep(options.admissionDelayMs);
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
    titleGenerator: {
      policy: () => policy,
      generate: async ({ prompt }) => {
        generated += 1;
        generatedPrompt = prompt;
        if (options.generationDelayMs) await sleep(options.generationDelayMs);
        if (options.generationFails) throw Object.assign(new Error("generator unavailable"), { code: "unavailable" });
        return "Generated semantic title";
      },
    },
  });

  return {
    store,
    sessions,
    generated: () => generated,
    generatedPrompt: () => generatedPrompt,
    setNativeTitle(value: string) { nativeTitle = value; },
    emit(sessionId: string, event: RuntimeEvent) {
      for (const listener of listeners) listener(sessionId, event);
    },
  };
}

test("native title before the custom fallback deadline wins without generation", async () => {
  const f = fixture({ mode: "fallback", fallbackDelayMs: 250 });
  const session = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(session.id, { text: "Fix native title race" });
  f.setNativeTitle("Native semantic title");
  f.emit(session.id, { type: "session/title-generated", title: "Native semantic title" });

  await waitUntil(async () => (await f.store.projection(session.id))?.title === "Native semantic title");
  await sleep(320);
  assert.equal((await f.store.projection(session.id))?.titleSource, "native");
  assert.equal(f.generated(), 0);
  await f.store.close();
});

test("native placeholders leave the custom fallback deadline active", async () => {
  const f = fixture({ mode: "fallback", fallbackDelayMs: 250 });
  const session = await f.sessions.create({ projectId: "p" });
  f.setNativeTitle("New session");
  await f.sessions.send(session.id, { text: "Replace a native placeholder with a custom title" });
  f.emit(session.id, { type: "session/title-generated", title: "New session" });

  await sleep(40);
  assert.equal((await f.store.projection(session.id))?.titleSource, "placeholder");
  assert.equal(f.generated(), 0);
  await waitUntil(async () => (await f.store.projection(session.id))?.title === "Generated semantic title");
  assert.equal((await f.store.projection(session.id))?.titleSource, "generated");
  assert.equal(f.generated(), 1);
  await f.store.close();
});

test("custom fallback claims title authority after the deadline and ignores late native titles", async () => {
  const f = fixture({ mode: "fallback", fallbackDelayMs: 250 });
  const session = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(session.id, { text: "Add a custom title fallback" });

  await waitUntil(async () => (await f.store.projection(session.id))?.title === "Generated semantic title");
  assert.equal((await f.store.projection(session.id))?.titleSource, "generated");
  assert.equal(f.generated(), 1);
  assert.equal(f.generatedPrompt(), "Add a custom title fallback");

  f.setNativeTitle("Native too late");
  f.emit(session.id, { type: "session/title-generated", title: "Native too late" });
  await sleep(40);
  assert.equal((await f.store.projection(session.id))?.title, "Generated semantic title");
  await f.store.close();
});

test("always mode owns automatic titles from admission and rejects native replacement", async () => {
  const f = fixture({ mode: "always", fallbackDelayMs: 250 });
  const session = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(session.id, { text: "Use custom titles always" });

  f.setNativeTitle("Harness title");
  f.emit(session.id, { type: "session/title-generated", title: "Harness title" });
  await waitUntil(async () => (await f.store.projection(session.id))?.title === "Generated semantic title");

  assert.equal((await f.store.projection(session.id))?.titleSource, "generated");
  assert.equal(f.generated(), 1);
  await f.store.close();
});

test("always mode persists a prompt title when custom generation fails and rejects native replacement", async () => {
  const f = fixture({ mode: "always", fallbackDelayMs: 250 }, { generationFails: true });
  const session = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(session.id, { text: "Keep a title when custom generation fails" });

  await waitUntil(async () =>
    (await f.store.projection(session.id))?.title === "Keep a title when custom generation fails");
  assert.equal((await f.store.projection(session.id))?.titleSource, "generated");
  const metadata = (await f.store.events(session.id)).find((event) => event.type === "session/metadata-changed");
  assert.deepEqual(metadata?.data, {
    title: "Keep a title when custom generation fails", source: "custom-titles-fallback",
  });
  f.emit(session.id, { type: "session/title-generated", title: "Late native title" });
  await sleep(40);
  assert.equal((await f.store.projection(session.id))?.title, "Keep a title when custom generation fails");
  assert.equal(f.generated(), 1);
  await f.store.close();
});

test("a failed custom generation prefers the harness's own title over the prompt text", async () => {
  const f = fixture({ mode: "always", fallbackDelayMs: 250 }, { generationFails: true });
  const session = await f.sessions.create({ projectId: "p" });
  f.setNativeTitle("Harness semantic title");
  await f.sessions.send(session.id, { text: "please look at why the titles are so bad right now and fix them" });

  await waitUntil(async () => (await f.store.projection(session.id))?.title === "Harness semantic title");
  assert.equal((await f.store.projection(session.id))?.titleSource, "generated");
  const metadata = (await f.store.events(session.id)).find((event) => event.type === "session/metadata-changed");
  assert.deepEqual(metadata?.data, { title: "Harness semantic title", source: "fake" });
  assert.equal(f.generated(), 1);
  await f.store.close();
});

test("fallback deadline remains authoritative when custom model generation fails", async () => {
  const f = fixture({ mode: "fallback", fallbackDelayMs: 250 }, { generationFails: true });
  const session = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(session.id, { text: "Keep deadline authority after generator failure" });

  await waitUntil(async () =>
    (await f.store.projection(session.id))?.title === "Keep deadline authority after generator failure");
  assert.equal((await f.store.projection(session.id))?.titleSource, "generated");
  assert.equal(f.generated(), 1);

  f.setNativeTitle("Late native title");
  f.emit(session.id, { type: "session/title-generated", title: "Late native title" });
  await sleep(40);
  assert.equal(
    (await f.store.projection(session.id))?.title,
    "Keep deadline authority after generator failure",
  );
  await f.store.close();
});

test("custom fallback deadline starts only after turn admission is confirmed", async () => {
  const f = fixture(
    { mode: "fallback", fallbackDelayMs: 250 },
    { admissionDelayMs: 350 },
  );
  const session = await f.sessions.create({ projectId: "p" });
  const sending = f.sessions.send(session.id, { text: "Start title timer after admission" });

  await sleep(300);
  assert.equal(f.generated(), 0, "turn/started must not start the custom fallback clock");

  await sending;
  await waitUntil(async () => (await f.store.projection(session.id))?.title === "Generated semantic title");
  assert.equal(f.generated(), 1);
  await f.store.close();
});

test("a workflow parent is named from its run task without a turn of its own", async () => {
  const f = fixture({ mode: "fallback", fallbackDelayMs: 10_000 });
  const session = await f.sessions.create({ projectId: "p", purpose: "workflow" });
  await f.sessions.requestAutomaticTitle!(session.id, "Fix the schedule package date picker");

  // No harness turn will ever name this session, so the package does not
  // wait for a native title before generating.
  const projection = await f.store.projection(session.id);
  assert.equal(projection?.title, "Generated semantic title");
  assert.equal(projection?.titleSource, "generated");
  assert.equal(f.generatedPrompt(), "Fix the schedule package date picker");
  const metadata = (await f.store.events(session.id)).find((event) => event.type === "session/metadata-changed");
  assert.deepEqual(metadata?.data, { title: "Generated semantic title", source: "custom-titles" });
  await f.store.close();
});

test("without Custom Titles a workflow parent gets the prompt-derived title", async () => {
  const f = fixture(undefined);
  const session = await f.sessions.create({ projectId: "p", purpose: "workflow" });
  await f.sessions.requestAutomaticTitle!(session.id, "Fix the schedule package date picker");

  const projection = await f.store.projection(session.id);
  assert.equal(projection?.title, "Fix the schedule package date picker");
  assert.equal(projection?.titleSource, "polyth");
  assert.equal(f.generated(), 0);
  await f.store.close();
});

test("a requested automatic title never replaces an explicit title", async () => {
  const f = fixture({ mode: "always", fallbackDelayMs: 250 });
  const session = await f.sessions.create({ projectId: "p", title: "Chosen by the person" });
  await f.sessions.requestAutomaticTitle!(session.id, "Some workflow task");

  assert.equal((await f.store.projection(session.id))?.title, "Chosen by the person");
  assert.equal((await f.store.projection(session.id))?.titleSource, "manual");
  assert.equal(f.generated(), 0);
  await f.store.close();
});

test("a hidden message neither names a session nor cancels its pending title", async () => {
  const f = fixture({ mode: "fallback", fallbackDelayMs: 250 }, { generationDelayMs: 150 });
  const session = await f.sessions.create({ projectId: "p", purpose: "workflow" });
  const naming = f.sessions.requestAutomaticTitle!(session.id, "Fix the schedule package date picker");
  await f.sessions.send(session.id, {
    text: "The user delegated a subagent's permission request to you.",
    hiddenUserMessage: true,
  });
  f.setNativeTitle("Delegated permission review");
  f.emit(session.id, { type: "session/title-generated", title: "Delegated permission review" });
  await naming;

  const projection = await f.store.projection(session.id);
  assert.equal(projection?.title, "Generated semantic title");
  assert.equal(f.generatedPrompt(), "Fix the schedule package date picker");
  assert.equal(f.generated(), 1);

  const quiet = await f.sessions.create({ projectId: "p" });
  await f.sessions.send(quiet.id, { text: "A hidden wake is not a request", hiddenUserMessage: true });
  await sleep(400);
  assert.equal((await f.store.projection(quiet.id))?.titleSource, "placeholder");
  assert.equal(f.generated(), 1);
  await f.store.close();
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createClaudeRuntime } from "../src/index.ts";
import { claudeAuthFingerprint, claudeModelDescriptors, discoverClaudeModels, invalidateClaudeModelCache } from "../src/discovery.ts";
import type { createProcessAuthority } from "@polyth/harness-runtime";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };

/** `supportedModels()` rows as Agent SDK 0.3.263 reports them. */
const MODELS = [
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: "",
    supportsEffort: true,
    supportedEffortLevels: ["max", "low", "high", "xhigh", "medium"],
  },
  { value: "haiku", displayName: "Haiku", description: "" },
] as never;

const fakeSdk = () => {
  const state = {
    options: undefined as Record<string, unknown> | undefined,
    spawns: 0,
    closes: 0,
    flagSettings: [] as Array<Record<string, unknown>>,
    setModels: [] as Array<string | undefined>,
    rejectModelChange: false,
    rejectModelDiscovery: false,
    inputs: undefined as AsyncIterator<{ uuid: string }> | undefined,
    push: (_message: unknown): void => {},
  };
  let closed = false;
  const sdk = {
    query(args: { prompt: AsyncIterable<{ uuid: string }>; options: Record<string, unknown> }) {
      state.spawns += 1;
      state.options = args.options;
      state.inputs = args.prompt[Symbol.asyncIterator]() as AsyncIterator<{ uuid: string }>;
      const pending: unknown[] = [];
      let wake: (() => void) | undefined;
      state.push = (message) => { pending.push(message); wake?.(); };
      return {
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            if (!pending.length) await new Promise<void>((r) => { wake = r; });
            while (pending.length) yield pending.shift();
          }
        },
        initializationResult: async () => ({}),
        supportedModels: async () => {
          if (state.rejectModelDiscovery) throw new Error("vendor-specific discovery failure");
          return MODELS;
        },
        applyFlagSettings: async (settings: Record<string, unknown>) => { state.flagSettings.push(settings); },
        setModel: async (model?: string) => {
          state.setModels.push(model);
          if (state.rejectModelChange) throw new Error("vendor-specific model failure");
        },
        interrupt: async () => {},
        close() { closed = true; state.closes += 1; wake?.(); },
      } as never;
    },
    getSessionInfo: async () => undefined,
    getSessionMessages: async () => [],
  };
  return { sdk, state };
};

const fakeAuthority = () => {
  const receipts: Record<string, string> = {};
  return {
    authorityId: "owned", generation: 1, receipts, releasedAuthorities: [],
    spawn() { throw new Error("the SDK fake never spawns"); },
    receipt: async (op: string, id: string) => { receipts[op] = id; },
    close: async () => {},
  } as Awaited<ReturnType<typeof createProcessAuthority>>;
};

test("effort levels map to variants only for models that support effort", () => {
  const descriptors = claudeModelDescriptors(MODELS);
  assert.deepEqual(descriptors[0]!.variants, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(descriptors[1]!.variants, undefined);
  assert.ok(descriptors[0]!.capabilities?.includes("input:pdf"));
});

test("cold discovery reads the catalog without a user message and closes its probe", async () => {
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  const models = await discoverClaudeModels({
    query: sdk.query as never,
    cwd: "/tmp",
    executable: "claude",
    authFingerprint: "cold-1",
  });
  assert.equal(models.length, 2);
  assert.equal(state.spawns, 1);
  assert.equal(state.closes, 1);
  // The prompt generator never yields, so `initialize` is the only exchange.
  const raced = await Promise.race([
    state.inputs!.next().then(() => "yielded"),
    new Promise((r) => setTimeout(() => r("silent"), 20)),
  ]);
  assert.equal(raced, "silent");
});

test("a second cold call is served from cache and deduped in flight", async () => {
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  const options = { query: sdk.query as never, cwd: "/tmp", executable: "claude", authFingerprint: "cold-2" };
  const [a, b] = await Promise.all([discoverClaudeModels(options), discoverClaudeModels(options)]);
  assert.deepEqual(a, b);
  assert.equal(state.spawns, 1, "concurrent callers share one probe");
  await discoverClaudeModels(options);
  assert.equal(state.spawns, 1, "a warm cache never spawns again");
  invalidateClaudeModelCache({ executable: "claude", authFingerprint: "cold-2" });
  await discoverClaudeModels(options);
  assert.equal(state.spawns, 2, "invalidation forces a fresh probe");
});

test("cold discovery timeout closes the probe and is retryable", async () => {
  invalidateClaudeModelCache();
  let closes = 0;
  let calls = 0;
  const query = (() => {
    calls++;
    return {
      supportedModels: () => calls === 1 ? new Promise<never>(() => {}) : Promise.resolve(MODELS),
      close: () => { closes++; },
    };
  }) as never;
  await assert.rejects(discoverClaudeModels({
    query, cwd: "/tmp", executable: "claude", authFingerprint: "timeout", timeoutMs: 5,
  }), /did not report its models in time/);
  assert.equal(closes, 1);
  assert.equal((await discoverClaudeModels({
    query, cwd: "/tmp", executable: "claude", authFingerprint: "timeout", timeoutMs: 5,
  })).length, 2);
  assert.equal(calls, 2, "a failed probe is not cached as an empty catalog");
  assert.equal(closes, 2);
});

test("a live session's query answers models with no extra spawn", async () => {
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID());
  assert.equal(state.spawns, 1);
  const models = await rt.models();
  assert.equal(models.length, 2);
  assert.equal(state.spawns, 1, "the live query is reused, not probed alongside");
});

test("the first model and variant are applied together at query creation", async () => {
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  await rt.createSessionOperation!({
    projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp",
    model: { providerID: "anthropic", modelID: "sonnet", variant: "high" },
  }, randomUUID());
  assert.equal(state.options!.effort, "high");
  assert.equal(state.options!.model, "sonnet");
  assert.deepEqual(state.setModels, [], "the initial model is not deferred to the first turn");
});

test("an invalid variant is refused at session create when the catalog is already warm", async () => {
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  await discoverClaudeModels({
    query: sdk.query as never,
    cwd: "/tmp",
    executable: "claude",
    authFingerprint: claudeAuthFingerprint(),
  });
  const before = state.spawns;
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  const outcome = await rt.createSessionOperation!({
    projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp",
    model: { providerID: "anthropic", modelID: "haiku", variant: "high" },
  }, randomUUID());
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.kind === "rejected" && outcome.code, "invalid-variant");
  assert.equal(state.spawns, before, "a refused create never opens a session query");
});

test("a changed variant is applied live, and an unchanged one is not re-applied", async () => {
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID());
  const turn = async (variant: string | undefined) => {
    const op = randomUUID();
    const admission = rt.startTurnOperation!({
      sessionId: "canonical",
      text: "task",
      model: { providerID: "anthropic", modelID: "sonnet", ...(variant ? { variant } : {}) },
    }, op);
    await state.inputs!.next();
    state.push({ type: "assistant", uuid: randomUUID(), parent_tool_use_id: null, message: { content: [{ type: "text", text: "ok" }] } });
    const outcome = await admission;
    state.push({ type: "result", is_error: false });
    await new Promise((r) => setImmediate(r));
    return outcome;
  };
  assert.equal((await turn("high")).kind, "confirmed");
  assert.deepEqual(state.flagSettings, [{ effortLevel: "high" }]);
  assert.equal((await turn("high")).kind, "confirmed");
  assert.equal(state.flagSettings.length, 1, "an unchanged effort is not re-sent");
  assert.equal((await turn(undefined)).kind, "confirmed");
  assert.deepEqual(state.flagSettings.at(-1), { effortLevel: null }, "clearing returns to the model default");
  assert.equal(state.spawns, 1, "effort changes never recreate the query");
});

test("a variant Claude does not advertise for the model is rejected", async () => {
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID());
  const outcome = await rt.startTurnOperation!({
    sessionId: "canonical",
    text: "task",
    model: { providerID: "anthropic", modelID: "haiku", variant: "high" },
  }, randomUUID());
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.kind === "rejected" && outcome.code, "invalid-variant");
  assert.deepEqual(state.flagSettings, []);
});

test("a native model rejection stays inside the stable runtime contract", async () => {
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID());
  state.rejectModelChange = true;
  const outcome = await rt.startTurnOperation!({
    sessionId: "canonical",
    text: "task",
    model: { providerID: "anthropic", modelID: "sonnet" },
  }, randomUUID());
  assert.equal(outcome.kind === "rejected" && outcome.code, "native-failure");
  assert.match(outcome.kind === "rejected" ? outcome.message : "", /did not accept the model or thinking level/i);
  assert.doesNotMatch(outcome.kind === "rejected" ? outcome.message : "", /vendor-specific/i);
});

test("a live catalog failure rejects before native model admission", async () => {
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID());
  state.rejectModelDiscovery = true;
  const outcome = await rt.startTurnOperation!({
    sessionId: "canonical",
    text: "task",
    model: { providerID: "anthropic", modelID: "sonnet", variant: "high" },
  }, randomUUID());
  assert.equal(outcome.kind === "rejected" && outcome.code, "discovery-unavailable");
  assert.match(outcome.kind === "rejected" ? outcome.message : "", /could not verify/i);
  assert.deepEqual(state.setModels, []);
  assert.deepEqual(state.flagSettings, []);
});

test("images and PDFs are native content blocks; text files are left to the server projection", async () => {
  invalidateClaudeModelCache();
  const { sdk } = fakeSdk();
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  const capabilities = await rt.capabilities();
  assert.equal(capabilities.attachments?.modalities.image, "native");
  assert.equal(capabilities.attachments?.modalities.pdf, "native");
  assert.equal(capabilities.attachments?.modalities.file, "emulated");
});

test("an attachment kind Claude has no content block for names the engine", async () => {
  invalidateClaudeModelCache();
  const { sdk } = fakeSdk();
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID());
  const outcome = await rt.startTurnOperation!({
    sessionId: "canonical",
    text: "hear this",
    attachments: [{ id: "a", name: "note.wav", mime: "audio/wav", size: 1, path: "note.wav" }],
  }, randomUUID());
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.kind === "rejected" && outcome.code, "unsupported");
  assert.match(
    outcome.kind === "rejected" ? outcome.message : "",
    /Audio attachments are not supported by the Claude Code engine\./,
  );
});

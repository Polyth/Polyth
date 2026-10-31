import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createClaudeRuntime } from "../src/index.ts";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAuthFingerprint, claudeBinaryIdentity, claudeModelDescriptors, discoverClaudeModels, invalidateClaudeModelCache, peekClaudeModels } from "../src/discovery.ts";
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
    /** What `supportedModels()` reports; a test may change it mid-way, as a
     *  CLI auto-update does between two reads. */
    models: MODELS as unknown[],
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
          return state.models as never;
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
  assert.deepEqual(descriptors[0]!.variants, ["low", "medium", "high", "xhigh", "max", "ultracode"]);
  assert.equal(descriptors[1]!.variants, undefined);
  assert.ok(descriptors[0]!.capabilities?.includes("input:pdf"));
});

test("ultracode is offered only where xhigh is advertised, and is never duplicated", () => {
  const [slower, reported] = claudeModelDescriptors([
    { value: "haiku-new", displayName: "Haiku New", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
    { value: "opus", displayName: "Opus", description: "", supportsEffort: true, supportedEffortLevels: ["low", "xhigh", "ultracode"] },
  ] as never);
  assert.deepEqual(slower!.variants, ["low", "medium", "high"], "a model without xhigh does not offer ultracode");
  assert.deepEqual(reported!.variants, ["low", "xhigh", "ultracode"], "a CLI that reports ultracode keeps one entry");
});

test("alias rows keep the concrete model the binary resolves them to; concrete rows do not repeat it", () => {
  const [opus, pinned, unresolved] = claudeModelDescriptors([
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "" },
    { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8", description: "" },
    // A binary older than `resolvedModel` says nothing; nothing is guessed.
    { value: "haiku", displayName: "Haiku", description: "" },
  ] as never);
  assert.equal(opus!.resolvedModelID, "claude-opus-5-5");
  assert.equal(opus!.modelID, "opus");
  assert.equal("resolvedModelID" in pinned!, false);
  assert.equal("resolvedModelID" in unresolved!, false);
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

test("ultracode is a picker variant that launches as xhigh with the session flag", async () => {
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  await rt.createSessionOperation!({
    projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp",
    model: { providerID: "anthropic", modelID: "sonnet", variant: "ultracode" },
  }, randomUUID());
  assert.equal(state.options!.effort, "xhigh", "ultracode launches at the level Claude runs it at");
  assert.deepEqual(state.options!.settings, { ultracode: true }, "the session-scoped flag is set at launch");

  const turn = async (variant?: string) => {
    const admission = rt.startTurnOperation!({
      sessionId: "canonical",
      text: "task",
      model: { providerID: "anthropic", modelID: "sonnet", ...(variant ? { variant } : {}) },
    }, randomUUID());
    await state.inputs!.next();
    state.push({ type: "assistant", uuid: randomUUID(), parent_tool_use_id: null, message: { content: [{ type: "text", text: "ok" }] } });
    assert.equal((await admission).kind, "confirmed");
    state.push({ type: "result", is_error: false });
    await new Promise((r) => setImmediate(r));
  };

  await turn("high");
  assert.deepEqual(state.flagSettings.at(-1), { effortLevel: "high", ultracode: false }, "leaving ultracode clears it");
  await turn("ultracode");
  assert.deepEqual(state.flagSettings.at(-1), { effortLevel: "xhigh", ultracode: true }, "selecting it again applies both flags");

  const refused = await rt.startTurnOperation!({
    sessionId: "canonical",
    text: "task",
    model: { providerID: "anthropic", modelID: "haiku", variant: "ultracode" },
  }, randomUUID());
  assert.equal(refused.kind === "rejected" && refused.code, "invalid-variant", "a model without xhigh does not offer ultracode");
  await rt.dispose();
});

test("an invalid variant is refused at session create when the catalog is already warm", async () => {
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  await discoverClaudeModels({
    query: sdk.query as never,
    cwd: "/tmp",
    // The adapter cache is scoped to the configured binary, as it can affect
    // which models and effort levels Claude reports.
    executable: process.env.POLYTH_CLAUDE_BIN ?? "claude",
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
  // The warm list is re-read once before the refusal stands: one catalog
  // probe (no session id, no conversation), never a session query.
  assert.equal(state.spawns, before + 1, "a refusal costs one catalog re-read");
  assert.equal(state.options!.sessionId, undefined, "a refused create never opens a session query");
  assert.equal(state.closes, before + 1, "the re-read probe is closed");
});

test("a warm catalog that predates a CLI update is re-read before a create is refused", async () => {
  // Live incident (2026-10-08): Claude Code auto-updated from 2.1.291 to
  // 2.1.294 one minute before a create. The picker's list (read after the
  // update) offered effort levels for `haiku`; the adapter's warm list (read
  // before it) still said `haiku` has none, and the create failed.
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  const identity = { executable: process.env.POLYTH_CLAUDE_BIN ?? "claude", authFingerprint: claudeAuthFingerprint() };
  await discoverClaudeModels({ query: sdk.query as never, cwd: "/tmp", ...identity });
  state.models = [
    MODELS[0],
    { value: "haiku", displayName: "Haiku 5.5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  ];
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  const outcome = await rt.createSessionOperation!({
    projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp",
    model: { providerID: "anthropic", modelID: "haiku", variant: "high" },
  }, randomUUID());
  assert.equal(outcome.kind, "confirmed");
  assert.equal(state.options!.model, "haiku");
  assert.equal(state.options!.effort, "high", "the re-read catalog's effort level is applied at query creation");
  assert.equal(state.spawns, 3, "one warm read, one re-read probe, one session query");
  assert.equal(peekClaudeModels(identity)?.find((model) => model.modelID === "haiku")?.name, "Haiku 5.5", "the re-read replaces the warm entry");
});

test("a failed re-read keeps the warm verdict instead of guessing", async () => {
  invalidateClaudeModelCache();
  const { sdk, state } = fakeSdk();
  await discoverClaudeModels({
    query: sdk.query as never, cwd: "/tmp",
    executable: process.env.POLYTH_CLAUDE_BIN ?? "claude", authFingerprint: claudeAuthFingerprint(),
  });
  state.rejectModelDiscovery = true;
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  const outcome = await rt.createSessionOperation!({
    projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp",
    model: { providerID: "anthropic", modelID: "haiku", variant: "high" },
  }, randomUUID());
  assert.equal(outcome.kind === "rejected" && outcome.code, "invalid-variant");
  assert.equal(state.options!.sessionId, undefined, "no session query is opened on a refusal");
});

test("the cold cache is keyed by the resolved binary, so an updated CLI starts a fresh entry", async () => {
  invalidateClaudeModelCache();
  const dir = mkdtempSync(join(tmpdir(), "polyth-claude-bin-"));
  const binary = join(dir, "claude-fake");
  writeFileSync(binary, "#!/bin/sh\necho 2.1.291\n", { mode: 0o755 });
  utimesSync(binary, new Date(1_000_000_000_000), new Date(1_000_000_000_000));
  // A bare name on PATH, the launcher path and the real file are one binary.
  const env = { PATH: `${dir}:${process.env.PATH ?? ""}` };
  const byName = claudeBinaryIdentity("claude-fake", env);
  assert.equal(byName, claudeBinaryIdentity(binary, env));
  assert.notEqual(byName, "claude-fake", "a resolvable spec is identified by its target, not its spelling");
  assert.equal(claudeBinaryIdentity("claude-fake", { PATH: "" }), "claude-fake", "an unresolvable spec stays itself");

  const { sdk, state } = fakeSdk();
  const options = { query: sdk.query as never, cwd: "/tmp", executable: binary, authFingerprint: "binary" };
  await discoverClaudeModels(options);
  await discoverClaudeModels(options);
  assert.equal(state.spawns, 1, "an unchanged binary is served from cache");
  assert.ok(peekClaudeModels(options), "the warm entry is readable under the same binary");
  // The CLI's auto-update replaces the versioned file the launcher points at.
  writeFileSync(binary, "#!/bin/sh\necho 2.1.294 updated\n", { mode: 0o755 });
  utimesSync(binary, new Date(1_000_000_100_000), new Date(1_000_000_100_000));
  assert.equal(peekClaudeModels(options), undefined, "the previous binary's warm list is not served for the new one");
  await discoverClaudeModels(options);
  assert.equal(state.spawns, 2, "an updated binary is probed afresh");
});

test("an expired warm entry is not served at session create", async () => {
  invalidateClaudeModelCache();
  const { sdk } = fakeSdk();
  let clock = 1_000;
  const options = { query: sdk.query as never, cwd: "/tmp", executable: "claude", authFingerprint: "ttl", ttlMs: 50, now: () => clock };
  await discoverClaudeModels(options);
  assert.equal(peekClaudeModels(options)?.length, 2);
  clock += 51;
  assert.equal(peekClaudeModels(options), undefined, "a stale list would refuse what the current binary offers");
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

test("a fresh session asked of a runtime still holding its process is refused, not left uncertain", async () => {
  invalidateClaudeModelCache();
  const { sdk } = fakeSdk();
  const rt = await createClaudeRuntime(context, sdk, fakeAuthority());
  const first = await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID());
  assert.equal(first.kind, "confirmed");
  // Nothing reaches Claude Code: an `unknown` here would fence every later
  // epoch recovery of the session.
  const second = await rt.resetSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, randomUUID());
  assert.equal(second.kind, "rejected");
  assert.equal(second.kind === "rejected" && second.code, "unsupported");
});

test("an unconfirmed operation keeps the native reason for the ledger", async () => {
  invalidateClaudeModelCache();
  const { sdk } = fakeSdk();
  const failing = {
    ...sdk,
    query(args: Parameters<typeof sdk.query>[0]) {
      const query = sdk.query(args) as unknown as Record<string, unknown>;
      return { ...query, initializationResult: async () => { throw new Error("spawn claude ENOENT\nstack line"); } } as never;
    },
  };
  const rt = await createClaudeRuntime(context, failing, fakeAuthority());
  const outcome = await rt.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "op-1");
  assert.deepEqual(outcome, {
    kind: "unknown",
    operationId: "op-1",
    message: "Claude Code did not confirm the operation (spawn claude ENOENT)",
  });
});

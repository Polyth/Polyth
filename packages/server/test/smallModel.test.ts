import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentRuntime, ModelRef } from "@polyth/contracts";
import { createStore } from "@polyth/session";
import {
  createSmallModelService,
  smallModelExecutionRoute,
  smallModelPreference,
  summarizeSessionFirst,
} from "../src/smallModel.ts";

test("account settings preserve the selected small model's harness", () => {
  assert.deepEqual(smallModelPreference({
    sessionDefaults: {
      smallModel: { harnessId: "claude", providerID: "anthropic", modelID: "default" },
    },
  }), {
    harnessId: "claude",
    providerID: "anthropic",
    modelID: "default",
  });
  assert.equal(smallModelPreference({ sessionDefaults: {} }), undefined);
});

test("small-model execution stays on the configured or session-owning harness", () => {
  assert.deepEqual(smallModelExecutionRoute(
    { harnessId: "codex", providerID: "openai", modelID: "gpt-mini" },
    { resolvedHarnessId: "opencode", model: { providerID: "openai", modelID: "session-model" } },
  ), {
    harnessId: "codex",
    model: { harnessId: "codex", providerID: "openai", modelID: "gpt-mini" },
  });
  assert.deepEqual(smallModelExecutionRoute(undefined, {
    resolvedHarnessId: "claude",
    model: { providerID: "anthropic", modelID: "default" },
  }), {
    harnessId: "claude",
    model: { providerID: "anthropic", modelID: "default" },
  });
});

test("a direct-provider failure does not wait then replay as a session turn", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-small-model-")), "sessions.db"));
  let submitted = 0;
  const runtime = {
    models: async () => [{ providerID: "custom", modelID: "small", name: "Small" }],
    completeSmallModel: async () => {
      throw Object.assign(new Error("provider timed out"), { code: "timeout" });
    },
    startTurnOperation: async () => {
      submitted += 1;
      throw new Error("must not submit a duplicate turn");
    },
  } as unknown as AgentRuntime;

  await assert.rejects(
    () => createSmallModelService(store).complete(runtime, {
      cwd: "/repo", prompt: "next action", maxOutputTokens: 64,
    }),
    /provider timed out/,
  );
  assert.equal(submitted, 0);
  await store.close();
});

test("a stale configured model fails before provider invocation", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-small-model-")), "sessions.db"));
  let invoked = false;
  const runtime = {
    models: async () => [{ providerID: "openai", modelID: "available", name: "Available" }],
    completeSmallModel: async () => {
      invoked = true;
      throw new Error("must not invoke provider");
    },
  } as unknown as AgentRuntime;

  await assert.rejects(
    () => createSmallModelService(store).complete(runtime, {
      cwd: "/repo",
      prompt: "improve this",
      model: { providerID: "openai", modelID: "deleted" },
      maxOutputTokens: 64,
    }),
    (error: Error & { code?: string }) => error.code === "invalid-model" && /not available/.test(error.message),
  );
  assert.equal(invoked, false);
  await store.close();
});

test("a deadline expiring during model discovery prevents late provider invocation", async () => {
  const store = createStore(":memory:");
  const controller = new AbortController();
  let release!: () => void;
  const discovery = new Promise<void>((resolveDiscovery) => { release = resolveDiscovery; });
  let invoked = false;
  const runtime = {
    harnessId: "opencode",
    models: async () => {
      await discovery;
      return [{ providerID: "custom", modelID: "small", name: "Small" }];
    },
    completeSmallModel: async () => { invoked = true; return { text: "Late title" }; },
  } as unknown as AgentRuntime;
  const generating = createSmallModelService(store).complete(runtime, {
    cwd: "/repo", prompt: "Name this session", maxOutputTokens: 96,
    model: { providerID: "custom", modelID: "small" }, signal: controller.signal,
  });
  controller.abort(Object.assign(new Error("title deadline expired"), { code: "timeout" }));
  release();
  await assert.rejects(generating, { code: "timeout" });
  assert.equal(invoked, false);
  await store.close();
});

test("an unresolved small model never falls through to the runtime default", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-small-model-")), "sessions.db"));
  let submitted = 0;
  const runtime = {
    completeSmallModel: async () => {
      throw Object.assign(new Error("direct transport unavailable"), { code: "unsupported" });
    },
    startTurnOperation: async () => {
      submitted += 1;
      throw new Error("must not use the default model");
    },
  } as unknown as AgentRuntime;

  await assert.rejects(
    () => createSmallModelService(store).complete(runtime, {
      cwd: "/repo",
      prompt: "improve this",
      maxOutputTokens: 64,
    }),
    (error: Error & { code?: string }) => error.code === "unavailable" && /no small model configured/.test(error.message),
  );
  assert.equal(submitted, 0);
  await store.close();
});

test("an unsupported direct transport falls back to one compatibility turn", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-small-model-")), "sessions.db"));
  let handler: Parameters<AgentRuntime["onEvent"]>[0] = () => {};
  let submitted = 0;
  let directModel: unknown;
  let fallbackModel: unknown;
  const runtime = {
    models: async () => [{ providerID: "custom", modelID: "small", name: "Small" }],
    completeSmallModel: async (request: { model?: unknown }) => {
      directModel = request.model;
      throw Object.assign(new Error("direct transport unavailable"), { code: "unsupported" });
    },
    createSessionOperation: async () => ({
      kind: "confirmed" as const,
      value: { backendSessionId: "backend-utility" },
    }),
    startTurnOperation: async (request: { sessionId: string; model?: unknown }) => {
      submitted += 1;
      fallbackModel = request.model;
      handler(request.sessionId, { type: "assistant/message", partId: "answer", text: "improved prompt" });
      handler(request.sessionId, { type: "turn/stopped", reason: "completed" });
      return { kind: "confirmed" as const, value: undefined };
    },
    onEvent: (next: typeof handler) => {
      handler = next;
      return { dispose() {} };
    },
  } as unknown as AgentRuntime;

  const result = await createSmallModelService(store).complete(runtime, {
    cwd: "/repo",
    prompt: "improve this",
    model: { providerID: "custom", modelID: "small", harnessId: "opencode" } as ModelRef & { harnessId: string },
    maxOutputTokens: 64,
  });

  assert.equal(result.text, "improved prompt");
  assert.equal(result.transport, "compatibility");
  assert.equal(submitted, 1);
  assert.deepEqual(directModel, { providerID: "custom", modelID: "small" });
  assert.deepEqual(fallbackModel, directModel);
  await store.close();
});

test("a direct-only completion never falls back to an agent turn", async () => {
  const store = createStore(":memory:");
  let submitted = 0;
  const unsupported = {
    models: async () => [{ providerID: "custom", modelID: "small", name: "Small" }],
    completeSmallModel: async () => { throw Object.assign(new Error("direct transport unavailable"), { code: "unsupported" }); },
    startTurnOperation: async () => { submitted += 1; throw new Error("must not run an agent turn"); },
  } as unknown as AgentRuntime;
  const options = { cwd: "/repo", prompt: "judge this", model: { providerID: "custom", modelID: "small" }, maxOutputTokens: 64, requireDirect: true };
  await assert.rejects(() => createSmallModelService(store).complete(unsupported, options), { code: "unsupported" });
  // A runtime with no direct transport at all is refused the same way.
  const { completeSmallModel: _direct, ...turnOnly } = unsupported as unknown as Record<string, unknown>;
  await assert.rejects(() => createSmallModelService(store).complete(turnOnly as unknown as AgentRuntime, options), { code: "unsupported" });
  assert.equal(submitted, 0);
  await store.close();
});

test("a catalog model named default runs on its selected non-OpenCode harness", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-small-model-")), "sessions.db"));
  let handler: Parameters<AgentRuntime["onEvent"]>[0] = () => {};
  let fallbackModel: unknown;
  const runtime = {
    harnessId: "claude",
    models: async () => [{ providerID: "anthropic", modelID: "default", name: "Default" }],
    createSessionOperation: async () => ({
      kind: "confirmed" as const,
      value: { backendSessionId: "claude-utility" },
    }),
    startTurnOperation: async (request: { sessionId: string; model?: unknown }) => {
      fallbackModel = request.model;
      handler(request.sessionId, { type: "assistant/message", partId: "answer", text: "next step" });
      handler(request.sessionId, { type: "turn/stopped", reason: "completed" });
      return { kind: "confirmed" as const, value: undefined };
    },
    onEvent: (next: typeof handler) => {
      handler = next;
      return { dispose() {} };
    },
  } as unknown as AgentRuntime;

  const result = await createSmallModelService(store).complete(runtime, {
    cwd: "/repo",
    prompt: "next action",
    model: { providerID: "anthropic", modelID: "default" },
    maxOutputTokens: 64,
  });

  assert.equal(result.text, "next step");
  assert.equal(result.transport, "compatibility");
  assert.deepEqual(fallbackModel, { providerID: "anthropic", modelID: "default" });
  await store.close();
});

test("an invalid-model refusal marks the shared model catalog stale", async () => {
  const store = createStore(join(mkdtempSync(join(tmpdir(), "polyth-small-model-")), "sessions.db"));
  const signals: unknown[] = [];
  const service = createSmallModelService(store, { modelCatalogStale: (signal) => { signals.push(signal); } });
  const runtime = {
    harnessId: "opencode",
    models: async () => [{ providerID: "custom", modelID: "small", name: "Small" }],
    completeSmallModel: async () => {
      throw Object.assign(new Error("provider completion failed (404)"), { code: "invalid-model" });
    },
  } as unknown as AgentRuntime;
  await assert.rejects(
    () => service.complete(runtime, { cwd: "/repo", prompt: "x", maxOutputTokens: 8, model: { providerID: "custom", modelID: "small" } }),
    { code: "invalid-model" },
  );
  // The configured model is missing from the runtime's own list as well.
  await assert.rejects(
    () => service.complete(runtime, { cwd: "/repo", prompt: "x", maxOutputTokens: 8, model: { providerID: "custom", modelID: "retired" } }),
    { code: "invalid-model" },
  );
  assert.deepEqual(signals, [
    { harnessId: "opencode", reason: "small-model-invalid-model" },
    { harnessId: "opencode", reason: "small-model-invalid-model" },
  ]);

  // Other failures say nothing about the catalog.
  const timeout = {
    ...runtime,
    completeSmallModel: async () => { throw Object.assign(new Error("slow"), { code: "timeout" }); },
  } as unknown as AgentRuntime;
  await assert.rejects(() => service.complete(timeout, { cwd: "/repo", prompt: "x", maxOutputTokens: 8, model: { providerID: "custom", modelID: "small" } }));
  assert.equal(signals.length, 2);
});

test("a compaction summary runs on the session's own runtime before any project runtime", async () => {
  const model: ModelRef = { providerID: "antigravity", modelID: "gemini-flash" };
  const session = { completeSmallModel: async () => ({}) } as unknown as AgentRuntime;
  const acquired: Array<string | undefined> = [];
  const runs: Array<{ runtime: AgentRuntime; requireDirect: boolean }> = [];
  const text = await summarizeSessionFirst({
    sessionRuntime: session,
    sessionRoute: { model, harnessId: "antigravity" },
    fallbackRoute: { model, harnessId: "antigravity" },
    projectRuntime: async (harnessId) => {
      acquired.push(harnessId);
      throw new Error("A validated local Space and canonical session are required");
    },
    run: async (runtime, _model, requireDirect) => {
      runs.push({ runtime, requireDirect });
      return "SUMMARY";
    },
  });
  assert.equal(text, "SUMMARY");
  assert.deepEqual(runs, [{ runtime: session, requireDirect: true }]);
  assert.deepEqual(acquired, []);
});

test("a failed session summary falls back to the configured small model and reports the session's failure", async () => {
  const session = { completeSmallModel: async () => ({}) } as unknown as AgentRuntime;
  const utility = {} as AgentRuntime;
  const sessionRoute = { model: { providerID: "a", modelID: "big" }, harnessId: "a" };
  const acquired: Array<string | undefined> = [];
  const text = await summarizeSessionFirst({
    sessionRuntime: session,
    sessionRoute,
    fallbackRoute: { model: { providerID: "b", modelID: "small" }, harnessId: "b" },
    projectRuntime: async (harnessId) => { acquired.push(harnessId); return utility; },
    run: async (runtime) => {
      if (runtime === session) throw new Error("session model unavailable");
      return "FALLBACK";
    },
  });
  assert.equal(text, "FALLBACK");
  // The session route is not retried on a project runtime.
  assert.deepEqual(acquired, ["b"]);

  await assert.rejects(() => summarizeSessionFirst({
    sessionRuntime: session,
    sessionRoute,
    fallbackRoute: { model: { providerID: "b", modelID: "small" }, harnessId: "b" },
    projectRuntime: async () => utility,
    run: async (runtime) => {
      throw new Error(runtime === session ? "session model unavailable" : "small model unavailable");
    },
  }), /session model unavailable/);
});

test("a session out of quota asks the configured small model first, then its own model", async () => {
  const session = { completeSmallModel: async () => ({}) } as unknown as AgentRuntime;
  const utility = {} as AgentRuntime;
  const sessionRoute = { model: { providerID: "a", modelID: "big" }, harnessId: "a" };
  const fallbackRoute = { model: { providerID: "b", modelID: "small" }, harnessId: "b" };
  const runs: Array<string | undefined> = [];
  const text = await summarizeSessionFirst({
    sessionRuntime: session,
    sessionRoute,
    fallbackRoute,
    smallModelFirst: true,
    projectRuntime: async () => utility,
    run: async (_runtime, model) => { runs.push(model?.modelID); return "SMALL"; },
  });
  assert.equal(text, "SMALL");
  assert.deepEqual(runs, ["small"]);

  // The small model failing still leaves the session's own model, once.
  runs.length = 0;
  const own = await summarizeSessionFirst({
    sessionRuntime: session,
    sessionRoute,
    fallbackRoute,
    smallModelFirst: true,
    projectRuntime: async () => utility,
    run: async (runtime, model) => {
      runs.push(model?.modelID);
      if (runtime !== session) throw new Error("small model unavailable");
      return "OWN";
    },
  });
  assert.equal(own, "OWN");
  assert.deepEqual(runs, ["small", "big"]);
});

test("a session runtime without direct completion summarizes on a project runtime", async () => {
  const session = {} as AgentRuntime;
  const project = {} as AgentRuntime;
  const runs: Array<{ runtime: AgentRuntime; requireDirect: boolean }> = [];
  const text = await summarizeSessionFirst({
    sessionRuntime: session,
    sessionRoute: { harnessId: "codex" },
    fallbackRoute: { harnessId: "codex" },
    projectRuntime: async () => project,
    run: async (runtime, _model, requireDirect) => { runs.push({ runtime, requireDirect }); return "S"; },
  });
  assert.equal(text, "S");
  assert.deepEqual(runs, [{ runtime: project, requireDirect: false }]);
});

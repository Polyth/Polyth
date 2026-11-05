import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentRuntime, ModelRef } from "@polyth/contracts";
import { createStore } from "@polyth/session";
import {
  compactionModelPreference,
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

test("compaction uses the session model unless the account chose the small model", () => {
  assert.equal(compactionModelPreference({ sessionDefaults: { compactionModel: "small" } }), "small");
  assert.equal(compactionModelPreference({ sessionDefaults: { compactionModel: "session" } }), "session");
  assert.equal(compactionModelPreference({ sessionDefaults: { compactionModel: "huge" } }), "session");
  assert.equal(compactionModelPreference({}), "session");
  assert.equal(compactionModelPreference(null), "session");
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

test("a failed compaction summary names every model it tried, with its own reason", async () => {
  // The chat d34b0ef0 case: the chosen small model answered blank, then the
  // session's Claude model refused over its 5-hour limit.
  const session = { completeSmallModel: async () => ({}) } as unknown as AgentRuntime;
  const utility = {} as AgentRuntime;
  const runs: string[] = [];
  const failure = await summarizeSessionFirst({
    sessionRuntime: session,
    sessionRoute: { model: { providerID: "anthropic", modelID: "opus" }, harnessId: "claude" },
    fallbackRoute: { model: { providerID: "opencode-go", modelID: "muse-spark" }, harnessId: "pi" },
    smallModelFirst: true,
    projectRuntime: async () => utility,
    describe: (route) => `${route.model?.modelID} on ${route.harnessId === "claude" ? "Claude Code" : "Pi"}`,
    retryDelayMs: 0,
    run: async (runtime) => {
      runs.push(runtime === utility ? "small" : "own");
      if (runtime === utility) return "  \n";
      throw Object.assign(new Error("You've hit your 5-hour limit · resets 2:50pm (Europe/Kyiv)"), { code: "unavailable" });
    },
  }).then(() => undefined, (error: unknown) => error as Error & { code?: string });
  assert.ok(failure);
  assert.equal(
    failure.message,
    "muse-spark on Pi: returned an empty summary (tried 2 times); opus on Claude Code: You've hit your 5-hour limit · resets 2:50pm (Europe/Kyiv)",
  );
  assert.equal(failure.code, "invalid-response");
  // The blank answer is retried once; the limit refusal is not.
  assert.deepEqual(runs, ["small", "small", "own"]);
});

test("a compaction summary failure without a describer names the model and harness id", async () => {
  await assert.rejects(() => summarizeSessionFirst({
    sessionRoute: { model: { providerID: "a", modelID: "big" }, harnessId: "codex" },
    fallbackRoute: { model: { providerID: "a", modelID: "big" }, harnessId: "codex" },
    projectRuntime: async () => ({}) as AgentRuntime,
    run: async () => { throw Object.assign(new Error("quota"), { code: "rate-limited" }); },
  }), (error: Error & { code?: string }) => {
    assert.equal(error.message, "big on codex: quota");
    assert.equal(error.code, "rate-limited");
    return true;
  });
});

test("a compaction summary retries a blank or transient answer once on the same route", async () => {
  const route = { model: { providerID: "a", modelID: "big" }, harnessId: "codex" };
  let acquired = 0;
  const answers: Array<() => string> = [() => "", () => "SUMMARY"];
  const text = await summarizeSessionFirst({
    sessionRoute: route,
    fallbackRoute: route,
    retryDelayMs: 0,
    projectRuntime: async () => { acquired += 1; return {} as AgentRuntime; },
    run: async () => answers.shift()!(),
  });
  assert.equal(text, "SUMMARY");
  assert.equal(acquired, 1);

  const calls: string[] = [];
  const overloaded = await summarizeSessionFirst({
    sessionRoute: route,
    fallbackRoute: route,
    retryDelayMs: 0,
    projectRuntime: async () => ({}) as AgentRuntime,
    run: async () => {
      calls.push("run");
      if (calls.length === 1) throw Object.assign(new Error("API Error: 529 Overloaded"), { code: "unavailable" });
      return "AGAIN";
    },
  });
  assert.equal(overloaded, "AGAIN");
  assert.equal(calls.length, 2);
});

test("a compaction summary never retries a limit, timeout or unknown failure", async () => {
  const route = { model: { providerID: "a", modelID: "big" }, harnessId: "codex" };
  for (const error of [
    Object.assign(new Error("You've hit your 5-hour limit · resets 2:50pm (Europe/Kyiv)"), { code: "unavailable" }),
    Object.assign(new Error("API Error: 429 rate limit"), { code: "unavailable" }),
    Object.assign(new Error("claude utility completion timed out after 180000ms"), { code: "unavailable" }),
    Object.assign(new Error("slow"), { code: "timeout" }),
    Object.assign(new Error("lost"), { code: "outcome-unknown" }),
    Object.assign(new Error("no such model"), { code: "invalid-model" }),
  ]) {
    let calls = 0;
    await assert.rejects(() => summarizeSessionFirst({
      sessionRoute: route,
      fallbackRoute: route,
      retryDelayMs: 0,
      projectRuntime: async () => ({}) as AgentRuntime,
      run: async () => { calls += 1; throw error; },
    }), (failure: Error) => !failure.message.includes("tried 2 times"));
    assert.equal(calls, 1, error.message);
  }
});

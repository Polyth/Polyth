import test from "node:test";
import assert from "node:assert/strict";
import {
  choice, noul, score, createJudgmentRuntime, createJudgmentBudget, createJudgmentConcurrency,
  JudgmentExecutionError, JudgmentEngineRegistry, questionSetId, resolveTarget,
  type JudgmentObservation,
} from "../src/index.ts";
import { createFakeJudgmentEngine } from "../src/testing.ts";

const request = () => ({ scope: "test.evidence.v1", state: { text: "private evidence" }, questions: { done: noul("Is it done?") } });
const response = { answers: { done: { type: "noul" as const, probability: 0.8, confidence: 0.8 } } };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reason = async (runtime: ReturnType<typeof createJudgmentRuntime>, input = request()) => {
  const result = await runtime.judge(input);
  assert.equal(result.ok, false);
  return result.ok ? undefined : result.reason;
};

test("typed primitives preserve uncertainty and fractional scores", async () => {
  const questions = { done: noul("Is it done?"), next: choice("What next?", { complete: "Complete", cannot_tell: "Unknown" }), risk: score("How risky?", ["None", "Medium", "High"]) };
  const engine = createFakeJudgmentEngine({ answers: { ...response.answers,
    next: { type: "choice", value: "cannot_tell", confidence: 0.55, probabilities: { complete: 0.45, cannot_tell: 0.55 } },
    risk: { type: "score", score: 1.25, confidence: 0.5, probabilities: [0.125, 0.5, 0.375], levelCount: 3 } } });
  const result = await createJudgmentRuntime({ engines: [engine] }).judge({ ...request(), questions });
  assert.ok(result.ok);
  const inferred: "complete" | "cannot_tell" = result.answers.next.value;
  // @ts-expect-error The inferred result is a literal union, not an arbitrary label.
  const wrong: "invented" = result.answers.next.value;
  assert.equal(inferred, "cannot_tell");
  assert.equal(result.answers.risk.score, 1.25);
  assert.equal(result.answers.done.probability, 0.8);
  assert.equal(result.attempts, 1);
  void wrong;
});

test("target fields inherit independently with scope precedence", () => {
  assert.deepEqual(resolveTarget({ defaults: { engineId: "default", providerId: "default", modelId: "default" },
    global: { engineId: "global", providerId: "global", modelId: "global", scopes: { "memory.persist.v1": { modelId: "cheap" } } },
    project: { providerId: "project" }, scope: "memory.persist.v1" }), { engineId: "global", providerId: "project", modelId: "cheap" });
  assert.deepEqual(resolveTarget({ global: { scopes: { x: { providerId: "scope" } } }, project: { scopes: { x: { modelId: "project-scope" } } },
    target: { modelId: "call" }, scope: "x" }), { providerId: "scope", modelId: "call" });
});

test("a model chosen for one provider never carries over to another", () => {
  const defaults = { providerId: "paid", modelId: "paid-model" };
  assert.deepEqual(resolveTarget({ defaults, project: { providerId: "free" }, scope: "x", defaultModels: { paid: "paid-model", free: "free-model" } }),
    { providerId: "free", modelId: "free-model" });
  assert.deepEqual(resolveTarget({ defaults, global: { modelId: "paid-large" }, project: { providerId: "free" }, scope: "x" }),
    { providerId: "free" }, "no default for the new provider leaves the model unresolved instead of borrowing one");
  assert.deepEqual(resolveTarget({ defaults, global: { providerId: "free", modelId: "free-large" }, scope: "x", defaultModels: { free: "free-model" } }),
    { providerId: "free", modelId: "free-large" });
});

test("a provider chosen under one engine never carries over to another", () => {
  const engineDefaults = { providerId: "local", modelId: "tiny" };
  assert.deepEqual(resolveTarget({ defaults: { engineId: "jev" }, global: { providerId: "typesafe", modelId: "jev-1" }, project: { engineId: "local" },
    scope: "x", engineDefaults }), { engineId: "local", providerId: "local", modelId: "tiny" });
  assert.deepEqual(resolveTarget({ defaults: { engineId: "jev" }, global: { engineId: "local" }, project: { providerId: "local", modelId: "big" },
    scope: "x", engineDefaults }), { engineId: "local", providerId: "local", modelId: "big" });
  assert.deepEqual(resolveTarget({ defaults: { engineId: "jev" }, global: { providerId: "typesafe" }, project: { engineId: "local" }, scope: "x" }),
    { engineId: "local" }, "without engine defaults the foreign provider is dropped, not sent");
});

test("configuration resolves through the adapter, independent of state/session model", async () => {
  const engine = createFakeJudgmentEngine(response);
  const runtime = createJudgmentRuntime({ engines: [engine], global: { providerId: "unavailable" },
    project: { providerId: "fake-provider", scopes: { "test.evidence.v1": { modelId: "fake-model" } } } });
  assert.ok((await runtime.judge({ ...request(), state: { harness: "codex", model: "agent-model" } })).ok);
  assert.deepEqual(engine.calls[0]!.target, { engineId: "fake", providerId: "fake-provider", modelId: "fake-model" });
});

const invalidRequests: Array<[string, (input: Record<string, unknown>) => void]> = [
  ["empty questions", (r) => { r.questions = {}; }],
  ["invalid question id", (r) => { r.questions = { "bad id": noul("Question") }; }],
  ["unsafe question id", (r) => { r.questions = { constructor: noul("Question") }; }],
  ["NaN", (r) => { r.state = NaN; }], ["Infinity", (r) => { r.state = { n: Infinity }; }],
  ["undefined", (r) => { r.state = { n: undefined }; }], ["BigInt", (r) => { r.state = 1n; }],
  ["Date", (r) => { r.state = new Date(); }], ["function", (r) => { r.state = { fn() {} }; }],
  ["cycle", (r) => { const state = { self: {} }; state.self = state; r.state = state; }],
  ["sparse array", (r) => { r.state = new Array(3); }],
  ["sparse array with compensating named properties", (r) => { r.state = Object.assign(new Array(2), { first: 1, second: 2 }); }],
  ["oversized UTF-8 state", (r) => { r.state = "🙂".repeat(17_000); }],
  ["oversized question", (r) => { r.questions = { q: noul("x".repeat(8_001)) }; }],
  ["too many questions", (r) => { r.questions = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i}`, noul("Q")])); }],
  ["single choice", (r) => { r.questions = { q: choice("Q", { x: "Only" }) }; }],
  ["single score level", (r) => { r.questions = { q: score("Q", ["Only"]) }; }],
  ["unlimited budget", (r) => { r.budget = { maxCalls: Infinity }; }],
  ["negative budget", (r) => { r.budget = { maxWallClockMs: -1 }; }],
  ["empty target", (r) => { r.target = { modelId: "" }; }],
  ["raw metadata", (r) => { r.metadata = { state: "private" }; }],
];
for (const [name, mutate] of invalidRequests) test(`invalid request: ${name}`, async () => {
  const engine = createFakeJudgmentEngine(response), input = request();
  mutate(input);
  assert.equal(await reason(createJudgmentRuntime({ engines: [engine] }), input), "invalid-request");
  assert.equal(engine.calls.length, 0);
});

test("state byte limits count serialized arrays without charging for non-serialized indices", async () => {
  const runtime = createJudgmentRuntime({ engines: [createFakeJudgmentEngine(response)], limits: { maxStateBytes: 64 } });
  const result = await runtime.judge({ ...request(), state: Array(30).fill(0) });
  assert.ok(result.ok);
});

const invalidAnswers = [
  {}, { done: response.answers.done, extra: response.answers.done },
  { done: { type: "score", score: 0, confidence: 1, levelCount: 2 } },
  { done: { type: "noul", probability: -0.1, confidence: 1 } },
  { done: { type: "noul", probability: 0.5, confidence: 1.1 } },
  { done: { type: "noul", probability: NaN, confidence: 1 } },
];
for (const [index, answers] of invalidAnswers.entries()) test(`invalid response ${index} is never retried or defaulted`, async () => {
  const engine = createFakeJudgmentEngine({ answers: answers as typeof response.answers });
  const result = await createJudgmentRuntime({ engines: [engine] }).judge(request());
  assert.ok(!result.ok); assert.equal(result.reason, "invalid-response"); assert.equal(result.attempts, 1);
  assert.ok(!("answers" in result)); assert.equal(engine.calls.length, 1);
});

test("choice labels, distribution and score bounds are validated", async () => {
  const cases = [
    { q: choice("Q", { a: "A", b: "B" }), a: { type: "choice", value: "unknown", confidence: 1, probabilities: { a: 1, b: 0 } } },
    { q: choice("Q", { a: "A", b: "B" }), a: { type: "choice", value: ["a"], confidence: 1, probabilities: { a: 1, b: 0 } } },
    { q: choice("Q", { a: "A", b: "B" }), a: { type: "choice", value: "a", confidence: 1, probabilities: { a: 1 } } },
    { q: choice("Q", { a: "A", b: "B" }), a: { type: "choice", value: "a", confidence: 1, probabilities: { a: 1, b: 1 } } },
    { q: score("Q", ["Low", "High"]), a: { type: "score", score: 2, confidence: 1, levelCount: 2 } },
    { q: score("Q", ["Low", "High"]), a: { type: "score", score: 0.5, confidence: 1, levelCount: 3 } },
  ];
  for (const { q, a } of cases) {
    const runtime = createJudgmentRuntime({ engines: [createFakeJudgmentEngine({ answers: { q: a } } as never)] });
    const result = await runtime.judge({ ...request(), questions: { q } });
    assert.ok(!result.ok); assert.equal(result.reason, "invalid-response");
  }
});

test("disabled and unavailable targets never reach the engine", async () => {
  const engine = createFakeJudgmentEngine(response);
  assert.equal(await reason(createJudgmentRuntime({ global: { enabled: false }, engines: [engine] })), "disabled");
  assert.equal(await reason(createJudgmentRuntime()), "engine-unavailable");
  const runtime = createJudgmentRuntime({ engines: [engine] });
  for (const [target, expected] of [[{ engineId: "missing" }, "engine-unavailable"], [{ providerId: "other" }, "provider-unavailable"], [{ modelId: "other" }, "model-unavailable"]] as const) {
    assert.equal(await reason(runtime, { ...request(), target } as ReturnType<typeof request>), expected);
  }
  assert.equal(engine.calls.length, 0);
});

test("transient retry succeeds and exhaustion remains explicit", async () => {
  const transient = new JudgmentExecutionError("provider-error", true);
  const engine = createFakeJudgmentEngine({ script: [transient, response] });
  const result = await createJudgmentRuntime({ engines: [engine] }).judge(request());
  assert.ok(result.ok); assert.equal(result.attempts, 2);
  const failed = await createJudgmentRuntime({ engines: [createFakeJudgmentEngine({ script: [transient, transient] })] }).judge(request());
  assert.ok(!failed.ok); assert.equal(failed.reason, "provider-error"); assert.equal(failed.attempts, 2);
});

test("untrusted errors are sanitized and not retried", async () => {
  const observations: JudgmentObservation[] = [];
  const engine = createFakeJudgmentEngine({ script: [async () => { throw new Error("secret and raw response"); }] });
  const result = await createJudgmentRuntime({ engines: [engine], observe: (o) => observations.push(o) }).judge(request());
  assert.ok(!result.ok); assert.equal(result.reason, "provider-error"); assert.equal(result.attempts, 1);
  assert.doesNotMatch(JSON.stringify([result, observations]), /secret|raw response|private evidence/);
});

test("abort and deadline propagate, including adapters that ignore cancellation", async () => {
  let signal: AbortSignal | undefined;
  const engine = createFakeJudgmentEngine({ script: [async (_, ctx) => { signal = ctx.signal; return new Promise(() => {}); }] });
  const runtime = createJudgmentRuntime({ engines: [engine], limits: { timeoutMs: 30, maxConcurrentCalls: 1 } });
  assert.equal(await reason(runtime), "timeout"); assert.ok(signal?.aborted);
  assert.equal(await reason(runtime), "timeout"); assert.equal(engine.calls.length, 1);
  const controller = new AbortController();
  const cancelling = createJudgmentRuntime({ engines: [createFakeJudgmentEngine({ script: [async () => new Promise(() => {})] })] });
  const pending = cancelling.judge({ ...request(), signal: controller.signal });
  await pause(5); controller.abort();
  const aborted = await pending; assert.ok(!aborted.ok); assert.equal(aborted.reason, "cancelled");
  assert.equal((await cancelling.judge({ ...request(), signal: controller.signal })).attempts, 0);
});

test("dispose cancels queued and active calls", async () => {
  const engine = createFakeJudgmentEngine({ script: [async () => new Promise(() => {})] });
  const runtime = createJudgmentRuntime({ engines: [engine], limits: { maxConcurrentCalls: 1 } });
  const first = runtime.judge(request()), second = runtime.judge(request());
  await pause(5); runtime.dispose();
  for (const result of await Promise.all([first, second])) { assert.ok(!result.ok); assert.equal(result.reason, "cancelled"); }
  assert.equal(engine.calls.length, 1);
});

test("deadline still rejects a synchronous adapter that blocks timer delivery", async () => {
  let signal: AbortSignal | undefined;
  const engine = createFakeJudgmentEngine({ script: [async (_, ctx) => {
    signal = ctx.signal;
    const until = performance.now() + 80;
    while (performance.now() < until) { /* Exercise a blocked event loop, not an asynchronous timer. */ }
    return response;
  }] });
  const result = await createJudgmentRuntime({ engines: [engine], limits: { timeoutMs: 50 } }).judge(request());
  assert.ok(!result.ok); assert.equal(result.reason, "timeout"); assert.ok(signal?.aborted);
});

test("shared reservation budget applies to concurrent runtimes and retries", async () => {
  const budget = createJudgmentBudget({ maxCalls: 1, maxInputBytes: 96_000, maxWallClockMs: 20_000 });
  const engine = createFakeJudgmentEngine(response);
  const runtimes = [0, 1].map(() => createJudgmentRuntime({ budget, engines: [engine] }));
  const results = await Promise.all(runtimes.map((runtime) => runtime.judge(request())));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok && r.reason === "budget-exhausted").length, 1);
  assert.equal(engine.calls.length, 1);
  const retrying = createFakeJudgmentEngine({ script: [new JudgmentExecutionError("provider-error", true), response] });
  const result = await createJudgmentRuntime({ engines: [retrying] }).judge({ ...request(), budget: { maxCalls: 1 } });
  assert.ok(!result.ok); assert.equal(result.reason, "budget-exhausted"); assert.equal(result.attempts, 1);
});

test("byte and wall reservations reject before execution; failed reservations roll back", async () => {
  for (const cap of [{ maxCalls: 0 }, { maxInputBytes: 1 }, { maxWallClockMs: 0 }]) {
    const engine = createFakeJudgmentEngine(response);
    const result = await createJudgmentRuntime({ engines: [engine] }).judge({ ...request(), budget: cap });
    assert.ok(!result.ok); assert.equal(result.reason, "budget-exhausted"); assert.equal(engine.calls.length, 0);
  }
  const pool = createJudgmentBudget({ maxCalls: 2, maxInputBytes: 100, maxWallClockMs: 30 });
  const first = pool.reserve(25, 20);
  assert.throws(() => pool.reserve(25, 20), /budget-exhausted/);
  first.cancel(); assert.deepEqual(pool.snapshot(), { calls: 0, inputBytes: 0, wallClockMs: 0, reservedWallClockMs: 0 });
});

test("FIFO concurrency bounds physical calls across runs", async () => {
  let active = 0, peak = 0;
  const engine = createFakeJudgmentEngine({ script: Array.from({ length: 8 }, () => async () => {
    active++; peak = Math.max(peak, active); await pause(5); active--; return response;
  }) });
  const pool = createJudgmentConcurrency(2);
  const runtimes = [0, 1].map(() => createJudgmentRuntime({ engines: [engine], concurrency: pool }));
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runtimes[i % 2]!.judge(request())));
  assert.ok(results.every((r) => r.ok)); assert.equal(peak, 2);
});

test("fingerprint is order independent and changes with semantics, not evidence", async () => {
  const a = { a: noul("A?"), b: choice("B?", { x: "X", y: "Y" }) };
  const b = { b: choice("B?", { y: "Y", x: "X" }), a: noul("A?") };
  assert.equal(await questionSetId("s.v1", a), await questionSetId("s.v1", b));
  assert.notEqual(await questionSetId("s.v1", a), await questionSetId("s.v2", a));
  assert.notEqual(await questionSetId("s.v1", a), await questionSetId("s.v1", { ...a, a: noul("Changed?") }));
});

test("telemetry excludes evidence, questions and raw extras; observer failure is isolated", async () => {
  const observations: JudgmentObservation[] = [];
  const engine = createFakeJudgmentEngine({ answers: { done: { ...response.answers.done, secret: "credential" } } } as never);
  const runtime = createJudgmentRuntime({ engines: [engine], observe: (o) => { observations.push(o); throw new Error("observer"); } });
  const result = await runtime.judge({ ...request(), metadata: { projectId: "project-a" } });
  assert.ok(result.ok); assert.equal(observations.length, 1);
  assert.equal(observations[0]!.status, "success"); assert.equal(observations[0]!.providerId, "fake-provider");
  assert.doesNotMatch(JSON.stringify([result, observations]), /credential|private evidence|Is it done/);
  assert.equal(observations[0]!.projectId, "project-a");
});

test("valid unavailable calls retain question fingerprints and measured input sizes", async () => {
  const observations: JudgmentObservation[] = [];
  const result = await createJudgmentRuntime({ observe: (o) => observations.push(o) }).judge(request());
  assert.ok(!result.ok); assert.equal(result.reason, "engine-unavailable");
  assert.match(observations[0]!.questionSetId, /^sha256:[a-f0-9]{64}$/);
  assert.ok(observations[0]!.requestBytes > observations[0]!.stateBytes);
});

test("engine registration cleanup and replacement preserve the consumer API", async () => {
  const registry = new JudgmentEngineRegistry();
  const remove = registry.register(createFakeJudgmentEngine({ ...response, id: "first" }));
  assert.throws(() => registry.register(createFakeJudgmentEngine({ id: "first" })), /duplicate/);
  const runtime = createJudgmentRuntime({ registry });
  assert.ok((await runtime.judge(request())).ok); remove();
  assert.equal(await reason(runtime), "engine-unavailable");
  registry.register(createFakeJudgmentEngine({ ...response, id: "second" }));
  const result = await runtime.judge(request()); assert.ok(result.ok); assert.equal(result.engine.id, "second");
});

test("caller mutation cannot alter admitted state or questions", async () => {
  const engine = createFakeJudgmentEngine(response);
  const input = request();
  const pending = createJudgmentRuntime({ engines: [engine] }).judge(input);
  input.state.text = "changed"; input.questions.done = noul("Changed");
  assert.ok((await pending).ok);
  assert.equal((engine.calls[0]!.state as { text: string }).text, "private evidence");
  assert.equal(engine.calls[0]!.questions.done!.instructions, "Is it done?");
});

test("correlation metadata accepts host UUIDs that start with a digit, and still rejects unknown keys", async () => {
  const engine = createFakeJudgmentEngine(response);
  const runtime = createJudgmentRuntime({ engines: [engine] });
  const ok = await runtime.judge({ ...request(), metadata: { projectId: "e17e998c-4a55-4e62-ba49-6ff0ff824d97", sessionId: "534341ce-6de9-4ff0-92d9-b6e16d70c806" } });
  assert.ok(ok.ok);
  const bad = await runtime.judge({ ...request(), metadata: { projectId: "../escape" } });
  assert.ok(!bad.ok); assert.equal(bad.reason, "invalid-request");
  const unknown = await runtime.judge({ ...request(), metadata: { owner: "abc" } as never });
  assert.ok(!unknown.ok); assert.equal(unknown.reason, "invalid-request");
});

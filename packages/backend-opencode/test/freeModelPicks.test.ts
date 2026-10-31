import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelDescriptor, RuntimeEvent } from "@polyth/contracts";
import type { RuntimeLifecycle } from "../src/runtime.ts";
import { createOpenCodeRuntimeFacade } from "../src/index.ts";
import {
  createFreeModelPicker,
  createFreeModelUsageObserver,
  FREE_PICK_PROVIDER_ID,
  isFreeModel,
} from "../src/freeModelPicks.ts";
import {
  calibrateRatings,
  configureFreeModelUtility,
  createFreeModelEvidence,
  EVAL_PURPOSE,
  createSpeedMeter,
  EVAL_TASKS,
  evalPrompt,
  fetchArenaText,
  gradeEvalReply,
  matchArena,
  type ArenaEntry,
  type EvalResult,
  type EvidenceHttp,
  type FreeModelEvidence,
  type SpeedSample,
} from "../src/freeModelEvidence.ts";

const free = (modelID: string, name: string, extra: Partial<ModelDescriptor> = {}): ModelDescriptor => ({
  providerID: "opencode",
  modelID,
  name,
  cost: { input: 0, output: 0 },
  capabilities: ["toolcall", "input:text", "output:text"],
  variants: ["low", "medium", "high"],
  context: 200_000,
  connected: true,
  ...extra,
});

// Ids shaped like the live OpenCode free catalog on 2026-10-18. Ranking below
// depends only on the evidence each test supplies, never on these names.
const catalog: ModelDescriptor[] = [
  { providerID: "anthropic", modelID: "claude-opus", name: "Claude Opus", cost: { input: 15, output: 75 }, capabilities: ["toolcall"], connected: true },
  free("big-pickle", "Big Pickle"),
  free("nemotron-3-ultra-free", "Nemotron 3 Ultra Free"),
  free("nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free"),
  free("deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash Free"),
  free("no-tools-free", "No Tools Free", { capabilities: ["input:text", "output:text"] }),
  free("offline-free", "Offline Free", { connected: false }),
  { providerID: "opencode", modelID: "unpriced", name: "Unpriced", connected: true },
];
const poolIds = ["big-pickle", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free", "deepseek-v4.1-flash-free"];

const speed = (ttftMs: number, tokensPerSecond: number): SpeedSample => ({
  ttftMs, tokensPerSecond, outputTokens: 200, tokenSource: "usage", measuredAt: 0,
});
const evaluation = (accuracy: number): EvalResult => ({ correct: accuracy * 16, total: 16, accuracy, measuredAt: 0 });

/** Evidence fixed by the test; refreshes are recorded, never performed. */
const fixedEvidence = (input: {
  speeds?: Record<string, SpeedSample>;
  evaluations?: Record<string, EvalResult>;
  arena?: ArenaEntry[];
} = {}) => {
  const calls: string[] = [];
  const evidence: FreeModelEvidence = {
    speed: (model) => input.speeds?.[model.modelID],
    evaluation: (model) => input.evaluations?.[model.modelID],
    arena: () => input.arena,
    refreshSpeed: async (models) => { calls.push(`speed:${models.length}`); },
    refreshArena: async () => { calls.push("arena"); },
    refreshEvaluations: async (models) => { calls.push(`eval:${models.length}`); },
  };
  return { evidence, calls };
};

/** Measurements that are never expected to run: evidence is fixed. */
const unusedMeasurements = {
  measureSpeed: async () => { throw new Error("not measured in this test"); },
  evaluate: async () => { throw new Error("not evaluated in this test"); },
};

const pickerWith = (evidence: FreeModelEvidence, now?: () => number) => {
  const picker = createFreeModelPicker({ evidence, measurements: unusedMeasurements, ...(now ? { now } : {}) });
  picker.withPicks(catalog);
  return picker;
};
const pick = (modelID: string) => ({ providerID: FREE_PICK_PROVIDER_ID, modelID });

test("only connected zero-cost models that can call tools are in the pool", () => {
  assert.deepEqual(catalog.filter(isFreeModel).map((model) => model.modelID), poolIds);
});

test("the speed meter times native deltas until the first step ends", () => {
  const delta = (text: string, field = "text") => ({ type: "message.part.delta", properties: { partID: "p", field, delta: text } });
  const stepEnd = (output: number, reasoning: number) => ({
    type: "message.updated",
    properties: { info: { id: "m", role: "assistant", time: { created: 1, completed: 2 }, tokens: { input: 5_000, output, reasoning } } },
  });
  const meter = createSpeedMeter(1_000);
  meter.observe({ type: "message.updated", properties: { info: { id: "m", role: "assistant", time: { created: 1 } } } }, 1_500);
  meter.observe(delta("Counting", "reasoning"), 2_400);
  meter.observe(delta("one two"), 2_900);
  meter.observe(delta(" sixty"), 4_400);
  meter.observe(stepEnd(120, 31), 4_410);
  // A second step after a tool call never stretches the measurement.
  meter.observe(delta("late"), 30_000);
  assert.deepEqual(meter.sample(42), { ttftMs: 1_400, tokensPerSecond: 150 / 2, outputTokens: 151, tokenSource: "usage", measuredAt: 42 });

  // Legacy streams carry the delta on part updates.
  const legacy = createSpeedMeter(0);
  for (let index = 0; index < 10; index += 1) legacy.observe({ type: "message.part.updated", properties: { delta: "w " } }, 100 + index * 100);
  assert.equal(legacy.sample(0).tokenSource, "chunks");
  assert.equal(legacy.sample(0).tokensPerSecond, 9 / 0.9);

  const empty = createSpeedMeter(0);
  empty.observe(delta("hi"), 5);
  assert.throws(() => empty.sample(0), { code: "insufficient" });
});

test("the own test is one prompt with every task, graded by its numbered lines", () => {
  const prompt = evalPrompt();
  assert.match(prompt, /^Do not use any tools/);
  assert.equal(prompt.split("\n").filter((line) => /^\d+\. /.test(line)).length, EVAL_TASKS.length);
  const reply = EVAL_TASKS.map((task, index) => `${index + 1}: ${index % 2 ? task.answer : "wrong"}`).join("\n");
  const result = gradeEvalReply(`${reply}\n**3**: ${EVAL_TASKS[2]!.answer}.`, EVAL_TASKS, 7);
  const expected = Math.floor(EVAL_TASKS.length / 2) + 1;
  assert.deepEqual(result, { correct: expected, total: EVAL_TASKS.length, accuracy: expected / EVAL_TASKS.length, measuredAt: 7 });
  // Answers are compared case-insensitively ("NaN" vs "nan").
  assert.equal(gradeEvalReply("10: 1,nan,nan", EVAL_TASKS).correct, EVAL_TASKS[9]!.answer === "1,NaN,NaN" ? 1 : 0);
  assert.throws(() => gradeEvalReply("I cannot help with that."), { code: "insufficient" });
});

test("the arena reader keeps overall rows and stops at the next category", async () => {
  const urls: string[] = [];
  const row = (name: string, rating: number, category = "overall") => ({ row: { model_name: name, organization: "nvidia", rating, vote_count: 10, category, leaderboard_publish_date: "2026-10-15" } });
  const http: EvidenceHttp = async (request) => {
    urls.push(request.url);
    const offset = Number(new URL(request.url).searchParams.get("offset"));
    const rows = offset === 0
      ? Array.from({ length: 100 }, (_, index) => row(`m${index}`, 1400 - index))
      : [row("tail", 1200), row("other", 1500, "chinese")];
    return { status: 200, text: JSON.stringify({ rows }) };
  };
  const entries = await fetchArenaText(http);
  assert.equal(entries.length, 101);
  assert.equal(entries.at(-1)!.name, "tail");
  assert.equal(urls.length, 2);
  assert.match(urls[0]!, /config=text_style_control&split=latest&offset=0/);
});

test("arena entries match a catalog model only by identity, ignoring run tags", () => {
  const entries: ArenaEntry[] = [
    { name: "nvidia-nemotron-3-ultra-550b-a55b-nvfp4", organization: "nvidia", rating: 1426, votes: 11_567 },
    { name: "nvidia-nemotron-3.5-super-120b", organization: "nvidia", rating: 1400, votes: 100 },
    { name: "deepseek-v4.1-flash-max", organization: "deepseek", rating: 1474, votes: 12_793 },
    { name: "mimo-v2-flash (thinking)", organization: "xiaomi", rating: 1386, votes: 11_142 },
    { name: "mimo-v2-flash", organization: "xiaomi", rating: 1391, votes: 48_088 },
  ];
  assert.equal(matchArena({ modelID: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free" }, entries)?.entry.rating, 1426);
  assert.equal(matchArena({ modelID: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free" }, entries)?.entry.rating, 1474);
  // A longer catalog id is a different model, never a partial match.
  assert.equal(matchArena({ modelID: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free" }, entries), undefined);
  assert.equal(matchArena({ modelID: "space-bunny-free", name: "Space Bunny Free" }, entries), undefined);
  // Several runs of one model: the one with more votes wins a tie.
  assert.equal(matchArena({ modelID: "mimo-v2-flash-free", name: "MiMo V2 Flash Free" }, entries)?.entry.rating, 1391);
});

test("ratings come from equal-scoring listed models first, then a positive fit", () => {
  assert.equal(calibrateRatings([]), undefined);
  // Saturated test: an unlisted full score takes the mean of listed full scores.
  const saturated = calibrateRatings([{ rating: 1474, accuracy: 1 }, { rating: 1470, accuracy: 1 }])!;
  assert.equal(saturated(1), 1472);
  assert.equal(saturated(0.9), undefined);
  // A negative relation predicts nothing beyond exact peers.
  const negative = calibrateRatings([{ rating: 1450, accuracy: 0.5 }, { rating: 1400, accuracy: 0.8 }, { rating: 1420, accuracy: 0.7 }])!;
  assert.equal(negative(0.6), undefined);
  assert.equal(negative(0.8), 1400);
  const predict = calibrateRatings([{ rating: 1350, accuracy: 0.5 }, { rating: 1400, accuracy: 0.75 }, { rating: 1450, accuracy: 1 }])!;
  assert.equal(predict(0.875), 1425);
  assert.equal(predict(-5), 1250);
});

test("a measurement cancelled by a closed runtime is not a failure", async () => {
  let calls = 0;
  const store = createFreeModelEvidence({ log: () => {} });
  const model = { providerID: "opencode", modelID: "big-pickle" };
  const cancelled = async (): Promise<SpeedSample> => { calls += 1; throw Object.assign(new Error("gone"), { code: "cancelled" }); };
  await store.refreshSpeed([model], cancelled);
  await store.refreshSpeed([model], cancelled);
  assert.equal(calls, 2);
});

test("fastest ranks by measured TTFT plus generation time, not by catalog order", () => {
  const { evidence } = fixedEvidence({ speeds: {
    "big-pickle": speed(300, 120),
    "nemotron-3-ultra-free": speed(4_000, 60),
    // Quick first token, slow stream: 0.2 + 500/20 = 25.2 s.
    "nemotron-3.5-lightning-free": speed(200, 20),
  } });
  const picker = pickerWith(evidence);
  const ranked = picker.rank("fastest");
  assert.deepEqual(ranked.map((row) => [row.model.modelID, row.measured]), [
    ["big-pickle", true], ["nemotron-3-ultra-free", true], ["nemotron-3.5-lightning-free", true], ["deepseek-v4.1-flash-free", false],
  ]);
  assert.ok(Math.abs(ranked[0]!.expectedSeconds! - (0.3 + 500 / 120)) < 1e-9);
  assert.deepEqual(picker.resolve(pick("fastest"))?.model, { providerID: "opencode", modelID: "big-pickle", variant: "low" });
});

test("smartest uses the arena rating and predicts unlisted models from the calibrated test", () => {
  const arena: ArenaEntry[] = [
    { name: "nvidia-nemotron-3-ultra-550b-a55b-nvfp4", organization: "nvidia", rating: 1426, votes: 1 },
    { name: "nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4", organization: "nvidia", rating: 1351, votes: 1 },
    { name: "deepseek-v4.1-flash-max", organization: "deepseek", rating: 1474, votes: 1 },
  ];
  const evaluations = {
    "nemotron-3-ultra-free": evaluation(0.75),
    "nemotron-3.5-lightning-free": evaluation(0.5),
    "deepseek-v4.1-flash-free": evaluation(0.875),
    "big-pickle": evaluation(1),
  };
  const ranked = pickerWith(fixedEvidence({ arena, evaluations }).evidence).rank("smartest");
  assert.equal(ranked[0]!.model.modelID, "big-pickle");
  assert.equal(ranked[0]!.intelligence?.source, "test");
  assert.ok(ranked[0]!.intelligence!.rating > 1474);
  assert.deepEqual(ranked.slice(1).map((row) => [row.model.modelID, row.intelligence?.source]), [
    ["deepseek-v4.1-flash-free", "arena"], ["nemotron-3-ultra-free", "arena"], ["nemotron-3.5-lightning-free", "arena"],
  ]);

  // Without a calibration point an unlisted model stays unrated.
  const sparse = pickerWith(fixedEvidence({ arena, evaluations: { "big-pickle": evaluation(1) } }).evidence).rank("smartest");
  assert.equal(sparse.find((row) => row.model.modelID === "big-pickle")?.measured, false);
  assert.equal(sparse[0]!.model.modelID, "deepseek-v4.1-flash-free");
});

test("balanced needs both measurements and prefers the model good at both", () => {
  const arena: ArenaEntry[] = [
    { name: "nemotron-3-ultra", rating: 1480, votes: 1 },
    { name: "nemotron-3.5-lightning", rating: 1350, votes: 1 },
    { name: "deepseek-v4.1-flash", rating: 1460, votes: 1 },
  ];
  const speeds = {
    "nemotron-3-ultra-free": speed(6_000, 25),
    "nemotron-3.5-lightning-free": speed(300, 150),
    "deepseek-v4.1-flash-free": speed(800, 90),
    "big-pickle": speed(200, 200),
  };
  const ranked = pickerWith(fixedEvidence({ arena, speeds }).evidence).rank("balanced");
  assert.equal(ranked[0]!.model.modelID, "deepseek-v4.1-flash-free");
  assert.equal(ranked.find((row) => row.model.modelID === "big-pickle")?.measured, false);
  assert.equal(pickerWith(fixedEvidence({ arena, speeds }).evidence).resolve(pick("balanced"))?.model.variant, undefined);
});

test("with no evidence yet a pick still routes, in OpenCode's own order", () => {
  const resolved = pickerWith(fixedEvidence().evidence).resolve(pick("smartest"));
  assert.equal(resolved?.measured, false);
  assert.deepEqual(resolved?.model, { providerID: "opencode", modelID: "big-pickle", variant: "high" });
  assert.equal(pickerWith(fixedEvidence().evidence).resolve({ providerID: "opencode", modelID: "big-pickle" }), undefined);
});

test("preparing a mode gathers only what it ranks by and does not wait on the test", async () => {
  const fastest = fixedEvidence();
  await pickerWith(fastest.evidence).prepare("fastest", 1_000);
  assert.deepEqual(fastest.calls, ["speed:4"]);
  const smartest = fixedEvidence();
  await pickerWith(smartest.evidence).prepare("smartest", 1_000);
  assert.deepEqual(smartest.calls.sort(), ["arena", "eval:4"]);
  const stuck: FreeModelEvidence = { ...fixedEvidence().evidence, refreshArena: () => new Promise(() => {}) };
  const started = Date.now();
  await pickerWith(stuck).prepare("smartest", 30);
  assert.ok(Date.now() - started < 1_000);
});

test("the evidence store measures once per TTL, shares in-flight work and backs off after a failure", async () => {
  let now = 0;
  let probes = 0;
  let fail = false;
  const measure = async (): Promise<SpeedSample> => {
    probes += 1;
    await Promise.resolve();
    if (fail) throw new Error("probe turn failed");
    return speed(500, 49);
  };
  const store = createFreeModelEvidence({ now: () => now, log: () => {} });
  const model = { providerID: "opencode", modelID: "big-pickle" };
  await Promise.all([store.refreshSpeed([model], measure), store.refreshSpeed([model], measure)]);
  assert.equal(probes, 1);
  assert.equal(store.speed(model)?.tokensPerSecond, 49);
  now += 5 * 60 * 60_000;
  await store.refreshSpeed([model], measure);
  assert.equal(probes, 1);
  now += 60 * 60_000;
  fail = true;
  await store.refreshSpeed([model], measure);
  assert.equal(probes, 2);
  // The older sample stays usable; the failed probe waits before a retry.
  assert.equal(store.speed(model)?.tokensPerSecond, 49);
  await store.refreshSpeed([model], measure);
  assert.equal(probes, 2);
  now += 15 * 60_000;
  await store.refreshSpeed([model], measure);
  assert.equal(probes, 3);
});

test("a cooling model is routed around until it recovers, unless nothing else is left", () => {
  let now = 1_000;
  const { evidence } = fixedEvidence({ speeds: { "big-pickle": speed(100, 200), "nemotron-3-ultra-free": speed(900, 40) } });
  const picker = pickerWith(evidence, () => now);
  picker.recordLimit({ providerID: "opencode", modelID: "big-pickle" }, 60_000);
  assert.equal(picker.resolve(pick("fastest"))?.model.modelID, "nemotron-3-ultra-free");
  now += 61_000;
  assert.equal(picker.resolve(pick("fastest"))?.model.modelID, "big-pickle");

  const lonely = createFreeModelPicker({ evidence, measurements: unusedMeasurements, now: () => now });
  lonely.withPicks([free("only-free", "Only Free")]);
  lonely.recordLimit({ providerID: "opencode", modelID: "only-free" }, 60_000);
  assert.equal(lonely.resolve(pick("fastest"))?.model.modelID, "only-free");
});

test("the usage observer counts completed steps and cools a limited pick", () => {
  let now = 5_000;
  const picker = pickerWith(fixedEvidence().evidence, () => now);
  const observer = createFreeModelUsageObserver(picker, { now: () => now });
  const step = (time: Record<string, number>, extra: Record<string, unknown> = {}) => ({
    type: "message.updated",
    properties: { info: { id: "msg_1", role: "assistant", providerID: "opencode", modelID: "big-pickle", time, ...extra } },
  });
  // V2 projects step.started and step.ended into two updates; only the start names the model.
  observer.observe("s1", step({ created: 10 }));
  observer.observe("s1", step({ created: 20, completed: 20 }, { providerID: undefined, modelID: undefined }));
  observer.observe("s1", step({ created: 20, completed: 30 }));
  const reliability = () => picker.rank("fastest").find((row) => row.model.modelID === "big-pickle")!.reliability;
  assert.equal(reliability(), 1);

  observer.routed("s1", { providerID: "opencode", modelID: "nemotron-3.5-lightning-free", variant: "low" });
  observer.observe("s1", {
    type: "session.error",
    properties: { error: { name: "APIError", data: { message: "Rate limit exceeded", statusCode: 429 } } },
  });
  const lightning = () => picker.rank("fastest").find((row) => row.model.modelID === "nemotron-3.5-lightning-free")!;
  assert.equal(lightning().coolingDown, true);
  // Waiting out a limit says nothing about the model's quality.
  assert.equal(lightning().reliability, 1);
  now += 5 * 60_000 + 1;
  assert.equal(lightning().coolingDown, false);
  observer.observe("s1", { type: "session.error", properties: { error: { name: "UnknownError", data: { message: "boom" } } } });
  assert.ok(lightning().reliability < 1);
  assert.equal(lightning().coolingDown, false);
});

const stubLifecycle = (models: ModelDescriptor[], submitted: unknown[]) => {
  const endpoint = {
    authorityId: "free-pick-test", generation: 1, continuity: "verified" as const,
    url: "http://fake.invalid", location: { directory: "/tmp" },
    control: { kind: "borrowed" as const, source: "external" as const },
    config: { kind: "read-only" as const }, authentication: { kind: "none" as const },
  };
  const protocol = { models: async () => models };
  return {
    endpoint: async () => endpoint,
    protocol: async () => "v2" as const,
    usingProtocol: async <T>(fn: (value: typeof protocol) => Promise<T>) => fn(protocol),
    submit: async (input: unknown) => {
      submitted.push(input);
      return { kind: "confirmed" as const, value: {} };
    },
    abort: async (binding: { canonicalSessionId?: string }) => {
      submitted.push({ aborted: binding.canonicalSessionId });
      return { kind: "confirmed" as const, value: {} };
    },
    streamEvents: async ({ signal }: Parameters<RuntimeLifecycle["streamEvents"]>[0]) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
  } as unknown as RuntimeLifecycle;
};

test("the facade lists picks and runs the concrete free model the evidence names", async () => {
  const submitted: Array<{ model?: unknown }> = [];
  const { evidence, calls } = fixedEvidence({ speeds: { "deepseek-v4.1-flash-free": speed(250, 140), "big-pickle": speed(900, 40) } });
  const runtime = createOpenCodeRuntimeFacade({
    cwd: "/tmp",
    lifecycle: stubLifecycle(catalog, submitted),
    sessionIdMap: new Map([["canonical", "backend"]]),
    freeModelPicker: createFreeModelPicker({ evidence, measurements: unusedMeasurements }),
  });
  const events: RuntimeEvent[] = [];
  runtime.onEvent((_id, event) => events.push(event));
  try {
    const listed = await runtime.models();
    assert.equal(listed.filter((row) => row.providerID === FREE_PICK_PROVIDER_ID).length, 3);
    const outcome = await runtime.startTurnOperation!({ sessionId: "canonical", text: "hi", model: pick("fastest") }, "op-1");
    assert.equal(outcome.kind, "confirmed");
    const concrete = { providerID: "opencode", modelID: "deepseek-v4.1-flash-free", variant: "low" };
    assert.deepEqual(submitted[0]?.model, concrete);
    assert.deepEqual(calls, ["speed:4"]);
    const started = events.find((event) => event.type === "turn/started");
    assert.deepEqual(started && "model" in started ? started.model : undefined, concrete);
  } finally {
    await runtime.dispose();
  }
});

test("picks are named by mode and sit before the free tier so a free-only catalog defaults to balanced", () => {
  const picker = pickerWith(fixedEvidence({ speeds: { "big-pickle": speed(300, 120) } }).evidence);
  const listed = picker.withPicks(catalog);
  const picks = listed.filter((row) => row.providerID === FREE_PICK_PROVIDER_ID);
  // The concrete model can change between listing and the turn, so the row
  // never names one.
  assert.deepEqual(picks.map((row) => row.name), ["Balanced", "Fastest", "Smartest"]);
  // A configured (paid) row stays ahead; the picks come before the first free
  // model, which is what an unchosen route otherwise falls back to.
  assert.deepEqual(listed.slice(0, 4).map((row) => row.modelID), ["claude-opus", "balanced", "fastest", "smartest"]);
  assert.equal(listed[4]?.modelID, "big-pickle");

  const freeOnly = picker.withPicks(catalog.filter((row) => row.providerID !== "anthropic"));
  assert.equal(freeOnly[0]?.providerID, FREE_PICK_PROVIDER_ID);
  assert.equal(freeOnly[0]?.modelID, "balanced");
  assert.equal(freeOnly[0]?.name, "Balanced");
});

test("a pick with no free model served is rejected as an invalid model before submit", async () => {
  const submitted: unknown[] = [];
  const runtime = createOpenCodeRuntimeFacade({
    cwd: "/tmp",
    lifecycle: stubLifecycle([catalog[0]!], submitted),
    sessionIdMap: new Map([["canonical", "backend"]]),
    freeModelPicker: createFreeModelPicker({ evidence: fixedEvidence().evidence, measurements: unusedMeasurements }),
  });
  try {
    const outcome = await runtime.startTurnOperation!({ sessionId: "canonical", text: "hi", model: pick("smartest") }, "op-1");
    assert.equal(outcome.kind, "rejected");
    assert.equal(outcome.kind === "rejected" && outcome.code, "invalid-model");
    assert.equal(submitted.length, 0);
  } finally {
    await runtime.dispose();
  }
});

test("a measurement turn that times out is aborted instead of left running", async () => {
  const submitted: Array<Record<string, unknown>> = [];
  const sessionIdMap = new Map<string, string>(poolIds.map((id) => [`oneshot-${id}`, `backend-${id}`]));
  sessionIdMap.set("user", "backend-user");
  const runtime = createOpenCodeRuntimeFacade({
    cwd: "/tmp",
    lifecycle: stubLifecycle(catalog, submitted),
    sessionIdMap,
    // No leaderboard: only the test runs, and every run times out.
    freeModelEvidence: createFreeModelEvidence({ log: () => {}, http: async () => ({ status: 503, text: "" }) }),
  });
  // The host one-shot submits the turn, then gives up waiting for it.
  const utility = configureFreeModelUtility(async (rt, turn) => {
    await rt.startTurnOperation!({
      sessionId: `oneshot-${turn.model.modelID}`, text: turn.prompt, model: turn.model, utility: { purpose: turn.purpose },
    }, `op-${turn.model.modelID}`);
    throw new Error("small-model task timed out after 300000ms");
  });
  try {
    const outcome = await runtime.startTurnOperation!({ sessionId: "user", text: "hi", model: pick("smartest") }, "op-user");
    assert.equal(outcome.kind, "confirmed");
    const aborted = () => submitted.flatMap((entry) => typeof entry.aborted === "string" ? [entry.aborted] : []);
    for (let attempt = 0; attempt < 100 && aborted().length < poolIds.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(aborted().sort(), poolIds.map((id) => `oneshot-${id}`).sort());
    const evaluations = submitted.filter((entry) => entry.text === evalPrompt());
    assert.equal(evaluations.length, poolIds.length);
    assert.ok(EVAL_PURPOSE);
  } finally {
    utility.dispose();
    await runtime.dispose();
  }
});

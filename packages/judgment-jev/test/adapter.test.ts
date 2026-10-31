import test from "node:test";
import assert from "node:assert/strict";
import { choice, noul, score, createJudgmentRuntime, type JudgmentObservation } from "@polyth/judgment";
import { createJevJudgmentEngine, discoverJevModels, JEV_DEFAULT_MODEL, JEV_ROUTES } from "../src/index.ts";
import { routeModel } from "../src/routes.ts";

const fixtureSecret = "offline-test-credential";
const withCredential = async (use: (secret: string) => Promise<void>) => use(fixtureSecret);
const questions = { positive: noul("Is the evidence positive?"), outcome: choice("Completion?", { complete: "Verified", cannot_tell: "Insufficient" }), strength: score("Strength?", ["None", "Some", "Direct"]) };
const native = () => ({ model: "jev-1.13.0", answers: {
  positive: { type: "noul", noul: 0.7 },
  outcome: { type: "choice", choice: "cannot_tell", confidence: 0.6, probabilities: { complete: 0.4, cannot_tell: 0.6 } },
  strength: { type: "score", score: 1.25, confidence: 0.5, probabilities: { "0": 0.125, "1": 0.5, "2": 0.375 }, legend: { "0": "None", "1": "Some", "2": "Direct" } },
}, usage: { input_tokens: 100, output_tokens: 20 } });
const input = () => ({ scope: "agent.task-completion.v1", state: {
  userRequest: "Fix the mobile composer so it stays above the safe area.",
  agentResult: "Implemented viewport and safe-area fixes.",
  evidence: { changedFiles: ["composer.css"], testsPassed: ["safe-area layout"] },
}, questions });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("smoke: public API → engine → selected provider/model → actual SDK protocol → typed evidence", async () => {
  let sent: Record<string, unknown> | undefined;
  const engine = createJevJudgmentEngine({ withCredential, fetch: async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${fixtureSecret}`);
    sent = JSON.parse(init!.body as string);
    return json(native());
  } });
  const observations: JudgmentObservation[] = [];
  const result = await createJudgmentRuntime({ engines: [engine], observe: (o) => observations.push(o) }).judge({
    ...input(), target: { engineId: "jev", providerId: "typesafe", modelId: "jev-latest" },
  });
  assert.ok(result.ok);
  const outcome: "complete" | "cannot_tell" = result.answers.outcome.value;
  assert.equal(outcome, "cannot_tell");
  assert.equal(sent!.model, "jev-latest"); assert.deepEqual(sent!.state, input().state);
  assert.deepEqual(sent!.questions, {
    positive: { type: "noul", instructions: questions.positive.instructions },
    outcome: { type: "choice", instructions: questions.outcome.instructions, criteria: questions.outcome.criteria },
    strength: { type: "score", instructions: questions.strength.instructions, criteria: questions.strength.rubric },
  });
  assert.equal(result.answers.positive.probability, 0.7); assert.equal(result.answers.positive.confidence, 0.7);
  assert.equal(result.answers.strength.score, 1.25); assert.deepEqual(result.answers.strength.probabilities, [0.125, 0.5, 0.375]);
  assert.deepEqual(result.model, { providerId: "typesafe", modelId: "jev-1.13.0" });
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(observations[0]!.engineId, "jev"); assert.equal(observations[0]!.modelId, "jev-1.13.0");
  assert.doesNotMatch(JSON.stringify([result, observations]), /offline-test-credential|mobile composer|agentResult/);
});

test("model list is translated to canonical Polyth descriptors and explicit selection is sent", async () => {
  const options = { withCredential, fetch: async (url: string) => {
    assert.equal(url, "https://api.typesafe.ai/v1/models");
    return json({ models: [{ name: "jev-1.13.0", description: "Pinned release", release_date: "2026-09-18" }] });
  } };
  const models = await discoverJevModels(options, new AbortController().signal);
  assert.equal(models[0]!.providerID, "typesafe"); assert.equal(models[0]!.modelID, "jev-1.13.0");
  const engine = createJevJudgmentEngine({ withCredential, models, fetch: async (_, init) => {
    assert.equal(JSON.parse(init!.body as string).model, "jev-1.13.0"); return json(native());
  } });
  assert.ok((await createJudgmentRuntime({ engines: [engine] }).judge({ ...input(), target: { modelId: "jev-1.13.0" } })).ok);
  assert.ok((await createJudgmentRuntime({ engines: [engine] }).judge(input())).ok, "Automatic deterministically uses the available account catalog");
});

test("unsupported provider and model fail before credential or network access", async () => {
  const engine = createJevJudgmentEngine({ withCredential: async () => { assert.fail("must not resolve credential"); } });
  for (const [target, reason] of [[{ providerId: "openai" }, "provider-unavailable"], [{ modelId: "gpt-anything" }, "model-unavailable"]] as const) {
    const result = await createJudgmentRuntime({ engines: [engine] }).judge({ ...input(), target });
    assert.ok(!result.ok); assert.equal(result.reason, reason); assert.equal(result.attempts, 0);
  }
});

for (const [status, reason, attempts] of [
  [401, "provider-unavailable", 1], [402, "provider-unavailable", 1], [403, "provider-unavailable", 1], [400, "invalid-request", 1],
  [422, "invalid-request", 1], [404, "model-unavailable", 1], [429, "provider-error", 2],
  [500, "provider-error", 1], [502, "provider-error", 2], [503, "provider-error", 2], [504, "provider-error", 2],
] as const) test(`SDK HTTP ${status} is sanitized and has ${attempts} attempt(s)`, async () => {
  let calls = 0;
  const engine = createJevJudgmentEngine({ withCredential, fetch: async () => { calls++; return json({ message: fixtureSecret }, status); } });
  const result = await createJudgmentRuntime({ engines: [engine] }).judge(input());
  assert.ok(!result.ok); assert.equal(result.reason, reason); assert.equal(result.attempts, attempts); assert.equal(calls, attempts);
  assert.doesNotMatch(JSON.stringify(result), /offline-test-credential/);
});

test("only core retries a transient SDK network failure", async () => {
  let calls = 0;
  const engine = createJevJudgmentEngine({ withCredential, fetch: async () => { if (++calls === 1) throw new TypeError("network reset"); return json(native()); } });
  const result = await createJudgmentRuntime({ engines: [engine] }).judge(input());
  assert.ok(result.ok); assert.equal(result.attempts, 2); assert.equal(calls, 2);
});

test("parent abort reaches the SDK transport", async () => {
  let transportSignal: AbortSignal | null | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const engine = createJevJudgmentEngine({ withCredential, fetch: async (_, init) => {
    transportSignal = init?.signal; started();
    return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } });
  const controller = new AbortController();
  const pending = createJudgmentRuntime({ engines: [engine] }).judge({ ...input(), signal: controller.signal });
  await ready; controller.abort();
  const result = await pending;
  assert.ok(!result.ok); assert.equal(result.reason, "cancelled"); assert.ok(transportSignal?.aborted);
});

test("malformed native answers cannot become successful evidence", async () => {
  for (const mutate of [
    (raw: ReturnType<typeof native>) => { raw.answers.outcome.choice = "unknown"; },
    (raw: ReturnType<typeof native>) => { raw.answers.strength.probabilities = { "0": 1 } as never; },
    (raw: ReturnType<typeof native>) => { raw.answers.positive.noul = 9; },
    (raw: ReturnType<typeof native>) => { raw.answers = {} as never; },
  ]) {
    const raw = native(); mutate(raw);
    const engine = createJevJudgmentEngine({ withCredential, fetch: async () => json(raw) });
    const result = await createJudgmentRuntime({ engines: [engine] }).judge(input());
    assert.ok(!result.ok); assert.equal(result.reason, "invalid-response"); assert.equal(result.attempts, 1);
  }
});

test("SDK logs stay off even when ambient configuration asks for debug", async () => {
  const prior = process.env.TYPESAFE_LOG_LEVEL; process.env.TYPESAFE_LOG_LEVEL = "debug";
  const entries: unknown[][] = [];
  const original = { debug: console.debug, info: console.info, warn: console.warn, error: console.error };
  for (const key of Object.keys(original) as Array<keyof typeof original>) console[key] = (...args) => { entries.push(args); };
  try {
    const result = await createJudgmentRuntime({ engines: [createJevJudgmentEngine({ withCredential, fetch: async () => json(native()) })] }).judge(input());
    assert.ok(result.ok); assert.equal(entries.length, 0);
  } finally {
    Object.assign(console, original);
    if (prior === undefined) delete process.env.TYPESAFE_LOG_LEVEL; else process.env.TYPESAFE_LOG_LEVEL = prior;
  }
});

test("credential endpoint cannot be redirected by adapter or ambient config", async () => {
  let called = false;
  const engine = createJevJudgmentEngine({ withCredential, config: { baseUrl: "https://untrusted.invalid" }, fetch: async () => { called = true; return json(native()); } });
  const result = await createJudgmentRuntime({ engines: [engine] }).judge(input());
  assert.ok(!result.ok); assert.equal(result.reason, "provider-unavailable"); assert.equal(called, false);
});

test("every route sends only to its pinned endpoint, with its own credential, model and client headers", async () => {
  const prior = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = "ambient-key-must-not-leak";
  try {
    for (const [providerId, url, model, authorization, client] of [
      ["openrouter", "https://openrouter.ai/api/v1/systemone", "jev-latest", "Bearer openrouter-secret", null],
      ["vercel-ai-gateway", "https://ai-gateway.vercel.sh/typesafe/v1/systemone", "typesafe-ai/jev", "Bearer vercel-ai-gateway-secret", null],
      ["opencode-zen", "https://opencode.ai/zen/v1/systemone", "jev-1.13", "Bearer opencode-zen-secret", "polyth"],
      ["opencode-zen-free", "https://opencode.ai/zen/v1/systemone", "jev-1.13-free", null, "polyth"],
    ] as const) {
      const resolved: string[] = [];
      const engine = createJevJudgmentEngine({ models: JEV_ROUTES.map(routeModel),
        withCredential: async (use, route) => { resolved.push(route.provider.id); await use(`${route.provider.id}-secret`); },
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          assert.equal(input, url); assert.equal(headers.get("authorization"), authorization);
          assert.equal(headers.get("x-opencode-client"), client);
          assert.equal(JSON.parse(init!.body as string).model, model);
          return json({ ...native(), model: "jev-1.13.0" });
        } });
      // A route chosen without a model uses that route's own model, never another route's default.
      const result = await createJudgmentRuntime({ engines: [engine] }).judge({ ...input(), target: { providerId } });
      assert.ok(result.ok, providerId); assert.equal(result.model?.providerId, providerId);
      assert.deepEqual(resolved, authorization ? [providerId] : [], "a keyless route never resolves a credential");
      assert.doesNotMatch(JSON.stringify(result), /secret|ambient-key/);
    }
  } finally { if (prior === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = prior; }
});

test("Automatic uses the route the server chose; a pinned model on a route cannot drift", async () => {
  const engine = createJevJudgmentEngine({ withCredential, models: JEV_ROUTES.map(routeModel), automaticProviderId: "openrouter",
    fetch: async (input) => { assert.equal(input, "https://openrouter.ai/api/v1/systemone"); return json({ ...native(), model: "jev-1.13.0" }); } });
  assert.deepEqual(engine.capabilities().defaults, { providerId: "openrouter", modelId: "jev-latest" });
  assert.equal(engine.capabilities().defaultModels?.["vercel-ai-gateway"], "typesafe-ai/jev");
  assert.ok((await createJudgmentRuntime({ engines: [engine] }).judge(input())).ok);
  const pinned = createJevJudgmentEngine({ withCredential, models: [{ ...JEV_DEFAULT_MODEL, modelID: "jev-1.12.0" }],
    fetch: async () => json({ ...native(), model: "jev-1.13.0" }) });
  const drifted = await createJudgmentRuntime({ engines: [pinned] }).judge({ ...input(), target: { modelId: "jev-1.12.0" } });
  assert.ok(!drifted.ok); assert.equal(drifted.reason, "invalid-response");
});

test("routes without account discovery offer exactly their verified model", async () => {
  const models = await discoverJevModels({ withCredential: async () => { assert.fail("must not resolve credential"); } },
    new AbortController().signal, "vercel-ai-gateway");
  assert.deepEqual(models.map((model) => [model.providerID, model.modelID]), [["vercel-ai-gateway", "typesafe-ai/jev"]]);
  await assert.rejects(discoverJevModels({ withCredential }, new AbortController().signal, "elsewhere"), /provider-unavailable/);
});

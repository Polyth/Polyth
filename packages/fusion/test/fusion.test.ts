import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "@polyth/contracts";
import { createFusionService, parseSynthesis, synthesisPrompt } from "../src/index.ts";

interface Harness {
  events: Array<{ sessionId: string; type: string; data: JsonObject }>;
  service: ReturnType<typeof createFusionService>;
}

const flush = () => new Promise((r) => setImmediate(r));

function harness(opts: {
  runModel?: (ctx: { model: string; prompt: string }) => Promise<string>;
  synthesize?: (raw: string, userId?: string) => Promise<string>;
}): Harness {
  const events: Array<{ sessionId: string; type: string; data: JsonObject }> = [];
  const service = createFusionService({
    append: async (sessionId, type, data) => {
      events.push({ sessionId, type, data });
    },
    runModel: async (ctx) => (opts.runModel ? opts.runModel(ctx) : `reply from ${ctx.model}`),
    synthesize: async (ctx) =>
      opts.synthesize ? opts.synthesize("", ctx.userId) : '{"answer":"combined","weights":[{"model":"a","weight":2},{"model":"b","weight":2}],"disagreements":["x disagrees"]}',
    now: () => 1000,
  });
  return { events, service };
}

const types = (h: Harness) => h.events.map((e) => e.type);

test("parseSynthesis parses json and normalizes weights to sum to 1", () => {
  const r = parseSynthesis('{"answer":"ok","weights":[{"model":"a","weight":2},{"model":"b","weight":2}],"disagreements":[]}', ["a", "b"]);
  assert.equal(r.answer, "ok");
  assert.equal(r.weights.length, 2);
  const sum = r.weights.reduce((s, w) => s + w.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("parseSynthesis falls back to equal weights and prose answer when JSON is unusable", () => {
  const r = parseSynthesis("just prose, no json here", ["a", "b", "c"]);
  assert.equal(r.answer, "just prose, no json here");
  assert.deepEqual(r.weights.map((w) => w.model).sort(), ["a", "b", "c"]);
  for (const w of r.weights) assert.ok(Math.abs(w.weight - 1 / 3) < 1e-9);
  assert.deepEqual(r.disagreements, []);
});

test("synthesisPrompt embeds the prompt and every reply", () => {
  const p = synthesisPrompt("what is 2+2", [{ model: "a", text: "4" }, { model: "b", text: "four" }]);
  assert.ok(p.includes("what is 2+2"));
  assert.ok(p.includes('model="a"'));
  assert.ok(p.includes("four"));
});

test("start emits fusion/started then fusion/completed with the synthesized answer", async () => {
  const h = harness({});
  const { id } = await h.service.start("s1", { text: "explain X", models: ["a", "b"] });
  await flush();
  await flush();
  await flush();
  const state = h.service.get(id)!;
  assert.equal(state.status, "completed");
  assert.equal(state.answer, "combined");
  assert.deepEqual(state.disagreements, ["x disagrees"]);
  assert.deepEqual(state.sources, [
    { model: "a", text: "reply from a" },
    { model: "b", text: "reply from b" },
  ]);
  assert.deepEqual(types(h), ["fusion/started", "fusion/completed"]);
  const completed = h.events.find((event) => event.type === "fusion/completed");
  assert.deepEqual(completed?.data.sources, [
    { model: "a", answer: "reply from a" },
    { model: "b", answer: "reply from b" },
  ]);
});

test("start rejects empty prompt or no models", async () => {
  const h = harness({});
  await assert.rejects(() => h.service.start("s1", { text: "", models: ["a"] }));
  await assert.rejects(() => h.service.start("s1", { text: "hi", models: [] }));
});

test("fusion keeps requester identity for the background small-model pass", async () => {
  let seenUserId: string | undefined;
  const h = harness({
    synthesize: async (_raw, userId) => {
      seenUserId = userId;
      return '{"answer":"combined","weights":[],"disagreements":[]}';
    },
  });
  const { id } = await h.service.start("s1", { text: "hi", models: ["a"] }, "usr_test");
  await flush();
  await flush();
  assert.equal(h.service.get(id)?.status, "completed");
  assert.equal(seenUserId, "usr_test");
});

test("a runModel failure marks the fusion failed instead of throwing to the caller", async () => {
  const h = harness({ runModel: async () => { throw new Error("provider down"); } });
  const { id } = await h.service.start("s1", { text: "hi", models: ["a"] });
  await flush();
  await flush();
  await flush();
  const state = h.service.get(id)!;
  assert.equal(state.status, "failed");
  assert.ok(state.error?.includes("provider down"));
  assert.ok(types(h).includes("fusion/completed"));
});

test("snapshot maps to the wire DTO shape", async () => {
  const h = harness({});
  const { id } = await h.service.start("s1", { text: "hi", models: ["a", "b"] });
  await flush();
  await flush();
  await flush();
  const dto = h.service.snapshot(h.service.get(id)!);
  assert.equal(dto.id, id);
  assert.equal(dto.answer, "combined");
  assert.ok(Array.isArray(dto.weights));
  assert.ok(Array.isArray(dto.disagreements));
  assert.deepEqual(dto.sources, [
    { model: "a", answer: "reply from a" },
    { model: "b", answer: "reply from b" },
  ]);
});

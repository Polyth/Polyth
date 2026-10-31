import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import {
  latestFusionTopK,
  latestScoredSources,
  rankTopSources,
} from "../widgets/fusionTopK.ts";

const event = (seq: number, type: string, data: JsonObject): SessionEvent =>
  ({ id: `e${seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1 });

const scored = (seq: number, multirunId: string, providerID: string, modelID: string, score: number, confidence: number) =>
  event(seq, "multirun/run-scored", { multirunId, runId: `r${seq}`, status: "scored", score, levels: 5, confidence, model: { providerID, modelID } });

test("latestScoredSources keeps only the newest multirun's scores", () => {
  const sources = latestScoredSources([
    event(1, "multirun/started", { multirunId: "m1" }),
    scored(2, "m1", "a", "one", 3, 0.9),
    event(3, "multirun/started", { multirunId: "m2" }),
    scored(4, "m2", "b", "two", 2, 0.5),
    scored(5, "m2", "c", "three", 4, 0.8),
  ]);
  assert.deepEqual(sources, [
    { model: "b/two", score: 2, confidence: 0.5, levels: 5 },
    { model: "c/three", score: 4, confidence: 0.8, levels: 5 },
  ]);
});

test("latestScoredSources ignores skipped and malformed score events", () => {
  const sources = latestScoredSources([
    event(1, "multirun/started", { multirunId: "m1" }),
    event(2, "multirun/run-scored", { multirunId: "m1", runId: "r1", status: "skipped", note: "bad rubric" }),
    event(3, "multirun/run-scored", { multirunId: "m1", runId: "r2", status: "scored", score: "high" }),
    scored(4, "m1", "a", "one", 1.5, 0.6),
  ]);
  assert.deepEqual(sources, [{ model: "a/one", score: 1.5, confidence: 0.6, levels: 5 }]);
});

test("rankTopSources orders by score, then confidence, and stays inside the offered set", () => {
  const sources = [
    { model: "a/one", score: 2, confidence: 0.4, levels: 5 },
    { model: "b/two", score: 4, confidence: 0.7, levels: 5 },
    { model: "c/three", score: 4, confidence: 0.5, levels: 5 },
    { model: "z/missing", score: 5, confidence: 1, levels: 5 },
  ];
  assert.deepEqual(rankTopSources(sources, 2, ["a/one", "b/two", "c/three"]), ["b/two", "c/three"]);
  assert.deepEqual(rankTopSources(sources, 0, ["a/one", "b/two"]), []);
  assert.deepEqual(rankTopSources(sources, 8, ["a/one"]), ["a/one"]);
});

test("latestFusionTopK reads the server-resolved value of the newest multirun only", () => {
  const withTopK = (seq: number, multirunId: string, value: unknown) =>
    event(seq, "multirun/run-scored", { multirunId, runId: `r${seq}`, status: "scored", score: 3, levels: 5, confidence: 0.8, fusionTopK: value as number });
  assert.equal(latestFusionTopK([withTopK(1, "m1", 2)]), 2);
  // A newer multirun scored with the option off wins over an older one.
  assert.equal(latestFusionTopK([withTopK(1, "m1", 3), event(2, "multirun/started", { multirunId: "m2" }), withTopK(3, "m2", 0)]), 0);
  // A newer multirun that was not scored means off.
  assert.equal(latestFusionTopK([withTopK(1, "m1", 3), event(2, "multirun/started", { multirunId: "m2" })]), 0);
  assert.equal(latestFusionTopK([withTopK(1, "m1", 9)]), 0);
  assert.equal(latestFusionTopK([withTopK(1, "m1", "2")]), 0);
  assert.equal(latestFusionTopK([]), 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactionDue,
  compactionDueForNextModel,
  compactionLatestTokens,
  compactionMarkPercent,
  compactionReserveTokens,
  effectiveCompactionPreference,
  parseCompactionPreference,
  supportedCompactionPreference,
} from "../src/compactionPolicy.ts";

test("the reserve is a tenth of the window, between 4k and 50k tokens", () => {
  assert.equal(compactionReserveTokens(32_000), 4_000);
  assert.equal(compactionReserveTokens(200_000), 20_000);
  assert.equal(compactionReserveTokens(1_000_000), 50_000);
  assert.equal(compactionLatestTokens(32_000), 28_000);
  assert.equal(compactionLatestTokens(200_000), 180_000);
  assert.equal(compactionLatestTokens(1_000_000), 950_000);
  assert.equal(compactionLatestTokens(4_000), undefined, "a window no larger than the reserve has no point to compact at");
});

test("only known preference shapes are kept, and a custom share snaps to the slider", () => {
  assert.deepEqual(parseCompactionPreference({ mode: "earlier", percent: 12 }), { mode: "earlier" });
  assert.deepEqual(parseCompactionPreference({ mode: "custom", percent: 73 }), { mode: "custom", percent: 75 });
  assert.deepEqual(parseCompactionPreference({ mode: "custom", percent: 5 }), { mode: "custom", percent: 40 });
  assert.deepEqual(parseCompactionPreference({ mode: "custom", percent: 99 }), { mode: "custom", percent: 95 });
  for (const value of [null, "auto", {}, { mode: "later" }, { mode: "custom" }, { mode: "custom", percent: Number.NaN }]) {
    assert.equal(parseCompactionPreference(value), undefined);
  }
});

test("Polyth compacts only for a chosen target and only on a measured window", () => {
  const window = { usedTokens: 130_000, limitTokens: 200_000 };
  assert.equal(compactionDue({ mode: "auto" }, window), false);
  assert.equal(compactionDue({ mode: "manual" }, window), false);
  assert.equal(compactionDue({ mode: "earlier" }, window), true);
  assert.equal(compactionDue({ mode: "earlier" }, { usedTokens: 110_000, limitTokens: 200_000 }), false);
  assert.equal(compactionDue({ mode: "custom", percent: 75 }, window), false);
  assert.equal(compactionDue({ mode: "earlier" }, {}), false);
  assert.equal(compactionDue({ mode: "earlier" }, { fraction: 0.7 }), true);
});

test("a switch to a smaller model compacts before the next message", () => {
  // 400k used on a 1M window still fits there, but not in a 200k model's 180k.
  assert.equal(compactionDueForNextModel({ mode: "auto" }, { usedTokens: 400_000, limitTokens: 200_000 }), true);
  assert.equal(compactionDueForNextModel({ mode: "earlier" }, { usedTokens: 400_000, limitTokens: 200_000 }), true);
  assert.equal(compactionDueForNextModel({ mode: "custom", percent: 70 }, { usedTokens: 400_000, limitTokens: 200_000 }), true);
  assert.equal(compactionDueForNextModel({ mode: "auto" }, { usedTokens: 400_000, limitTokens: 1_000_000 }), false, "it still fits a 1M window");
  assert.equal(compactionDueForNextModel({ mode: "auto" }, { usedTokens: 120_000, limitTokens: 200_000 }), false, "auto stays out of the way when it fits");
  assert.equal(compactionDueForNextModel({ mode: "auto" }, { usedTokens: 180_000, limitTokens: 200_000 }), true, "the reserve is the last point that leaves the summary room");
});

test("manual never compacts on a model switch, and an unknown window or usage is not due", () => {
  assert.equal(compactionDueForNextModel({ mode: "manual" }, { usedTokens: 900_000, limitTokens: 200_000 }), false);
  assert.equal(compactionDueForNextModel({ mode: "auto" }, {}), false);
  assert.equal(compactionDueForNextModel({ mode: "auto" }, { usedTokens: 400_000 }), false);
  assert.equal(compactionDueForNextModel({ mode: "auto" }, { limitTokens: 200_000 }), false);
  assert.equal(compactionDueForNextModel({ mode: "auto" }, { usedTokens: Number.NaN, limitTokens: 200_000 }), false);
  assert.equal(compactionDueForNextModel({ mode: "auto" }, { usedTokens: 400_000, limitTokens: 4_000 }), false, "a window no larger than the reserve has no point to compact at");
});

test("the reserve caps a custom target on a small window", () => {
  const preference = { mode: "custom" as const, percent: 95 };
  assert.equal(compactionDue(preference, { usedTokens: 28_500, limitTokens: 32_000 }), true);
  assert.equal(compactionDue(preference, { usedTokens: 27_000, limitTokens: 32_000 }), false);
});

test("the chat's own choice wins, then the person's default, then auto", () => {
  assert.deepEqual(effectiveCompactionPreference({ mode: "manual" }, { mode: "earlier" }), { mode: "manual" });
  assert.deepEqual(effectiveCompactionPreference(undefined, { mode: "earlier" }), { mode: "earlier" });
  assert.deepEqual(effectiveCompactionPreference(undefined, undefined), { mode: "auto" });
});

test("manual falls back to auto where the harness keeps compacting anyway", () => {
  assert.deepEqual(supportedCompactionPreference({ mode: "manual" }, false), { mode: "auto" });
  assert.deepEqual(supportedCompactionPreference({ mode: "manual" }, true), { mode: "manual" });
  assert.deepEqual(supportedCompactionPreference({ mode: "earlier" }, false), { mode: "earlier" });
});

test("the mark is only where Polyth itself compacts", () => {
  assert.equal(compactionMarkPercent({ mode: "earlier" }, { limitTokens: 200_000 }), 60);
  assert.equal(compactionMarkPercent({ mode: "custom", percent: 95 }, { limitTokens: 200_000 }), 90, "a target keeps room for the summary");
  assert.equal(compactionMarkPercent({ mode: "custom", percent: 70 }, {}), 70);
  assert.equal(compactionMarkPercent({ mode: "auto" }, { limitTokens: 200_000 }), undefined, "no harness says when it really compacts");
  assert.equal(compactionMarkPercent({ mode: "manual" }, { limitTokens: 200_000 }), undefined);
});

import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, createContextSourceRegistry } from "../src/index.ts";

test("estimateTokens uses chars/4 ceiling", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("providers registered before and after registry creation are visible", () => {
  const early = createContextSourceRegistry();
  early.register({
    id: "early",
    label: "Early",
    description: "Registered on first registry",
    async collect() { return { sections: [], status: "missing" }; },
  });
  const late = createContextSourceRegistry();
  late.register({
    id: "late",
    label: "Late",
    description: "Registered on second registry",
    async collect() { return { sections: [], status: "missing" }; },
  });
  assert.ok(early.get("early"));
  assert.ok(late.get("late"));
  assert.equal(early.get("late"), undefined);
});

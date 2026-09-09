import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDictationAdapter } from "../src/routing.ts";
import type { SttAdapter } from "../src/streaming.ts";

const adapter = (engine: string): SttAdapter => ({
  engine,
  createStream: () => ({ push() {}, finalize: async () => engine }),
});

const local = adapter("local");
const cloud = adapter("cloud");
const fallback = adapter("fallback");

test("local-only can never route audio to cloud", () => {
  assert.equal(selectDictationAdapter({
    policy: "local-only",
    selectedProvider: "local-nemotron",
    selected: local,
    local,
    explicitFallback: cloud,
  })?.engine, "local");
  assert.equal(selectDictationAdapter({
    policy: "local-only",
    selectedProvider: "local-nemotron",
    selected: null,
    local: null,
    explicitFallback: cloud,
  }), null);
});

test("prefer-local only uses a named explicit fallback", () => {
  assert.equal(selectDictationAdapter({
    policy: "prefer-local",
    selectedProvider: "local-nemotron",
    selected: local,
    local,
    explicitFallback: null,
  })?.engine, "local");
  assert.equal(selectDictationAdapter({
    policy: "prefer-local",
    selectedProvider: "local-nemotron",
    selected: local,
    local,
    explicitFallback: fallback,
  })?.engine, "local->fallback");
  assert.equal(selectDictationAdapter({
    policy: "prefer-local",
    selectedProvider: "local-nemotron",
    selected: null,
    local: null,
    explicitFallback: fallback,
  })?.engine, "fallback");
});

test("prefer-cloud does not invent local or cloud alternatives", () => {
  assert.equal(selectDictationAdapter({
    policy: "prefer-cloud",
    selectedProvider: "deepgram",
    selected: cloud,
    local,
    explicitFallback: fallback,
  })?.engine, "cloud");
  assert.equal(selectDictationAdapter({
    policy: "prefer-cloud",
    selectedProvider: "local-nemotron",
    selected: local,
    local,
    explicitFallback: fallback,
  })?.engine, "fallback");
});

test("auto-fallback is bounded to selected plus one explicit secondary path", () => {
  assert.equal(selectDictationAdapter({
    policy: "auto-fallback",
    selectedProvider: "deepgram",
    selected: cloud,
    local,
    explicitFallback: fallback,
  })?.engine, "cloud->local");
  assert.equal(selectDictationAdapter({
    policy: "auto-fallback",
    selectedProvider: "local-nemotron",
    selected: local,
    local,
    explicitFallback: fallback,
  })?.engine, "local->fallback");
});

test("browser-fallback leaves browser execution to the client", () => {
  assert.equal(selectDictationAdapter({
    policy: "browser-fallback",
    selectedProvider: "web-speech",
    selected: null,
    local: null,
    explicitFallback: null,
  }), null);
  assert.equal(selectDictationAdapter({
    policy: "browser-fallback",
    selectedProvider: "deepgram",
    selected: cloud,
    local: null,
    explicitFallback: null,
  })?.engine, "cloud");
});

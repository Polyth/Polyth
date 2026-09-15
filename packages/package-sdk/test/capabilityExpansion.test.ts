import assert from "node:assert/strict";
import { test } from "node:test";
import { expandedCapabilities, type DeclaredCapability } from "../src/capabilities.ts";

const cap = (
  name: DeclaredCapability["name"],
  constraints?: DeclaredCapability["constraints"],
  required = true,
): DeclaredCapability => ({
  name,
  ...(required ? {} : { required: false }),
  ...(constraints ? { constraints } : {}),
});

test("removing one string constraint dimension requires review", () => {
  const current = [cap("network.fetch", {
    origins: ["https://api.example.com"],
    methods: ["GET"],
  })];
  const next = [cap("network.fetch", { methods: ["GET"] })];
  assert.deepEqual(expandedCapabilities(current, next), next);
});

test("removing a model token ceiling requires review", () => {
  const current = [cap("model.generate", {
    modelClasses: ["utility"],
    maxOutputTokens: 512,
  })];
  const next = [cap("model.generate", { modelClasses: ["utility"] })];
  assert.deepEqual(expandedCapabilities(current, next), next);
});

test("dropping all constraints requires review and preserves optional semantics", () => {
  const current = [cap("network.fetch", { origins: ["https://api.example.com"] }, false)];
  const next = [cap("network.fetch", undefined, false)];
  assert.deepEqual(expandedCapabilities(current, next), next);
});

test("narrowing every constrained dimension is already covered", () => {
  const current = [cap("network.fetch", {
    origins: ["https://api.example.com", "https://api2.example.com"],
    methods: ["GET", "POST"],
  })];
  const next = [cap("network.fetch", {
    origins: ["https://api.example.com"],
    methods: ["GET"],
  })];
  assert.deepEqual(expandedCapabilities(current, next), []);
});

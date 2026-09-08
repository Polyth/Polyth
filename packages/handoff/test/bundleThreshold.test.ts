import test from "node:test";
import assert from "node:assert/strict";
import type { SpaceContext } from "@polyth/contracts";
import { createBundleService } from "../src/bundles.ts";
import { createContextSourceRegistry } from "../src/index.ts";

const space: SpaceContext = {
  spaceId: "space-1",
  spaceSlug: "space-1",
  userId: "user-1",
  role: "owner",
  deployment: "local-trusted",
  storageDir: "/tmp/space-1",
};

const storage = {
  path: (p: string) => p,
  packageDir: () => "/tmp/pkg",
} as never;

test("createBundle sets warning when tokens exceed passed threshold", async () => {
  const registry = createContextSourceRegistry();
  registry.register({
    id: "large",
    label: "Large",
    description: "Produces many tokens",
    async collect() {
      return {
        sections: [{
          title: "Large",
          body: "x".repeat(40_000),
          tokens: 10_000,
          fingerprint: "fp",
        }],
        status: "ok" as const,
      };
    },
  });
  const bundles = createBundleService({ registry, warnTokenThreshold: 80_000 });
  const bundle = await bundles.createBundle({
    storage,
    collectCtx: { space, projectId: "p1", sessionId: "s1" },
    projectId: "p1",
    sessionId: "s1",
    presetId: "custom",
    label: "Test",
    instruction: "",
    sources: [{ id: "large" }],
    warnTokenThreshold: 5_000,
  });
  assert.ok(bundle.warning);
  assert.equal(bundle.warning?.tokens, bundle.tokens);
});

test("createBundle omits warning when tokens stay below passed threshold", async () => {
  const registry = createContextSourceRegistry();
  registry.register({
    id: "small",
    label: "Small",
    description: "Produces few tokens",
    async collect() {
      return {
        sections: [{
          title: "Small",
          body: "hello",
          tokens: 10,
          fingerprint: "fp",
        }],
        status: "ok" as const,
      };
    },
  });
  const bundles = createBundleService({ registry, warnTokenThreshold: 80_000 });
  const bundle = await bundles.createBundle({
    storage,
    collectCtx: { space, projectId: "p1", sessionId: "s1" },
    projectId: "p1",
    sessionId: "s1",
    presetId: "custom",
    label: "Test",
    instruction: "",
    sources: [{ id: "small" }],
    warnTokenThreshold: 5_000,
  });
  assert.equal(bundle.warning, undefined);
});

test("createBundle uses service default threshold when omitted", async () => {
  const registry = createContextSourceRegistry();
  registry.register({
    id: "large",
    label: "Large",
    description: "Produces many tokens",
    async collect() {
      return {
        sections: [{
          title: "Large",
          body: "x".repeat(400_000),
          tokens: 100_000,
          fingerprint: "fp",
        }],
        status: "ok" as const,
      };
    },
  });
  const bundles = createBundleService({ registry, warnTokenThreshold: 80_000 });
  const bundle = await bundles.createBundle({
    storage,
    collectCtx: { space, projectId: "p1", sessionId: "s1" },
    projectId: "p1",
    sessionId: "s1",
    presetId: "custom",
    label: "Test",
    instruction: "",
    sources: [{ id: "large" }],
  });
  assert.ok(bundle.warning);
});

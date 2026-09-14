import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackageManifest } from "@polyth/package-sdk/manifest";
import { effectiveCapabilities, invokePackageRpc } from "../src/packageRpc.ts";
import { writeGrants } from "../src/grants.ts";
import { testSpaceStorage } from "./helpers.ts";

const space = (root: string) => ({
  spaceId: "spc_test",
  spaceSlug: "test",
  userId: "usr_test",
  role: "owner" as const,
  deployment: "local-trusted" as const,
  storageDir: root,
});

function manifest(capabilities: NonNullable<PackageManifest["capabilities"]>): PackageManifest {
  return {
    manifestVersion: 2,
    id: "com-example-effective",
    version: "1.0.0",
    display: { name: "Effective", description: "Effective authority test" },
    runtime: { kind: "sandboxed", ui: { entry: "ui.ts" } },
    capabilities,
  };
}

const baseDeps = (root: string, storage: ReturnType<typeof testSpaceStorage>, value: PackageManifest) => ({
  space: space(root),
  storage,
  sessions: {} as never,
  projects: {} as never,
  appendEvent: async () => ({}),
  manifest: value,
  enabled: true,
});

test("a narrower manifest constrains an older unconstrained grant", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-effective-manifest-"));
  const storage = testSpaceStorage(root);
  writeGrants(storage, "com-example-effective", [{
    name: "network.fetch",
    grantedAt: 1,
  }]);
  const value = manifest([{
    name: "network.fetch",
    constraints: {
      origins: ["https://api.example.com"],
      methods: ["GET"],
    },
  }]);

  const capability = effectiveCapabilities(value, storage).granted[0];
  assert.deepEqual(capability?.constraints, {
    origins: ["https://api.example.com"],
    methods: ["GET"],
  });
});

test("a narrower grant constrains a broader manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-effective-grant-"));
  const storage = testSpaceStorage(root);
  writeGrants(storage, "com-example-effective", [{
    name: "network.fetch",
    constraints: {
      origins: ["https://api.example.com"],
      methods: ["GET"],
    },
    grantedAt: 1,
  }]);
  const value = manifest([{
    name: "network.fetch",
    constraints: {
      origins: ["https://api.example.com", "https://api2.example.com"],
      methods: ["GET", "POST"],
    },
  }]);

  const capability = effectiveCapabilities(value, storage).granted[0];
  assert.deepEqual(capability?.constraints, {
    origins: ["https://api.example.com"],
    methods: ["GET"],
  });
});

test("disjoint method allowlists become deny-all at the RPC gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-effective-empty-"));
  const storage = testSpaceStorage(root);
  writeGrants(storage, "com-example-effective", [{
    name: "network.fetch",
    constraints: {
      origins: ["https://api.example.com"],
      methods: ["POST"],
    },
    grantedAt: 1,
  }]);
  const value = manifest([{
    name: "network.fetch",
    constraints: {
      origins: ["https://api.example.com"],
      methods: ["GET"],
    },
  }]);
  const capability = effectiveCapabilities(value, storage).granted[0];
  assert.deepEqual(capability?.constraints?.methods, []);

  await assert.rejects(
    () => invokePackageRpc(
      baseDeps(root, storage, value),
      "network.fetch",
      { url: "https://api.example.com/items", method: "GET" },
    ),
    (error: Error & { code?: string }) =>
      error.code === "CAPABILITY_DENIED" && /method GET/.test(error.message),
  );
});

test("manifest model token ceiling survives an older unbounded grant", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-effective-model-"));
  const storage = testSpaceStorage(root);
  writeGrants(storage, "com-example-effective", [{
    name: "model.generate",
    grantedAt: 1,
  }]);
  const value = manifest([{
    name: "model.generate",
    constraints: { modelClasses: ["utility"], maxOutputTokens: 128 },
  }]);
  const seen: number[] = [];

  const capability = effectiveCapabilities(value, storage).granted[0];
  assert.deepEqual(capability?.constraints, {
    modelClasses: ["utility"],
    maxOutputTokens: 128,
  });

  await invokePackageRpc({
    ...baseDeps(root, storage, value),
    generateModel: async (request) => {
      seen.push(request.maxOutputTokens);
      return { text: "ok", modelClass: "utility", inputTruncated: false };
    },
  }, "model.generate", { prompt: "test", maxOutputTokens: 4096 });
  assert.deepEqual(seen, [128]);
});

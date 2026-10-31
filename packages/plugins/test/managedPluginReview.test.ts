import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstalledPluginDto } from "@polyth/contracts";
import type { PackageManifestV2 } from "@polyth/package-sdk/manifest";
import { approveConnectionDefinitions, grantCapabilities } from "../src/grants.ts";
import { withInitialPermissionReview } from "../src/managedPluginReview.ts";
import { testSpaceStorage } from "./helpers.ts";

const manifest: PackageManifestV2 = {
  manifestVersion: 2,
  id: "com-example",
  version: "1.0.0",
  display: { name: "Example", description: "Example" },
  runtime: { kind: "sandboxed", ui: { entry: "src/index.ts" } },
  capabilities: [
    { name: "ui.render" },
    { name: "clipboard.write", required: false },
    { name: "auth.connection" },
  ],
  connections: [{
    id: "tracker",
    label: "Tracker",
    kind: "token",
    origins: ["https://api.example.com"],
  }],
};

const row = (enabled = false): InstalledPluginDto => ({
  id: manifest.id,
  name: manifest.display.name,
  version: manifest.version,
  source: "https://example.com/package.zip",
  trust: "network",
  enabled,
  status: enabled ? "ready" : "installed",
  runtimeKind: "sandboxed",
  contributions: [],
  permissions: {
    effective: [],
    requested: manifest.capabilities!.map((capability) => ({
      name: capability.name,
      ...(capability.constraints ? { constraints: capability.constraints } : {}),
    })),
  },
  connections: [{ id: "tracker", label: "Tracker", kind: "token", status: "disconnected" }],
});

const registry = { canonicalManifest: () => manifest };

test("fresh disabled sandbox exposes capability and connection review", () => {
  const storage = testSpaceStorage(join(mkdtempSync(join(tmpdir(), "polyth-review-")), "space"));
  const reviewed = withInitialPermissionReview(registry as never, storage, row());
  assert.deepEqual(reviewed.permissions.review?.capabilities.map((item) => item.name), [
    "ui.render", "clipboard.write", "auth.connection",
  ]);
  assert.deepEqual(reviewed.permissions.review?.connections.map((item) => [item.id, item.kind]), [
    ["tracker", "new"],
  ]);
});

test("already approved disabled sandbox can re-enable without another review", () => {
  const storage = testSpaceStorage(join(mkdtempSync(join(tmpdir(), "polyth-review-approved-")), "space"));
  grantCapabilities(storage, manifest.id, manifest.capabilities ?? []);
  approveConnectionDefinitions(storage, manifest.id, manifest.connections ?? [], ["tracker"]);
  const reviewed = withInitialPermissionReview(registry as never, storage, row());
  assert.equal(reviewed.permissions.review, undefined);
});

test("enabled sandbox never receives synthetic initial review", () => {
  const storage = testSpaceStorage(join(mkdtempSync(join(tmpdir(), "polyth-review-enabled-")), "space"));
  const reviewed = withInitialPermissionReview(registry as never, storage, row(true));
  assert.equal(reviewed.permissions.review, undefined);
});

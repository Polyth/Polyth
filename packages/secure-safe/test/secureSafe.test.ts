import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureSafeService } from "../src/index.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "polyth-secure-safe-"));

test("CRUD round-trip persists metadata while list DTOs never expose values", async () => {
  const dataDir = tempDir();
  const safe = createSecureSafeService({ dataDir });
  const created = await safe.create({
    handle: "GITHUB_TOKEN",
    label: "GitHub token",
    purpose: "Publish releases",
    kind: "token",
    scope: "project",
    projectId: "project-1",
    value: "ghp-super-secret",
  });

  assert.equal(created.revision, 1);
  assert.equal("value" in created, false);
  assert.doesNotMatch(JSON.stringify(safe.list()), /ghp-super-secret/);
  assert.doesNotMatch(readFileSync(join(dataDir, "secure-safe.json"), "utf8"), /ghp-super-secret/);
  assert.equal(statSync(join(dataDir, "secure-safe-secrets.json")).mode & 0o777, 0o600);

  const updated = await safe.update(created.id, { label: "Release token", purpose: "Release publishing" });
  assert.equal(updated.revision, 2);
  assert.equal(updated.label, "Release token");

  const reloaded = createSecureSafeService({ dataDir });
  assert.deepEqual(reloaded.list(), [updated]);
  assert.equal(await reloaded.remove(created.id), true);
  assert.equal(await reloaded.remove(created.id), false);
  assert.deepEqual(reloaded.list(), []);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "secure-safe-secrets.json"), "utf8")), {});
});

test("forbidden config contains handles and env refs but never secret values", async () => {
  const dataDir = tempDir();
  const safe = createSecureSafeService({ dataDir });
  await safe.create({
    handle: "stripe-live",
    label: "Stripe live key",
    purpose: "Billing API",
    kind: "env",
    value: "sk_live_never_return_this",
  });

  const raw = readFileSync(join(dataDir, "forbidden-config.json"), "utf8");
  assert.doesNotMatch(raw, /sk_live_never_return_this/);
  assert.deepEqual(JSON.parse(raw), {
    version: 1,
    handles: [{
      handle: "stripe-live",
      label: "Stripe live key",
      purpose: "Billing API",
      kind: "env",
      envRef: "POLYTH_SAFE_STRIPE_LIVE",
    }],
  });
});

test("PATCH with a blank value retains the prior write-only value", async () => {
  const dataDir = tempDir();
  const safe = createSecureSafeService({ dataDir });
  const created = await safe.create({
    handle: "DATABASE_PASSWORD",
    label: "Database password",
    kind: "password",
    value: "original-secret",
  });

  await safe.update(created.id, { value: "   ", label: "Primary database password" });
  const stored = JSON.parse(readFileSync(join(dataDir, "secure-safe-secrets.json"), "utf8")) as Record<string, string>;
  assert.equal(stored[created.id], "original-secret");
  assert.doesNotMatch(JSON.stringify(safe.list()), /original-secret/);
});

test("opaque secrets stay out of list() and the handle manifest", () => {
  const dataDir = tempDir();
  const safe = createSecureSafeService({ dataDir });
  safe.putOpaque("pkgconn:spc_a:pkg.one:ref", "package-access-token");
  assert.deepEqual(safe.list(), []);
  assert.equal(safe.getOpaque("pkgconn:spc_a:pkg.one:ref"), "package-access-token");
  assert.doesNotMatch(JSON.stringify(safe.list()), /package-access-token/);
  assert.equal(existsSync(join(dataDir, "forbidden-config.json")), false);
  assert.match(readFileSync(join(dataDir, "secure-safe-secrets.json"), "utf8"), /package-access-token/);
  assert.equal(safe.redact?.("use package-access-token here"), "use [redacted] here");
  safe.deleteOpaqueByPrefix("pkgconn:spc_a:pkg.one:");
  assert.equal(safe.getOpaque("pkgconn:spc_a:pkg.one:ref"), null);
});

test("duplicate handles and env-ref collisions are rejected", async () => {
  const safe = createSecureSafeService({ dataDir: tempDir() });
  await safe.create({ handle: "API-KEY", label: "API key", value: "one" });

  await assert.rejects(
    () => safe.create({ handle: "api-key", label: "Other API key", value: "two" }),
    (cause: Error & { code?: string }) => cause.code === "conflict",
  );
  await assert.rejects(
    () => safe.create({ handle: "API_KEY", label: "Colliding env ref", value: "three" }),
    (cause: Error & { code?: string }) => cause.code === "conflict",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../legacy-migration.ts", import.meta.url));
const PASSWORD = `scrypt$${"a".repeat(32)}$${"b".repeat(64)}`;
const run = (...args: string[]) => spawnSync(
  process.execPath,
  ["--experimental-strip-types", script, ...args],
  { encoding: "utf8", timeout: 15_000 },
);
const json = (file: string, value: unknown): void => {
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
};

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-reviewed-migration-cli-"));
  const data = join(root, "data");
  const stage = join(root, "stage");
  mkdirSync(data, { mode: 0o700 });
  json(join(data, "auth.json"), {
    version: 2,
    passwordHash: null,
    credentials: [{ userId: "usr_owner", passwordHash: PASSWORD }],
    sessions: [{
      id: "legacy-session",
      userId: "usr_owner",
      tokenHash: "c".repeat(64),
      createdAt: 10,
      lastSeenAt: 20,
      label: "legacy browser",
    }],
  });
  json(join(data, "tenancy.json"), {
    version: 1,
    users: [{ id: "usr_owner", name: "Owner", createdAt: 1 }],
    spaces: [{
      id: "spc_personal",
      name: "Personal",
      slug: "personal",
      createdAt: 2,
      updatedAt: 3,
      isDefault: true,
    }],
    memberships: [{ userId: "usr_owner", spaceId: "spc_personal", role: "owner", createdAt: 2 }],
    selections: { desktop: "spc_personal" },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, data, stage };
}

test("canonical migration CLI performs reviewed offline cutover", (t) => {
  const f = fixture(t);
  const inspected = run("inventory", "--data", f.data);
  assert.equal(inspected.status, 0, inspected.stderr);
  const inventory = JSON.parse(inspected.stdout) as { inventoryDigest: string; safeToStage: boolean };
  assert.equal(inventory.safeToStage, true);
  assert.equal(existsSync(join(f.data, "control-plane")), false);

  const staged = run(
    "stage",
    "--data", f.data,
    "--stage", f.stage,
    "--inventory-digest", inventory.inventoryDigest,
    "--offline",
  );
  assert.equal(staged.status, 0, staged.stderr);
  const stage = JSON.parse(staged.stdout) as { status: string; manifestDigest: string };
  assert.equal(stage.status, "verified");
  assert.equal(existsSync(join(f.data, "control-plane")), false);

  const verified = run("verify", "--stage", f.stage, "--manifest-digest", stage.manifestDigest);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).manifestDigest, stage.manifestDigest);

  const applied = run(
    "apply",
    "--data", f.data,
    "--stage", f.stage,
    "--manifest-digest", stage.manifestDigest,
    "--offline",
  );
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout) as { usersImported: number; sessionsRevoked: number; generatedLogins: Record<string, string> };
  assert.equal(result.usersImported, 1);
  assert.equal(result.sessionsRevoked, 1);
  assert.equal(result.generatedLogins.usr_owner, "owner");
  assert.equal(existsSync(join(f.data, "control-plane")), true);
});

test("canonical migration CLI requires offline acknowledgement before every mutating phase", (t) => {
  const f = fixture(t);
  const inventory = JSON.parse(run("inventory", "--data", f.data).stdout) as { inventoryDigest: string };

  const noOfflineStage = run(
    "stage",
    "--data", f.data,
    "--stage", f.stage,
    "--inventory-digest", inventory.inventoryDigest,
  );
  assert.equal(noOfflineStage.status, 1);
  assert.match(noOfflineStage.stderr, /offline-required/);
  assert.equal(existsSync(f.stage), false);

  const staged = run(
    "stage",
    "--data", f.data,
    "--stage", f.stage,
    "--inventory-digest", inventory.inventoryDigest,
    "--offline",
  );
  assert.equal(staged.status, 0, staged.stderr);
  const manifestDigest = JSON.parse(staged.stdout).manifestDigest as string;

  for (const command of ["adopt", "apply"] as const) {
    const denied = run(
      command,
      "--data", f.data,
      "--stage", f.stage,
      "--manifest-digest", manifestDigest,
    );
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /offline-required/);
    assert.equal(existsSync(join(f.data, "control-plane")), false);
  }
});

test("canonical migration CLI never echoes rejected command-line values", (t) => {
  fixture(t);
  const rejected = run("apply", "--secret=CANARY_CREDENTIAL_DO_NOT_ECHO");
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stderr.includes("CANARY_CREDENTIAL_DO_NOT_ECHO"), false);
  assert.equal(rejected.stdout.includes("CANARY_CREDENTIAL_DO_NOT_ECHO"), false);
});

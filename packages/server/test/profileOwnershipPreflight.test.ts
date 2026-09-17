import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openControlPlane } from "@polyth/control-plane";
import { verifyCanonicalAgentProfileOwnership } from "../src/profileOwnershipPreflight.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-profile-owner-preflight-"));
  const control = openControlPlane({ directory: root });
  control.transaction(() => {
    for (const [id, status] of [["usr_owner", "active"], ["usr_disabled", "disabled"]] as const) {
      control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user',?)", id, status);
      control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, id);
    }
  });
  const db = new DatabaseSync(join(root, "sessions.db"));
  db.exec("CREATE TABLE agent_profiles(id TEXT PRIMARY KEY) STRICT; INSERT INTO agent_profiles(id) VALUES('profile_one')");
  db.close();
  t.after(() => { control.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, control };
}

const owners = (root: string, value: Record<string, string>) =>
  writeFileSync(join(root, "agent-profile-owners.json"), `${JSON.stringify({ version: 1, owners: value })}\n`, { mode: 0o600 });

test("canonical Agent Profiles require exact explicit durable-user ownership", t => {
  const f = fixture(t);
  assert.throws(() => verifyCanonicalAgentProfileOwnership({ dataDir: f.root, control: f.control }), { code: "recovery-required" });

  owners(f.root, { profile_one: "usr_owner" });
  assert.doesNotThrow(() => verifyCanonicalAgentProfileOwnership({ dataDir: f.root, control: f.control }));

  // Offboarding revokes authentication, not historical ownership. Disabled
  // users may keep durable profiles without making the installation unbootable.
  owners(f.root, { profile_one: "usr_disabled" });
  assert.doesNotThrow(() => verifyCanonicalAgentProfileOwnership({ dataDir: f.root, control: f.control }));

  owners(f.root, { profile_one: "usr_missing" });
  assert.throws(() => verifyCanonicalAgentProfileOwnership({ dataDir: f.root, control: f.control }), { code: "recovery-required" });

  owners(f.root, { profile_one: "usr_owner", stale_profile: "usr_owner" });
  assert.throws(() => verifyCanonicalAgentProfileOwnership({ dataDir: f.root, control: f.control }), { code: "recovery-required" });
});

test("profile-free canonical installs do not require an owner sidecar", t => {
  const root = mkdtempSync(join(tmpdir(), "polyth-profile-owner-empty-"));
  const control = openControlPlane({ directory: root });
  const db = new DatabaseSync(join(root, "sessions.db"));
  db.exec("CREATE TABLE agent_profiles(id TEXT PRIMARY KEY) STRICT");
  db.close();
  t.after(() => { control.close(); rmSync(root, { recursive: true, force: true }); });
  assert.doesNotThrow(() => verifyCanonicalAgentProfileOwnership({ dataDir: root, control }));
});

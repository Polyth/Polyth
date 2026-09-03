import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  GRANT_PROFILE_PRESETS,
  PRIVILEGED_REMOTE_CAPABILITIES,
  isRemotePathPattern,
  matchRemotePath,
} from "@polyth/contracts";
import { BROWSER_REMOTE_ACCESS } from "../../browser/src/serverEntry.ts";
import { FILES_REMOTE_ACCESS } from "../../files/src/serverEntry.ts";
import { GIT_REMOTE_ACCESS } from "../../git/src/serverEntry.ts";
import { TERMINAL_REMOTE_ACCESS } from "../../terminal/src/serverEntry.ts";
import { TUNNEL_REMOTE_ACCESS } from "../../tunnel/src/serverEntry.ts";
import {
  CORE_LOCAL_ONLY_PREFIXES,
  CORE_REMOTE_ACCESS,
  findRemotePolicyOverlaps,
  validateRemoteAccessPolicy,
  type OwnedRemotePolicy,
} from "../src/remotePolicy.ts";

const packagesDir = resolve(import.meta.dirname, "../..");

function serverEntryFiles(): Array<{ id: string; source: string }> {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = join(packagesDir, entry.name, "src", "serverEntry.ts");
      if (!existsSync(path)) return [];
      return [{ id: entry.name, source: readFileSync(path, "utf8") }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

test("every discovered serverEntry declares remoteAccess (omit is not silent allow)", () => {
  const entries = serverEntryFiles();
  assert.ok(entries.length >= 25);
  for (const { id, source } of entries) {
    assert.match(
      source,
      /remoteAccess:/,
      `${id} must declare remoteAccess so paired-device default-deny is explicit`,
    );
  }
});

test("core and developer package remote policies validate, do not overlap, and stay default-deny", () => {
  const policies: OwnedRemotePolicy[] = [
    { owner: "core", policy: CORE_REMOTE_ACCESS },
    { owner: "files", policy: FILES_REMOTE_ACCESS },
    { owner: "git", policy: GIT_REMOTE_ACCESS },
    { owner: "terminal", policy: TERMINAL_REMOTE_ACCESS },
    { owner: "browser", policy: BROWSER_REMOTE_ACCESS },
    { owner: "tunnel", policy: TUNNEL_REMOTE_ACCESS },
  ];
  for (const owned of policies) validateRemoteAccessPolicy(owned.owner, owned.policy);
  assert.deepEqual(findRemotePolicyOverlaps(policies), []);

  for (const owned of policies) {
    for (const rule of owned.policy.http) {
      assert.equal(isRemotePathPattern(rule.path), true, rule.path);
      assert.equal(matchRemotePath(rule.path, rule.path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, "x")), true);
    }
  }

  assert.ok(CORE_LOCAL_ONLY_PREFIXES.includes("/api/auth/login"));
  assert.ok(CORE_LOCAL_ONLY_PREFIXES.includes("/internal"));
  const remotePaths = CORE_REMOTE_ACCESS.http.map((rule) => rule.path);
  assert.equal(remotePaths.includes("/api/auth/login"), false);
  assert.equal(remotePaths.some((path) => path.startsWith("/api/sessions/") && path.includes("secrets")), false);
});

test("full-remote preset never includes privileged administration capabilities", () => {
  const full = new Set(GRANT_PROFILE_PRESETS["full-remote"]);
  for (const cap of PRIVILEGED_REMOTE_CAPABILITIES) {
    assert.equal(full.has(cap), false, cap);
  }
  assert.ok(GRANT_PROFILE_PRESETS.interact.includes("core.sessions.message"));
  assert.equal(GRANT_PROFILE_PRESETS.observe.includes("core.sessions.message"), false);
  assert.equal(GRANT_PROFILE_PRESETS.interact.includes("files.write"), false);
});

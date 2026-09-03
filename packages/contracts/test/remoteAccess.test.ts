import test from "node:test";
import assert from "node:assert/strict";
import {
  GRANT_PROFILE_PRESETS,
  PRIVILEGED_REMOTE_CAPABILITIES,
  REMOTE_CAPABILITY,
  canonicalizeRemotePath,
  isRemoteCapability,
  matchRemotePath,
  normalizeDeviceGrants,
  normalizeRemoteGrants,
  remotePathPatternsOverlap,
} from "@polyth/contracts";

test("canonicalizeRemotePath rejects encoded dots, slashes, NUL, and duplicate separators", () => {
  assert.equal(canonicalizeRemotePath("/api/health"), "/api/health");
  assert.equal(canonicalizeRemotePath("/api/sessions/abc-1"), "/api/sessions/abc-1");
  assert.equal(canonicalizeRemotePath("/api/health/%2e%2e"), null);
  assert.equal(canonicalizeRemotePath("/api/health/%2e"), null);
  assert.equal(canonicalizeRemotePath("/api/health/%2fsecret"), null);
  assert.equal(canonicalizeRemotePath("/api/health/%00"), null);
  assert.equal(canonicalizeRemotePath("/api//health"), null);
  assert.equal(canonicalizeRemotePath("/api/health/../x"), null);
  assert.equal(canonicalizeRemotePath("/api/health/."), null);
  assert.equal(canonicalizeRemotePath("/api/health\\x"), null);
  assert.equal(canonicalizeRemotePath("/api/health/%zz"), null);
  assert.equal(canonicalizeRemotePath("/api/health/%2"), null);
  assert.equal(canonicalizeRemotePath(""), null);
  assert.equal(matchRemotePath("/api/sessions/:id", "/api/sessions/%2e%2e"), false);
  assert.equal(matchRemotePath("/api/health", "/api/health"), true);
});

test("static and dynamic remote path patterns overlap when method sets can collide", () => {
  assert.equal(remotePathPatternsOverlap("/api/items/:id", "/api/items/special"), true);
  assert.equal(remotePathPatternsOverlap("/api/items/:id", "/api/items/:name"), true);
  assert.equal(remotePathPatternsOverlap("/api/items/:id", "/api/items/:id/extra"), false);
  assert.equal(remotePathPatternsOverlap("/api/items/special", "/api/other/special"), false);
});

test("grant presets only use canonical capabilities and never include privileged ones", () => {
  for (const [profile, grants] of Object.entries(GRANT_PROFILE_PRESETS)) {
    const normalized = normalizeDeviceGrants(grants);
    assert.deepEqual(normalized, [...new Set(normalized)].sort(), profile);
    for (const capability of grants) {
      assert.equal(isRemoteCapability(capability), true, `${profile}:${capability}`);
      assert.equal(PRIVILEGED_REMOTE_CAPABILITIES.includes(capability), false, `${profile}:${capability}`);
    }
  }
  assert.ok(GRANT_PROFILE_PRESETS.interact.includes(REMOTE_CAPABILITY.coreSessionsMessage));
});

test("unknown capabilities and privileged device grants are rejected; duplicates are sorted", () => {
  assert.throws(
    () => normalizeRemoteGrants(["core.sessions.read", "not.a.capability"]),
    (error: Error & { code?: string }) => error.code === "invalid-input" && /unknown remote capability/.test(error.message),
  );
  assert.throws(
    () => normalizeDeviceGrants([REMOTE_CAPABILITY.tunnelPairingManage]),
    (error: Error & { code?: string }) => error.code === "invalid-input" && /privileged capability/.test(error.message),
  );
  assert.deepEqual(
    normalizeDeviceGrants([
      REMOTE_CAPABILITY.coreSessionsRead,
      REMOTE_CAPABILITY.coreHealthRead,
      REMOTE_CAPABILITY.coreSessionsRead,
    ]),
    [REMOTE_CAPABILITY.coreHealthRead, REMOTE_CAPABILITY.coreSessionsRead],
  );
});

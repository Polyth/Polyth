import test from "node:test";
import assert from "node:assert/strict";
import { selectChatWorkspaceRuntime } from "../src/runtime.ts";

test("prefers an available desktop runtime without remote fallback", () => {
  const selected = selectChatWorkspaceRuntime([
    { kind: "server-remote", available: true, localRendering: false, localProfileState: false },
    { kind: "desktop-local", available: true, deviceId: "mac", deviceName: "MacBook", localRendering: true, localProfileState: true },
  ]);
  assert.equal(selected.selected?.kind, "desktop-local");
  assert.equal(selected.selected?.deviceId, "mac");
  assert.equal(selected.usedRemoteFallback, false);
});

test("waits for a local device by default instead of silently starting remote Chromium", () => {
  const selected = selectChatWorkspaceRuntime([
    { kind: "server-remote", available: true, localRendering: false, localProfileState: false },
  ]);
  assert.equal(selected.selected, null);
  assert.equal(selected.waitingForDevice, true);
  assert.equal(selected.usedRemoteFallback, false);
});

test("uses remote fallback only when explicitly allowed", () => {
  const selected = selectChatWorkspaceRuntime(
    [{ kind: "server-remote", available: true, localRendering: false, localProfileState: false }],
    { mode: "local-first", allowRemoteFallback: true },
  );
  assert.equal(selected.selected?.kind, "server-remote");
  assert.equal(selected.usedRemoteFallback, true);
});

test("honors a requested desktop device", () => {
  const selected = selectChatWorkspaceRuntime([
    { kind: "desktop-local", available: true, deviceId: "home", localRendering: true, localProfileState: true },
    { kind: "desktop-local", available: true, deviceId: "mac", localRendering: true, localProfileState: true },
  ], { mode: "local-first", deviceId: "mac", allowRemoteFallback: false });
  assert.equal(selected.selected?.deviceId, "mac");
});

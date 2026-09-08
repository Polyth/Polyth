import test from "node:test";
import assert from "node:assert/strict";
import { createProfileRegistry, createFakeProfileDriver, resetFakeProfileLocks } from "@polyth/browser";

test("fake profile emits popup-opened for test fixture URL and accepts popup input", async () => {
  resetFakeProfileLocks();
  const driver = createFakeProfileDriver();
  const registry = createProfileRegistry({ driver, liveTabLimit: 4 });
  const profileId = "profile-popup";
  await registry.openProfile({
    profileId,
    userDataDir: "/tmp/fake-profile-popup",
    allowedOrigins: ["http://127.0.0.1"],
    approvedOrigins: new Set(["http://127.0.0.1"]),
  });
  const tab = registry.registerTab("space:project", "tab-popup", profileId);
  const events: string[] = [];
  registry.onEvent((ev) => events.push(`${ev.kind}:${ev.popupId ?? ""}`));
  await registry.ensureLive(tab.tabId, "http://127.0.0.1/polyth-test-popup");
  assert.ok(events.some((e) => e.startsWith("popup-opened:")));
  const popupId = "test-popup";
  await registry.popupInput(tab.tabId, popupId, { inputType: "key", kind: "press", key: "Escape" });
  assert.ok(events.some((e) => e === `popup-closed:${popupId}`));
});

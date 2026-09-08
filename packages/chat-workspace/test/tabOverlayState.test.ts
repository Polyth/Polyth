import test from "node:test";
import assert from "node:assert/strict";
import {
  clearProfileLocked,
  dismissDownloadBlocked,
  emptyOverlayModel,
  overlayFromState,
  reduceTabOverlay,
  setProfileLocked,
} from "../widgets/lib/tabOverlayState.ts";

test("approval-required populates overlay copy fields", () => {
  const next = reduceTabOverlay(emptyOverlayModel(), {
    tabId: "t1",
    kind: "approval-required",
    origin: "https://evil.example",
    reason: "external origin needs approval",
  });
  assert.equal(next.approval?.origin, "https://evil.example");
  assert.equal(next.approval?.reason, "external origin needs approval");
});

test("download-blocked can be dismissed", () => {
  const blocked = reduceTabOverlay(emptyOverlayModel(), { tabId: "t1", kind: "download-blocked" });
  assert.equal(blocked.downloadBlocked, true);
  assert.equal(dismissDownloadBlocked(blocked).downloadBlocked, false);
});

test("state snapshot maps server fields", () => {
  const model = overlayFromState({
    tab: {
      id: "t1",
      profileId: "p1",
      url: "http://127.0.0.1:8765/",
      title: "Test",
      pinned: false,
      lastActiveAt: 1,
      hibernated: false,
      contentAccess: { contentAccess: "manual-only", agentControl: false, observation: false, contextCapture: false, inspect: false },
    },
    loading: false,
    canGoBack: true,
    canGoForward: true,
    pendingApproval: { origin: "https://x", reason: "r" },
    liveTabCount: 3,
  });
  assert.equal(model.approval?.origin, "https://x");
  assert.equal(model.liveTabCount, 3);
});

test("profile-locked event and helpers toggle overlay state", () => {
  const locked = reduceTabOverlay(emptyOverlayModel(), { tabId: "t1", kind: "profile-locked" });
  assert.equal(locked.profileLocked, true);
  assert.equal(clearProfileLocked(locked).profileLocked, false);
  assert.equal(setProfileLocked(emptyOverlayModel()).profileLocked, true);
});

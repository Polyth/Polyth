import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeDeviceProtocolPayload } from "../src/deviceRuntimeProtocol.ts";

test("accepts metadata-only desktop worker commands", () => {
  assert.doesNotThrow(() => assertSafeDeviceProtocolPayload({
    kind: "tab.navigate",
    requestId: "r1",
    projectId: "p1",
    tabId: "t1",
    url: "https://claude.ai/new",
  }));
});

test("accepts explicit provider handoff text without browser state", () => {
  assert.doesNotThrow(() => assertSafeDeviceProtocolPayload({
    kind: "handoff",
    eventId: "evt-1",
    action: "ask-agent",
    handoff: {
      sourceKind: "external-llm-chat",
      providerId: "claude",
      providerName: "Claude",
      profileId: "profile-1",
      tabId: "tab-1",
      projectId: "project-1",
      scope: "response",
      text: "A user-selected provider response.",
      capturedAt: Date.now(),
    },
  }));
});

test("rejects accidental browser credentials and rendered content", () => {
  for (const field of ["cookies", "storageState", "dom", "html", "frame", "screenshot", "clipboard"]) {
    assert.throws(
      () => assertSafeDeviceProtocolPayload({ kind: "debug", nested: { [field]: "secret" } }),
      /forbidden Chat Workspace device payload field/,
    );
  }
});

test("rejects forbidden browser state even when nested inside a handoff event", () => {
  assert.throws(
    () => assertSafeDeviceProtocolPayload({
      kind: "handoff",
      eventId: "evt-2",
      action: "add-to-agent",
      handoff: {
        projectId: "project-1",
        tabId: "tab-1",
        text: "safe text",
        metadata: { cookies: "must never cross the protocol" },
      },
    }),
    /forbidden Chat Workspace device payload field: cookies/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});

const store = await import("../src/store.ts");
const { registerSurface } = await import("../src/surfaces.ts");
const { registerWorkbenchProfile } = await import("../src/workbench/profiles.ts");
const { getActiveProfileId, setWorkbenchProject } = await import("../src/workbench/store.ts");
const nav = await import("../src/workbench/profileNavigation.ts");

const PURPOSE = "studio-test-purpose";
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, projectId: "p-lane-home", title: id, status: "idle" as const, createdAt: 1, updatedAt: 1, ...extra,
});

test("a home surface that owns a chat lane stays the lane's home across its chats; closing it reveals the lane chat", async () => {
  const offSurface = registerSurface({
    id: "studio-test",
    capabilityId: "studio-test",
    title: "Studio",
    order: 91,
    component: () => null,
    presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 320, preferredMaxWidth: 1400, keepAlive: true, escape: "close" },
  });
  const offProfile = registerWorkbenchProfile({
    id: "studio-tab",
    label: "Studio",
    description: "",
    order: 6,
    defaultLayout: {
      surfaces: [
        { surface: "session", region: "primary", active: true },
        { surface: "studio-test", region: "end", active: true },
      ],
    },
    presentation: { navigation: "primary", homeSurface: "studio-test" },
    sessionPurpose: PURPOSE,
  });
  try {
    store.activateProject("p-lane-home");
    setWorkbenchProject("p-lane-home");
    store.setSessions("p-lane-home", [row("chat-1"), row("video-1", { purpose: PURPOSE }), row("video-2", { purpose: PURPOSE })]);
    store.activateSession("chat-1");

    // Entering the lane: no remembered chat yet, so a fresh lane chat under
    // the home surface, over the whole workspace.
    assert.equal(nav.switchWorkbenchNavigation({ profileId: "studio-tab" }), true);
    await flush();
    assert.equal(getActiveProfileId(), "studio-tab");
    assert.equal(store.getState().activeSessionId, null);
    assert.equal(store.getState().railPlugin, "studio-test");
    assert.equal(store.getState().paneMode, "fullscreen");

    // Opening another chat of the lane closes non-pinned windows; the home
    // surface comes back for it instead of the tab leaving for Chat.
    store.activateSession("video-1");
    await flush();
    assert.equal(getActiveProfileId(), "studio-tab");
    assert.equal(store.getState().activeSessionId, "video-1");
    assert.equal(store.getState().railPlugin, "studio-test");
    assert.equal(store.getState().paneMode, "fullscreen");

    // An explicit close reveals the lane chat beneath: same tab, same chat.
    store.closeWorkspacePane();
    await flush();
    assert.equal(getActiveProfileId(), "studio-tab");
    assert.equal(store.getState().activeSessionId, "video-1");
    assert.equal(store.getState().railPlugin, null);

    // The next chat boundary presents the home surface again.
    store.activateSession("video-2");
    await flush();
    assert.equal(store.getState().railPlugin, "studio-test");
    assert.equal(store.getState().paneMode, "fullscreen");

    // So does a fresh new chat in the lane (startNewSession closes the window).
    store.startNewSession("p-lane-home");
    await flush();
    assert.equal(getActiveProfileId(), "studio-tab");
    assert.equal(store.getState().activeSessionId, null);
    assert.equal(store.getState().railPlugin, "studio-test");

    // ...and the chat its first send creates; opening it then re-activates
    // the same chat and shows "its chat" once loaded, without a boundary.
    store.setSessions("p-lane-home", [row("chat-1"), row("video-1", { purpose: PURPOSE }), row("video-2", { purpose: PURPOSE }), row("video-3", { purpose: PURPOSE })]);
    store.activateSession("video-3");
    store.showSessionChat();
    await flush();
    store.activateSession("video-3");
    store.showSessionChat();
    await flush();
    assert.equal(getActiveProfileId(), "studio-tab");
    assert.equal(store.getState().railPlugin, "studio-test");
    assert.equal(store.getState().paneMode, "fullscreen");

    // From the revealed lane chat, entering the tab again shows the surface.
    store.closeWorkspacePane();
    await flush();
    assert.equal(store.getState().railPlugin, null);
    assert.equal(nav.switchWorkbenchNavigation({ profileId: "studio-tab" }), true);
    await flush();
    assert.equal(store.getState().railPlugin, "studio-test");
    assert.equal(store.getState().activeSessionId, "video-3");

    // An ordinary chat belongs to Chat: the device leaves the lane.
    store.activateSession("chat-1");
    await flush();
    assert.equal(getActiveProfileId(), "conversation");
    assert.equal(store.getState().railPlugin, null);
  } finally {
    store.closeWorkspacePane({ restoreFocus: false });
    offProfile();
    offSurface();
  }
});

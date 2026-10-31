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
const { isWorkbenchProfileOffered, workbenchProfileOffersStorageKey } = await import("../src/workbench/profileOffers.ts");
const nav = await import("../src/workbench/profileNavigation.ts");

const PRESENTATION = {
  kind: "workspace" as const,
  defaultRatio: 0.6,
  minWidth: 320,
  preferredMaxWidth: 1200,
  keepAlive: true,
  escape: "close" as const,
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("an optional profile joins the view switch only once the project offers it; its home surface is the whole view", async () => {
  const offSurface = registerSurface({
    id: "board-test",
    capabilityId: "board-test",
    title: "Board",
    order: 90,
    component: () => null,
    presentation: PRESENTATION,
  });
  const offProfile = registerWorkbenchProfile({
    id: "board-tab",
    label: "Board",
    description: "",
    order: 5,
    defaultLayout: {
      surfaces: [
        { surface: "session", region: "primary", active: true },
        { surface: "board-test", region: "end", active: true },
      ],
    },
    presentation: { navigation: "primary", optional: true, homeSurface: "board-test" },
  });
  try {
    store.activateProject("p-optional");
    setWorkbenchProject("p-optional");
    store.setSessions("p-optional", [{ id: "s-1", projectId: "p-optional", title: "s-1", status: "idle", createdAt: 1, updatedAt: 1 }]);
    store.activateSession("s-1");

    assert.equal(nav.listWorkbenchNavigationProfiles().some((profile) => profile.id === "board-tab"), false, "not offered yet");
    assert.equal(nav.getWorkbenchNavigationProfileId("board-tab"), "conversation");
    assert.equal(nav.activateWorkbenchNavigationProfile("board-tab"), false, "a package cannot switch to a tab the project has not offered");

    // The header menu (or project settings) offers it; choosing it switches.
    nav.setWorkbenchProfileTabEnabled("board-tab", true);
    assert.equal(isWorkbenchProfileOffered("board-tab", "p-optional"), true);
    assert.equal(localStorage.getItem(workbenchProfileOffersStorageKey("p-optional")), JSON.stringify({ "board-tab": true }));
    assert.equal(isWorkbenchProfileOffered("board-tab", "p-other"), false, "the offer belongs to one project");
    assert.equal(getActiveProfileId(), "board-tab");
    assert.ok(nav.listWorkbenchNavigationProfiles().some((profile) => profile.id === "board-tab"));
    assert.equal(nav.activeWorkbenchHomeSurface(), "board-test");
    assert.equal(store.getState().railPlugin, "board-test", "the home surface opens");
    assert.equal(store.getState().paneMode, "fullscreen", "over the whole workspace, as Canvas replaces Chat");

    // Closing the home surface leaves the tab for Chat with the same session.
    store.closeWorkspacePane();
    await flush();
    assert.equal(getActiveProfileId(), "conversation");
    assert.equal(store.getState().activeSessionId, "s-1");

    // Back into the tab: always the whole view again.
    assert.equal(nav.switchWorkbenchNavigation({ profileId: "board-tab" }), true);
    assert.equal(store.getState().railPlugin, "board-test");
    assert.equal(store.getState().paneMode, "fullscreen");

    // Withdrawing the tab this device shows returns it to Chat.
    nav.setWorkbenchProfileOfferedForProject("board-tab", "p-optional", false);
    await flush();
    assert.equal(getActiveProfileId(), "conversation");
    assert.equal(nav.listWorkbenchNavigationProfiles().some((profile) => profile.id === "board-tab"), false);
  } finally {
    store.closeWorkspacePane({ restoreFocus: false });
    offProfile();
    offSurface();
  }
});

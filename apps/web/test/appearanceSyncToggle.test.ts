import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

test("per-device appearance sync toggle gates appearance fields only", async () => {
  const dom = new Window({ url: "http://127.0.0.1:4400/" });
  Object.assign(globalThis, {
    window: dom as unknown as Window & typeof globalThis,
    document: dom.document as unknown as Document,
    localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom),
  });
  Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

  const { api } = await import("@polyth/session/web-api");
  const sync = await import("../src/settingsSync.ts");
  const store = await import("../src/store.ts");
  const { getUiSettings } = await import("../src/uiPrefs.ts");

  const originalGet = api.clientSettings;
  const originalSave = api.clientSettingsSave;
  let revision = 0;
  let serverSettings: Record<string, unknown> = {};
  const saves: Array<{ settings: Record<string, unknown>; expectedRevision?: number }> = [];
  api.clientSettings = async () => ({ revision, updatedAt: revision, settings: structuredClone(serverSettings) });
  api.clientSettingsSave = async (settings, opts) => {
    if (opts?.expectedRevision !== revision) {
      throw Object.assign(new Error("stale settings"), { code: "conflict" });
    }
    saves.push({ settings, expectedRevision: opts?.expectedRevision });
    serverSettings = structuredClone(settings);
    revision += 1;
    return { revision, updatedAt: revision, settings };
  };

  try {
    // Seed the server with this client's blob while sync is ON (default).
    sync.initSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saves.length, 1);
    const seededProduct = saves[0]!.settings.product as Record<string, unknown>;
    const seededUi = saves[0]!.settings.ui as Record<string, unknown>;
    const serverTheme = seededProduct.theme;
    const serverDensity = seededUi.density;

    // Turn the toggle OFF: the local look freezes where it is.
    sync.setAppearanceSyncEnabled(false);
    assert.equal(sync.isAppearanceSyncEnabled(), false);

    // A local appearance edit must not be pushed, while a non-appearance edit
    // still syncs.
    store.updateSettings({ theme: "midnight", accentColor: "#ff0000", productName: "Off edit" });
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pushed = saves.at(-1)!.settings;
    const pushedProduct = pushed.product as Record<string, unknown>;
    const pushedUi = pushed.ui as Record<string, unknown>;
    // Non-appearance field still syncs.
    assert.equal(pushedProduct.productName, "Off edit");
    // Appearance fields echo the server's last confirmed values, never the
    // local look, so this device neither pushes its own look nor wipes the
    // account's look for other devices.
    assert.equal(pushedProduct.theme, serverTheme);
    assert.equal(pushedProduct.accentColor, seededProduct.accentColor);
    assert.equal(pushedUi.density, serverDensity);

    // The flag is device-local: it never appears in any payload.
    for (const save of saves) {
      assert.equal(JSON.stringify(save.settings).includes("appearanceSync"), false, "flag never reaches the payload");
      assert.equal(JSON.stringify(save.settings).includes("polyth.appearanceSync"), false);
    }

    // A remote appearance change must not be applied while OFF, but a remote
    // non-appearance change still lands.
    const localThemeBefore = store.getState().settings.theme;
    const remote = structuredClone(serverSettings);
    (remote.product as Record<string, unknown>).theme = "remote-theme";
    (remote.product as Record<string, unknown>).accentColor = "#00ff00";
    (remote.product as Record<string, unknown>).productName = "Remote name";
    (remote.ui as Record<string, unknown>).density = "balanced";
    revision += 1;
    serverSettings = remote;
    sync.applyRemoteClientSettings({ revision, updatedAt: revision, settings: remote });
    assert.equal(store.getState().settings.theme, localThemeBefore, "remote theme ignored while OFF");
    assert.equal(store.getState().settings.accentColor, "#ff0000", "remote accent ignored while OFF");
    assert.equal(store.getState().settings.productName, "Remote name", "non-appearance still applied");
    assert.equal(getUiSettings().density, serverDensity, "remote density ignored while OFF");

    // Turning ON adopts the server look (no flicker), and does not push the
    // frozen local look.
    const savesBeforeOn = saves.length;
    sync.setAppearanceSyncEnabled(true);
    assert.equal(sync.isAppearanceSyncEnabled(), true);
    assert.equal(store.getState().settings.theme, "remote-theme", "ON adopts the server theme");
    assert.equal(store.getState().settings.accentColor, "#00ff00", "ON adopts the server accent");
    assert.equal(getUiSettings().density, "balanced", "ON adopts the server density");
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saves.length, savesBeforeOn, "adopting the server look does not push the local look back");

    // Storage event from another tab: while OFF the local appearance still wins.
    sync.setAppearanceSyncEnabled(false);
    const otherTab = structuredClone(serverSettings);
    (otherTab.product as Record<string, unknown>).theme = "other-tab-theme";
    revision += 1;
    serverSettings = otherTab;
    sync.applyRemoteClientSettings({ revision, updatedAt: revision, settings: otherTab });
    assert.equal(store.getState().settings.theme, "remote-theme", "another tab's theme does not overwrite the gated local look");
  } finally {
    api.clientSettings = originalGet;
    api.clientSettingsSave = originalSave;
    sync.setAppearanceSyncEnabled(true);
  }
});

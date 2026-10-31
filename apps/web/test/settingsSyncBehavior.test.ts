import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

test("account sync merges pending edits and keeps device navigation and images local", async () => {
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
  const {
    getLastHarnessModels, getLastHarnessModelsRecord, getModelThinking, rememberHarnessModel, setModelThinking, thinkingModelKey,
  } = await import("@polyth/models/web-prefs");
  const { getBackground, setCustomBackground } = await import("../src/backgrounds.ts");
  const { setRailLastOpen, getRailPrefs } = await import("../src/railPrefs.ts");
  const { setSidebarLayout, getSidebarLayout } = await import("../src/sidebarLayout.ts");
  const { setMobileWorkspaceLastPackage, getMobileWorkspaceNavigationSnapshot } = await import("../src/mobileWorkspaceNavigation.ts");
  const { mobileRailKey, readMobileRail, writeMobileRail, getMobileRailMap } = await import("../src/composer/mobileRail.ts");
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
    sync.initSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saves.length, 1);

    // A session event changes the app store, but has no settings work to send.
    store.setOpeningSession("s1");
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saves.length, 1);

    store.updateSettings({ productName: "Local edit" });
    (serverSettings.ui as Record<string, unknown>).density = "compact";
    (serverSettings.ui as Record<string, unknown>).mobileSessionTitle = "button";
    (serverSettings.product as Record<string, unknown>).productName = "Server edit";
    revision += 1;
    // The WS frame was missed; the stale PUT must conflict and reconcile GET.
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.getState().settings.productName, "Local edit");
    assert.equal(getUiSettings().density, "compact");
    assert.equal(getUiSettings().mobileSessionTitle, "button");
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saves.at(-1)?.expectedRevision, 2);
    assert.equal((saves.at(-1)?.settings.product as Record<string, unknown>).productName, "Local edit");
    assert.equal((saves.at(-1)?.settings.ui as Record<string, unknown>).density, "compact");
    assert.equal((saves.at(-1)?.settings.ui as Record<string, unknown>).mobileSessionTitle, "button");

    setRailLastOpen("git");
    setSidebarLayout({ collapsed: true, restoreViewMode: "rail" });
    setMobileWorkspaceLastPackage("files");
    assert.equal(setCustomBackground("data:image/png;base64,AAAA"), true);
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const preferences = saves.at(-1)?.settings.preferences as Record<string, unknown>;
    assert.equal((preferences["core.rail"] as Record<string, unknown>).lastOpen, undefined);
    assert.equal(preferences["core.mobile-workspace"], undefined);
    assert.equal(JSON.stringify(saves.at(-1)?.settings).includes("customImage"), false);

    const legacy = structuredClone(saves.at(-1)!.settings);
    (legacy.preferences as Record<string, unknown>)["core.rail"] = { lastOpen: "browser", widths: {} };
    (legacy.preferences as Record<string, unknown>)["core.sidebar-layout"] = { width: 400, collapsed: false };
    (legacy.preferences as Record<string, unknown>)["core.mobile-workspace"] = { lastPackageId: "terminal" };
    (legacy.preferences as Record<string, unknown>)["core.background"] = { id: "custom", customImage: "data:image/png;base64,BBBB" };
    revision += 1;
    serverSettings = legacy;
    sync.applyRemoteClientSettings({ revision, updatedAt: revision, settings: legacy });
    assert.equal(getRailPrefs().lastOpen, "git");
    assert.equal(getSidebarLayout().width, 400);
    assert.equal(getSidebarLayout().collapsed, true);
    assert.equal(getMobileWorkspaceNavigationSnapshot().lastPackageId, "files");
    assert.equal(getBackground().id, "custom");
    sync.flushSettingsSync(); // Persist the legacy-key cleanup before the race.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(JSON.stringify(saves.at(-1)?.settings).includes("customImage"), false);

    const thinkingModel = { harnessId: "codex", providerID: "openai", modelID: "account-effort" };
    setModelThinking(thinkingModel, "high");
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const thinkingPrefs = (saves.at(-1)!.settings.preferences as Record<string, unknown>)["core.thinking"];
    assert.deepEqual(thinkingPrefs, { [thinkingModelKey(thinkingModel)]: "high" }, "effort uses the existing account settings sync");
    const remoteThinking = structuredClone(serverSettings);
    (remoteThinking.preferences as Record<string, unknown>)["core.thinking"] = { [thinkingModelKey(thinkingModel)]: "" };
    revision += 1;
    serverSettings = remoteThinking;
    sync.applyRemoteClientSettings({ revision, updatedAt: revision, settings: remoteThinking });
    assert.equal(getModelThinking(thinkingModel), "", "another client can synchronize explicit Auto");
    const writesBeforeEcho = saves.length;
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saves.length, writesBeforeEcho, "an inbound effort snapshot does not echo back");

    // The model each harness last ran travels the same way, as a preference id
    // a client that predates it keeps instead of erasing.
    rememberHarnessModel("codex", { providerID: "openai", modelID: "account-last", name: "Account last" });
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      (saves.at(-1)!.settings.preferences as Record<string, unknown>)["core.last-harness-models"],
      { codex: ["openai", "account-last", "Account last"] },
      "a harness's last pick reaches the account record as one value",
    );
    const remoteLast = structuredClone(serverSettings);
    (remoteLast.preferences as Record<string, unknown>)["core.last-harness-models"] = {
      claude: ["anthropic", "opus"],
      codex: ["openai", "account-last", "Account last"],
    };
    revision += 1;
    serverSettings = remoteLast;
    sync.applyRemoteClientSettings({ revision, updatedAt: revision, settings: remoteLast });
    assert.deepEqual(getLastHarnessModels().claude, { providerID: "anthropic", modelID: "opus" },
      "another client's pick is what a switch here selects");
    const writesBeforeLastEcho = saves.length;
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saves.length, writesBeforeLastEcho, "an inbound pick does not echo back");
    // Two clients pick in the same harness at once: one whole pick wins, never
    // one client's provider spliced onto the other's model.
    rememberHarnessModel("claude", { providerID: "anthropic", modelID: "haiku", name: "Haiku" });
    const racing = structuredClone(serverSettings);
    (racing.preferences as Record<string, unknown>)["core.last-harness-models"] = {
      claude: ["bedrock", "opus", "Opus on Bedrock"],
      codex: ["openai", "account-last", "Account last"],
    };
    revision += 1;
    serverSettings = racing;
    sync.applyRemoteClientSettings({ revision, updatedAt: revision, settings: racing });
    const merged = getLastHarnessModels().claude;
    assert.ok(
      JSON.stringify(merged) === JSON.stringify({ providerID: "anthropic", modelID: "haiku", name: "Haiku" })
        || JSON.stringify(merged) === JSON.stringify({ providerID: "bedrock", modelID: "opus", name: "Opus on Bedrock" }),
      `a concurrent pick is merged whole, got ${JSON.stringify(merged)}`,
    );
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Two tabs of one account make the same pick: it reaches this tab through
    // storage, then through the account record. That settles without a push
    // back; a recency key order once bounced between two tabs forever.
    rememberHarnessModel("codex", { providerID: "openai", modelID: "x" });
    rememberHarnessModel("claude", { providerID: "anthropic", modelID: "y" });
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const savesBeforeTabs = saves.length;
    rememberHarnessModel("codex", { providerID: "openai", modelID: "z" });
    const otherTab = structuredClone(serverSettings);
    (otherTab.preferences as Record<string, unknown>)["core.last-harness-models"] = structuredClone(getLastHarnessModelsRecord());
    revision += 1;
    serverSettings = otherTab;
    sync.applyRemoteClientSettings({ revision, updatedAt: revision, settings: otherTab });
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saves.length, savesBeforeTabs, "an identical pick from another tab is not pushed back");
    assert.deepEqual(getLastHarnessModels().codex, { providerID: "openai", modelID: "z" });

    // Composer buttons: an arrangement built on this client reaches the server
    // blob, and one built on another client is applied here verbatim.
    const railKey = mobileRailKey("space-sync", "project-sync");
    writeMobileRail(railKey, ["host:add", "widget:local", null]);
    sync.flushSettingsSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const railPrefs = (saves.at(-1)!.settings.preferences as Record<string, unknown>)["core.mobile-composer-rail"] as Record<string, unknown>;
    assert.deepEqual(railPrefs[railKey], JSON.stringify({ v: 1, slots: ["host:add", "widget:local"] }), "a local arrangement is mirrored by project key");
    const remoteRail = structuredClone(serverSettings);
    (remoteRail.preferences as Record<string, unknown>)["core.mobile-composer-rail"] = {
      ...railPrefs,
      [railKey]: JSON.stringify({ v: 1, slots: ["widget:remote", "host:add"] }),
    };
    revision += 1;
    serverSettings = remoteRail;
    sync.applyRemoteClientSettings({ revision, updatedAt: revision, settings: remoteRail });
    assert.equal(readMobileRail(railKey), JSON.stringify({ v: 1, slots: ["widget:remote", "host:add"] }), "another client's arrangement replaces the local one");
    assert.deepEqual(Object.keys(getMobileRailMap()), [railKey]);

    let completeFirst: ((value: { revision: number; updatedAt: number; settings: Record<string, unknown> }) => void) | undefined;
    const inFlightSettings: Record<string, unknown>[] = [];
    api.clientSettingsSave = async (settings, opts) => {
      assert.equal(opts?.expectedRevision, revision);
      inFlightSettings.push(settings);
      if (inFlightSettings.length === 1) {
        return new Promise((resolve) => { completeFirst = resolve; });
      }
      revision += 1;
      serverSettings = structuredClone(settings);
      return { revision, updatedAt: revision, settings };
    };
    store.updateSettings({ productName: "first rapid edit" });
    sync.flushSettingsSync();
    store.updateSettings({ productName: "second rapid edit" });
    sync.flushSettingsSync();
    assert.equal(inFlightSettings.length, 1, "only one settings write may be in flight");
    revision += 1;
    completeFirst!({ revision, updatedAt: revision, settings: inFlightSettings[0]! });
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(inFlightSettings.length, 2);
    assert.equal((inFlightSettings[1]!.product as Record<string, unknown>).productName, "second rapid edit");
  } finally {
    api.clientSettings = originalGet;
    api.clientSettingsSave = originalSave;
  }
});

// The Appearance drawer nav must track independent typography and density
// settings on phones, and every client setting must round-trip through the
// server so a change on one device reaches the others.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { readWebStyles } from "./webStyles.ts";

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
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("interfaceSizeBucket maps the Interface scale segments to coarse buckets", async () => {
  const settings = await import("../src/settings.ts");
  assert.equal(settings.interfaceSizeBucket(12), "small");
  assert.equal(settings.interfaceSizeBucket(13), "small");
  assert.equal(settings.interfaceSizeBucket(14), "medium");
  assert.equal(settings.interfaceSizeBucket(16), "large");
  assert.equal(settings.interfaceSizeBucket(18), "large");
});

test("applySettingsToDom publishes the interface-size bucket for CSS", async () => {
  const settings = await import("../src/settings.ts");
  const base = settings.DEFAULT_SETTINGS;

  settings.applySettingsToDom({ ...base, fontSize: 14 });
  assert.equal(document.documentElement.dataset.interfaceSize, "medium");
  settings.applySettingsToDom({ ...base, fontSize: 12 });
  assert.equal(document.documentElement.dataset.interfaceSize, "small");
  settings.applySettingsToDom({ ...base, fontSize: 18 });
  assert.equal(document.documentElement.dataset.interfaceSize, "large");
});

test("the compact-shell drawer nav reacts to typography and density", async () => {
  const css = await readWebStyles();

  // Project names use the subheader role; worktree names stay linked to the
  // general-text size used by session names.
  assert.match(
    css,
    /\.sidebar \{[^}]*--nav-session-size:\s*var\(--ui-font-size, 15px\)/s,
    "the drawer nav uses the general text size for sessions",
  );
  assert.match(
    css,
    /\.sidebar \{[^}]*--nav-project-size:\s*var\(--subheader-font-size, 16px\)/s,
    "the drawer nav uses the subheader size for projects",
  );

  // Balanced density tightens the drawer rhythm (rows + scroll padding).
  const balanced = css.match(
    /:is\(html, body\)\[data-density="balanced"\] \.sidebar \{[^}]*--nav-row-session:\s*(\d+)px/s,
  );
  const comfortable = css.match(
    /:is\(html, body\)\[data-density="comfortable"\] \.sidebar \{[^}]*--nav-row-session:\s*(\d+)px/s,
  );
  assert.ok(balanced && comfortable, "both density steps set the drawer session-row height");
  assert.ok(
    Number(balanced![1]) < Number(comfortable![1]),
    "balanced density is denser than comfortable in the drawer",
  );
  assert.match(
    css,
    /:is\(html, body\)\[data-density="balanced"\] \.sidebar \.side-scroll \{[^}]*padding-block:/s,
    "balanced density also pulls in the drawer scroll padding",
  );
});

test("client settings round-trip through the server and apply on inbound frames", async () => {
  const [sync, initSrc, apiSrc, settingsSync] = await Promise.all([
    read("../src/sync.ts"),
    read("../src/init.ts"),
    read("../../../packages/session/src/webApi.ts"),
    read("../src/settingsSync.ts"),
  ]);

  // Transport: a dedicated WS frame + REST endpoints on both ends.
  assert.match(sync, /type:\s*"client-settings\/changed";\s*settings:\s*ClientSettingsDto/);
  assert.match(sync, /type:\s*"project-presentation\/changed";\s*projectId:\s*string;\s*settings:\s*ProjectPresentationSettingsDto/);
  assert.match(sync, /m\.type === "client-settings\/changed"/);
  assert.match(sync, /m\.type === "project-presentation\/changed"/);
  assert.match(apiSrc, /clientSettings:\s*\(\)\s*=>\s*jfetch<ClientSettingsDto>\(`\/api\/settings\/client`\)/);
  assert.match(apiSrc, /clientSettingsSave:\s*\(settings: Record<string, unknown>/);

  // Boot + live wiring.
  assert.match(initSrc, /initSettingsSync\(\)/);
  assert.match(initSrc, /applyRemoteClientSettings\(msg\.settings\)/);
  assert.match(initSrc, /applyRemoteProjectPresentation\(msg\.projectId, msg\.settings\)/);

  // Echo-safe: a push only fires when the serialized blob actually changed,
  // and inbound snapshots are applied under a suppression guard.
  assert.match(settingsSync, /if \(json === lastSyncedJson\) return;/);
  assert.match(settingsSync, /if \(dto\.revision <= localRevision\) return;/);
  assert.match(settingsSync, /updateSettings\(normalizeSettings\(mergedProduct\)\)/);
  assert.match(settingsSync, /setUiSettings\(parseUiSettings\(JSON\.stringify\(mergedUi\)\)\)/);

  // Session defaults ride along so server-side small-model generation (commit
  // messages, next-action, task brief) honours the model the user picked.
  assert.match(settingsSync, /sessionDefaults:\s*getSessionDefaults\(\)/);
  assert.match(settingsSync, /setSessionDefaults\(parseSessionDefaults\(JSON\.stringify\(mergedDefaults\)\)\)/);

  // Model-picker state is part of the same server-owned account blob. Existing
  // local prefs only seed an older/empty server record; after that the server
  // snapshot is authoritative on boot/reconnect and changes are subscribed.
  assert.match(settingsSync, /modelPrefs:\s*getModelPrefs\(\)/);
  assert.match(settingsSync, /replaceModelPrefs\(parseModelPrefs\(JSON\.stringify\(mergedModels\)\)\)/);
  assert.match(settingsSync, /subscribeModelPrefs\(schedulePush\)/);
  assert.match(settingsSync, /expectedRevision: localRevision/);
  assert.match(settingsSync, /mergeLocal\(base\[key\], before\[key\], remote\)/);
  assert.match(settingsSync, /if \(JSON\.stringify\(currentBlob\(\)\) !== lastSyncedJson\) schedulePush\(\);/);

  // OpenCode provider/model visibility rides the same account blob, so the
  // per-user list reaches every client. It is server-owned: the local cache is
  // applied from the snapshot, never pushed back as the authority.
  assert.match(settingsSync, /modelVisibility:\s*getModelVisibilityPrefs\(\)/);
  assert.match(settingsSync, /replaceModelVisibilityPrefs\(mergedVisibility\)/);
});

test("settings flush uses a keepalive write", async () => {
  const { api } = await import("@polyth/session/web-api");
  api.clientSettings = async () => ({ revision: 1, updatedAt: 1, settings: {} });
  let keepalive = false;
  api.clientSettingsSave = async (_settings, opts) => {
    keepalive = opts?.keepalive === true;
    return { revision: 2, updatedAt: 2, settings: {} };
  };
  const sync = await import("../src/settingsSync.ts");
  const store = await import("../src/store.ts");
  sync.initSettingsSync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  store.updateSettings({ productName: "Flush test" });
  sync.flushSettingsSync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(keepalive, true);
});

test("registered UI preferences share the account blob and apply inbound values", async () => {
  const { api } = await import("@polyth/session/web-api");
  let saved: Record<string, unknown> | undefined;
  api.clientSettingsSave = async (settings) => {
    saved = settings;
    return { revision: 20, updatedAt: 20, settings };
  };
  const sync = await import("../src/settingsSync.ts");
  let value = { width: 320 };
  const listeners = new Set<() => void>();
  const off = sync.registerUiPreference("test.layout", {
    read: () => value,
    write: (next) => { value = next as { width: number }; },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  });
  value = { width: 360 };
  for (const listener of listeners) listener();
  sync.flushSettingsSync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual((saved?.preferences as Record<string, unknown> | undefined)?.["test.layout"], { width: 360 });

  sync.applyRemoteClientSettings({
    revision: 21,
    updatedAt: 21,
    settings: { preferences: { "test.layout": { width: 420 } } },
  });
  assert.deepEqual(value, { width: 420 });
  off();
});

test("legacy remote mobile navigation never replaces this device's last package", async () => {
  const sync = await import("../src/settingsSync.ts");
  const { getMobileWorkspaceNavigationSnapshot, hideMobileWorkspaceHome, setMobileWorkspaceLastPackage } = await import("../src/mobileWorkspaceNavigation.ts");
  hideMobileWorkspaceHome();
  setMobileWorkspaceLastPackage("files");
  assert.equal(getMobileWorkspaceNavigationSnapshot().homeOpen, false);

  sync.applyRemoteClientSettings({
    revision: 99,
    updatedAt: 99,
    settings: {
      preferences: {
        "core.mobile-workspace": { lastPackageId: null },
      },
    },
  });

  assert.equal(getMobileWorkspaceNavigationSnapshot().homeOpen, false);
  assert.equal(getMobileWorkspaceNavigationSnapshot().lastPackageId, "files");
});

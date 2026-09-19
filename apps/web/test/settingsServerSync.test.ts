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

  // Project/worktree names and sessions use their independent type roles.
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
  assert.match(sync, /m\.type === "client-settings\/changed"/);
  assert.match(apiSrc, /clientSettings:\s*\(\)\s*=>\s*jfetch<ClientSettingsDto>\(`\/api\/settings\/client`\)/);
  assert.match(apiSrc, /clientSettingsSave:\s*\(settings: Record<string, unknown>/);

  // Boot + live wiring.
  assert.match(initSrc, /initSettingsSync\(\)/);
  assert.match(initSrc, /applyRemoteClientSettings\(msg\.settings\)/);

  // Echo-safe: a push only fires when the serialized blob actually changed,
  // and inbound snapshots are applied under a suppression guard.
  assert.match(settingsSync, /if \(json === lastSyncedJson\) return;/);
  assert.match(settingsSync, /if \(dto\.revision <= localRevision\) return;/);
  assert.match(settingsSync, /updateSettings\(normalizeSettings\(incoming\.product\)\)/);
  assert.match(settingsSync, /setUiSettings\(parseUiSettings\(JSON\.stringify\(incoming\.ui\)\)\)/);

  // Session defaults ride along so server-side small-model generation (commit
  // messages, next-action, task brief) honours the model the user picked.
  assert.match(settingsSync, /sessionDefaults:\s*getSessionDefaults\(\)/);
  assert.match(settingsSync, /setSessionDefaults\(parseSessionDefaults\(JSON\.stringify\(incoming\.sessionDefaults\)\)\)/);

  // Model-picker state is part of the same server-owned account blob. Existing
  // local prefs only seed an older/empty server record; after that the server
  // snapshot is authoritative on boot/reconnect and changes are subscribed.
  assert.match(settingsSync, /modelPrefs:\s*getModelPrefs\(\)/);
  assert.match(settingsSync, /replaceModelPrefs\(parseModelPrefs\(JSON\.stringify\(incoming\.modelPrefs\)\)\)/);
  assert.match(settingsSync, /subscribeModelPrefs\(schedulePush\)/);
  assert.match(settingsSync, /usagePrefs:\s*getUsagePrefs\(\)/);
  assert.match(settingsSync, /replaceUsagePrefs\(parseUsagePrefs\(JSON\.stringify\(incoming\.usagePrefs\)\)\)/);
  assert.match(settingsSync, /subscribeUsagePrefs\(schedulePush\)/);
  assert.match(settingsSync, /if \(!serverHasModelPrefs \|\| !serverHasUsagePrefs\) lastSyncedJson = "";/);
  assert.match(settingsSync, /if \(JSON\.stringify\(currentBlob\(\)\) !== lastSyncedJson\) schedulePush\(\);/);
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

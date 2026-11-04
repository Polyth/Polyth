// The native app's origin storage is empty on every launch, so the person's
// look (theme, wallpaper preset, density…) is remembered in the app-owned store
// and put back before the first render. The server stays the authority: its
// answer replaces the remembered look, an edit made meanwhile survives, and
// applying the memory never causes a push.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

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

import type { AsyncKeyValueStore } from "../src/clientPersistence.ts";

const { api } = await import("@polyth/session/web-api");
const sync = await import("../src/settingsSync.ts");
const store = await import("../src/store.ts");
const persistence = await import("../src/clientPersistence.ts");
const snapshot = await import("../src/settingsSnapshot.ts");
const { getUiSettings, setUiSettings, parseUiSettings } = await import("../src/uiPrefs.ts");
const { getBackground, setBackground, DEFAULT_BACKGROUND_ID } = await import("../src/backgrounds.ts");
const { loadCustomThemes, replaceCustomThemes } = await import("../src/theme.ts");
const { normalizeSettings } = await import("../src/settings.ts");
const { clientAccountPersistenceScope } = await import("../src/reliabilityContext.ts");
const { decideLaunchReveal, LAUNCH_REVEAL_TIMING } = await import("../src/launchReveal.ts");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A stand-in for the Link app-owned store that outlives a "launch". */
const stores = new WeakMap<object, Map<string, string>>();
const memory = (backend: object): Map<string, string> => stores.get(backend)!;
function memoryStore(limit = 256 * 1024) {
  const records = new Map<string, string>();
  const backend: AsyncKeyValueStore = {
    async get(key) { return records.get(key) ?? null; },
    async set(key, value) {
      if (value.length > limit) throw new Error("too large");
      records.set(key, value);
    },
    async remove(key) { records.delete(key); },
  };
  stores.set(backend, records);
  return { records, backend };
}

function resetLocalState(): void {
  store.updateSettings(normalizeSettings({}));
  setUiSettings(parseUiSettings(null));
  setBackground(DEFAULT_BACKGROUND_ID);
  replaceCustomThemes([]);
  sync.resetSettingsSyncForTest();
}

const LOOK = {
  product: { theme: "midnight", appearanceMode: "dark", themeStyle: "auto", accentColor: "#ff8800", density: "comfortable", fontSize: 16, chatFontSize: 17, fontFamily: "theme" },
  ui: { density: "comfortable", shellLook: "standard", rounding: 4 },
  background: "blue-hour",
  customTheme: null,
};

/** What an up-to-date client saves from untouched defaults, so a server holding
 *  it differs from the client only where a test says so. */
let realistic: Record<string, unknown> = {};
async function captureRealisticBlob(): Promise<void> {
  resetLocalState();
  persistence.setClientPersistenceBackend(null);
  const seed = fakeServer(0, {});
  sync.initSettingsSync();
  await flush();
  sync.flushSettingsSync();
  await flush();
  realistic = structuredClone(seed.saves.at(-1)!);
  assert.ok(realistic.product);
  resetLocalState();
}

function serverBlob(extra: { product?: object; ui?: object; preferences?: object } = {}): Record<string, unknown> {
  const blob = structuredClone(realistic);
  return {
    ...blob,
    product: { ...(blob.product as object), ...extra.product },
    ui: { ...(blob.ui as object), ...extra.ui },
    preferences: { ...(blob.preferences as object), "core.background": { id: "ember-veil" }, ...extra.preferences },
  };
}

interface Server {
  revision: number;
  settings: Record<string, unknown>;
  saves: Array<Record<string, unknown>>;
  delayRead: Promise<void> | null;
  failRead: boolean;
}
function fakeServer(revision: number, settings: Record<string, unknown>): Server {
  const server: Server = { revision, settings, saves: [], delayRead: null, failRead: false };
  api.clientSettings = async () => {
    if (server.delayRead) await server.delayRead;
    if (server.failRead) throw new Error("offline");
    return { revision: server.revision, updatedAt: 1, settings: structuredClone(server.settings) };
  };
  api.clientSettingsSave = async (settings, opts) => {
    if (opts?.expectedRevision !== server.revision) throw Object.assign(new Error("stale"), { code: "conflict" });
    server.saves.push(structuredClone(settings));
    server.settings = structuredClone(settings);
    server.revision += 1;
    return { revision: server.revision, updatedAt: 2, settings };
  };
  return server;
}

async function remember(backend: AsyncKeyValueStore, look: object = LOOK): Promise<void> {
  persistence.setClientPersistenceBackend(backend);
  const encoded = JSON.stringify({ v: 1, savedAt: 1, ...look });
  persistence.writeClientPreference("settings-look-v1", clientAccountPersistenceScope(), encoded);
  // Preference writes are not part of the flush barrier: wait for the store.
  for (let i = 0; i < 100 && ![...memory(backend)].length; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  persistence.setClientPersistenceBackend(backend); // a new launch: cold cache
}

test("setup: capture an untouched client's own blob", async () => { await captureRealisticBlob(); });

test("the record keeps only the look and refuses what is missing, corrupt, oversized or of another version", () => {
  const look = {
    product: snapshot.pickLookProduct(normalizeSettings({ theme: "midnight", productName: "Secret Co", defaultModel: "x/y" })),
    ui: snapshot.pickLookUi({ ...parseUiSettings(null), notifyTemplate: "{preview}", mcpServers: [{ id: "a", name: "n", url: "http://h" }] } as never),
    background: "blue-hour",
    customTheme: null,
    preferences: {},
  };
  const encoded = snapshot.encodeSettingsLook(look, 1)!;
  const decoded = snapshot.decodeSettingsLook(encoded)!;
  assert.equal(decoded.product.theme, "midnight");
  assert.equal(decoded.background, "blue-hour");
  for (const leaked of ["Secret Co", "defaultModel", "mcpServers", "notifyTemplate", "customImage"]) {
    assert.equal(encoded.includes(leaked), false, leaked);
  }
  assert.equal(snapshot.decodeSettingsLook(null), null);
  assert.equal(snapshot.decodeSettingsLook("{nope"), null);
  assert.equal(snapshot.decodeSettingsLook(JSON.stringify({ v: 2, savedAt: 1, ...LOOK })), null);
  assert.equal(snapshot.decodeSettingsLook(JSON.stringify({ v: 1, ...LOOK })), null);
  assert.equal(snapshot.decodeSettingsLook(JSON.stringify({ v: 1, savedAt: 1, product: 3, ui: {} })), null);
  assert.equal(snapshot.decodeSettingsLook(encoded + " ".repeat(snapshot.SETTINGS_LOOK_MAX_BYTES)), null);
  // An unknown or custom wallpaper id is not a preset: no wallpaper is restored.
  assert.equal(snapshot.decodeSettingsLook(JSON.stringify({ v: 1, savedAt: 1, ...LOOK, background: "custom" }))!.background, "");
  assert.equal(snapshot.decodeSettingsLook(JSON.stringify({ v: 1, savedAt: 1, ...LOOK, background: "made-up" }))!.background, "");
  // Too big even without its custom theme: not remembered.
  assert.equal(snapshot.encodeSettingsLook({ ...look, product: { ...look.product, accentColor: "x".repeat(70_000) } }, 1), null);
});

test("a browser is unchanged: no store, nothing restored, nothing written", async () => {
  resetLocalState();
  persistence.setClientPersistenceBackend(null);
  localStorage.setItem("polyth.client.v1.x", "keep");
  assert.equal(await sync.restoreRememberedLook(), false);
  assert.equal(store.getState().settings.theme, normalizeSettings({}).theme);
  const server = fakeServer(1, serverBlob());
  sync.initSettingsSync();
  await flush();
  sync.flushSettingsSync();
  assert.equal(server.saves.length, 0);
  assert.equal(snapshot.writeSettingsLook("{}"), undefined);
  assert.equal(await snapshot.readSettingsLook(), null);
});

test("a corrupt or foreign record leaves the launch exactly as it was", async () => {
  resetLocalState();
  const { backend, records } = memoryStore();
  persistence.setClientPersistenceBackend(backend);
  // Another account/connection's record is never found under this scope.
  persistence.writeClientPreference("settings-look-v1", { connectionScope: "other-server", accountId: "usr_other" }, JSON.stringify({ v: 1, savedAt: 1, ...LOOK }));
  await persistence.flushClientPersistence();
  persistence.setClientPersistenceBackend(backend);
  assert.equal(await sync.restoreRememberedLook(), false);
  assert.equal(store.getState().settings.theme, normalizeSettings({}).theme);
  // Corrupt record under this very scope.
  persistence.writeClientPreference("settings-look-v1", clientAccountPersistenceScope(), "{garbage");
  await persistence.flushClientPersistence();
  persistence.setClientPersistenceBackend(backend);
  assert.equal(await sync.restoreRememberedLook(), false);
  assert.equal(store.getState().settings.theme, normalizeSettings({}).theme);
});

test("the remembered look is on screen before sync starts, and starting sync pushes nothing", async () => {
  resetLocalState();
  const { backend } = memoryStore();
  await remember(backend);
  assert.equal(await sync.restoreRememberedLook(), true);
  assert.equal(store.getState().settings.theme, "midnight");
  assert.equal(store.getState().settings.accentColor, "#ff8800");
  assert.equal(document.documentElement.dataset.theme, "midnight");
  assert.equal(getUiSettings().rounding, 4);
  assert.equal(getBackground().id, "blue-hour");
  assert.equal(document.documentElement.dataset.background, "blue-hour");
  // The native status bar follows the restored wallpaper and palette.
  assert.equal(document.documentElement.style.getPropertyValue("--app-system-bar-color").length > 0, true);
  const server = fakeServer(0, {});
  server.failRead = true;
  sync.initSettingsSync();
  await flush();
  sync.flushSettingsSync();
  await flush();
  assert.equal(server.saves.length, 0, "an unanswered server is never sent the remembered look");
  assert.equal(store.getState().settings.theme, "midnight", "a failed read keeps the remembered look");
});

test("the server's answer replaces the remembered look, with no push and a held back stale copy", async () => {
  resetLocalState();
  const { backend } = memoryStore();
  await remember(backend);
  assert.equal(await sync.restoreRememberedLook(), true);
  const server = fakeServer(7, serverBlob({
    product: { theme: "forest", accentColor: "", density: "compact" },
    preferences: { "core.background": { id: "ember-veil" } },
  }));
  let release!: () => void;
  server.delayRead = new Promise<void>((resolve) => { release = resolve; });
  sync.initSettingsSync();
  await flush();
  assert.equal(store.getState().settings.theme, "midnight", "the remembered look holds while the read is out");
  release();
  await flush();
  await flush();
  assert.equal(store.getState().settings.theme, "forest");
  assert.equal(store.getState().settings.accentColor, "");
  assert.equal(getBackground().id, "ember-veil");
  sync.flushSettingsSync();
  await flush();
  assert.equal(server.saves.length, 0, "applying the memory and then the answer pushes nothing");
  assert.equal(server.revision, 7);
});

test("an edit made during the launch window survives the answer, whichever way the race goes", async () => {
  // Edit before the answer.
  resetLocalState();
  const { backend } = memoryStore();
  await remember(backend);
  await sync.restoreRememberedLook();
  const server = fakeServer(3, serverBlob({ product: { theme: "forest", density: "compact" } }));
  let release!: () => void;
  server.delayRead = new Promise<void>((resolve) => { release = resolve; });
  sync.initSettingsSync();
  await flush();
  store.updateSettings({ theme: "mist" });
  release();
  await flush();
  await flush();
  assert.equal(store.getState().settings.theme, "mist", "the local edit beats the remembered and the server value");
  sync.flushSettingsSync();
  await flush();
  await flush();
  assert.equal((server.saves.at(-1)?.product as Record<string, unknown>).theme, "mist");
  assert.equal((server.saves.at(-1)?.product as Record<string, unknown>).density, "compact", "unrelated server edits still land");

  // Edit after the answer.
  resetLocalState();
  await remember(backend);
  await sync.restoreRememberedLook();
  const second = fakeServer(5, serverBlob({ product: { theme: "forest" } }));
  sync.initSettingsSync();
  await flush();
  await flush();
  assert.equal(store.getState().settings.theme, "forest");
  store.updateSettings({ theme: "mist" });
  sync.flushSettingsSync();
  await flush();
  await flush();
  assert.equal((second.saves.at(-1)?.product as Record<string, unknown>).theme, "mist");
});

test("a server with no record never receives the remembered look", async () => {
  resetLocalState();
  const { backend } = memoryStore();
  await remember(backend);
  assert.equal(await sync.restoreRememberedLook(), true);
  const server = fakeServer(0, {});
  sync.initSettingsSync();
  await flush();
  await flush();
  sync.flushSettingsSync();
  await flush();
  const seeded = server.saves.at(-1);
  assert.ok(seeded, "an empty server is seeded as on a first run");
  assert.equal((seeded.product as Record<string, unknown>).theme, normalizeSettings({}).theme, "with the client's own values, not the memory");
  assert.equal(store.getState().settings.theme, normalizeSettings({}).theme);
  assert.equal(getBackground().id, DEFAULT_BACKGROUND_ID);
});

test("what the server confirms is remembered; a launch does not re-save its own memory", async () => {
  resetLocalState();
  const { backend, records } = memoryStore();
  await remember(backend);
  const before = [...records.values()].join("|");
  await sync.restoreRememberedLook();
  const server = fakeServer(4, serverBlob({ product: { theme: "forest" } }));
  server.failRead = true;
  sync.initSettingsSync();
  await flush();
  sync.flushSettingsSync();
  await persistence.flushClientPersistence();
  assert.equal([...records.values()].join("|"), before, "no server answer, no write");
  server.failRead = false;
  sync.initSettingsSync();
  await flush();
  await flush();
  sync.flushSettingsSync();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const written = [...records.values()].map((raw) => snapshot.decodeSettingsLook(raw)).find((look) => look?.product.theme === "forest");
  assert.ok(written, "the answered look is what the next launch finds");
  assert.equal(written.background, "ember-veil");
});

test("a custom palette the look names travels with it, others stay untouched", async () => {
  resetLocalState();
  const { backend } = memoryStore();
  const base = (await import("../src/theme.ts")).DEFAULT_THEME;
  const mine = { ...base, id: "mine", name: "Mine" };
  const other = { ...base, id: "other", name: "Other" };
  replaceCustomThemes([other]);
  const look = { ...LOOK, product: { ...LOOK.product, theme: "mine" }, customTheme: mine };
  await remember(backend, look);
  const wasOther = loadCustomThemes();
  assert.equal(wasOther.length, 1);
  // The device's other custom palette is neither a different look nor touched.
  assert.equal(await sync.restoreRememberedLook(), true);
  assert.deepEqual(loadCustomThemes().map((theme) => theme.id).sort(), ["mine", "other"]);
  assert.equal(store.getState().settings.theme, "mine");
});

test("once sync has started a remembered look is never applied over the live one", async () => {
  resetLocalState();
  const { backend } = memoryStore();
  await remember(backend);
  fakeServer(0, {}).failRead = true;
  sync.initSettingsSync();
  store.updateSettings({ theme: "mist" });
  assert.equal(await sync.restoreRememberedLook(), false);
  assert.equal(store.getState().settings.theme, "mist");
});

test("the launch veil holds for settings only a bounded grace when a look was restored, and keeps its caps", () => {
  const T = LAUNCH_REVEAL_TIMING;
  assert.equal(T.settingsGraceMs, 600);
  const progress = {
    phase: "ready" as const, committedAt: 100, hydratedAt: 500, settingsSettled: false, lookRestored: false,
    packagesSettled: true, holds: 0, lastChangeAt: 500,
  };
  // Without a restored look the hold is unchanged: up to the settle cap.
  assert.equal(decideLaunchReveal(progress, 500 + T.settingsGraceMs + 50).reveal, false);
  assert.equal(decideLaunchReveal(progress, 500 + T.settledCapMs).reveal, true);
  // With one it holds until settings settle or the grace ends, whichever is first.
  const restored = { ...progress, lookRestored: true };
  const early = decideLaunchReveal(restored, 1_000);
  assert.deepEqual(early, { reveal: false, wakeAt: 500 + T.settingsGraceMs }, "the grace end is a wake time, so evaluation re-runs");
  assert.equal(decideLaunchReveal(restored, 500 + T.settingsGraceMs).reveal, true);
  assert.equal(decideLaunchReveal({ ...restored, settingsSettled: true, lastChangeAt: 0 }, 700).reveal, true, "an answer inside the grace releases it");
  // The other holds and caps stay.
  assert.equal(decideLaunchReveal({ ...restored, holds: 1 }, 500 + T.settingsGraceMs + 50).reveal, false);
  assert.equal(decideLaunchReveal({ ...restored, hydratedAt: null }, 5_000).reveal, false);
});

test("sign-out and account switch: another account's scope never reads this look", async () => {
  resetLocalState();
  const { backend } = memoryStore();
  await remember(backend);
  const mine = clientAccountPersistenceScope();
  assert.notEqual(mine.accountId, "usr_other");
  persistence.setClientPersistenceBackend(backend);
  assert.equal(await persistence.hydrateClientRecord("settings-look-v1", { ...mine, accountId: "usr_other" }), null);
  assert.equal(await persistence.hydrateClientRecord("settings-look-v1", { ...mine, connectionScope: "another-server" }), null);
});

test("a preset this build does not know keeps the current wallpaper instead of blanking it", async () => {
  resetLocalState();
  const { backend } = memoryStore();
  await remember(backend, { ...LOOK, background: "preset-from-a-newer-shell" });
  assert.equal(await sync.restoreRememberedLook(), true);
  assert.equal(getBackground().id, DEFAULT_BACKGROUND_ID);
  assert.notEqual(document.documentElement.style.getPropertyValue("--app-background-image"), "none");
  assert.equal(store.getState().settings.theme, "midnight", "the rest of the look still applies");
  // And an answer that has no wallpaper keeps the client's own, with nothing pushed.
  const server = fakeServer(2, serverBlob());
  delete (server.settings.preferences as Record<string, unknown>)["core.background"];
  sync.initSettingsSync();
  await flush();
  await flush();
  assert.equal(getBackground().id, DEFAULT_BACKGROUND_ID);
});

async function heroAdapter() {
  return await import("../src/heroWidgetPrefs.ts");
}
const hiddenOf = (hero: Awaited<ReturnType<typeof heroAdapter>>): string => JSON.stringify(hero.getHeroWidgetPrefs().hidden);

test("a remembered preference is written through its adapter, the server replaces it, no push", async () => {
  resetLocalState();
  const hero = await heroAdapter();
  const original = structuredClone(hero.getHeroWidgetPrefs());
  const { backend } = memoryStore();
  await remember(backend, { ...LOOK, preferences: { "core.hero-widgets": { ...original, hidden: [original.order[0]] } } });
  assert.equal(await sync.restoreRememberedLook(), true);
  assert.equal(hiddenOf(hero), JSON.stringify([original.order[0]]), "the remembered value is in the store before sync starts");
  const server = fakeServer(4, serverBlob({ preferences: { "core.hero-widgets": original } }));
  sync.initSettingsSync();
  await flush();
  await flush();
  assert.equal(hiddenOf(hero), JSON.stringify(original.hidden), "the server's value replaces the memory");
  sync.flushSettingsSync();
  await flush();
  assert.equal(server.saves.length, 0);
});

test("a remembered preference the server has no word on reverts and is never seeded; a local edit wins", async () => {
  resetLocalState();
  const hero = await heroAdapter();
  const original = structuredClone(hero.getHeroWidgetPrefs());
  const { backend } = memoryStore();
  const wanted = { ...original, hidden: [original.order[0]] };
  await remember(backend, { ...LOOK, preferences: { "core.hero-widgets": wanted } });
  await sync.restoreRememberedLook();
  assert.equal(hiddenOf(hero), JSON.stringify(wanted.hidden));
  const blob = serverBlob();
  delete (blob.preferences as Record<string, unknown>)["core.hero-widgets"];
  const server = fakeServer(3, blob);
  sync.initSettingsSync();
  await flush();
  await flush();
  assert.equal(hiddenOf(hero), JSON.stringify(original.hidden), "no word from the server: back to the client's own");
  sync.flushSettingsSync();
  await flush();
  await flush();
  for (const body of server.saves) {
    assert.equal(JSON.stringify((body.preferences as Record<string, unknown>)["core.hero-widgets"]).includes(JSON.stringify(wanted.hidden)), JSON.stringify(wanted.hidden) === JSON.stringify(original.hidden), "the memory is never sent up");
  }

  // A local edit made inside the window beats both the memory and the server value.
  resetLocalState();
  hero.replaceHeroWidgetPrefs(original);
  await remember(backend, { ...LOOK, preferences: { "core.hero-widgets": wanted } });
  await sync.restoreRememberedLook();
  const second = fakeServer(5, serverBlob({ preferences: { "core.hero-widgets": original } }));
  let release!: () => void;
  second.delayRead = new Promise<void>((resolve) => { release = resolve; });
  sync.initSettingsSync();
  await flush();
  hero.replaceHeroWidgetPrefs({ ...original, hidden: [original.order[1]] });
  release();
  await flush();
  await flush();
  assert.equal(hiddenOf(hero), JSON.stringify([original.order[1]]));
});

test("preferences over the record cap are dropped before the look", () => {
  const look = {
    product: snapshot.pickLookProduct(normalizeSettings({})),
    ui: snapshot.pickLookUi(parseUiSettings(null)),
    background: "blue-hour",
    customTheme: null,
    preferences: { "core.hero-board": { big: "x".repeat(70_000) } },
  };
  const decoded = snapshot.decodeSettingsLook(snapshot.encodeSettingsLook(look, 1)!)!;
  assert.deepEqual(decoded.preferences, {});
  assert.equal(decoded.background, "blue-hour");
  assert.equal(decoded.product.theme, look.product.theme);
});

test("the server's own section never makes the client re-push an unchanged blob", async () => {
  resetLocalState();
  persistence.setClientPersistenceBackend(null);
  // The server drops `modelVisibility` from a client write when the account has
  // none, so its echo never contains it. The echo of our own PUT can land before
  // the PUT's response; it must not look like a difference to push again.
  const base = serverBlob();
  delete base.modelVisibility;
  const server = fakeServer(1, base);
  const plainSave = api.clientSettingsSave;
  api.clientSettingsSave = async (settings, opts) => {
    const stripped = { ...settings } as Record<string, unknown>;
    delete stripped.modelVisibility;
    const dto = await plainSave(stripped, opts);
    sync.applyRemoteClientSettings({ revision: dto.revision, updatedAt: 3, settings: stripped } as never);
    return dto;
  };
  sync.initSettingsSync();
  await flush();
  await flush();
  assert.equal(server.saves.length, 0, "nothing to push before an edit");
  store.updateSettings({ density: store.getState().settings.density === "comfortable" ? "balanced" : "comfortable" });
  sync.flushSettingsSync();
  for (let i = 0; i < 6; i += 1) await flush();
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(server.saves.length, 1, "one edit is one PUT, not a chain of identical ones");
});

// The native app's origin storage is empty on every launch, so a custom
// wallpaper would be lost with it. A reduced copy lives in the app-owned store
// and comes back before the first render; a browser keeps its original.
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

const backgrounds = await import("../src/backgrounds.ts");
const persistence = await import("../src/clientPersistence.ts");
const memory = await import("../src/customWallpaperMemory.ts");
const { setClientReliabilityContext } = await import("../src/reliabilityContext.ts");
const { setActiveBrowserAccount } = await import("../src/accountStorage.ts");

const { getBackground, setBackground, setCustomBackground, DEFAULT_BACKGROUND_ID, BACKGROUND_KEY, parseBackgroundState } = backgrounds;
const {
  CUSTOM_WALLPAPER_MAX_BYTES,
  decodeCustomWallpaper,
  reduceWallpaper,
  resetCustomWallpaperForTest,
  restoreCustomWallpaper,
} = memory;

const image = (name: string): string => `data:image/jpeg;base64,${btoa(name)}`;
const record = (active: boolean, value: string): string => JSON.stringify({ v: 1, active, image: value });

function memoryStore() {
  const records = new Map<string, string>();
  return {
    records,
    backend: {
      async get(key: string) { return records.get(key) ?? null; },
      async set(key: string, value: string) { records.set(key, value); },
      async remove(key: string) { records.delete(key); },
    },
  };
}

/** A fresh launch: nothing in origin storage, the app-owned store as it was. */
function launch(backend: ReturnType<typeof memoryStore>["backend"] | null): void {
  resetCustomWallpaperForTest();
  localStorage.removeItem(BACKGROUND_KEY);
  // backgrounds.ts holds one state per document: an empty-storage launch has no image.
  backgrounds.resetBackgroundForTest();
  persistence.setClientPersistenceBackend(backend);
  setClientReliabilityContext({ connectionScope: "conn-a", spaceId: "space-a" });
  setActiveBrowserAccount("usr_a");
}

const stored = (store: ReturnType<typeof memoryStore>): string | null => {
  const entries = [...store.records.values()];
  assert.ok(entries.length <= 1, "one record per connection and account");
  return entries[0] ?? null;
};

/** Store writes land asynchronously (their key is a digest), so wait for this one. */
async function storedBecomes(
  store: ReturnType<typeof memoryStore>,
  expected: { active: boolean; image: string } | null,
  message?: string,
): Promise<void> {
  const wanted = JSON.stringify(expected);
  for (let tick = 0; tick < 1_000 && JSON.stringify(decodeCustomWallpaper(stored(store))) !== wanted; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(decodeCustomWallpaper(stored(store)), expected, message);
}

/** Long enough for a write that should not happen to have landed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test("a record that is missing, corrupt, oversized, cleared or of another version is no wallpaper", () => {
  assert.equal(decodeCustomWallpaper(null), null);
  assert.equal(decodeCustomWallpaper("not json"), null);
  assert.equal(decodeCustomWallpaper("null"), null);
  assert.equal(decodeCustomWallpaper(JSON.stringify({ v: 2, active: true, image: image("a") })), null);
  assert.equal(decodeCustomWallpaper(JSON.stringify({ v: 1, image: image("a") })), null);
  assert.equal(decodeCustomWallpaper(record(false, "")), null, "a cleared record");
  assert.equal(decodeCustomWallpaper(record(true, "https://example.test/a.png")), null, "only an inline image");
  assert.equal(decodeCustomWallpaper(record(true, "data:text/html;base64,AAAA")), null);
  assert.equal(decodeCustomWallpaper(record(true, image("x".repeat(CUSTOM_WALLPAPER_MAX_BYTES)))), null, "over the cap");
  assert.deepEqual(decodeCustomWallpaper(record(true, image("a"))), { active: true, image: image("a") });
});

test("an image that already fits is kept as it is", async () => {
  assert.equal(await reduceWallpaper(image("small")), image("small"));
});

test("a browser is unchanged: nothing restored, nothing written, nothing followed", async () => {
  launch(null);
  let reductions = 0;
  await restoreCustomWallpaper(async () => { reductions += 1; return image("reduced"); });
  setCustomBackground(image("original"));
  await settle();
  assert.equal(reductions, 0);
  assert.equal(localStorage.getItem(BACKGROUND_KEY)?.includes(image("original")), true, "origin storage keeps the original");
});

test("a picked image is reduced for the next launch, which gets it back before anything renders", async () => {
  const store = memoryStore();
  launch(store.backend);
  await restoreCustomWallpaper(async () => image("reduced"));
  assert.equal(getBackground().id, DEFAULT_BACKGROUND_ID, "first launch: nothing to restore");
  assert.equal(stored(store), null, "and nothing to write");

  setCustomBackground(image("original"));
  await storedBecomes(store, { active: true, image: image("reduced") });
  assert.equal(getBackground().customImage, image("original"), "this document keeps the original");

  launch(store.backend);
  assert.equal(getBackground().customImage, "");
  await restoreCustomWallpaper(async () => { throw new Error("a restored copy is not reduced again"); });
  assert.deepEqual(getBackground(), { id: "custom", customImage: image("reduced") });
  assert.equal(document.documentElement.dataset.background, "custom", "on the page, not only in state");
});

test("choosing a preset keeps the image in the picker, without reducing it again", async () => {
  const store = memoryStore();
  launch(store.backend);
  let reductions = 0;
  await restoreCustomWallpaper(async () => { reductions += 1; return image("reduced"); });
  setCustomBackground(image("original"));
  await storedBecomes(store, { active: true, image: image("reduced") });
  setBackground("aurora");
  await storedBecomes(store, { active: false, image: image("reduced") });
  assert.equal(reductions, 1);

  launch(store.backend);
  await restoreCustomWallpaper(async () => null);
  assert.equal(getBackground().customImage, image("reduced"), "still offered in the picker");
  assert.notEqual(getBackground().id, "custom", "and not the wallpaper");
});

test("a replaced image: a failed or overtaken reduction never brings back the older one", async () => {
  const store = memoryStore();
  launch(store.backend);
  const pending: Array<(value: string | null) => void> = [];
  await restoreCustomWallpaper(() => new Promise((resolve) => { pending.push(resolve); }));

  setCustomBackground(image("first"));
  pending[0]!(image("first-reduced"));
  await storedBecomes(store, { active: true, image: image("first-reduced") });

  setCustomBackground(image("second"));
  await storedBecomes(store, null, "the old copy is gone while the new one is made");

  setCustomBackground(image("third"));
  pending[2]!(image("third-reduced"));
  await storedBecomes(store, { active: true, image: image("third-reduced") });
  pending[1]!(image("second-reduced"));
  await settle();
  assert.deepEqual(decodeCustomWallpaper(stored(store)), { active: true, image: image("third-reduced") }, "the newest image wins");

  setCustomBackground(image("fourth"));
  await storedBecomes(store, null);
  pending[3]!(null);
  await settle();
  assert.equal(decodeCustomWallpaper(stored(store)), null, "a failed reduction leaves no image, not the older one");
});

test("a failed store read shows no image and leaves the record for the next launch", async () => {
  const store = memoryStore();
  store.records.set("seed", "seed");
  const failing = { ...store.backend, get: async () => { throw new Error("stalled"); } };
  launch(failing);
  await restoreCustomWallpaper(async () => image("reduced"));
  await settle();
  assert.equal(getBackground().customImage, "");
  assert.deepEqual([...store.records.keys()], ["seed"], "nothing overwrote it");
});

test("another account or connection does not see this one's image", async () => {
  const store = memoryStore();
  launch(store.backend);
  await restoreCustomWallpaper(async () => image("reduced"));
  setCustomBackground(image("original"));
  await storedBecomes(store, { active: true, image: image("reduced") });

  launch(store.backend);
  setClientReliabilityContext({ connectionScope: "conn-b", spaceId: "space-a" });
  await restoreCustomWallpaper(async () => null);
  assert.equal(getBackground().customImage, "", "another connection");

  launch(store.backend);
  setActiveBrowserAccount("usr_b");
  await restoreCustomWallpaper(async () => null);
  assert.equal(getBackground().customImage, "", "another account");

  launch(store.backend);
  await restoreCustomWallpaper(async () => null);
  assert.equal(getBackground().customImage, image("reduced"), "its own launch still has it");
});

test("an original already in origin storage wins over the reduced copy", async () => {
  const store = memoryStore();
  launch(store.backend);
  await restoreCustomWallpaper(async () => image("reduced"));
  setCustomBackground(image("original"));
  await storedBecomes(store, { active: true, image: image("reduced") });

  // A reload within one app launch keeps origin storage.
  resetCustomWallpaperForTest();
  persistence.setClientPersistenceBackend(store.backend);
  let reductions = 0;
  await restoreCustomWallpaper(async () => { reductions += 1; return image("again"); });
  await settle();
  assert.equal(getBackground().customImage, image("original"));
  assert.equal(reductions, 0, "the record already holds this image's copy");
  assert.equal(parseBackgroundState(localStorage.getItem(BACKGROUND_KEY)).customImage, image("original"));
});

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1/" });
Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage, Event: dom.Event });
after(() => dom.happyDOM.abort());

const position = await import("../src/promptBookmarkPosition.ts");
const { accountStorageKey, setActiveBrowserAccount } = await import("../src/accountStorage.ts");
const KEY = position.PROMPT_BOOKMARK_POSITION_KEY;
const storageEvent = (key: string | null) => Object.assign(new dom.Event("storage"), { key });

beforeEach(() => {
  dom.localStorage.clear();
  setActiveBrowserAccount("usr_owner");
  position.writePromptBookmarkPosition(null);
});

test("records are parsed defensively and clamped into the unit square", () => {
  const home = { x: 1, y: 0 };
  assert.deepEqual(position.parsePromptBookmarkPosition(null), home);
  assert.deepEqual(position.parsePromptBookmarkPosition("not json"), home);
  assert.deepEqual(position.parsePromptBookmarkPosition("null"), home);
  assert.deepEqual(position.parsePromptBookmarkPosition(JSON.stringify({ v: 2, x: 0.2, y: 0.4 })), home, "an unknown version is ignored, not guessed at");
  assert.deepEqual(position.parsePromptBookmarkPosition(JSON.stringify({ x: 0.2, y: 0.4 })), home, "an unversioned record is ignored");
  assert.deepEqual(position.parsePromptBookmarkPosition(JSON.stringify({ v: 1, x: 0.25, y: 0.5 })), { x: 0.25, y: 0.5 });
  assert.deepEqual(position.parsePromptBookmarkPosition(JSON.stringify({ v: 1, x: -4, y: 9 })), { x: 0, y: 1 });
  assert.deepEqual(position.parsePromptBookmarkPosition(JSON.stringify({ v: 1, x: "0.3", y: null })), home, "non-numeric axes keep their home value");
  assert.deepEqual(position.parsePromptBookmarkPosition(JSON.stringify({ v: 1, x: 0.5 })), { x: 0.5, y: 0 }, "one valid axis survives a damaged other axis");
  assert.deepEqual(position.clampPromptBookmarkPosition({ x: Number.NaN, y: Number.POSITIVE_INFINITY }), home);
  assert.deepEqual(position.clampPromptBookmarkPosition({ x: 1 / 3, y: 2 / 3 }), { x: 0.3333, y: 0.6667 }, "stored fractions are rounded to a sub-pixel precision");
});

test("a placement persists per account and the default leaves no record behind", () => {
  const scoped = accountStorageKey(KEY, "usr_owner");
  position.writePromptBookmarkPosition({ x: 0.1, y: 0.75 });
  assert.equal(dom.localStorage.getItem(scoped), JSON.stringify({ v: 1, x: 0.1, y: 0.75 }));
  assert.deepEqual(position.getPromptBookmarkPosition(), { x: 0.1, y: 0.75 });

  setActiveBrowserAccount("usr_guest");
  assert.deepEqual(position.getPromptBookmarkPosition(), { x: 1, y: 0 }, "another account does not inherit the placement");
  position.writePromptBookmarkPosition({ x: 0.9, y: 0.2 });
  setActiveBrowserAccount("usr_owner");
  assert.deepEqual(position.getPromptBookmarkPosition(), { x: 0.1, y: 0.75 });

  position.writePromptBookmarkPosition({ x: 1, y: 0 });
  assert.equal(dom.localStorage.getItem(scoped), null, "writing the home position removes the record");
  position.writePromptBookmarkPosition({ x: 0.4, y: 0.4 });
  position.writePromptBookmarkPosition(null);
  assert.equal(dom.localStorage.getItem(scoped), null, "null resets to the default");
  assert.ok(position.isPromptBookmarkHome(position.getPromptBookmarkPosition()));
});

test("a placement is device-local and never travels with the synced UI preferences", async () => {
  position.writePromptBookmarkPosition({ x: 0.2, y: 0.2 });
  const { parseUiSettings, UI_DEFAULTS } = await import("../src/uiPrefs.ts");
  assert.ok(!Object.keys(UI_DEFAULTS).some((key) => /bookmark.*position|position.*bookmark/i.test(key)));
  const smuggled = parseUiSettings(JSON.stringify({ pinLatestPrompt: true, promptBookmarkPosition: { x: 0.2, y: 0.2 } }));
  assert.equal(smuggled.pinLatestPrompt, true);
  assert.ok(!("promptBookmarkPosition" in smuggled), "the synced settings parser drops unknown placement data");
});

test("pixel offsets and fractions invert each other, mirrored in right-to-left layouts", () => {
  const area = { width: 400, height: 600 };
  const size = { width: 40, height: 40 };
  for (const rtl of [false, true]) {
    for (const wanted of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.25, y: 0.5 }, { x: 0.8, y: 0.1 }]) {
      const offset = position.promptBookmarkOffset(wanted, area, size, rtl);
      assert.deepEqual(position.promptBookmarkFromOffset(offset, area, size, rtl), wanted, `rtl=${rtl} ${JSON.stringify(wanted)}`);
    }
  }
  assert.deepEqual(position.promptBookmarkOffset({ x: 1, y: 0 }, area, size, false), { left: 360, top: 0 }, "home is the inline-end edge: right in LTR");
  assert.deepEqual(position.promptBookmarkOffset({ x: 1, y: 0 }, area, size, true), { left: 0, top: 0 }, "home is the inline-end edge: left in RTL");
  assert.deepEqual(position.promptBookmarkOffset({ x: 0.5, y: 1 }, area, size, false), { left: 180, top: 560 });
});

test("a drag outside the free area is clamped, and an axis with no room keeps its saved value", () => {
  const area = { width: 400, height: 600 };
  const size = { width: 40, height: 40 };
  assert.deepEqual(position.promptBookmarkFromOffset({ left: -80, top: 9000 }, area, size, false), { x: 0, y: 1 });
  assert.deepEqual(position.promptBookmarkFromOffset({ left: 9000, top: -3 }, area, size, true), { x: 0, y: 0 });
  const flat = { width: 400, height: 30 };
  assert.deepEqual(
    position.promptBookmarkFromOffset({ left: 100, top: 0 }, flat, size, false, { x: 0.9, y: 0.6 }),
    { x: 0.2778, y: 0.6 },
    "a free area shorter than the control must not erase the saved vertical placement",
  );
  assert.deepEqual(
    position.promptBookmarkFromOffset({ left: 0, top: 200 }, { width: 40, height: 600 }, size, false, { x: 0.3, y: 0.1 }),
    { x: 0.3, y: 0.3571 },
    "and the same holds for a free area narrower than the control",
  );
});

test("subscribers hear local writes and other tabs' storage events for this account only", () => {
  let calls = 0;
  const stop = position.subscribePromptBookmarkPosition(() => { calls++; });
  try {
    position.writePromptBookmarkPosition({ x: 0.5, y: 0.5 });
    assert.equal(calls, 1);
    dom.dispatchEvent(storageEvent(accountStorageKey(KEY, "usr_owner")));
    assert.equal(calls, 2, "another tab moved this account's bookmark");
    dom.dispatchEvent(storageEvent("polyth.unrelated"));
    dom.dispatchEvent(storageEvent(accountStorageKey(KEY, "usr_guest")));
    assert.equal(calls, 2, "unrelated and other-account keys are ignored");
    dom.dispatchEvent(storageEvent(null));
    assert.equal(calls, 3, "clearing storage is a change");
  } finally {
    stop();
  }
  position.writePromptBookmarkPosition({ x: 0.6, y: 0.6 });
  assert.equal(calls, 3, "a disposed subscription stays silent");
});

test("blocked storage still lets the bookmark move for the lifetime of the page", () => {
  const real = dom.localStorage;
  const blocked = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("blocked"); } };
  Object.defineProperty(globalThis, "localStorage", { value: blocked, configurable: true, writable: true });
  try {
    position.writePromptBookmarkPosition({ x: 0.3, y: 0.7 });
    assert.deepEqual(position.getPromptBookmarkPosition(), { x: 0.3, y: 0.7 });
    position.writePromptBookmarkPosition(null);
    assert.deepEqual(position.getPromptBookmarkPosition(), { x: 1, y: 0 });
    position.writePromptBookmarkPosition({ x: 0.3, y: 0.7 });
  } finally {
    Object.defineProperty(globalThis, "localStorage", { value: real, configurable: true, writable: true });
  }
  position.writePromptBookmarkPosition(null);
  assert.deepEqual(position.getPromptBookmarkPosition(), { x: 1, y: 0 }, "healthy storage takes over again");
});

// A confirmation asked from a control on a phone (Delete in a session row's
// menu) opens as a card over that control. placeAnchoredAlert decides where:
// centred on the control, kept inside the visible band, with the
// transform-origin on the control so the card grows out of it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);

const { placeAnchoredAlert } = await import("../src/alerts.ts");

const band = { left: 0, top: 0, width: 390, height: 844 };
const insets = { top: 47, right: 12, bottom: 34, left: 12 };
const card = { width: 366, height: 180 };

test("the card centres on the control and grows from its centre", () => {
  const origin = { left: 200, top: 400, width: 170, height: 44 };
  const placement = placeAnchoredAlert({ origin, card, band, insets });
  assert.deepEqual(placement, { left: 12, top: 332, originX: 273, originY: 90 });
});

test("near an edge the card stays inside the band and its origin follows the control", () => {
  const low = placeAnchoredAlert({ origin: { left: 200, top: 790, width: 170, height: 44 }, card, band, insets });
  assert.equal(low.top, 844 - 34 - 180, "clear of the home indicator");
  assert.equal(low.originY, 812 - low.top, "still grows out of the control below it");
  const high = placeAnchoredAlert({ origin: { left: 0, top: 10, width: 60, height: 44 }, card, band, insets });
  assert.equal(high.top, 47, "clear of the status bar");
  assert.equal(high.left, 12);
  assert.equal(high.originX, 30 - 12);
});

test("a narrow card follows the control sideways; the band offset is subtracted", () => {
  const placement = placeAnchoredAlert({
    origin: { left: 400, top: 300, width: 100, height: 40 },
    card: { width: 300, height: 160 },
    band: { left: 0, top: 20, width: 700, height: 800 },
    insets,
  });
  assert.equal(placement.left, 300, "centred on x = 450");
  assert.equal(placement.top, 300 + 20 - 20 - 80, "band-relative: the control's centre is at 300 inside it");
});

test("a card taller than the band pins to the top inset instead of going negative", () => {
  const placement = placeAnchoredAlert({ origin: { left: 0, top: 400, width: 10, height: 10 }, card: { width: 366, height: 2000 }, band, insets });
  assert.equal(placement.top, 47);
});

test("the phone session menu's Delete hands its row to the confirmation", async () => {
  const [navigator, menu, dialog] = await Promise.all([
    readFile(new URL("../src/components/mobile/MobileNavigator.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ui/Menu.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/AlertDialog.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(menu, /const origin = row\?\.getBoundingClientRect\(\);/, "read before the menu unmounts");
  assert.match(menu, /action\.onSelect\(origin \? \{ origin \} : undefined\)/);
  assert.match(navigator, /onSelect: \(context\) => void remove\(context\?\.origin\)/);
  assert.match(navigator, /void remove\(button\.getBoundingClientRect\(\)\)/, "and so does the swipe tray's Delete");
  assert.match(navigator, /onClick=\{\(event\) => runTrayAction\(id, event\.currentTarget\)\}/);
  assert.match(dialog, /className=\{origin \? "alert-dialog is-anchored" : "alert-dialog"\}/);
});

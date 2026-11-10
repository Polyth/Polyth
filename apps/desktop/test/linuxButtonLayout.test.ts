import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseGnomeButtonLayout,
  parseKwinrc,
  parseXfwmButtonLayout,
  readLinuxSystemControls,
} from "../src/linuxButtonLayout.ts";

test("GNOME button-layout gives the side, order and set of buttons", () => {
  assert.deepEqual(parseGnomeButtonLayout("'appmenu:close'\n"), { side: "right", buttons: ["close"] }, "GNOME's default is Close alone");
  assert.deepEqual(parseGnomeButtonLayout("'appmenu:minimize,maximize,close'"), { side: "right", buttons: ["minimize", "maximize", "close"] });
  assert.deepEqual(parseGnomeButtonLayout("'close,minimize,maximize:'"), { side: "left", buttons: ["close", "minimize", "maximize"] });
  assert.deepEqual(parseGnomeButtonLayout("'close:maximize'"), { side: "left", buttons: ["close"] }, "a split layout keeps the side that holds Close");
  assert.deepEqual(parseGnomeButtonLayout("'minimize:'"), { side: "left", buttons: ["minimize"] });
  assert.equal(parseGnomeButtonLayout("'appmenu:'"), null, "no caption buttons at all");
  assert.equal(parseGnomeButtonLayout("garbage"), null);
  assert.deepEqual(parseGnomeButtonLayout("':close,close,spacer'"), { side: "right", buttons: ["close"] });
});

test("KWin letters map to the same layout, with KWin's defaults when unset", () => {
  assert.deepEqual(parseKwinrc(""), { side: "right", buttons: ["minimize", "maximize", "close"] });
  assert.deepEqual(parseKwinrc("[org.kde.kdecoration2]\nButtonsOnLeft=XIA\nButtonsOnRight=\n"), { side: "left", buttons: ["close", "minimize", "maximize"] });
  assert.deepEqual(parseKwinrc("[Other]\nButtonsOnLeft=X\n[org.kde.kdecoration2]\nButtonsOnRight=X\n"), { side: "right", buttons: ["close"] });
});

test("xfwm4 letters map to the same layout", () => {
  assert.deepEqual(parseXfwmButtonLayout("O|HMC\n"), { side: "right", buttons: ["minimize", "maximize", "close"] });
  assert.deepEqual(parseXfwmButtonLayout("CMH|"), { side: "left", buttons: ["close", "maximize", "minimize"] });
  assert.equal(parseXfwmButtonLayout("HMC"), null);
});

test("KDE is read from kwinrc in the config home without running a tool", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "polyth-kwinrc-"));
  try {
    await writeFile(join(configHome, "kwinrc"), "[org.kde.kdecoration2]\nButtonsOnLeft=X\nButtonsOnRight=\n");
    assert.deepEqual(
      await readLinuxSystemControls({ XDG_CURRENT_DESKTOP: "KDE", XDG_CONFIG_HOME: configHome }),
      { side: "left", buttons: ["close"] },
    );
  } finally { await rm(configHome, { recursive: true, force: true }); }
});

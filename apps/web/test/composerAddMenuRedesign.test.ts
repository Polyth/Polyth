import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("composer Add menu shows attach tiles and labelled rows, each outcome once", async () => {
  const source = await read("../src/components/ComposerAddMenu.tsx");

  // Attach sources are tiles; every other outcome is a single labelled row.
  assert.ok(source.includes("rows.filter((row) => row.tile)"), "attach tiles come from the row model");
  assert.ok(source.includes("rows.filter((row) => !row.tile)"), "the list never repeats a tile");
  assert.ok(!source.includes("add-menu-quick"), "no duplicate quick-action strip remains");
  assert.ok(!source.includes("shortLabel"), "contributions are drawn once, as full rows");
  for (const action of ["camera", "photos", "upload"] as const) {
    assert.ok(source.includes(`case "${action}"`), `${action} is an attach source`);
  }
  assert.ok(source.includes("props.contributions"), "the host feeds the contributions in");
  for (const action of ["commands", "snippets", "shell"] as const) {
    assert.ok(source.includes(`case "${action}"`), `${action} remains available from the labelled Compose section`);
  }
  // The generic menu reaches feature packages only through contributed items,
  // never by naming one. A package it may import is one the app itself
  // declares, and the shell never declares a removable package.
  const appManifest = JSON.parse(await read("../package.json")) as { dependencies?: Record<string, string> };
  const declared = new Set(Object.keys(appManifest.dependencies ?? {}));
  const packageIds = readdirSync(new URL("../../../packages/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && existsSync(new URL(`../../../packages/${entry.name}/package.json`, import.meta.url)))
    .map((entry) => entry.name);
  assert.ok(packageIds.length > 0, "packages are discoverable");
  for (const id of packageIds) {
    if (declared.has(`@polyth/${id}`)) continue;
    assert.ok(!source.includes(`@polyth/${id}`) && !source.includes(`packages/${id}/`),
      `the generic menu never names the ${id} package`);
  }
  assert.ok(source.includes('className="add-menu-attach"'), "attach tiles have their own bounded group");
  assert.ok(source.includes('id="composer-add-attach-note"'), "one note names the _inbox destination or the shared reason");
  assert.ok(source.includes('className="add-menu-sections"'), "the complete labelled action list remains visible");
  assert.ok(source.includes('listRows.map((row) => row.kind === "group"'),
    "Add context and Compose groups still come from the capability-truth model");
  assert.ok(source.includes("row.description"), "plain-language outcomes stay visible");
  assert.ok(source.includes("row.disabledReason"), "unavailable actions keep an honest visible reason");
  assert.ok(source.includes('className="add-menu-meta"'), "sigils keep their quiet trailing metadata lane");
});

test("composer Add menu exposes advanced controls without duplicating model/thinking controls", async () => {
  const source = await read("../src/components/ComposerAddMenu.tsx");

  assert.ok(source.includes('tr("composeraddmenu.moreComposerTools")'));
  assert.ok(source.includes('openSettingsPage("harnesses")'),
    "More controls reaches the harness/tool configuration surface");
  assert.ok(!source.includes("EffortMenu"), "thinking remains owned by the model picker");
  assert.ok(!source.includes("ModelPicker"), "model selection is not duplicated inside Add");
});

test("composer Add menu styling is quiet, touch-safe and loaded after composer chrome", async () => {
  const css = await read("../src/composerAddMenu.css");
  const main = await read("../src/main.tsx");

  assert.match(css, /\.add-menu-v2 \.add-menu-tiles\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--add-menu-tiles/s,
    "attach tiles share the row equally, however many sources the device offers");
  assert.match(css, /\.add-menu-v2 \.add-menu-tile\s*\{[^}]*border:\s*0;/s,
    "tiles avoid card-within-card borders");
  assert.match(css, /\.composer-add-pop \.add-menu\.add-menu-v2\s*\{[^}]*width:\s*100%;[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s,
    "content fits the measured Popover and leaves scrolling to that viewport-bounded surface");
  assert.match(css, /\.add-menu-v2 \.add-menu-label\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
    "action labels wrap instead of being clipped by narrow or enlarged menus");
  assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*?\.add-menu-v2 \.add-menu-item \{[\s\S]*?min-height:\s*var\(--tap\);/s,
    "coarse-pointer Add rows preserve the shared minimum touch target");
  assert.match(css, /\.add-menu-v2 \.add-menu-tile\s*\{[^}]*min-height:\s*calc\(var\(--control-h\) \* 2\);/s,
    "tiles are taller than any touch target");
  assert.match(css, /\.add-menu-v2 \.add-menu-hint\s*\{[^}]*border:\s*0;/s,
    "keyboard hints are quiet text, not nested outlined pills");
  assert.ok(main.indexOf('import "./composerAddMenu.css";') > main.indexOf('import "./composerAdaptive.css";'),
    "the focused Add-menu polish loads after the general composer rules");
});

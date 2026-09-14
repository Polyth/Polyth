import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("composer Add menu keeps quick shortcuts and labelled source-of-truth rows", async () => {
  const source = await read("../src/components/ComposerAddMenu.tsx");

  for (const id of ["upload", "mention", "github", "goal"] as const) {
    assert.ok(source.includes(`{ id: "${id}"`), `${id} is available as a quick action`);
  }
  for (const action of ["commands", "snippets", "shell"] as const) {
    assert.ok(source.includes(`case "${action}"`), `${action} remains available from the labelled Compose section`);
  }
  assert.ok(source.includes('className="add-menu-quick"'), "quick actions have their own bounded group");
  assert.ok(source.includes('className="add-menu-sections"'), "the complete labelled action list remains visible");
  assert.ok(source.includes('rows.map((row) => row.kind === "group"'),
    "Add context and Compose groups still come from the capability-truth model");
  assert.ok(source.includes("row.description"), "plain-language outcomes stay visible");
  assert.ok(source.includes("row.disabledReason"), "unavailable actions keep an honest visible reason");
  assert.ok(source.includes('className="add-menu-meta"'), "counts and sigils share the quiet trailing metadata lane");
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

  assert.match(css, /\.add-menu-v2 \.add-menu-quick\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s,
    "quick actions form a compact four-column row");
  assert.match(css, /\.add-menu-v2 \.add-menu-quick-action\s*\{[^}]*border:\s*0;/s,
    "quick actions avoid card-within-card borders");
  assert.match(css, /\.composer-add-sheet \.add-menu-item\s*\{[^}]*min-height:\s*56px;/s,
    "mobile rows stay comfortably tappable");
  assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*?\.add-menu-v2 \.add-menu-quick-action,[\s\S]*?min-height:\s*var\(--tap\);/s,
    "coarse-pointer Add actions preserve the shared minimum touch target");
  assert.match(css, /\.add-menu-v2 \.add-menu-hint\s*\{[^}]*border:\s*0;/s,
    "keyboard hints are quiet text, not nested outlined pills");
  assert.ok(main.indexOf('import "./composerAddMenu.css";') > main.indexOf('import "./composerAdaptive.css";'),
    "the focused Add-menu polish loads after the general composer rules");
});

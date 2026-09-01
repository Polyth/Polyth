import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("workspace customizer composes the library, live canvas, and placement inspector", async () => {
  const [page, styles] = await Promise.all([
    read("../src/components/settings/WidgetsPage.tsx"),
    read("../src/styles.css"),
  ]);

  assert.match(page, /<WidgetLibraryPanel widgets=\{widgets\} onAdd=\{add\}/);
  assert.match(page, /<WidgetCanvas editing selectedId=\{selected\}/);
  assert.match(page, /<Inspector selectedId=\{selected\} widgets=\{widgets\}/);
  assert.match(page, /<Select label="Placement"/);
  assert.match(styles, /\.workspace-customizer-body\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /\.workspace-inspector\s*\{[^}]*display:\s*flex/s);
});

test("widget placement and settings shell typography use canonical roles", async () => {
  const styles = await read("../src/styles.css");
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const widgetPlacementSelector = /\.(?:widget-(?:placement|place|order|rail|interface|map|save|project|toolbar))/;

  for (const [, selector = "", declarations = ""] of rules) {
    if (!widgetPlacementSelector.test(selector)) continue;
    assert.doesNotMatch(
      declarations,
      /font-size:\s*[0-9](?:\.[0-9]+)?px/,
      `${selector.trim()} does not use sub-10px type`,
    );
  }

  assert.match(styles, /\.set-row-label\s*\{[^}]*font-size:\s*var\(--font-label\)/s);
  assert.match(styles, /\.set-row-hint\s*\{[^}]*font-size:\s*var\(--font-meta\)/s);
  assert.match(styles, /\.settings-pane-title\s*\{[^}]*font-size:\s*var\(--font-label\)/s);
  assert.match(styles, /\.settings-nav-group\s*\{[^}]*font-size:\s*var\(--font-meta\)/s);
});

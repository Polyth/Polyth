import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("header Canvas owns widget placement instead of a settings customizer", async () => {
  const [settings, canvas, styles] = await Promise.all([
    read("../src/components/SettingsView.tsx"),
    read("../src/widgets/WidgetCanvas.tsx"),
    read("../src/styles.css"),
  ]);

  assert.doesNotMatch(settings, /WidgetsPage|workspace-customizer|WidgetLibraryPanel/);
  assert.match(canvas, /<WidgetMenu /);
  assert.match(canvas, /data-widget-surface="workspace-canvas"/);
  assert.doesNotMatch(styles, /\.workspace-customizer-body\s*\{/);
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
  assert.match(styles, /\.settings-pane-title\s*\{[^}]*font-size:\s*var\(--font-heading\)/s);
  assert.match(styles, /\.settings-nav-group\s*\{[^}]*font-size:\s*var\(--font-meta\)/s);
});

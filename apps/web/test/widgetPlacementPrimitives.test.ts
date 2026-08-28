import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("widget placement sections, chips, and pickers use shared settings primitives", async () => {
  const [parts, page, styles] = await Promise.all([
    read("../src/components/settings/parts.tsx"),
    read("../src/components/settings/WidgetsPage.tsx"),
    read("../src/styles.css"),
  ]);

  for (const primitive of ["WidgetSectionCard", "WidgetPlacementChip", "WidgetPlacementPicker"]) {
    assert.match(parts, new RegExp(`export function ${primitive}`), `${primitive} is a shared settings primitive`);
    assert.match(page, new RegExp(`<${primitive}`), `${primitive} is used by widget settings`);
  }
  assert.match(page, /className=\{`widget-placement-item widget-order-chip/, "ordered toggles join the shared chip family");
  assert.match(styles, /\.widget-placement-item\s*\{[^}]*min-height:\s*var\(--tap\)[^}]*font-size:\s*var\(--font-label\)/s);
  assert.match(styles, /\.widget-placement-picker-label\s*\{[^}]*font-weight:\s*650/s);
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

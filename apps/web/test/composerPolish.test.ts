import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("phone composer keeps one text origin and one semantic control order", async () => {
  const css = await read("../src/composerAdaptive.css");
  assert.match(css, /padding:\s*var\(--space-3\) var\(--space-4\) 0;/,
    "placeholder, short drafts and multiline drafts share the same top-left padding");
  assert.match(css, /\.composer-mobile \.composer-execution[\s\S]*?margin-inline-start:\s*auto;/,
    "execution controls stay grouped at the trailing edge");
  assert.match(css, /\.composer-mobile \.composer-effort-inline\s*\{[^}]*order:\s*-1;/s,
    "thinking effort renders immediately before the model");
  assert.match(css, /\.composer-mobile \.model-picker-trigger \.model-trigger-logo,[\s\S]*?display:\s*none;/,
    "the composer model trigger is text-only");
  assert.match(css, /\.composer-mobile \.composer-mobile-extensions > \.placed-mini-widget:has\(\.mic-btn\)/,
    "voice is the only inline trailing extension on phone");
});

test("thinking effort is a static icon meter with an icon-only menu", async () => {
  const effort = await read("../src/components/EffortMenu.tsx");
  assert.ok(effort.includes("composer-effort-meter"));
  assert.ok(effort.includes('role="menuitemradio"'));
  assert.ok(effort.includes('aria-label={optionLabel}'), "icon choices keep accessible names");
  assert.ok(effort.includes('title={optionLabel}'), "pointer users can discover icon semantics");
  assert.ok(!effort.includes("composer-effort-tooltip"), "the old drag-tooltip UI is gone");

  const css = await read("../src/composerAdaptive.css");
  assert.match(css, /\.composer-effort-menu\s*\{[^}]*display:\s*inline-flex;/s);
  assert.match(css, /\.composer-effort-meter\.auto i\s*\{[^}]*background:\s*var\(--faint\);/s,
    "Auto is neutral and cannot read as an animated progress spinner");
});

test("phone effort is a required execution control and queue keeps the send glyph", async () => {
  const widgets = await read("../src/widgets/builtinMiniWidgets.tsx");
  assert.ok(widgets.includes('id: "composer.effort-inline"'));
  assert.ok(widgets.includes('defaultSlot: "composer.execution"'));
  assert.ok(widgets.includes("requiredVisible: true"));
  assert.ok(widgets.includes("context.executionEffortControl"));

  const icons = await read("../src/components/ui/icons.ts");
  assert.ok(icons.includes("Send as QueueIcon"), "queued follow-ups retain the familiar send glyph");

  const css = await read("../src/composerAdaptive.css");
  assert.match(css, /\.composer-simple \.composer-queue::after\s*\{[^}]*content:\s*"\+";/s,
    "queue state is a subtle badge on Send rather than a replacement glyph");
});

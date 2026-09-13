import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("phone composer keeps one text origin and one semantic control order", async () => {
  const css = await read("../src/composerAdaptive.css");
  assert.match(css, /padding:\s*var\(--space-3\) var\(--space-4\) var\(--space-1\);/,
    "placeholder, short drafts and multiline drafts share the same top-left padding");
  assert.match(css, /\.composer-mobile \.composer-leading-zone,[\s\S]*?display:\s*contents;/,
    "the leading wrapper cannot lock Add and Voice into the wrong visual group");
  assert.match(css, /\.composer-mobile \.composer-add\s*\{[^}]*order:\s*1;/s,
    "Add stays at the far left");
  assert.match(css, /\.composer-mobile \.composer-execution[\s\S]*?order:\s*2;[\s\S]*?margin-inline-start:\s*auto;/,
    "thinking and model start the right-aligned execution group");
  assert.match(css, /\.composer-mobile \.composer-mobile-extensions\s*\{[^}]*order:\s*3;/s,
    "voice follows the execution group");
  assert.match(css, /\.composer-mobile \.composer-actions,[\s\S]*?order:\s*4;/,
    "the primary action remains the final rail group");
  assert.match(css, /\.composer-mobile \.composer-effort-inline\s*\{[^}]*order:\s*-1;/s,
    "thinking effort renders immediately before the model");
  assert.match(css, /\.composer-mobile \.model-picker-trigger \.model-trigger-logo,[\s\S]*?display:\s*none;/,
    "the composer model trigger is text-only");
});

test("phone composer never reserves empty widget slots or leaks desktop actions", async () => {
  const css = await read("../src/composerAdaptive.css");
  assert.match(css, /\.composer-mobile \.composer-mobile-extensions\s*\{[^}]*display:\s*none;[^}]*width:\s*0;/s,
    "an empty leading extension host consumes no horizontal space");
  assert.match(css, /\.composer-mobile \.composer-mobile-extensions:has\(\.mic-btn\)\s*\{[^}]*display:\s*inline-flex;/s,
    "only the microphone makes the leading extension lane visible");
  assert.match(css, /\.composer-mobile \.composer-actions > \.composer-extensions\s*\{[^}]*display:\s*none;[^}]*width:\s*0;/s,
    "desktop trailing widgets do not reflow the phone composer");
  assert.match(css, /\.composer-mobile \.composer-actions > \.composer-extensions:has\(\.mic-btn\)/,
    "a user-moved microphone remains supported without exposing other widgets");
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

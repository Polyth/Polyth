import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { composerLayoutState } from "../src/composerLayout.ts";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("send glyph inherits the contrasting theme ink instead of forcing white", async () => {
  const css = await read("../src/styles.css");
  const plane = css.match(/\.send-plane\s*\{([^}]*)\}/)?.[1];
  assert.ok(plane, "the send glyph wrapper is styled");
  assert.doesNotMatch(plane, /(?:^|;)\s*color\s*:/,
    "the glyph inherits the button ink in both dark and light themes");
  assert.match(css, /\.composer-simple \.composer-rail \.send\s*\{[^}]*color:\s*var\(--accent-ink\);/s);
});

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
  assert.doesNotMatch(css, /\.composer-mobile \.composer-actions > \.composer-extensions:has\(\.mic-btn\)/,
    "the microphone cannot be moved into the trailing action lane");
  assert.match(css, /\.composer-simple \.composer-primary \.send\s*\{[^}]*display:\s*inline-flex;/s,
    "Send remains visible as the terminal action even with an empty draft");
});

test("the primary action is terminal and draft engagement survives blur", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const voice = await read("../../../packages/dictation/widgets/voice.tsx");
  const primary = composer.indexOf('<span className="composer-primary">');
  const trailingCustomize = composer.indexOf('<CustomizeZoneButton slot="composer.trailing" />');
  assert.ok(primary > trailingCustomize, "the primary action follows trailing customization controls");
  const queue = composer.indexOf('className="send composer-delivery composer-queue"');
  const menu = composer.indexOf('className="composer-send-options"');
  assert.ok(queue > menu, "the queue/send action follows active-run alternatives");
  assert.match(composer.slice(primary), /className="send"/, "idle compositions retain Send");
  assert.equal(
    composerLayoutState({ phoneLayout: true, inputFocused: false, shellMode: false, hasDraft: true }),
    "phone-engaged",
    "a typed draft stays engaged after the input blurs",
  );
  assert.equal(
    composerLayoutState({ phoneLayout: true, inputFocused: false, shellMode: false, hasDraft: false }),
    "phone-resting",
    "an idle or working phone composer uses the compact resting row",
  );
  assert.equal(
    composerLayoutState({ phoneLayout: false, inputFocused: false, shellMode: false, hasDraft: false }),
    "desktop",
    "desktop keeps its existing non-phone layout",
  );
  assert.doesNotMatch(voice, /supportedSlots:\s*\[[\s\S]*?"composer\.trailing"/,
    "voice cannot be placed after the primary action");
});

test("thinking effort lives in the model picker", async () => {
  const picker = await read("../../../packages/models/widgets/ModelPicker.tsx");
  const composer = await read("../src/components/Composer.tsx");
  const css = await read("../../../packages/models/widgets/styles.css");
  assert.ok(picker.includes("const variantMenu"));
  assert.ok(picker.includes('label={tr("composer.thinking")}'));
  assert.ok(picker.includes('variant: variant ?? ""'));
  assert.match(css, /\.model-thinking-trigger\s*\{/);
  assert.ok(!composer.includes("EffortMenu"));
  assert.ok(composer.includes("thinking={pickerThinking}"), "a controlled thinking choice is projected back into the picker");
  assert.ok(
    composer.includes("cfg.thinking !== undefined ? cfg.thinking : savedThinking"),
    "inherited defaults remain distinct from explicit and saved choices",
  );
});

test("model picker owns effort and queue keeps the send glyph", async () => {
  const widgets = await read("../src/widgets/builtinMiniWidgets.tsx");
  assert.ok(!widgets.includes("composer.effort"));

  const icons = await read("../src/components/ui/icons.ts");
  assert.ok(icons.includes("Send as QueueIcon"), "queued follow-ups retain the familiar send glyph");

  const css = await read("../src/composerAdaptive.css");
  assert.match(css, /\.composer-simple \.composer-queue::after\s*\{[^}]*content:\s*"\+";/s,
    "queue state is a subtle badge on Send rather than a replacement glyph");
});

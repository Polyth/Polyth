import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { composerLayoutState } from "../src/composerLayout.ts";
import { readWebStyles } from "./webStyles.ts";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("adaptive composer polish loads after the shared style layers", async () => {
  const main = await read("../src/main.tsx");
  const core = main.indexOf('import "./styles.css"');
  const moduleContent = main.indexOf('import "./moduleContent.css"');
  const adaptive = main.indexOf('import "./composerAdaptive.css"');

  assert.ok(core >= 0 && moduleContent > core && adaptive > moduleContent,
    "adaptive composer rules are the final shell-level style layer");
});

test("composer attachments live outside the writing surface", async () => {
  const css = await read("../src/composerAdaptive.css");
  const composer = await read("../src/components/Composer.tsx");
  const pills = await read("../src/components/AttachmentPills.tsx");

  assert.match(composer, /\{!session && attachmentStrip\}[\s\S]*?<SessionContextBar/);
  assert.match(composer, /<QueuedMessageList[\s\S]*?\{session && attachmentStrip\}[\s\S]*?<GlassDock/);
  assert.match(css, /\.composer-simple > \.attachment-pills\s*\{/);
  assert.match(css, /flex-wrap:\s*nowrap;/);
  assert.match(css, /overflow-x:\s*auto;/);
  assert.match(pills, /imagePreview \? <img className="att-thumb"/, "a previewable image is a bare tile");
});

test("attachment remove controls sit inside their own card", async () => {
  // The strip scrolls sideways, so overflow clips both axes: a remove badge
  // hung off the card's corner (negative inset) was cropped in half.
  const css = await read("../src/styles.css");
  const pills = await read("../src/components/AttachmentPills.tsx");
  const base = css.slice(css.indexOf("/* Attachment cards"), css.indexOf(".task-activity {"));
  assert.ok(base.length > 0, "the attachment card rules exist");
  assert.doesNotMatch(base, /inset-(?:block|inline)-(?:start|end):\s*calc\([^)]*\* -1\)/);
  assert.doesNotMatch(base, /inset-(?:block|inline)-(?:start|end):\s*-/);
  assert.match(base, /\.attachment-pill:has\(\.att-remove\) \{ padding-inline-end: var\(--att-remove\); \}/,
    "a removable card reserves room for its control");
  assert.match(pills, /className="att-remove-glyph"/);
  assert.match(pills, /attachmentpills\.pastedText/, "a large text paste reads as Pasted text, not its upload file name");
});

test("the configuration row sits above the editor and reuses the quiet chip", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const css = await read("../src/composerAdaptive.css");

  const row = composer.indexOf('className="composer-config composer-config-row"');
  const editor = composer.indexOf('<div className="composer-input">');
  assert.ok(row > -1 && row < editor, "the model/effort row is rendered above the editor");
  assert.match(
    css,
    /\.composer-simple \.composer-config-row \{[^}]*gap:\s*var\(--space-2\);[^}]*padding:\s*var\(--space-2\) var\(--space-4\) 0;/s,
    "the model and thinking effort sit side-by-side at the start of the configuration row",
  );
  assert.match(
    css,
    /\.composer-simple \.composer-config-row \.model-picker-trigger \{[^}]*padding-inline-start:\s*0;/s,
    "the model picker logo starts at the same inline level as the rail add glyph",
  );
  assert.doesNotMatch(
    css.slice(css.indexOf(".composer-simple .composer-config-row"), css.indexOf("/* Quiet secondary controls")),
    /margin-inline-start:\s*auto/,
    "effort sits right next to the model picker rather than at the trailing edge",
  );
  // The row is layout only: model and effort keep the shared quiet chip, so
  // no colour, radius or type literal is introduced for it.
  assert.doesNotMatch(
    css.slice(css.indexOf(".composer-simple .composer-config-row"), css.indexOf("/* Quiet secondary controls")),
    /(?:color|background|border-radius|font-size|box-shadow):/,
  );
});

test("running send and contributed composer actions stay compact and borderless", async () => {
  const css = await read("../src/composerAdaptive.css");

  assert.match(css, /\.composer-simple \.composer-running-send \.composer-action-label\s*\{\s*display:\s*none;/);
  assert.match(
    css,
    /\.composer-mobile\.composer-collapsed \.composer-mobile-extensions\s*\{[^}]*max-width:\s*var\(--tap\);[^}]*\}/s,
    "the resting leading lane is one full tap box, so the input method is never squeezed below a touch target",
  );
  assert.match(
    css,
    /\.composer-mobile\.composer-collapsed \.composer-actions > \.composer-extensions\s*\{\s*display:\s*none;\s*\}/s,
    "the resting row carries no contributed trailing control beside Send",
  );
  assert.match(css, /\.composer-mobile \.composer-send-split > \.composer-running-send[\s\S]*?width:\s*var\(--tap\)/);
  assert.match(css, /\.composer-simple \.composer-rail \.send,[\s\S]*?border:\s*0;/);
});

test("expanded phone composer uses one compact spacing and control rhythm", async () => {
  const css = await read("../src/composerAdaptive.css");

  assert.match(
    css,
    /\.composer-mobile \.composer-card textarea\b[\s\S]*?min-height:\s*var\(--control-h-sm\);[\s\S]*?padding:\s*var\(--space-3\) var\(--space-4\) var\(--space-1\);/s,
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-rail\s*\{\s*--composer-rail-gap:\s*7px;[^}]*min-height:\s*var\(--tap\);[^}]*gap:\s*var\(--composer-rail-gap\);[^}]*padding:\s*0 var\(--space-4\) var\(--space-2\);/s,
    "the engaged rail keeps one 7px rhythm across Add, the contributed controls and the trailing block",
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-mobile-extensions \.mic-btn\b[\s\S]*?width:\s*var\(--tap\);[\s\S]*?min-height:\s*var\(--tap\);/s,
    "the microphone occupies the same mobile layout box as the primary action",
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-execution \.model-picker-trigger\s*\{[^}]*max-width:\s*32vw;[^}]*height:\s*var\(--tap\);/s,
    "the model control should align to the action row and yield width before overflowing",
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-actions > \.composer-extensions\s*\{[^}]*display:\s*inline-flex;[^}]*min-width:\s*0;[^}]*overflow-x:\s*auto;/s,
    "the trailing lane keeps the desktop action set and stays internally scrollable",
  );
  assert.match(
    css,
    /\.composer-mobile\.composer-expanded \.composer-mobile-extensions,[\s\S]*?\.composer-mobile\.composer-expanded \.composer-actions > \.composer-extensions\s*\{\s*max-width:\s*none;\s*\}/s,
    "an engaged lane shows every contributed control instead of clipping a capped box",
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-actions \{[^}]*margin-inline-start:\s*auto;/s,
    "the trailing block owns the end of the rail, so the free space collects once instead of between every group",
  );
  assert.doesNotMatch(
    css,
    /\.composer-mobile \.composer-rail\b[^}]*justify-content:\s*space-between/s,
    "the rail cannot distribute the free space between its groups: that produced three gap sizes in one row",
  );
  assert.match(
    css,
    /\.composer-mobile\.composer-collapsed \.composer-card textarea\s*\{[\s\S]*?padding-block:\s*max\(0px, calc\(\(var\(--composer-height\) - var\(--font-response-lh\)\) \/ 2\)\);[\s\S]*?line-height:\s*var\(--font-response-lh\);/s,
    "the resting placeholder is centered inside the compact composer control",
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-config-row > \.picker-model\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*0;/s,
    "the mobile model picker sizes to its own name instead of forcing the effort chip into the far corner",
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-config-row \.model-picker-trigger\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;/s,
    "the model trigger uses the width granted by its row",
  );
});

test("the runtime cascade leaves the compact resting row to its canonical rules", async () => {
  const adaptive = await read("../src/composerAdaptive.css");
  const effective = await readWebStyles();
  const mobileLayer = adaptive.slice(
    adaptive.indexOf("/* Mobile"),
    adaptive.indexOf("/* Tight phones"),
  );

  assert.match(mobileLayer, /composer-mobile\.composer-collapsed \.composer-card textarea/);
  assert.ok(
    effective.indexOf("/* Adaptive composer polish")
      > effective.indexOf("UX-MOBILE-01 — mobile-first new chat"),
    "tests include the adaptive shell layer after core mobile rules",
  );
});

test("every phone state routes through one canonical layout helper", async () => {
  // Composition decisions live in one place: any new state must be added
  // there, not re-derived ad hoc in the component.
  assert.equal(
    composerLayoutState({ phoneLayout: true, inputFocused: true, shellMode: false, hasDraft: false }),
    "phone-engaged",
  );
  assert.equal(
    composerLayoutState({ phoneLayout: true, inputFocused: false, shellMode: true, hasDraft: false }),
    "phone-engaged",
  );
  assert.equal(
    composerLayoutState({ phoneLayout: true, inputFocused: false, shellMode: false, hasDraft: true }),
    "phone-engaged",
  );
  assert.equal(
    composerLayoutState({ phoneLayout: true, inputFocused: false, shellMode: false, hasDraft: false }),
    "phone-resting",
  );
  const composer = await read("../src/components/Composer.tsx");
  assert.ok(
    composer.includes("const layoutState = composerLayoutState("),
    "the component no longer re-derives its own phone layout branches",
  );
  assert.doesNotMatch(
    composer,
    /phoneLayout\s*&&\s*\(.*(expanded|collapsed)/i,
    "no parallel expanded/collapsed derivation may bypass the helper",
  );
});

test("desktop keeps extension actions bounded and primary action terminal", async () => {
  const css = await read("../src/composerAdaptive.css");
  const composer = await read("../src/components/Composer.tsx");

  assert.match(css, /\.composer-simple \.composer-actions > \.composer-extensions\s*\{[\s\S]*?max-width:\s*min\(30vw, 260px\)/);
  assert.match(css, /\.composer-simple \.composer-config\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(css, /\.composer-simple \.composer-config\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  assert.ok(
    composer.indexOf('<CustomizeZoneButton slot="composer.trailing" />')
      < composer.indexOf('<span className="composer-primary">'),
    "desktop customization stays before the terminal primary action",
  );
});

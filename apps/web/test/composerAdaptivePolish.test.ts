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
  assert.match(pills, /!imagePreview && <span className="att-name"/);
});

test("queue and contributed composer actions stay compact and borderless", async () => {
  const css = await read("../src/composerAdaptive.css");

  assert.match(css, /\.composer-simple \.composer-queue \.composer-action-label\s*\{\s*display:\s*none;/);
  assert.match(css, /\.composer-mobile \.composer-mobile-extensions\s*\{[\s\S]*?max-width:\s*var\(--tap\)/);
  assert.match(css, /\.composer-mobile \.composer-send-split \.composer-queue,[\s\S]*?width:\s*var\(--tap\)/);
  assert.match(css, /\.composer-simple \.composer-rail \.send,[\s\S]*?border:\s*0;/);
});

test("expanded phone composer uses one compact spacing and control rhythm", async () => {
  const css = await read("../src/composerAdaptive.css");

  assert.match(
    css,
    /\.composer-mobile \.composer-card textarea,[\s\S]*?min-height:\s*var\(--control-h-sm\);[\s\S]*?padding:\s*var\(--space-3\) var\(--space-4\) var\(--space-1\);/s,
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-rail,[\s\S]*?min-height:\s*var\(--tap\);[\s\S]*?gap:\s*calc\(var\(--space-1\) \/ 2\);[\s\S]*?padding:\s*0 var\(--space-4\) var\(--space-2\);/s,
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-mobile-extensions \.mic-btn,[\s\S]*?width:\s*var\(--tap\);[\s\S]*?min-height:\s*var\(--tap\);/s,
    "the microphone occupies the same mobile layout box as the primary action",
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-execution \.model-picker-trigger\s*\{[^}]*max-width:\s*32vw;[^}]*height:\s*var\(--tap\);/s,
    "the model control should align to the action row and yield width before overflowing",
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-actions > \.composer-extensions\s*\{[^}]*display:\s*none;[^}]*width:\s*0;/s,
    "trailing widgets stay out of the phone primary row",
  );
});

test("the runtime cascade leaves the compact resting row to its canonical rules", async () => {
  const adaptive = await read("../src/composerAdaptive.css");
  const effective = await readWebStyles();
  const mobileLayer = adaptive.slice(
    adaptive.indexOf("/* Mobile"),
    adaptive.indexOf("/* Tight phones"),
  );

  assert.doesNotMatch(mobileLayer, /composer-mobile\.composer-collapsed\s+\.composer-card/);
  assert.doesNotMatch(mobileLayer, /composer-mobile\.composer-collapsed\s+\.composer-card textarea/);
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("adaptive composer polish loads after the shared style layers", async () => {
  const main = await read("../src/main.tsx");
  const core = main.indexOf('import "./styles.css"');
  const moduleContent = main.indexOf('import "./moduleContent.css"');
  const adaptive = main.indexOf('import "./composerAdaptive.css"');

  assert.ok(core >= 0 && moduleContent > core && adaptive > moduleContent,
    "adaptive composer rules are the final shell-level style layer");
});

test("composer attachments live in a reserved strip above the writing surface", async () => {
  const css = await read("../src/composerAdaptive.css");

  assert.ok(css.includes(".composer-simple .composer-card:has(> .attachment-pills)"));
  assert.match(css, /margin-block-start:\s*calc\(var\(--control-h-sm\) \+ var\(--space-2\)\)/);
  assert.match(css, /\.composer-simple \.composer-card > \.attachment-pills\s*\{[\s\S]*?position:\s*absolute;/);
  assert.match(css, /inset-block-end:\s*calc\(100% \+ var\(--space-2\)\)/);
  assert.match(css, /flex-wrap:\s*nowrap;/);
  assert.match(css, /overflow-x:\s*auto;/);
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
    /\.composer-mobile\.composer-expanded \.composer-card textarea\s*\{[^}]*min-height:\s*calc\(var\(--control-h-lg\) \+ var\(--space-3\)\);[^}]*padding:\s*var\(--space-2\) var\(--space-3\) var\(--space-1\);/s,
  );
  assert.match(
    css,
    /\.composer-mobile\.composer-expanded \.composer-rail\s*\{[^}]*min-height:\s*calc\(var\(--tap\) \+ var\(--space-3\)\);[^}]*gap:\s*var\(--space-1\);[^}]*padding:\s*var\(--space-1\) var\(--space-2\) var\(--space-2\);/s,
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-extensions \.ui-icon-btn\s*\{[^}]*width:\s*var\(--tap\);[^}]*min-width:\s*var\(--tap\);[^}]*height:\s*var\(--tap\);[^}]*min-height:\s*var\(--tap\);/s,
    "contributed icon controls should occupy the same mobile layout box as built-in actions",
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-execution \.model-picker-trigger\s*\{[^}]*height:\s*var\(--tap\);[^}]*max-width:\s*100%;/s,
    "the model control should align to the action row and yield width before overflowing",
  );
  assert.match(
    css,
    /@media \(max-width: 340px\)[\s\S]*?\.composer-mobile \.composer-actions > \.composer-extensions\s*\{[^}]*width:\s*var\(--tap\);[^}]*flex:\s*0 0 var\(--tap\);[^}]*overflow-x:\s*auto;/s,
    "the narrowest phone should give extra trailing actions one scrollable touch-width lane",
  );
});

test("desktop keeps extension actions bounded and model next to send", async () => {
  const css = await read("../src/composerAdaptive.css");

  assert.match(css, /\.composer-simple \.composer-actions > \.composer-extensions\s*\{[\s\S]*?max-width:\s*min\(30vw, 260px\)/);
  assert.match(css, /\.composer-simple \.composer-config\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(css, /\.composer-simple \.composer-config \+ \.composer-primary\s*\{\s*margin-inline-start:\s*2px;/);
});

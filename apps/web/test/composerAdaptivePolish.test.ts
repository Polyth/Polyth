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

test("desktop keeps extension actions bounded and model next to send", async () => {
  const css = await read("../src/composerAdaptive.css");

  assert.match(css, /\.composer-simple \.composer-actions > \.composer-extensions\s*\{[\s\S]*?max-width:\s*min\(30vw, 260px\)/);
  assert.match(css, /\.composer-simple \.composer-config\s*\{[\s\S]*?flex:\s*0 0 auto;/);
  assert.match(css, /\.composer-simple \.composer-config \+ \.composer-primary\s*\{\s*margin-inline-start:\s*2px;/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("phone modules use navigation chrome instead of desktop window controls", async () => {
  const moduleView = await read("../src/components/ui/ModuleView.ts");

  assert.match(moduleView, /const phone = shellMode === "phone"/);
  assert.match(moduleView, /phone \? BackIcon : CloseIcon/);
  assert.match(moduleView, /phone \? tr\("common\.back"\)/);
  assert.match(moduleView, /!phone && dockActions/);
  assert.match(moduleView, /!phone && onTogglePin/);
  assert.match(moduleView, /!phone && onToggleFullscreen/);
  assert.match(moduleView, /module-view--phone/);
});

test("phone modules share glass chrome, touch targets, safe spacing and overflow rules", async () => {
  const css = await read("../src/moduleContent.css");

  assert.match(css, /\.module-view--phone \.module-view-head\s*\{/);
  assert.match(css, /background:\s*var\(--material-glass-chrome\)/);
  assert.match(css, /min-height:\s*calc\(var\(--tap\) \+ var\(--space-2\)\)/);
  assert.match(css, /\.module-view--phone \.module-view-back\s*\{/);
  assert.match(css, /width:\s*var\(--tap\)/);
  assert.match(css, /font-size:\s*max\(16px, var\(--font-input\)\)/);
  assert.match(css, /overscroll-behavior:\s*contain/);
  assert.match(css, /--module-content-inline:\s*var\(--screen-gutter\)/);
});

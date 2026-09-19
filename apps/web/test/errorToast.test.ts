import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

test("the transient error toast keeps its right-edge anchor and enter/exit motion", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.error-banner\s*\{[^}]*position:\s*fixed;[^}]*inset-inline-end:\s*calc\(var\(--safe-right\) - var\(--space-1\)\);[^}]*bottom:\s*max\(var\(--space-3\), var\(--safe-bottom\)\);[^}]*z-index:\s*var\(--z-toast\)/s);
  assert.match(css, /@keyframes error-banner-slide\s*\{[^}]*from\s*\{\s*opacity:\s*0;\s*transform:\s*translateX\(100%\)/s);
  assert.match(css, /@keyframes error-banner-slide\s*\{[\s\S]*?to\s*\{\s*opacity:\s*0;\s*transform:\s*translateX\(100%\);\s*\}/);
  assert.match(css, /html\[dir="rtl"\] \.error-banner\s*\{\s*animation-name:\s*error-banner-slide-rtl;/);
  assert.match(css, /\.error-banner\s*\{[^}]*animation:\s*error-banner-slide 7s var\(--motion-ease\) both/s);
});

test("the toast right edge is intentionally hidden past the viewport", () => {
  const css = read("../src/styles.css");
  const block = css.slice(css.indexOf(".error-banner {"), css.indexOf("}", css.indexOf(".error-banner {")));

  assert.match(block, /border-inline-end:\s*0;/);
  assert.match(block, /border-start-end-radius:\s*0;/);
  assert.match(block, /border-end-end-radius:\s*0;/);
  assert.doesNotMatch(block, /border-radius:\s*var\(--radius-surface\);\s*border-start-end-radius:\s*var/);
});

test("the toast is a close / content / contextual-glyph row", () => {
  const app = read("../src/App.tsx");
  const notice = read("../src/components/ui/Notice.tsx");
  const css = read("../src/styles.css");

  assert.match(app, /presentUiError\(message\)/);
  assert.match(app, /data-category=\{view\.category\}/);
  assert.match(app, /className="error-banner-close"/);
  assert.match(app, /iconPosition="trailing"/);
  assert.match(app, /error-banner-glyph/);
  assert.match(app, /heading=\{view\.title \|\| undefined\}/);
  assert.doesNotMatch(app, /actions=\{<>/);

  // The shared primitive gains optional leading/icon slots without moving the
  // default tone glyph for every other Notice consumer.
  assert.match(notice, /leading\?:\s*ReactNode/);
  assert.match(notice, /iconPosition\?:\s*"leading" \| "trailing"/);
  assert.match(notice, /\{leading\}/);
  assert.match(notice, /\{iconPosition === "leading" && glyph\}/);
  assert.match(notice, /\{iconPosition === "trailing" && glyph\}/);

  // The old order:-1 hack that pushed the close control left is gone.
  assert.doesNotMatch(css, /\.error-banner \.ui-notice-actions\s*\{[^}]*order:\s*-1/s);
});

test("the toast follows the shared lifetime with a secondary progress hairline", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.error-banner::after\s*\{[^}]*content:\s*"";[^}]*position:\s*absolute;[^}]*bottom:\s*0;[^}]*height:\s*2px;[^}]*animation:\s*error-banner-lifetime 7s linear both/s);
  assert.match(css, /@keyframes error-banner-lifetime\s*\{[\s\S]*?from\s*\{\s*transform:\s*scaleX\(1\);\s*\}[\s\S]*?to\s*\{\s*transform:\s*scaleX\(0\);/s);
  assert.match(css, /html\[dir="rtl"\] \.error-banner::after\s*\{\s*transform-origin:\s*right center;/);
});

test("toast typography keeps a dominant title over a muted clamped detail", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.error-banner \.ui-notice-heading\s*\{[^}]*color:\s*var\(--text\);[^}]*font-size:\s*var\(--font-label\);[^}]*font-weight:\s*650;[^}]*-webkit-line-clamp:\s*1;/s);
  assert.match(css, /\.error-banner \.error-banner-detail\s*\{[^}]*-webkit-line-clamp:\s*2;/s);
  assert.match(css, /\.error-banner \.ui-notice-body\s*\{[^}]*color:\s*var\(--muted\);[^}]*font-size:\s*var\(--font-meta\)/s);
});

test("the contextual glyph carries the semantic error tint", () => {
  const css = read("../src/styles.css");
  const icons = read("../src/components/ui/icons.ts");

  assert.match(css, /\.error-banner \.error-banner-glyph\s*\{[^}]*color:\s*var\(--notice-tone\);[^}]*background:\s*color-mix\(in srgb, var\(--notice-tone\)/s);
  for (const icon of ["OfflineIcon", "StorageIcon", "ServerErrorIcon", "BlockedIcon"]) {
    assert.match(icons, new RegExp(`${icon},`), `${icon} must be exported for the toast`);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  inlineIconifySvgDataUrl,
  isSafePersistedProjectIcon,
} from "../src/projectIconPicker.ts";
import {
  isProjectIconRasterDataUrl,
  isProjectIconSvgDataUrl,
  projectIconMaskStyle,
} from "../src/projectIconGlyph.ts";

test("svg data urls use css mask styling, not img fallback", () => {
  const stored = inlineIconifySvgDataUrl(
    "ph:house",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h1v1H0z"/></svg>',
    "#b4532a",
  );
  assert.equal(isSafePersistedProjectIcon(stored), true);
  assert.equal(isProjectIconSvgDataUrl(stored), true);
  assert.ok(projectIconMaskStyle(stored));
  assert.equal(isProjectIconRasterDataUrl(stored), false);
});

test("png data urls stay raster icons", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(isProjectIconRasterDataUrl(png), true);
  assert.equal(projectIconMaskStyle(png), null);
});

test("shared ProjectGlyph renders svg masks instead of folder placeholders", async () => {
  const tsx = await readFile(new URL("../src/components/ProjectGlyph.tsx", import.meta.url), "utf8");
  const sidebar = await readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  assert.match(tsx, /project-glyph-mask/);
  assert.match(tsx, /ProjectIconBody/);
  assert.match(tsx, /isProjectIconSvgDataUrl\(icon\)[\s\S]*ProjectIconBody/);
  assert.match(tsx, /isProjectIconRasterDataUrl\(icon\)[\s\S]*<img src=\{icon\}/);
  assert.doesNotMatch(sidebar, /function ProjectGlyph/);
  assert.match(sidebar, /from "\.\/ProjectGlyph\.tsx"/);
});

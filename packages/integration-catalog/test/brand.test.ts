import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BRAND_MARKS, brandMarkFor } from "../src/brand.ts";
import { CATALOG_DIR, loadCatalog } from "../src/entries.ts";

const LOGO_DIR = fileURLToPath(new URL("../assets/logos/", import.meta.url));

test("every entry has a brand mark, and the mark file is in the package", async () => {
  const { entries } = await loadCatalog(CATALOG_DIR);
  assert.ok(entries.length > 0);
  const missing: string[] = [];
  for (const entry of entries) {
    const mark = brandMarkFor(entry.id);
    if (!mark) {
      missing.push(`${entry.id}: no mark in src/brand.ts`);
      continue;
    }
    try {
      const bytes = await readFile(`${LOGO_DIR}${mark.file}`);
      assert.ok(bytes.byteLength > 200, `${mark.file} looks empty`);
      if (mark.format === "svg") {
        assert.match(bytes.toString("utf8"), /^<svg[\s>]/, `${mark.file} is not an SVG`);
        assert.match(bytes.toString("utf8"), /viewBox="[^"]+"/, `${mark.file} cannot scale`);
      } else {
        assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${mark.file} is not a PNG`);
      }
    } catch (cause) {
      missing.push(`${entry.id}: ${(cause as Error).message}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the registry names no entry the catalog does not ship", async () => {
  const { entries } = await loadCatalog(CATALOG_DIR);
  const ids = new Set(entries.map((entry) => entry.id));
  assert.deepEqual(Object.keys(BRAND_MARKS).filter((id) => !ids.has(id)), []);
});

test("a mark is a brand colour and a file name, never a URL", () => {
  for (const [id, mark] of Object.entries(BRAND_MARKS)) {
    assert.match(mark.color, /^#[0-9A-F]{6}$/i, `${id} colour`);
    assert.match(mark.file, /^[a-z0-9-]+\.(svg|png)$/, `${id} file`);
    assert.ok(!mark.file.includes("/"), `${id} file must stay inside assets/logos`);
  }
});

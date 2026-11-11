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

test("a mark is a file name inside the package, never a URL", () => {
  for (const [id, mark] of Object.entries(BRAND_MARKS)) {
    assert.match(mark.file, /^[a-z0-9-]+\.(svg|png)$/, `${id} file`);
    assert.equal(mark.file.slice(-3), mark.format, `${id} format`);
    assert.ok(mark.source === "simple-icons" || mark.source === "vendor", `${id} source`);
  }
});

test("every vector mark is a plain drawing", async () => {
  // The route refuses an SVG with script or external references; the build
  // script refuses them too. This keeps both honest.
  for (const mark of Object.values(BRAND_MARKS)) {
    if (mark.format !== "svg") continue;
    const text = await readFile(`${LOGO_DIR}${mark.file}`, "utf8");
    assert.doesNotMatch(text, /<script|<foreignObject|\son[a-z]+\s*=|<iframe|<image|href\s*=\s*["']?(?:https?:|data:|javascript:)/i, mark.file);
  }
});

test("every mark has a reviewed source", async () => {
  const sources = JSON.parse(await readFile(`${LOGO_DIR}sources.json`, "utf8")) as Record<string, Record<string, string>>;
  for (const id of Object.keys(BRAND_MARKS)) {
    const source = sources[id];
    assert.ok(source, `${id} is missing from sources.json`);
    const keys = Object.keys(source).filter((key) => ["simpleIcons", "url", "same"].includes(key));
    assert.equal(keys.length, 1, `${id} names exactly one source`);
    if (source.url) assert.match(source.url, /^https:\/\//, `${id} source is https`);
  }
});

test("a raster mark is a tile big enough to stay sharp", async () => {
  for (const mark of Object.values(BRAND_MARKS)) {
    if (mark.format !== "png") continue;
    const bytes = await readFile(`${LOGO_DIR}${mark.file}`);
    // IHDR width and height, big-endian, right after the signature.
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    assert.equal(width, height, `${mark.file} is square`);
    assert.ok(width >= 96, `${mark.file} is ${width}px`);
  }
});

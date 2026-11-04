// An uploaded wallpaper that the browser would refuse to paint is re-encoded on
// the way in; a smaller one is kept exactly as chosen.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  FileReader: dom.FileReader,
  getComputedStyle: dom.getComputedStyle.bind(dom),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

const { shrinkImage, shrinkToBudget } = await import("../src/imageShrink.ts");
const { MAX_PAINTABLE_IMAGE_CHARS, MAX_CUSTOM_BACKGROUND_BYTES, readBackgroundFile } = await import("../src/backgrounds.ts");

const LADDER = { edges: [1600, 1280, 1024], qualities: [0.72, 0.5] };

/** A file whose data URL comes to about `bytes * 4 / 3` characters. */
function imageFile(bytes: number, type = "image/jpeg"): File {
  return new dom.File([new Uint8Array(bytes)], "wallpaper.jpg", { type }) as unknown as File;
}

test("the budget takes the sharpest encoding that fits, and gives up rather than exceed it", async () => {
  const tried: string[] = [];
  const fits = await shrinkToBudget(4000, async (edge, quality) => {
    tried.push(`${edge}@${quality}`);
    return { size: edge === 1024 && quality === 0.5 ? 100 : 1000 };
  }, 500, LADDER);
  assert.equal(fits?.size, 100);
  assert.deepEqual(tried, ["1600@0.72", "1600@0.5", "1280@0.72", "1280@0.5", "1024@0.72", "1024@0.5"]);

  assert.equal(await shrinkToBudget(4000, async () => ({ size: 1000 }), 500, LADDER), null);
  assert.equal(await shrinkToBudget(4000, async () => null, 500, LADDER), null, "an encoder that returns nothing is not a fit");
});

test("an image is never scaled up", async () => {
  const edges: number[] = [];
  await shrinkToBudget(1200, async (edge) => { edges.push(edge); return { size: 1000 }; }, 500, LADDER);
  assert.deepEqual([...new Set(edges)], [1200, 1024]);
});

test("an image that already fits stays exactly as it is", async () => {
  const image = "data:image/png;base64,AAAA";
  assert.equal(await shrinkImage(image, image.length, LADDER), image);
});

test("the paintable limit stays under what Chromium refuses, and below the upload limit's data URL", () => {
  assert.ok(MAX_PAINTABLE_IMAGE_CHARS < 2 * 1024 * 1024);
  assert.ok(MAX_PAINTABLE_IMAGE_CHARS < MAX_CUSTOM_BACKGROUND_BYTES * 4 / 3, "or uploads would never need it");
});

test("a file the page can paint is handed over as it was read", async () => {
  const seen: number[] = [];
  const result = await readBackgroundFile(imageFile(1000), async (image, maxChars) => {
    seen.push(maxChars);
    return image;
  });
  assert.match(result, /^data:image\/jpeg;base64,/);
  assert.deepEqual(seen, [MAX_PAINTABLE_IMAGE_CHARS]);
});

test("a file too large to paint comes back re-encoded", async () => {
  const reduced = "data:image/jpeg;base64,REDUCED";
  const result = await readBackgroundFile(imageFile(1_800_000), async (image, maxChars) => {
    assert.ok(image.length > maxChars, "this file is over the paintable limit");
    return reduced;
  });
  assert.equal(result, reduced);
});

test("an upload that cannot be made paintable says so instead of leaving the old wallpaper up", async () => {
  await assert.rejects(readBackgroundFile(imageFile(1_800_000), async () => null));
  await assert.rejects(readBackgroundFile(imageFile(1_800_000), async () => { throw new Error("not an image"); }));
  await assert.rejects(
    readBackgroundFile(imageFile(1_800_000), async () => `data:image/jpeg;base64,${"A".repeat(MAX_PAINTABLE_IMAGE_CHARS)}`),
    "a result over the limit is not accepted either",
  );
});

test("the upload limit and format checks still come first", async () => {
  let shrunk = 0;
  const shrink = async (image: string) => { shrunk += 1; return image; };
  await assert.rejects(readBackgroundFile(imageFile(MAX_CUSTOM_BACKGROUND_BYTES + 1), shrink));
  await assert.rejects(readBackgroundFile(imageFile(1000, "image/gif"), shrink));
  assert.equal(shrunk, 0);
});

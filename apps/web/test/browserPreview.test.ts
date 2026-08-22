import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotationViewportRect,
  BROWSER_DEVICE_PRESETS,
  captureFileName,
  containedImageRect,
  devicePresetForViewport,
  normalizedPointInImage,
  normalizedRectInImage,
} from "../src/browserPreview.ts";

test("browser device presets expose distinct phone, tablet, laptop, and desktop viewports", () => {
  assert.deepEqual(
    BROWSER_DEVICE_PRESETS.map(({ id, width, height }) => [id, width, height]),
    [
      ["responsive", 1280, 800],
      ["iphone-14", 390, 844],
      ["pixel-7", 412, 915],
      ["ipad-mini", 768, 1024],
      ["laptop", 1366, 768],
      ["desktop", 1440, 900],
    ],
  );
  assert.equal(devicePresetForViewport(390, 844), "iphone-14");
  assert.equal(devicePresetForViewport(1440, 900), "desktop");
  assert.equal(devicePresetForViewport(1111, 777), "responsive");
});

test("contained frame geometry excludes letterboxing before clicks or annotations are mapped", () => {
  const landscape = containedImageRect(1000, 1000, 1440, 900);
  assert.deepEqual(landscape, { left: 0, top: 187.5, width: 1000, height: 625 });
  assert.equal(normalizedPointInImage(500, 100, landscape), null);
  assert.deepEqual(normalizedPointInImage(500, 500, landscape), { x: 0.5, y: 0.5 });

  const portrait = containedImageRect(1000, 600, 390, 844);
  assert.ok(portrait.left > 300);
  assert.equal(portrait.top, 0);
  assert.equal(normalizedPointInImage(20, 300, portrait), null);
  const center = normalizedPointInImage(500, 300, portrait);
  assert.ok(center);
  assert.ok(Math.abs(center!.x - 0.5) < 1e-9);
  assert.ok(Math.abs(center!.y - 0.5) < 1e-9);
});

test("drag selections normalize, clamp to the image, and map to viewport pixels", () => {
  const image = containedImageRect(1000, 1000, 1440, 900);
  const selected = normalizedRectInImage(
    { x: -100, y: 250 },
    { x: 500, y: 750 },
    image,
  );
  assert.deepEqual(selected, {
    x: 0,
    y: 0.1,
    width: 0.5,
    height: 0.8,
  });
  assert.deepEqual(annotationViewportRect(selected!, { width: 1440, height: 900 }), {
    x: 0,
    y: 90,
    width: 720,
    height: 720,
  });
  assert.equal(normalizedRectInImage({ x: 10, y: 10 }, { x: 12, y: 12 }, image), null);
});

test("capture filenames are deterministic, safe PNG names", () => {
  assert.equal(
    captureFileName(new Date("2026-08-22T20:30:40.123Z")),
    "browser-2026-08-22T20-30-40-123Z.png",
  );
});

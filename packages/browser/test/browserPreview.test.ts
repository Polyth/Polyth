import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotationViewportRect,
  BROWSER_DEVICE_PRESETS,
  browserApprovalRequired,
  browserPointedElementLabel,
  containedImageRect,
  compactPageIdentity,
  namedPresetForViewport,
  pointedFromActionResult,
  pressKeyFromEvent,
  recalledViewportMode,
  rememberViewportMode,
  elementHighlightRect,
  mergeScrollDelta,
  normalizedPointInImage,
  normalizedRectInImage,
} from "../widgets/browserPreview.ts";

test("browser device presets expose distinct phone, tablet, laptop, and desktop viewports", () => {
  assert.deepEqual(
    BROWSER_DEVICE_PRESETS.map(({ id, width, height }) => [id, width, height]),
    [
      ["responsive", 0, 0],
      ["iphone-14", 390, 844],
      ["pixel-7", 412, 915],
      ["ipad-mini", 768, 1024],
      ["laptop", 1366, 768],
      ["desktop", 1440, 900],
    ],
  );
  assert.equal(namedPresetForViewport(390, 844), "iphone-14");
  assert.equal(namedPresetForViewport(1440, 900), "desktop");
  assert.equal(namedPresetForViewport(1111, 777), null);
  assert.equal(namedPresetForViewport(1280, 800), null);
  assert.equal(compactPageIdentity("https://example.com/settings"), "example.com/settings");
  assert.equal(compactPageIdentity("https://example.com/"), "example.com");
  rememberViewportMode("b-a", "preset");
  rememberViewportMode("b-b", "custom");
  assert.equal(recalledViewportMode("b-a"), "preset");
  assert.equal(recalledViewportMode("b-b"), "custom");
  assert.deepEqual(pointedFromActionResult({
    tag: "input",
    selector: "input#q",
    editable: true,
    rect: { x: 8, y: 12, width: 200, height: 32 },
  }), {
    tag: "input",
    selector: "input#q",
    editable: true,
    rect: { x: 8, y: 12, width: 200, height: 32 },
  });
  assert.equal(pointedFromActionResult({ tag: "div" }), null);
});

test("pressKeyFromEvent maps Tab and Shift+Tab", () => {
  assert.equal(pressKeyFromEvent({ key: "Tab" }), "Tab");
  assert.equal(pressKeyFromEvent({ key: "Tab", shiftKey: true }), "Shift+Tab");
  assert.equal(pressKeyFromEvent({ key: "Enter", shiftKey: true }), "Enter");
  assert.equal(pressKeyFromEvent({ key: "a" }), null);
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

test("scroll deltas coalesce into one pending vector", () => {
  assert.deepEqual(mergeScrollDelta(null, 4, -10), { x: 4, y: -10 });
  assert.deepEqual(mergeScrollDelta({ x: 4, y: -10 }, 2, -3), { x: 6, y: -13 });
});

test("element highlights normalize against the viewport", () => {
  assert.deepEqual(
    elementHighlightRect({ x: 100, y: 50, width: 200, height: 40 }, { width: 1000, height: 500 }),
    { x: 0.1, y: 0.1, width: 0.2, height: 0.08 },
  );
});

test("external navigation approval uses the typed code and supports legacy messages", () => {
  assert.equal(browserApprovalRequired(Object.assign(
    new Error("external origin https://example.com needs a per-origin approval"),
    { code: "approval-required" },
  )), true);
  assert.equal(browserApprovalRequired(new Error(
    "external origin https://example.com needs a per-origin approval",
  )), true);
  assert.equal(browserApprovalRequired(new Error("DNS lookup failed")), false);
});

test("pointed-element UI labels normalize and bound page-sized text", () => {
  assert.equal(browserPointedElementLabel({
    name: "",
    text: "  Save\n\n changes  ",
    selector: "#save",
  }), "Save changes");
  assert.equal(browserPointedElementLabel({
    text: "x".repeat(200),
    selector: "html",
  }, 12), "xxxxxxxxxxx…");
  assert.equal(browserPointedElementLabel({ selector: "#fallback" }), "#fallback");
});

test("formatBrowserContextForModel is text-first and bounded", async () => {
  const { formatBrowserContextForModel, browserContextLabel } = await import("@polyth/contracts");
  const text = formatBrowserContextForModel({
    id: "c1",
    type: "element",
    browserSessionId: "b1",
    projectId: "p1",
    frameRevision: 4,
    url: "http://localhost:3000/settings/profile",
    title: "Profile",
    viewport: { width: 390, height: 844 },
    capturedAt: "2026-09-05T00:00:00.000Z",
    element: {
      tag: "button",
      role: "button",
      name: "Save changes",
      text: "Save changes",
      selector: "button.save",
      bounds: { x: 10, y: 20, width: 120, height: 36 },
    },
    note: "Focus the CTA",
  });
  assert.match(text, /\[Browser context\]/);
  assert.match(text, /Accessible name: Save changes/);
  assert.match(text, /Selector: button\.save/);
  assert.match(text, /Note: Focus the CTA/);
  assert.equal(browserContextLabel({
    id: "c1",
    type: "element",
    browserSessionId: "b1",
    projectId: "p1",
    frameRevision: 4,
    url: "http://localhost:3000/settings",
    title: "Settings",
    viewport: { width: 390, height: 844 },
    capturedAt: "2026-09-05T00:00:00.000Z",
    element: { name: "Save changes" },
  }), "Save changes");
  assert.equal(browserContextLabel({
    id: "c2",
    type: "area",
    browserSessionId: "b1",
    projectId: "p1",
    frameRevision: 4,
    url: "http://localhost:3000/settings",
    title: "Settings",
    viewport: { width: 390, height: 844 },
    capturedAt: "2026-09-05T00:00:00.000Z",
    region: {
      normalized: { x: 0, y: 0, width: 0.5, height: 0.5 },
      pixels: { x: 0, y: 0, width: 195, height: 422 },
    },
  }), "Selected area");
});

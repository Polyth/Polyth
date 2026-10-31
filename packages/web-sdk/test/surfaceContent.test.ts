import test from "node:test";
import assert from "node:assert/strict";
import { surfaceContentMode, withSurfaceContent } from "../src/surfaceContent.ts";
import type { SurfacePresentation } from "../src/index.ts";

const capabilities: SurfacePresentation = Object.freeze({
  kind: "workspace", defaultRatio: 0.55, minWidth: 320, minHeight: 240,
  preferredMaxWidth: 900, keepAlive: true, escape: "close", dock: "bottom",
  dockOptions: Object.freeze(["side", "bottom"] as const),
});

test("page content is the shared default without changing window capabilities", () => {
  const result = withSurfaceContent(capabilities);
  assert.equal(result.contentMode, "page");
  const { contentMode: _, ...rest } = result;
  assert.deepEqual(rest, capabilities);
  assert.equal(result.dockOptions, capabilities.dockOptions);
  assert.equal(Object.hasOwn(capabilities, "contentMode"), false);
});

for (const mode of ["page", "panel", "workspace"] as const) {
  test(`${mode} content is independent of the host presentation fallback`, () => {
    const presentation = withSurfaceContent(capabilities, mode);
    for (const fallback of ["page", "panel", "workspace"] as const) {
      assert.equal(surfaceContentMode(presentation, fallback), mode);
    }
  });
}

test("legacy registrations preserve their caller's content mode", () => {
  for (const fallback of ["page", "panel", "workspace"] as const) {
    for (const presentation of [capabilities, undefined, null, {}, 0, "page"]) {
      assert.equal(surfaceContentMode(presentation, fallback), fallback);
    }
  }
});

test("invalid and inherited plugin metadata cannot invent a layout mode", () => {
  for (const contentMode of [undefined, null, "", "fullscreen", "page workspace", 1, true, {}]) {
    assert.equal(surfaceContentMode({ contentMode }, "panel"), "panel");
  }
  assert.equal(surfaceContentMode(Object.create({ contentMode: "page" }), "workspace"), "workspace");
});

test("reading a presentation does not mutate or freeze package-owned metadata", () => {
  const presentation = withSurfaceContent(capabilities);
  surfaceContentMode(presentation, "workspace");
  assert.equal(Object.isFrozen(presentation), false);
  presentation.contentMode = "panel";
  assert.equal(surfaceContentMode(presentation, "workspace"), "panel");
});

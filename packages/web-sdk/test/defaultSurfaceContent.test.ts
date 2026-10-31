import test from "node:test";
import assert from "node:assert/strict";
import { withDefaultSurfaceContent, withSurfaceContent } from "../src/surfaceContent.ts";
import type { SurfacePresentation } from "../src/index.ts";

const capabilities: SurfacePresentation = Object.freeze({
  kind: "workspace", defaultRatio: 0.55, minWidth: 320, minHeight: 240,
  preferredMaxWidth: 900, keepAlive: true, escape: "close", dock: "bottom",
  dockOptions: Object.freeze(["side", "bottom"] as const),
});

test("every package window inherits page layout without changing its component or capabilities", () => {
  const component = () => null;
  const badge = () => 3;
  const visible = () => true;
  const placement = Object.freeze({ preferredRegion: "end", keepAlive: true });
  const definition = Object.freeze({
    id: "example", ownerPackageId: "example-package", component, badge, visible,
    presentation: capabilities, placement,
  });
  const result = withDefaultSurfaceContent(definition);
  assert.equal(result.presentation.contentMode, "page");
  assert.notEqual(result, definition);
  assert.equal(result.component, component);
  assert.equal(result.badge, badge);
  assert.equal(result.visible, visible);
  assert.equal(result.placement, placement);
  assert.equal(result.ownerPackageId, definition.ownerPackageId);
  assert.equal(Object.hasOwn(definition.presentation, "contentMode"), false);
  const { presentation: _, ...metadata } = result;
  const { presentation: __, ...originalMetadata } = definition;
  assert.deepEqual(metadata, originalMetadata);
  const { contentMode: ___, ...windowCapabilities } = result.presentation;
  assert.deepEqual(windowCapabilities, capabilities);
});

for (const mode of ["page", "panel", "workspace"] as const) {
  test(`package registration preserves explicit ${mode} content`, () => {
    const definition = { presentation: withSurfaceContent(capabilities, mode) };
    const once = withDefaultSurfaceContent(definition);
    const twice = withDefaultSurfaceContent(once);
    assert.equal(once.presentation.contentMode, mode);
    assert.deepEqual(twice, once);
    assert.deepEqual(definition.presentation, once.presentation);
  });
}

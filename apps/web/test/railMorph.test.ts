// The package window morph (railMorph.ts): the keyframes that carry an open
// window's frame from one presentation to the next, and Chat's room with it.
// Pure geometry; ContextRail's wiring is pinned from its source below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { railFrameKeyframes, railWorkspaceKeyframes } from "../src/railMorph.ts";

const frame = (width: number, edge = 0, gutter = 12, top = 8, bottom = 992) => ({ width, top, bottom, edge, gutter, fill: "" });

test("a floating window resizes from the width it had", () => {
  assert.deepEqual(railFrameKeyframes("floating", frame(545, 1), frame(838, 1)), [
    { width: "545px", maxWidth: "none" },
    { width: "838px", maxWidth: "none" },
  ]);
  assert.equal(railFrameKeyframes("floating", frame(545, 1), frame(545.4, 1)), null, "layout rounding is not motion");
});

test("a docked window resizes without taking Chat's room twice", () => {
  const keyframes = railFrameKeyframes("docked", frame(838, 1), frame(808, 0));
  assert.ok(keyframes);
  const [from, to] = keyframes;
  // The floating frame drew its own 1px edge; docked, the host draws it. The
  // content's edge stays where it was, so the frame starts 1px narrower.
  assert.equal(from?.width, "837px");
  assert.equal(from?.flexBasis, "837px");
  assert.equal(to?.width, "808px");
  // Width plus margin is the frame's footprint in the row: constant, at the
  // final width, so only railWorkspaceKeyframes moves Chat.
  for (const keyframe of keyframes) {
    assert.equal(Number.parseFloat(String(keyframe.width)) + Number.parseFloat(String(keyframe.marginInlineStart)), 808);
  }
});

test("a layer is held at the old width by its inline-start margin", () => {
  assert.deepEqual(railFrameKeyframes("layer", frame(808, 0, 12), frame(1286, 1, 0)), [
    { marginInlineStart: "477px", paddingInlineEnd: "12px" },
    { marginInlineStart: "0px", paddingInlineEnd: "0px" },
  ], "the seam gutter closes with the motion instead of stepping first");
});

test("a frame that keeps its width only moves its gutter, or nothing", () => {
  assert.deepEqual(railFrameKeyframes("floating", frame(545, 1, 12), frame(545, 1, 0)), [
    { paddingInlineEnd: "12px" },
    { paddingInlineEnd: "0px" },
  ]);
  assert.equal(railFrameKeyframes("docked", frame(808), frame(808)), null);
});

test("a layer that starts under the bar is held at the window's block edges", () => {
  assert.deepEqual(railFrameKeyframes("layer", frame(808, 0, 0), frame(808, 0, 0, 48, 992)), [
    { marginBlockStart: "-40px", marginBlockEnd: "0px" },
    { marginBlockStart: "0px", marginBlockEnd: "0px" },
  ]);
  assert.deepEqual(railFrameKeyframes("floating", frame(808, 0, 0, 48, 992), frame(808, 0, 0)), [
    { marginBlockStart: "40px", height: "944px", maxHeight: "none" },
    { marginBlockStart: "0px", height: "984px", maxHeight: "none" },
  ], "a floating frame has its own height, so it carries the old one");
});

test("Chat keeps the width it had and reaches the new one with the frame", () => {
  assert.deepEqual(railWorkspaceKeyframes(1332, 481), [{ marginRight: "-851px" }, { marginRight: "0px" }],
    "pinning: Chat runs on under the window, then gives up its room");
  assert.deepEqual(railWorkspaceKeyframes(481, 1332, "marginLeft"), [{ marginLeft: "851px" }, { marginLeft: "0px" }],
    "unpinning in a mirrored shell: Chat grows back on the launcher's side, the left");
  assert.equal(railWorkspaceKeyframes(1332, 1332), null);
  assert.equal(railWorkspaceKeyframes(null, 1332), null);
});

test("ContextRail morphs between presentations instead of replaying an entry", async () => {
  const [rail, css] = await Promise.all([
    readFile(new URL("../src/components/ContextRail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  // The old frame is read in render, before React commits the new one.
  assert.match(rail, /: \{ key: frameKey, reading: readRailFrame\(\{ pane: paneRef\.current,/);
  assert.match(rail, /\? \{ key: frameKey, reading: frameBeforeRef\.current\.reading \}/, "an unused reading survives a promoted pin");
  assert.match(rail, /if \(geometryPending \|\| frameRef\.current\.key === frameKey\) return;/, "the morph waits for the measured commit");
  // Transitional widths must not reach the dock decision or the layout guard.
  assert.match(rail, /const measure = \(\) => \{\s*if \(frameMorphingRef\.current\) \{/);
  assert.match(rail, /const check = \(\) => \{\s*if \(frameMorphingRef\.current\) return;/);
  assert.match(rail, /data-rail-entry=\{open !== null && frameEntry === "morph" \? "morph" : undefined\}/);
  assert.match(
    css,
    /\.railbar > \.rail\[data-rail-entry="morph"\]:not\(\.rail-exiting\),\s*\.railbar > \.rail\[data-rail-entry="morph"\]:not\(\.rail-exiting\) > \.module-view \{\s*animation: none !important;/,
    "no entry animation replays over a morph",
  );
  const frameRule = css.match(/\.rail:not\(\.rail-workspace\):not\(\.rail-fullscreen\),\s*\.rail-workspace \{([^}]*)\}/)?.[1] ?? "";
  assert.doesNotMatch(frameRule.replace(/\/\*[\s\S]*?\*\//g, ""), /transition:[^;]*\b(?:width|height)\b/,
    "size is never a CSS transition: it would start from an unmeasured commit's width");
  // A leaving window is still on screen: it keeps rendering as the active one.
  assert.match(rail, /const shown = active \|\| leaving;/);
  assert.match(rail, /<s\.component active=\{shown\}/);
});

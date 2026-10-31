import test from "node:test";
import assert from "node:assert/strict";
import {
  RAIL_ACTIVE_WIDTH,
  RAIL_BASE_WIDTH,
  RAIL_CURSOR_NEAR_WIDTH,
  RAIL_CURSOR_WIDTH,
  RAIL_EDGE_GAP,
  RAIL_MAX_TICKS,
  RAIL_TICK_PITCH,
  RAIL_VISUAL_SCALE,
  activePromptIndex,
  cursorTickIndex,
  promptRailInset,
  promptRowLabel,
  promptRowTops,
  railWindow,
  tickWidth,
} from "../src/promptRail.ts";

test("rail marks and pitch are scaled up by 15%", () => {
  const scaled = (value: number) => Number((value * RAIL_VISUAL_SCALE).toFixed(2));
  assert.equal(RAIL_VISUAL_SCALE, 1.15);
  assert.equal(RAIL_TICK_PITCH, scaled(8));
  assert.equal(RAIL_BASE_WIDTH, scaled(7));
  assert.equal(RAIL_ACTIVE_WIDTH, scaled(14));
  assert.equal(RAIL_CURSOR_WIDTH, scaled(20));
  assert.equal(RAIL_CURSOR_NEAR_WIDTH, scaled(12));
});

test("railWindow shows everything when it fits", () => {
  assert.deepEqual(railWindow(0, -1), { start: 0, end: 0 });
  assert.deepEqual(railWindow(5, 2), { start: 0, end: 5 });
  assert.deepEqual(railWindow(RAIL_MAX_TICKS, 0), { start: 0, end: RAIL_MAX_TICKS });
});

test("railWindow centers the active tick and clamps at both edges", () => {
  // 100 prompts, 30 ticks: active in the middle sits at the window center.
  const mid = railWindow(100, 50);
  assert.equal(mid.end - mid.start, RAIL_MAX_TICKS);
  assert.deepEqual(mid, { start: 35, end: 65 });
  // Near the start the window clamps to 0.
  assert.deepEqual(railWindow(100, 3), { start: 0, end: 30 });
  // Near the end it clamps so the last tick is the last prompt.
  assert.deepEqual(railWindow(100, 99), { start: 70, end: 100 });
  // No active prompt yet: window ends at the newest prompt.
  assert.deepEqual(railWindow(100, -1), { start: 70, end: 100 });
});

test("tickWidth: base, active, and cursor emphasis", () => {
  assert.equal(tickWidth(0, -1, -1), RAIL_BASE_WIDTH);
  assert.equal(tickWidth(4, 4, -1), RAIL_ACTIVE_WIDTH);
  assert.equal(tickWidth(4, -1, 4), RAIL_CURSOR_WIDTH);
  // Active + cursor on the same tick: the larger (cursor) wins.
  assert.equal(tickWidth(4, 4, 4), RAIL_CURSOR_WIDTH);
});

test("tickWidth uses three compact proximity levels", () => {
  const w0 = tickWidth(10, -1, 10);
  const w1 = tickWidth(11, -1, 10);
  const w2 = tickWidth(12, -1, 10);
  const w3 = tickWidth(13, -1, 10);
  assert.deepEqual([w0, w1, w2, w3], [RAIL_CURSOR_WIDTH, RAIL_CURSOR_NEAR_WIDTH, RAIL_BASE_WIDTH, RAIL_BASE_WIDTH]);
  assert.equal(tickWidth(14, 14, 10), RAIL_BASE_WIDTH, "hover emphasis beats active emphasis");
});

test("cursorTickIndex maps tape offsets to visible ticks", () => {
  assert.equal(cursorTickIndex(0, 10), 0);
  assert.equal(cursorTickIndex(RAIL_TICK_PITCH - 1, 10), 0);
  assert.equal(cursorTickIndex(RAIL_TICK_PITCH, 10), 1);
  assert.equal(cursorTickIndex(RAIL_TICK_PITCH * 10 - 1, 10), 9);
  assert.equal(cursorTickIndex(RAIL_TICK_PITCH * 10, 10), -1, "below the last tick");
  assert.equal(cursorTickIndex(-1, 10), -1, "above the tape");
  assert.equal(cursorTickIndex(5, 0), -1, "no ticks");
});

test("activePromptIndex picks the last prompt at or above the reading line", () => {
  assert.equal(activePromptIndex([], 100), -1);
  // All rendered: last top <= line wins.
  assert.equal(activePromptIndex([10, 50, 90, 400], 100), 2);
  // Everything below the line: the first prompt is current.
  assert.equal(activePromptIndex([200, 300], 100), 0);
  // Earlier prompts windowed out (null): they count as "above", so when every
  // rendered prompt is below the line the newest hidden one is current.
  assert.equal(activePromptIndex([null, null, 200, 300], 100), 1);
  // A rendered prompt above the line beats hidden earlier ones.
  assert.equal(activePromptIndex([null, 40, 300], 100), 1);
});

// Chat viewport 300..1300 x 50..850 in every inset case below.
const viewport = { left: 300, right: 1300, top: 50, bottom: 850 };

test("rail inset hugs a free edge on either side", () => {
  assert.equal(promptRailInset(viewport, [], "right"), RAIL_EDGE_GAP);
  assert.equal(promptRailInset(viewport, [], "left"), RAIL_EDGE_GAP);
});

test("rail inset clears chrome drawn over its edge, whatever its size or offset", () => {
  // Full-height launcher strip overlaying the right edge.
  assert.equal(promptRailInset(viewport, [{ left: 1260, right: 1300, top: 0, bottom: 900 }], "right"), 40 + RAIL_EDGE_GAP);
  // Floating cluster inset 12px from the edge, wider custom icons.
  assert.equal(promptRailInset(viewport, [{ left: 1240, right: 1288, top: 62, bottom: 400 }], "right"), 60 + RAIL_EDGE_GAP);
  // A collapsed navigator drawn over the left edge only affects a left rail.
  const navigator = { left: 300, right: 356, top: 50, bottom: 850 };
  assert.equal(promptRailInset(viewport, [navigator], "left"), 56 + RAIL_EDGE_GAP);
  assert.equal(promptRailInset(viewport, [navigator], "right"), RAIL_EDGE_GAP);
});

test("rail inset ignores chrome beside the chat or covering most of it", () => {
  // In-flow sidebar (expanded or collapsed) and a pinned pane sit beside the viewport.
  const beside = [{ left: 0, right: 300, top: 0, bottom: 900 }, { left: 1300, right: 1700, top: 0, bottom: 900 }];
  assert.equal(promptRailInset(viewport, beside, "left"), RAIL_EDGE_GAP);
  assert.equal(promptRailInset(viewport, beside, "right"), RAIL_EDGE_GAP);
  // A fullscreen package is not an edge strip.
  assert.equal(promptRailInset(viewport, [{ left: 320, right: 1300, top: 50, bottom: 850 }], "right"), RAIL_EDGE_GAP);
  // Hidden (zero-size) chrome costs nothing.
  assert.equal(promptRailInset(viewport, [{ left: 1300, right: 1300, top: 0, bottom: 0 }], "right"), RAIL_EDGE_GAP);
});

test("prompt row labels read as sentences without rewriting code-like input", () => {
  assert.equal(promptRowLabel("оглянь і займися дизайном"), "Оглянь і займися дизайном");
  assert.equal(promptRowLabel("fix the build, please"), "Fix the build, please");
  assert.equal(promptRowLabel("don't stop"), "Don't stop");
  assert.equal(promptRowLabel("done. next"), "Done. next");
  assert.equal(promptRowLabel("note: keep it"), "Note: keep it");
  assert.equal(promptRowLabel("  ## make   it\tpretty "), "Make it pretty");
  assert.equal(promptRowLabel("> quoted request"), "Quoted request");
  assert.equal(promptRowLabel("- list item"), "List item");
  assert.equal(promptRowLabel("1. first step"), "First step");
  assert.equal(promptRowLabel("Already capitalized"), "Already capitalized");
  // Commands, mentions, paths, identifiers and brand spellings stay as typed.
  for (const raw of ["/review this", "@file.ts look", "src/app.ts is broken", "npm_run", "iPhone layout", "git.status", "http://localhost:4400 is down", "`code` first", "42 tests"]) {
    assert.equal(promptRowLabel(raw), raw);
  }
  assert.equal(promptRowLabel("   "), "");
});

test("promptRowTops reads every prompt from one subtree walk", () => {
  const node = (id: string, top: number) => ({ getAttribute: (name: string) => name === "data-msg-id" ? id : null, getBoundingClientRect: () => ({ top }) });
  let walks = 0;
  const rects: string[] = [];
  const timeline = {
    querySelectorAll(selector: string) {
      assert.equal(selector, "[data-msg-id]");
      walks += 1;
      return [node("a1", 5), node("u2", 40), node("u3", 90), node("u2", 999), node("u4", 300)].map((n) => ({
        ...n,
        getBoundingClientRect: () => { rects.push(n.getAttribute("data-msg-id")!); return n.getBoundingClientRect(); },
      }));
    },
  };
  // u1 is windowed out; a1 is not a prompt; the first u2 wins like querySelector.
  assert.deepEqual(promptRowTops(timeline, ["u1", "u2", "u3", "u4"]), [null, 40, 90, 300]);
  assert.equal(walks, 1);
  assert.deepEqual(rects, ["u2", "u3", "u4"]);
});

// Focused split (Tasks / IDE): the work surface is the flexible primary
// column, Chat a fixed-width companion (min 360). Pure geometry over the
// window bands, the +24px re-entry hysteresis, the per-profile Chat width
// record and the 0.45 Chat-profile ratio.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_FLOOR, FOCUSED_CHAT_MIN, FOCUSED_SNAP, FOCUSED_WORK_MAX, FOCUSED_WORK_MIN, commitFocusedChatWidth, companionTargetFor,
  decideFocusedSplit, normalizeCompanionWidth,
  type CompanionWidth, type FocusedSplitDecision,
} from "../src/surfaces.ts";
import { DOCK_HYSTERESIS, dockWithHysteresis } from "../src/workspace/dockGeometry.ts";
import { parseWorkspacePanePrefs, serializeWorkspacePanePrefs } from "../src/workspace/panePrefs.ts";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_RAIL_WIDTH } from "../src/sidebarLayout.ts";

const COMPANION: CompanionWidth = { min: 360, target: 440, max: 560 };
const TASKS_WORK_MAX = 1400;
/** Files declares 760 (its Chat-companion cap); the focused split floors it. */
const FILES_WORK_MAX = Math.max(FOCUSED_WORK_MAX, 760);
/** Launcher strip + pane seam beside the split (measured: 1100 − 332 − 702). */
const STRIP_LANE = 66;
const SIDEBAR_RAIL_BELOW = 1600;

/** Post-sidebar Chat + work width the host measures for a window: the
 *  automatic project rail below `sidebarRailBelow`, the full sidebar above. */
function workspaceFor(windowWidth: number): number {
  const sidebar = windowWidth < SIDEBAR_RAIL_BELOW ? SIDEBAR_RAIL_WIDTH : SIDEBAR_DEFAULT_WIDTH;
  return windowWidth - sidebar - STRIP_LANE;
}

function split(windowWidth: number, over: Partial<Parameters<typeof decideFocusedSplit>[0]> = {}): FocusedSplitDecision {
  return decideFocusedSplit({
    windowWidth,
    workspaceWidth: workspaceFor(windowWidth),
    companion: COMPANION,
    workMin: FOCUSED_WORK_MIN,
    workMax: TASKS_WORK_MAX,
    savedChatWidth: null,
    wasDocked: null,
    ...over,
  });
}

test("focused split table: chat companion and work surface per window band", () => {
  const rows = [1024, 1100, 1280, 1440, 1600, 1920].map((w) => {
    const d = split(w);
    return { w, mode: d.dock ? "docked" : "layer", chat: d.dock ? d.chatWidth : null, work: d.dock ? d.workWidth : null };
  });
  assert.deepEqual(rows, [
    { w: 1024, mode: "layer", chat: null, work: null },
    { w: 1100, mode: "docked", chat: 360, work: 625 },
    { w: 1280, mode: "docked", chat: 400, work: 765 },
    { w: 1440, mode: "docked", chat: 400, work: 925 },
    { w: 1600, mode: "docked", chat: 440, work: 762 },
    { w: 1920, mode: "docked", chat: 440, work: 1082 },
  ]);
});

test("focused split: chat width is monotonic in the window and no minimum is ever broken", () => {
  let previousChat = 0;
  for (let w = 961; w <= 2560; w++) {
    for (const workMax of [TASKS_WORK_MAX, FILES_WORK_MAX]) {
      const d = split(w, { workMax });
      if (!d.dock) {
        assert.ok(workspaceFor(w) < FOCUSED_WORK_MIN + FOCUSED_CHAT_MIN, `${w}: layer only below the floors`);
        continue;
      }
      assert.ok(d.chatWidth >= FOCUSED_CHAT_MIN, `${w}: chat ${d.chatWidth}`);
      assert.ok(d.workWidth >= FOCUSED_WORK_MIN, `${w}: work ${d.workWidth}`);
      assert.equal(d.chatWidth + d.workWidth, workspaceFor(w));
      if (workMax === TASKS_WORK_MAX) {
        assert.ok(d.chatWidth >= previousChat, `${w}: ${d.chatWidth} < ${previousChat}`);
        previousChat = d.chatWidth;
      }
    }
  }
  assert.ok(CHAT_FLOOR < FOCUSED_CHAT_MIN, "the companion floor is above the generic Chat floor");
});

test("focused split: band defaults are min / midpoint / target", () => {
  assert.equal(companionTargetFor(1100, COMPANION), 360);
  assert.equal(companionTargetFor(1279, COMPANION), 360);
  assert.equal(companionTargetFor(1280, COMPANION), 400);
  assert.equal(companionTargetFor(1599, COMPANION), 400);
  assert.equal(companionTargetFor(1600, COMPANION), 440);
});

test("focused split: past the work cap Chat fills to its max, then the work surface grows", () => {
  // 2560px, Files capped at 1100: Chat takes 560 (its max), Files the rest.
  const d = split(2560, { workMax: FILES_WORK_MAX });
  assert.equal(d.chatWidth, 560);
  assert.equal(d.workWidth, workspaceFor(2560) - 560);
  // Tasks (cap 1400) still fits beside the 440 target at 1920.
  assert.equal(split(1920).chatWidth, 440);
});

test("focused split: a saved Chat width is clamped on read and never causes a layer jump", () => {
  for (const w of [1100, 1280, 1440, 1920]) {
    const auto = split(w);
    for (const saved of [1, 200, 359, 900, 4000]) {
      const d = split(w, { savedChatWidth: saved });
      assert.equal(d.dock, auto.dock, `${w}/${saved}: mode follows geometry only`);
      assert.ok(d.chatWidth >= FOCUSED_CHAT_MIN && d.workWidth >= FOCUSED_WORK_MIN, `${w}/${saved}`);
    }
  }
  assert.equal(split(1100, { savedChatWidth: 900 }).chatWidth, workspaceFor(1100) - FOCUSED_WORK_MIN);
  assert.equal(split(1440, { savedChatWidth: 480 }).chatWidth, 480);
});

test("focused split: resize commits snap within ±12px of the band default", () => {
  const d = split(1440);
  assert.equal(commitFocusedChatWidth(d.chatTarget + FOCUSED_SNAP, d), null, "snaps (forgets the saved width)");
  assert.equal(commitFocusedChatWidth(d.chatTarget - FOCUSED_SNAP, d), null);
  assert.equal(commitFocusedChatWidth(d.chatTarget + FOCUSED_SNAP + 1, d), d.chatTarget + FOCUSED_SNAP + 1);
  assert.equal(commitFocusedChatWidth(10, d), FOCUSED_CHAT_MIN, "clamped to the floor");
  assert.equal(commitFocusedChatWidth(5000, d), d.chatMax, "clamped to leave the work floor");
});

test("companion hint is untrusted data: normalized into min ≤ target ≤ max with the 360 floor", () => {
  assert.deepEqual(normalizeCompanionWidth(COMPANION), COMPANION);
  assert.deepEqual(normalizeCompanionWidth({ min: 100, target: 50, max: 10 }), { min: 360, target: 360, max: 360 });
  assert.deepEqual(normalizeCompanionWidth({ target: 420 }), { min: 360, target: 420, max: 420 });
  assert.equal(normalizeCompanionWidth("440"), null);
  assert.equal(normalizeCompanionWidth(null), null);
  assert.equal(normalizeCompanionWidth([360]), null);
});

// ---- hysteresis ---------------------------------------------------------------

test("dock hysteresis: leave below the threshold, re-enter only at threshold + 24", () => {
  const threshold = FOCUSED_WORK_MIN + FOCUSED_CHAT_MIN;
  assert.equal(DOCK_HYSTERESIS, 24);
  // First decision is unchanged: opening at the threshold docks.
  assert.equal(dockWithHysteresis({ width: threshold, threshold, wasDocked: null }), true);
  assert.equal(dockWithHysteresis({ width: threshold - 1, threshold, wasDocked: null }), false);
  for (let over = 0; over < DOCK_HYSTERESIS; over++) {
    assert.equal(dockWithHysteresis({ width: threshold + over, threshold, wasDocked: true }), true, `docked stays at +${over}`);
    assert.equal(dockWithHysteresis({ width: threshold + over, threshold, wasDocked: false }), false, `left stays out at +${over}`);
  }
  assert.equal(dockWithHysteresis({ width: threshold + DOCK_HYSTERESIS, threshold, wasDocked: false }), true);
});

test("dock hysteresis: no oscillation anywhere in the 0–24px band, frame after frame", () => {
  const threshold = FOCUSED_WORK_MIN + FOCUSED_CHAT_MIN;
  for (let over = -2; over <= DOCK_HYSTERESIS + 2; over++) {
    for (const start of [true, false]) {
      let docked: boolean | null = start;
      const frames: boolean[] = [];
      for (let frame = 0; frame < 12; frame++) {
        // The layer's Chat box can overstate by the strip lane only when the
        // docked-width memory is gone (fresh shell box); model the worst case
        // of ±noise around the same geometry.
        const width = threshold + over + (frame % 2 === 0 ? 0 : 1);
        docked = decideFocusedSplit({
          windowWidth: 1100, workspaceWidth: width, companion: COMPANION, workMin: FOCUSED_WORK_MIN,
          workMax: TASKS_WORK_MAX, savedChatWidth: null, wasDocked: docked,
        }).dock;
        frames.push(docked);
      }
      const flips = frames.slice(1).filter((value, index) => value !== frames[index]).length;
      assert.ok(flips <= 1, `+${over} from ${start ? "docked" : "layer"}: ${frames.join(",")}`);
    }
  }
});

test("dock hysteresis: a slow window drag across the threshold flips exactly twice", () => {
  const sweep = [...Array.from({ length: 80 }, (_, i) => 1120 - i), ...Array.from({ length: 80 }, (_, i) => 1041 + i)];
  let docked: boolean | null = null;
  const changes: number[] = [];
  for (const w of sweep) {
    const next: boolean = split(w, { wasDocked: docked }).dock;
    if (docked !== null && next !== docked) changes.push(w);
    docked = next;
  }
  const threshold = FOCUSED_WORK_MIN + FOCUSED_CHAT_MIN + SIDEBAR_RAIL_WIDTH + STRIP_LANE;
  assert.deepEqual(changes, [threshold - 1, threshold + DOCK_HYSTERESIS]);
});

// ---- persistence ----------------------------------------------------------------

test("panePrefs splitChatWidths: per profile, sanity-filtered, round-trips", () => {
  const parsed = parseWorkspacePanePrefs(JSON.stringify({
    version: 2, widths: {}, heights: {}, lastResource: {},
    splitChatWidths: { tasks: 420.4, ide: 380, junk: "wide", tiny: 4, huge: 99999 },
  }));
  assert.deepEqual(parsed.splitChatWidths, { tasks: 420, ide: 380 });
  assert.deepEqual(parseWorkspacePanePrefs(serializeWorkspacePanePrefs(parsed)).splitChatWidths, { tasks: 420, ide: 380 });
  assert.equal("splitChatWidths" in parseWorkspacePanePrefs(JSON.stringify({ version: 2 })), false);
});

test("panePrefs setSplitChatWidth: per project and profile; null forgets; garbage ignored", async () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
    },
  });
  const { getWorkspacePanePrefs, resetWorkspacePanePrefsCache, setSplitChatWidth, setPanePreferredWidth } =
    await import("../src/workspace/panePrefs.ts");
  resetWorkspacePanePrefsCache();
  setPanePreferredWidth("p1", "task-trackers", 700);
  setSplitChatWidth("p1", "tasks", 420);
  setSplitChatWidth("p1", "ide", 480);
  setSplitChatWidth("p1", "ide", Number.NaN);
  assert.deepEqual(getWorkspacePanePrefs("p1").splitChatWidths, { tasks: 420, ide: 480 });
  assert.equal(getWorkspacePanePrefs("p2").splitChatWidths, undefined, "project B untouched");
  assert.equal(getWorkspacePanePrefs("p1").widths["task-trackers"], 700, "the pane width record is separate");

  setSplitChatWidth("p1", "tasks", null);
  assert.deepEqual(getWorkspacePanePrefs("p1").splitChatWidths, { ide: 480 });
  setSplitChatWidth("p1", "ide", null);
  assert.equal("splitChatWidths" in getWorkspacePanePrefs("p1"), false);

  resetWorkspacePanePrefsCache();
  setSplitChatWidth("p1", "tasks", 400);
  resetWorkspacePanePrefsCache();
  assert.deepEqual(getWorkspacePanePrefs("p1").splitChatWidths, { tasks: 400 }, "survives storage");
});

// ---- Chat-profile companion ------------------------------------------------------

// The Tasks Chat-profile companion geometry is asserted with the package's own
// widget in that package's host-focusedSplit test.

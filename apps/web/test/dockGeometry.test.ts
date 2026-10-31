// Dock admission must be judged from a width that does not depend on the mode
// the admission itself selects. Geometry below is the measured 1100px desktop
// repro of "opening Tasks/IDE flickers": 332px sidebar, Tasks pane (min 380,
// ratio 0.65). Docked in flow, Chat + pane measure 702px; on the full-screen
// layer Chat also spans the launcher-strip lane and measures 760px.
import test from "node:test";
import assert from "node:assert/strict";
import { decideDock, paneWindowLayout, type WorkspacePanePresentation } from "../src/surfaces.ts";
import { dockAdmissionWidth, shellBoxKey, type DockedWidthMemory } from "../src/workspace/dockGeometry.ts";

const TASKS: WorkspacePanePresentation = {
  kind: "workspace", defaultRatio: 0.65, minWidth: 380, minHeight: 320, preferredMaxWidth: 1400,
  keepAlive: true, escape: "close",
};
const CHROME = 6;
const DOCKED_WIDTH = 702;
const LAYERED_WIDTH = 760;

/** Drive the measure → admit → render loop the pane host runs, starting from
 *  a freshly pinned pane, and return the presentation after every frame. */
function simulate(stable: boolean, frames = 12, shellKey = () => shellBoxKey(1100, 332)): boolean[] {
  let layered: boolean = false;
  let memory: DockedWidthMemory | null = null;
  const history: boolean[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const measuredWidth: number = layered ? LAYERED_WIDTH : DOCKED_WIDTH;
    let width: number = measuredWidth;
    if (stable) {
      const next = dockAdmissionWidth({ measuredWidth, dockedInFlow: !layered, shellKey: shellKey(), memory });
      width = next.width;
      memory = next.memory;
    }
    const admits: boolean = decideDock(null, TASKS, { workspaceWidth: width, chrome: CHROME }).dock;
    layered = paneWindowLayout({
      isWorkspacePane: true, compact: false, paneMode: "pinned", dockEdge: "side",
      measured: true, admits, guardPromoted: false,
    }).layered;
    history.push(layered);
  }
  return history;
}

const flips = (history: readonly boolean[]) => history.filter((value, i) => i > 0 && value !== history[i - 1]).length;

test("negative control: admitting from the layered box flips dock ⇄ layer every frame", () => {
  // This was the shipped behaviour: the pane host fed the raw measurement in.
  const history = simulate(false);
  assert.ok(flips(history) >= 10, `expected an oscillation, got ${history.join(",")}`);
});

test("a pane that cannot dock promotes to the layer once and stays there", () => {
  const history = simulate(true);
  assert.equal(history[0], true, "702px cannot keep Chat's floor beside a 380px Tasks pane");
  assert.equal(flips(history), 0, history.join(","));
});

test("the remembered docked width is released by a real shell change", () => {
  let memory: DockedWidthMemory | null = null;
  const docked = dockAdmissionWidth({ measuredWidth: 702.4, dockedInFlow: true, shellKey: shellBoxKey(1100, 332), memory });
  assert.equal(docked.width, 702);
  memory = docked.memory;

  // The layer's own wider Chat box is not a geometry change.
  assert.equal(dockAdmissionWidth({ measuredWidth: 760, dockedInFlow: false, shellKey: shellBoxKey(1100.3, 332), memory }).width, 702);
  // A wider window or a collapsed sidebar is: judge the new box fresh.
  const resized = dockAdmissionWidth({ measuredWidth: 940, dockedInFlow: false, shellKey: shellBoxKey(1280, 332), memory });
  assert.deepEqual(resized, { width: 940, memory: null });
  assert.equal(dockAdmissionWidth({ measuredWidth: 1046, dockedInFlow: false, shellKey: shellBoxKey(1100, 46), memory }).width, 1046);
  // A fresh docked measurement always replaces the memory.
  assert.deepEqual(
    dockAdmissionWidth({ measuredWidth: 713, dockedInFlow: true, shellKey: shellBoxKey(1100, 332), memory }).memory,
    { shellKey: "1100:332", width: 713 },
  );
});

test("a pane that fits keeps docking after the shell grows", () => {
  let key = shellBoxKey(1100, 332);
  let layered: boolean = true;
  let memory: DockedWidthMemory | null = { shellKey: key, width: DOCKED_WIDTH };
  key = shellBoxKey(1280, 332);
  for (let frame = 0; frame < 6; frame++) {
    const measuredWidth: number = layered ? 940 : 882;
    const next = dockAdmissionWidth({ measuredWidth, dockedInFlow: !layered, shellKey: key, memory });
    memory = next.memory;
    layered = !decideDock(null, TASKS, { workspaceWidth: next.width, chrome: CHROME }).dock;
  }
  assert.equal(layered, false);
  assert.deepEqual(memory, { shellKey: "1280:332", width: 882 });
});

// ---- learned layer inset + hysteresis (live window drag) -----------------------

test("layer inset: learned at the first dock → layer flip in one box, kept across resizes", async () => {
  const { learnLayerInset, layerCorrectedWidth } = await import("../src/workspace/dockGeometry.ts");
  const key = shellBoxKey(1100, 332);
  const docked: DockedWidthMemory = { shellKey: key, width: DOCKED_WIDTH };
  assert.equal(learnLayerInset({ measuredWidth: LAYERED_WIDTH, layered: true, shellKey: key, docked, inset: null }), 58);
  // A fresh box (resize) keeps the learned inset; docked readings never learn.
  assert.equal(learnLayerInset({ measuredWidth: 900, layered: true, shellKey: shellBoxKey(1240, 332), docked, inset: 58 }), 58);
  assert.equal(learnLayerInset({ measuredWidth: 760, layered: false, shellKey: key, docked, inset: null }), null);
  // Implausible differences (another layout) are ignored.
  assert.equal(learnLayerInset({ measuredWidth: DOCKED_WIDTH + 400, layered: true, shellKey: key, docked, inset: null }), null);
  assert.equal(layerCorrectedWidth(LAYERED_WIDTH, true, 58), DOCKED_WIDTH);
  assert.equal(layerCorrectedWidth(DOCKED_WIDTH, false, 58), DOCKED_WIDTH);
  assert.equal(layerCorrectedWidth(LAYERED_WIDTH, true, null), LAYERED_WIDTH);
});

test("negative control + fix: a 1px window drag across the threshold flips exactly twice", async () => {
  const { dockWithHysteresis, learnLayerInset, layerCorrectedWidth } = await import("../src/workspace/dockGeometry.ts");
  const OVERSTATE = 58;
  const threshold = 960;
  const drag = (learn: boolean): number[] => {
    let docked: boolean | null = null;
    let memory: DockedWidthMemory | null = null;
    let inset: number | null = null;
    const flips: number[] = [];
    const sweep = [...Array.from({ length: 60 }, (_, i) => 1000 - i), ...Array.from({ length: 60 }, (_, i) => 941 + i)];
    for (const dockedWidth of sweep) {
      const shellKey = shellBoxKey(dockedWidth + 115, 49);
      // Two frames per window size: the reading in the current mode, then
      // the reading after the decision it produced.
      for (let frame = 0; frame < 2; frame++) {
        const layered = docked === false;
        const raw = layered ? dockedWidth + OVERSTATE : dockedWidth;
        if (learn) inset = learnLayerInset({ measuredWidth: raw, layered, shellKey, docked: memory, inset });
        const admission = dockAdmissionWidth({
          measuredWidth: learn ? layerCorrectedWidth(raw, layered, inset) : raw, dockedInFlow: !layered, shellKey, memory,
        });
        memory = admission.memory;
        const next = dockWithHysteresis({ width: admission.width, threshold, wasDocked: docked });
        if (docked !== null && next !== docked) flips.push(dockedWidth);
        docked = next;
      }
    }
    return flips;
  };
  assert.ok(drag(false).length > 10, "without the learned inset the drag oscillates");
  assert.deepEqual(drag(true), [threshold - 1, threshold + 24]);
});

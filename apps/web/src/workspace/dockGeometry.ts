// Dock admission input. `decideDock` judges a side dock from the
// post-sidebar workspace width (Chat + pane, launcher strip excluded). That
// number can only be read while the pane is docked in flow: once the pane is
// on the full-screen layer (or closed), the launcher strip floats over Chat's
// inline end, so Chat's box also spans the strip lane, its gap and the pane
// seam (~58px on desktop). Admitting from that wider box re-docks the pane,
// the docked box fails admission again, and the shell flips between dock and
// layer several times a second — the "huge flicker" when a focused profile
// (Tasks, IDE) pins its companion in a window just below the dock threshold.
//
// The rule: a docked-in-flow measurement is authoritative and remembered for
// the shell box it was taken in. While the pane is not docked in flow and the
// shell box (its width and the sidebar's) is unchanged, keep using that
// remembered docked width. A real geometry change — window resize, sidebar
// toggle or resize — changes the shell key and drops the memory, so the next
// measurement is judged fresh.

export interface DockedWidthMemory {
  /** Identity of the shell box the docked width was measured in. */
  shellKey: string;
  width: number;
}

export interface DockAdmissionWidthInput {
  /** This measurement: Chat's width plus the in-flow pane width (0 when not docked). */
  measuredWidth: number;
  /** The pane is a side dock in flow (pinned, not narrow, not on the layer). */
  dockedInFlow: boolean;
  /** `shellBoxKey(...)` of the current shell box. */
  shellKey: string;
  memory: DockedWidthMemory | null;
}

export interface DockAdmissionWidth {
  /** The width admission and the dock width are judged from. */
  width: number;
  memory: DockedWidthMemory | null;
}

/** Shell identity for the docked-width memory; rounded so sub-pixel layout
 *  noise does not count as a geometry change. */
export function shellBoxKey(shellWidth: number, sidebarWidth: number): string {
  return `${Math.round(shellWidth)}:${Math.round(sidebarWidth)}`;
}

/** Mode-independent admission width: see the module comment. */
export function dockAdmissionWidth(input: DockAdmissionWidthInput): DockAdmissionWidth {
  const width = Math.round(input.measuredWidth);
  if (input.dockedInFlow) {
    const memory = input.memory?.shellKey === input.shellKey && input.memory.width === width
      ? input.memory
      : { shellKey: input.shellKey, width };
    return { width, memory };
  }
  if (input.memory !== null && input.memory.shellKey === input.shellKey) {
    return { width: input.memory.width, memory: input.memory };
  }
  return { width, memory: null };
}

// Learned layer inset. The memory above only covers an unchanged shell box;
// a live window drag makes a fresh box every pixel, and a fresh reading on the
// layer overstates the docked width by the strip lane + seam + gap (58px on
// desktop) — far more than any hysteresis margin. The first dock → layer flip
// inside one box measures that overstatement exactly (layer reading minus the
// remembered docked width); later fresh layer readings subtract it. It is a
// property of the shell chrome, not of the window, so it survives resizes.

/** Upper bound for a plausible inset; anything larger is a different layout. */
const MAX_LAYER_INSET = 160;

export interface LayerInsetInput {
  /** Chat's width (+ in-flow pane width when docked) — the raw reading. */
  measuredWidth: number;
  /** The pane is on the full-screen layer (the reading overstates). */
  layered: boolean;
  shellKey: string;
  /** The docked-width memory BEFORE this reading is applied. */
  docked: DockedWidthMemory | null;
  inset: number | null;
}

/** Learn (or keep) the layer inset from a layer reading in a box whose docked
 *  width is remembered. */
export function learnLayerInset(input: LayerInsetInput): number | null {
  if (!input.layered || input.docked === null || input.docked.shellKey !== input.shellKey) return input.inset;
  const inset = Math.round(input.measuredWidth) - input.docked.width;
  return inset > 0 && inset <= MAX_LAYER_INSET ? inset : input.inset;
}

/** A layer reading corrected by the learned inset (docked readings pass). */
export function layerCorrectedWidth(measuredWidth: number, layered: boolean, inset: number | null): number {
  return layered && inset !== null ? measuredWidth - inset : measuredWidth;
}

// Hysteresis on top of the memory above. The memory removes the dock ⇄ layer
// flip inside one shell box; a live window drag still produces a fresh box
// every pixel, and a box right at the admission threshold must not alternate
// as it re-measures. A docked pane leaves only once the width drops below the
// threshold; a pane that left re-enters only above threshold + margin.

/** Re-entry margin above the dock threshold (px). */
export const DOCK_HYSTERESIS = 24;

export interface DockHysteresisInput {
  /** Mode-independent admission width (`dockAdmissionWidth().width`). */
  width: number;
  /** The smallest width that can hold both surfaces at their minimums. */
  threshold: number;
  /** The previous decision for this pane; null before the first one. */
  wasDocked: boolean | null;
  margin?: number;
}

/** First decision (null) admits at the threshold itself, so opening a pane
 *  behaves exactly as without hysteresis; only a re-entry pays the margin. */
export function dockWithHysteresis(input: DockHysteresisInput): boolean {
  const margin = input.margin ?? DOCK_HYSTERESIS;
  if (input.wasDocked === false) return input.width >= input.threshold + margin;
  return input.width >= input.threshold;
}

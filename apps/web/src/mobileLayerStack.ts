// DOM-free decisions for the phone layer stack: Chat → Workspace → package
// window. Components own the DOM and timers; these helpers only decide which
// role a layer plays so the Workspace, the package host and the native Back
// handler can never disagree about where Back leads.
//
//   Chat ◀── Workspace ◀── package window
//
// Back pops exactly one layer. Close (and a session switch) dismisses the
// whole stack. The Workspace stays mounted UNDER a package window, so Back
// reveals an already-rendered layer instead of mounting one mid-transition.

/** How the Workspace layer is presented right now (also its CSS hook). */
export type LayerStackPhase =
  /** Arrived from the inline-end edge over Chat. */
  | "enter"
  /** Another full-screen layer is on top: mounted, inert, retreated. */
  | "covered"
  /** Back from a package window: the layer settles from its retreat. */
  | "revealed";

/** The slice of store state that says whether a package window is on top. */
export interface PackageLayerState {
  railPlugin: string | null;
  activeView: string;
}

/** A package window is presented when a rail/pane surface or a non-Chat view is open. */
export function packageLayerPresented(state: PackageLayerState): boolean {
  return state.railPlugin !== null || state.activeView !== "session";
}

/**
 * The phase a freshly mounted Workspace layer starts in. It mounts covered
 * when it is only the idle underlay of a package that was opened from Chat,
 * and revealed when Back asked for it before that underlay existed (the package
 * is already leaving, so it must settle rather than slide in from the edge).
 */
export function workspaceEntryPhase(input: {
  packagePresented: boolean;
  packageWasPresented: boolean;
}): LayerStackPhase {
  if (input.packagePresented) return "covered";
  return input.packageWasPresented ? "revealed" : "enter";
}

/** Phase after a package appears or disappears above a mounted Workspace. */
export function nextWorkspacePhase(
  phase: LayerStackPhase,
  packagePresented: boolean,
): LayerStackPhase {
  if (packagePresented) return "covered";
  return phase === "covered" ? "revealed" : phase;
}

/**
 * Whether the Workspace layer should be mounted. Foreground when it is open
 * and nothing covers it. Under a package it keeps whatever is already
 * mounted and only adds the idle underlay once the package has finished
 * arriving, so opening a package never pays for a Workspace render mid-slide.
 */
export function workspaceLayerWanted(input: {
  phone: boolean;
  homeOpen: boolean;
  packagePresented: boolean;
  mounted: boolean;
  underlaySettled: boolean;
}): boolean {
  if (!input.phone) return false;
  if (!input.packagePresented) return input.homeOpen;
  return input.mounted || input.underlaySettled;
}

/** The layer the phone Back control (and native Back) pops next. */
export type PhoneBackTarget = "package" | "workspace" | null;

export function phoneBackTarget(input: {
  phone: boolean;
  homeOpen: boolean;
  packagePresented: boolean;
}): PhoneBackTarget {
  if (!input.phone) return null;
  if (input.packagePresented) return "package";
  return input.homeOpen ? "workspace" : null;
}

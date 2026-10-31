// How a wide window shares its height between the top bar and the side
// columns (Settings → Appearance → Window layout). One pure resolver decides
// where each former top-bar group lives; Header, Sidebar and ContextRail ask
// it instead of reading the preferences themselves, so a group is rendered
// in exactly one place. Tablet and phone widths always keep their headers.
import { useLayoutEffect } from "react";
import { useShellMode, type ShellMode } from "./responsiveShell.ts";
import {
  useUiSettings,
  type ShellBarStyle,
  type ShellDockSide,
  type ShellLayout,
  type UiSettings,
} from "./uiPrefs.ts";

/** Where a group of top-bar controls renders: the bar, a column, or nowhere. */
export type ShellHome = "bar" | ShellDockSide;
/** A column that can hold former top-bar controls: the navigator's
 *  (`start`) or the launcher strip (`end`). Logical, so a mirrored shell
 *  keeps each group with its column. */
export type ShellColumn = "start" | "end";

export interface ShellLayoutState {
  /** The layout in effect: `classic` below the wide shell. */
  layout: ShellLayout;
  /** The `columns` bar style; `spread` elsewhere. */
  barStyle: ShellBarStyle;
  /** Full-height columns float inside the window (not in `classic`). */
  floating: boolean;
  /** The top rail's tools. */
  tools: ShellHome;
  /** The header actions rail (search, notifications, …). */
  actions: ShellHome;
  /** The account menu: in the bar, or at the foot of a column. It travels
   *  with the header actions rail; hiding that rail leaves the account at the
   *  foot of the navigator, so its menu stays reachable. */
  account: "bar" | ShellColumn;
  /** The chat title shows (in the bar, or over the chat when bare). */
  title: boolean;
}

type ShellLayoutPrefs = Pick<UiSettings,
  "shellLayout" | "shellBarStyle" | "floatingColumns" | "shellToolsDock" | "shellActionsDock" | "shellTitle">;

const CLASSIC: ShellLayoutState = {
  layout: "classic",
  barStyle: "spread",
  floating: false,
  tools: "bar",
  actions: "bar",
  account: "bar",
  title: true,
};

export function resolveShellLayout(prefs: ShellLayoutPrefs, mode: ShellMode): ShellLayoutState {
  if (mode !== "wide" || prefs.shellLayout === "classic") return CLASSIC;
  if (prefs.shellLayout === "columns") {
    return {
      ...CLASSIC,
      layout: "columns",
      barStyle: prefs.shellBarStyle,
      floating: prefs.floatingColumns,
    };
  }
  return {
    layout: "bare",
    barStyle: "spread",
    floating: prefs.floatingColumns,
    tools: prefs.shellToolsDock,
    actions: prefs.shellActionsDock,
    account: prefs.shellActionsDock === "hidden" ? "start" : prefs.shellActionsDock,
    title: prefs.shellTitle === "chat",
  };
}

export function useShellLayout(): ShellLayoutState {
  const ui = useUiSettings();
  const mode = useShellMode();
  return resolveShellLayout(ui, mode);
}

/** The groups a column holds in the `bare` layout. */
export function shellColumnGroups(
  state: ShellLayoutState,
  column: ShellColumn,
): { tools: boolean; actions: boolean; account: boolean } {
  return { tools: state.tools === column, actions: state.actions === column, account: state.account === column };
}

/** Publish the layout in effect on <body> for CSS: `data-shell-layout`
 *  (classic | columns | bare), plus `data-shell-bar` and
 *  `data-shell-floating` while the columns run the full height. Owned by App
 *  so the attribute always matches the shell mode the DOM was rendered for. */
export function usePublishShellLayout(state: ShellLayoutState): void {
  useLayoutEffect(() => {
    const data = document.body.dataset;
    data.shellLayout = state.layout;
    if (state.layout === "classic") {
      delete data.shellBar;
      delete data.shellFloating;
    } else {
      data.shellBar = state.barStyle;
      data.shellFloating = String(state.floating);
    }
  }, [state.layout, state.barStyle, state.floating]);
  useLayoutEffect(() => () => {
    const data = document.body.dataset;
    delete data.shellLayout;
    delete data.shellBar;
    delete data.shellFloating;
  }, []);
}

/** A horizontal extent in viewport px (a DOMRect satisfies it). */
export interface ShellSpan { left: number; right: number }

/** How far the bar between full-height columns stops short of each side of
 *  the workspace lane. The right column overlays the workspace's edge — the
 *  idle launcher strip, and a floating package window beside it — so the bar
 *  ends one column gap before the nearest of those, as it starts one gap
 *  after the navigator; otherwise the window covers the bar's end (the title
 *  and the header actions). Overlays on the lane's start half reserve the
 *  start side (a mirrored shell). A pinned window takes its lane in flow, so
 *  it never overlaps the lane and reserves nothing. */
export function shellBarReserves(lane: ShellSpan, overlays: readonly ShellSpan[], gap: number): { left: number; right: number } {
  let left = 0;
  let right = 0;
  const middle = (lane.left + lane.right) / 2;
  for (const o of overlays) {
    if (o.right - o.left <= 0 || o.left >= lane.right || o.right <= lane.left) continue;
    if ((o.left + o.right) / 2 > middle) right = Math.max(right, lane.right - o.left + gap);
    else left = Math.max(left, o.right - lane.left + gap);
  }
  return { left: Math.max(0, Math.round(left)), right: Math.max(0, Math.round(right)) };
}

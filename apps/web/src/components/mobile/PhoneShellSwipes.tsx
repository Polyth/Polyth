// Chat-level phone swipes: a finger travelling toward the inline end pulls
// the Navigator in from the inline-start side, one travelling toward the
// inline start pulls the Workspace in from the inline-end side. Each surface
// mounts as a peek (shellSwipe.ts) the moment the swipe claims the touch,
// follows the finger, and on release either opens for real, carrying on from
// where the finger left it, or springs back and unmounts unseen.
//
// The release is a compositor animation started by the controller before
// anything else happens (swipeSurface.ts `settle`). Opening for real (a React
// commit that makes the surface modal, moves focus and marks Chat inert)
// follows one frame later, under a layer that is already moving, so its cost
// never shows as a pause between the finger and the settle.
//
// Mounted once for the phone shell. The listeners exist only while swipe
// navigation is on; whether a touch may start a swipe is decided per touch,
// because Chat must be the top layer (anything above it owns its gestures).
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { getShellMode, useShellMode } from "../../responsiveShell.ts";
import { getState, setRailPlugin, setSidebarOpen } from "../../store.ts";
import {
  getMobileWorkspaceNavigationSnapshot,
  hideMobileWorkspaceHome,
  showMobileWorkspaceHome,
} from "../../mobileWorkspaceNavigation.ts";
import { packageLayerPresented } from "../../mobileLayerStack.ts";
import { useUiSettings } from "../../uiPrefs.ts";
import { animateSettle, attachSwipeSurface, type SwipeSession, type SwipeStart } from "../../swipeSurface.ts";
import { chatSwipeAllowed, setSwipePeek, swipeZoneInHost, transientSurfaceOpen } from "../../shellSwipe.ts";

const NAVIGATOR = "#polyth-session-drawer";
const WORKSPACE_SHEET = ".sheet-backdrop[data-stack] > .workspace-panel-sheet";
/**
 * Marks a surface that arrived under the finger: its entrance animation must
 * not replay over the settle that brought it in (MobileNavigator.css,
 * stackNavigation.css).
 */
const ARRIVED = "rest";

function chatIsTop(): boolean {
  const state = getState();
  return chatSwipeAllowed({
    phone: getShellMode() === "phone",
    sidebarOpen: state.sidebarOpen,
    workspaceOpen: getMobileWorkspaceNavigationSnapshot().homeOpen,
    packagePresented: packageLayerPresented(state),
    overlay: state.overlay !== null,
    transientOpen: transientSurfaceOpen(document),
  });
}

/** Mount `target` as a peek right now, so the first frame of the drag can move it. */
function peekElement(target: "navigator" | "workspace", selector: string): HTMLElement | null {
  flushSync(() => setSwipePeek(target));
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) flushSync(() => setSwipePeek(null));
  return el;
}

/** The Navigator rides in from the inline-start side, its trailing edge under the finger's travel. */
function navigatorOpenSession({ rtl, width }: SwipeStart): SwipeSession | null {
  const nav = peekElement("navigator", NAVIGATOR);
  if (!nav) return null;
  nav.setAttribute("data-swiping", "true");
  const offset = (travel: number): number => (travel - width) * (rtl ? -1 : 1);
  const at = (travel: number): string => `translate3d(${offset(travel)}px, 0, 0)`;
  const clear = (): void => {
    nav.removeAttribute("data-swiping");
    nav.style.removeProperty("transform");
  };
  return {
    paint(travel) {
      nav.style.transform = at(travel);
    },
    settle(settle) {
      return animateSettle(nav, settle, (travel) => ({ transform: at(travel) }));
    },
    cancel() {
      // Unseen either way (the peek rests off-screen), so the unmount need not
      // be synchronous; it may also run from an effect cleanup.
      clear();
      setSwipePeek(null);
    },
    commit() {
      // The drawer is arriving (or, with motion off, simply lands): the open
      // state must not start an entrance of its own underneath.
      nav.setAttribute("data-swipe-handoff", ARRIVED);
      // The open state replaces the peek in one synchronous commit, so the
      // peek's resting position and the inline one go in the same task.
      flushSync(() => {
        setSwipePeek(null);
        hideMobileWorkspaceHome();
        setRailPlugin(null);
        setSidebarOpen(true);
      });
      clear();
    },
  };
}

/** The Workspace rides in from the inline-end side, the way its button-driven `stack-in` does. */
function workspaceOpenSession({ rtl, width }: SwipeStart): SwipeSession | null {
  const sheet = peekElement("workspace", WORKSPACE_SHEET);
  if (!sheet) return null;
  sheet.style.willChange = "transform";
  const offset = (travel: number): number => (width - travel) * (rtl ? -1 : 1);
  const at = (travel: number): string => `translate3d(${offset(travel)}px, 0, 0)`;
  const clear = (): void => {
    sheet.style.removeProperty("transform");
    sheet.style.removeProperty("will-change");
  };
  return {
    paint(travel) {
      sheet.style.transform = at(travel);
    },
    settle(settle) {
      return animateSettle(sheet, settle, (travel) => ({ transform: at(travel) }));
    },
    cancel() {
      // Off-screen again (or abandoned mid-drag): the layer host unmounts a
      // peek that never opened at once, without an exit.
      clear();
      setSwipePeek(null);
    },
    commit() {
      sheet.setAttribute("data-swipe-handoff", ARRIVED);
      flushSync(() => {
        setSwipePeek(null);
        showMobileWorkspaceHome();
      });
      clear();
    },
  };
}

export default function PhoneShellSwipes() {
  const phone = useShellMode() === "phone";
  const zone = swipeZoneInHost(useUiSettings().swipeNavigation);
  const zoneRef = useRef(zone);
  zoneRef.current = zone;
  const on = phone && zone !== null;

  useEffect(() => {
    if (!on) return;
    const surface = () => document.querySelector<HTMLElement>(".app");
    const currentZone = () => zoneRef.current ?? "edge";
    const enabled = () => zoneRef.current !== null && chatIsTop();
    const detachNavigator = attachSwipeSurface({
      surface,
      direction: "toward-end",
      zone: currentZone,
      enabled,
      // The Navigator's own entrance/exit is paced by --motion-surface.
      motion: "--motion-surface",
      begin: navigatorOpenSession,
    });
    const detachWorkspace = attachSwipeSurface({
      surface,
      direction: "toward-start",
      zone: currentZone,
      enabled,
      motion: "--motion-stack",
      begin: workspaceOpenSession,
    });
    return () => {
      detachNavigator();
      detachWorkspace();
    };
  }, [on]);

  return null;
}

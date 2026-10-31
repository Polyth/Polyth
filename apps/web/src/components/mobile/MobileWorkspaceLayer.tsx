// The phone Workspace as a layer in one stack: Chat → Workspace → package
// window (see mobileLayerStack.ts). This host mounts once for the whole phone
// shell — not inside either header, which swap as the active view changes — so
// the Workspace keeps its identity, scroll position and edit state while a
// package window is open above it. That is what makes Back a true pop: the
// layer it returns to is already rendered and only settles from its retreat.
//
// Presence is presentation-only, like every other phone surface: the layer
// stays mounted through its exit motion, a reopen cancels a pending unmount,
// and reduced-motion/low-resource modes release it immediately.
import { useEffect, useState, type RefObject } from "react";
import { useShellMode } from "../../responsiveShell.ts";
import { useStore } from "../../store.ts";
import { hideMobileWorkspaceHome, useMobileWorkspaceNavigation } from "../../mobileWorkspaceNavigation.ts";
import {
  nextWorkspacePhase,
  packageLayerPresented,
  workspaceEntryPhase,
  workspaceLayerWanted,
  type LayerStackPhase,
} from "../../mobileLayerStack.ts";
import { scheduleSurfaceExit } from "../../motionPresence.ts";
import { useSwipePeek } from "../../shellSwipe.ts";
import WorkspacePanel from "./WorkspacePanel.tsx";

/**
 * Focus returns to the control that opened the Workspace, wherever the current
 * header renders it. Resolved lazily: the trigger is remounted when the header
 * swaps between its chat and non-chat variants.
 */
const workspaceTrigger = {
  get current(): HTMLElement | null {
    return typeof document === "undefined"
      ? null
      : document.querySelector<HTMLElement>("[data-workspace-trigger]");
  },
} as RefObject<HTMLElement | null>;

function WorkspaceLayer({ entry, packagePresented, closing, peeking }: {
  entry: LayerStackPhase;
  packagePresented: boolean;
  closing: boolean;
  peeking: boolean;
}) {
  const [phase, setPhase] = useState<LayerStackPhase>(entry);
  // Derived during render so a package appearing/leaving never paints one
  // frame of the old phase.
  const next = nextWorkspacePhase(phase, packagePresented);
  if (next !== phase) setPhase(next);
  return (
    <WorkspacePanel
      onClose={hideMobileWorkspaceHome}
      closing={closing}
      peeking={peeking}
      stackPhase={next}
      restoreFocusRef={workspaceTrigger}
    />
  );
}

export default function MobileWorkspaceLayer() {
  const phone = useShellMode() === "phone";
  const { homeOpen } = useMobileWorkspaceNavigation();
  const packagePresented = useStore(packageLayerPresented);
  // A swipe from Chat mounts the layer while the finger pulls it in; it only
  // becomes the open Workspace when the swipe is released past the commit point.
  const peeking = useSwipePeek("workspace") && !homeOpen;
  const [mounted, setMounted] = useState(false);
  const [underlaySettled, setUnderlaySettled] = useState(false);
  // What the previous commit showed. It trails by one commit on purpose: the
  // render that mounts the layer must still see whether a package was on screen
  // a moment ago (Back before the idle underlay existed) to pick its entry.
  const [previousPresented, setPreviousPresented] = useState(packagePresented);
  useEffect(() => { setPreviousPresented(packagePresented); }, [packagePresented]);

  const wanted = workspaceLayerWanted({ phone, homeOpen: homeOpen || peeking, packagePresented, mounted, underlaySettled });
  // Until the Workspace actually opens, a layer mounted for a peek is only a
  // picture following the finger. An abandoned peek (already back off-screen)
  // leaves at once: no exit, and it never becomes the active modal, which
  // would take focus from Chat and hand it to the Tools button on unmount.
  const [peekOnly, setPeekOnly] = useState(false);
  if (peeking && !mounted && !peekOnly) setPeekOnly(true);
  if (peekOnly && (homeOpen || packagePresented)) setPeekOnly(false);

  // A package opened straight from Chat gets its idle Workspace underlay only
  // after it has finished arriving: mounting the Workspace mid-slide would put
  // a full render inside the animation's first frames.
  useEffect(() => {
    if (!phone || !packagePresented || homeOpen) {
      setUnderlaySettled(false);
      return;
    }
    return scheduleSurfaceExit(() => setUnderlaySettled(true), "--motion-stack");
  }, [phone, packagePresented, homeOpen]);

  useEffect(() => {
    if (wanted) {
      setMounted(true);
      return;
    }
    if (peekOnly) {
      setMounted(false);
      setPeekOnly(false);
      return;
    }
    if (!mounted) return;
    return scheduleSurfaceExit(() => setMounted(false), "--motion-stack");
  }, [wanted, mounted, peekOnly]);

  if (!phone || (!mounted && !wanted) || (peekOnly && !wanted)) return null;
  return (
    <WorkspaceLayer
      entry={workspaceEntryPhase({ packagePresented, packageWasPresented: previousPresented })}
      packagePresented={packagePresented}
      closing={mounted && !wanted}
      peeking={peeking}
    />
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Collapse host for the rows above the composer (harness transition, runtime
 * recovery). The dock lays its children out with no gap of its own, so a row
 * that appears or resolves animates its own height (grid-template-rows
 * 0fr↔1fr, `.composer-notice-row` in composerAdaptive.css) instead of popping
 * the dock. The last content stays mounted through the collapse and is
 * released afterwards. Reduced motion, the desktop reduce-motion setting and
 * the low-resource profile remove the transition.
 */
const NOTICE_ROW_EXIT_MS = 180; // --motion-normal

function noticesMotionDisabled(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.reduceAnimations === "true") return true;
  if (document.body?.dataset.desktopLowResource === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function ComposerNoticeRow({ open, children }: { open: boolean; children?: ReactNode }): ReactNode {
  const last = useRef<ReactNode>(null);
  if (open) last.current = children;
  const [present, setPresent] = useState(open);
  // Mount collapsed and expand on the next frame, so a row that appears grows
  // by the same transition that folds it away.
  const [entered, setEntered] = useState(open && noticesMotionDisabled());
  useEffect(() => {
    if (!open) {
      if (!present) return;
      const timer = setTimeout(() => {
        setPresent(false);
        setEntered(false);
      }, noticesMotionDisabled() ? 0 : NOTICE_ROW_EXIT_MS);
      return () => clearTimeout(timer);
    }
    setPresent(true);
    if (entered) return;
    if (noticesMotionDisabled()) {
      setEntered(true);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [open, present, entered]);
  if (!present) return null;
  return (
    <div
      className="composer-notice-row"
      data-open={open && entered ? "true" : "false"}
      aria-hidden={open ? undefined : true}
    >
      <div className="composer-notice-row-inner">{last.current}</div>
    </div>
  );
}

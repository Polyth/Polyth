// Touch selection dock: the phone take on the desktop selection toolbar
// (SelectionMenu.tsx). A floating toolbar beside a touch selection collides
// with the OS callout and the drag handles, so touch selections get a glass
// card docked to the bottom of the interaction frame instead: a quote preview
// that follows the handles live, then thumb-sized Quote / New session / Copy
// (and Share where the platform has a share sheet).
//
// The dock does not depend on the selection rect, so it stays put while the
// timeline scrolls. Swipe it down (or press Escape) to clear the selection.
// A tap on the dock can collapse the selection before its click lands on some
// engines, so the dock keeps its own copy of the text and ignores selection
// changes while a finger is on it or an action is still running.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { dockDragDismisses, dockDragOffset } from "../selectionActions.ts";
import { quoteSelectionInComposer, startSessionFromSelection } from "../selectionCommands.ts";
import { scheduleSurfaceExit } from "../motionPresence.ts";
import { errorFeedback, selectionFeedback, successFeedback, tapFeedback } from "../haptics.ts";
import { copyText } from "../utils.ts";
import { useStore } from "../store.ts";
import { tr } from "../i18n/index.ts";
import { isImeComposing } from "./input/editorCore.ts";
import {
  CheckIcon,
  CopyIcon,
  Icon,
  NewChatIcon,
  QuoteIcon,
  ShareIcon,
  VisuallyHidden,
  type LucideIcon,
} from "./ui/index.ts";
import "./SelectionDock.css";

/** Quiet time before a fresh selection summons the dock (long-press settle). */
const SETTLE_MS = 140;
/** How long a tap on the dock keeps selection changes from closing it. */
const HOLD_RELEASE_MS = 350;
/** Copy outcome stays on screen this long before the dock leaves. */
const COPY_FLASH_MS = 900;
const PREVIEW_CHARS = 280;
const DRAG_SLOP = 6;

type DockExit = "collapse" | "action" | "drag";

interface DockView {
  text: string;
  phase: "open" | "closing";
  exit?: DockExit;
}

interface DragState {
  id: number;
  x: number;
  y: number;
  lastY: number;
  lastT: number;
  velocity: number;
  offset: number;
  active: boolean;
}

interface DockAction {
  key: string;
  icon: LucideIcon;
  label: string;
  title: string;
  run: () => void;
  disabled?: boolean;
  primary?: boolean;
  state?: "done" | "failed";
}

function readSelection(container: HTMLElement | null): string | null {
  const sel = document.getSelection();
  if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const host = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!host || !container.contains(host)) return null;
  return sel.toString().trim() || null;
}

function clearSelection(): void {
  document.getSelection()?.removeAllRanges();
}

export default function SelectionDock({ container }: {
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const projectId = useStore((s) => s.activeProjectId);
  const [view, setView] = useState<DockView | null>(null);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(false);
  const holdRef = useRef(false);
  const busyRef = useRef(false);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef(0);
  const cancelExit = useRef<(() => void) | null>(null);
  const textRef = useRef("");
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const close = useCallback((exit: DockExit = "collapse") => {
    clearTimeout(settleTimer.current);
    cancelAnimationFrame(frame.current);
    if (!openRef.current) return;
    openRef.current = false;
    setView((v) => (v ? { ...v, phase: "closing", exit } : v));
    cancelExit.current?.();
    cancelExit.current = scheduleSurfaceExit(() => {
      cancelExit.current = null;
      setView(null);
      setCopied(null);
    });
  }, []);

  const open = useCallback((text: string) => {
    cancelExit.current?.();
    cancelExit.current = null;
    textRef.current = text;
    if (!openRef.current) {
      openRef.current = true;
      dockRef.current?.style.setProperty("--selection-dock-drag", "0px");
      setCopied(null);
      selectionFeedback();
    }
    setView((v) => (v?.phase === "open" && v.text === text ? v : { text, phase: "open" }));
  }, []);

  useEffect(() => {
    const sync = () => {
      if (holdRef.current || busyRef.current) return;
      const text = readSelection(container.current);
      if (!text) return close();
      if (openRef.current) {
        // Handles are moving: refresh the preview once per frame.
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => open(text));
        return;
      }
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        if (holdRef.current || busyRef.current) return;
        const settled = readSelection(container.current);
        if (settled) open(settled);
      }, SETTLE_MS);
    };
    const onKey = (e: KeyboardEvent) => {
      if (isImeComposing(e)) return;
      if (e.key !== "Escape" || !openRef.current) return;
      close("action");
      clearSelection();
    };
    document.addEventListener("selectionchange", sync);
    document.addEventListener("keydown", onKey);
    // A selection that already exists when the dock mounts (surface switch).
    sync();
    return () => {
      document.removeEventListener("selectionchange", sync);
      document.removeEventListener("keydown", onKey);
    };
  }, [close, container, open]);

  useEffect(() => () => {
    clearTimeout(settleTimer.current);
    clearTimeout(holdTimer.current);
    clearTimeout(flashTimer.current);
    cancelAnimationFrame(frame.current);
    cancelExit.current?.();
  }, []);

  if (!view) return null;

  const finish = (exit: DockExit = "action") => {
    close(exit);
    clearSelection();
  };

  // A tap may have collapsed the selection underneath the dock; once the
  // finger has been gone long enough for its click, follow the real selection.
  const releaseHold = () => {
    clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdRef.current = false;
      if (openRef.current && !busyRef.current && !readSelection(container.current)) close();
    }, HOLD_RELEASE_MS);
  };

  const quote = () => {
    tapFeedback();
    quoteSelectionInComposer(textRef.current);
    finish();
  };

  const newSession = () => {
    if (!projectId) return;
    tapFeedback();
    const text = textRef.current;
    finish();
    startSessionFromSelection(projectId, text);
  };

  const copy = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const ok = await copyText(textRef.current);
    if (ok) successFeedback();
    else errorFeedback();
    setCopied(ok ? "ok" : "failed");
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      busyRef.current = false;
      finish();
    }, COPY_FLASH_MS);
  };

  const share = async () => {
    if (busyRef.current || !canShare) return;
    busyRef.current = true;
    tapFeedback();
    try {
      await navigator.share({ text: textRef.current });
      busyRef.current = false;
      finish();
    } catch {
      // Dismissing the share sheet is not an error; keep the dock while the
      // selection is still there.
      busyRef.current = false;
      if (!readSelection(container.current)) close();
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (view.phase !== "open") return;
    // Like the desktop toolbar's mousedown guard: the dock never takes focus
    // or starts a selection of its own.
    e.preventDefault();
    clearTimeout(holdTimer.current);
    holdRef.current = true;
    suppressClickRef.current = false;
    dragRef.current = {
      id: e.pointerId, x: e.clientX, y: e.clientY,
      lastY: e.clientY, lastT: e.timeStamp, velocity: 0, offset: 0, active: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const el = e.currentTarget;
    const dy = e.clientY - d.y;
    if (!d.active) {
      if (Math.abs(dy) < DRAG_SLOP || Math.abs(dy) < Math.abs(e.clientX - d.x)) return;
      d.active = true;
      suppressClickRef.current = true;
      el.setPointerCapture?.(e.pointerId);
      el.dataset.dragging = "true";
    }
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.velocity = 0.7 * ((e.clientY - d.lastY) / dt) + 0.3 * d.velocity;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    d.offset = dockDragOffset(dy);
    el.style.setProperty("--selection-dock-drag", `${d.offset}px`);
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    releaseHold();
    if (!d.active) return;
    const el = e.currentTarget;
    delete el.dataset.dragging;
    if (e.type === "pointerup" && dockDragDismisses(d.offset, d.velocity, el.offsetHeight)) {
      tapFeedback();
      finish("drag");
    } else {
      // Spring back through the transform transition.
      el.style.setProperty("--selection-dock-drag", "0px");
    }
  };

  const actions: DockAction[] = [
    {
      key: "quote",
      icon: QuoteIcon,
      label: tr("selectionmenu.quote"),
      title: tr("selectionmenu.quoteTheSelectionInTheComposer"),
      run: quote,
      primary: true,
    },
    {
      key: "session",
      icon: NewChatIcon,
      label: tr("selectionmenu.newSession"),
      title: tr("selectionmenu.startANewSessionWithThisSelection"),
      run: newSession,
      disabled: !projectId,
    },
    {
      key: "copy",
      icon: copied === "ok" ? CheckIcon : CopyIcon,
      label: copied === "ok"
        ? tr("selectionmenu.copiedLabel")
        : copied === "failed" ? tr("selectionmenu.copyFailed") : tr("common.copy"),
      title: tr("selectionmenu.copyTheSelection"),
      run: () => void copy(),
      state: copied === "ok" ? "done" : copied === "failed" ? "failed" : undefined,
    },
  ];
  if (canShare) {
    actions.push({
      key: "share",
      icon: ShareIcon,
      label: tr("selectionmenu.share"),
      title: tr("selectionmenu.shareTheSelection"),
      run: () => void share(),
    });
  }

  const preview = view.text.replace(/\s+/g, " ").slice(0, PREVIEW_CHARS);

  return createPortal(
    <div className="selection-dock-frame">
      <div
        ref={dockRef}
        className="selection-dock"
        role="toolbar"
        aria-label={tr("selectionmenu.selectionActions")}
        data-phase={view.phase}
        data-exit={view.exit}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onMouseDown={(e) => e.preventDefault()}
        onClickCapture={(e) => {
          if (!suppressClickRef.current) return;
          suppressClickRef.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <span className="selection-dock-grabber" aria-hidden="true" />
        <div className="selection-dock-preview" aria-hidden="true">
          <p className="selection-dock-preview-text" dir="auto">{preview}</p>
        </div>
        <div className="selection-dock-actions">
          {actions.map((action, index) => (
            <button
              key={action.key}
              type="button"
              className="selection-dock-action"
              style={{ "--selection-dock-i": index } as React.CSSProperties}
              data-primary={action.primary ? "true" : undefined}
              data-state={action.state}
              title={action.title}
              disabled={action.disabled}
              onClick={action.run}
            >
              <span className="selection-dock-action-icon" key={action.state ?? "idle"}>
                <Icon icon={action.icon} size="md" />
              </span>
              <span className="selection-dock-action-label">{action.label}</span>
            </button>
          ))}
        </div>
        <VisuallyHidden>
          <span aria-live="polite">
            {copied === "ok" ? tr("selectionmenu.copied") : copied === "failed" ? tr("selectionmenu.copyFailed") : ""}
          </span>
        </VisuallyHidden>
      </div>
    </div>,
    document.body,
  );
}

// Selection quick actions: select transcript text and a
// floating mini-menu appears — Quote in reply (markdown-quotes into the
// composer), New session (the quote becomes a fresh session's draft; nothing
// is sent), and Copy. Buttons act on mousedown so the selection is still
// alive when the handler runs; scrolling the timeline hides the menu instead
// of chasing the selection rect. Touch and pen selections (and the phone
// shell before any pointer is seen) get SelectionDock instead: a bottom card
// that does not collide with the OS selection callout.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { clampMenuPosition, selectionSurface } from "../selectionActions.ts";
import { quoteSelectionInComposer, startSessionFromSelection } from "../selectionCommands.ts";
import { useShellMode } from "../responsiveShell.ts";
import { copyText } from "../utils.ts";
import { useTimelineProjectId } from "../timelineSession.ts";
import { tr } from "../i18n/index.ts";
import { Button } from "./ui/index.ts";
import SelectionDock from "./SelectionDock.tsx";

const MENU_W = 270;
const MENU_H = 34;

interface MenuState {
  x: number;
  y: number;
  text: string;
}

// The pointer type of the latest press decides the surface, so a touch laptop
// gets the dock for a finger selection and the toolbar for a mouse drag.
let lastPointerType: string | null = null;
const pointerListeners = new Set<() => void>();

function onPointerDown(e: PointerEvent): void {
  if (e.pointerType === lastPointerType) return;
  lastPointerType = e.pointerType;
  for (const listener of pointerListeners) listener();
}

function subscribePointerType(listener: () => void): () => void {
  if (pointerListeners.size === 0) {
    document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  }
  pointerListeners.add(listener);
  return () => {
    pointerListeners.delete(listener);
    if (pointerListeners.size === 0) {
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    }
  };
}

export default function SelectionMenu({ container }: {
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const shellMode = useShellMode();
  const pointerType = useSyncExternalStore(subscribePointerType, () => lastPointerType, () => null);
  return selectionSurface(shellMode, pointerType) === "dock"
    ? <SelectionDock container={container} />
    : <FloatingSelectionMenu container={container} />;
}

function FloatingSelectionMenu({ container }: {
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const projectId = useTimelineProjectId();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [flash, setFlash] = useState("");

  const compute = useCallback(() => {
    const el = container.current;
    const sel = document.getSelection();
    if (!el || !sel || sel.isCollapsed || sel.rangeCount === 0) return setMenu(null);
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const host = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!host || !el.contains(host)) return setMenu(null);
    const text = sel.toString().trim();
    if (!text) return setMenu(null);
    const rect = range.getBoundingClientRect();
    const pos = clampMenuPosition(
      rect.left + rect.width / 2 - MENU_W / 2, rect.top - MENU_H - 10,
      MENU_W, MENU_H, window.innerWidth, window.innerHeight,
    );
    setMenu({ x: pos.x, y: pos.y, text });
  }, [container]);

  useEffect(() => {
    // mouseup/keyup catch drag- and Shift+Arrow-selections once they settle;
    // selectionchange only hides (a live drag would thrash the position).
    const settle = () => setTimeout(compute, 0);
    const onSelectionChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) setMenu(null);
    };
    const hide = () => setMenu(null);
    const el = container.current;
    document.addEventListener("mouseup", settle);
    document.addEventListener("keyup", settle);
    document.addEventListener("selectionchange", onSelectionChange);
    el?.addEventListener("scroll", hide);
    return () => {
      document.removeEventListener("mouseup", settle);
      document.removeEventListener("keyup", settle);
      document.removeEventListener("selectionchange", onSelectionChange);
      el?.removeEventListener("scroll", hide);
    };
  }, [compute, container]);

  if (!menu) return null;

  const dismiss = () => {
    document.getSelection()?.removeAllRanges();
    setMenu(null);
  };

  const quote = () => {
    quoteSelectionInComposer(menu.text);
    dismiss();
  };

  const newSession = () => {
    if (!projectId) return;
    const { text } = menu;
    dismiss();
    startSessionFromSelection(projectId, text);
  };

  const copy = async () => {
    const ok = await copyText(menu.text);
    setFlash(ok ? tr("selectionmenu.copied") : tr("selectionmenu.copyFailed"));
    setTimeout(() => { setFlash(""); setMenu(null); }, 900);
  };

  return (
    <div
      className="selection-menu"
      role="toolbar"
      aria-label={tr("selectionmenu.selectionActions")}
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {flash
        ? <span className="selection-menu-flash">{flash}</span>
        : (
          <>
            <Button size="sm" variant="ghost" title={tr("selectionmenu.quoteTheSelectionInTheComposer")} onClick={quote}>{tr("selectionmenu.quoteInReply")}</Button>
            <Button size="sm" variant="ghost" title={tr("selectionmenu.startANewSessionWithThisSelection")} onClick={newSession} disabled={!projectId}>{tr("selectionmenu.newSession")}</Button>
            <Button size="sm" variant="ghost" title={tr("selectionmenu.copyTheSelection")} onClick={() => void copy()}>{tr("common.copy")}</Button>
          </>
        )}
    </div>
  );
}

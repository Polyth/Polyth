// F3 selection quick actions (OC#283, OC#1501): select transcript text and a
// floating mini-menu appears — Quote in reply (markdown-quotes into the
// composer), New session (the quote becomes a fresh session's draft; nothing
// is sent), and Copy. Buttons act on mousedown so the selection is still
// alive when the handler runs; scrolling the timeline hides the menu instead
// of chasing the selection rect.
import { useCallback, useEffect, useState } from "react";
import { clampMenuPosition, quoteForReply, selectionTitle } from "../selectionActions.ts";
import { requestComposerInsert } from "../composerInsert.ts";
import { copyText } from "../utils.ts";
import { startNewSession, useStore } from "../store.ts";
import { tr } from "../i18n/index.ts";

const MENU_W = 270;
const MENU_H = 34;

interface MenuState {
  x: number;
  y: number;
  text: string;
}

export default function SelectionMenu({ container }: {
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const projectId = useStore((s) => s.activeProjectId);
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
    requestComposerInsert(quoteForReply(menu.text));
    dismiss();
  };

  // Same bootstrap pattern as GithubView "+ session": the context lands as the
  // new session's draft (saved before it opens) — nothing is sent.
  const newSession = () => {
    if (!projectId) return;
    const { text } = menu;
    dismiss();
    startNewSession(projectId, {
      title: selectionTitle(text),
      draft: quoteForReply(text),
    });
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
            <button className="small-btn" title={tr("selectionmenu.quoteTheSelectionInTheComposer")} onClick={quote}>{tr("selectionmenu.quoteInReply")}</button>
            <button className="small-btn" title={tr("selectionmenu.startANewSessionWithThisSelection")} onClick={newSession} disabled={!projectId}>{tr("selectionmenu.newSession")}</button>
            <button className="small-btn" title={tr("selectionmenu.copyTheSelection")} onClick={() => void copy()}>{tr("common.copy")}</button>
          </>
        )}
    </div>
  );
}

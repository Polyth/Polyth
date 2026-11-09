// The way from one bookmark to the next: one line above the composer while a
// walk is on. It stays out of the transcript and folds away when the walk ends.
import { useEffect, type KeyboardEvent, type ReactNode } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, IconButton } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { placesOf, setBookmarkWalk, useBookmarkWalk, useSessionBookmarks } from "./client.ts";
import { openBookmarksPane, reportMissingPlace, revealBookmark } from "./commands.ts";

export default function WalkBar({ host, sessionId }: { host: WebPackageHost; sessionId: string | null }) {
  const walk = useBookmarkWalk();
  const places = placesOf(useSessionBookmarks(sessionId));
  const index = walk && walk.sessionId === sessionId ? places.findIndex((place) => place.id === walk.activeId) : -1;
  const showing = index >= 0;
  const active = showing ? places[index]! : null;
  const NoticeRow = host.ui.components.ComposerNoticeRow;
  const fold = (open: boolean, children?: ReactNode) => (NoticeRow
    ? <NoticeRow open={open}>{children}</NoticeRow>
    : open ? children ?? null : null);

  const step = async (by: -1 | 1) => {
    const next = places[index + by];
    if (!next || !sessionId) return;
    setBookmarkWalk({ sessionId, activeId: next.id });
    if (!await revealBookmark(host, next, false)) reportMissingPlace(host);
  };

  // A fine pointer's reader keeps both hands on the keyboard. Only while a walk
  // is on, so the keys stay the composer's otherwise.
  useEffect(() => {
    if (!showing) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      void step(event.key === "ArrowDown" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!active) return fold(false);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    setBookmarkWalk(null);
  };
  return fold(true, (
    <div className="bm-walk" role="toolbar" aria-label={tr("bookmarks.walk.label")} onKeyDown={onKeyDown}>
      <button type="button" className="bm-walk-open" onClick={() => openBookmarksPane(host)}>
        <span className="bm-walk-at">{tr("bookmarks.walk.position", { index: index + 1, total: places.length })}</span>
        <bdi className="bm-walk-title">{active.title}</bdi>
      </button>
      <IconButton icon={ChevronUpIcon} label={tr("bookmarks.walk.previous")} size="sm" variant="ghost" disabled={index === 0} onClick={() => void step(-1)} />
      <IconButton icon={ChevronDownIcon} label={tr("bookmarks.walk.next")} size="sm" variant="ghost" disabled={index === places.length - 1} onClick={() => void step(1)} />
      <IconButton icon={CloseIcon} label={tr("bookmarks.walk.end")} size="sm" variant="ghost" onClick={() => setBookmarkWalk(null)} />
    </div>
  ));
}

// Attachment pills — removable in the composer, read-only on timeline
// user messages. Images and browser contexts show a thumbnail when available;
// a file names its type with its extension instead of a glyph. A composer may
// keep a removed card's place as a restore slot (`removed` / `onRestore`).
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import type { AttachmentRef } from "@polyth/contracts";
import { browserContextHostPath } from "@polyth/contracts";
import { browserContextChipTitle, PASTED_TEXT_NAME } from "../attachments.ts";
import { THUMB_RETRY_DELAYS_MS, thumbQueue } from "../attachmentThumbQueue.ts";
import { isBlockedAttachment } from "../composer/history.ts";
import { formatNumber, tr } from "../i18n/index.ts";
import { Icon } from "../icons.tsx";
import { motionIsReduced } from "../motionPresence.ts";
import AttachmentPreview from "./AttachmentPreview.tsx";
import { HistoryIcon } from "./ui/icons.ts";

const KIND_ICONS: Record<string, () => ReactElement> = {
  file: Icon.file,
  image: Icon.image,
  range: Icon.events,
  url: Icon.link,
  "browser-context": Icon.globe,
};

function fmtSize(n: number): string {
  if (n <= 0) return "";
  if (n < 1024) return `${formatNumber(n)} B`;
  if (n < 1048576) {
    return `${formatNumber(n / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  }
  return `${formatNumber(n / 1048576, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  const ext = name.slice(dot + 1);
  return ext.length <= 5 ? ext.toUpperCase() : "";
}

function urlHost(url: string | undefined): string {
  if (!url) return "";
  try { return new URL(url).host; } catch { return ""; }
}

function parentDir(path: string | undefined): string {
  if (!path) return "";
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
}

/** The extension a file card shows as its type; empty for every other card. */
function typeLabel(a: AttachmentRef, kind: string, blocked: boolean): string {
  return kind === "file" && !blocked && a.name !== PASTED_TEXT_NAME ? fileExtension(a.name) : "";
}

/** Card copy: a readable title plus one quiet line of type/size/location. */
function cardText(a: AttachmentRef, kind: string, blocked: boolean): { title: string; meta: string } {
  if (kind === "browser-context") {
    const ctx = a.browserContext;
    return { title: ctx ? browserContextChipTitle(ctx) : a.name, meta: ctx ? browserContextHostPath(ctx.url) : "" };
  }
  const pasted = a.name === PASTED_TEXT_NAME;
  const title = pasted ? tr("attachmentpills.pastedText") : a.name;
  if (blocked) return { title, meta: tr("attachmentpills.unavailable") };
  if (kind === "url") return { title, meta: urlHost(a.url) };
  if (kind === "range") return { title, meta: parentDir(a.path) };
  const size = fmtSize(a.size);
  // A file's type is its card's glyph; an image the tile cannot show keeps it here.
  const type = kind === "file" || pasted ? "" : fileExtension(a.name);
  return { title, meta: [type, size].filter(Boolean).join(" · ") };
}

/** Composer strips: which cards arrived after the strip was first drawn (they
 *  enter on their own, composerAdaptive.css), whether the row is scrolled
 *  away from either edge (the edges fade), and a scroll to a card that
 *  arrives past the visible end. */
function useLiveStrip(attachments: AttachmentRef[], live: boolean) {
  const strip = useRef<HTMLDivElement | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  const revealed = useRef<string | undefined>(undefined);
  if (live) {
    if (seen.current === null) seen.current = new Set(attachments.map((a) => a.id));
    for (const a of attachments) if (!seen.current.has(a.id)) fresh.current.add(a.id);
  }
  const newest = live ? attachments.findLast((a) => fresh.current.has(a.id))?.id : undefined;

  useLayoutEffect(() => {
    const el = strip.current;
    if (!live || !el) return;
    const mark = () => {
      // Inline offset from the start edge; RTL scrolls with a negative scrollLeft.
      const offset = Math.abs(el.scrollLeft);
      el.toggleAttribute("data-overflow-start", offset > 1);
      el.toggleAttribute("data-overflow-end", offset + el.clientWidth < el.scrollWidth - 1);
    };
    mark();
    el.addEventListener("scroll", mark, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(mark) : null;
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", mark);
      observer?.disconnect();
    };
  }, [live]);

  useLayoutEffect(() => {
    for (const a of attachments) seen.current?.add(a.id);
    const el = strip.current;
    // Once per arrival: removing another card must not scroll the row again.
    if (!live || !el || !newest || newest === revealed.current) return;
    revealed.current = newest;
    if (el.scrollWidth <= el.clientWidth) return;
    const rtl = getComputedStyle(el).direction === "rtl";
    el.scrollTo({ left: rtl ? -el.scrollWidth : el.scrollWidth, behavior: motionIsReduced() ? "auto" : "smooth" });
  }, [attachments, live, newest]);

  return { strip, fresh: fresh.current };
}

/** How far past the screen a tile starts loading, so a scroll finds it ready. */
const THUMB_NEAR_SCREEN = "400px";

/** A tile's picture: starts near the screen, waits its turn in the page's queue,
 *  and tries again after a dropped transfer (see attachmentThumbQueue.ts). */
function AttachmentThumb({ url }: { url: string }) {
  const element = useRef<HTMLImageElement | null>(null);
  const release = useRef<(() => void) | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const finish = () => {
    release.current?.();
    release.current = null;
  };

  useEffect(() => {
    const img = element.current;
    if (!img) return;
    const start = () => {
      release.current = thumbQueue.request(() => setSrc(url));
    };
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        start();
      }, { rootMargin: THUMB_NEAR_SCREEN });
      observer.observe(img);
    } else {
      start();
    }
    return () => {
      observer?.disconnect();
      finish();
      // Leaving the chat also stops a download still under way: it would keep
      // its socket from the chat the person went to.
      if (!img.complete) img.removeAttribute("src");
      setSrc(undefined);
    };
  }, [url, attempt]);

  useEffect(() => () => {
    if (retry.current) clearTimeout(retry.current);
  }, []);

  return (
    <img
      ref={element}
      className="att-thumb"
      src={src}
      alt=""
      decoding="async"
      onLoad={finish}
      onError={() => {
        finish();
        setSrc(undefined);
        const delay = THUMB_RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) retry.current = setTimeout(() => setAttempt((value) => value + 1), delay);
      }}
    />
  );
}

/** A removed card's restore slot: the width the card had, and whether the
 *  slot is already on its way out. */
export interface RemovedAttachmentSlot {
  width: number;
  leaving: boolean;
}

/** A click this soon after the removal is the same slip's second click (a
 *  double click on remove), not a wish to put the file back. */
const RESTORE_GUARD_MS = 400;

export default function AttachmentPills({ attachments, onRemove, removed, onRestore }: {
  attachments: AttachmentRef[];
  /** Present = composer mode (removable); absent = read-only timeline render.
   *  `width` is the card's, for a restore slot that keeps its place. */
  onRemove?: (id: string, width: number) => void;
  /** Cards of `attachments` the person removed that can still be put back, by
   *  id: each is drawn as a restore button in the card's place. */
  removed?: ReadonlyMap<string, RemovedAttachmentSlot>;
  onRestore?: (id: string) => void;
}) {
  const [previewAt, setPreviewAt] = useState<number | null>(null);
  const { strip, fresh } = useLiveStrip(attachments, Boolean(onRemove));
  const removedAt = useRef(new Map<string, number>());
  // Keyboard focus follows the card: from its remove button to the slot's
  // restore button, and from there back to the card.
  const focusNext = useRef<{ id: string; target: ".att-restore" | ".attachment-open" } | null>(null);
  useLayoutEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    focusNext.current = null;
    const card = [...strip.current?.children ?? []].find((child) => (child as HTMLElement).dataset.attachment === next.id);
    card?.querySelector<HTMLElement>(next.target)?.focus();
  });
  if (attachments.length === 0) return null;
  // The preview pages through the cards that are there, not the restore slots.
  const shown = removed?.size ? attachments.filter((a) => !removed.has(a.id)) : attachments;
  let shownIndex = -1;
  return (
    <>
      <div ref={strip} className="attachment-pills" aria-label={tr("attachmentpills.attachments")}>
        {attachments.map((a, i) => {
          const kind = a.kind ?? "file";
          const blocked = kind !== "browser-context" && isBlockedAttachment(a);
          const { title, meta } = cardText(a, kind, blocked);
          const imagePreview = kind === "image" && a.url && !blocked;
          const slot = removed?.get(a.id);
          if (slot) {
            return (
              <span
                key={a.id || i}
                data-attachment={a.id}
                className={`attachment-pill att-${kind}${imagePreview ? " att-tile" : ""} att-removed${slot.leaving ? " att-leaving" : ""}`}
                style={{ "--att-w": `${slot.width}px` } as CSSProperties}
                inert={slot.leaving ? true : undefined}
              >
                <button
                  type="button"
                  className="att-restore"
                  aria-label={tr("attachmentpills.restoreAttachmentValue", { name: title })}
                  title={tr("attachmentpills.restoreAttachmentValue", { name: title })}
                  onClick={(event) => {
                    if (event.timeStamp - (removedAt.current.get(a.id) ?? -Infinity) < RESTORE_GUARD_MS) return;
                    if (document.activeElement === event.currentTarget) focusNext.current = { id: a.id, target: ".attachment-open" };
                    onRestore?.(a.id);
                  }}
                >
                  {/* The slot puts back what was just removed, so it wears a
                      rewind in time (rotate-ccw-clock): undo is the editor's and
                      the message revert's action. */}
                  <span className="att-icon" aria-hidden><HistoryIcon /></span>
                  {!imagePreview && (
                    <span className="att-text">
                      <span className="att-name">{tr("attachmentpills.restore")}</span>
                      <span className="att-meta">{title}</span>
                    </span>
                  )}
                </button>
              </span>
            );
          }
          shownIndex += 1;
          const at = shownIndex;
          const type = typeLabel(a, kind, blocked);
          const detail = kind === "url" ? a.url : kind === "browser-context" ? meta : a.path;
          const KindIcon = KIND_ICONS[kind] ?? Icon.file;
          const LeadIcon = a.name === PASTED_TEXT_NAME ? Icon.text : KindIcon;
          const body = imagePreview ? <AttachmentThumb url={a.url!} /> : (
            <>
              {kind === "browser-context" && a.url
                ? <AttachmentThumb url={a.url} />
                : type
                  ? <span className="att-icon att-type" aria-hidden>{type}</span>
                  : <span className="att-icon" aria-hidden><LeadIcon /></span>}
              <span className="att-text" title={detail ? `${title} · ${detail}` : title}>
                <span className="att-name">{title}</span>
                {meta && <span className="att-meta">{meta}</span>}
              </span>
            </>
          );
          return (
            <span
              key={a.id || i}
              data-attachment={a.id}
              className={`attachment-pill att-${kind}${imagePreview ? " att-tile" : ""}${blocked ? " att-unavailable" : ""}${fresh.has(a.id) ? " att-fresh" : ""}`}
              style={onRemove ? { "--att-i": i } as CSSProperties : undefined}
            >
              {blocked ? (
                <span
                  className="attachment-open"
                  aria-label={tr("attachmentpills.unavailableAttachmentValue", { name: a.name })}
                  title={tr("attachmentpills.unavailableAttachmentValue", { name: a.name })}
                >{body}</span>
              ) : (
                <button
                  type="button"
                  className="attachment-open"
                  aria-haspopup="dialog"
                  aria-label={tr("attachmentpills.previewAttachmentValue", { name: title })}
                  title={tr("attachmentpills.previewAttachmentValue", { name: title })}
                  onClick={() => setPreviewAt(at)}
                >{body}</button>
              )}
              {onRemove && (
                <button
                  type="button"
                  className="att-remove"
                  aria-label={tr("attachmentpills.removeAttachmentValue", { name: title })}
                  title={tr("attachmentpills.removeAttachment")}
                  onClick={(event) => {
                    const card = event.currentTarget.parentElement;
                    removedAt.current.set(a.id, event.timeStamp);
                    if (onRestore && event.currentTarget.matches(":focus-visible")) focusNext.current = { id: a.id, target: ".att-restore" };
                    onRemove(a.id, card?.getBoundingClientRect().width ?? 0);
                  }}
                ><span className="att-remove-glyph" aria-hidden><Icon.close /></span></button>
              )}
            </span>
          );
        })}
      </div>
      {previewAt !== null && shown[previewAt] && (
        <AttachmentPreview attachments={shown} start={previewAt} onClose={() => setPreviewAt(null)} />
      )}
    </>
  );
}

// Attachment pills — removable in the composer, read-only on timeline
// user messages. Images and browser contexts show a thumbnail when available;
// a file names its type with its extension instead of a glyph.
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

export default function AttachmentPills({ attachments, onRemove }: {
  attachments: AttachmentRef[];
  /** Present = composer mode (removable); absent = read-only timeline render. */
  onRemove?: (id: string) => void;
}) {
  const [previewAt, setPreviewAt] = useState<number | null>(null);
  const { strip, fresh } = useLiveStrip(attachments, Boolean(onRemove));
  if (attachments.length === 0) return null;
  const preview = previewAt === null ? null : attachments[previewAt];
  return (
    <>
      <div ref={strip} className="attachment-pills" aria-label={tr("attachmentpills.attachments")}>
        {attachments.map((a, i) => {
          const kind = a.kind ?? "file";
          const blocked = kind !== "browser-context" && isBlockedAttachment(a);
          const { title, meta } = cardText(a, kind, blocked);
          const type = typeLabel(a, kind, blocked);
          const detail = kind === "url" ? a.url : kind === "browser-context" ? meta : a.path;
          const imagePreview = kind === "image" && a.url && !blocked;
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
                  onClick={() => setPreviewAt(i)}
                >{body}</button>
              )}
              {onRemove && (
                <button
                  type="button"
                  className="att-remove"
                  aria-label={tr("attachmentpills.removeAttachmentValue", { name: title })}
                  title={tr("attachmentpills.removeAttachment")}
                  onClick={() => onRemove(a.id)}
                ><span className="att-remove-glyph" aria-hidden><Icon.close /></span></button>
              )}
            </span>
          );
        })}
      </div>
      {preview && previewAt !== null && (
        <AttachmentPreview attachments={attachments} start={previewAt} onClose={() => setPreviewAt(null)} />
      )}
    </>
  );
}

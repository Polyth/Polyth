// Full-screen media viewer for composer/timeline attachments, tool images and
// Markdown images. The file is the content: no filename chrome, one large
// close control, and a slider (arrows, swipe, keyboard, thumbnail strip) when
// there is more than one item.
//
// Touch follows the finger: a sideways drag moves the item and a release
// past the commit point carries it off the edge while the next one rides in
// from the other (swipeSurface.ts); a downward drag pulls the item away while
// the dim behind it lifts, and a release dismisses the viewer from there
// (sheetDrag.ts) or springs it back. An image also pinches, double-taps and
// drags to zoom (mediaZoom.ts); while it is zoomed the paging and the pull
// stand aside. The stage takes no native panning (`touch-action: none`), so
// the browser never scrolls or bounces the page under these drags.
import { useEffect, useRef, useState } from "react";
import type { AttachmentRef } from "@polyth/contracts";
import A11yDialog from "./a11y/Dialog.tsx";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, DownloadIcon, ExternalLinkIcon, IconButton } from "./ui/index.ts";
import { buttonClassName } from "./ui/buttonClassName.ts";
import { tr } from "../i18n/index.ts";
import { attachSwipeSurface } from "../swipeSurface.ts";
import { attachSheetDrag } from "../sheetDrag.ts";
import { leaveExitGhost } from "../exitGhost.ts";
import { attachMediaZoom, type MediaZoom } from "../mediaZoom.ts";
import type { InlineDirection } from "../mobileGestures.ts";

const TEXT_EXTENSIONS = /\.(?:c|cc|cpp|css|csv|go|h|hpp|html?|java|js|jsx|json|log|md|mjs|py|rb|rs|scss|sh|sql|svg|toml|ts|tsx|txt|vue|xml|yaml|yml)$/i;
const VIDEO_EXTENSIONS = /\.(?:m4v|mov|mp4|ogv|webm)$/i;
const AUDIO_EXTENSIONS = /\.(?:aac|flac|m4a|mp3|oga|ogg|wav|weba)$/i;
const MAX_TEXT_PREVIEW = 512 * 1024;

type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "link" | "unsupported";

function previewKind(attachment: AttachmentRef): PreviewKind {
  if (attachment.kind === "url") return "link";
  if (attachment.kind === "browser-context") {
    return attachment.url ? "image" : "unsupported";
  }
  if (attachment.kind === "image" || attachment.mime.startsWith("image/")) return "image";
  if (attachment.mime.startsWith("video/") || VIDEO_EXTENSIONS.test(attachment.name)) return "video";
  if (attachment.mime.startsWith("audio/") || AUDIO_EXTENSIONS.test(attachment.name)) return "audio";
  if (attachment.mime === "application/pdf") return "pdf";
  if (attachment.mime.startsWith("text/") || TEXT_EXTENSIONS.test(attachment.name)) return "text";
  return "unsupported";
}

/** Short type badge ("PDF", "TS") for items without a visual thumbnail. */
function typeBadge(attachment: AttachmentRef, kind: PreviewKind): string {
  if (kind === "link") return "URL";
  const ext = /\.([a-z0-9]{1,4})$/i.exec(attachment.name)?.[1];
  return (ext ?? kind.slice(0, 4)).toUpperCase();
}

function TextPreview({ attachment }: { attachment: AttachmentRef }) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; text: string }>({
    status: "loading",
    text: "",
  });

  useEffect(() => {
    const controller = new AbortController();
    if (!attachment.url) {
      setState({ status: "error", text: "" });
      return () => controller.abort();
    }
    setState({ status: "loading", text: "" });
    void fetch(attachment.url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => setState({
        status: "ready",
        text: text.length > MAX_TEXT_PREVIEW ? `${text.slice(0, MAX_TEXT_PREVIEW)}\n…` : text,
      }))
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setState({ status: "error", text: "" });
      });
    return () => controller.abort();
  }, [attachment.url]);

  if (state.status === "loading") return <div className="attachment-preview-state">{tr("common.loading")}</div>;
  if (state.status === "error") return <div className="attachment-preview-state">{tr("common.error")}</div>;
  return <pre className="attachment-preview-text"><code>{state.text}</code></pre>;
}

/** Files the browser cannot render inline: a calm card with one clear action. */
function FileCard({ attachment, kind }: { attachment: AttachmentRef; kind: PreviewKind }) {
  const isLink = kind === "link";
  return (
    <div className="attachment-preview-card">
      <span className="attachment-preview-card-badge" aria-hidden="true">{typeBadge(attachment, kind)}</span>
      <span className="attachment-preview-card-name">{isLink ? attachment.url : attachment.name}</span>
      {kind === "audio" && attachment.url && (
        <audio className="attachment-preview-audio" src={attachment.url} controls preload="metadata" />
      )}
      {!attachment.url && <span className="attachment-preview-card-meta">{tr("common.unavailable")}</span>}
      {attachment.url && kind !== "audio" && (
        <a
          className={buttonClassName({ className: "attachment-preview-card-action" })}
          href={attachment.url}
          target="_blank"
          rel="noreferrer"
          {...(isLink ? {} : { download: attachment.name })}
        >
          {isLink ? <ExternalLinkIcon aria-hidden="true" /> : <DownloadIcon aria-hidden="true" />}
          <span>{isLink ? attachment.name : tr("attachmentpills.download")}</span>
        </a>
      )}
    </div>
  );
}

function AttachmentContent({ attachment, kind }: { attachment: AttachmentRef; kind: PreviewKind }) {
  if (!attachment.url || kind === "audio" || kind === "link" || kind === "unsupported") {
    return <FileCard attachment={attachment} kind={kind} />;
  }
  if (kind === "image") return <img className="attachment-preview-media" src={attachment.url} alt={attachment.name} />;
  if (kind === "video") return <video className="attachment-preview-media" src={attachment.url} controls preload="metadata" />;
  if (kind === "pdf") {
    return <div className="attachment-preview-doc"><iframe className="attachment-preview-pdf" src={attachment.url} title={attachment.name} /></div>;
  }
  return <div className="attachment-preview-doc"><TextPreview attachment={attachment} /></div>;
}

export default function AttachmentPreview({ attachments, start, onClose }: {
  attachments: AttachmentRef[];
  start: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(Math.min(Math.max(start, 0), Math.max(attachments.length - 1, 0)));
  const [direction, setDirection] = useState<"prev" | "next" | null>(null);
  /** The last page change came from a swipe: the next item rides in from the far edge. */
  const [swiped, setSwiped] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<MediaZoom | null>(null);
  const count = attachments.length;

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [index]);

  const go = (target: number, dir: "prev" | "next", bySwipe = false) => {
    setDirection(dir);
    setSwiped(bySwipe);
    setIndex(((target % count) + count) % count);
  };
  const goRef = useRef(go);
  goRef.current = go;
  const indexRef = useRef(index);
  indexRef.current = index;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const hasNavigation = count > 1;

  useEffect(() => {
    const zoom = attachMediaZoom({
      surface: () => stageRef.current,
      media: () => slideRef.current?.querySelector<HTMLElement>("img.attachment-preview-media") ?? null,
    });
    zoomRef.current = zoom;
    return () => {
      zoom.detach();
      zoomRef.current = null;
    };
  }, []);

  // Every item opens at rest.
  useEffect(() => { zoomRef.current?.reset(); }, [index]);

  // Pull down to dismiss, following the finger; the dim behind lifts with it.
  useEffect(() => attachSheetDrag({
    sheet: () => slideRef.current,
    origin: () => "bottom",
    enabled: () => Boolean(slideRef.current && !slideRef.current.hasAttribute("data-swiping") && !zoomRef.current?.engaged()),
    onProgress: (progress) => {
      const dialog = stageRef.current?.closest<HTMLElement>(".attachment-preview-dialog");
      if (!dialog) return;
      dialog.style.setProperty("--preview-drag", progress.toFixed(4));
      dialog.toggleAttribute("data-media-dragging", progress > 0);
    },
    onDismiss: () => closeRef.current(),
  }), []);

  // Sideways drags page through the items, the current one following the
  // finger. A release past the commit point leaves it on its way off the edge
  // (an exit ghost) while the next one arrives from the other edge in the same
  // time; anything else springs it back.
  useEffect(() => {
    if (!hasNavigation) return;
    const pager = (swipe: InlineDirection) => attachSwipeSurface({
      surface: () => stageRef.current,
      direction: swipe,
      zone: () => "surface",
      enabled: () => Boolean(slideRef.current && !slideRef.current.hasAttribute("data-dragging") && !zoomRef.current?.engaged()),
      motion: "--motion-stack",
      begin: ({ rtl }) => {
        const slide = slideRef.current;
        const stage = stageRef.current;
        if (!slide || !stage) return null;
        // Physical direction the item travels with the finger.
        const sign = (swipe === "toward-end" ? 1 : -1) * (rtl ? -1 : 1);
        slide.setAttribute("data-swiping", "true");
        slide.style.willChange = "transform";
        const clear = () => {
          slide.removeAttribute("data-swiping");
          slide.style.removeProperty("transform");
          slide.style.removeProperty("will-change");
        };
        return {
          paint(travel) {
            slide.style.transform = `translate3d(${sign * travel}px, 0, 0)`;
          },
          cancel: clear,
          commit({ travel, settleMs }) {
            stage.style.setProperty("--page-settle", `${settleMs}ms`);
            leaveExitGhost(slide, {
              kind: "page",
              vars: { "--page-from": `${sign * travel}px`, "--page-to": `${sign * 100}%`, "--page-settle": `${settleMs}ms` },
            });
            clear();
            // Toward the inline start brings the next item, toward the end the previous one.
            if (swipe === "toward-start") goRef.current(indexRef.current + 1, "next", true);
            else goRef.current(indexRef.current - 1, "prev", true);
          },
        };
      },
    });
    const detachNext = pager("toward-start");
    const detachPrevious = pager("toward-end");
    return () => {
      detachNext();
      detachPrevious();
    };
  }, [hasNavigation]);

  const attachment = attachments[index];
  if (!attachment) return null;
  const kind = previewKind(attachment);
  const previous = () => go(index - 1, "prev");
  const next = () => go(index + 1, "next");

  return (
    <A11yDialog
      title={attachment.name}
      size="full"
      className={`attachment-preview-dialog attachment-preview-dialog--${kind}`}
      backdropClassName="attachment-preview-backdrop"
      onClose={onClose}
      initialFocus=".attachment-preview-stage"
    >
      <div
        className="attachment-preview-content"
        onKeyDown={(event) => {
          if (!hasNavigation) return;
          if (event.key === "ArrowLeft") { event.preventDefault(); previous(); }
          if (event.key === "ArrowRight") { event.preventDefault(); next(); }
        }}
      >
        <div
          ref={stageRef}
          className="attachment-preview-stage"
          tabIndex={-1}
          onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
        >
          <div
            key={index}
            ref={slideRef}
            className="attachment-preview-slide"
            data-direction={direction ?? undefined}
            data-swiped={swiped ? "" : undefined}
            onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
          >
            <AttachmentContent attachment={attachment} kind={kind} />
          </div>
        </div>

        <div className="attachment-preview-bar">
          {hasNavigation && <span className="attachment-preview-count">{index + 1} / {count}</span>}
          <IconButton icon={CloseIcon} label={tr("common.close")} size="lg" className="attachment-preview-close" onClick={onClose} />
        </div>

        {hasNavigation && (
          <>
            <IconButton
              icon={ChevronLeftIcon}
              label={tr("attachmentpills.previousAttachment")}
              size="lg"
              className="attachment-preview-nav attachment-preview-nav--prev"
              onClick={previous}
            />
            <IconButton
              icon={ChevronRightIcon}
              label={tr("attachmentpills.nextAttachment")}
              size="lg"
              className="attachment-preview-nav attachment-preview-nav--next"
              onClick={next}
            />
            <div ref={strip} className="attachment-preview-strip">
              {attachments.map((item, i) => {
                const itemKind = previewKind(item);
                return (
                  <button
                    key={item.id || i}
                    type="button"
                    className="attachment-preview-thumb"
                    aria-current={i === index ? "true" : undefined}
                    aria-label={tr("attachmentpills.previewAttachmentValue", { name: item.name })}
                    onClick={() => { if (i !== index) go(i, i < index ? "prev" : "next"); }}
                  >
                    {itemKind === "image" && item.url
                      ? <img src={item.url} alt="" loading="lazy" />
                      : <span aria-hidden="true">{typeBadge(item, itemKind)}</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </A11yDialog>
  );
}

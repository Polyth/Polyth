import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { AttachmentRef } from "@polyth/contracts";
import { CloseIcon, Dialog, IconButton } from "./ui/index.ts";
import { tr } from "../i18n/index.ts";

const TEXT_EXTENSIONS = /\.(?:c|cc|cpp|css|csv|go|h|hpp|html?|java|js|jsx|json|log|md|mjs|py|rb|rs|scss|sh|sql|svg|toml|ts|tsx|txt|vue|xml|yaml|yml)$/i;
const VIDEO_EXTENSIONS = /\.(?:m4v|mov|mp4|ogv|webm)$/i;
const AUDIO_EXTENSIONS = /\.(?:aac|flac|m4a|mp3|oga|ogg|wav|weba)$/i;
const MAX_TEXT_PREVIEW = 512 * 1024;

type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "link" | "unsupported";

function previewKind(attachment: AttachmentRef): PreviewKind {
  if (attachment.kind === "url") return "link";
  if (attachment.kind === "image" || attachment.mime.startsWith("image/")) return "image";
  if (attachment.mime.startsWith("video/") || VIDEO_EXTENSIONS.test(attachment.name)) return "video";
  if (attachment.mime.startsWith("audio/") || AUDIO_EXTENSIONS.test(attachment.name)) return "audio";
  if (attachment.mime === "application/pdf") return "pdf";
  if (attachment.mime.startsWith("text/") || TEXT_EXTENSIONS.test(attachment.name)) return "text";
  return "unsupported";
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

function AttachmentContent({ attachment, kind }: { attachment: AttachmentRef; kind: PreviewKind }) {
  if (!attachment.url) {
    return <div className="attachment-preview-state">{tr("common.unavailable")}</div>;
  }
  if (kind === "image") return <img className="attachment-preview-media" src={attachment.url} alt={attachment.name} />;
  if (kind === "video") return <video className="attachment-preview-media" src={attachment.url} controls preload="metadata" />;
  if (kind === "audio") return <audio className="attachment-preview-audio" src={attachment.url} controls preload="metadata" />;
  if (kind === "pdf") return <iframe className="attachment-preview-pdf" src={attachment.url} title={attachment.name} />;
  if (kind === "text") return <TextPreview attachment={attachment} />;
  if (kind === "link") {
    return (
      <div className="attachment-preview-state attachment-preview-link">
        <span className="attachment-preview-link-url">{attachment.url}</span>
        <a href={attachment.url} target="_blank" rel="noreferrer">{attachment.name}</a>
      </div>
    );
  }
  return (
    <div className="attachment-preview-state attachment-preview-download">
      <span>{attachment.mime || tr("common.unavailable")}</span>
      <a href={attachment.url} target="_blank" rel="noreferrer" download={attachment.name}>{attachment.name}</a>
    </div>
  );
}

export default function AttachmentPreview({ attachments, start, onClose }: {
  attachments: AttachmentRef[];
  start: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(Math.min(Math.max(start, 0), Math.max(attachments.length - 1, 0)));
  const attachment = attachments[index];
  if (!attachment) return null;
  const kind = previewKind(attachment);
  const hasNavigation = attachments.length > 1;
  const previous = () => setIndex((current) => (current - 1 + attachments.length) % attachments.length);
  const next = () => setIndex((current) => (current + 1) % attachments.length);

  const dialog = (
    <Dialog
      title={attachment.name}
      size="full"
      className={`attachment-preview-dialog attachment-preview-dialog--${kind}`}
      onClose={onClose}
      initialFocus=".attachment-preview-stage"
      hideHeader
    >
      <div
        className="attachment-preview-content"
        onKeyDown={(event) => {
          if (!hasNavigation) return;
          if (event.key === "ArrowLeft") { event.preventDefault(); previous(); }
          if (event.key === "ArrowRight") { event.preventDefault(); next(); }
        }}
      >
        <div className="attachment-preview-toolbar">
          <strong className="attachment-preview-title" title={attachment.name}>{attachment.name}</strong>
          {attachment.path && <span className="attachment-preview-path" title={attachment.path}>{attachment.path}</span>}
          {hasNavigation && (
            <div className="attachment-preview-navigation">
              <button type="button" className="attachment-preview-nav" onClick={previous} aria-label={tr("attachmentpills.previousAttachment")} title={tr("attachmentpills.previousAttachment")}>‹</button>
              <span>{index + 1} / {attachments.length}</span>
              <button type="button" className="attachment-preview-nav" onClick={next} aria-label={tr("attachmentpills.nextAttachment")} title={tr("attachmentpills.nextAttachment")}>›</button>
            </div>
          )}
          <IconButton icon={CloseIcon} label={tr("common.close")} onClick={onClose} size="sm" />
        </div>
        <div className="attachment-preview-stage" tabIndex={-1}>
          <AttachmentContent attachment={attachment} kind={kind} />
        </div>
      </div>
    </Dialog>
  );
  // The opener lives in the scrolling chat timeline. Keep the fixed scrim and
  // glass blur attached to the document viewport instead of that chat region.
  return typeof document === "undefined" ? null : createPortal(dialog, document.body);
}

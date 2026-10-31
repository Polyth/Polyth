// Attachment pills — removable in the composer, read-only on timeline
// user messages. Images and browser contexts show a thumbnail when available.
import { useState, type ReactElement } from "react";
import type { AttachmentRef } from "@polyth/contracts";
import { browserContextHostPath } from "@polyth/contracts";
import { browserContextChipTitle, PASTED_TEXT_NAME } from "../attachments.ts";
import { isBlockedAttachment } from "../composer/history.ts";
import { formatNumber, tr } from "../i18n/index.ts";
import { Icon } from "../icons.tsx";
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
  return { title, meta: [pasted ? "" : fileExtension(a.name), size].filter(Boolean).join(" · ") };
}

export default function AttachmentPills({ attachments, onRemove }: {
  attachments: AttachmentRef[];
  /** Present = composer mode (removable); absent = read-only timeline render. */
  onRemove?: (id: string) => void;
}) {
  const [previewAt, setPreviewAt] = useState<number | null>(null);
  if (attachments.length === 0) return null;
  const preview = previewAt === null ? null : attachments[previewAt];
  return (
    <>
      <div className="attachment-pills" aria-label={tr("attachmentpills.attachments")}>
        {attachments.map((a, i) => {
          const kind = a.kind ?? "file";
          const blocked = kind !== "browser-context" && isBlockedAttachment(a);
          const { title, meta } = cardText(a, kind, blocked);
          const detail = kind === "url" ? a.url : kind === "browser-context" ? meta : a.path;
          const imagePreview = kind === "image" && a.url && !blocked;
          const KindIcon = KIND_ICONS[kind] ?? Icon.file;
          const LeadIcon = a.name === PASTED_TEXT_NAME ? Icon.text : KindIcon;
          const body = imagePreview ? <img className="att-thumb" src={a.url} alt="" /> : (
            <>
              {kind === "browser-context" && a.url
                ? <img className="att-thumb" src={a.url} alt="" />
                : <span className="att-icon" aria-hidden><LeadIcon /></span>}
              <span className="att-text" title={detail ? `${title} · ${detail}` : title}>
                <span className="att-name">{title}</span>
                {meta && <span className="att-meta">{meta}</span>}
              </span>
            </>
          );
          return (
            <span key={a.id || i} className={`attachment-pill att-${kind}${imagePreview ? " att-tile" : ""}${blocked ? " att-unavailable" : ""}`}>
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

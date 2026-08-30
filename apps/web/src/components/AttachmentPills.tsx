// F2: attachment pills — removable in the composer, read-only on timeline
// user messages. Images show a thumbnail from the sanitized raw endpoint.
import { useState } from "react";
import type { AttachmentRef } from "@polyth/contracts";
import { formatNumber, tr } from "../i18n/index.ts";
import AttachmentPreview from "./AttachmentPreview.tsx";

const GLYPHS: Record<string, string> = { file: "▤", image: "▣", range: "¶", url: "↗" };

function fmtSize(n: number): string {
  if (n <= 0) return "";
  if (n < 1024) return `${formatNumber(n)} B`;
  if (n < 1048576) {
    return `${formatNumber(n / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  }
  return `${formatNumber(n / 1048576, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
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
          const detail = kind === "url" ? a.url : a.path;
          const size = kind === "url" ? "" : fmtSize(a.size);
          const body = (
            <>
              {kind === "image" && a.url
                ? <img className="att-thumb" src={a.url} alt="" />
                : <span className="att-icon" aria-hidden>{GLYPHS[kind] ?? "▤"}</span>}
              <span className="att-name" title={detail ? `${detail}${size ? ` · ${size}` : ""}` : a.name}>{a.name}</span>
            </>
          );
          return (
            <span key={a.id || i} className={`attachment-pill att-${kind}`}>
              <button
                type="button"
                className="attachment-open"
                aria-haspopup="dialog"
                aria-label={tr("attachmentpills.previewAttachmentValue", { name: a.name })}
                title={tr("attachmentpills.previewAttachmentValue", { name: a.name })}
                onClick={() => setPreviewAt(i)}
              >{body}</button>
              {onRemove && (
                <button
                  type="button"
                  className="att-remove"
                  aria-label={tr("attachmentpills.removeAttachmentValue", { name: a.name })}
                  title={tr("attachmentpills.removeAttachment")}
                  onClick={() => onRemove(a.id)}
                >✕</button>
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

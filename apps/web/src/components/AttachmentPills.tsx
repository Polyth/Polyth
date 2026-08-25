// F2: attachment pills — removable in the composer, read-only on timeline
// user messages. Images show a thumbnail from the sanitized raw endpoint.
import type { AttachmentRef } from "@polyth/contracts";
import { formatNumber, tr } from "../i18n/index.ts";

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
  if (attachments.length === 0) return null;
  return (
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
            {kind === "url" && a.url && !onRemove
              ? <a className="att-link" href={a.url} target="_blank" rel="noreferrer">{body}</a>
              : body}
            {onRemove && (
              <button
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
  );
}

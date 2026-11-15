// The one decision a rollback asks for when it would change files on disk:
// roll back the conversation and put those files back, or the conversation
// only. It opens only when at least one file will change; every other
// rollback stays the instant, dialog-free action it always was. The list is
// the preview — there is no second "are you sure".
import { useId, useState, type RefObject } from "react";
import type { RewindFileChange, RewindFileKept, RewindFileKeepReason, RewindFilesPreview } from "@polyth/contracts";
import { tr, type TranslationKey } from "../i18n/index.ts";
import Button from "./ui/Button.tsx";
import Icon from "./ui/Icon.tsx";
import Notice from "./ui/Notice.tsx";
import ResponsiveOverlay from "./ui/ResponsiveOverlay.tsx";
import { ChevronRightIcon } from "./ui/icons.ts";
import "./RewindFilesDialog.css";

export type RewindFilesPhase = "idle" | "stopping" | "applying";

const KEEP_REASON: Record<RewindFileKeepReason, TranslationKey> = {
  "changed-after": "timeline.rewindFiles.keep.changedAfter",
  "other-chat": "timeline.rewindFiles.keep.otherChat",
  "between-steps": "timeline.rewindFiles.keep.betweenSteps",
  "too-large": "timeline.rewindFiles.keep.tooLarge",
  unsupported: "timeline.rewindFiles.keep.unsupported",
  "write-failed": "timeline.rewindFiles.keep.writeFailed",
};

const splitPath = (path: string): { name: string; dir: string } => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash + 1) };
};

const changeState = (change: RewindFileChange): string => {
  if (change.kind === "added") return tr("timeline.rewindFiles.created");
  if (change.kind === "deleted") return tr("timeline.rewindFiles.deleted");
  return change.byCommand ? tr("timeline.rewindFiles.byCommand") : tr("timeline.rewindFiles.edited");
};

function ChangeRow({ change }: { change: RewindFileChange }) {
  const { name, dir } = splitPath(change.path);
  const state = changeState(change);
  const counted = !change.binary && change.kind === "modified"
    && ((change.additions ?? 0) > 0 || (change.deletions ?? 0) > 0);
  const label = [
    change.path,
    state,
    ...(change.binary ? [tr("timeline.rewindFiles.binary")] : []),
    ...(counted ? [tr("timeline.rewindFiles.lines", { added: change.additions ?? 0, removed: change.deletions ?? 0 })] : []),
  ].join(", ");
  return (
    <li className="rewind-files-row" aria-label={label}>
      <span className="rewind-files-path" aria-hidden="true" title={change.path}>
        <span className="rewind-files-name">{name}</span>
        {dir && <span className="rewind-files-dir">{dir}</span>}
      </span>
      <span className="rewind-files-state" aria-hidden="true">
        {state}
        {counted && (
          <span className="rewind-files-lines">
            {(change.additions ?? 0) > 0 && <span className="rewind-files-added">+{change.additions}</span>}
            {(change.deletions ?? 0) > 0 && <span className="rewind-files-removed">−{change.deletions}</span>}
          </span>
        )}
      </span>
    </li>
  );
}

function KeptRow({ kept }: { kept: RewindFileKept }) {
  const { name, dir } = splitPath(kept.path);
  const reason = tr(KEEP_REASON[kept.reason] ?? "timeline.rewindFiles.keep.unsupported");
  return (
    <li className="rewind-files-row" aria-label={`${kept.path}, ${reason}`}>
      <span className="rewind-files-path" aria-hidden="true" title={kept.path}>
        <span className="rewind-files-name">{name}</span>
        {dir && <span className="rewind-files-dir">{dir}</span>}
      </span>
      <span className="rewind-files-state" aria-hidden="true">{reason}</span>
    </li>
  );
}

export default function RewindFilesDialog({
  preview,
  phase,
  error,
  onRestore,
  onConversationOnly,
  onClose,
  restoreFocusRef,
}: {
  /** Open while non-null. */
  preview: RewindFilesPreview | null;
  phase: RewindFilesPhase;
  error: string | null;
  onRestore: () => void;
  onConversationOnly: () => void;
  onClose: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [keepOpen, setKeepOpen] = useState(false);
  const describedBy = useId();
  const keepListId = useId();
  const busy = phase !== "idle";
  const running = preview?.turnRunning === true;
  const restore = preview?.restore ?? [];
  const keep = preview?.keep ?? [];

  const footer = (
    <div className="rewind-files-actions">
      <Button
        variant="quiet"
        className="rewind-files-secondary"
        disabled={busy}
        onClick={onConversationOnly}
      >{tr("timeline.rewindFiles.conversationOnly")}</Button>
      <Button
        variant="primary"
        className="rewind-files-primary"
        busy={busy}
        onClick={onRestore}
      >
        {phase === "applying"
          ? tr("timeline.rewindFiles.applying")
          : phase === "stopping"
            ? tr("timeline.rewindFiles.stopping")
            : running
              ? tr("timeline.rewindFiles.stopAndRollBack")
              : tr("timeline.rewindFiles.confirm")}
      </Button>
    </div>
  );

  return (
    <ResponsiveOverlay
      open={preview !== null}
      // The rollback is in flight: the dialog closes only once the server
      // has confirmed (or refused) it.
      onClose={() => { if (!busy) onClose(); }}
      title={tr("timeline.rewindFiles.title")}
      desktop="dialog"
      phone="sheet"
      dialogSize="md"
      className="rewind-files"
      initialFocus=".rewind-files-primary"
      dialogDescribedBy={describedBy}
      dialogFooter={footer}
      sheetFooter={footer}
      {...(restoreFocusRef ? { restoreFocusRef } : {})}
    >
      <div className="rewind-files-body">
        <p className="rewind-files-subtitle" id={describedBy}>{tr("timeline.rewindFiles.subtitle")}</p>
        {running && <Notice tone="info">{tr("timeline.rewindFiles.running")}</Notice>}
        {error && <Notice tone="error" role="alert">{error}</Notice>}
        <section className="rewind-files-group">
          <h3 className="rewind-files-group-label">{tr("timeline.rewindFiles.restoreGroup", { count: restore.length })}</h3>
          <ul className="rewind-files-list" aria-label={tr("timeline.rewindFiles.restoreGroup", { count: restore.length })}>
            {restore.map((change) => <ChangeRow key={change.path} change={change} />)}
          </ul>
        </section>
        {keep.length > 0 && (
          <section className="rewind-files-group" data-open={keepOpen || undefined}>
            <button
              type="button"
              className="rewind-files-disclosure"
              aria-expanded={keepOpen}
              aria-controls={keepListId}
              onClick={() => setKeepOpen((value) => !value)}
            >
              <Icon icon={ChevronRightIcon} size="sm" className="rewind-files-chevron" />
              <span className="rewind-files-group-label">{tr("timeline.rewindFiles.keepGroup", { count: keep.length })}</span>
            </button>
            <ul
              className="rewind-files-list"
              id={keepListId}
              hidden={!keepOpen}
              aria-label={tr("timeline.rewindFiles.keepGroup", { count: keep.length })}
            >
              {keep.map((kept) => <KeptRow key={kept.path} kept={kept} />)}
            </ul>
          </section>
        )}
        <p className="rewind-files-footnote">{tr("timeline.rewindFiles.footnote")}</p>
      </div>
    </ResponsiveOverlay>
  );
}

const UNAVAILABLE_REASON: Record<string, TranslationKey> = {
  "not-git": "timeline.rewindFiles.reason.notGit",
  remote: "timeline.rewindFiles.reason.remote",
  "branch-changed": "timeline.rewindFiles.reason.branchChanged",
  "no-snapshot": "timeline.rewindFiles.reason.noSnapshot",
  "mid-turn": "timeline.rewindFiles.reason.noSnapshot",
};

/** The marker's disk-state suffix for an active rollback (`session/rewound
 *  .files`): counted files, or "files unchanged" with the reason. Nothing for
 *  a rollback that had no files to touch. */
export function rewindMarkerFilesLabel(files: {
  mode: "restored" | "kept" | "unavailable";
  restored: number;
  kept: number;
  reason?: string;
}): { suffix: string; detail?: string } | undefined {
  if (files.mode === "restored") {
    return files.kept > 0
      ? { suffix: tr("timeline.rewindMarkerFilesPartial", { count: files.restored, total: files.restored + files.kept }) }
      : { suffix: tr("timeline.rewindMarkerFiles", { count: files.restored }) };
  }
  if (files.mode === "kept") {
    return { suffix: tr("timeline.rewindMarkerFilesUnchanged"), detail: tr("timeline.rewindFiles.reason.kept") };
  }
  if ((!files.reason || files.reason === "no-changes") && files.kept === 0) return undefined;
  const reason = files.kept > 0 && (!files.reason || files.reason === "no-changes")
    ? "timeline.rewindFiles.reason.changedAfter"
    : UNAVAILABLE_REASON[files.reason ?? ""] ?? "timeline.rewindFiles.reason.unavailable";
  return { suffix: tr("timeline.rewindMarkerFilesUnchanged"), detail: tr(reason) };
}

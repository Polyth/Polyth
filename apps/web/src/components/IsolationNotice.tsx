import { useEffect, useState } from "react";
import { tr } from "../i18n/index.ts";
import type { NoticeMsg } from "../reduce.ts";
import { copyText } from "../utils.ts";
import Icon from "./ui/Icon.tsx";
import { BranchIcon, CommitIcon, CopiedIcon, DeleteIcon, MergeIcon, UndoIcon } from "./ui/icons.ts";
import "./IsolationNotice.css";

const BRANCH_SLOT = "\u0000";

/**
 * A milestone of an isolated session's lifecycle in the transcript: a
 * centered seal on a hairline rule. Moving an existing chat into isolation
 * names the branch it came from (and how many uncommitted files stayed
 * there); a merge names its target branch and result commit as chips, and the
 * commit chip copies its id. The branch sits wherever the locale's sentence
 * puts it.
 */
export default function IsolationNotice({ notice, entering = false, leaving = false }: {
  notice: NoticeMsg;
  entering?: boolean;
  leaving?: boolean;
}) {
  const merged = notice.topic === "isolation-merged";
  const started = notice.topic === "isolation-started";
  const tone = merged ? "merged" : started ? "started" : notice.returned ? "returned" : "discarded";
  const label = merged
    ? tr("timeline.mergedIntoValue", { branch: notice.branch ?? "", commit: notice.commit ?? "" })
    : started
      ? tr("timeline.isolatedFromBranch", { branch: notice.branch ?? "" })
      : notice.returned
        ? tr("timeline.returnedFromIsolation")
        : tr("timeline.isolatedWorkspaceDiscarded");
  const glyph = merged ? MergeIcon : started ? BranchIcon : notice.returned ? UndoIcon : DeleteIcon;
  const sentence = (merged || started) && notice.branch
    ? <BranchSentence branch={notice.branch} template={merged ? "timeline.mergedIntoBranch" : "timeline.isolatedFromBranch"} />
    : <span className="isolation-notice-text">{label}</span>;
  return (
    <div
      className={`task-activity isolation-notice isolation-notice--${tone}${entering ? " timeline-row-enter" : ""}${leaving ? " rewind-leaving" : ""}`}
      data-msg-id={notice.id}
    >
      <div className={`isolation-notice-seal${started && notice.uncommitted ? " isolation-notice-seal--noted" : ""}`}>
        <span className="isolation-notice-mark"><Icon icon={glyph} size="sm" /></span>
        {sentence}
        {merged && notice.commit && <CommitChip commit={notice.commit} />}
        {started && notice.uncommitted
          ? <span className="isolation-notice-note" title={tr("timeline.uncommittedStayed", { count: notice.uncommitted })}>
            {tr("timeline.uncommittedStayed", { count: notice.uncommitted })}
          </span>
          : null}
      </div>
    </div>
  );
}

function BranchSentence({ branch, template }: { branch: string; template: "timeline.mergedIntoBranch" | "timeline.isolatedFromBranch" }) {
  const [before = "", after = ""] = tr(template, { branch: BRANCH_SLOT }).split(BRANCH_SLOT);
  return (
    <>
      {before.trim() && <span className="isolation-notice-text isolation-notice-word">{before.trim()}</span>}
      <span className="isolation-notice-chip isolation-notice-branch" title={branch}>
        <Icon icon={BranchIcon} size="sm" />
        <span className="isolation-notice-chip-text">{branch}</span>
      </span>
      {after.trim() && <span className="isolation-notice-text isolation-notice-word">{after.trim()}</span>}
    </>
  );
}

function CommitChip({ commit }: { commit: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={`isolation-notice-chip isolation-notice-commit${copied ? " is-copied" : ""}`}
      title={tr("common.copy")}
      aria-label={`${tr("common.copy")} ${commit}`}
      onClick={() => { void copyText(commit).then((ok) => { if (ok) setCopied(true); }); }}
    >
      <Icon icon={copied ? CopiedIcon : CommitIcon} size="sm" />
      <span className="isolation-notice-chip-text">{commit}</span>
    </button>
  );
}

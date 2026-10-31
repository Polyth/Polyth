// Source Control's Conflicts view. Integrating an isolated session merges in a
// throwaway checkout, so the session's own working tree never shows the
// conflict. This view asks the server for a read-only preview of that merge
// against the current target branch and shows each overlapping edit: the
// target's lines, then the session's, with the unchanged lines around them.
import { useEffect, useState } from "react";
import { isManagedIsolationBranch } from "@polyth/contracts";
import type { GitMergeConflictFile, GitMergeConflictRegion } from "../src/index.ts";
import type { IsolationConflictPreview } from "../src/sessionIntegration.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { BranchIcon, Icon as UiIcon, IconButton, RefreshIcon, SessionIcon } from "../../../apps/web/src/components/ui/index.ts";
import { DiffCode, DiffSkeleton } from "./DiffViewer.tsx";
import { CountBadge, StatusChip, fileIdentity } from "./sourceControlParts.tsx";
import { createIsolationClient } from "./isolationClient.ts";

const KIND_NOTE: Partial<Record<GitMergeConflictFile["kind"], Parameters<typeof tr>[0]>> = {
  "added-by-both": "gitview.conflictAddedByBoth",
  "deleted-in-target": "gitview.conflictDeletedInTarget",
  "deleted-in-source": "gitview.conflictDeletedInSource",
  binary: "gitview.conflictBinary",
  "too-large": "gitview.conflictTooLarge",
  unsupported: "gitview.conflictUnsupported",
};

function Row({ kind, line, text, path }: { kind?: "target" | "source"; line?: number; text: string; path: string }) {
  return (
    <div className={`git-diff-line${kind ? ` diff-conflict-${kind}` : ""}`}>
      <span className="git-diff-ln" aria-hidden="true">{line ?? ""}</span>
      <DiffCode line={text} path={path} />
    </div>
  );
}

function SideLabel({ kind, label }: { kind: "target" | "source"; label: string }) {
  return (
    <div className={`git-diff-line git-conflict-side git-conflict-side--${kind}`}>
      <span className="git-diff-ln" aria-hidden="true" />
      <span className="git-conflict-side-label">
        <UiIcon icon={kind === "target" ? BranchIcon : SessionIcon} size="sm" />
        {label}
      </span>
    </div>
  );
}

function Region({ region, path, branch }: { region: GitMergeConflictRegion; path: string; branch: string }) {
  const first = region.line - region.before.length;
  const afterStart = region.line + region.source.length;
  const label = tr("gitview.conflictLine", { line: String(region.line) });
  return (
    <div role="group" aria-label={label} className="git-conflict-region">
      <div className="git-diff-line diff-hunk">
        <span className="git-diff-ln git-diff-ln--hunk" aria-hidden="true" />
        <span className="git-diff-hunk-text">{label}</span>
      </div>
      {region.before.map((text, index) => <Row key={`b${index}`} line={first + index} text={text} path={path} />)}
      <SideLabel kind="target" label={branch} />
      {region.target.length
        ? region.target.map((text, index) => <Row key={`t${index}`} kind="target" text={text} path={path} />)
        : <div className="git-diff-line diff-meta git-conflict-empty"><span className="git-diff-ln" aria-hidden="true" />{tr("gitview.conflictNoLines")}</div>}
      <SideLabel kind="source" label={tr("gitview.conflictThisSession")} />
      {region.source.length
        ? region.source.map((text, index) => <Row key={`s${index}`} kind="source" line={region.line + index} text={text} path={path} />)
        : <div className="git-diff-line diff-meta git-conflict-empty"><span className="git-diff-ln" aria-hidden="true" />{tr("gitview.conflictNoLines")}</div>}
      {region.after.map((text, index) => <Row key={`a${index}`} line={afterStart + index} text={text} path={path} />)}
      {region.truncated && <div className="git-diff-line diff-meta"><span className="git-diff-ln" aria-hidden="true" />{tr("gitview.conflictSideShortened")}</div>}
    </div>
  );
}

export function ConflictReviewPanel({ sessionId, conflictKey, requestedPath, wrap }: {
  sessionId: string;
  /** Changes when the session's recorded conflict does: re-preview then. */
  conflictKey: string;
  /** A file asked for from the isolation card, opened once it is listed. */
  requestedPath?: { path: string; seq: number } | null;
  wrap: boolean;
}) {
  const [revision, retry] = useState(0);
  const [preview, setPreview] = useState<IsolationConflictPreview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [path, selectPath] = useState<string | null>(requestedPath?.path ?? null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    // A transport per read: it binds `fetch` when created.
    void createIsolationClient().conflicts(sessionId)
      .then((value) => { if (active) setPreview(value); })
      .catch((cause) => { if (active) { setPreview(null); setError(friendlyError(tr("gitview.conflicts"), cause)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId, conflictKey, revision]);

  useEffect(() => {
    if (requestedPath) selectPath(requestedPath.path);
  }, [requestedPath?.path, requestedPath?.seq]);

  const files = preview?.files ?? [];
  const selected = files.find((file) => file.path === path) ?? files[0] ?? null;
  const branch = preview
    ? isManagedIsolationBranch(preview.targetBranch) ? tr("isolation.parentWorkspace") : preview.targetBranch
    : "";
  const note = selected ? KIND_NOTE[selected.kind] : undefined;

  return (
    <section className="git-branch-review git-conflict-review" aria-label={tr("gitview.conflicts")} aria-busy={loading}>
      <div className="git-conflict-review-head">
        {preview && (
          <p className="git-branch-review-identity">
            <span className="git-branch-review-ref">{tr("gitview.conflictThisSession")}</span>
            <span className="git-branch-review-vs" aria-hidden="true">→</span>
            <span className="git-branch-review-ref git-branch-review-ref--base mono" title={preview.targetBranch}>
              <UiIcon icon={BranchIcon} size="sm" />{branch}
            </span>
            {files.length > 0 && <span className="muted">{tr("gitview.conflictSummary", { count: String(files.length) })}</span>}
          </p>
        )}
        <IconButton icon={RefreshIcon} size="sm" variant="ghost" label={tr("common.retry")} disabled={loading} onClick={() => retry((n) => n + 1)} />
      </div>
      {loading && !preview
        ? <div role="status" className="git-branch-review-loading"><span>{tr("gitview.conflictsLoading")}</span><DiffSkeleton /></div>
        : error
          ? <div className="source-inline-status error" role="alert">{error}</div>
          : preview && files.length === 0
            ? <EmptyState
                variant="compact"
                title={tr("gitview.noConflictsNow", { branch })}
                description={tr("gitview.noConflictsNowDetail", { branch })}
              />
            : preview && (
              <>
                {preview.truncated && <p className="source-inline-status" role="status">{tr("gitview.conflictFilesTruncated", { count: String(files.length) })}</p>}
                <div className="git-branch-review-columns">
                  <nav aria-label={tr("gitview.conflicts")} className="git-branch-review-files">
                    {files.map((file) => {
                      const identity = fileIdentity(file.path);
                      return (
                        <button
                          type="button"
                          key={file.path}
                          className="git-branch-review-file"
                          aria-pressed={selected?.path === file.path}
                          title={file.path}
                          onClick={() => selectPath(file.path)}
                        >
                          <StatusChip status="conflicted" />
                          <span className="git-file-identity">
                            <span className="git-file-name">{identity.name}</span>
                            <span className="git-file-directory">{identity.directory}</span>
                          </span>
                          {file.regions.length > 0
                            ? <CountBadge count={file.regions.length} tone="danger" label={tr("gitview.conflictCount", { count: String(file.regions.length) })} />
                            : <span aria-hidden="true" />}
                        </button>
                      );
                    })}
                  </nav>
                  <div className="git-branch-review-detail">
                    {selected ? (
                      <>
                        <p className="git-conflict-path mono" title={selected.path}>{selected.path}</p>
                        {note && <p className="source-inline-status" role="status">{tr(note, { branch })}</p>}
                        {selected.regions.length > 0 && (
                          <div className={`git-diff git-conflict-diff${wrap ? " wrap" : ""}`}>
                            {selected.regions.map((region) => (
                              <Region key={`${region.line}:${region.target.length}:${region.source.length}`} region={region} path={selected.path} branch={branch} />
                            ))}
                          </div>
                        )}
                        {selected.truncated && <p className="source-inline-status" role="status">{tr("gitview.conflictRegionsTruncated", { count: String(selected.regions.length) })}</p>}
                      </>
                    ) : <EmptyState variant="compact" title={tr("gitview.selectAFileToReview")} />}
                  </div>
                </div>
              </>
            )}
    </section>
  );
}

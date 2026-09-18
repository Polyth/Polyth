import { openChanges } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { EmptyState, ProjectRequiredEmpty } from "../../../apps/web/src/components/ui/index.ts";
import { useGitStatus } from "./gitStatusStore.ts";
import type { GitFileEntry } from "@polyth/session/web-api";

const PREVIEW = 6;

const STATUS_LETTER: Record<string, { letter: string; cls: string }> = {
  added: { letter: "A", cls: "staged" },
  modified: { letter: "M", cls: "unstaged" },
  deleted: { letter: "D", cls: "unstaged" },
  renamed: { letter: "R", cls: "staged" },
  copied: { letter: "C", cls: "staged" },
  typechange: { letter: "T", cls: "unstaged" },
  untracked: { letter: "?", cls: "unstaged" },
  conflicted: { letter: "!", cls: "conflict" },
};

function fileLetter(file: GitFileEntry): { letter: string; cls: string } {
  const hit = STATUS_LETTER[file.status] ?? { letter: "M", cls: file.staged ? "staged" : "unstaged" };
  return file.staged && file.status !== "conflicted" ? { ...hit, cls: "staged" } : hit;
}

function fileIdentity(path: string): { name: string; directory: string } {
  const separator = path.lastIndexOf("/");
  return separator < 0
    ? { name: path, directory: "" }
    : { name: path.slice(separator + 1), directory: path.slice(0, separator + 1) };
}

/** Compact Canvas summary of source control. Deliberately read-only: branch,
 *  sync state, and a bounded changed-file preview that links into the full
 *  Source control surface. No stage/revert/publish here — those stay in
 *  GitView so a small card can never mutate the repository by accident. */
export default function RecentChangesWidget({
  projectId,
  sessionId,
}: {
  projectId: string | null;
  sessionId: string | null;
}) {
  const status = useGitStatus(projectId, true, sessionId);

  if (!projectId) {
    return (
      <ProjectRequiredEmpty
        variant="compact"
        title={tr("gitview.noProjectSelected")}
        description={tr("gitview.openAProjectToInspectItsGit")}
      />
    );
  }
  if (!status) {
    return (
      <div className="git-recent-widget" aria-busy="true" aria-label={tr("gitview.loadingSourceControl")}>
        <div className="source-skeleton skeleton-title" />
        <div className="source-skeleton skeleton-panel" />
      </div>
    );
  }
  if (status.isRepo === false) {
    return <EmptyState variant="compact" title={tr("gitview.thisFolderIsntAGitRepository")} description={tr("gitview.initializeGitInThisProject")} />;
  }

  const files = [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked];
  const count = files.length;
  const summary = count === 0
    ? tr("gitview.workingTreeClean")
    : count === 1
      ? tr("gitview.oneChangedFile")
      : tr("gitview.changedFilesValue", { count });

  return (
    <div className="git-recent-widget">
      <div className="git-recent-head">
        <span className="source-branch"><Icon.branch /> <span className="mono">{status.branch || tr("gitview.detachedHead")}</span></span>
        <span className="git-recent-summary">{summary}</span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="git-ahead-behind">
            {status.ahead > 0 && <span className="ahead">↑ {status.ahead}</span>}
            {status.behind > 0 && <span className="behind">↓ {status.behind}</span>}
          </span>
        )}
      </div>
      {count > 0 && (
        <div className="git-recent-list">
          {files.slice(0, PREVIEW).map((file) => {
            const { letter, cls } = fileLetter(file);
            const identity = fileIdentity(file.path);
            const title = file.origPath ? `${file.origPath} → ${file.path}` : file.path;
            return (
              <button
                key={`${file.staged ? "s" : "u"}:${file.path}`}
                type="button"
                className="git-recent-file"
                title={title}
                aria-label={`${file.status}: ${title}`}
                onClick={() => openChanges(file.path)}
              >
                <span className={`git-file-letter ${cls}`} aria-hidden="true">{letter}</span>
                <span className="git-recent-path">
                  <span className="git-recent-name">{identity.name}</span>
                  <span className="git-recent-directory">
                    {file.origPath ? `${file.origPath} → ${file.path}` : identity.directory}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className="git-recent-foot">
        <button type="button" className="git-recent-open" onClick={() => openChanges()}>
          <Icon.branch /> {tr("capabilities.sourceControl")}
        </button>
      </div>
    </div>
  );
}

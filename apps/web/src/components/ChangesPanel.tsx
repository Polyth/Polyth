// Git Changes panel for the Context Rail: branch info, staged/unstaged lists,
// per-file stage/unstage/discard, diff viewer, commit with generate.
import { useState, useEffect, useCallback } from "react";
import { api, type GitStatus, type GitFileEntry } from "../api.ts";
import { useStore } from "../store.ts";
import { diffStat } from "../utils.ts";
import CopyButton from "./CopyButton.tsx";
import { setGitPrefs, splitDiffRows, useGitPrefs } from "../gitPrefs.ts";

const EMPTY_STAGED: never[] = [];
const EMPTY_UNSTAGED: never[] = [];
const EMPTY_UNTRACKED: never[] = [];
const EMPTY_CONFLICTED: never[] = [];

function fileRow(
  f: GitFileEntry,
  onStage?: (p: string) => void,
  onUnstage?: (p: string) => void,
  onDiscard?: (p: string) => void,
  onClick?: (p: string) => void,
  selected?: boolean,
) {
  const letter = f.staged ? "+" : f.status === "conflict" ? "!" : f.status === "untracked" ? "?" : "-";
  return (
    <div className={`git-file-row ${selected ? "selected" : ""}`} key={f.path} onClick={() => onClick?.(f.path)}>
      <span className={`git-file-letter ${f.staged ? "staged" : f.status === "conflict" ? "conflict" : "unstaged"}`}>
        {letter}
      </span>
      <span className="git-file-path">{f.path}</span>
      <span className="git-file-actions" onClick={(e) => e.stopPropagation()}>
        {f.staged
          ? onUnstage && <button className="small-btn" title="Unstage" onClick={() => onUnstage(f.path)}>U</button>
          : onStage && <button className="small-btn" title="Stage" onClick={() => onStage(f.path)}>S</button>}
        {onDiscard && <button className="small-btn danger-btn" title="Discard" onClick={() => onDiscard(f.path)}>✕</button>}
      </span>
    </div>
  );
}

function DiffViewer({ diff }: { diff: string }) {
  const prefs = useGitPrefs();
  if (!diff) return <div className="empty" style={{ padding: 8 }}>No changes.</div>;
  const lines = diff.split("\n");
  return (
    <div className="copy-wrap">
      <div className="diff-prefs">
        <button className={`small-btn ${prefs.layout === "unified" ? "active" : ""}`} onClick={() => setGitPrefs({ layout: "unified" })}>Unified</button>
        <button className={`small-btn ${prefs.layout === "split" ? "active" : ""}`} onClick={() => setGitPrefs({ layout: "split" })}>Split</button>
        <label><input type="checkbox" checked={prefs.ignoreWhitespace} onChange={(event) => setGitPrefs({ ignoreWhitespace: event.target.checked })} /> Ignore whitespace</label>
        <label><input type="checkbox" checked={prefs.wrap} onChange={(event) => setGitPrefs({ wrap: event.target.checked })} /> Wrap</label>
      </div>
      {prefs.layout === "split" ? (
        <div className={`split-diff${prefs.wrap ? " wrap" : ""}`}>
          {splitDiffRows(diff).map((row, index) => (
            <div className={`split-diff-row ${row.kind}`} key={index}>
              <code className={row.left.startsWith("-") ? "diff-del" : ""}>{row.left}</code>
              <code className={row.right.startsWith("+") ? "diff-add" : ""}>{row.right}</code>
            </div>
          ))}
        </div>
      ) : <pre className={`git-diff${prefs.wrap ? " wrap" : ""}`}>
        {lines.map((line, i) => {
          let cls = "";
          if (line.startsWith("+") && !line.startsWith("+++")) cls = "diff-add";
          else if (line.startsWith("-") && !line.startsWith("---")) cls = "diff-del";
          else if (line.startsWith("@@")) cls = "diff-hunk";
          return (
            <div key={i} className={`git-diff-line ${cls}`}>
              <span className="git-diff-ln">{i + 1}</span>
              <span>{line}</span>
            </div>
          );
        })}
      </pre>}
      <CopyButton text={diff} />
    </div>
  );
}

export default function ChangesPanel() {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [worktrees, setWorktrees] = useState(0);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffText, setDiffText] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const prefs = useGitPrefs();

  const projectId = activeProjectId;
  const refresh = useCallback(() => {
    if (!projectId) return;
    void api.gitStatus(projectId).then(setStatus);
    void api.listWorktrees(projectId).then((w) => setWorktrees(w.length));
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!projectId || !diffPath || !status) return;
    const staged = status.staged.some((file) => file.path === diffPath);
    void api.gitDiff(projectId, diffPath, staged, prefs.ignoreWhitespace).then((result) => setDiffText(result.diff));
  }, [projectId, diffPath, status, prefs.ignoreWhitespace]);

  if (!projectId) return <div className="empty">Select a project first.</div>;
  if (!status) return <div className="empty">Loading git status…</div>;
  if (!status.branch && status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0) {
    return <div className="empty">Not a git repository, or nothing to show.</div>;
  }

  const loadDiff = async (fp: string) => {
    setDiffPath(fp);
    if (!projectId) return;
    const staged = status.staged.some((f) => f.path === fp);
    const got = await api.gitDiff(projectId, fp, staged, prefs.ignoreWhitespace);
    setDiffText(got.diff);
  };

  const stage = async (fp: string) => {
    if (!projectId) return;
    setBusy(true);
    await api.gitStage(projectId, [fp]);
    setBusy(false);
    refresh();
  };
  const unstage = async (fp: string) => {
    if (!projectId) return;
    setBusy(true);
    await api.gitUnstage(projectId, [fp]);
    setBusy(false);
    refresh();
  };
  const discard = async (fp: string) => {
    if (!projectId) return;
    if (!window.confirm(`Discard changes to ${fp}?`)) return;
    setBusy(true);
    await api.gitDiscard(projectId, [fp]);
    setBusy(false);
    refresh();
  };
  const stageAll = async () => {
    if (!projectId) return;
    setBusy(true);
    const paths = [...status.unstaged, ...status.untracked].map((f) => f.path);
    if (paths.length > 0) await api.gitStage(projectId, paths);
    setBusy(false);
    refresh();
  };
  const commit = async () => {
    if (!projectId || !commitMsg.trim()) return;
    setBusy(true);
    await api.gitCommit(projectId, commitMsg.trim());
    setCommitMsg("");
    setBusy(false);
    refresh();
  };
  const generate = async () => {
    if (!projectId) return;
    setGenerating(true);
    const got = await api.gitCommitMessage(projectId);
    if (got.message) setCommitMsg(got.message);
    setGenerating(false);
  };

  const aheadBehind = status.ahead > 0 || status.behind > 0;

  return (
    <div className="changes-panel">
      <div className="stat-label">Branch</div>
      <div className="status-line">
        <span style={{ fontWeight: 600 }}>{status.branch || "—"}</span>
        {aheadBehind && (
          <span className="git-ahead-behind">
            {status.ahead > 0 && <span className="ahead">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="behind">↓{status.behind}</span>}
          </span>
        )}
        <span className="header-spacer" />
        {worktrees > 1 && <span className="ctx-badge" title="Linked worktrees">{worktrees} worktrees</span>}
      </div>

      {status.conflicted.length > 0 && (
        <>
          <div className="stat-label" style={{ color: "var(--red)" }}>Conflicts ({status.conflicted.length})</div>
          {status.conflicted.map((f) => fileRow(f, undefined, undefined, undefined, loadDiff, f.path === diffPath))}
        </>
      )}

      <div className="stat-label">Staged ({status.staged.length})</div>
      {status.staged.length === 0 && <div className="empty" style={{ padding: "4px 0" }}>No staged files.</div>}
      {status.staged.map((f) => fileRow(f, undefined, unstage, undefined, loadDiff, f.path === diffPath))}

      <div className="stat-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Unstaged ({status.unstaged.length + status.untracked.length})</span>
        {(status.unstaged.length + status.untracked.length) > 0 && (
          <button className="small-btn" onClick={() => void stageAll()} disabled={busy}>Stage all</button>
        )}
      </div>
      {status.unstaged.map((f) => fileRow(f, stage, undefined, discard, loadDiff, f.path === diffPath))}
      {status.untracked.map((f) => fileRow(f, stage, undefined, undefined, loadDiff, f.path === diffPath))}
      {status.unstaged.length === 0 && status.untracked.length === 0 && (
        <div className="empty" style={{ padding: "4px 0" }}>Working tree clean.</div>
      )}

      {diffPath !== null && (
        <>
          <div className="stat-label" style={{ display: "flex", gap: 8 }}>
            <span className="git-subj">Diff: {diffPath}</span>
            <span className="header-spacer" />
            <span style={{ color: "var(--green)" }}>+{diffStat(diffText).add}</span>
            <span style={{ color: "var(--red)" }}>−{diffStat(diffText).del}</span>
          </div>
          <DiffViewer diff={diffText} />
        </>
      )}

      {status.staged.length > 0 && (
        <div className="commit-area">
          <textarea
            className="commit-msg"
            rows={3}
            placeholder="Commit message…"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
          />
          <div className="commit-row">
            <button className="small-btn" onClick={() => void generate()} disabled={generating || busy}>
              {generating ? "…" : "Generate"}
            </button>
            <button
              className="send"
              onClick={() => void commit()}
              disabled={!commitMsg.trim() || busy}
              style={{ padding: "4px 14px", fontSize: 12 }}
            >
              Commit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

import { createBranchDiffClient, type BranchReviewTarget } from "./branchDiffClient.ts";
import { defaultReviewScope, reviewNoteKey, capReviewExcerpt, markOutdatedNotes, reviewNotesMarkdown, type ReviewView, type BranchReviewNote } from "./branchReview.ts";
import { consumeReviewScope, subscribeReviewScope } from "./reviewScopeHandoff.ts";
import { ConflictReviewPanel } from "./ConflictReview.tsx";
import { setReviewScope, useReviewScopePreference } from "./gitPrefs.ts";
import type { GitBranchDiffList, GitBranchFileDiff } from "../src/index.ts";
import { useCallback, useEffect, useMemo, useRef, useId, useState, type DragEvent, type ReactNode } from "react";
import { isManagedIsolationBranch, projectIsolationLevel } from "@polyth/contracts";
import { resolveWorkspaceContext, type WorkspaceRepository } from "@polyth/contracts/workspace";
import { api, errorCodeOf, errorChangesOf, type GitBranches, type GitFileEntry, type GitGraphEntry, type GitStash, type GitStatus, type Worktree } from "@polyth/session/web-api";
import { layoutGraph, type GraphRow } from "./git/graph.ts";
import { getGitRemoteSelection, getGitRepositorySelection, getGitViewState, setGitRemoteSelection, setGitRepositorySelection, setGitPrefs, setGitViewState, useGitPrefs, type GitPrefs, type GitTabId } from "./gitPrefs.ts";
import { gitChangedCount, gitUnpushedCount, refreshGitStatus, useGitStatus } from "./gitStatusStore.ts";
import {
  repositorySourceControlRemotes,
  type RepositorySourceControlRemote,
} from "./sourceControlRemote.ts";
import { gitDiffSnapshotDigestOf, mutateGitHunk, type GitHunkOperation } from "./hunkActions.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { requestComposerReplace } from "../../../apps/web/src/composerInsert.ts";
import { openSession } from "../../../apps/web/src/init.ts";
import {
  commentState, hunkDigest, loadComments, saveComments, splitHunks,
  type DiffHunk, type ReviewComment,
} from "../../../apps/web/src/review/anchors.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { openWorktreeSessionDialog, setGitBranch, setGitDiffPath, setUiError, startNewSession, useStore, getState, workspaceProjectId, workspacePresentationKey } from "../../../apps/web/src/store.ts";
import { diffStat } from "../../../apps/web/src/utils.ts";
import { setPaneLastResource } from "../../../apps/web/src/workspace/panePrefs.ts";
import {
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventHasKey,
  projectPresentationEventProjectId,
} from "../../../apps/web/src/projectPresentationSync.ts";
import CopyButton from "../../../apps/web/src/components/CopyButton.tsx";
import EmptyState, { ProjectRequiredEmpty } from "../../../apps/web/src/components/EmptyState.tsx";
import { isImeComposing, type ResourceRef, type SurfaceComponentProps, type WebPackageHost } from "@polyth/web-sdk";
import { summarizeUnifiedDiff, totalDiffStats, type DiffLineStats } from "./PendingChangesBar.tsx";
import "./repository-scope.css";
import RepoStackPanel from "./RepoStackPanel.tsx";
import LandingBar from "./LandingBar.tsx";
import { gitRefusalOf, openGitRefusal, reportGitError, type GitRefusal } from "./gitRefusal.ts";
import { ChangeSection, fileStatKey, type ChangeGroup } from "./ChangeList.tsx";
import { CommitFiles, DiffContent, DiffSkeleton, HunkBlock, parseCommitPrelude } from "./DiffViewer.tsx";
import { AuthorAvatar, CountBadge, LineStats, StatusChip, When, fileIdentity, refKind, statusLabel } from "./sourceControlParts.tsx";
import {
  AddIcon,
  AssistIcon,
  BackIcon,
  BranchIcon,
  Button,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  CombineIcon,
  CommitIcon,
  CompareIcon,
  CopyIcon,
  DeleteIcon,
  Dialog,
  FetchIcon,
  Icon as UiIcon,
  IconButton,
  Menu,
  MinusIcon,
  MoreIcon,
  type MenuEntry,
  PullIcon,
  PullRequestIcon,
  RepositoryScopePicker,
  SearchIcon,
  Select,
  PushIcon,
  RefreshIcon,
  SessionIcon,
  SplitViewIcon,
  StageIcon,
  StashApplyIcon,
  StashIcon,
  SyncIcon,
  Tabs,
  Textarea,
  TextInput,
  UndoIcon,
  UnifiedViewIcon,
  ViewOptionsIcon,
  WarningIcon,
  WorktreeIcon,
  WorkspaceSurfaceHeader,
  WrapIcon,
} from "../../../apps/web/src/components/ui/index.ts";

export { DiffContent } from "./DiffViewer.tsx";
export { diffSyntaxSections } from "./DiffViewer.tsx";

type GitTab = GitTabId;
type RemoteStep = "fetch" | "pull" | "push" | "sync";
type BranchGroup = "local" | "remote";

// Opt into the host's edge fade only when there is content to scroll. Observe
// labels too: a locale/count change may grow scrollWidth without resizing the strip.
// Measure the resting strip (no scroll padding, first label flush), so the
// padding the scroll mode adds can never keep a strip that fits in that mode.
function SourceControlTabs({ tabs, value, onChange }: {
  tabs: { id: GitTab; label: ReactNode }[];
  value: GitTab;
  onChange: (value: GitTab) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const strip = frame.current?.querySelector<HTMLElement>("[role=tablist]");
    if (!strip) return;
    const measure = () => {
      const items = [...strip.querySelectorAll<HTMLElement>("[role=tab]")];
      const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
      const inset = items[0] ? parseFloat(getComputedStyle(items[0]).paddingInlineStart) || 0 : 0;
      const resting = items.reduce((sum, item) => sum + item.getBoundingClientRect().width, 0)
        + gap * Math.max(0, items.length - 1) - (strip.classList.contains("ui-scroll-tabs") ? inset : 0);
      setOverflow(resting > strip.clientWidth + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    strip.querySelectorAll("[role=tab]").forEach((item) => observer.observe(item));
    measure();
    return () => observer.disconnect();
  }, [tabs]);
  return <div ref={frame} className="source-tabs-frame">
    <Tabs className={`source-tabs${overflow ? " ui-scroll-tabs" : ""}`} size="md"
      label={tr("gitview.sourceControlViews")} tabs={tabs} value={value}
      onChange={(next) => onChange(next as GitTab)} />
  </div>;
}

/** Tab label: the name plus a count pill. The visible pill is decorative; the
 *  accessible name reads "Changes 11" from the same two text nodes. */
function tabLabel(name: string, count?: number, tone: "neutral" | "accent" | "danger" = "neutral"): ReactNode {
  return <span className="source-tab-label"><span>{name}</span>{count !== undefined && <> <CountBadge count={count} tone={tone} /></>}</span>;
}

const remoteProviderLabel = (hostname: string): string => {
  if (hostname === "github.com") return "GitHub";
  if (hostname === "gitlab.com") return "GitLab";
  return "Git";
};

const remoteDetail = (option: RepositorySourceControlRemote): string => {
  const directions = option.directions.map((direction) => direction === "push" ? "push" : "fetch").join(" · ");
  return `${remoteProviderLabel(option.remote.hostname)} · ${option.remote.hostname}/${option.remote.fullPath}${directions ? ` · ${directions}` : ""}`;
};
interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => Promise<unknown>;
}

const GRAPH_PAGE = 40;
const LANE_W = 12;
const SUBJECT_SOFT_LIMIT = 72;

type GitSelection = { path: string; staged: boolean };

interface RepositoryOverviewEntry {
  repositoryId: string;
  alias: string;
  path: string;
  state: "ready" | "missing";
  status: GitStatus | null;
  error?: string;
}

const EMPTY_REPOSITORIES: readonly WorkspaceRepository[] = [];

const refusalField = (cause: unknown): { refusal?: GitRefusal } => {
  const refusal = gitRefusalOf(cause);
  return refusal ? { refusal } : {};
};

const isDivergedError = (message: string): boolean =>
  /diverged|fast-forward|non-fast-forward|remote has commits/i.test(message);

/** Keep an open diff attached to the file's current staged/unstaged location. */
export function reconcileGitSelection(selection: GitSelection | null, status: GitStatus): GitSelection | null {
  if (!selection) return null;
  const files = [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked];
  const exact = files.find((file) => file.path === selection.path && file.staged === selection.staged);
  const moved = files.find((file) => file.path === selection.path);
  const next = exact ?? moved;
  return next ? { path: next.path, staged: next.staged } : null;
}

/** Lane graph cell. It stretches to the row's height: through-lines run 0→100%
 *  and the dot sits at 50%, so lanes stay continuous at any row density. */
function GraphSvg({ row }: { row: GraphRow }) {
  const width = Math.max(row.width, 1) * LANE_W;
  const cx = row.lane * LANE_W + LANE_W / 2;
  return (
    <svg className="graph-svg" width={width} aria-hidden="true">
      {row.through.map((lane) => (
        <line key={`t${lane}`} x1={lane * LANE_W + LANE_W / 2} y1="0" x2={lane * LANE_W + LANE_W / 2} y2="100%" className={`graph-line graph-lane-${lane % 5}`} />
      ))}
      {row.edges.map((lane, index) => (
        <line key={`e${index}`} x1={cx} y1="50%" x2={lane * LANE_W + LANE_W / 2} y2="100%" className={`graph-line graph-lane-${lane % 5}`} />
      ))}
      <line x1={cx} y1="0" x2={cx} y2="50%" className={`graph-line graph-lane-${row.lane % 5}`} />
      <circle cx={cx} cy="50%" r={4} className={`${row.edges.length > 1 ? "graph-dot merge" : "graph-dot"} graph-lane-${row.lane % 5}`} />
    </svg>
  );
}

function RefBadges({ refs, remotes, limit }: { refs: readonly string[]; remotes: ReadonlySet<string>; limit?: number }) {
  const shown = limit === undefined ? refs : refs.slice(0, limit);
  const hidden = refs.length - shown.length;
  return (
    <>
      {shown.map((ref) => {
        const { label, kind } = refKind(ref, remotes);
        return <span key={ref} className={`graph-ref graph-ref--${kind}${kind === "tag" ? " tag" : ""}`} title={label}>{label}</span>;
      })}
      {hidden > 0 && <span className="graph-ref graph-ref--more">+{hidden}</span>}
    </>
  );
}

/** Account-wide list display choices. Diff layout stays per repository. */
function ViewOptionsMenu({ prefs, log = false }: { prefs: GitPrefs; log?: boolean }) {
  const entries: MenuEntry[] = log ? [
    { id: "graph", kind: "checkbox", checked: prefs.logGraph, label: tr("gitview.showGraph"), onSelect: () => setGitPrefs({ logGraph: !prefs.logGraph }) },
    "separator",
    { heading: tr("gitview.dates") },
    { id: "dates-relative", kind: "radio", checked: prefs.dateStyle === "relative", label: tr("gitview.datesRelative"), onSelect: () => setGitPrefs({ dateStyle: "relative" }) },
    { id: "dates-absolute", kind: "radio", checked: prefs.dateStyle === "absolute", label: tr("gitview.datesAbsolute"), onSelect: () => setGitPrefs({ dateStyle: "absolute" }) },
    "separator",
    { heading: tr("gitview.density") },
    { id: "density-compact", kind: "radio", checked: prefs.density === "compact", label: tr("gitview.densityCompact"), onSelect: () => setGitPrefs({ density: "compact" }) },
    { id: "density-comfortable", kind: "radio", checked: prefs.density === "comfortable", label: tr("gitview.densityComfortable"), onSelect: () => setGitPrefs({ density: "comfortable" }) },
  ] : [
    { heading: tr("gitview.showChangesAs") },
    { id: "view-tree", kind: "radio", checked: prefs.changesView === "tree", label: tr("gitview.viewAsTree"), onSelect: () => setGitPrefs({ changesView: "tree" }) },
    { id: "view-flat", kind: "radio", checked: prefs.changesView === "flat", label: tr("gitview.viewAsList"), onSelect: () => setGitPrefs({ changesView: "flat" }) },
    "separator",
    { heading: tr("gitview.lineStats") },
    { id: "stats-numbers", kind: "radio", checked: prefs.lineStats === "numbers", label: tr("gitview.lineStatsNumbers"), onSelect: () => setGitPrefs({ lineStats: "numbers" }) },
    { id: "stats-bar", kind: "radio", checked: prefs.lineStats === "bar", label: tr("gitview.lineStatsBar"), onSelect: () => setGitPrefs({ lineStats: "bar" }) },
    { id: "stats-hidden", kind: "radio", checked: prefs.lineStats === "hidden", label: tr("gitview.lineStatsHidden"), onSelect: () => setGitPrefs({ lineStats: "hidden" }) },
    "separator",
    { heading: tr("gitview.density") },
    { id: "density-compact", kind: "radio", checked: prefs.density === "compact", label: tr("gitview.densityCompact"), onSelect: () => setGitPrefs({ density: "compact" }) },
    { id: "density-comfortable", kind: "radio", checked: prefs.density === "comfortable", label: tr("gitview.densityComfortable"), onSelect: () => setGitPrefs({ density: "comfortable" }) },
  ];
  return (
    <Menu label={tr("gitview.viewOptions")} align="end" entries={entries}>
      {(trigger) => <IconButton {...trigger} icon={ViewOptionsIcon} size="sm" variant="ghost" className="source-view-options" label={tr("gitview.viewOptions")} />}
    </Menu>
  );
}

function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <IconButton icon={copied ? CheckIcon : CopyIcon} size="sm" variant="ghost" label={label} onClick={() => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
  }} />;
}

type ConflictAgentTarget = "new-session" | "current-session";

/** Inline "resolve this conflict with an agent" affordance. Shown wherever the
 *  git surface knows the repo is conflicted — a diverged fast-forward pull or
 *  unresolved working-tree merge conflicts — and opens an editable prompt in
 *  the current session or a fresh one. */
function ConflictAgentBanner({
  hint, defaultTarget, hasCurrentSession, busy, message, failed, autoRebaseBusy, onAutoRebase, onResolve,
}: {
  hint: string;
  defaultTarget: ConflictAgentTarget;
  hasCurrentSession: boolean;
  busy: ConflictAgentTarget | null;
  message: string;
  failed: boolean;
  autoRebaseBusy: boolean;
  onAutoRebase?: () => void;
  onResolve: (target: ConflictAgentTarget) => void;
}) {
  return (
    <div className="source-inline-status conflict-agent-bar" role="group" aria-label={tr("gitview.resolveConflictWithAgent")}>
      <span className="conflict-agent-glyph" aria-hidden="true"><UiIcon icon={WarningIcon} size="sm" /></span>
      <div className="conflict-agent-copy">
        <strong>{tr("gitview.resolveConflictWithAgent")}</strong>
        <span className="muted">{hint}</span>
      </div>
      <div className="conflict-agent-actions">
        {onAutoRebase && (
          <Button
            size="sm"
            variant="primary"
            iconStart={SyncIcon}
            busy={autoRebaseBusy}
            disabled={busy !== null || autoRebaseBusy}
            onClick={onAutoRebase}
          >
            {tr("gitview.autoRebaseAndSync")}
          </Button>
        )}
        <Button
          size="sm"
          variant={defaultTarget === "current-session" && !onAutoRebase ? "primary" : "quiet"}
          iconStart={AssistIcon}
          busy={busy === "current-session"}
          disabled={busy !== null || autoRebaseBusy || !hasCurrentSession}
          onClick={() => onResolve("current-session")}
        >
          {tr("gitview.resolveInThisSession")}
        </Button>
        <Button
          size="sm"
          variant={defaultTarget === "new-session" && !onAutoRebase ? "primary" : "quiet"}
          iconStart={AssistIcon}
          busy={busy === "new-session"}
          disabled={busy !== null || autoRebaseBusy}
          onClick={() => onResolve("new-session")}
        >
          {tr("gitview.resolveInNewSession")}
        </Button>
      </div>
      {message && (
        <div className={failed ? "form-error" : "form-success"} role={failed ? "alert" : "status"}>
          {message}
        </div>
      )}
    </div>
  );
}

const branchReviewClient = createBranchDiffClient();

export function BranchReviewPanel({ target, host, prefs, prefsScope, workspace, missing, branches = [] }: {
  target: BranchReviewTarget;
  host?: WebPackageHost;
  prefs: ReturnType<typeof useGitPrefs>;
  prefsScope: string;
  workspace: string;
  missing: boolean;
  branches?: readonly { name: string }[];
}) {
  const activeSessionId = useStore((state) => state.activeSessionId);
  const [baseDraft, setBaseDraft] = useState("");
  const [base, setBase] = useState("");
  const [revision, retry] = useState(0);
  const [list, setList] = useState<GitBranchDiffList | null>(null);
  const [patch, setPatch] = useState<GitBranchFileDiff | null>(null);
  const [path, selectPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [notes, setNotes] = useState<BranchReviewNote[]>([]);
  const [draftHunk, setDraftHunk] = useState<DiffHunk | null>(null);
  const [text, setText] = useState("");
  const [inserting, setInserting] = useState(false);
  const mounted = useRef(true);
  const insertionLock = useRef(false);
  const [inserted, setInserted] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const request = useMemo(() => ({ ...target, base, ignoreWhitespace: prefs.ignoreWhitespace }),
    [target.projectId, target.sessionId, target.repositoryId, base, prefs.ignoreWhitespace, workspace]);
  const basePickerId = `branch-review-base-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const noteKey = list ? workspacePresentationKey(reviewNoteKey({ project: target.projectId,
    repository: target.repositoryId ?? "primary", workspace, base: list.base, head: list.headRef ?? list.head }), target.projectId, target.sessionId ?? null) : null;
  const activeIdentity = useRef("");
  activeIdentity.current = JSON.stringify([request, noteKey, revision, list?.head, list?.mergeBase, missing]);
  const persist = (next: BranchReviewNote[]) => {
    setNotes(next);
    if (noteKey) saveComments(noteKey, next);
  };
  useEffect(() => {
    let active = true;
    setList(null); setPatch(null); selectPath(null); setError(""); setErrorCode(""); setDraftHunk(null); setInserted(false);
    if (missing) return;
    setLoading(true);
    void branchReviewClient.list(request).then((value) => { if (active) setList(value); })
      .catch((cause) => { if (active) { setError(friendlyError(tr("gitview.branchVsBase"), cause)); setErrorCode(errorCodeOf(cause) ?? ""); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, missing, revision]);
  useEffect(() => {
    let next: BranchReviewNote[] = [];
    if (noteKey) try {
      const stored: unknown = loadComments(noteKey);
      if (Array.isArray(stored)) next = stored.filter((note): note is BranchReviewNote => note && typeof note.id === "string" && typeof note.path === "string" && typeof note.text === "string" && typeof note.excerpt === "string" && typeof note.digest === "string").slice(0, 500);
    } catch { /* best effort */ }
    setNotes(next);
  }, [noteKey]);
  useEffect(() => {
    let active = true;
    setPatch(null); setDraftHunk(null); setText(""); setFileLoading(false);
    if (!path || !list) return;
    setFileLoading(true); setError("");
    void branchReviewClient.file(request, path).then((value) => {
      if (!active) return;
      if (value.head !== list.head || value.mergeBase !== list.mergeBase) { retry((n) => n + 1); return; }
      setPatch(value);
      setNotes((current) => markOutdatedNotes(current, path, splitHunks(value.diff).map(hunkDigest)));
    }).catch((cause) => { if (active) setError(friendlyError(tr("gitview.branchVsBase"), cause)); })
      .finally(() => { if (active) setFileLoading(false); });
    return () => { active = false; };
  }, [request, path, list]);
  const insertNotes = async () => {
    if (!host || !target.sessionId || getState().activeSessionId !== target.sessionId || !list || insertionLock.current) return;
    const identity = activeIdentity.current;
    insertionLock.current = true;
    setInserting(true);
    try {
      let checked = notes;
      for (const file of new Set(notes.map((note) => note.path))) {
        try {
          const current = await branchReviewClient.file(request, file);
          checked = markOutdatedNotes(checked, file, current.head === list.head && current.mergeBase === list.mergeBase ? splitHunks(current.diff).map(hunkDigest) : []);
        } catch { checked = markOutdatedNotes(checked, file, []); }
      }
      if (!mounted.current || activeIdentity.current !== identity || getState().activeSessionId !== target.sessionId) return;
      persist(checked);
      const markdown = reviewNotesMarkdown(checked, { head: list.headRef ?? list.head.slice(0, 8), base: list.base, mergeBase: list.mergeBase });
      if (markdown) { host.conversation.insert(markdown); setInserted(true); }
    } finally { insertionLock.current = false; if (mounted.current) setInserting(false); }
  };
  const currentNotes = notes.filter((note) => !note.outdated);
  const canInsert = Boolean(host && target.sessionId && activeSessionId === target.sessionId);
  const compare = () => { setBase(baseDraft.trim()); retry((n) => n + 1); };
  return <section className="git-branch-review" aria-label={tr("gitview.branchVsBase")}>
    <div className="git-branch-review-toolbar">
      <form className="git-branch-review-base" onSubmit={(event) => { event.preventDefault(); if (baseDraft.trim() && !loading) compare(); }}>
        <label htmlFor={`${basePickerId}-input`}>{tr("gitview.reviewBase")}</label>
        <TextInput id={`${basePickerId}-input`} uiSize="sm" className="mono" list={basePickerId} value={baseDraft} placeholder={list?.base ?? "main"} onChange={(event) => setBaseDraft(event.target.value)} />
        <datalist id={basePickerId}>{branches.map((branch) => <option key={branch.name} value={branch.name} />)}</datalist>
        <Button size="sm" type="submit" iconStart={CompareIcon} disabled={!baseDraft.trim() || loading}>{tr("gitview.compareBase")}</Button>
      </form>
      <div className="git-branch-review-prefs">
        <Button size="sm" variant="ghost" iconStart={SplitViewIcon} aria-pressed={prefs.layout === "split"} onClick={() => setGitPrefs({ layout: prefs.layout === "split" ? "unified" : "split" }, prefsScope)}>{tr("gitview.splitReview")}</Button>
        <Button size="sm" variant="ghost" iconStart={WrapIcon} aria-pressed={prefs.wrap} onClick={() => setGitPrefs({ wrap: !prefs.wrap }, prefsScope)}>{tr("gitview.wrapReview")}</Button>
        <Button size="sm" variant="ghost" aria-pressed={prefs.ignoreWhitespace} onClick={() => setGitPrefs({ ignoreWhitespace: !prefs.ignoreWhitespace }, prefsScope)}>{tr("gitview.ignoreWhitespaceReview")}</Button>
        <IconButton icon={RefreshIcon} size="sm" variant="ghost" label={tr("common.retry")} onClick={() => retry((n) => n + 1)} />
      </div>
    </div>
    {missing ? <div className="source-inline-status" role="status">{tr("gitview.reviewMissingWorktree")}</div> : loading ? <div role="status" className="git-branch-review-loading" aria-busy="true"><span>{tr("gitview.reviewLoading")}</span><DiffSkeleton /></div> : error && <div className="source-inline-status error" role="alert">{errorCode === "no-base" ? tr("gitview.reviewNoBase") : errorCode === "no-merge-base" ? tr("gitview.reviewNoMergeBase") : error}</div>}
    {list && <>
      <p className="git-branch-review-identity">
        <span className="git-branch-review-ref mono" title={list.headRef ?? list.head}><UiIcon icon={BranchIcon} size="sm" />{list.headRef ?? "HEAD"}</span>
        <span className="git-branch-review-vs" aria-hidden="true">←</span>
        <span className="git-branch-review-ref git-branch-review-ref--base mono" title={list.base}>{list.base}</span>
        <span className="muted">{tr("gitview.reviewIdentity", { head: list.headRef ?? "HEAD", base: list.base, mergeBase: list.mergeBase.slice(0, 8), count: list.ahead })}</span>
      </p>
      {list.truncated && <p className="source-inline-status" role="status">{tr("gitview.reviewTruncated")}</p>}
      {list.files.length === 0 ? <EmptyState variant="compact" mark={<UiIcon icon={CompareIcon} size="lg" />} title={tr("gitview.reviewNoChanges", { base: list.base })} /> : <div className="git-branch-review-columns">
        <nav aria-label={tr("gitview.changedFiles")} className="git-branch-review-files">{list.files.map((file) => {
          const identity = fileIdentity(file.path);
          return <button type="button" key={file.path} className="git-branch-review-file" aria-pressed={path === file.path} title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path} onClick={() => selectPath(file.path)}>
            <StatusChip status={file.status} />
            <span className="git-file-identity">
              <span className="git-file-name">{identity.name}</span>
              <span className="git-file-directory"><span className="sr-only">{statusLabel(file.status)} · </span>{file.previousPath ? `${file.previousPath} → ` : ""}{identity.directory}</span>
            </span>
            <LineStats stats={file} mode={prefs.lineStats === "hidden" ? "numbers" : prefs.lineStats} />
          </button>;
        })}</nav>
        <div className="git-branch-review-detail">
          {fileLoading ? <div role="status" aria-busy="true" className="git-branch-review-loading"><span>{tr("gitview.reviewLoading")}</span></div> : patch ? <>
            {patch.binary ? <p className="source-inline-status">{tr("gitview.reviewBinary")}</p> : <DiffContent diff={patch.diff} path={patch.path} split={prefs.layout === "split"} wrap={prefs.wrap} />}
            {patch.truncated && <p className="source-inline-status" role="status">{tr("gitview.reviewTruncated")}</p>}
            {!patch.binary && <div className="git-branch-review-hunks" aria-label={tr("gitview.addReviewNote")}>
              {splitHunks(patch.diff).map((hunk, index) => <Button key={hunkDigest(hunk)} size="sm" variant="ghost" iconStart={AddIcon} aria-pressed={draftHunk ? hunkDigest(draftHunk) === hunkDigest(hunk) : false} onClick={() => { setDraftHunk(hunk); setText(""); }}>{tr("gitview.reviewNoteNearLineValue", { line: hunk.startNew })} · {index + 1}</Button>)}
            </div>}
            {draftHunk && <div className="review-draft"><Textarea aria-label={tr("gitview.addReviewNote")} rows={3} value={text} onChange={(event) => setText(event.target.value)} />
              <div className="commit-row">
                <Button size="sm" variant="ghost" onClick={() => setDraftHunk(null)}>{tr("common.cancel")}</Button>
                <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => { persist([...notes, { id: globalThis.crypto.randomUUID(), path: patch.path, line: draftHunk.startNew, mergeBase: patch.mergeBase, head: patch.head, createdAt: Date.now(), text: text.trim(), digest: hunkDigest(draftHunk), excerpt: capReviewExcerpt(draftHunk.body.join("\n")) }]); setDraftHunk(null); }}>{tr("gitview.addNote")}</Button>
              </div>
            </div>}
          </> : <EmptyState title={tr("gitview.selectAFileToReview")} description={tr("gitview.chooseAFileFromTheChangeList")} />}
        </div>
      </div>}
      {notes.length > 0 && <div className="review-list">
        <div className="stat-label">{tr("gitview.reviewNotesValue", { count: notes.length })}</div>
        {notes.map((note) => <div className={`review-note${note.outdated ? " outdated" : ""}`} key={note.id}>
          <div className="review-note-head">
            <span className="mono review-note-path" title={note.path}>{note.path}:{note.line}</span>
            {note.outdated && <span className="tag">{tr("gitview.outdated")}</span>}
            <span className="header-spacer" />
            <IconButton icon={CloseIcon} size="sm" variant="ghost" label={tr("gitview.removeReviewNote")} onClick={() => persist(notes.filter((item) => item.id !== note.id))} />
          </div>
          <p className="review-note-text">{note.text}</p>
        </div>)}
      </div>}
      {(notes.length > 0 || inserted) && <div className="git-branch-review-foot">
        {!canInsert && <p className="muted">{tr("gitview.reviewSessionRequired")}</p>}
        {inserted && <p className="form-success" role="status">{tr("gitview.reviewInserted")}</p>}
        {notes.length > 0 && <Button variant="primary" size="sm" iconStart={AssistIcon} disabled={!canInsert || !currentNotes.length || inserting || loading || missing} onClick={() => void insertNotes()}>{tr("gitview.insertReviewNotes", { count: currentNotes.length })}</Button>}
      </div>}
    </>}
  </section>;
}

export default function GitView({
  host,
  projectId: scopedProjectId,
  sessionId: scopedSessionId,
}: SurfaceComponentProps & { host?: WebPackageHost } = {}) {
  const Slot = host?.ui.Slot;
  const storeProjectId = useStore(workspaceProjectId);
  const storeSessionId = useStore((state) => state.activeSessionId);
  const projectId = scopedProjectId === undefined ? storeProjectId : scopedProjectId;
  const sessionId = scopedSessionId === undefined ? storeSessionId : scopedSessionId;
  const project = useStore((state) => state.projectRegistry.projects.find((candidate) => candidate.id === projectId) ?? null);
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const workspace = useMemo(() => {
    if (!project) return null;
    try { return resolveWorkspaceContext(project, session); } catch { return null; }
  }, [project, session]);
  const workspaceInvalid = project !== null && (workspace === null || (sessionId !== null && sessionId !== undefined && session === null));
  const repositoryRows = workspace?.repositories ?? EMPTY_REPOSITORIES;
  const repositoryOptions = repositoryRows.map((repository) => ({ id: repository.repositoryId, alias: repository.alias, detail: repository.state === "missing" ? `${repository.path} · missing` : repository.path }));
  const primaryRepositoryId = useMemo(() => {
    if (!workspace || !project) return null;
    if (project.primaryRepositoryId) return project.primaryRepositoryId;
    const root = repositoryRows.find((repository) => repository.path === project.path);
    return root?.repositoryId ?? (repositoryRows.length === 1 ? repositoryRows[0]!.repositoryId : null);
  }, [project, repositoryRows, workspace]);
  const [storedRepositoryId, setStoredRepositoryId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setStoredRepositoryId(projectId ? getGitRepositorySelection(projectId, sessionId) : undefined);
  }, [projectId, sessionId]);
  const selectedRepositoryId = useMemo(() => {
    if (repositoryRows.length === 0) return undefined;
    if (storedRepositoryId === null && repositoryRows.length > 1) return null;
    if (storedRepositoryId && repositoryRows.some((repository) => repository.repositoryId === storedRepositoryId)) return storedRepositoryId;
    return primaryRepositoryId ?? repositoryRows[0]?.repositoryId;
  }, [primaryRepositoryId, repositoryRows, storedRepositoryId]);
  const allRepositoriesSelected = !workspaceInvalid && selectedRepositoryId === null && repositoryRows.length > 1;
  // Preserve the legacy API shape for projects without an explicit inventory.
  const repositoryId = workspaceInvalid
    ? "__invalid_workspace__"
    : allRepositoriesSelected ? undefined : project?.repositories ? (selectedRepositoryId ?? undefined) : undefined;
  const [storedRemoteName, setStoredRemoteName] = useState<string | undefined>(undefined);
  const [remoteOptions, setRemoteOptions] = useState<RepositorySourceControlRemote[]>([]);
  const [remoteOptionsError, setRemoteOptionsError] = useState("");
  const [remoteInspectionRevision, setRemoteInspectionRevision] = useState(0);
  const remoteTargetAvailable = remoteOptionsError === "" && remoteOptions.length > 0;
  const retryRemoteInspection = useCallback(() => setRemoteInspectionRevision((value) => value + 1), []);
  useEffect(() => {
    setStoredRemoteName(projectId ? getGitRemoteSelection(projectId, sessionId, repositoryId) : undefined);
  }, [projectId, repositoryId, sessionId]);
  useEffect(() => {
    if (!projectId || allRepositoriesSelected || workspaceInvalid) {
      setRemoteOptions([]);
      setRemoteOptionsError("");
      return;
    }
    let active = true;
    setRemoteOptions([]);
    setRemoteOptionsError("");
    void repositorySourceControlRemotes(projectId, repositoryId, sessionId)
      .then((next) => { if (active) setRemoteOptions(next); })
      .catch((cause) => { if (active) setRemoteOptionsError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [allRepositoriesSelected, projectId, repositoryId, remoteInspectionRevision, sessionId, workspaceInvalid]);
  const selectedRemoteName = useMemo(() => {
    if (storedRemoteName && (remoteOptions.length === 0 || remoteOptions.some((option) => option.remoteName === storedRemoteName))) return storedRemoteName;
    return remoteOptions.find((option) => option.remoteName === "origin")?.remoteName
      ?? remoteOptions[0]?.remoteName
      ?? "origin";
  }, [remoteOptions, storedRemoteName]);
  useEffect(() => {
    if (!projectId || allRepositoriesSelected || remoteOptions.length === 0) return;
    if (storedRemoteName !== selectedRemoteName) {
      setStoredRemoteName(selectedRemoteName);
      setGitRemoteSelection(projectId, sessionId, selectedRemoteName, repositoryId);
    }
  }, [allRepositoriesSelected, projectId, remoteOptions.length, repositoryId, selectedRemoteName, sessionId, storedRemoteName]);
  const remoteChoices = useMemo(() => remoteOptions.map((option) => ({
    value: option.remoteName,
    label: option.remoteName,
    detail: remoteDetail(option),
  })), [remoteOptions]);
  const selectedRepository = repositoryRows.find((repository) => repository.repositoryId === selectedRepositoryId) ?? null;
  const isPrimaryRepository = !workspaceInvalid && !allRepositoriesSelected && (!selectedRepositoryId || selectedRepositoryId === primaryRepositoryId);
  const gitViewScope = `${projectId ?? ""}\0${sessionId ?? ""}\0${selectedRepositoryId ?? (allRepositoriesSelected ? "all" : "primary")}`;
  const chooseRepository = useCallback((next: string | null) => {
    if (!projectId) return;
    setStoredRepositoryId(next);
    setGitRepositorySelection(projectId, sessionId, next);
    setCommitSel(null);
    setShowTreeForm(false);
    setShowPrForm(false);
  }, [projectId, sessionId]);
  const settings = useStore((state) => state.settings);
  const diffPath = useStore((state) => state.gitDiffPath);
  // This project's worktree topology revision. It moves when a worktree is
  // created or removed anywhere — here, by an agent, by a shell — and nothing
  // else moves it, so another project's churn never refetches this one.
  const worktreeTopology = useStore((state) => {
    const id = workspaceProjectId(state);
    return (id && state.worktreeTopology[id]) || 0;
  });
  const status = useGitStatus(projectId, true, sessionId, allRepositoriesSelected ? undefined : repositoryId, !allRepositoriesSelected);
  const statusRemoteName = status?.upstream?.split("/", 1)[0] ?? null;
  const statusMatchesSelectedRemote = remoteTargetAvailable && (!statusRemoteName || statusRemoteName === selectedRemoteName);
  const prefs = useGitPrefs(gitViewScope);
  const [tab, setTab] = useState<GitTab>(() => getGitViewState(gitViewScope).tab ?? "changes");
  // Restore the last tab per repository scope before any handoff below can
  // redirect to Changes, so an explicit navigation still wins.
  useEffect(() => { setTab(getGitViewState(gitViewScope).tab ?? "changes"); }, [gitViewScope]);
  const reviewPreference = useReviewScopePreference(projectId);
  const isolatedReview = !!(selectedRepositoryId
    ? session?.workspace ? session.workspace.repositories.find((row) => row.repositoryId === selectedRepositoryId)?.isolation : session?.isolation
    : session?.isolation);
  const reviewHandoffKey = projectId ? workspacePresentationKey("git-review-handoff", projectId, sessionId ?? null) : null;
  const [reviewScope, updateReviewScope] = useState<ReviewView>(() => defaultReviewScope(isolatedReview, reviewPreference));
  // The file the isolation card asked the Conflicts view to open; `seq` lets
  // the same file be asked for again.
  const [conflictRequest, setConflictRequest] = useState<{ path: string; seq: number } | null>(null);
  useEffect(() => {
    const receive = () => {
      const handoff = reviewHandoffKey ? consumeReviewScope(reviewHandoffKey) : undefined;
      if (handoff) {
        updateReviewScope(handoff.scope);
        if (handoff.path !== undefined) {
          const path = handoff.path;
          setConflictRequest((current) => ({ path, seq: (current?.seq ?? 0) + 1 }));
        }
        setTab("changes");
      }
      return handoff;
    };
    if (!receive()) updateReviewScope(defaultReviewScope(isolatedReview, reviewPreference));
    return subscribeReviewScope(receive);
  }, [reviewHandoffKey, isolatedReview, reviewPreference]);
  // Conflicts exist only while this session's single-repository isolation is
  // in conflict; once resolved the view falls back to the ordinary scope.
  const conflictIsolation = session?.isolation?.state === "conflict"
    && (session.workspace?.repositories.filter((row) => row.isolation).length ?? 0) <= 1
    ? session.isolation
    : null;
  // The landing ("where to integrate") belongs to a single-repository
  // isolation, shown while its repository is the one in view.
  const landingIsolation = isolatedReview && !!session?.isolation
    && (session.workspace?.repositories.filter((row) => row.isolation).length ?? 0) <= 1;
  const conflictKey = conflictIsolation
    ? `${conflictIsolation.conflict?.at ?? ""}\u0000${conflictIsolation.conflict?.files.join("\u0000") ?? ""}`
    : "";
  const reviewView: ReviewView = reviewScope === "conflicts" && !conflictIsolation
    ? defaultReviewScope(isolatedReview, reviewPreference)
    : reviewScope;

  const [branches, setBranches] = useState<GitBranches>({ current: null, branches: [] });
  const [trees, setTrees] = useState<Worktree[]>([]);
  // Worktrees are listed for the primary repository only; `refresh` empties
  // the list for any other scope, so this filter is the whole visibility rule.
  const visibleTrees = trees.filter((tree) => !tree.branch?.startsWith("polyth/isolate/"));
  const [graph, setGraph] = useState<GitGraphEntry[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [overviewEntries, setOverviewEntries] = useState<RepositoryOverviewEntry[]>([]);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [graphDone, setGraphDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<GitSelection | null>(null);
  const [diff, setDiff] = useState("");
  const [diffSnapshotDigest, setDiffSnapshotDigest] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [diffRetry, setDiffRetry] = useState(0);
  const [commitSel, setCommitSel] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState("");
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [commitDiffError, setCommitDiffError] = useState("");
  const [commitDiffRetry, setCommitDiffRetry] = useState(0);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [commitDrafts, setCommitDrafts] = useState<Record<string, string>>({});
  const [newBranch, setNewBranch] = useState("");
  const [newTree, setNewTree] = useState("");
  const [stashMessage, setStashMessage] = useState("");
  const [showBranchForm, setShowBranchForm] = useState(false);
  const [showTreeForm, setShowTreeForm] = useState(false);
  const [showPrForm, setShowPrForm] = useState(false);
  const [selectedChangeProvider, setSelectedChangeProvider] = useState<string | null>(null);
  useEffect(() => { setSelectedChangeProvider(null); }, [projectId]);
  const [busy, setBusy] = useState(false);
  const [busyRemote, setBusyRemote] = useState<RemoteStep | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<{ step: RemoteStep; remote: string; error?: string; refusal?: GitRefusal } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [conflictAgentBusy, setConflictAgentBusy] = useState<ConflictAgentTarget | null>(null);
  const [conflictAgentMsg, setConflictAgentMsg] = useState("");
  const [conflictAgentFailed, setConflictAgentFailed] = useState(false);
  const [autoRebaseBusy, setAutoRebaseBusy] = useState(false);
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(new Set());
  const viewStateHydrated = useRef<string | null>(null);
  useEffect(() => {
    viewStateHydrated.current = null;
    const saved = getGitViewState(gitViewScope);
    setSelected(saved.selected ?? null);
    setClosedGroups(new Set(saved.closedGroups));
    setMobileDetail(Boolean(saved.selected));
    queueMicrotask(() => { viewStateHydrated.current = gitViewScope; });
  }, [gitViewScope]);
  useEffect(() => {
    if (viewStateHydrated.current !== gitViewScope) return;
    setGitViewState(gitViewScope, { selected: selected ?? undefined, closedGroups: [...closedGroups], tab });
  }, [closedGroups, gitViewScope, selected, tab]);
  useEffect(() => {
    const onHydrated = (event: Event): void => {
      if (!projectId || projectPresentationEventProjectId(event) !== projectId || !projectPresentationEventHasKey(event, "workspaceState")) return;
      setStoredRepositoryId(getGitRepositorySelection(projectId, sessionId));
      setStoredRemoteName(getGitRemoteSelection(projectId, sessionId, repositoryId));
      const saved = getGitViewState(gitViewScope);
      setSelected(saved.selected ?? null);
      setClosedGroups(new Set(saved.closedGroups));
      setMobileDetail(Boolean(saved.selected));
      queueMicrotask(() => { viewStateHydrated.current = gitViewScope; });
    };
    window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
    return () => window.removeEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
  }, [gitViewScope, projectId, repositoryId, sessionId]);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [draft, setDraft] = useState<{ digest: string; line: number } | null>(null);
  const [draftText, setDraftText] = useState("");
  const [graphQuery, setGraphQuery] = useState("");
  const [graphRef, setGraphRef] = useState("");
  const [graphLoading, setGraphLoading] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [closedBranchGroups, setClosedBranchGroups] = useState<ReadonlySet<BranchGroup>>(new Set(["remote"]));
  const [branchLimits, setBranchLimits] = useState<Record<BranchGroup, number>>({ local: 30, remote: 30 });
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [fileStats, setFileStats] = useState<Record<string, DiffLineStats>>({});
  // Which worktree row is mid-action, as `<path>:<step>`. Keyed by path so one
  // busy checkout never freezes the others' controls.
  const [treeBusy, setTreeBusy] = useState<string | null>(null);
  const scopeGeneration = useRef(0);
  const commitScopeKey = gitViewScope;
  const commitScopeRef = useRef(commitScopeKey);
  commitScopeRef.current = commitScopeKey;
  const commitMsg = commitDrafts[commitScopeKey] ?? "";
  const setCommitMsg = useCallback((next: string) => {
    setCommitDrafts((current) => {
      if (!next) {
        const copy = { ...current };
        delete copy[commitScopeKey];
        return copy;
      }
      return { ...current, [commitScopeKey]: next };
    });
  }, [commitScopeKey]);
  useEffect(() => {
    scopeGeneration.current += 1;
    setGenerating(false);
  }, [allRepositoriesSelected, projectId, sessionId, repositoryId]);

  const refresh = useCallback(async (showLoading = false): Promise<GitStatus | null> => {
    if (!projectId || allRepositoriesSelected) return null;
    if (showLoading) setLoading(true);
    setLoadError("");
    const generation = scopeGeneration.current;
    let nextStatus: GitStatus | null = null;
    try {
      nextStatus = await refreshGitStatus(projectId, sessionId, repositoryId);
      if (generation !== scopeGeneration.current) return null;
      if (!nextStatus) throw new Error(tr("gitview.theGitServiceDidNotRespond"));
      if (nextStatus.isRepo === false) {
        if (generation !== scopeGeneration.current) return null;
        setBranches({ current: null, branches: [] });
        setTrees([]);
        setGraph([]);
        setStashes([]);
        return nextStatus;
      }
      const [nextBranches, nextTrees, nextGraph, nextStashes] = await Promise.all([
        api.gitBranches(projectId, sessionId ?? undefined, repositoryId),
        // Ahead/behind/dirty per checkout is what makes the per-worktree
        // push/merge controls honest rather than decorative.
        isPrimaryRepository ? api.listWorktrees(projectId, { status: true }) : Promise.resolve([] as Worktree[]),
        api.gitGraph(projectId, GRAPH_PAGE, 0, sessionId ?? undefined, repositoryId),
        api.gitStashes(projectId, sessionId ?? undefined, repositoryId),
      ]);
      if (generation !== scopeGeneration.current) return null;
      setBranches({ ...nextBranches, branches: nextBranches.branches.filter((branch) => !isManagedIsolationBranch(branch.remote ? branch.name.slice(branch.remote.length + 1) : branch.name)) });
      setTrees(nextTrees.filter((tree) => !isManagedIsolationBranch(tree.branch)));
      setGraph(nextGraph);
      setStashes(nextStashes);
      setGraphDone(nextGraph.length < GRAPH_PAGE);
      if (isPrimaryRepository && nextBranches.current) setGitBranch(nextBranches.current);
    } catch (cause) {
      if (generation === scopeGeneration.current) setLoadError(friendlyError(tr("gitview.couldntLoadSourceControl"), cause));
    } finally {
      if (generation === scopeGeneration.current) setLoading(false);
    }
    return nextStatus;
  }, [allRepositoriesSelected, isPrimaryRepository, projectId, repositoryId, sessionId]);

  const repositoryOverviewKey = repositoryRows
    .map((repository) => `${repository.repositoryId}\0${repository.path}\0${repository.state}`)
    .join("\0");
  useEffect(() => {
    if (!allRepositoriesSelected || !projectId) {
      setOverviewEntries([]);
      setOverviewLoading(false);
      return;
    }
    const generation = scopeGeneration.current;
    let cancelled = false;
    setOverviewLoading(true);
    void Promise.all(repositoryRows.map(async (repository): Promise<RepositoryOverviewEntry> => {
      const base = {
        repositoryId: repository.repositoryId,
        alias: repository.alias,
        path: repository.path,
        state: repository.state,
      } as const;
      if (repository.state === "missing") return { ...base, status: null, error: tr("gitview.repositoryMissing") };
      try {
        const nextStatus = await api.gitStatus(projectId, sessionId ?? undefined, repository.repositoryId);
        return {
          ...base,
          status: nextStatus,
          ...(nextStatus.isRepo === false ? { error: tr("gitview.folderNotARepository") } : {}),
        };
      } catch (cause) {
        return { ...base, status: null, error: friendlyError(tr("gitview.couldntLoadSourceControl"), cause) };
      }
    })).then((entries) => {
      if (!cancelled && generation === scopeGeneration.current) setOverviewEntries(entries);
    }).finally(() => {
      if (!cancelled && generation === scopeGeneration.current) setOverviewLoading(false);
    });
    return () => { cancelled = true; };
  }, [allRepositoriesSelected, projectId, repositoryOverviewKey, repositoryRows, sessionId]);

  useEffect(() => {
    setSelected(null);
    setCommitSel(null);
    setMobileDetail(false);
    setGraphLoading(false);
    setBranches({ current: null, branches: [] });
    setTrees([]);
    setGraph([]);
    setStashes([]);
    void refresh(true);
  }, [refresh]);

  // A topology change re-reads the lists but must not disturb the pane: the
  // open diff, the commit selection and the mobile detail view all survive,
  // because a worktree appearing elsewhere is not a reason to lose your place.
  const topologyHydrated = useRef(false);
  useEffect(() => {
    if (!topologyHydrated.current) { topologyHydrated.current = true; return; }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeTopology]);

  useEffect(() => {
    setComments(projectId && isPrimaryRepository ? loadComments(projectId) : []);
  }, [isPrimaryRepository, projectId, repositoryId]);

  useEffect(() => {
    if (!diffPath || !status) return;
    const file = [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted].find((candidate) => candidate.path === diffPath);
    // The resource is a navigation request, not a standing selection. Keeping
    // it set makes every polled status refresh reopen the old file after the
    // user returns to the change list.
    setGitDiffPath(null);
    setTab("changes");
    setCommitSel(null);
    setSelected({ path: diffPath, staged: file?.staged ?? false });
    setMobileDetail(true);
  }, [diffPath, status]);

  useEffect(() => {
    if (projectId && selected) setPaneLastResource(projectId, "git", `changes:${repositoryId ?? "primary"}:${selected.path}`);
  }, [projectId, repositoryId, selected]);

  useEffect(() => {
    if (!projectId || !selected || status?.isRepo === false || reviewView !== "working") return;
    let active = true;
    setDiff("");
    setDiffSnapshotDigest("");
    setDiffError("");
    setDiffLoading(true);
    setDraft(null);
    void api.gitDiff(projectId, selected.path, selected.staged, prefs.ignoreWhitespace, sessionId ?? undefined, repositoryId)
      .then((result) => {
        if (!active) return;
        setDiff(result.diff);
        setDiffSnapshotDigest(gitDiffSnapshotDigestOf(result));
      })
      .catch((cause) => {
        if (active) setDiffError(friendlyError(tr("gitview.couldntLoadTheFileDiff"), cause));
      })
      .finally(() => { if (active) setDiffLoading(false); });
    return () => { active = false; };
  }, [projectId, repositoryId, sessionId, selected, status?.isRepo, prefs.ignoreWhitespace, diffRetry, reviewView]);

  useEffect(() => {
    if (!projectId || !commitSel) return;
    let active = true;
    setCommitDiff("");
    setCommitDiffError("");
    setCommitDiffLoading(true);
    void api.gitShow(projectId, commitSel, prefs.ignoreWhitespace, sessionId ?? undefined, repositoryId)
      .then((result) => { if (active) setCommitDiff(result.diff); })
      .catch((cause) => {
        if (active) setCommitDiffError(friendlyError(tr("gitview.couldntLoadTheCommitDiff"), cause));
      })
      .finally(() => { if (active) setCommitDiffLoading(false); });
    return () => { active = false; };
  }, [projectId, repositoryId, sessionId, commitSel, prefs.ignoreWhitespace, commitDiffRetry]);

  // Only re-summarize once the set of changed paths actually shifts — the
  // status poll below replaces `status` every 2.5s even when nothing changed.
  const changeKey = status
    ? [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked]
        .map(fileStatKey).sort().join("\0")
    : "";

  useEffect(() => {
    if (!projectId || !status || status.isRepo === false || !changeKey) {
      setFileStats({});
      return;
    }
    const files = [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked];
    let cancelled = false;
    void Promise.all(files.map(async (file) => {
      try {
        const result = await api.gitDiff(projectId, file.path, file.staged, false, sessionId ?? undefined, repositoryId);
        return [fileStatKey(file), summarizeUnifiedDiff(result.diff)] as const;
      } catch {
        return [fileStatKey(file), null] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      const next: Record<string, DiffLineStats> = {};
      for (const [key, stats] of entries) if (stats) next[key] = stats;
      setFileStats(next);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by changeKey, not the polled status object
  }, [projectId, repositoryId, sessionId, changeKey]);

  useEffect(() => {
    // A fixable refusal stays until acted on or replaced.
    if (!remoteStatus || remoteStatus.refusal) return;
    const timer = window.setTimeout(() => setRemoteStatus(null), remoteStatus.error ? 6_000 : 3_500);
    return () => window.clearTimeout(timer);
  }, [remoteStatus]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      const nextStatus = await refresh();
      if (nextStatus) {
        const nextSelected = reconcileGitSelection(selected, nextStatus);
        setSelected(nextSelected);
        if (selected && !nextSelected) setMobileDetail(false);
      }
    } catch (cause) {
      reportGitError(tr("gitview.couldntUpdateTheRepository"), cause);
    } finally {
      setBusy(false);
    }
  };

  const runHunkAction = (operation: GitHunkOperation, hunk: DiffHunk, hunkIndex: number) => {
    if (!projectId || !selected || !diffSnapshotDigest || busy) return;
    const action = () => mutateGitHunk(operation, {
      projectId,
      ...(sessionId ? { sessionId } : {}),
      ...(repositoryId ? { repositoryId } : {}),
      path: selected.path,
      hunkIndex,
      hunkDigest: hunkDigest(hunk),
      expectedSnapshotDigest: diffSnapshotDigest,
      expectedStaged: selected.staged,
      ...(prefs.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    });
    if (operation === "discard") {
      setConfirmRequest({
        title: tr("gitview.discardFileChanges"),
        description: tr("gitview.revertValue", { path: selected.path }),
        confirmLabel: tr("common.discardChanges"),
        action,
      });
      return;
    }
    void run(action);
  };

  // One button: commit what's staged (when a message is present), then sync via
  // the server-owned fetch/integrate/publish flow.
  const syncRepository = async () => {
    if (!projectId) return;
    if (commitMsg.trim() && (status?.staged.length ?? 0) > 0) {
      await api.gitCommit(projectId, commitMsg.trim(), sessionId ?? undefined, repositoryId);
      setCommitMsg("");
      setSelected(null);
      setMobileDetail(false);
    }
    await api.gitSync(projectId, selectedRemoteName, sessionId ?? undefined, { repositoryId });
  };

  const runRemote = async (step: RemoteStep) => {
    if (!projectId || !remoteTargetAvailable || autoRebaseBusy) return;
    const remote = selectedRemoteName;
    setBusyRemote(step);
    setRemoteStatus(null);
    try {
      if (step === "sync") {
        await syncRepository();
      } else {
        const action = step === "fetch" ? api.gitFetch : step === "pull" ? api.gitPull : api.gitPush;
        await action(projectId, remote, sessionId ?? undefined, { repositoryId });
      }
      setRemoteStatus({ step, remote });
      await refresh();
    } catch (cause) {
      setRemoteStatus({ step, remote, error: cause instanceof Error ? cause.message : String(cause), ...refusalField(cause) });
    } finally {
      setBusyRemote(null);
    }
  };

  const autoRebaseAndSync = async () => {
    if (!projectId || !remoteTargetAvailable || autoRebaseBusy || busyRemote !== null) return;
    const remote = selectedRemoteName;
    setAutoRebaseBusy(true);
    setRemoteStatus(null);
    setConflictAgentMsg("");
    setConflictAgentFailed(false);
    try {
      await api.gitRebase(projectId, remote, sessionId ?? undefined, { repositoryId });
      await api.gitPush(projectId, remote, sessionId ?? undefined, { repositoryId });
      setRemoteStatus({ step: "sync", remote });
      await refresh();
    } catch (cause) {
      setRemoteStatus({ step: "sync", remote, error: cause instanceof Error ? cause.message : String(cause), ...refusalField(cause) });
      await refresh();
    } finally {
      setAutoRebaseBusy(false);
    }
  };

  // Remote steps aimed at one linked checkout. The path is a selector, not a
  // trusted root: the server matches it against this project's own worktree
  // list before Git touches anything.
  const runTreeRemote = async (tree: Worktree, step: RemoteStep) => {
    if (!projectId || !remoteTargetAvailable || treeBusy) return;
    const remote = selectedRemoteName;
    setTreeBusy(`${tree.path}:${step}`);
    try {
      const scope = { worktreePath: tree.path };
      if (step === "fetch") await api.gitFetch(projectId, remote, undefined, scope);
      else if (step === "pull") await api.gitPull(projectId, remote, undefined, scope);
      else if (step === "push") await api.gitPush(projectId, remote, undefined, scope);
      else await api.gitSync(projectId, remote, undefined, scope);
      await refresh();
    } catch (cause) {
      reportGitError(tr("gitview.worktreeActionFailed"), cause);
    } finally {
      setTreeBusy(null);
    }
  };

  // Merge a linked checkout's branch into the branch this project has checked
  // out. A conflict is an expected outcome, not an error: Git stops with the
  // tree conflicted, so hand the user to the Changes tab where the conflict
  // tools already live instead of silently aborting their merge.
  const mergeTree = async (tree: Worktree) => {
    if (!projectId || !tree.branch || treeBusy) return;
    setTreeBusy(`${tree.path}:merge`);
    try {
      const result = await api.gitMerge(projectId, tree.branch, repositoryId ? { repositoryId } : undefined);
      await refresh();
      if (!result.ok) {
        setTab("changes");
        setUiError(tr("gitview.mergeStoppedOnConflicts", { count: result.conflicted.length }));
      }
    } catch (cause) {
      reportGitError(tr("gitview.worktreeActionFailed"), cause);
    } finally {
      setTreeBusy(null);
    }
  };

  // Removal keeps its two-step shape: the first refusal carries the dirty
  // count, and only an explicit second confirmation destroys uncommitted work.
  const requestRemoveTree = (tree: Worktree) => {
    if (!projectId) return;
    setConfirmRequest({
      title: tr("gitview.removeWorktreeQuestion"),
      description: tr("gitview.theLinkedWorktreeAtValue", { path: tree.path }),
      confirmLabel: tr("gitview.removeWorktree"),
      action: async () => {
        const finish = async (force?: boolean) => {
          const result = await api.removeWorktree(projectId, tree.path, true, force);
          if (result.metadataCleanupFailed || result.branchCleanupFailed) {
            setUiError(tr("gitview.couldntCleanUpAfterRemovingTheWorktree"));
          }
        };
        try {
          await finish();
        } catch (err) {
          if (errorCodeOf(err) !== "worktree-dirty") throw err;
          const changes = errorChangesOf(err);
          setConfirmRequest({
            title: tr("gitview.removeWorktreeQuestion"),
            description: changes > 0
              ? tr("gitview.destroyDirtyWorktreeValue", { count: changes })
              : tr("gitview.destroyDirtyWorktree"),
            confirmLabel: tr("gitview.removeWorktree"),
            action: () => finish(true),
          });
        }
      },
    });
  };

  const openConflictAgentDraft = async (target: ConflictAgentTarget, problem?: string) => {
    if (conflictAgentBusy || autoRebaseBusy || !projectId) return;
    const currentSessionId = sessionId;
    if (target === "current-session" && !currentSessionId) {
      setConflictAgentFailed(true);
      setConflictAgentMsg(tr("pullrequestview.conflictAgentNeedsCurrentSession"));
      return;
    }
    setConflictAgentBusy(target);
    setConflictAgentMsg("");
    setConflictAgentFailed(false);
    try {
      const result = await api.gitConflictPrompt({
        projectId,
        target,
        prompt: settings.conflictAgentPrompt,
        ...(problem?.trim() ? { problem: problem.trim() } : {}),
        ...(target === "current-session" && currentSessionId ? { sessionId: currentSessionId } : {}),
      });
      if (!result.ok) {
        setConflictAgentFailed(true);
        setConflictAgentMsg(result.reason);
        return;
      }
      if (target === "new-session") {
        startNewSession(projectId, { draft: result.data.prompt });
      } else if (currentSessionId) {
        await openSession(currentSessionId);
        requestComposerReplace(result.data.prompt);
      }
      setConflictAgentMsg(tr("gitview.conflictAgentDraftReady"));
    } catch (cause) {
      setConflictAgentFailed(true);
      setConflictAgentMsg(friendlyError(tr("pullrequestview.conflictAgentFailed"), cause));
    } finally {
      setConflictAgentBusy(null);
    }
  };

  const openFile = (file: GitFileEntry) => {
    setCommitSel(null);
    setSelected({ path: file.path, staged: file.staged });
    setMobileDetail(true);
  };

  const toggleGroup = (id: string) => {
    setClosedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const loadMoreGraph = async () => {
    if (!projectId || graphLoading) return;
    const generation = scopeGeneration.current;
    setGraphLoading(true);
    try {
      const more = await api.gitGraph(projectId, GRAPH_PAGE, graph.length, sessionId ?? undefined, repositoryId);
      if (generation !== scopeGeneration.current) return;
      setGraph((current) => [...current, ...more]);
      if (more.length < GRAPH_PAGE) setGraphDone(true);
    } catch (cause) {
      if (generation === scopeGeneration.current) setUiError(friendlyError(tr("gitview.couldntLoadOlderCommits"), cause));
    } finally {
      if (generation === scopeGeneration.current) setGraphLoading(false);
    }
  };

  const all = status ? [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked] : [];
  const hunks = useMemo(() => splitHunks(diff), [diff]);
  const graphRows = useMemo(() => layoutGraph(graph), [graph]);
  const ResourceLink = host?.ui.components.ResourceLink;
  const resourceFor = useCallback((file: GitFileEntry): ResourceRef | undefined => {
    if (!projectId) return undefined;
    return {
      scheme: "file",
      locator: file.path,
      projectId,
      sessionId: sessionId ?? null,
      ...(repositoryId && repositoryId !== "__invalid_workspace__" ? { repositoryId } : {}),
    };
  }, [projectId, repositoryId, sessionId]);
  const dragFile = useCallback((event: DragEvent<HTMLElement>, file: GitFileEntry) => {
    const drag = host?.resources.drag;
    const resource = resourceFor(file);
    if (!drag || !resource) return;
    const loaded = selected?.path === file.path && selected.staged === file.staged && !diffLoading && !diffError && Boolean(diffSnapshotDigest);
    drag(event.dataTransfer, resource, {
      context: {
        kind: "working-changes",
        staged: file.staged,
        ...(loaded ? { snapshotDigest: diffSnapshotDigest } : {}),
      },
    });
  }, [diffError, diffLoading, diffSnapshotDigest, host, resourceFor, selected]);
  const dragHunk = useCallback((event: DragEvent<HTMLElement>, hunk: DiffHunk) => {
    const drag = host?.resources.drag;
    if (!drag || !projectId || !selected || !diffSnapshotDigest || diffLoading || diffError) return;
    const resource = resourceFor({ path: selected.path, staged: selected.staged, status: "modified" });
    if (!resource) return;
    drag(event.dataTransfer, resource, {
      context: {
        kind: "working-changes",
        staged: selected.staged,
        snapshotDigest: diffSnapshotDigest,
        hunkDigest: hunkDigest(hunk),
      },
    });
  }, [diffError, diffLoading, diffSnapshotDigest, host, projectId, resourceFor, selected]);
  const branchChips = useMemo(() => {
    const refs = new Set<string>();
    for (const commit of graph) {
      for (const ref of commit.refs) {
        if (!ref.startsWith("tag: ")) refs.add(ref.replace(/^HEAD -> /, ""));
      }
    }
    return [...refs].slice(0, 12);
  }, [graph]);
  const visibleGraph = useMemo(() => {
    const query = graphQuery.trim().toLowerCase();
    return graph.map((commit, index) => ({ commit, row: graphRows[index] }))
      .filter(({ commit }) => {
        const refMatch = !graphRef || commit.refs.some((ref) => ref.replace(/^HEAD -> /, "") === graphRef);
        const queryMatch = !query || [commit.subject, commit.author, commit.shortSha, ...commit.refs].some((value) => value.toLowerCase().includes(query));
        return refMatch && queryMatch;
      });
  }, [graph, graphRows, graphQuery, graphRef]);
  const fileComments = comments.filter((comment) => comment.path === selected?.path);
  const selectedCommit = graph.find((commit) => commit.sha === commitSel);
  const { add: addCount, del: delCount } = diffStat(diff);
  const totalFileStats = totalDiffStats(Object.values(fileStats));

  const remoteLabel: Record<RemoteStep, { idle: string; busy: string }> = {
    fetch: { idle: tr("gitview.fetch"), busy: tr("gitview.fetching") },
    pull: { idle: tr("gitview.pull"), busy: tr("gitview.pulling") },
    push: { idle: tr("gitview.push"), busy: tr("gitview.pushing") },
    sync: { idle: tr("gitview.syncRepository"), busy: tr("gitview.syncRepository") },
  };

  if (!projectId) {
    return (
      <ProjectRequiredEmpty
        title={tr("gitview.noProjectSelected")}
        description={tr("gitview.openAProjectToInspectItsGit")}
      />
    );
  }

  if (allRepositoriesSelected) {
    return (
      <div className="git-page git-repository-overview-page" data-density={prefs.density}>
        <header className="source-control-head git-repository-overview-head" aria-label={tr("gitview.sourceControl")}>
          <div className="source-control-title">
            <strong>{tr("gitview.allRepositories")}</strong>
            <span className="muted">{tr("gitview.readOnlyOverview")}</span>
          </div>
          <RepositoryScopePicker
            mode="all"
            label={tr("gitview.repository")}
            repositories={repositoryOptions}
            value={null}
            onChange={chooseRepository}
          />
        </header>
        <div className="git-repository-overview" aria-busy={overviewLoading}>
          {overviewLoading && overviewEntries.length === 0 && <div className="source-inline-status" role="status">{tr("gitview.loadingRepositoryStatus")}</div>}
          {overviewEntries.map((entry) => {
            const changed = gitChangedCount(entry.status);
            const ahead = gitUnpushedCount(entry.status);
            const behind = entry.status?.behind ?? 0;
            return (
              <button
                type="button"
                className={`git-repository-overview-card${entry.error ? " has-error" : ""}`}
                key={entry.repositoryId}
                onClick={() => chooseRepository(entry.repositoryId)}
              >
                <span className="git-repository-overview-glyph" aria-hidden="true"><UiIcon icon={entry.error ? WarningIcon : WorktreeIcon} size="md" /></span>
                <span className="git-repository-overview-main">
                  <strong>{entry.alias}</strong>
                  <span className="muted mono" title={entry.path}>{entry.path}</span>
                </span>
                <span className="git-repository-overview-branch">
                  {entry.error ?? <><UiIcon icon={BranchIcon} size="sm" /><span>{entry.status?.branch || tr("gitview.noBranch")}</span></>}
                </span>
                <span className="git-repository-overview-stats">
                  <span className={changed > 0 ? "is-dirty" : undefined}>{tr("gitview.changedValue", { count: changed })}</span>
                  <span className={ahead > 0 ? "ahead" : undefined} title={tr("gitview.commitsToPushValue", { count: ahead })}>{tr("gitview.aheadValue", { count: ahead })}</span>
                  {behind > 0 && <span className="behind" title={tr("gitview.commitsToPullValue", { count: behind })}>{tr("gitview.behindValue", { count: behind })}</span>}
                </span>
                <span className="git-repository-overview-open">{tr("gitview.open")}</span>
              </button>
            );
          })}
          {!overviewLoading && overviewEntries.length === 0 && (
            <EmptyState variant="compact" title={tr("gitview.noRepositoriesInWorkspace")} />
          )}
        </div>
      </div>
    );
  }

  if (loading && !status) {
    return (
      <div className="git-page" aria-busy="true" aria-label={tr("gitview.loadingSourceControl")}>
        <div className="source-skeleton skeleton-title" />
        <div className="source-skeleton skeleton-tabs" />
        <div className="source-skeleton skeleton-panel" />
      </div>
    );
  }

  if (loadError && !status) {
    return <EmptyState title={tr("gitview.sourceControlUnavailable")} description={loadError} actionLabel={tr("common.retry")} onAction={() => void refresh(true)} />;
  }

  if (status?.isRepo === false) {
    return (
      <div className="git-page">
        <EmptyState
          title={tr("gitview.thisFolderIsntAGitRepository")}
          description={tr("gitview.initializeGitInThisProject")}
          actionLabel={tr("gitview.checkAgain")}
          onAction={() => void refresh(true)}
        />
      </div>
    );
  }

  const changeGroups: ChangeGroup[] = [
    { id: "merge", title: tr("gitview.mergeChanges"), files: status?.conflicted ?? [] },
    { id: "staged", title: tr("gitview.stagedChanges"), files: status?.staged ?? [] },
    { id: "changes", title: tr("gitview.tabChanges"), files: status?.unstaged ?? [] },
    { id: "untracked", title: tr("gitview.untracked"), files: status?.untracked ?? [] },
  ].filter((group) => group.files.length > 0);

  const persistComments = (next: ReviewComment[]) => {
    if (!isPrimaryRepository) return;
    setComments(next);
    saveComments(projectId, next);
  };

  const selectTab = (next: GitTab) => {
    setTab(next);
    setMobileDetail(false);
  };

  const commitStaged = async () => {
    await api.gitCommit(projectId, commitMsg.trim(), sessionId ?? undefined, repositoryId);
    setCommitMsg("");
    setSelected(null);
    setMobileDetail(false);
  };

  const stageMany = (paths: string[], stage: boolean) => {
    if (paths.length === 0) return;
    void run(() => stage
      ? api.gitStage(projectId, paths, sessionId ?? undefined, repositoryId)
      : api.gitUnstage(projectId, paths, sessionId ?? undefined, repositoryId));
  };

  const requestDiscard = (file: GitFileEntry) => setConfirmRequest({
    title: tr("gitview.discardFileChanges"),
    description: tr("gitview.allUncommittedChangesInValue", { path: file.path }),
    confirmLabel: tr("common.discardChanges"),
    action: () => api.gitDiscard(projectId, [file.path], sessionId ?? undefined, repositoryId),
  });

  const remoteBlocked = busy || busyRemote !== null || autoRebaseBusy || !remoteTargetAvailable;
  const selectedRemote = remoteOptions.find((option) => option.remoteName === selectedRemoteName);
  const remoteNames = new Set([...remoteOptions.map((option) => option.remoteName), ...branches.branches.flatMap((branch) => branch.remote ? [branch.remote] : [])]);
  const subjectLength = commitMsg.split("\n", 1)[0]?.trim().length ?? 0;
  const selectedFile = selected ? all.find((file) => file.path === selected.path && file.staged === selected.staged) ?? null : null;
  const stagedCount = status?.staged.length ?? 0;
  const conflictCount = status?.conflicted.length ?? 0;
  const branchFilterOptions = [
    { value: "", label: tr("gitview.allBranches") },
    ...branchChips.map((ref) => ({ value: ref, label: ref })),
  ];
  const commitBody = commitDiff ? parseCommitPrelude(commitDiff).body : "";

  return (
    <div className="git-page" data-density={prefs.density}>
      <WorkspaceSurfaceHeader
        className="source-control-head"
        label={tr("gitview.sourceControl")}
        scope={repositoryOptions.length > 1 ? <RepositoryScopePicker
          mode="all"
          label={tr("gitview.repository")}
          repositories={repositoryOptions}
          value={selectedRepositoryId ?? null}
          onChange={chooseRepository}
        /> : undefined}
        context={<div className="source-control-title">
          {/* Title + close come from the shared ContextRail / ModuleView header. */}
          <span className="source-branch" title={status?.upstream ? tr("gitview.trackingValue", { upstream: status.upstream }) : status?.branch || undefined}>
            <UiIcon icon={BranchIcon} size="sm" />
            <span className="mono">{status?.branch || tr("gitview.detachedHead")}</span>
          </span>
          {status && statusMatchesSelectedRemote && (status.ahead > 0 || status.behind > 0) && (
            <span className="git-ahead-behind">
              {status.ahead > 0 && <span className="ahead" title={tr("gitview.commitsToPushValue", { count: status.ahead })}>↑ {status.ahead}</span>}
              {status.behind > 0 && <span className="behind" title={tr("gitview.commitsToPullValue", { count: status.behind })}>↓ {status.behind}</span>}
            </span>
          )}
          {selectedRepository && repositoryOptions.length > 1 && <span className="muted source-repo-alias" title={selectedRepository.path}>{selectedRepository.alias}</span>}
          {Slot && isPrimaryRepository && <Slot slot="git.repository.identity" context={{ projectId, sessionId }} />}
        </div>}
        actions={<div className="source-remote-actions" aria-label={tr("gitview.remoteRepositoryActions")}>
          <div className="git-remote-context">
            {remoteChoices.length > 1 ? (
              <Select
                label={tr("gitview.remote")}
                ariaLabel={tr("gitview.chooseGitRemote")}
                value={selectedRemoteName}
                options={remoteChoices}
                onChange={(next) => {
                  if (!projectId) return;
                  setStoredRemoteName(next);
                  setGitRemoteSelection(projectId, sessionId, next, repositoryId);
                }}
                disabled={busy || busyRemote !== null || autoRebaseBusy || !remoteTargetAvailable}
                className="git-remote-picker"
              />
            ) : (
              <span
                className={`git-remote-name${remoteTargetAvailable ? "" : " is-unavailable"}`}
                title={selectedRemote ? `${remoteDetail(selectedRemote)} · ${tr("gitview.remoteTransportHint")}` : tr("gitview.remoteTransportHint")}
              >
                <span className="sr-only">{tr("gitview.remote")} </span>
                {remoteTargetAvailable ? selectedRemoteName : tr("gitview.remoteUnavailable")}
              </span>
            )}
          </div>
          <div className="source-remote-buttons">
            {remoteOptionsError && <Button size="sm" variant="ghost" onClick={retryRemoteInspection}>{tr("common.retry")}</Button>}
            <Button
              size="sm"
              className="source-action-btn source-sync-btn"
              iconStart={SyncIcon}
              busy={busyRemote !== null || autoRebaseBusy}
              disabled={remoteBlocked}
              title={tr("gitview.syncWithValue", { remote: selectedRemoteName })}
              onClick={() => void runRemote("sync")}
            >
              {busyRemote ? remoteLabel[busyRemote].busy : autoRebaseBusy ? remoteLabel.sync.busy : remoteLabel.sync.idle}
            </Button>
            <Menu
              label={tr("gitview.remoteRepositoryActions")}
              align="end"
              entries={(["fetch", "pull", "push"] as const).map((step) => ({
                id: step,
                label: remoteLabel[step].idle,
                detail: selectedRemoteName,
                icon: step === "fetch" ? FetchIcon : step === "pull" ? PullIcon : PushIcon,
                disabled: remoteBlocked,
                onSelect: () => { void runRemote(step); },
              }))}
            >
              {(trigger) => <IconButton {...trigger} icon={MoreIcon} size="sm" label={tr("gitview.remoteRepositoryActions")} disabled={remoteBlocked} />}
            </Menu>
            <IconButton icon={RefreshIcon} size="sm" className="source-refresh-btn" label={tr("gitview.refreshSourceControl")} disabled={busy || busyRemote !== null || autoRebaseBusy} onClick={() => { void refresh(); retryRemoteInspection(); }} />
          </div>
        </div>}
      />

      {(remoteOptionsError || remoteOptions.length === 0) && <div className="source-inline-status git-remote-error" role="status">
        <UiIcon icon={WarningIcon} size="sm" />
        <span>{remoteOptionsError || tr("gitview.noGitRemoteConfigured")}</span>
      </div>}

      <div className="git-feedback">
        {remoteStatus && (
          <div className={`source-inline-status ${remoteStatus.error ? "error" : "success"}`} role={remoteStatus.error ? "alert" : "status"}>
            <UiIcon icon={remoteStatus.error ? WarningIcon : CheckIcon} size="sm" />
            <span>{remoteStatus.error
              ? tr("gitview.stepFailedValue", { step: remoteLabel[remoteStatus.step].idle, error: remoteStatus.error })
              : tr("gitview.stepCompletedValue", { step: remoteLabel[remoteStatus.step].idle })}</span>
            <small className="git-feedback-remote mono">{remoteStatus.remote}</small>
            {remoteStatus.refusal && (
              <Button size="sm" variant="quiet" className="git-refusal-action" onClick={() => openGitRefusal(remoteStatus.refusal!)}>
                {remoteStatus.refusal.label}
              </Button>
            )}
          </div>
        )}

        {isPrimaryRepository && ((remoteStatus?.error && !remoteStatus.refusal) || (tab === "changes" && !!status?.conflicted.length)) && (
          <ConflictAgentBanner
            hint={[
              remoteStatus?.error && !remoteStatus.refusal ? (isDivergedError(remoteStatus.error)
                ? tr("gitview.historyDivergedHint")
                : tr("gitview.resolveProblemHint")) : "",
              status?.conflicted.length ? tr("gitview.filesConflictedHint", { count: status.conflicted.length }) : "",
            ].filter(Boolean).join(" ")}
            defaultTarget={settings.conflictAgentTarget}
            hasCurrentSession={!!sessionId}
            busy={conflictAgentBusy}
            message={conflictAgentMsg}
            failed={conflictAgentFailed}
            autoRebaseBusy={autoRebaseBusy}
            {...(remoteStatus?.error && isDivergedError(remoteStatus.error) ? { onAutoRebase: () => void autoRebaseAndSync() } : {})}
            onResolve={(target) => void openConflictAgentDraft(target, remoteStatus?.error)}
          />
        )}

      </div>

      {loadError && status && (
        <div className="source-inline-status error" role="alert">
          <span>{loadError}</span>
          <Button size="sm" disabled={loading} onClick={() => void refresh(true)}>{tr("common.retry")}</Button>
        </div>
      )}

      {confirmRequest && (
        <Dialog
          title={confirmRequest.title}
          onClose={() => setConfirmRequest(null)}
          initialFocus=".ui-dialog-foot .ui-btn:first-child"
          footer={
            <>
              <Button onClick={() => setConfirmRequest(null)}>{tr("common.cancel")}</Button>
              <Button variant="danger" disabled={busy} onClick={() => {
                const request = confirmRequest;
                setConfirmRequest(null);
                void run(request.action);
              }}>{confirmRequest.confirmLabel}</Button>
            </>
          }
        >
          <div className="source-confirm-dialog">
            <p>{confirmRequest.description}</p>
          </div>
        </Dialog>
      )}

      <SourceControlTabs
        value={tab}
        tabs={[
          { id: "changes", label: tabLabel(tr("gitview.tabChanges"), all.length, conflictCount > 0 ? "danger" : all.length > 0 ? "accent" : "neutral") },
          { id: "log", label: tr("gitview.tabLog") },
          { id: "branches", label: tabLabel(tr("gitview.tabBranches"), branches.branches.length) },
          { id: "stashes", label: tabLabel(tr("gitview.tabStashes"), stashes.length) },
        ]}
        onChange={selectTab}
      />

      {tab === "changes" && (
        <div className="git-changes-layout">
          <div className="source-subbar">
            <div className="git-review-scope source-segmented" role="group" aria-label={tr("gitview.reviewScope")}>
              {(["working", "branch"] as const).map((scope) => <Button key={scope} size="sm" variant="ghost" aria-pressed={reviewView === scope} onClick={() => {
                updateReviewScope(scope);
                if (projectId) setReviewScope(projectId, scope);
              }}>{tr(scope === "working" ? "gitview.workingTree" : "gitview.branchVsBase")}</Button>)}
              {conflictIsolation && (
                <Button size="sm" variant="ghost" className="git-review-scope-conflicts" aria-pressed={reviewView === "conflicts"} onClick={() => updateReviewScope("conflicts")}>
                  {tr("gitview.conflicts")}
                </Button>
              )}
            </div>
            <span className="header-spacer" />
            {reviewView === "working" && <ViewOptionsMenu prefs={prefs} />}
          </div>

          {reviewView === "conflicts" && sessionId && (
            <ConflictReviewPanel key={sessionId} sessionId={sessionId} conflictKey={conflictKey} requestedPath={conflictRequest} wrap={prefs.wrap} />
          )}

          {reviewView === "branch" && projectId && (
            <BranchReviewPanel key={`${workspacePresentationKey("git-branch-review", projectId, sessionId ?? null)}:${gitViewScope}`} target={{ projectId, sessionId, repositoryId }} host={host} prefs={prefs}
              prefsScope={gitViewScope} workspace={selectedRepository?.path ?? session?.worktreePath ?? project?.path ?? ""}
              branches={branches.branches} missing={workspaceInvalid || selectedRepository?.state === "missing" || session?.worktreeState === "missing"} />
          )}

          {reviewView === "working" && (
            <div className={`git-master-detail ${mobileDetail ? "detail-open" : ""}${all.length === 0 ? " is-clean" : ""}`}>
              <section className="git-master-pane" aria-label={tr("gitview.changedFiles")}>
                {all.length > 0 && <div className="git-pane-toolbar">
                  <div className="git-pane-summary">
                    <strong>{all.length === 1 ? tr("gitview.oneChangedFile") : tr("gitview.changedFilesValue", { count: all.length })}</strong>
                    <span className="muted">{[
                      conflictCount > 0 ? tr("gitview.conflictedValue", { count: conflictCount }) : "",
                      tr("gitview.stagedValue", { count: stagedCount }),
                    ].filter(Boolean).join(" · ")}</span>
                  </div>
                  {(totalFileStats.additions > 0 || totalFileStats.deletions > 0) && (
                    <span
                      className="diff-stat"
                      aria-label={tr("pendingchangesbar.valueAdditionsValueDeletions", {
                        additions: totalFileStats.additions,
                        deletions: totalFileStats.deletions,
                      })}
                    >
                      <span>+{totalFileStats.additions}</span>
                      <span>−{totalFileStats.deletions}</span>
                    </span>
                  )}
                  <div className="git-pane-actions">
                    {(status?.unstaged.length || status?.untracked.length || status?.conflicted.length) ? (
                      <Button size="sm" variant="ghost" className="git-stage-all" iconStart={StageIcon} disabled={busy} title={tr("gitview.stageAll")} onClick={() => void run(() => api.gitFolder(projectId, "", "stage", sessionId ?? undefined, repositoryId))}>
                        {tr("gitview.stageAll")}
                      </Button>
                    ) : null}
                    {(status?.unstaged.length || status?.untracked.length) ? (
                      <IconButton icon={UndoIcon} size="sm" variant="ghost" className="git-file-discard" label={tr("gitview.revertAll")} disabled={busy} onClick={() => setConfirmRequest({
                        title: tr("gitview.revertAllChangesQuestion"),
                        description: tr("pendingchangesbar.undoAllChangesDescription", {
                          count: (status?.unstaged.length ?? 0) + (status?.untracked.length ?? 0),
                        }),
                        confirmLabel: tr("gitview.revertAll"),
                        action: () => api.gitFolder(projectId, "", "discard", sessionId ?? undefined, repositoryId),
                      })} />
                    ) : null}
                    {stagedCount > 0 && (
                      <IconButton icon={MinusIcon} size="sm" variant="ghost" label={tr("gitview.unstageAll")} disabled={busy} onClick={() => void run(() => api.gitFolder(projectId, "", "unstage", sessionId ?? undefined, repositoryId))} />
                    )}
                  </div>
                </div>}
                <div className="git-change-groups">
                  {/* The default (bare) variant: the pane is already the card, and a
                      Look repaints compact/panel states as cards of their own. */}
                  {all.length === 0 && <EmptyState
                    mark={<UiIcon icon={CheckIcon} size="lg" />}
                    title={tr("gitview.workingTreeClean")}
                    description={tr("gitview.localEditsWillAppearHere")}
                  />}
                  {changeGroups.map((group) => (
                    <ChangeSection
                      key={group.id}
                      group={group}
                      view={prefs.changesView}
                      lineStats={prefs.lineStats}
                      closed={closedGroups}
                      selected={selected}
                      busy={busy}
                      fileStats={fileStats}
                      ResourceLink={ResourceLink}
                      resourceFor={resourceFor}
                      onToggle={toggleGroup}
                      onOpen={openFile}
                      onDragFile={host?.resources.drag ? dragFile : undefined}
                      onStage={(file) => void run(() => file.staged
                        ? api.gitUnstage(projectId, [file.path], sessionId ?? undefined, repositoryId)
                        : api.gitStage(projectId, [file.path], sessionId ?? undefined, repositoryId))}
                      onDiscard={requestDiscard}
                      onStageMany={stageMany}
                    />
                  ))}
                </div>
              </section>
              {all.length > 0 && <section className="git-detail-pane" aria-label={tr("gitview.changeDetails")}>
                {!selected ? (
                  <EmptyState
                    title={tr("gitview.selectAFileToReview")}
                    description={tr("gitview.chooseAFileFromTheChangeList")}
                  />
                ) : (
                  <>
                    <div className="git-detail-head">
                      <div className="git-mobile-detail-head">
                        <IconButton icon={BackIcon} size="sm" variant="ghost" label={tr("gitview.backToChanges")} onClick={() => setMobileDetail(false)} />
                      </div>
                      {selectedFile && <StatusChip status={selectedFile.status} staged={selectedFile.staged} />}
                      <div className="git-detail-title" title={selected.path}>
                        <strong>{fileIdentity(selected.path).name}</strong>
                        <span className="muted"><span className="mono">{fileIdentity(selected.path).directory}</span>{fileIdentity(selected.path).directory ? " · " : ""}{selected.staged ? tr("gitview.stagedChangesLower") : tr("gitview.workingTreeChanges")}</span>
                      </div>
                      {(addCount + delCount > 0) && <span className="diff-stat"><span>+{addCount}</span><span>−{delCount}</span></span>}
                      {selectedFile && <div className="git-detail-actions">
                        {!selectedFile.staged && selectedFile.status !== "conflicted" && <IconButton icon={UndoIcon} size="sm" variant="ghost" className="git-file-discard" label={tr("gitview.revertValue", { path: selectedFile.path })} title={tr("gitview.revert")} disabled={busy} onClick={() => requestDiscard(selectedFile)} />}
                        <Button size="sm" iconStart={selectedFile.staged ? MinusIcon : StageIcon} disabled={busy} onClick={() => void run(() => selectedFile.staged
                          ? api.gitUnstage(projectId, [selectedFile.path], sessionId ?? undefined, repositoryId)
                          : api.gitStage(projectId, [selectedFile.path], sessionId ?? undefined, repositoryId))}>
                          {selectedFile.staged ? tr("gitview.unstage") : selectedFile.status === "conflicted" ? tr("gitview.markResolved") : tr("gitview.stage")}
                        </Button>
                      </div>}
                    </div>
                    <DiffPrefsToolbar scope={gitViewScope} />
                    {diffLoading ? <DiffSkeleton /> : diffError ? (
                      <div className="source-inline-status error" role="alert">
                        <span>{diffError}</span>
                        <Button size="sm" onClick={() => setDiffRetry((value) => value + 1)}>{tr("common.retry")}</Button>
                      </div>
                    ) : prefs.layout === "split" || hunks.length === 0 ? (
                      <DiffContent diff={diff} path={selected.path} split={prefs.layout === "split"} wrap={prefs.wrap} />
                    ) : (
                      <div className="copy-wrap source-diff">
                        <pre className={`git-diff git-diff-page${prefs.wrap ? " wrap" : ""}`} data-diff-path={selected.path}>
                          {hunks.map((hunk, index) => (
                            <HunkBlock
                              key={index}
                              hunk={hunk}
                              hunkIndex={index}
                              path={selected.path}
                              staged={selected.staged}
                              busy={busy}
                              canMutate={!!diffSnapshotDigest}
                              onDragStart={host?.resources.drag ? (event) => dragHunk(event, hunk) : undefined}
                              onMutate={(operation) => runHunkAction(operation, hunk, index)}
                              onComment={isPrimaryRepository ? () => {
                                setDraft({ digest: hunkDigest(hunk), line: hunk.startNew });
                                setDraftText("");
                              } : undefined}
                            />
                          ))}
                        </pre>
                        <CopyButton text={diff} />
                      </div>
                    )}
                    {draft && (
                      <div className="review-draft">
                        <Textarea autoFocus rows={3} placeholder={tr("gitview.reviewNoteNearLineValue", { line: draft.line })} value={draftText} onChange={(event) => setDraftText(event.target.value)} />
                        <div className="commit-row">
                          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{tr("common.cancel")}</Button>
                          <Button size="sm" variant="primary" disabled={!draftText.trim()} onClick={() => {
                            persistComments([...comments, {
                              id: `rc_${Date.now().toString(36)}`,
                              path: selected.path,
                              digest: draft.digest,
                              line: draft.line,
                              text: draftText.trim(),
                              createdAt: Date.now(),
                            }]);
                            setDraft(null);
                          }}>{tr("gitview.addNote")}</Button>
                        </div>
                      </div>
                    )}
                    {fileComments.length > 0 && (
                      <div className="review-list">
                        <div className="stat-label">{tr("gitview.reviewNotesValue", { count: fileComments.length })}</div>
                        {fileComments.map((comment) => {
                          const anchorState = commentState(comment, hunks);
                          return (
                            <div key={comment.id} className={`review-note${anchorState === "outdated" ? " outdated" : ""}`}>
                              <div className="review-note-head">
                                <span className="mono">L{comment.line}</span>
                                {anchorState === "outdated" && <span className="tag">{tr("gitview.outdated")}</span>}
                                <span className="header-spacer" />
                                <IconButton icon={CloseIcon} size="sm" variant="ghost" label={tr("gitview.removeReviewNote")} onClick={() => persistComments(comments.filter((item) => item.id !== comment.id))} />
                              </div>
                              <div className="review-note-text">{comment.text}</div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </section>}
            </div>
          )}

          {reviewView === "working" && status && status.staged.length > 0 && (
            <section className="git-commit-composer ui-field-frame" aria-label={tr("gitview.commitStagedChanges")}>
              <Textarea
                className="git-commit-msg"
                minRows={1}
                maxRows={4}
                autoGrow
                aria-label={tr("gitview.commitMessage")}
                placeholder={tr("gitview.commitMessage")}
                value={commitMsg}
                onChange={(event) => setCommitMsg(event.target.value)}
                onKeyDown={(event) => {
                  if (isImeComposing(event)) return;
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && commitMsg.trim() && !busy) {
                    event.preventDefault();
                    void run(commitStaged);
                  }
                }}
              />
              <div className="git-commit-rail">
                <div className="git-commit-heading">
                  <strong>{status.staged.length === 1 ? tr("gitview.commitOneStagedFile") : tr("gitview.commitStagedFilesValue", { count: status.staged.length })}</strong>
                  <span className="git-commit-branch" title={status.branch || "HEAD"}>
                    <UiIcon icon={BranchIcon} size="sm" />
                    <span className="mono">{status.branch || "HEAD"}</span>
                  </span>
                  {subjectLength > 0 && (
                    <span className="git-commit-counter" data-over={subjectLength > SUBJECT_SOFT_LIMIT ? "true" : undefined} title={tr("gitview.subjectLengthValue", { count: subjectLength, limit: SUBJECT_SOFT_LIMIT })}>
                      {subjectLength}/{SUBJECT_SOFT_LIMIT}
                    </span>
                  )}
                </div>
                <div className="git-commit-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    iconStart={AssistIcon}
                    title={tr("gitview.generateWithAi")}
                    busy={generating}
                    disabled={generating || busy}
                    onClick={() => {
                      const generation = scopeGeneration.current;
                      const requestedScope = commitScopeKey;
                      setGenerating(true);
                      void api.gitCommitMessage(projectId, sessionId ?? undefined, repositoryId)
                        .then((result) => {
                          if (generation === scopeGeneration.current && requestedScope === commitScopeRef.current && result.message) setCommitMsg(result.message);
                        })
                        .catch((error) => {
                          if (generation === scopeGeneration.current && requestedScope === commitScopeRef.current) setUiError(friendlyError(tr("gitview.generate"), error));
                        })
                        .finally(() => {
                          if (generation === scopeGeneration.current && requestedScope === commitScopeRef.current) setGenerating(false);
                        });
                    }}
                  >{tr("gitview.generate")}</Button>
                  <Button
                    size="sm"
                    iconStart={SyncIcon}
                    busy={busyRemote === "sync"}
                    disabled={busy || busyRemote !== null || !remoteTargetAvailable}
                    title={tr("gitview.commitAndSyncHint")}
                    onClick={() => void runRemote("sync")}
                  >{tr("gitview.syncRepository")}</Button>
                  <Button
                    size="sm"
                    variant="primary"
                    className="git-commit-submit"
                    iconStart={CheckIcon}
                    busy={busy && !!commitMsg.trim()}
                    disabled={!commitMsg.trim() || busy}
                    title={tr("gitview.commitShortcutHint")}
                    onClick={() => void run(commitStaged)}
                  >{tr("gitview.commit")}</Button>
                </div>
              </div>
            </section>
          )}

          {landingIsolation && projectId && sessionId && (
            <LandingBar
              key={sessionId}
              host={host}
              projectId={projectId}
              sessionId={sessionId}
              repositoryId={repositoryId}
              uncommitted={all.length}
              onReviewConflicts={conflictIsolation && reviewView !== "conflicts" ? () => updateReviewScope("conflicts") : undefined}
            />
          )}
        </div>
      )}

      {tab === "log" && (
        <div className={`git-master-detail git-log-layout ${mobileDetail ? "detail-open" : ""}`}>
          <section className="git-master-pane" aria-label={tr("gitview.tabLog")}>
            <div className="git-log-toolbar">
              <div className="source-search ui-field-well">
                <UiIcon icon={SearchIcon} size="sm" />
                <TextInput uiSize="sm" value={graphQuery} placeholder={tr("gitview.searchCommitsAuthorsOrRefs")} aria-label={tr("gitview.searchCommitLog")} onChange={(event) => setGraphQuery(event.target.value)} />
                {graphQuery && <IconButton icon={CloseIcon} size="sm" variant="ghost" className="source-search-clear" label={tr("gitview.clearSearch")} onClick={() => setGraphQuery("")} />}
              </div>
              {branchChips.length > 0 && <Select
                label={tr("gitview.filterByBranch")}
                ariaLabel={tr("gitview.filterByBranch")}
                value={graphRef}
                options={branchFilterOptions}
                onChange={setGraphRef}
                className="git-log-branch-filter"
              />}
              <ViewOptionsMenu prefs={prefs} log />
            </div>
            <div className="git-graph" data-graph={prefs.logGraph ? "on" : "off"}>
              {!loadError && visibleGraph.length === 0 && <EmptyState mark={<UiIcon icon={graphQuery || graphRef ? SearchIcon : CommitIcon} size="lg" />} title={graphQuery || graphRef ? tr("gitview.noCommitsMatchThisFilter") : tr("gitview.noCommitsYet")} />}
              {visibleGraph.map(({ commit, row }) => (
                <button type="button" key={commit.sha} className={`git-graph-row ${commitSel === commit.sha ? "selected" : ""}`} aria-current={commitSel === commit.sha ? "true" : undefined} onClick={() => {
                  setCommitSel(commit.sha);
                  setSelected(null);
                  setMobileDetail(true);
                }}>
                  {prefs.logGraph && row && !graphQuery && !graphRef && <GraphSvg row={row} />}
                  <AuthorAvatar name={commit.author} size="sm" />
                  <span className="git-graph-copy">
                    <span className="git-graph-subject-line">
                      <span className="git-graph-subject">{commit.subject}</span>
                      {commit.refs.length > 0 && <span className="git-graph-refs"><RefBadges refs={commit.refs} remotes={remoteNames} limit={2} /></span>}
                    </span>
                    <span className="git-graph-meta"><span className="git-graph-author">{commit.author}</span><span aria-hidden="true">·</span><When value={commit.date} style={prefs.dateStyle} /></span>
                  </span>
                  <span className="git-graph-sha mono">{commit.shortSha}</span>
                </button>
              ))}
            </div>
            {!graphDone && graph.length > 0 && <Button size="sm" variant="ghost" className="git-load-more" busy={graphLoading} disabled={graphLoading} onClick={() => void loadMoreGraph()}>{graphLoading ? tr("gitview.loadingOlderCommits") : tr("gitview.loadOlderCommits")}</Button>}
          </section>
          <section className="git-detail-pane" aria-label={tr("gitview.commitDetails")}>
            {!commitSel ? <EmptyState title={tr("gitview.selectACommit")} description={tr("gitview.chooseACommitToInspect")} /> : (
              <>
                <div className="git-commit-detail-head">
                  <div className="git-mobile-detail-head">
                    <IconButton icon={BackIcon} size="sm" variant="ghost" label={tr("gitview.backToLog")} onClick={() => setMobileDetail(false)} />
                  </div>
                  <div className="git-commit-detail-copy">
                    <strong className="git-commit-detail-subject">{selectedCommit?.subject ?? commitSel.slice(0, 7)}</strong>
                    {commitBody && <p className="git-commit-detail-body">{commitBody}</p>}
                    {selectedCommit && (
                      <div className="git-commit-detail-meta">
                        <AuthorAvatar name={selectedCommit.author} size="sm" />
                        <span className="git-commit-detail-author">{selectedCommit.author}</span>
                        <span aria-hidden="true">·</span>
                        <When value={selectedCommit.date} style={prefs.dateStyle} />
                        <span className="git-sha" title={selectedCommit.sha}>{selectedCommit.shortSha}</span>
                        <CopyTextButton text={selectedCommit.sha} label={tr("gitview.copySha")} />
                      </div>
                    )}
                    {selectedCommit && selectedCommit.refs.length > 0 && <div className="git-commit-detail-refs"><RefBadges refs={selectedCommit.refs} remotes={remoteNames} /></div>}
                  </div>
                </div>
                <DiffPrefsToolbar scope={gitViewScope} />
                {commitDiffLoading ? <DiffSkeleton /> : commitDiffError ? (
                  <div className="source-inline-status error" role="alert">
                    <span>{commitDiffError}</span>
                    <Button size="sm" onClick={() => setCommitDiffRetry((value) => value + 1)}>{tr("common.retry")}</Button>
                  </div>
                ) : commitDiff ? <CommitFiles key={commitSel} diff={commitDiff} split={prefs.layout === "split"} wrap={prefs.wrap} /> : <DiffContent diff={commitDiff} split={prefs.layout === "split"} wrap={prefs.wrap} />}
              </>
            )}
          </section>
        </div>
      )}

      {tab === "branches" && (
        <div className="git-resource-page">
          <div className="git-resource-head">
            <div className="git-resource-head-copy">
              <h2>{tr("gitview.branchesAmpWorktrees")}</h2>
              <p>{tr("gitview.switchContextOrStartAnIsolated")}</p>
            </div>
            <div className="git-resource-head-actions">
              <Button size="sm" iconStart={BranchIcon} aria-pressed={showBranchForm} onClick={() => {
                setShowBranchForm((open) => !open);
                setShowTreeForm(false);
                setShowPrForm(false);
              }}>{tr("gitview.newBranch")}</Button>
              {isPrimaryRepository && <Button size="sm" iconStart={WorktreeIcon} aria-pressed={showTreeForm} onClick={() => {
                setShowTreeForm((open) => !open);
                setShowBranchForm(false);
                setShowPrForm(false);
              }}>{tr("gitview.newWorktree")}</Button>}
              {isPrimaryRepository && <Button size="sm" variant="primary" iconStart={PullRequestIcon} aria-pressed={showPrForm} onClick={() => {
                setShowPrForm((open) => !open);
                setShowBranchForm(false);
                setShowTreeForm(false);
              }}>{tr("gitview.createPr")}</Button>}
            </div>
          </div>

          {showPrForm && isPrimaryRepository && Slot && <Slot slot="git.change-request.create" context={{ projectId, sessionId, selectedProvider: selectedChangeProvider, onSelectProvider: setSelectedChangeProvider, onClose: () => { setShowPrForm(false); setSelectedChangeProvider(null); } }} />}

          {showBranchForm && (
            <form className="source-inline-form" onSubmit={(event) => {
              event.preventDefault();
              if (busy || !newBranch.trim()) return;
              void run(async () => {
                await api.gitBranch(projectId, newBranch.trim(), undefined, sessionId ?? undefined, repositoryId);
                setNewBranch("");
                setShowBranchForm(false);
              });
            }}>
              <UiIcon icon={BranchIcon} size="sm" />
              <TextInput id="git-new-branch" uiSize="sm" className="mono" autoFocus aria-label={tr("gitview.createABranch")} value={newBranch} placeholder={tr("gitview.branchNamePlaceholder")} onChange={(event) => setNewBranch(event.target.value)} />
              <Button size="sm" variant="primary" type="submit" disabled={busy || !newBranch.trim()}>{tr("gitview.createBranch")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setShowBranchForm(false)}>{tr("common.cancel")}</Button>
            </form>
          )}
          {showTreeForm && isPrimaryRepository && (
            <form className="source-inline-form" onSubmit={(event) => {
              event.preventDefault();
              if (busy || !newTree.trim()) return;
              void run(async () => {
                await api.createWorktree(projectId, newTree.trim());
                setNewTree("");
                setShowTreeForm(false);
              });
            }}>
              <UiIcon icon={WorktreeIcon} size="sm" />
              <TextInput id="git-new-worktree" uiSize="sm" className="mono" autoFocus aria-label={tr("gitview.createAWorktree")} value={newTree} placeholder={tr("gitview.branchForTheWorktree")} onChange={(event) => setNewTree(event.target.value)} />
              <Button size="sm" variant="primary" type="submit" disabled={busy || !newTree.trim() || !isPrimaryRepository}>{tr("gitview.createWorktree")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setShowTreeForm(false)}>{tr("common.cancel")}</Button>
            </form>
          )}

          <div className="git-resource-grid">
            <section className="git-resource-card" aria-label={tr("gitview.tabBranches")}>
              <div className="git-current-branch" aria-current="true">
                <span className="git-current-branch-glyph" aria-hidden="true"><UiIcon icon={BranchIcon} size="md" /></span>
                <span className="git-current-branch-copy">
                  <span className="stat-label">{tr("gitview.currentBranch")}</span>
                  <strong className="mono" title={status?.branch || undefined}>{status?.branch || tr("gitview.detachedHead")}</strong>
                  <span className="muted">
                    {status?.upstream ? tr("gitview.trackingValue", { upstream: status.upstream }) : tr("gitview.noUpstream")}
                    {status && (status.ahead > 0 || status.behind > 0) && <span className="git-ahead-behind">
                      {status.ahead > 0 && <span className="ahead" title={tr("gitview.commitsToPushValue", { count: status.ahead })}>↑ {status.ahead}</span>}
                      {status.behind > 0 && <span className="behind" title={tr("gitview.commitsToPullValue", { count: status.behind })}>↓ {status.behind}</span>}
                    </span>}
                  </span>
                </span>
                <span className="tag">{tr("gitview.current")}</span>
              </div>
              <div className="source-search git-branch-search ui-field-well">
                <UiIcon icon={SearchIcon} size="sm" />
                <TextInput uiSize="sm" value={branchQuery} placeholder={tr("gitview.searchLocalAndRemoteBranches")} aria-label={tr("gitview.searchBranches")} onChange={(event) => setBranchQuery(event.target.value)} />
                {branchQuery && <IconButton icon={CloseIcon} size="sm" variant="ghost" className="source-search-clear" label={tr("gitview.clearBranchSearch")} onClick={() => setBranchQuery("")} />}
              </div>
              {(["local", "remote"] as const).map((group) => {
                const remote = group === "remote";
                const label = remote ? tr("gitview.remote") : tr("gitview.local");
                const normalized = branchQuery.trim().toLowerCase();
                const rows = branches.branches.filter((branch) =>
                  !branch.current
                  && !branch.name.startsWith("polyth/isolate/")
                  && Boolean(branch.remote) === remote
                  && (!remote || (branch.name !== branch.remote && !branch.name.endsWith("/HEAD")))
                  && (!normalized || branch.name.toLowerCase().includes(normalized)));
                const closed = closedBranchGroups.has(group) && !normalized;
                const shown = rows.slice(0, branchLimits[group]);
                const emptyText = remote
                  ? (normalized ? tr("gitview.noMatchingRemoteBranches") : tr("gitview.noRemoteBranches"))
                  : (normalized ? tr("gitview.noMatchingLocalBranches") : tr("gitview.noLocalBranches"));
                return (
                  <div key={group} className="git-branch-section">
                    <button type="button" className="git-branch-section-head" aria-expanded={!closed} onClick={() => setClosedBranchGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group)) next.delete(group); else next.add(group);
                      return next;
                    })}>
                      <span className={`git-folder-chevron${closed ? "" : " expanded"}`} aria-hidden="true"><UiIcon icon={ChevronRightIcon} size="sm" /></span>
                      <span>{label}</span>
                      <span className="git-count"><CountBadge count={rows.length} /></span>
                    </button>
                    {!closed && (
                      <div className="git-branch-list">
                        {!loadError && rows.length === 0 && <div className="git-group-empty">{emptyText}</div>}
                        {shown.map((branch) => {
                          const slash = remote && branch.remote ? branch.remote.length + 1 : 0;
                          return (
                            <button type="button" key={branch.name} className="git-branch-row" disabled={busy} title={branch.name} onClick={() => void run(() => api.gitCheckout(projectId, branch.name, sessionId ?? undefined, repositoryId))}>
                              <UiIcon icon={BranchIcon} size="sm" />
                              <span className="mono git-branch-row-name">
                                {slash > 0 && <span className="git-branch-row-remote">{branch.name.slice(0, slash)}</span>}
                                {branch.name.slice(slash)}
                              </span>
                              <span className="git-branch-row-action">{tr("gitview.checkout")}</span>
                            </button>
                          );
                        })}
                        {shown.length < rows.length && (
                          <Button size="sm" variant="ghost" className="git-branch-load-more" onClick={() => setBranchLimits((current) => ({ ...current, [group]: current[group] + 30 }))}>
                            {tr("gitview.showMoreValue", { count: 30 })} <span className="muted">{tr("gitview.remainingValue", { count: rows.length - shown.length })}</span>
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
            {isPrimaryRepository && <section className="git-resource-card" aria-label={tr("gitview.worktreesValue", { count: visibleTrees.length })}>
              <div className="git-resource-card-head">
                <span className="stat-label">{tr("gitview.worktreesValue", { count: visibleTrees.length })}</span>
              </div>
              {!loadError && visibleTrees.length === 0 && <EmptyState mark={<UiIcon icon={WorktreeIcon} size="lg" />} title={tr("gitview.noLinkedWorktrees")} description={tr("gitview.newSessionsCurrentlyRunInThe")} />}
              <div className="git-worktree-list">
                {visibleTrees.map((tree) => {
                  const rowBusy = treeBusy?.startsWith(`${tree.path}:`) === true;
                  const stepBusy = (step: string) => treeBusy === `${tree.path}:${step}`;
                  const blocked = busy || treeBusy !== null;
                  const treeRemoteBlocked = blocked || !remoteTargetAvailable;
                  // `undefined` means this server did not report status, which
                  // is different from a checkout that is genuinely in sync.
                  const known = tree.ahead !== undefined;
                  const ahead = tree.ahead ?? 0;
                  const behind = tree.behind ?? 0;
                  const changed = tree.changed ?? 0;
                  // The branch this project has checked out is what a merge
                  // lands into, so a worktree cannot be merged into itself.
                  const into = branches.current;
                  const canMerge = !tree.isMain && tree.branch !== null
                    && into !== null && tree.branch !== into;
                  const entries: MenuEntry[] = [];
                  if (canMerge) {
                    entries.push({
                      id: "merge",
                      label: tr("gitview.mergeIntoValue", { branch: into }),
                      icon: CombineIcon,
                      disabled: blocked,
                      onSelect: () => setConfirmRequest({
                        title: tr("gitview.mergeIntoValue", { branch: into }),
                        description: tr("gitview.mergeWorktreeDescription", { branch: tree.branch ?? "", target: into }),
                        confirmLabel: tr("gitview.merge"),
                        action: () => mergeTree(tree),
                      }),
                    });
                  }
                  entries.push(
                    { id: "fetch", label: tr("gitview.fetch"), icon: FetchIcon, disabled: treeRemoteBlocked, onSelect: () => { void runTreeRemote(tree, "fetch"); } },
                    { id: "pull", label: tr("gitview.pull"), icon: PullIcon, disabled: treeRemoteBlocked, onSelect: () => { void runTreeRemote(tree, "pull"); } },
                    { id: "push", label: tr("gitview.push"), icon: PushIcon, disabled: treeRemoteBlocked, onSelect: () => { void runTreeRemote(tree, "push"); } },
                    { id: "sync", label: tr("gitview.syncRepository"), icon: SyncIcon, disabled: treeRemoteBlocked, onSelect: () => { void runTreeRemote(tree, "sync"); } },
                  );
                  if (!tree.isMain) {
                    entries.push({
                      id: "remove",
                      label: tr("gitview.removeWorktree"),
                      icon: DeleteIcon,
                      danger: true,
                      disabled: blocked,
                      onSelect: () => requestRemoveTree(tree),
                    });
                  }
                  return (
                    <article key={tree.path} className="git-wt-card" data-main={tree.isMain ? "true" : undefined}>
                      <span className="git-wt-glyph" aria-hidden="true"><UiIcon icon={WorktreeIcon} size="sm" /></span>
                      <div className="git-wt-copy">
                        <div className="git-wt-title">
                          <strong className="mono" title={tree.branch ?? undefined}>{tree.branch ?? tr("gitview.detachedHead")}</strong>
                          <span className={`tag ${tree.isMain ? "green" : ""}`}>{tree.isMain ? tr("gitview.main") : tr("gitview.linked")}</span>
                        </div>
                        <span className="muted mono git-wt-path" title={tree.path}>{tree.path}</span>
                        <div className="git-wt-state">
                          <span className="muted mono">{tree.head.slice(0, 7)}</span>
                          {known && ahead > 0 && (
                            <span className="git-wt-stat" title={tr("gitview.commitsToPushValue", { count: ahead })}>
                              <UiIcon icon={PushIcon} size="sm" />{ahead}
                            </span>
                          )}
                          {known && behind > 0 && (
                            <span className="git-wt-stat" title={tr("gitview.commitsToPullValue", { count: behind })}>
                              <UiIcon icon={PullIcon} size="sm" />{behind}
                            </span>
                          )}
                          {known && changed > 0 && (
                            <span className="git-wt-stat git-wt-stat--dirty" title={tr("gitview.uncommittedChangesValue", { count: changed })}>
                              {tr("gitview.changedValue", { count: changed })}
                            </span>
                          )}
                          {known && ahead === 0 && behind === 0 && changed === 0 && (
                            <span className="git-wt-stat git-wt-stat--clean"><UiIcon icon={CheckIcon} size="sm" />{tr("gitview.inSync")}</span>
                          )}
                        </div>
                      </div>
                      <div className="git-wt-actions">
                        {/* One adaptive verb: whatever this checkout actually
                            needs next. Everything else stays in the overflow. */}
                        {known && ahead > 0 && (
                          <Button size="sm" variant="primary" iconStart={PushIcon} busy={stepBusy("push")} disabled={blocked} onClick={() => void runTreeRemote(tree, "push")}>
                            {tr("gitview.push")}
                          </Button>
                        )}
                        {known && ahead === 0 && behind > 0 && (
                          <Button size="sm" iconStart={PullIcon} busy={stepBusy("pull")} disabled={blocked} onClick={() => void runTreeRemote(tree, "pull")}>
                            {tr("gitview.pull")}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" iconStart={SessionIcon} disabled={rowBusy} title={tr("gitview.newSessionInValue", { branch: tree.branch ?? tr("gitview.thisWorktree") })} onClick={() => openWorktreeSessionDialog(projectId, tree.path)}>{tr("gitview.session")}</Button>
                        <Menu label={tr("common.more")} align="end" entries={entries}>
                          {(trigger) => (
                            <IconButton
                              {...trigger}
                              icon={MoreIcon}
                              size="sm"
                              variant="ghost"
                              busy={rowBusy && !stepBusy("push") && !stepBusy("pull")}
                              disabled={busy}
                              label={tr("gitview.worktreeActionsValue", { branch: tree.branch ?? tree.path })}
                            />
                          )}
                        </Menu>
                      </div>
                    </article>
                  );
                })}
              </div>
              {projectIsolationLevel(project?.defaults) !== "off" && (
                <Button size="sm" className="git-new-session-btn" iconStart={SessionIcon} onClick={() => openWorktreeSessionDialog(projectId)}>{tr("isolation.workInIsolation")}</Button>
              )}
            </section>}
          </div>
          <RepoStackPanel projectId={projectId} repositoryId={repositoryId} />
        </div>
      )}

      {tab === "stashes" && (
        <div className="git-resource-page">
          <div className="git-resource-head">
            <div className="git-resource-head-copy">
              <h2>{tr("gitview.tabStashes")}</h2>
              <p>{tr("gitview.temporarilySetAsideLocalChanges")}</p>
            </div>
          </div>
          <form className="git-stash-composer" onSubmit={(event) => {
            event.preventDefault();
            if (busy || all.length === 0) return;
            void run(async () => {
              await api.gitStashPush(projectId, stashMessage.trim() || undefined, sessionId ?? undefined, repositoryId);
              setStashMessage("");
              setSelected(null);
            });
          }}>
            <TextInput id="stash-message" uiSize="sm" aria-label={tr("gitview.stashCurrentChanges")} value={stashMessage} placeholder={tr("gitview.optionalMessage")} disabled={all.length === 0} onChange={(event) => setStashMessage(event.target.value)} />
            <Button size="sm" variant="primary" type="submit" iconStart={StashIcon} disabled={busy || all.length === 0}>{all.length === 1 ? tr("gitview.stashOneFile") : all.length > 1 ? tr("gitview.stashFilesValue", { count: all.length }) : tr("gitview.stashChanges")}</Button>
          </form>
          {!loadError && stashes.length === 0 ? <EmptyState variant="compact" mark={<UiIcon icon={StashIcon} size="lg" />} title={tr("gitview.noStashes")} description={tr("gitview.savedWorkInProgressChanges")} /> : stashes.length > 0 ? (
            <div className="git-stash-list">
              {stashes.map((stash) => {
                const onBranch = /^(?:On|WIP on) ([^:]+):/.exec(stash.message)?.[1];
                return (
                  <article className="git-stash-card" key={stash.ref}>
                    <span className="git-stash-icon" aria-hidden="true"><UiIcon icon={StashIcon} size="sm" /></span>
                    <div className="git-stash-copy">
                      <strong title={stash.message}>{stash.message.replace(/^(?:On|WIP on) [^:]+:\s*/, "") || tr("gitview.stashedChanges")}</strong>
                      <span className="muted">
                        <span className="mono">{stash.ref}</span>
                        {onBranch && <><span aria-hidden="true"> · </span><span className="git-stash-branch"><UiIcon icon={BranchIcon} size="sm" /><span className="mono">{onBranch}</span></span></>}
                        <span aria-hidden="true"> · </span><When value={stash.date} style={prefs.dateStyle} />
                      </span>
                    </div>
                    <div className="git-stash-actions">
                      <Button size="sm" iconStart={StashApplyIcon} disabled={busy} onClick={() => void run(() => api.gitStashApply(projectId, stash.ref, sessionId ?? undefined, repositoryId))}>{tr("common.apply")}</Button>
                      <IconButton icon={DeleteIcon} size="sm" variant="danger" label={`${tr("gitview.drop")} ${stash.ref}`} title={tr("gitview.drop")} disabled={busy} onClick={() => setConfirmRequest({
                        title: tr("gitview.dropStashQuestion"),
                        description: tr("gitview.stashWillBePermanentlyDeleted", { ref: stash.ref }),
                        confirmLabel: tr("gitview.dropStash"),
                        action: () => api.gitStashDrop(projectId, stash.ref, sessionId ?? undefined, repositoryId),
                      })} />
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function DiffPrefsToolbar({ scope }: { scope: string }) {
  const prefs = useGitPrefs(scope);
  return (
    <div className="diff-prefs">
      <div className="diff-layout-toggle source-segmented" role="group" aria-label={tr("gitview.diffLayout")}>
        <Button size="sm" variant="ghost" iconStart={UnifiedViewIcon} aria-pressed={prefs.layout === "unified"} onClick={() => setGitPrefs({ layout: "unified" }, scope)}>{tr("gitview.unified")}</Button>
        <Button size="sm" variant="ghost" iconStart={SplitViewIcon} aria-pressed={prefs.layout === "split"} onClick={() => setGitPrefs({ layout: "split" }, scope)}>{tr("gitview.split")}</Button>
      </div>
      <span className="header-spacer" />
      <Button size="sm" variant="ghost" className="diff-pref-toggle" iconStart={WrapIcon} aria-pressed={prefs.wrap} onClick={() => setGitPrefs({ wrap: !prefs.wrap }, scope)}>{tr("gitview.wrapLines")}</Button>
      <Button size="sm" variant="ghost" className="diff-pref-toggle" aria-pressed={prefs.ignoreWhitespace} onClick={() => setGitPrefs({ ignoreWhitespace: !prefs.ignoreWhitespace }, scope)}>{tr("gitview.ignoreWhitespace")}</Button>
    </div>
  );
}

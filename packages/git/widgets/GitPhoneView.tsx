// Source Control on a phone. The first screen answers one question: what changed,
// and what happens next. Files are always on it, one primary action sits under
// the thumb and changes with the state, and everything rarer lives one step
// away: the branch row opens remote, account and compare; History, Branches and
// Stashes are rows; a file is its own layer with its diff options in a menu.
//
// Presentation only. GitView still owns every request, mutation and panel; this
// file decides where they appear (phoneOverview.ts decides what state applies).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GitFileEntry, GitStatus } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  AddIcon,
  AssistIcon,
  BranchIcon,
  Button,
  Checkbox,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CombineIcon,
  CommitIcon,
  CompareIcon,
  CopyIcon,
  FetchIcon,
  HistoryIcon,
  Icon as UiIcon,
  IconButton,
  Menu,
  MoreIcon,
  PullIcon,
  PushIcon,
  RefreshIcon,
  Sheet,
  SheetRow,
  StashIcon,
  SyncIcon,
  Textarea,
  UndoIcon,
  WarningIcon,
  WorktreeIcon,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import { createBranchDiffClient } from "./branchDiffClient.ts";
import { fileStatKey } from "./ChangeList.tsx";
import { setGitPrefs, type GitPrefs } from "./gitPrefs.ts";
import { useLanding } from "./LandingBar.tsx";
import type { DiffLineStats } from "./PendingChangesBar.tsx";
import {
  commitStagePlan,
  includedChanges,
  isChangeIncluded,
  isPartlyStaged,
  phoneChangeEntry,
  phoneChanges,
  phoneOverviewState,
  type CommitPicks,
  type PhoneChange,
} from "./phoneOverview.ts";
import { LineStats, StatusChip, fileIdentity } from "./sourceControlParts.tsx";
import type { GitBranchDiffList } from "../src/index.ts";

const branchDiffClient = createBranchDiffClient();
const SUBJECT_SOFT_LIMIT = 72;

export type PhonePage =
  | { kind: "history" }
  | { kind: "branches" }
  | { kind: "stashes" }
  | { kind: "conflicts" }
  /** `fromOverview`: a file row on the first screen opened it, so Back returns there. */
  | { kind: "compare"; path: string | null; fromOverview: boolean };

export type PhoneConflictTarget = "new-session" | "current-session";

export interface PhoneRemote {
  /** Selected remote name. */
  name: string;
  choices: readonly { value: string; label: string; detail?: string }[];
  available: boolean;
  /** Why no remote can be used, when none can. */
  problem: string;
  busyStep: "fetch" | "pull" | "push" | "sync" | null;
  blocked: boolean;
  run: (step: "fetch" | "pull" | "push" | "sync") => void;
  choose: (name: string) => void;
  retry: () => void;
}

export interface PhoneRepositoryScope {
  options: readonly { id: string; alias: string; detail?: string; group?: string }[];
  selectedId: string | null | undefined;
  alias: string | null;
  choose: (id: string | null) => void;
}

export interface GitPhoneViewProps {
  host?: WebPackageHost;
  projectId: string;
  sessionId?: string | null;
  repositoryId?: string;
  status: GitStatus | null;
  fileStats: Record<string, DiffLineStats>;
  prefs: GitPrefs;
  prefsScope: string;
  /** What the next commit explicitly includes or leaves out. */
  picks: CommitPicks;
  setPicks: (picks: CommitPicks) => void;
  busy: boolean;
  /** Remote outcomes and load errors, shown under the summary. */
  feedback: ReactNode;
  /** Modal surfaces GitView owns (the destructive confirmations). */
  overlay: ReactNode;
  isolated: boolean;
  /** The branch an isolated chat lands on. */
  isolationTarget: string | null;
  isolationState: string | null;
  /** Show the landing: a single-repository isolation in view. */
  landingActive: boolean;
  /** Files of a recorded isolation conflict; null while there is none. */
  conflictFiles: readonly string[] | null;
  /** Moves when the checkout's history may have (see GitView). */
  headRevision: string;
  repository: PhoneRepositoryScope;
  /** Slot content naming the commit identity and provider accounts. */
  identity: ReactNode;
  remote: PhoneRemote;
  branchCount: number;
  stashCount: number;
  page: PhonePage | null;
  setPage: (page: PhonePage | null) => void;
  /** The working-tree file whose diff layer is open. */
  file: { path: string; staged: boolean } | null;
  openFile: (file: GitFileEntry) => void;
  closeFile: () => void;
  /** A commit's detail is open inside History. */
  commitTitle: string | null;
  closeCommit: () => void;
  renderFileDiff: () => ReactNode;
  renderLog: () => ReactNode;
  renderBranches: () => ReactNode;
  renderStashes: () => ReactNode;
  renderConflicts: () => ReactNode;
  renderCompare: (path: string | null, onPath: (path: string | null) => void) => ReactNode;
  branchActions: readonly MenuEntry[];
  logActions: readonly MenuEntry[];
  openConflict: (path?: string) => void;
  stageFile: (file: GitFileEntry, stage: boolean) => void;
  discardFile: (file: GitFileEntry) => void;
  stash: () => void;
  revertAll: () => void;
  abortMerge: () => void;
  resolveWithAgent: (target: PhoneConflictTarget) => void;
  resolveIsolation: () => void;
  conflictAgentTarget: PhoneConflictTarget;
  conflictAgentBusy: boolean;
  commitMessage: string;
  setCommitMessage: (message: string) => void;
  generating: boolean;
  /** Applies the plan first, so the message describes what will be committed. */
  generateMessage: (plan: { stage: string[]; unstage: string[] }) => void;
  /** Resolves true once the commit landed; the sheet stays open otherwise. */
  commit: (plan: { stage: string[]; unstage: string[] }, sync: boolean) => Promise<boolean>;
}

function PhoneLines({ additions, deletions }: { additions: number; deletions: number }) {
  return <LineStats stats={{ additions, deletions }} mode="numbers" />;
}

/** One changed file: the name is the row, its folder a quiet second line. */
export function PhoneFileRow({ path, origPath, status, staged, stats, lineStats, excluded, onClick }: {
  path: string;
  origPath?: string;
  status: string;
  staged?: boolean;
  stats?: DiffLineStats;
  lineStats: GitPrefs["lineStats"];
  excluded?: boolean;
  onClick: () => void;
}) {
  const identity = fileIdentity(path);
  const directory = origPath ? `${origPath} → ${identity.directory}` : identity.directory;
  return (
    <button type="button" className="git-phone-file" data-excluded={excluded ? "true" : undefined} title={path} onClick={onClick}>
      <StatusChip status={status} {...(staged ? { staged } : {})} />
      <span className="git-phone-file-copy">
        <span className="git-phone-file-name">{identity.name}</span>
        {directory && <span className="git-phone-file-directory">{directory}</span>}
      </span>
      {status === "conflicted"
        ? <span className="git-phone-file-note" data-tone="danger">{tr("gitview.conflicted")}</span>
        : excluded
          ? <span className="git-phone-file-note">{tr("gitphone.notIncluded")}</span>
          : stats && lineStats !== "hidden" && <LineStats stats={stats} mode={lineStats} />}
    </button>
  );
}

/** Previous, next and where this is in the list: the foot of every file layer. */
export function PhoneFileFoot({ index, total, onStep, children }: {
  index: number;
  total: number;
  onStep: (delta: number) => void;
  children?: ReactNode;
}) {
  return (
    <div className="git-phone-file-foot">
      <IconButton icon={ChevronLeftIcon} variant="ghost" label={tr("gitphone.previousFile")} disabled={index <= 0} onClick={() => onStep(-1)} />
      <IconButton icon={ChevronRightIcon} variant="ghost" label={tr("gitphone.nextFile")} disabled={index < 0 || index >= total - 1} onClick={() => onStep(1)} />
      {index >= 0 && <span className="git-phone-file-position">{tr("gitphone.position", { index: index + 1, total })}</span>}
      <span className="git-phone-file-action">{children}</span>
    </div>
  );
}

/** Pick what to compare with: the known branches, or anything Git can resolve. */
export function PhoneBasePicker({ branches, current, onChoose, onClose }: {
  branches: readonly { name: string }[];
  current: string;
  onChoose: (base: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const needle = typed.toLowerCase();
  const rows = branches.filter((branch) => !needle || branch.name.toLowerCase().includes(needle));
  return (
    <Sheet
      title={tr("gitphone.compareWith")}
      size="tall"
      onClose={onClose}
      search={{ value: query, onChange: setQuery, placeholder: tr("gitphone.branchOrCommit") }}
    >
      <div className="git-phone-picker" role="listbox" aria-label={tr("gitphone.compareWith")}>
        {typed && !rows.some((branch) => branch.name === typed) && (
          <SheetRow title={tr("gitphone.useBase", { value: typed })} icon={<UiIcon icon={CompareIcon} size="md" />} onClick={() => onChoose(typed)} />
        )}
        {rows.map((branch) => (
          <SheetRow key={branch.name} title={branch.name} selected={branch.name === current} icon={<UiIcon icon={BranchIcon} size="md" />} onClick={() => onChoose(branch.name)} />
        ))}
      </div>
    </Sheet>
  );
}

/** A full-screen step on top of the overview. It replaces the window's own head,
 *  so there is one Back and one title at a time; a swipe from the edge pops it. */
function PhoneLayer({ title, onBack, trailing, footer, density, children }: {
  title: string;
  onBack: () => void;
  trailing?: ReactNode;
  footer?: ReactNode;
  density: GitPrefs["density"];
  children: ReactNode;
}) {
  return (
    <Sheet
      title={title}
      dismiss="back"
      swipeBack
      size="tall"
      className="git-phone-layer"
      onClose={onBack}
      {...(trailing ? { headerTrailing: trailing } : {})}
      {...(footer ? { footer } : {})}
    >
      <div className="git-page git-phone-page" data-density={density}>{children}</div>
    </Sheet>
  );
}

function MoreMenu({ label, entries, title, open, onOpenChange }: {
  label: string;
  entries: readonly MenuEntry[];
  title?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Menu
      label={label}
      {...(title ? { title } : {})}
      phonePresentation="sheet"
      entries={entries}
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {(trigger) => <IconButton {...trigger} icon={MoreIcon} size="lg" variant="ghost" label={label} />}
    </Menu>
  );
}

export default function GitPhoneView(props: GitPhoneViewProps) {
  const {
    host, projectId, sessionId, repositoryId, status, fileStats, prefs, prefsScope, picks, setPicks, busy, feedback, overlay,
    isolated, isolationTarget, isolationState, landingActive, conflictFiles, headRevision,
    repository, identity, remote, branchCount, stashCount,
    page, setPage, file, openFile, closeFile, commitTitle, closeCommit,
    renderFileDiff, renderLog, renderBranches, renderStashes, renderConflicts, renderCompare,
    branchActions, logActions, openConflict, stageFile, discardFile, stash, revertAll, abortMerge,
    resolveWithAgent, resolveIsolation, conflictAgentTarget, conflictAgentBusy,
    commitMessage, setCommitMessage, generating, generateMessage, commit,
  } = props;
  const changes = useMemo(() => phoneChanges(status, (entry) => fileStats[fileStatKey(entry)]), [status, fileStats]);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitFilesOpen, setCommitFilesOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const landing = useLanding({
    ...(host ? { host } : {}),
    projectId,
    // An empty id finds no session, so the hook stays idle without one in view.
    sessionId: landingActive && sessionId ? sessionId : "",
    ...(repositoryId ? { repositoryId } : {}),
    uncommitted: changes.length,
  });

  // What an isolated chat has on its branch. Another question from what Git
  // reports against an upstream, and the one its next step depends on.
  const [branchDiff, setBranchDiff] = useState<GitBranchDiffList | null>(null);
  const [branchDiffPending, setBranchDiffPending] = useState(isolated);
  const branchDiffKey = isolated
    ? JSON.stringify([projectId, sessionId, repositoryId, status?.branch, headRevision, changes.length, isolationState, isolationTarget])
    : null;
  useEffect(() => {
    if (!branchDiffKey) {
      setBranchDiff(null);
      setBranchDiffPending(false);
      return;
    }
    let active = true;
    setBranchDiffPending(true);
    void branchDiffClient.list({ projectId, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) })
      .then((value) => { if (active) setBranchDiff(value); })
      .catch(() => { if (active) setBranchDiff(null); })
      .finally(() => { if (active) setBranchDiffPending(false); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by branchDiffKey
  }, [branchDiffKey]);

  const state = phoneOverviewState({
    changes,
    status,
    isolated,
    isolationConflict: conflictFiles ? conflictFiles.length : null,
    branchDiff,
    branchDiffPending,
  });
  const included = includedChanges(changes, picks);
  const plan = commitStagePlan(changes, picks);
  const commitLabel = included.length === 1 ? tr("gitphone.commitOneFile") : tr("gitphone.commitFiles", { count: included.length });
  const base = isolationTarget ?? branchDiff?.base ?? null;
  const branchName = status?.branch || tr("gitview.detachedHead");

  // ── The answer ───────────────────────────────────────────────────────────
  const summary = ((): { title: string; meta: ReactNode } => {
    switch (state.kind) {
      case "conflict":
        return {
          title: state.count === 0
            ? tr("gitview.conflicts")
            : state.count === 1 ? tr("gitphone.oneConflict") : tr("gitphone.conflictsCount", { count: state.count }),
          // The landing names the branch this conflicts with; a merge just stopped.
          meta: state.source === "isolation" && landing?.check.text ? landing.check.text : tr("gitphone.conflictMeta"),
        };
      case "changes":
        return {
          title: state.files === 1 ? tr("gitphone.oneFileChanged") : tr("gitphone.filesChanged", { count: state.files }),
          meta: <>{state.additions + state.deletions > 0 && <><PhoneLines additions={state.additions} deletions={state.deletions} /> · </>}{tr("gitphone.notCommitted")}</>,
        };
      case "ready":
        return {
          title: state.commits === 1 ? tr("gitphone.oneCommitReady") : tr("gitphone.commitsReady", { count: state.commits }),
          meta: <>{state.files === 1 ? tr("gitphone.oneFile") : tr("gitphone.filesCount", { count: state.files })} · <PhoneLines additions={state.additions} deletions={state.deletions} /></>,
        };
      case "remote":
        return {
          title: state.ahead > 0 && state.behind > 0
            ? tr("gitphone.pushAndPull", { ahead: state.ahead, behind: state.behind })
            : state.ahead > 0
              ? (state.ahead === 1 ? tr("gitphone.oneCommitToPush") : tr("gitphone.commitsToPush", { count: state.ahead }))
              : (state.behind === 1 ? tr("gitphone.oneCommitToPull") : tr("gitphone.commitsToPull", { count: state.behind })),
          meta: status?.upstream ?? remote.name,
        };
      case "checking":
        return { title: tr("gitphone.checking"), meta: "" };
      default:
        return { title: tr("gitphone.nothingToReview"), meta: tr("gitphone.nothingToReviewMeta") };
    }
  })();

  // ── One primary action ───────────────────────────────────────────────────
  const primary = ((): { label: string; icon: typeof CheckIcon; disabled?: boolean; busy?: boolean; run: () => void } | null => {
    if (state.kind === "conflict" && state.source === "merge") {
      return { label: tr("gitphone.resolveWithAgent"), icon: AssistIcon, busy: conflictAgentBusy, disabled: conflictAgentBusy, run: () => resolveWithAgent(conflictAgentTarget) };
    }
    if (state.kind === "conflict") {
      return landing?.canResolve
        ? { label: tr("gitphone.resolveWithAgent"), icon: AssistIcon, run: resolveIsolation }
        : { label: tr("landing.reviewConflicts"), icon: WarningIcon, run: () => openConflict() };
    }
    if (state.kind === "changes") {
      return included.length === 0
        ? { label: tr("gitphone.chooseFiles"), icon: CommitIcon, disabled: busy, run: () => { setCommitFilesOpen(true); setCommitOpen(true); } }
        : { label: commitLabel, icon: CommitIcon, disabled: busy, run: () => setCommitOpen(true) };
    }
    if (state.kind === "ready" && landing) {
      if (landing.stranded) return { label: tr("landing.chooseBranchAction"), icon: BranchIcon, disabled: !landing.canChoose, run: () => landing.setChoosing(true) };
      return { label: landing.integrateLabel, icon: CombineIcon, busy: landing.busy === "merge", disabled: !landing.canIntegrate, run: landing.integrate };
    }
    if (state.kind === "remote" && remote.available) {
      const step = state.ahead > 0 && state.behind > 0 ? "sync" : state.ahead > 0 ? "push" : "pull";
      const label = step === "sync"
        ? tr("gitview.syncRepository")
        : step === "push"
          ? (state.ahead === 1 ? tr("gitphone.pushOneCommit") : tr("gitphone.pushCommits", { count: state.ahead }))
          : (state.behind === 1 ? tr("gitphone.pullOneCommit") : tr("gitphone.pullCommits", { count: state.behind }));
      return { label, icon: step === "sync" ? SyncIcon : step === "push" ? PushIcon : PullIcon, busy: remote.busyStep !== null, disabled: remote.blocked, run: () => remote.run(step) };
    }
    return null;
  })();

  // ── What is rarer than that ──────────────────────────────────────────────
  const moreEntries = ((): MenuEntry[] => {
    if (state.kind === "conflict" && state.source === "merge") {
      return [
        { id: "resolve-here", label: tr("gitphone.resolveInThisChat"), icon: AssistIcon, disabled: !sessionId || conflictAgentBusy, onSelect: () => resolveWithAgent("current-session") },
        { id: "resolve-new", label: tr("gitphone.resolveInNewChat"), icon: AssistIcon, disabled: conflictAgentBusy, onSelect: () => resolveWithAgent("new-session") },
        "separator",
        { id: "abort", label: tr("gitphone.abortMerge"), detail: tr("gitphone.abortMergeDetail"), icon: UndoIcon, danger: true, disabled: busy, onSelect: abortMerge },
      ];
    }
    if (state.kind === "conflict") {
      return landing?.canResolve ? [{ id: "review", label: tr("landing.reviewConflicts"), icon: WarningIcon, onSelect: () => openConflict() }] : [];
    }
    if (state.kind === "changes") {
      return [
        ...(landing && !landing.conflict && !landing.stranded ? [{
          id: "integrate",
          label: landing.integrateLabel,
          detail: tr("gitphone.commitsFirst"),
          icon: CombineIcon,
          disabled: !landing.canIntegrate,
          onSelect: landing.integrate,
        }] : []),
        { id: "stash", label: tr("gitview.stashChanges"), icon: StashIcon, disabled: busy, onSelect: stash },
        "separator",
        { id: "revert", label: tr("gitphone.revertAllChanges"), detail: tr("gitphone.asksFirst"), icon: UndoIcon, danger: true, disabled: busy, onSelect: revertAll },
      ];
    }
    if (state.kind === "ready" && landing) return landing.entries;
    return [];
  })();

  const remoteEntries: MenuEntry[] = remote.available
    ? (["sync", "fetch", "pull", "push"] as const).map((step): MenuEntry => ({
      id: step,
      label: step === "sync" ? tr("gitview.syncRepository") : tr(step === "fetch" ? "gitview.fetch" : step === "pull" ? "gitview.pull" : "gitview.push"),
      icon: step === "sync" ? SyncIcon : step === "fetch" ? FetchIcon : step === "pull" ? PullIcon : PushIcon,
      ...(step === "sync" ? { detail: tr("gitphone.syncDetail") } : {}),
      disabled: remote.blocked,
      onSelect: () => remote.run(step),
    }))
    : [{ id: "retry", label: tr("common.retry"), detail: remote.problem, icon: RefreshIcon, onSelect: remote.retry }];
  const branchEntries: MenuEntry[] = [
    ...remoteEntries,
    "separator",
    { id: "compare", label: tr("gitphone.compareWith"), ...(base ? { detail: base } : {}), icon: CompareIcon, onSelect: () => setPage({ kind: "compare", path: null, fromOverview: false }) },
    ...(remote.choices.length > 1 ? [{
      id: "remote",
      label: tr("gitview.remote"),
      value: remote.name,
      icon: WorktreeIcon,
      entries: remote.choices.map((choice): MenuEntry => ({
        id: `remote:${choice.value}`,
        label: choice.label,
        ...(choice.detail ? { detail: choice.detail } : {}),
        kind: "radio",
        checked: choice.value === remote.name,
        disabled: remote.blocked,
        onSelect: () => remote.choose(choice.value),
      })),
      onSelect: () => undefined,
    }] : []),
    ...(repository.options.length > 1 ? [{
      id: "repository",
      label: tr("gitview.repository"),
      ...(repository.alias ? { value: repository.alias } : {}),
      icon: WorktreeIcon,
      entries: [
        { id: "repository:all", label: tr("gitview.allRepositories"), kind: "radio" as const, checked: repository.selectedId === null, onSelect: () => repository.choose(null) },
        ...repository.options.map((option): MenuEntry => ({
          id: `repository:${option.id}`,
          label: option.alias,
          ...(option.detail || option.group ? { detail: [option.group, option.detail].filter(Boolean).join(" · ") } : {}),
          kind: "radio",
          checked: option.id === repository.selectedId,
          onSelect: () => repository.choose(option.id),
        })),
      ],
      onSelect: () => undefined,
    }] : []),
    { id: "refresh", label: tr("gitphone.refresh"), icon: RefreshIcon, disabled: busy || remote.busyStep !== null, onSelect: remote.retry },
  ];
  const trackingNote = !status?.upstream
    // An isolated branch normally has no upstream: its base is what matters.
    ? (remote.available ? (isolated ? "" : tr("gitview.noUpstream")) : remote.problem)
    : status.ahead === 0 && status.behind === 0
      ? tr("gitphone.upToDate", { upstream: status.upstream })
      : tr("gitview.trackingValue", { upstream: status.upstream });

  const row = (icon: typeof CheckIcon, label: string, onClick: () => void, value?: string | number) => (
    <button type="button" className="git-phone-row" key={label} onClick={onClick}>
      <UiIcon icon={icon} size="md" />
      <span className="git-phone-row-label">{label}</span>
      {value !== undefined && <span className="git-phone-row-value">{value}</span>}
      <UiIcon icon={ChevronRightIcon} size="sm" className="git-phone-row-chevron" />
    </button>
  );

  // ── Layers ───────────────────────────────────────────────────────────────
  const fileChange = file ? changes.find((change) => change.path === file.path) ?? null : null;
  const fileEntry = file && fileChange ? (file.staged ? fileChange.staged : fileChange.working) ?? phoneChangeEntry(fileChange) : null;
  const fileIndex = fileChange ? changes.indexOf(fileChange) : -1;
  // The file left the list (an agent committed it, say): its layer has nothing to
  // stand on. A file that was never listed, opened by a link, stays.
  const fileListed = useRef(false);
  useEffect(() => {
    if (!file) { fileListed.current = false; return; }
    if (fileChange) { fileListed.current = true; return; }
    if (fileListed.current) closeFile();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- presence of the file only
  }, [file?.path, Boolean(fileChange)]);
  const setIncluded = (change: PhoneChange, next: boolean) => setPicks(new Map(picks).set(change.path, next));
  const fileEntries: MenuEntry[] = !file ? [] : [
    { id: "wrap", kind: "switch", checked: prefs.phoneWrap, label: tr("gitview.wrapLines"), onSelect: () => setGitPrefs({ phoneWrap: !prefs.phoneWrap }, prefsScope) },
    { id: "whitespace", kind: "switch", checked: prefs.ignoreWhitespace, label: tr("gitview.ignoreWhitespace"), onSelect: () => setGitPrefs({ ignoreWhitespace: !prefs.ignoreWhitespace }, prefsScope) },
    "separator",
    ...(fileChange && isPartlyStaged(fileChange) ? [
      { id: "show-working", kind: "radio" as const, checked: !file.staged, label: tr("gitphone.showNotStaged"), onSelect: () => openFile(fileChange.working!) },
      { id: "show-staged", kind: "radio" as const, checked: file.staged, label: tr("gitphone.showStaged"), onSelect: () => openFile(fileChange.staged!) },
      "separator" as const,
    ] : []),
    { id: "copy", label: tr("gitphone.copyPath"), icon: CopyIcon, onSelect: () => { void navigator.clipboard?.writeText(file.path).catch(() => undefined); } },
    ...(fileEntry && !fileChange?.conflicted ? [{ id: "revert", label: tr("gitphone.revertFile"), detail: tr("gitphone.asksFirst"), icon: UndoIcon, danger: true, disabled: busy, onSelect: () => discardFile(fileEntry) }] : []),
  ];

  const fileLayer = file && !page && (
    <PhoneLayer
      title={fileIdentity(file.path).name}
      density={prefs.density}
      onBack={closeFile}
      trailing={<MoreMenu label={tr("gitphone.fileOptions")} title={fileIdentity(file.path).name} entries={fileEntries} />}
      footer={<PhoneFileFoot
        index={fileIndex}
        total={changes.length}
        onStep={(delta) => { const next = changes[fileIndex + delta]; if (next) openFile(phoneChangeEntry(next)); }}
      >
        {fileChange?.conflicted && fileEntry
          ? <Button iconStart={CheckIcon} disabled={busy} onClick={() => stageFile(fileEntry, true)}>{tr("gitview.markResolved")}</Button>
          : fileChange && (() => {
            const on = isChangeIncluded(fileChange, changes, picks);
            return <Button iconStart={on ? CheckIcon : AddIcon} aria-pressed={on} onClick={() => setIncluded(fileChange, !on)}>{on ? tr("gitphone.included") : tr("gitphone.include")}</Button>;
          })()}
      </PhoneFileFoot>}
    >
      <p className="git-phone-file-meta" title={file.path}>
        {fileIdentity(file.path).directory && <span className="git-phone-file-meta-path">{fileIdentity(file.path).directory}</span>}
        {fileChange?.stats && <LineStats stats={fileChange.stats} mode="numbers" />}
        {fileChange && isPartlyStaged(fileChange) && <span>{file.staged ? tr("gitphone.showStaged") : tr("gitphone.showNotStaged")}</span>}
      </p>
      {renderFileDiff()}
    </PhoneLayer>
  );

  const pageLayer = page && (() => {
    switch (page.kind) {
      case "history":
        return <PhoneLayer
          title={commitTitle ?? tr("gitphone.history")}
          density={prefs.density}
          onBack={() => { if (commitTitle) closeCommit(); else setPage(null); }}
          {...(commitTitle ? {} : { trailing: <MoreMenu label={tr("gitview.viewOptions")} entries={logActions} /> })}
        >{renderLog()}</PhoneLayer>;
      case "branches":
        return <PhoneLayer
          title={tr("gitview.tabBranches")}
          density={prefs.density}
          onBack={() => setPage(null)}
          {...(branchActions.length ? { trailing: <MoreMenu label={tr("gitphone.moreActions")} entries={branchActions} /> } : {})}
        >{renderBranches()}</PhoneLayer>;
      case "stashes":
        return <PhoneLayer title={tr("gitview.tabStashes")} density={prefs.density} onBack={() => setPage(null)}>{renderStashes()}</PhoneLayer>;
      case "conflicts":
        return <PhoneLayer title={tr("gitview.conflicts")} density={prefs.density} onBack={() => setPage(null)}>{renderConflicts()}</PhoneLayer>;
      case "compare":
        return <PhoneLayer
          title={page.path ? fileIdentity(page.path).name : tr("gitphone.compare")}
          density={prefs.density}
          onBack={() => { if (page.path && !page.fromOverview) setPage({ ...page, path: null }); else setPage(null); }}
        >{renderCompare(page.path, (path) => setPage({ ...page, path }))}</PhoneLayer>;
    }
  })();

  const subjectLength = commitMessage.split("\n", 1)[0]?.trim().length ?? 0;
  const canCommit = Boolean(commitMessage.trim()) && included.length > 0 && !busy && !committing;
  const submit = (sync: boolean) => {
    setCommitting(true);
    void commit(plan, sync)
      .then((done) => {
        if (!done) return;
        setCommitOpen(false);
        setCommitFilesOpen(false);
        setPicks(new Map());
      })
      .finally(() => setCommitting(false));
  };
  const commitSheet = commitOpen && state.kind === "changes" && (
    <Sheet
      title={included.length === 0 ? tr("gitphone.chooseFiles") : commitLabel}
      className="git-phone-commit"
      onClose={() => setCommitOpen(false)}
      footer={<div className="git-phone-commit-actions">
        <Button size="lg" variant="primary" block iconStart={CheckIcon} busy={committing || (busy && !generating)} disabled={!canCommit} onClick={() => submit(false)}>{tr("gitview.commit")}</Button>
        {remote.available && <Button size="lg" block iconStart={SyncIcon} disabled={!canCommit} onClick={() => submit(true)}>{tr("gitphone.commitAndSync")}</Button>}
      </div>}
    >
      <div className="git-page git-phone-sheet" data-density={prefs.density}>
        <div className="git-phone-commit-field ui-field-frame">
          <Textarea
            className="git-commit-msg"
            minRows={3}
            maxRows={8}
            autoGrow
            aria-label={tr("gitview.commitMessage")}
            placeholder={tr("gitphone.commitPlaceholder")}
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
          />
          <div className="git-phone-commit-field-foot">
            <Button size="sm" variant="ghost" iconStart={AssistIcon} busy={generating} disabled={generating || busy} onClick={() => generateMessage(plan)}>{tr("gitview.generate")}</Button>
            {subjectLength > 0 && <span className="git-commit-counter" data-over={subjectLength > SUBJECT_SOFT_LIMIT ? "true" : undefined}>{subjectLength}/{SUBJECT_SOFT_LIMIT}</span>}
          </div>
        </div>
        <button type="button" className="git-phone-row" aria-expanded={commitFilesOpen} onClick={() => setCommitFilesOpen((open) => !open)}>
          <UiIcon icon={CommitIcon} size="md" />
          <span className="git-phone-row-label">{tr("gitphone.filesIncluded", { included: included.length, total: changes.length })}</span>
          <UiIcon icon={commitFilesOpen ? ChevronDownIcon : ChevronRightIcon} size="sm" className="git-phone-row-chevron" />
        </button>
        {commitFilesOpen && <div className="git-phone-commit-files">
          {changes.map((change) => (
            <Checkbox
              key={change.path}
              className="git-phone-commit-file"
              checked={isChangeIncluded(change, changes, picks)}
              onChange={(next) => setIncluded(change, next)}
              label={fileIdentity(change.path).name}
              description={change.staged && change.working ? tr("gitphone.stagedPartOnly") : fileIdentity(change.path).directory}
            />
          ))}
        </div>}
      </div>
    </Sheet>
  );

  const showRows = state.kind === "changes" || (state.kind === "conflict" && state.source === "merge");
  const earlierCommits = state.kind === "changes" && isolated && branchDiff && branchDiff.ahead > 0 ? branchDiff.ahead : 0;

  return (
    <div className="git-page git-phone" data-density={prefs.density} data-state={state.kind} data-commit-open={commitOpen ? "true" : undefined}>
      <div className="git-phone-scroll">
        <header className="git-phone-summary">
          <h2 className="git-phone-title" aria-live="polite">{summary.title}</h2>
          {summary.meta && <p className="git-phone-meta">{summary.meta}</p>}
          {landing && state.kind !== "changes" && state.kind !== "conflict" && landing.check.tone !== "ok" && landing.check.text && (
            <p className="git-phone-check" data-tone={landing.check.tone} role="status">
              {(landing.check.tone === "warn" || landing.check.tone === "danger") && <UiIcon icon={WarningIcon} size="sm" />}
              <span>{landing.check.text}</span>
            </p>
          )}
          <Menu
            label={tr("gitphone.branchAndRemote")}
            title={isolated ? tr("gitphone.isolatedBranch") : branchName}
            phonePresentation="sheet"
            entries={branchEntries}
            header={<div className="git-phone-branch-head">
              <div className="git-phone-branch-name">
                <span className="mono" title={branchName}>{branchName}</span>
                {status?.branch && <IconButton icon={CopyIcon} variant="ghost" label={tr("gitphone.copyBranch")} onClick={() => { void navigator.clipboard?.writeText(status.branch ?? "").catch(() => undefined); }} />}
              </div>
              <p className="git-phone-branch-note">
                {[isolated && base ? tr("gitphone.basedOn", { base }) : "", trackingNote].filter(Boolean).join(" · ")}
              </p>
            </div>}
            footer={identity ? <div className="git-phone-branch-identity"><span>{tr("gitphone.account")}</span>{identity}</div> : undefined}
          >
            {(trigger) => (
              <button {...trigger} type="button" className="git-phone-branch" aria-label={tr("gitphone.branchAndRemote")}>
                <UiIcon icon={BranchIcon} size="sm" />
                <span className="git-phone-branch-label">
                  {repository.options.length > 1 && repository.alias ? `${repository.alias} · ` : ""}
                  {isolated
                    ? (base ? tr("gitphone.isolatedBasedOn", { base }) : tr("gitphone.isolatedBranch"))
                    : <span className="mono">{branchName}</span>}
                </span>
                {state.kind !== "remote" && status && (status.ahead > 0 || status.behind > 0) && (
                  <span className="git-ahead-behind">
                    {status.ahead > 0 && <span className="ahead">↑ {status.ahead}</span>}
                    {status.behind > 0 && <span className="behind">↓ {status.behind}</span>}
                  </span>
                )}
                <UiIcon icon={ChevronDownIcon} size="sm" />
              </button>
            )}
          </Menu>
        </header>

        {feedback}

        {showRows && <div className="git-phone-files" role="list">
          {changes.map((change) => (
            <div role="listitem" key={change.path}>
              <PhoneFileRow
                path={change.path}
                {...(change.origPath ? { origPath: change.origPath } : {})}
                status={change.status}
                {...(change.stats ? { stats: change.stats } : {})}
                lineStats={prefs.lineStats}
                excluded={state.kind === "changes" && !isChangeIncluded(change, changes, picks)}
                onClick={() => openFile(phoneChangeEntry(change))}
              />
            </div>
          ))}
        </div>}

        {state.kind === "conflict" && state.source === "isolation" && conflictFiles && conflictFiles.length > 0 && (
          <div className="git-phone-files" role="list">
            {conflictFiles.map((path) => (
              <div role="listitem" key={path}>
                <PhoneFileRow path={path} status="conflicted" lineStats={prefs.lineStats} onClick={() => openConflict(path)} />
              </div>
            ))}
          </div>
        )}

        {state.kind === "ready" && branchDiff && <div className="git-phone-files" role="list">
          {branchDiff.files.map((entry) => (
            <div role="listitem" key={entry.path}>
              <PhoneFileRow
                path={entry.path}
                {...(entry.previousPath ? { origPath: entry.previousPath } : {})}
                status={entry.status}
                stats={{ additions: entry.additions ?? 0, deletions: entry.deletions ?? 0 }}
                lineStats={prefs.lineStats}
                onClick={() => setPage({ kind: "compare", path: entry.path, fromOverview: true })}
              />
            </div>
          ))}
        </div>}

        <nav className="git-phone-nav" aria-label={tr("gitphone.moreInSourceControl")}>
          {earlierCommits > 0 && row(CommitIcon, earlierCommits === 1 ? tr("gitphone.oneEarlierCommit") : tr("gitphone.earlierCommits", { count: earlierCommits }), () => setPage({ kind: "compare", path: null, fromOverview: false }))}
          {row(HistoryIcon, tr("gitphone.history"), () => setPage({ kind: "history" }))}
          {row(BranchIcon, tr("gitview.tabBranches"), () => setPage({ kind: "branches" }), branchCount || undefined)}
          {row(StashIcon, tr("gitview.tabStashes"), () => setPage({ kind: "stashes" }), stashCount || undefined)}
        </nav>
      </div>

      {(primary || moreEntries.length > 0) && (
        <footer className="git-phone-dock">
          {primary
            ? <Button size="lg" variant="primary" block className="git-phone-primary" iconStart={primary.icon} busy={primary.busy ?? false} disabled={primary.disabled ?? false} onClick={primary.run}>{primary.label}</Button>
            : <span className="header-spacer" />}
          {moreEntries.length > 0 && <MoreMenu
            label={state.kind === "ready" ? tr("landing.chooseBranch") : tr("gitphone.moreActions")}
            {...(state.kind === "ready" ? { title: tr("landing.title") } : {})}
            entries={moreEntries}
            {...(state.kind === "ready" && landing ? { open: landing.choosing, onOpenChange: landing.setChoosing } : {})}
          />}
        </footer>
      )}

      {fileLayer}
      {pageLayer}
      {commitSheet}
      {overlay}
    </div>
  );
}

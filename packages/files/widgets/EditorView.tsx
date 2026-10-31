// The canonical Files surface.
// EditorView is the file-tree and open-resource COORDINATOR — the generic tab
// strip, dirty guarding, keyboard cycling, and kept-alive resource bodies all
// live in the shared workspace/PaneHost; one file's document lifecycle lives
// in editor/FilePane. This file implements no tab store and no second editor.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import { api, type FileEntry } from "@polyth/session/web-api";
import type { EditorLocation } from "@polyth/contracts";
import { resolveWorkspaceContext, type WorkspaceRepository } from "@polyth/contracts/workspace";
import type { SurfaceComponentProps } from "@polyth/web-sdk";
import { closeWorkspacePane, getState, openEditorFile, setEditorFile, useActiveModel, useStore, workspacePresentationKey, workspaceProjectId } from "../../../apps/web/src/store.ts";
import {
  markProjectPresentationChanged,
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventHasKey,
  projectPresentationEventProjectId,
} from "../../../apps/web/src/projectPresentationSync.ts";
import EmptyState, { ProjectRequiredEmpty } from "../../../apps/web/src/components/EmptyState.tsx";
import { requestComposerInsert } from "../../../apps/web/src/composerInsert.ts";
import { formatSelectionChat } from "../../../apps/web/src/chatclip.ts";
import { attachProjectFile } from "../../../apps/web/src/attachments.ts";
import { MOD } from "../../../apps/web/src/format.ts";
import { usePaneVisible } from "../../../apps/web/src/workspace/paneVisibility.ts";
import { setPaneLastResource } from "../../../apps/web/src/workspace/panePrefs.ts";
import { openResource } from "../../../apps/web/src/resources/navigation.ts";
import type { PaneTab } from "../../../apps/web/src/workspace/paneStore.ts";
import PaneHost, { type PaneHostHandle } from "../../../apps/web/src/components/workspace/PaneHost.tsx";
import { FileTypeGlyph, fileTypeKeyOf } from "./editor/fileTreeIcons.tsx";
import RepositoryTree from "./editor/RepositoryTree.tsx";
import FlatFileList from "./editor/FlatFileList.tsx";
import type { GitKindEntry } from "./editor/sessionChanges.ts";
import { buildCheckoutEdits, sessionToneColor, treeChanges, type CheckoutEdits, type CheckoutSession, type EditSource } from "./editor/checkoutEdits.ts";
import { fetchCheckoutSources, liveEditCalls, mergeLiveCalls } from "./editor/sessionEditsClient.ts";
import { checkoutScopeKey, publishCheckoutEdits, sessionLabel } from "./editor/sessionEditsStore.ts";
import { useOpenSessionEdits } from "./workbenchHints.ts";
import { ContextMenuAnchor } from "./editor/contextMenuAnchor.tsx";
import { confirmAlert, promptAlert } from "../../../apps/web/src/alerts.ts";
import { desktopBridge } from "../../../apps/web/src/desktopBridge.ts";
import { RESOURCE_MIME, dragKind, getDragResource } from "../../../apps/web/src/dnd.ts";
import { announceFilesChanged } from "./editor/FilePane.tsx"; // registers the "file" pane provider
import { isDocDirty, peekFileDoc, removeDoc, renameDoc } from "./editor/fileDocs.ts";
import "../../../apps/web/src/workspace/mainSlotPanes.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts"; // registers the "plugin" slot bridge
import { BackIcon, Button, CloseIcon, Icon, CollapseIcon, DownloadIcon, FileIcon, FolderIcon, IconButton, Menu, MoreIcon, ListViewIcon, RefreshIcon, RepositoryScopePicker, ResponsiveOverlay, SearchIcon, Spinner, Tabs, TextInput, TreeViewIcon, UploadIcon, WorkspaceSurfaceHeader, type MenuEntry } from "../../../apps/web/src/components/ui/index.ts";
import { formatSize, isTreeSortMode, type TreeSortMode } from "./editor/treeSort.ts";
import { archiveUrl, checkArchive, downloadUrl, MAX_UPLOAD_BYTES, triggerDownload, uploadIntoFolder, type ArchiveRefusal } from "./editor/uploads.ts";
import { matchSegments, splitPath } from "./editor/searchMatch.ts";
import { isImeComposing } from "@polyth/web-sdk";

interface EditorLocationResult {
  projectId: string;
  sessionId: string | null;
  repositoryId: string;
  path: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  name?: string;
  kind?: string;
}
interface EditorReferenceResult extends EditorLocationResult { isDefinition?: boolean }
interface IdePeekPreview {
  content: string;
  startLine: number;
  revision?: string;
  truncated?: boolean;
  error?: string;
}
interface EditorRenamePreview { oldName: string; newName: string; targets: Array<EditorLocationResult & { expectedRevision: string }> }
interface GitHunkContext {
  projectId: string;
  sessionId: string | null;
  repositoryId: string;
  path: string;
  hunkIndex: number;
  hunkDigest: string;
  expectedSnapshotDigest: string;
  expectedStaged: boolean;
  diff?: string;
  loading?: boolean;
}

const baseOf = (p: string) => p.split("/").pop() ?? p;
const safeRelativeResourcePath = (value: string): boolean => Boolean(value)
  && !value.includes("\0") && !value.includes("\\") && !value.startsWith("/")
  && !/^[A-Za-z]:/.test(value)
  && !value.split("/").some((segment) => !segment || segment === "..");
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
type FilesView = "tree" | "list";
type FilesTreePrefs = { showHidden: boolean; hideIgnored: boolean; autoReveal: boolean; changedOnly: boolean; sort: TreeSortMode; view: FilesView };
const DEFAULT_TREE_PREFS: FilesTreePrefs = { showHidden: false, hideIgnored: true, autoReveal: true, changedOnly: false, sort: "name", view: "tree" };
/** Quick-open waits this long after the last keystroke before asking the server. */
const SEARCH_DEBOUNCE_MS = 160;
const SEARCH_LIMIT = 50;
const treePrefsKey = (projectId: string | null, sessionId: string | null): string =>
  projectId ? workspacePresentationKey("files.tree-options", projectId, sessionId) : "polyth.files.tree-options.unscoped";
const legacyTreePrefsKey = (projectId: string | null, sessionId: string | null): string | null =>
  projectId ? `polyth.files.tree-options.${workspacePresentationKey("files.tree-options", projectId, sessionId)}` : null;
/** Other chats' edits refresh on this cadence while Files is visible. */
const SESSION_EDITS_REFRESH_MS = 8_000;
/** IDE mode opens at most this many of a chat's edited files as tabs. */
const MAX_AUTO_OPEN_TABS = 40;
const MAX_AUTO_OPEN_RECORDS = 500;
const EMPTY_SOURCES: readonly EditSource[] = [];

/** Which edit of each file IDE mode already opened, so a tab the person
 *  closed stays closed until the chat edits that file again. */
function readAutoOpened(key: string): Map<string, number> | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    if (raw === null) return null;
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return new Map();
    return new Map(value.filter((entry): entry is [string, number] =>
      Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number"));
  } catch { return new Map(); }
}

function writeAutoOpened(key: string, seen: Map<string, number>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...seen].slice(-MAX_AUTO_OPEN_RECORDS)));
  } catch { /* storage is optional */ }
}

/** The viewing chat's newest edit of a file, or -1. */
function viewerEditSeq(edits: CheckoutEdits, path: string, viewerId: string): { seq: number; time: number } | null {
  const file = edits.files.get(path);
  if (!file || file.kind === "deleted" || !file.sessions.includes(viewerId)) return null;
  let found: { seq: number; time: number } | null = null;
  for (const edit of file.edits) {
    if (edit.sessionId === viewerId && (!found || edit.time >= found.time)) found = { seq: edit.seq, time: edit.time };
  }
  return found ?? { seq: file.seq, time: 0 };
}

/** Existing files the viewing chat edited, oldest first edit first. */
function viewerFilesOf(edits: CheckoutEdits, viewerId: string | null): string[] {
  if (!viewerId) return [];
  const rows: Array<[string, number]> = [];
  for (const [path, file] of edits.files) {
    if (file.kind === "deleted" || !file.sessions.includes(viewerId)) continue;
    const first = file.edits.find((edit) => edit.sessionId === viewerId);
    rows.push([path, first?.time ?? file.seq]);
  }
  return rows.sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0])).map(([path]) => path);
}

function readTreePrefs(projectId: string | null, sessionId: string | null): FilesTreePrefs {
  if (typeof localStorage === "undefined") return DEFAULT_TREE_PREFS;
  try {
    const key = treePrefsKey(projectId, sessionId);
    let raw = localStorage.getItem(key);
    const legacy = legacyTreePrefsKey(projectId, sessionId);
    if (raw === null && legacy) {
      raw = localStorage.getItem(legacy);
      if (raw !== null) {
        localStorage.setItem(key, raw);
        localStorage.removeItem(legacy);
      }
    }
    const value = JSON.parse(raw ?? "null") as Partial<FilesTreePrefs> | null;
    return {
      showHidden: value?.showHidden === true,
      hideIgnored: value?.hideIgnored !== false,
      autoReveal: value?.autoReveal !== false,
      changedOnly: value?.changedOnly === true,
      sort: isTreeSortMode(value?.sort) ? value.sort : "name",
      view: value?.view === "list" ? "list" : "tree",
    };
  } catch { return DEFAULT_TREE_PREFS; }
}

async function editorLanguageRequest(
  capability: "definition" | "references",
  context: Pick<IdeContext, "projectId" | "sessionId" | "repositoryId" | "path" | "position" | "content" | "contentRevision">,
): Promise<{ definitions?: EditorLocationResult[]; references?: EditorReferenceResult[] }> {
  const response = await fetch("/api/editor/language", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...context, capability }),
  });
  if (!response.ok) throw new Error(tr("editorview.ideLanguageFailed", { status: response.status }));
  return await response.json() as { definitions?: EditorLocationResult[]; references?: EditorReferenceResult[] };
}

async function editorRenamePreview(context: IdeContext, newName: string): Promise<EditorRenamePreview | null> {
  const response = await fetch("/api/editor/language/rename-preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...context, newName }),
  });
  if (!response.ok) throw new Error(tr("editorview.ideRenamePreviewFailed", { status: response.status }));
  return ((await response.json()) as { rename?: EditorRenamePreview }).rename ?? null;
}

/** Where desktop files dropped outside the tree go: over the editor, the open
 *  file's folder; over the flat list, the row's folder; elsewhere the root. */
interface WindowDrop {
  dir: string;
  repositoryId: string;
  zone: "pane" | "side";
}

const parentDir = (path: string): string => path.split("/").slice(0, -1).join("/");

interface CtxMenu {
  x: number;
  y: number;
  entry: FileEntry | null;
  repositoryId: string | null;
}

interface IdeContext {
  x: number;
  y: number;
  projectId: string;
  sessionId: string | null;
  repositoryId: string;
  path: string;
  position: { line: number; character: number };
  selection: string;
  content?: string;
  contentRevision?: string;
  startLine?: number;
  endLine?: number;
}

export interface EditorViewProps extends SurfaceComponentProps {
  /**
   * Canvas widget rendering. A widget already owns a pane host, so opening a
   * file must stay inside it: the navigating `openEditorFile` adapter would
   * otherwise force the workspace back to Chat behind a plain tree click.
   */
  embedded?: boolean;
}

export default function EditorView({
  projectId: scopedProjectId,
  sessionId: scopedSessionId,
  embedded = false,
}: EditorViewProps) {
  const storeProjectId = useStore(workspaceProjectId);
  const storeSessionId = useStore((s) => s.activeSessionId);
  const projectId = scopedProjectId === undefined ? storeProjectId : scopedProjectId;
  const project = useStore((s) => s.projectRegistry.projects.find((candidate) => candidate.id === projectId));
  // Files must follow the ACTIVE SESSION's worktree, not the project root:
  // every files call carries the session id.
  const sessionId = scopedSessionId === undefined ? storeSessionId : scopedSessionId;
  const session = useStore((s) => s.sessions.find((candidate) => candidate.id === sessionId));
  const sid = sessionId ?? undefined;
  const filePath = useStore((s) => s.editorFile);
  const editorRepositoryId = useStore((s) => s.editorRepositoryId);
  const editorOpenRequest = useStore((s) => s.editorOpenRequest);
  const visible = usePaneVisible();
  const workspace = useMemo(() => {
    if (!project) return { repositories: [] as readonly WorkspaceRepository[], error: "" };
    try {
      return { repositories: resolveWorkspaceContext(project, session ?? null).repositories, error: "" };
    } catch (error) {
      return { repositories: [] as readonly WorkspaceRepository[], error: msg(error) };
    }
  }, [project, session]);
  const repositories = workspace.repositories.length > 0
    ? workspace.repositories
    : projectId
      ? [{ repositoryId: "primary", alias: tr("editorview.files"), path: project?.path ?? "", state: "ready" as const }]
      : workspace.repositories;
  const readyRepositories = repositories.filter((repository) => repository.state === "ready");
  const readyRepositoryKey = readyRepositories.map((repository) => `${repository.repositoryId}:${repository.path}:${repository.state}`).join("\u0000");
  const primaryRepositoryId = project?.primaryRepositoryId
    ?? repositories.find((repository) => repository.path === project?.path)?.repositoryId
    ?? (repositories.length === 1 ? repositories[0]?.repositoryId : null);
  const [treeRepositoryId, setTreeRepositoryId] = useState<string | null>(null);
  const activeRepository = readyRepositories.find((repository) => repository.repositoryId === treeRepositoryId)
    ?? readyRepositories.find((repository) => repository.repositoryId === primaryRepositoryId)
    ?? readyRepositories[0] ?? null;
  const activeRepositoryId = activeRepository?.repositoryId ?? null;
  const [desktopWide, setDesktopWide] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia("(min-width: 821px)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 821px)");
    const update = () => setDesktopWide(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  const showRepositorySections = desktopWide && repositories.length > 1;
  const visibleRepositories = showRepositorySections
    ? repositories
    : activeRepository ? [activeRepository] : [];

  // ---- tree ----------------------------------------------------------------
  const [treeErr, setTreeErr] = useState("");
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [ideContext, setIdeContext] = useState<IdeContext | null>(null);
  const peekRequest = useRef(0);
  const [idePeek, setIdePeek] = useState<{
    title: string;
    items: Array<EditorLocationResult | EditorReferenceResult>;
    previews: Record<string, IdePeekPreview | undefined>;
  } | null>(null);
  const [gitHunk, setGitHunk] = useState<GitHunkContext | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<string[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchRequest = useRef(0);
  const [uploadStatus, setUploadStatus] = useState<{ text: string; busy: boolean } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<{ dir: string; repositoryId: string } | null>(null);
  /** Desktop files dragged over Files outside the tree: where they would land. */
  const [windowDrop, setWindowDrop] = useState<WindowDrop | null>(null);
  const windowDragDepth = useRef(0);
  const [mobileStage, setMobileStage] = useState<"tree" | "editor">("tree");
  const [treePrefs, setTreePrefs] = useState<FilesTreePrefs>(() => readTreePrefs(projectId ?? null, sessionId ?? null));
  const currentTreePrefsScope = treePrefsKey(projectId ?? null, sessionId ?? null);
  const [treePrefsScope, setTreePrefsScope] = useState(currentTreePrefsScope);
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  const [treeCollapseToken, setTreeCollapseToken] = useState(0);
  const [repositoryStatus, setRepositoryStatus] = useState<Record<string, { branch: string | null; changes: number }>>({});
  const [repositoryGit, setRepositoryGit] = useState<Record<string, readonly GitKindEntry[]>>({});
  // Bumped when any chat's edits change, so the tree's "still uncommitted"
  // view of other chats' files follows their new edits.
  const [editsGitToken, setEditsGitToken] = useState(0);
  const activeModel = useActiveModel();
  useEffect(() => {
    setTreePrefsScope(currentTreePrefsScope);
    setTreePrefs(readTreePrefs(projectId ?? null, sessionId ?? null));
  }, [currentTreePrefsScope, projectId, sessionId]);
  useEffect(() => {
    if (treePrefsScope !== currentTreePrefsScope) return;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(treePrefsKey(projectId ?? null, sessionId ?? null), JSON.stringify(treePrefs));
        if (projectId) markProjectPresentationChanged(projectId, "workspaceState");
      } catch { /* storage is optional */ }
    }
  }, [currentTreePrefsScope, projectId, sessionId, treePrefs, treePrefsScope]);
  useEffect(() => {
    const onHydrated = (event: Event): void => {
      if (!projectId || projectPresentationEventProjectId(event) !== projectId || !projectPresentationEventHasKey(event, "workspaceState")) return;
      const next = readTreePrefs(projectId, sessionId);
      setTreePrefs((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
    return () => window.removeEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
  }, [projectId, sessionId]);
  const effectiveTreePrefs = treePrefsScope === currentTreePrefsScope ? treePrefs : DEFAULT_TREE_PREFS;
  useEffect(() => {
    if (!projectId || readyRepositories.length === 0) { setRepositoryStatus({}); return; }
    let current = true;
    void Promise.all(readyRepositories.map(async (repository) => {
      try {
        const status = await api.gitStatus(projectId, sessionId ?? undefined, repository.repositoryId);
        const paths = new Set([...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted].map((entry) => entry.path));
        const git = [...status.staged, ...status.unstaged, ...status.untracked].map((entry) => ({ path: entry.path, status: entry.status }));
        return [repository.repositoryId, { branch: status.branch, changes: paths.size }, git] as const;
      } catch { return [repository.repositoryId, { branch: null, changes: 0 }, []] as const; }
    })).then((rows) => {
      if (!current) return;
      setRepositoryStatus(Object.fromEntries(rows.map(([id, status]) => [id, status])));
      setRepositoryGit(Object.fromEntries(rows.map(([id, , git]) => [id, git])));
    });
    return () => { current = false; };
  }, [projectId, sessionId, readyRepositoryKey, treeRefreshToken, editsGitToken]);
  // What each chat writing into this checkout edited, per repository. The
  // viewing chat's edits come live from the canonical render model (so they
  // update while a turn runs, for every harness) merged with the server's
  // complete history; other chats sharing the checkout come from the server.
  const sessionWorktree = session?.worktreePath;
  const followEdits = useOpenSessionEdits();
  const liveViewer = !!sessionId && sessionId === storeSessionId;
  const live = useMemo(
    () => liveViewer ? liveEditCalls(activeModel.messages) : null,
    [liveViewer, activeModel.messages],
  );
  const editsScope = `${projectId ?? ""}\0${sessionId ?? ""}`;
  const [server, setServer] = useState<{ scope: string; sources: readonly EditSource[] }>({ scope: editsScope, sources: EMPTY_SOURCES });
  useEffect(() => {
    if (!projectId || !visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pausedUntil = 0;
    const run = async () => {
      if (cancelled || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      if (Date.now() < pausedUntil) return;
      try {
        const result = await fetchCheckoutSources(projectId, sessionId ?? null);
        if (cancelled) return;
        setServer({ scope: editsScope, sources: result.sources });
        if (result.more) schedule(300);
      } catch (error) {
        // Older servers or a chat the server does not know yet leave the live
        // chat's edits only; an unknown route or chat is not asked every poll.
        const status = (error as { status?: unknown }).status;
        if (status === 404 || status === 405) pausedUntil = Date.now() + 60_000;
      }
    };
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    };
    schedule(0);
    const interval = setInterval(() => void run(), SESSION_EDITS_REFRESH_MS);
    const onFilesChanged = () => schedule(600);
    const onFocus = () => schedule(0);
    window.addEventListener("polyth:files-changed", onFilesChanged);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener("polyth:files-changed", onFilesChanged);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId, visible]);
  const sources = useMemo<EditSource[]>(() => {
    const fetched = server.scope === editsScope ? server.sources : EMPTY_SOURCES;
    const list: EditSource[] = [];
    if (sessionId) {
      const fromServer = fetched.find((source) => source.viewer && source.sessionId === sessionId);
      list.push({
        sessionId,
        title: session?.title ?? fromServer?.title ?? "",
        createdAt: session?.createdAt ?? fromServer?.createdAt ?? 0,
        viewer: true,
        calls: mergeLiveCalls(fromServer?.calls ?? [], live?.calls ?? []),
        ...(live?.lastUserSeq !== undefined ? { lastUserSeq: live.lastUserSeq } : {}),
      });
    }
    for (const source of fetched) {
      if (!source.viewer && source.sessionId !== sessionId) list.push(source);
    }
    return list;
  }, [editsScope, live, server, session?.createdAt, session?.title, sessionId]);
  const editsSignature = sources
    .map((source) => `${source.sessionId}:${source.calls.length}:${source.calls.at(-1)?.seq ?? 0}`)
    .join("|");
  const lastEditsSignature = useRef<string | null>(null);
  useEffect(() => {
    if (lastEditsSignature.current !== null && lastEditsSignature.current !== editsSignature) {
      setEditsGitToken((value) => value + 1);
    }
    lastEditsSignature.current = editsSignature;
  }, [editsSignature]);
  const checkoutByRepository = useMemo(() => {
    const result = new Map<string, CheckoutEdits>();
    for (const repository of readyRepositories) {
      const roots = [repository.path];
      if (sessionWorktree && (readyRepositories.length === 1 || repository.repositoryId === primaryRepositoryId)) roots.push(sessionWorktree);
      result.set(repository.repositoryId, buildCheckoutEdits(sources, roots, repositoryGit[repository.repositoryId] ?? []));
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, readyRepositoryKey, repositoryGit, sessionWorktree, primaryRepositoryId]);
  const changesByRepository = useMemo(() => {
    const result = new Map<string, ReturnType<typeof treeChanges>>();
    for (const [repositoryId, edits] of checkoutByRepository) {
      const dirty = new Set((repositoryGit[repositoryId] ?? []).map((entry) => entry.path));
      result.set(repositoryId, treeChanges(edits, sessionId ?? null, dirty));
    }
    return result;
  }, [checkoutByRepository, repositoryGit, sessionId]);
  // File panes, tab markers and the review bar read the same model.
  useEffect(() => {
    if (!projectId) return;
    const published: string[][] = [];
    for (const repository of readyRepositories) {
      const edits = checkoutByRepository.get(repository.repositoryId);
      if (!edits) continue;
      const keys = [checkoutScopeKey(projectId, sessionId ?? null, repository.repositoryId)];
      if (repository.repositoryId === (primaryRepositoryId ?? readyRepositories[0]?.repositoryId)) {
        keys.push(checkoutScopeKey(projectId, sessionId ?? null, undefined));
      }
      publishCheckoutEdits(keys, { edits, viewerFiles: viewerFilesOf(edits, sessionId ?? null) });
      published.push(keys);
    }
    return () => { for (const keys of published) publishCheckoutEdits(keys, null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutByRepository, projectId, sessionId, primaryRepositoryId]);
  const visibleRepositoryKey = visibleRepositories.map((repository) => repository.repositoryId).join("\0");
  const changeSessions = useMemo(() => {
    const byId = new Map<string, CheckoutSession>();
    for (const repository of visibleRepositories) {
      for (const entry of checkoutByRepository.get(repository.repositoryId)?.sessions ?? []) byId.set(entry.sessionId, entry);
    }
    return [...byId.values()].sort((left, right) => left.tone - right.tone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutByRepository, visibleRepositoryKey]);
  // Colour dots only mean something once a second chat (or another chat) is involved.
  const showChangeOwners = changeSessions.length > 1 || changeSessions.some((entry) => !entry.viewer);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const consumedOpenRequest = useRef<number | null>(null);

  const paneRef = useRef<PaneHostHandle>(null);
  const editorScopeKey = `${projectId ?? ""}\0${sessionId ?? ""}\0${readyRepositories.map((repository) => `${repository.repositoryId}:${repository.path}:${repository.state}`).sort().join(",")}`;
  const editorScopeRef = useRef(editorScopeKey);
  editorScopeRef.current = editorScopeKey;
  useEffect(() => {
    peekRequest.current += 1;
    setIdePeek(null);
    setIdeContext(null);
    setGitHunk(null);
    return () => { peekRequest.current += 1; };
  }, [editorScopeKey]);
  const [activeTab, setActiveTab] = useState<PaneTab | null>(null);
  const [openTabCount, setOpenTabCount] = useState(0);
  const activePath = activeTab && activeTab.kind === "file" && !activeTab.unavailable ? activeTab.resource : null;

  // Store-driven opens (file refs in chat, palette, adapters) become tabs.
  // The request id is intentionally observed: opening the same path again can
  // be a pin request even though `editorFile` itself did not change.
  useEffect(() => {
    if (!filePath || !editorOpenRequest) return;
    if (editorOpenRequest.projectId !== (projectId ?? null) || editorOpenRequest.sessionId !== (sessionId ?? null)) return;
    if (consumedOpenRequest.current === editorOpenRequest.id) return;
    const requestedRepositoryId = editorOpenRequest.repositoryId ?? primaryRepositoryId ?? "primary";
    if (requestedRepositoryId !== (activeRepositoryId ?? "primary")) {
      if (readyRepositories.some((repository) => repository.repositoryId === requestedRepositoryId)) {
        setTreeRepositoryId(requestedRepositoryId);
      }
      return;
    }
    paneRef.current?.open("file", filePath, baseOf(filePath), { preview: editorOpenRequest.preview, repositoryId: activeRepositoryId ?? undefined });
    consumedOpenRequest.current = editorOpenRequest.id;
    setMobileStage("editor");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpenRequest?.id, filePath, projectId, sessionId, activeRepositoryId, readyRepositoryKey, primaryRepositoryId]);

  // IDE mode: every file this chat edited is an open tab (each chat keeps its
  // own set, because the pane is scoped per chat). New edits open as they land;
  // the newest edit of the running turn comes to the front unless the person
  // is working in Files or reading a file the chat did not touch.
  useEffect(() => {
    const pane = paneRef.current;
    if (!followEdits || !projectId || !sessionId || !pane) return;
    const recordKey = workspacePresentationKey("files.session-edits-opened", projectId, sessionId);
    const stored = readAutoOpened(recordKey);
    const seen = stored ?? new Map<string, number>();
    const fresh: Array<{ repositoryId: string; path: string; time: number; latestTurn: boolean }> = [];
    const viewerPaths = new Set<string>();
    for (const repository of readyRepositories) {
      const edits = checkoutByRepository.get(repository.repositoryId);
      if (!edits) continue;
      for (const path of viewerFilesOf(edits, sessionId)) {
        viewerPaths.add(`${repository.repositoryId}\0${path}`);
        const edit = viewerEditSeq(edits, path, sessionId);
        const key = `${repository.repositoryId}\0${path}`;
        if (!edit || (seen.get(key) ?? -1) >= edit.seq) continue;
        seen.set(key, edit.seq);
        fresh.push({ repositoryId: repository.repositoryId, path, time: edit.time, latestTurn: edits.files.get(path)?.latestTurn === true });
      }
    }
    if (fresh.length === 0) return;
    writeAutoOpened(recordKey, seen);
    const ordered = fresh.sort((left, right) => left.time - right.time).slice(-MAX_AUTO_OPEN_TABS);
    for (const item of ordered) {
      pane.open("file", item.path, baseOf(item.path), { preview: false, repositoryId: item.repositoryId, background: true });
    }
    const newest = ordered.filter((item) => item.latestTurn).at(-1);
    if (!newest) return;
    const active = pane.activeTab();
    const focused = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      && document.activeElement.closest(".editor-view") !== null;
    const activeRepositoryKey = active?.repositoryId ?? primaryRepositoryId ?? "primary";
    const follow = !focused && (!active || (active.kind === "file"
      && !isDocDirty(projectId, sessionId, active.resource, active.repositoryId)
      && viewerPaths.has(`${activeRepositoryKey}\0${active.resource}`)));
    if (follow) pane.open("file", newest.path, baseOf(newest.path), { preview: false, repositoryId: newest.repositoryId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followEdits, checkoutByRepository, projectId, sessionId]);

  // Active tab drives the store channel + the project-scoped last resource.
  const onActiveChange = (tab: PaneTab | null) => {
    setActiveTab(tab);
    const next = tab && tab.kind === "file" && !tab.unavailable ? tab.resource : null;
    const tabRepositoryId = tab?.repositoryId ?? primaryRepositoryId ?? "primary";
    if (tab && tabRepositoryId !== (activeRepositoryId ?? "primary")
      && readyRepositories.some((repository) => repository.repositoryId === tabRepositoryId)) {
      setTreeRepositoryId(tabRepositoryId);
    }
    if (getState().editorFile !== next || getState().editorRepositoryId !== (tab?.repositoryId ?? null)) {
      setEditorFile(next, tab?.repositoryId);
    }
    if (next !== null) {
      setMobileStage("editor");
      if (projectId) setPaneLastResource(projectId, "files", `file:${next}`);
    } else {
      setMobileStage("tree");
    }
  };
  /** Canvas-only open: the widget's own pane host becomes the destination and
   *  the shared selection/reveal range is published without navigating. The
   *  selection is published first so the pane host's active-tab sync stays a
   *  no-op and cannot clear the reveal range before the body consumes it. */
  const openFileInPane = (fp: string, repositoryId: string, options: { preview?: boolean; location?: EditorLocation } = {}) => {
    setEditorFile(fp, repositoryId, options.location);
    paneRef.current?.open("file", fp, baseOf(fp), { preview: options.preview !== false, repositoryId });
  };

  const openFile = (fp: string, repositoryId: string) => {
    setMobileStage("editor");
    if (repositoryId !== activeRepositoryId) setTreeRepositoryId(repositoryId);
    if (embedded) openFileInPane(fp, repositoryId, { preview: true });
    else openEditorFile(fp, undefined, { preview: true, repositoryId }); // request channel → preview tab
  };

  const pinFile = (fp: string, repositoryId: string) => {
    setMobileStage("editor");
    if (repositoryId !== activeRepositoryId) setTreeRepositoryId(repositoryId);
    if (embedded) openFileInPane(fp, repositoryId, { preview: false });
    else paneRef.current?.open("file", fp, baseOf(fp), { preview: false, repositoryId });
    paneRef.current?.pin("file", fp, repositoryId);
    if (!embedded) openEditorFile(fp, undefined, { preview: false, repositoryId });
  };

  // The editor package remains independent of Files' store. Navigation and
  // symbol actions cross this browser event seam with the complete resource
  // identity, so a same-path secondary repository can never fall back to the
  // primary checkout.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const value = (event as CustomEvent).detail as Record<string, unknown> | undefined;
      if (!value || value.projectId !== projectId || value.sessionId !== (sessionId ?? null)
        || typeof value.path !== "string" || !safeRelativeResourcePath(value.path) || typeof value.repositoryId !== "string") return;
      const targetRepo = value.repositoryId;
      if (!readyRepositories.some((repository) => repository.repositoryId === targetRepo)) return;
      setTreeRepositoryId(targetRepo);
      setMobileStage("editor");
      const revealValue = value.reveal as { startLine?: unknown; endLine?: unknown } | undefined;
      const location = revealValue && Number.isSafeInteger(revealValue.startLine)
        ? { path: value.path, startLine: Number(revealValue.startLine), endLine: Number(revealValue.endLine ?? revealValue.startLine) }
        : undefined;
      openEditorFile(value.path, location, { preview: true, repositoryId: targetRepo });
    };
    const onDefinitions = (event: Event) => {
      const value = (event as CustomEvent).detail as { definitions?: EditorLocationResult[] } | undefined;
      const definitions = value?.definitions?.filter(validPeekLocation);
      if (definitions?.length) {
        const items = definitions.slice(0, 8);
        setIdePeek({ title: tr("editorview.ideDefinitions"), items, previews: {} });
        void loadPeekPreviews(items, tr("editorview.ideDefinitions"));
      }
    };
    const onContext = (event: Event) => {
      const value = (event as CustomEvent).detail as IdeContext | undefined;
      if (!value || value.projectId !== projectId || value.sessionId !== (sessionId ?? null)) return;
      if (!readyRepositories.some((repository) => repository.repositoryId === value.repositoryId)) return;
      setIdeContext(value);
    };
    const onGitHunk = (event: Event) => {
      const value = (event as CustomEvent).detail as GitHunkContext | undefined;
      if (!value || value.projectId !== projectId || value.sessionId !== (sessionId ?? null)
        || !readyRepositories.some((repository) => repository.repositoryId === value.repositoryId)) return;
      setGitHunk({ ...value, loading: true });
      const query = new URLSearchParams({
        projectId: value.projectId,
        path: value.path,
        repositoryId: value.repositoryId,
        ...(value.sessionId ? { sessionId: value.sessionId } : {}),
      });
      void fetch(`/api/git/diff?${query}`)
        .then(async (response) => {
          if (!response.ok) throw new Error(tr("editorview.ideDiffUnavailable", { status: response.status }));
          return await response.json() as { diff?: unknown };
        })
        .then((result) => setGitHunk((current) => current && current.path === value.path
          ? { ...current, diff: typeof result.diff === "string" ? result.diff : "", loading: false }
          : current))
        .catch(() => setGitHunk((current) => current && current.path === value.path ? { ...current, loading: false, diff: "" } : current));
    };
    window.addEventListener("polyth:editor-open", onOpen);
    window.addEventListener("polyth:editor-definition-list", onDefinitions);
    window.addEventListener("polyth:editor-context-menu", onContext);
    window.addEventListener("polyth:editor-git-hunk", onGitHunk);
    return () => {
      window.removeEventListener("polyth:editor-open", onOpen);
      window.removeEventListener("polyth:editor-definition-list", onDefinitions);
      window.removeEventListener("polyth:editor-context-menu", onContext);
      window.removeEventListener("polyth:editor-git-hunk", onGitHunk);
    };
  }, [projectId, sessionId, readyRepositoryKey]);

  const openLanguageLocation = (location: EditorLocationResult, preview = true) => {
    if (location.projectId !== projectId || location.sessionId !== (sessionId ?? null)) return;
    if (!readyRepositories.some((repository) => repository.repositoryId === location.repositoryId)) return;
    setTreeRepositoryId(location.repositoryId);
    setMobileStage("editor");
    const target: EditorLocation = {
      path: location.path,
      startLine: location.range.start.line + 1,
      endLine: location.range.end.line + 1,
    };
    if (embedded) openFileInPane(location.path, location.repositoryId, { preview, location: target });
    else openEditorFile(location.path, target, { preview, repositoryId: location.repositoryId });
  };

  const validPeekLocation = (location: EditorLocationResult | EditorReferenceResult): boolean =>
    location.projectId === projectId
    && location.sessionId === (sessionId ?? null)
    && readyRepositories.some((repository) => repository.repositoryId === location.repositoryId)
    && location.path.length > 0
    && safeRelativeResourcePath(location.path);

  const loadPeekPreviews = async (items: Array<EditorLocationResult | EditorReferenceResult>, title: string) => {
    const request = ++peekRequest.current;
    const scope = editorScopeKey;
    const bounded = items.filter(validPeekLocation).slice(0, 8);
    const previews: Array<readonly [string, IdePeekPreview]> = [];
    for (const [index, item] of bounded.entries()) {
      if (request !== peekRequest.current || editorScopeRef.current !== scope) return;
      const key = `${item.repositoryId}:${item.path}:${item.range.start.line}:${index}`;
      try {
        const read = await api.filesRead(projectId!, item.path, sessionId ?? undefined, undefined, item.repositoryId);
        if (request !== peekRequest.current || editorScopeRef.current !== scope) return;
        const lines = read.content.split("\n");
        const start = Math.max(0, Math.min(item.range.start.line - 3, lines.length - 1));
        const excerpt = lines.slice(start, start + 24).map((line) => line.slice(0, 600)).join("\n").slice(0, 8_000);
        previews.push([key, { content: excerpt, startLine: start, revision: read.revision, truncated: read.truncated }]);
      } catch (error) {
        previews.push([key, { content: "", startLine: item.range.start.line, error: msg(error) }]);
      }
    }
    if (request === peekRequest.current && editorScopeRef.current === scope) setIdePeek((current) => current?.title === title
      ? { ...current, previews: Object.fromEntries(previews) } : current);
  };

  const runIdeAction = async (action: "definition" | "references" | "rename" | "peek") => {
    const context = ideContext;
    if (!context) return;
    const actionRequest = ++peekRequest.current;
    const actionScope = editorScopeKey;
    setIdeContext(null);
    try {
      if (action === "rename") {
        const newName = (await promptAlert(tr("editorview.renameSymbol"), { title: tr("editorview.renameSymbol"), confirmLabel: tr("editorview.renamePreview") }))?.trim() ?? "";
        if (!newName) return;
        const preview = await editorRenamePreview(context, newName);
        if (actionRequest !== peekRequest.current || editorScopeRef.current !== actionScope) return;
        if (!preview?.targets.length) return;
        if (!preview.targets.every(validPeekLocation)) return;
        const dirty = preview.targets.find((target) => isDocDirty(target.projectId, target.sessionId, target.path, target.repositoryId));
        if (dirty) {
          setTreeErr(tr("editorview.renameDirty", { path: dirty.path }));
          return;
        }
        const summary = preview.targets.map((target) => target.path).join("\n");
        if (!await confirmAlert(tr("editorview.renameReview", { oldName: preview.oldName, newName: preview.newName, summary }), { title: tr("editorview.renameReviewTitle"), confirmLabel: tr("editorview.renameApply") })) return;
        if (actionRequest !== peekRequest.current || editorScopeRef.current !== actionScope) return;
        const response = await fetch("/api/editor/language/rename-apply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...context, newName, targets: preview.targets }),
        });
        if (!response.ok && response.status !== 207) throw new Error(tr("editorview.ideRenameFailed", { status: response.status }));
        const result = await response.json() as { failed?: Array<{ path: string; reason: string }> };
        if (result.failed?.length) setTreeErr(tr("editorview.renamePartial", { items: result.failed.map((item) => `${item.path} (${item.reason})`).join(", ") }));
        announceFilesChanged({ projectId: projectId ?? undefined, sessionId, repositoryId: context.repositoryId, path: context.path, source: "user" });
        return;
      }
      const result = await editorLanguageRequest(action === "references" ? "references" : "definition", context);
      if (actionRequest !== peekRequest.current || editorScopeRef.current !== actionScope) return;
      const items = action === "references" ? result.references ?? [] : result.definitions ?? [];
      const validItems = items.filter(validPeekLocation);
      if (action === "peek" || validItems.length !== 1) {
        if (validItems.length) {
          const title = tr(action === "references" ? "editorview.ideReferences" : "editorview.idePeekDefinition");
          setIdePeek({ title, items: validItems.slice(0, 8), previews: {} });
          void loadPeekPreviews(validItems, title);
        }
      } else {
        openLanguageLocation(validItems[0]!);
      }
    } catch (error) {
      setTreeErr(msg(error));
    }
  };

  const revertGitHunk = async () => {
    const hunk = gitHunk;
    if (!hunk || hunk.loading) return;
    if (isDocDirty(hunk.projectId, hunk.sessionId, hunk.path, hunk.repositoryId)) {
      setTreeErr(tr("editorview.revertDirty", { path: hunk.path }));
      return;
    }
    try {
      const response = await fetch("/api/git/hunk/discard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: hunk.projectId,
          sessionId: hunk.sessionId,
          repositoryId: hunk.repositoryId,
          path: hunk.path,
          hunkIndex: hunk.hunkIndex,
          hunkDigest: hunk.hunkDigest,
          expectedSnapshotDigest: hunk.expectedSnapshotDigest,
          expectedStaged: hunk.expectedStaged,
        }),
      });
      if (!response.ok) throw new Error(tr("editorview.ideHunkRevertFailed", { status: response.status }));
      setGitHunk(null);
      announceFilesChanged({ projectId: hunk.projectId, sessionId: hunk.sessionId, repositoryId: hunk.repositoryId, path: hunk.path, source: "user" });
    } catch (error) {
      setTreeErr(msg(error));
    }
  };

  // ---- quick open: results follow the query as it is typed ------------------
  const search = async (text: string) => {
    const request = ++searchRequest.current;
    if (!projectId || !text.trim()) {
      setSearching(false);
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const hits = await api.filesSearch(projectId, text.trim(), SEARCH_LIMIT, sid, activeRepositoryId ?? undefined);
      if (request !== searchRequest.current) return;
      setSearchResults(hits);
      setTreeErr("");
    } catch (err) {
      if (request !== searchRequest.current) return;
      setTreeErr(msg(err));
    } finally {
      if (request === searchRequest.current) setSearching(false);
    }
  };
  useEffect(() => {
    if (!query.trim()) {
      searchRequest.current += 1;
      setSearching(false);
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(() => void search(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, projectId, sid, activeRepositoryId]);
  const clearSearch = () => {
    searchRequest.current += 1;
    setQuery("");
    setSearching(false);
    setSearchResults(null);
  };

  // ---- upload / download ---------------------------------------------------------
  const runUpload = async (dir: string, files: File[], repositoryId: string) => {
    if (!projectId || files.length === 0) return;
    const folder = dir || tr("filetree.root");
    setTreeErr("");
    setUploadStatus({ text: tr("filetree.uploading", { done: 0, total: files.length }), busy: true });
    try {
      const outcome = await uploadIntoFolder({
        projectId,
        sessionId: sessionId ?? null,
        repositoryId,
        dir,
        files,
        reasons: {
          tooLarge: tr("filetree.uploadTooLarge", { limit: formatSize(MAX_UPLOAD_BYTES) }),
          isFolder: tr("filetree.uploadIsFolder"),
          invalidName: tr("filetree.uploadInvalidName"),
        },
        confirmReplace: (names) => confirmAlert(
          tr("filetree.replaceBody", { names: names.join(", "), folder }),
          { title: tr("filetree.replaceTitle"), confirmLabel: tr("filetree.replace") },
        ),
        onProgress: (done, total) => setUploadStatus({ text: tr("filetree.uploading", { done, total }), busy: true }),
      });
      if (outcome.uploaded.length > 0) {
        setTreeRefreshToken((value) => value + 1);
        announceFilesChanged({ projectId, sessionId, repositoryId, path: outcome.uploaded[0], source: "user" });
      }
      if (outcome.failed.length > 0) {
        setTreeErr(outcome.failed.map((entry) => `${entry.name}: ${entry.reason}`).join("; "));
      }
      setUploadStatus(outcome.uploaded.length > 0
        ? { text: tr("filetree.uploaded", { count: outcome.uploaded.length, folder }), busy: false }
        : null);
    } catch (error) {
      setUploadStatus(null);
      setTreeErr(msg(error));
    }
  };
  useEffect(() => {
    if (!uploadStatus || uploadStatus.busy) return;
    const timer = setTimeout(() => setUploadStatus(null), 3_500);
    return () => clearTimeout(timer);
  }, [uploadStatus]);
  const pickUpload = (dir: string, repositoryId: string) => {
    uploadTargetRef.current = { dir, repositoryId };
    uploadInputRef.current?.click();
  };
  const downloadPath = (fp: string, repositoryId: string) => {
    if (!projectId) return;
    triggerDownload(downloadUrl(projectId, fp, sessionId ?? null, repositoryId), baseOf(fp));
  };

  // ---- desktop files dropped anywhere on Files -------------------------------
  // The tree resolves its own drops (the folder under the pointer, spring-
  // loaded folders). Everywhere else is handled here in the capture phase, so
  // the editor surface never receives the files as text.
  const windowDropTarget = (target: EventTarget | null): WindowDrop | null => {
    const element = target instanceof Element ? target : null;
    if (!element || element.closest(".ft-tree")) return null;
    const fallbackRepositoryId = activeRepositoryId ?? primaryRepository;
    if (element.closest(".editor-tree")) {
      const row = element.closest<HTMLElement>("[data-drop-dir]");
      return { dir: row?.dataset.dropDir ?? "", repositoryId: fallbackRepositoryId, zone: "side" };
    }
    const tabRepositoryId = activeTab?.repositoryId ?? primaryRepository;
    if (activePath && readyRepositories.some((repository) => repository.repositoryId === tabRepositoryId)) {
      return { dir: parentDir(activePath), repositoryId: tabRepositoryId, zone: "pane" };
    }
    return { dir: "", repositoryId: fallbackRepositoryId, zone: "pane" };
  };
  const resetWindowDrop = () => {
    windowDragDepth.current = 0;
    setWindowDrop(null);
  };
  useEffect(() => {
    if (!windowDrop) return;
    window.addEventListener("dragend", resetWindowDrop);
    window.addEventListener("drop", resetWindowDrop);
    return () => {
      window.removeEventListener("dragend", resetWindowDrop);
      window.removeEventListener("drop", resetWindowDrop);
    };
  }, [windowDrop !== null]);
  const windowDropHandlers = {
    onDragEnterCapture: (event: DragEvent) => {
      if (dragKind(event.dataTransfer) === "files") windowDragDepth.current += 1;
    },
    onDragLeaveCapture: (event: DragEvent) => {
      if (dragKind(event.dataTransfer) !== "files") return;
      windowDragDepth.current = Math.max(0, windowDragDepth.current - 1);
      if (windowDragDepth.current === 0) setWindowDrop(null);
    },
    onDragOverCapture: (event: DragEvent) => {
      if (!projectId || dragKind(event.dataTransfer) !== "files") return;
      const next = windowDropTarget(event.target);
      if (!next) {
        setWindowDrop((current) => current === null ? current : null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setWindowDrop((current) => current && current.dir === next.dir && current.repositoryId === next.repositoryId && current.zone === next.zone ? current : next);
    },
    onDropCapture: (event: DragEvent) => {
      if (!projectId || dragKind(event.dataTransfer) !== "files") return;
      const next = windowDropTarget(event.target);
      resetWindowDrop();
      if (!next) return; // the tree uploads into the folder under the pointer
      event.preventDefault();
      event.stopPropagation();
      const files = [...event.dataTransfer.files];
      if (files.length > 0) void runUpload(next.dir, files, next.repositoryId);
    },
  };
  const windowDropLabel = windowDrop
    ? tr("filetree.dropToUpload", {
        folder: `${readyRepositories.length > 1 ? `${repositories.find((repository) => repository.repositoryId === windowDrop.repositoryId)?.alias ?? windowDrop.repositoryId}: ` : ""}${windowDrop.dir || tr("filetree.root")}`,
      })
    : "";

  // ---- chat inserts ----------------------------------------------------------
  const attachPath = async (fp: string, repositoryId: string) => {
    if (!projectId) return;
    const alias = repositories.find((repository) => repository.repositoryId === repositoryId)?.alias;
    const displayName = repositories.length > 1 && alias ? `${alias} · ${baseOf(fp)}` : baseOf(fp);
    const result = await attachProjectFile(projectId, sessionId, fp, undefined, undefined, undefined, displayName, repositoryId);
    if (!result.ok) setTreeErr(result.reason);
  };

  // ---- tree context menu actions ------------------------------------------------
  /** Rename/move one entry; an open document follows its file. */
  const movePath = async (entry: FileEntry, to: string, repositoryId: string): Promise<boolean> => {
    if (!projectId) return false;
    try {
      if (!entry.dir && peekFileDoc(projectId, sessionId, entry.path, repositoryId)) {
        await renameDoc(projectId, sessionId, entry.path, to, repositoryId);
      } else {
        await api.filesRename(projectId, entry.path, to, sid, repositoryId);
      }
      if (!entry.dir) paneRef.current?.rename("file", entry.path, to, baseOf(to), repositoryId);
      setTreeRefreshToken((value) => value + 1);
      announceFilesChanged({ projectId, sessionId, repositoryId, path: to, source: "user" });
      return true;
    } catch (err) {
      setTreeErr(msg(err));
      return false;
    }
  };

  const ctxRename = async (entry: FileEntry, repositoryId: string) => {
    if (!projectId) return;
    const to = (await promptAlert(tr("editorview.renameOrMoveThisItem"), { title: tr("editorview.renameMoveTitle"), initialValue: entry.path, confirmLabel: tr("common.rename") }))?.trim();
    if (!to || to === entry.path) return;
    await movePath(entry, to, repositoryId);
  };

  /** A tree row dropped on another folder: one confirmation, then a move. */
  const moveEntry = async (entry: FileEntry, toDir: string, repositoryId: string) => {
    if (!projectId) return;
    if (!entry.dir && isDocDirty(projectId, sessionId, entry.path, repositoryId)) {
      setTreeErr(tr("filetree.moveUnsaved", { name: entry.name }));
      return;
    }
    const folder = toDir || tr("filetree.root");
    if (!await confirmAlert(tr("filetree.moveBody", { name: entry.name, folder }), { title: tr("filetree.moveTitle"), confirmLabel: tr("filetree.move") })) return;
    const to = toDir ? `${toDir}/${entry.name}` : entry.name;
    setTreeErr("");
    if (await movePath(entry, to, repositoryId)) {
      setUploadStatus({ text: tr("filetree.moved", { name: entry.name, folder }), busy: false });
    }
  };

  const archiveRefusalText = (reason: ArchiveRefusal, path?: string): string => {
    if (reason === "empty") return tr("filetree.zipEmpty");
    if (reason === "too-many") return tr("filetree.zipTooMany");
    if (reason === "file-too-large") return tr("filetree.zipFileTooLarge", { path: path ?? "" });
    return tr("filetree.zipTooLarge");
  };
  /** Folder → .zip of what the tree shows of it (hidden/ignored follow the tree). */
  const downloadFolder = async (dir: string, repositoryId: string) => {
    if (!projectId) return;
    const scope = {
      projectId,
      sessionId: sessionId ?? null,
      repositoryId,
      dir,
      hidden: effectiveTreePrefs.showHidden,
      skipIgnored: effectiveTreePrefs.hideIgnored,
    };
    setTreeErr("");
    setUploadStatus({ text: tr("filetree.zipPreparing"), busy: true });
    try {
      const check = await checkArchive(scope);
      if (check.refusal) {
        setUploadStatus(null);
        setTreeErr(archiveRefusalText(check.refusal.reason, check.refusal.path));
        return;
      }
      triggerDownload(archiveUrl(scope), `${check.name}.zip`);
      setUploadStatus({ text: tr("filetree.zipStarted", { count: check.files, size: formatSize(check.bytes) }), busy: false });
    } catch (error) {
      setUploadStatus(null);
      setTreeErr(msg(error));
    }
  };

  const ctxDelete = async (entry: FileEntry, repositoryId: string) => {
    if (!projectId) return;
    if (!await confirmAlert(tr("editorview.deleteValueValue", { path: entry.path, value: entry.dir ? tr("editorview.andItsContents") : "" }), { title: tr("editorview.deleteItem"), confirmLabel: tr("common.delete") })) return;
    try {
      if (!entry.dir && projectId && peekFileDoc(projectId, sessionId, entry.path, repositoryId)) {
        await removeDoc(projectId, sessionId, entry.path, repositoryId);
      } else {
        await api.filesDelete(projectId, entry.path, sid, repositoryId);
      }
      if (!entry.dir) paneRef.current?.close("file", entry.path, { force: true, repositoryId });
    } catch (err) {
      setTreeErr(msg(err));
    }
  };

  const ctxNew = async (dirPath: string, kind: "file" | "folder", repositoryId: string) => {
    if (!projectId) return;
    const name = (await promptAlert(tr("editorview.enterTheNewValueName", { kind: kind }), { title: tr("editorview.newValue", { kind: kind }), confirmLabel: tr("common.create") }))?.trim();
    if (!name) return;
    const rel = dirPath ? `${dirPath}/${name}` : name;
    try {
      if (kind === "folder") await api.filesMkdir(projectId, rel, sid, repositoryId);
      else await api.filesWrite(projectId, rel, "", undefined, sid, repositoryId);
      if (kind === "file") openFile(rel, repositoryId);
    } catch (err) {
      setTreeErr(msg(err));
    }
  };

  const revealNative = async (entry: FileEntry, repositoryId: string) => {
    const desktop = desktopBridge();
    const root = repositories.find((repository) => repository.repositoryId === repositoryId)?.path
      ?? session?.worktreePath ?? project?.path;
    if (!desktop || !root || project?.remote) return;
    const separator = root.includes("\\") ? "\\" : "/";
    if (!safeRelativeResourcePath(entry.path)) return;
    const absolute = `${root.replace(/[\\/]$/, "")}${separator}${entry.path.replaceAll("/", separator)}`;
    try {
      if (entry.dir) await desktop.openPath(absolute);
      else await desktop.revealPath(absolute);
    } catch (error) {
      setTreeErr(msg(error));
    }
  };

  const primaryRepository = primaryRepositoryId ?? "primary";
  const repositoryLabels = Object.fromEntries([
    ...repositories.map((repository) => [repository.repositoryId, repository.alias] as const),
    ...(primaryRepository !== "primary" && repositories.some((repository) => repository.repositoryId === primaryRepository)
      ? [["primary", repositories.find((repository) => repository.repositoryId === primaryRepository)!.alias] as const]
      : []),
  ]);
  const updateTreePrefs = (patch: Partial<FilesTreePrefs>) => {
    setTreePrefs((current) => ({ ...current, ...patch }));
    setTreeRefreshToken((value) => value + 1);
  };
  const rootRepositoryId = activeRepositoryId ?? primaryRepository;
  const sortLabels: Record<TreeSortMode, string> = {
    name: tr("filetree.sort.name"),
    modified: tr("filetree.sort.modified"),
    size: tr("filetree.sort.size"),
  };
  const treeMenuEntries: MenuEntry[] = [
    { id: "new-file", label: tr("editorview.newFile"), icon: FileIcon, onSelect: () => void ctxNew("", "file", rootRepositoryId) },
    { id: "new-folder", label: tr("editorview.newFolder"), icon: FolderIcon, onSelect: () => void ctxNew("", "folder", rootRepositoryId) },
    { id: "upload", label: tr("filetree.upload"), icon: UploadIcon, onSelect: () => pickUpload("", rootRepositoryId) },
    { id: "download-zip", label: tr("filetree.downloadZip"), icon: DownloadIcon, onSelect: () => void downloadFolder("", rootRepositoryId) },
    "separator",
    { heading: tr("filetree.viewAs") },
    { id: "view-tree", label: tr("filetree.view.tree"), icon: TreeViewIcon, kind: "radio", checked: effectiveTreePrefs.view === "tree", onSelect: () => setTreePrefs((current) => ({ ...current, view: "tree" })) },
    { id: "view-list", label: tr("filetree.view.list"), icon: ListViewIcon, kind: "radio", checked: effectiveTreePrefs.view === "list", onSelect: () => setTreePrefs((current) => ({ ...current, view: "list" })) },
    "separator",
    { heading: tr("filetree.sortBy") },
    ...(["name", "modified", "size"] as const).map((mode): MenuEntry => ({
      id: `sort-${mode}`,
      label: sortLabels[mode],
      kind: "radio",
      checked: effectiveTreePrefs.sort === mode,
      onSelect: () => setTreePrefs((current) => ({ ...current, sort: mode })),
    })),
    "separator",
    { id: "hidden", label: tr("filetree.showHidden"), kind: "checkbox", checked: effectiveTreePrefs.showHidden, onSelect: () => updateTreePrefs({ showHidden: !effectiveTreePrefs.showHidden }) },
    { id: "ignored", label: tr("filetree.hideIgnored"), kind: "checkbox", checked: effectiveTreePrefs.hideIgnored, onSelect: () => updateTreePrefs({ hideIgnored: !effectiveTreePrefs.hideIgnored }) },
    { id: "changed", label: tr("filetree.changedOnly"), kind: "checkbox", checked: effectiveTreePrefs.changedOnly, onSelect: () => updateTreePrefs({ changedOnly: !effectiveTreePrefs.changedOnly }) },
    ...(effectiveTreePrefs.view === "tree" ? [
      { id: "reveal", label: tr("filetree.autoReveal"), kind: "checkbox", checked: effectiveTreePrefs.autoReveal, onSelect: () => updateTreePrefs({ autoReveal: !effectiveTreePrefs.autoReveal }) },
      "separator",
      { id: "collapse", label: tr("filetree.collapseAll"), icon: CollapseIcon, onSelect: () => setTreeCollapseToken((value) => value + 1) },
    ] satisfies MenuEntry[] : ["separator" as const]),
    { id: "refresh", label: tr("filetree.refresh"), icon: RefreshIcon, onSelect: () => setTreeRefreshToken((value) => value + 1) },
  ];
  const onTreeContextMenu = (event: MouseEvent, entry: FileEntry | null, repositoryId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setCtx({ x: event.clientX, y: event.clientY, entry, repositoryId });
  };

  // Escape with no open document closes the Files pane (non-terminal Escape
  // → the command path restores focus to the invoker). FilePane owns Escape
  // while a document is active.
  useEffect(() => {
    if (!visible) return;
    const h = (e: globalThis.KeyboardEvent) => {
      if (isImeComposing(e)) return;
      if (e.key !== "Escape") return;
      if (ctx) return; // the context menu's own Escape handler closes it
      if (activeTab === null) closeWorkspacePane();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [visible, ctx, activeTab]);

  if (!projectId) {
    return (
      <ProjectRequiredEmpty
        title={tr("editorview.noProjectSelected")}
        description={tr("editorview.openAProjectToBrowseAndEdit")}
      />
    );
  }

  return (
    <div className={`editor-view mobile-${mobileStage}${windowDrop ? " files-window-dragging" : ""}`} {...windowDropHandlers}>
      {/* Compact layouts show one surface at a time. This row is the single
          place the open file is named: the stage switch carries its title and
          the counter opens the open-files switcher (the tab strip is hidden). */}
      <div className="editor-mobile-tabs">
        <Tabs
          className="editor-stage-tabs"
          size="sm"
          label={tr("editorview.files")}
          value={mobileStage}
          tabs={[
            { id: "tree", label: tr("editorview.files") },
            { id: "editor", label: activeTab?.title ?? tr("common.edit"), disabled: activeTab === null },
          ]}
          onChange={(value) => setMobileStage(value as "tree" | "editor")}
        />
        {openTabCount > 1 && (
          <button
            type="button"
            className="editor-open-files"
            aria-haspopup="dialog"
            aria-label={`${tr("editorview.openFiles")} (${openTabCount})`}
            title={tr("editorview.openFiles")}
            onClick={() => paneRef.current?.showSwitcher()}
          >
            <span aria-hidden="true">{openTabCount > 99 ? "99+" : openTabCount}</span>
          </button>
        )}
      </div>
      <aside
        className="editor-tree"
        aria-label={tr("editorview.files")}
      >
        <WorkspaceSurfaceHeader
          className="files-toolbar"
          label={tr("editorview.files")}
          scope={readyRepositories.length > 1 ? (
            <RepositoryScopePicker
              mode="one"
              repositories={readyRepositories.map((repository) => ({ id: repository.repositoryId, alias: repository.alias, detail: repository.path }))}
              value={activeRepositoryId}
              onChange={setTreeRepositoryId}
              label={tr("editorview.repositoryLabel")}
            />
          ) : undefined}
          context={
            <span className="files-search-field">
              <TextInput
                ref={searchInputRef}
                uiSize="sm"
                enterKeyHint="search"
                placeholder={tr("editorview.searchFiles")}
                aria-label={tr("editorview.searchFiles2")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (isImeComposing(e)) return;
                  if (e.key === "Enter") {
                    // Quick open: Enter takes the best match once results follow the query.
                    const first = searchResults?.[0];
                    // Mod+Enter pins it, as in the command palette's quick open.
                    if (first && !searching && (e.metaKey || e.ctrlKey)) pinFile(first, activeRepositoryId ?? primaryRepository);
                    else if (first && !searching) openFile(first, activeRepositoryId ?? primaryRepository);
                    else void search(query);
                  } else if (e.key === "Escape" && query) {
                    e.stopPropagation();
                    clearSearch();
                  }
                }}
              />
              {query ? (
                <IconButton
                  className="files-search-icon"
                  icon={CloseIcon}
                  size="sm"
                  label={tr("filetree.clearSearch")}
                  onClick={() => { clearSearch(); searchInputRef.current?.focus(); }}
                />
              ) : (
                <IconButton
                  className="files-search-icon"
                  icon={SearchIcon}
                  size="sm"
                  label={tr("editorview.searchFiles2")}
                  onClick={() => searchInputRef.current?.focus()}
                />
              )}
            </span>
          }
          actions={<div className="files-toolbar-actions">
            <IconButton icon={RefreshIcon} size="sm" label={tr("editorview.refreshFiles")} onClick={() => setTreeRefreshToken((value) => value + 1)} />
            <Menu label={tr("editorview.filesOptions")} title={tr("editorview.filesOptions")} entries={treeMenuEntries} align="end">
              {(trigger) => <IconButton {...trigger} icon={MoreIcon} size="sm" label={tr("editorview.filesOptions")} />}
            </Menu>
          </div>}
        />
        {(workspace.error || treeErr) && <div className="form-error">{workspace.error || treeErr}</div>}
        {uploadStatus && (
          <div className={`files-upload-status${uploadStatus.busy ? " busy" : ""}`} role="status">
            {uploadStatus.busy ? <Spinner size="sm" /> : <Icon icon={UploadIcon} size="sm" />}
            <span>{uploadStatus.text}</span>
          </div>
        )}
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const target = uploadTargetRef.current;
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            uploadTargetRef.current = null;
            if (target && files.length > 0) void runUpload(target.dir, files, target.repositoryId);
          }}
        />
        {query.trim() && (searchResults !== null || searching) ? (
          <div className="files-list files-search-results" role="region" aria-label={tr("editorview.searchFiles2")}>
            <div className="files-search-head">
              <IconButton icon={BackIcon} size="sm" label={tr("editorview.backToTree")} onClick={clearSearch} />
              <span className="files-search-count" aria-live="polite">
                {searching && searchResults === null
                  ? tr("filetree.searching")
                  : tr("filetree.results", { count: searchResults?.length ?? 0 })}
              </span>
              {searching && <Spinner size="sm" />}
            </div>
            {searchResults !== null && searchResults.length === 0 && !searching && (
              <EmptyState
                title={tr("editorview.noMatches")}
                description={tr("editorview.searchFiles")}
              />
            )}
            {(searchResults ?? []).map((fp, index) => {
              const { name, dir } = splitPath(fp);
              return (
                <div key={fp} className={`files-row files-hit${index === 0 ? " files-hit--default" : ""}`}>
                  <button
                    className="files-row-main"
                    onClick={() => openFile(fp, activeRepositoryId ?? primaryRepository)}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      pinFile(fp, activeRepositoryId ?? primaryRepository);
                    }}
                    onContextMenu={(event) => onTreeContextMenu(event, { name, path: fp, dir: false }, activeRepositoryId ?? primaryRepository)}
                  >
                    <span className="files-file-icon ft-icon" data-ft={fileTypeKeyOf(name)} aria-hidden>
                      <FileTypeGlyph type={fileTypeKeyOf(name)} />
                    </span>
                    <span className="files-hit-text">
                      <span className="files-hit-name" dir="auto">
                        {matchSegments(name, query).map((segment, part) => segment.hit
                          ? <mark key={part}>{segment.text}</mark>
                          : <span key={part}>{segment.text}</span>)}
                      </span>
                      {dir && <span className="files-hit-dir" dir="auto">{dir}</span>}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="files-repository-trees">
            {effectiveTreePrefs.changedOnly && (
              <div className="ft-filter-bar">
                <span className="ft-filter-label">{tr("filetree.changedOnlyActive")}</span>
                <Button size="sm" variant="ghost" className="ft-filter-clear" onClick={() => updateTreePrefs({ changedOnly: false })}>
                  {tr("filetree.showAll")}
                </Button>
              </div>
            )}
            {showChangeOwners && (
              <ul className="files-change-legend" aria-label={tr("files.changes.legend")}>
                {changeSessions.map((entry) => (
                  <li key={entry.sessionId} className="files-change-legend-item" title={sessionLabel(entry)}>
                    <span className="files-change-dot" style={{ "--session-tone": sessionToneColor(entry.tone) } as CSSProperties} aria-hidden />
                    <span className="files-change-legend-name" dir="auto">{sessionLabel(entry)}</span>
                  </li>
                ))}
              </ul>
            )}
            {effectiveTreePrefs.view === "list" && activeRepository ? (
              <FlatFileList
                key={`${projectId}:${sessionId ?? "project"}:${activeRepository.repositoryId}:list`}
                projectId={projectId}
                sessionId={sessionId ?? null}
                repository={activeRepository}
                visible={visible}
                activePath={activeTab?.repositoryId === activeRepository.repositoryId || (!activeTab?.repositoryId && activeRepository.repositoryId === primaryRepository) ? activePath : null}
                showHidden={effectiveTreePrefs.showHidden}
                hideIgnored={effectiveTreePrefs.hideIgnored}
                changedOnly={effectiveTreePrefs.changedOnly}
                sort={effectiveTreePrefs.sort}
                refreshToken={treeRefreshToken}
                changes={changesByRepository.get(activeRepository.repositoryId)}
                onOpenFile={openFile}
                onPinFile={pinFile}
                onContextMenu={onTreeContextMenu}
              />
            ) : visibleRepositories.map((repository) => (
              <RepositoryTree
                key={`${projectId}:${sessionId ?? "project"}:${repository.repositoryId}`}
                projectId={projectId}
                sessionId={sessionId}
                repository={repository}
                storageNamespace={workspacePresentationKey("files.tree", projectId, sessionId)}
                visible={visible}
                activePath={activeTab?.repositoryId === repository.repositoryId ? activePath : null}
                revealToken={editorOpenRequest?.id}
                showHidden={effectiveTreePrefs.showHidden}
                hideIgnored={effectiveTreePrefs.hideIgnored}
                autoReveal={effectiveTreePrefs.autoReveal}
                refreshToken={treeRefreshToken}
                collapseToken={treeCollapseToken}
                status={repositoryStatus[repository.repositoryId]}
                changes={changesByRepository.get(repository.repositoryId)}
                changeSessions={showChangeOwners ? checkoutByRepository.get(repository.repositoryId)?.sessions : undefined}
                changedOnly={effectiveTreePrefs.changedOnly}
                sort={effectiveTreePrefs.sort}
                onUploadFiles={(dir, files, repositoryId) => void runUpload(dir, files, repositoryId)}
                onMoveEntry={(entry, toDir, repositoryId) => void moveEntry(entry, toDir, repositoryId)}
                compact={!showRepositorySections}
                onOpenFile={openFile}
                onPinFile={pinFile}
                onContextMenu={onTreeContextMenu}
                onFocusSearch={() => searchInputRef.current?.focus()}
              />
            ))}
          </div>
        )}
        {windowDrop?.zone === "side" && (
          <div className="ft-drop-hint files-side-drop-hint" role="status">{windowDropLabel}</div>
        )}
      </aside>

      <Menu
        key={ctx ? `${ctx.entry?.path ?? "root"}:${ctx.x}:${ctx.y}` : "closed"}
        label={ctx?.entry ? tr("filerowactions.actionsForValue", { path: ctx.entry.path }) : tr("editorview.files")}
        phonePresentation="sheet"
        open={ctx !== null}
        onOpenChange={(open) => { if (!open) setCtx(null); }}
        entries={ctx ? (ctx.entry ? ([
          ...(!ctx.entry.dir
            ? [{ id: "open", label: tr("common.open"), onSelect: () => openFile(ctx.entry!.path, ctx.repositoryId ?? primaryRepository) }]
            : []),
          { id: "chat", label: tr("editorview.addToChat"), onSelect: () => void attachPath(ctx.entry!.path, ctx.repositoryId ?? primaryRepository) },
          { id: "copy", label: tr("editorview.copyPath"), onSelect: () => void navigator.clipboard?.writeText(ctx.entry!.path) },
          ctx.entry.dir
            ? { id: "download-zip", label: tr("filetree.downloadZip"), icon: DownloadIcon, onSelect: () => void downloadFolder(ctx.entry!.path, ctx.repositoryId ?? primaryRepository) }
            : { id: "download", label: tr("filetree.download"), icon: DownloadIcon, onSelect: () => downloadPath(ctx.entry!.path, ctx.repositoryId ?? primaryRepository) },
          ...(desktopBridge() && !project?.remote
            ? [{
                id: "reveal",
                label: tr(ctx.entry.dir ? "editorview.openInFileManager" : "editorview.revealInFileManager"),
                onSelect: () => void revealNative(ctx.entry!, ctx.repositoryId ?? primaryRepository),
              }]
            : []),
          ...(ctx.entry.dir
            ? [
                { id: "new-file", label: tr("editorview.newFile"), onSelect: () => void ctxNew(ctx.entry!.path, "file", ctx.repositoryId ?? primaryRepository) },
                { id: "new-folder", label: tr("editorview.newFolder"), onSelect: () => void ctxNew(ctx.entry!.path, "folder", ctx.repositoryId ?? primaryRepository) },
                { id: "upload", label: tr("filetree.uploadHere"), icon: UploadIcon, onSelect: () => pickUpload(ctx.entry!.path, ctx.repositoryId ?? primaryRepository) },
              ]
            : []),
          { id: "rename", label: tr("editorview.renameMove"), onSelect: () => void ctxRename(ctx.entry!, ctx.repositoryId ?? primaryRepository) },
          { id: "delete", label: tr("editorview.delete"), danger: true, onSelect: () => void ctxDelete(ctx.entry!, ctx.repositoryId ?? primaryRepository) },
        ] satisfies MenuEntry[]) : [
          { id: "new-file", label: tr("editorview.newFile"), onSelect: () => void ctxNew("", "file", ctx.repositoryId ?? primaryRepository) },
          { id: "new-folder", label: tr("editorview.newFolder"), onSelect: () => void ctxNew("", "folder", ctx.repositoryId ?? primaryRepository) },
          { id: "upload", label: tr("filetree.upload"), icon: UploadIcon, onSelect: () => pickUpload("", ctx.repositoryId ?? primaryRepository) },
          { id: "download-zip", label: tr("filetree.downloadZip"), icon: DownloadIcon, onSelect: () => void downloadFolder("", ctx.repositoryId ?? primaryRepository) },
        ]) : []}
      >
        {(trigger) => (
          <ContextMenuAnchor
            trigger={trigger}
            className="files-ctx-anchor"
            hidden
            x={ctx?.x ?? 0}
            y={ctx?.y ?? 0}
          />
        )}
      </Menu>

      <Menu
        key={ideContext ? `ide-${ideContext.x}-${ideContext.y}` : "ide-closed"}
        label={tr("editorview.codeActions")}
        title={tr("editorview.codeActions")}
        phonePresentation="sheet"
        open={ideContext !== null}
        onOpenChange={(open) => { if (!open) setIdeContext(null); }}
        entries={ideContext ? [
          { id: "find", label: tr("editorview.findInFile"), detail: "⌘F", onSelect: () => window.dispatchEvent(new CustomEvent("polyth:editor-command", { detail: { action: "find", projectId: ideContext?.projectId, sessionId: ideContext?.sessionId, repositoryId: ideContext?.repositoryId, path: ideContext?.path } })) },
          { id: "definition", label: tr("editorview.goToDefinition"), detail: "F12", onSelect: () => void runIdeAction("definition") },
          { id: "peek", label: tr("editorview.idePeekDefinition"), onSelect: () => void runIdeAction("peek") },
          { id: "references", label: tr("editorview.findReferences"), onSelect: () => void runIdeAction("references") },
          { id: "rename", label: tr("editorview.renameSymbol"), onSelect: () => void runIdeAction("rename") },
          { id: "copy", label: tr("editorview.copySelection"), onSelect: () => void navigator.clipboard?.writeText(ideContext.selection) },
          { id: "ask", label: tr("editorview.askAboutSelection"), disabled: !ideContext.selection, onSelect: () => requestComposerInsert(`Explain this selection from @${ideContext.path}:\n\n${ideContext.selection}`) },
          { id: "attach", label: tr("editor.filepane.addSelectionToChat"), disabled: !ideContext.selection, onSelect: () => requestComposerInsert(formatSelectionChat(ideContext.path, ideContext.selection, ideContext.startLine ?? ideContext.position.line + 1, ideContext.endLine ?? ideContext.startLine ?? ideContext.position.line + 1)) },
        ] satisfies MenuEntry[] : []}
      >
        {(trigger) => (
          <ContextMenuAnchor
            trigger={trigger}
            className="editor-ide-ctx-anchor"
            hidden
            x={ideContext?.x ?? 0}
            y={ideContext?.y ?? 0}
          />
        )}
      </Menu>

      <ResponsiveOverlay
        open={idePeek !== null}
        onClose={() => { peekRequest.current += 1; setIdePeek(null); }}
        title={idePeek?.title ?? tr("editorview.ideDefinitions")}
        phone="sheet"
        dialogSize="lg"
        className="editor-ide-peek-overlay"
      >
        {idePeek && <div className="editor-ide-peek" role="document">
          <div className="editor-ide-peek-head">
            <strong>{idePeek.title}</strong>
          </div>
          <div className="editor-ide-peek-list">
            {idePeek.items.map((item, index) => {
              const key = `${item.repositoryId}:${item.path}:${item.range.start.line}:${index}`;
              const preview = idePeek.previews[key];
              const repository = readyRepositories.find((entry) => entry.repositoryId === item.repositoryId);
              return (
              <button
                className="editor-ide-peek-item"
                key={`${item.repositoryId}:${item.path}:${item.range.start.line}:${index}`}
                onClick={() => { openLanguageLocation(item); peekRequest.current += 1; setIdePeek(null); }}
              >
                <span className="editor-ide-peek-location">
                  <span>{repository?.alias ?? item.repositoryId} · {item.path}</span>
                  <small>:{item.range.start.line + 1}:{item.range.start.character + 1} · {tr("editorview.openFileLink")}</small>
                  {preview ? preview.error ? <small className="editor-ide-peek-error">{preview.error}</small> : preview.content ? <pre className="editor-ide-peek-code" data-start-line={preview.startLine + 1}>{preview.content}</pre> : <small>{tr("editorview.loadingPreview")}</small> : <small>{tr("editorview.loadingPreview")}</small>}
                </span>
              </button>
              );
            })}
          </div>
        </div>}
      </ResponsiveOverlay>

      {gitHunk && (
        <div className="editor-git-hunk" role="dialog" aria-label={tr("editorview.hunkChangesIn", { path: gitHunk.path })}>
          <div className="editor-git-hunk-head">
            <strong>{gitHunk.path}</strong>
            <span className="muted">{tr("editorview.hunkN", { n: gitHunk.hunkIndex + 1 })}</span>
            <IconButton icon={BackIcon} size="sm" label={tr("common.close")} onClick={() => setGitHunk(null)} />
          </div>
          {gitHunk.loading ? <div className="editor-git-hunk-loading">{tr("editorview.loadingDiff")}</div> : (
            <>
              <pre className="editor-git-hunk-diff">{gitHunk.diff || tr("editorview.noDiff")}</pre>
              <div className="editor-git-hunk-actions">
                <Button size="sm" variant="danger" disabled={!gitHunk.diff} onClick={() => void revertGitHunk()}>{tr("editorview.revertHunk")}</Button>
              </div>
            </>
          )}
        </div>
      )}

      <div
        className="editor-pane-drop"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(RESOURCE_MIME)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          const resource = getDragResource(event.dataTransfer);
          if (!resource || resource.projectId !== projectId || (resource.sessionId ?? null) !== (sessionId ?? null)) return;
          const repositoryId = resource.repositoryId ?? primaryRepository;
          if (!readyRepositories.some((repository) => repository.repositoryId === repositoryId)) return;
          event.preventDefault();
          setTreeRepositoryId(repositoryId);
          setMobileStage("editor");
          // A drop onto the widget is an in-card interaction, so an embedded
          // Files opens it in place. The generic `openResource` router is for
          // requests to go somewhere else, and it routes files by navigating.
          if (embedded && resource.scheme === "file") {
            openFileInPane(resource.locator, repositoryId, {
              preview: true,
              ...(resource.selection ? { location: { path: resource.locator, ...resource.selection } } : {}),
            });
            return;
          }
          openResource(resource, {
            preview: true,
            ...(resource.selection ? { selection: resource.selection } : {}),
          });
        }}
      >
        {windowDrop?.zone === "pane" && (
          <div className="files-window-drop" role="status">
            <div className="files-window-drop-card">
              <Icon icon={UploadIcon} size="xl" />
              <strong>{windowDropLabel}</strong>
              <span>{tr("filetree.dropHintTree")}</span>
            </div>
          </div>
        )}
        <PaneHost
          ref={paneRef}
          projectId={projectId}
          sessionId={sessionId}
          repositoryLabels={repositoryLabels}
          onActiveChange={onActiveChange}
          onTabCountChange={setOpenTabCount}
          switcherLabel={tr("editorview.openFiles")}
          emptyBody={
            <div className="editor-empty">
              <EmptyState
                title={tr("editorview.selectAFileToViewOrEdit")}
                description={`${tr("editorview.enterOpensAddsToChat")} ${MOD}${tr("editorview.lSendsASelectionToTheSession")}`}
              />
            </div>
          }
        />
      </div>
    </div>
  );
}

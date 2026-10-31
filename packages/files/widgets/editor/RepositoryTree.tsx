import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { api, type FileEntry } from "@polyth/session/web-api";
import type { WorkspaceRepository } from "@polyth/contracts/workspace";
import { dragKind, setDragResource } from "../../../../apps/web/src/dnd.ts";
import {
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventHasKey,
  projectPresentationEventProjectId,
} from "../../../../apps/web/src/projectPresentationSync.ts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import { EmptyState, FileDiffIcon, Icon } from "../../../../apps/web/src/components/ui/index.ts";
import { ChevronGlyph, FileTypeGlyph, FolderGlyph, fileTypeKeyOf } from "./fileTreeIcons.tsx";
import {
  ancestorPaths,
  beginTreeRequest,
  canMoveInto,
  isCurrentTreeRequest,
  readTreePrefs,
  treeScopeKey,
  writeTreePrefs,
} from "./treeState.ts";
import {
  changesKey,
  deletedChildren,
  deletedFolders,
  isVisibleWhenChangedOnly,
  rollupFolders,
  type SessionChange,
} from "./sessionChanges.ts";
import { sessionToneColor, type CheckoutSession } from "./checkoutEdits.ts";
import { changedByLabel } from "./sessionEditsStore.ts";
import { entryMeta, sortEntries, type TreeSortMode } from "./treeSort.ts";

interface Row {
  entry: FileEntry;
  depth: number;
  /** Deleted this session and gone from disk: shown struck through, not openable. */
  ghost?: boolean;
}

export interface RepositoryTreeProps {
  projectId: string;
  sessionId: string | null;
  repository: WorkspaceRepository;
  storageNamespace: string;
  visible: boolean;
  activePath: string | null;
  revealToken?: number;
  compact?: boolean;
  showHidden?: boolean;
  hideIgnored?: boolean;
  autoReveal?: boolean;
  refreshToken?: number;
  collapseToken?: number;
  status?: { branch: string | null; changes: number };
  /** Files this session wrote (repo-relative), see sessionChanges.ts; with
   *  `sessions` the chats that changed each one (checkoutEdits.ts). */
  changes?: ReadonlyMap<string, SessionChange & { sessions?: readonly string[] }>;
  /** Chats with changes here; set only when colours tell them apart. */
  changeSessions?: readonly CheckoutSession[];
  changedOnly?: boolean;
  /** Listing order; the row shows the value it is keyed on. */
  sort?: TreeSortMode;
  /** Desktop files dropped on the tree; `dir` is the folder under the pointer. */
  onUploadFiles?: (dir: string, files: File[], repositoryId: string) => void;
  /** A tree row dragged onto another folder of the same repository. */
  onMoveEntry?: (entry: FileEntry, toDir: string, repositoryId: string) => void;
  onOpenFile: (path: string, repositoryId: string) => void;
  onPinFile: (path: string, repositoryId: string) => void;
  onContextMenu: (event: MouseEvent, entry: FileEntry | null, repositoryId: string) => void;
  onFocusSearch: () => void;
}

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const baseOf = (path: string) => path.split("/").pop() ?? path;
const treeItemId = (repositoryId: string, path: string) =>
  `ft-item-${encodeURIComponent(repositoryId)}-${encodeURIComponent(path)}`;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const TREE_REFRESH_MS = 8_000;
const NO_CHANGES: ReadonlyMap<string, SessionChange & { sessions?: readonly string[] }> = new Map();
const MAX_OWNER_DOTS = 3;
interface ChangeMark { kind: SessionChange["kind"]; latestTurn: boolean; count?: number; owners?: readonly CheckoutSession[] }
const CHANGE_LABEL_KEY = {
  created: "filetree.created",
  modified: "filetree.modified",
  deleted: "filetree.deleted",
} as const;
const CHANGE_LETTER = { created: "A", modified: "M", deleted: "D" } as const;
/** A collapsed folder held under a drag this long opens (spring-loaded). */
const DRAG_EXPAND_MS = 650;

/** The row being dragged inside a tree. Drag data is unreadable until the
 *  drop, so the source of a move is remembered here from its dragstart. */
let treeDrag: { scope: string; entry: FileEntry } | null = null;


/** Neutral kind words: with several chats, "in this session" would be wrong. */
const CHANGE_KIND_KEY = {
  created: "files.changes.created",
  modified: "files.changes.modified",
  deleted: "files.changes.deleted",
} as const;

/** Spoken/tooltip text for a change mark: colour and the letter are never the only signal. */
function changeLabelOf(mark: ChangeMark, dir: boolean, ghost: boolean): string {
  const counted = dir && !ghost && mark.count !== undefined;
  const base = mark.owners
    ? counted ? tr("files.changes.changedCount", { count: mark.count! }) : tr(CHANGE_KIND_KEY[mark.kind])
    : counted ? tr("filetree.changedCount", { count: mark.count! }) : tr(CHANGE_LABEL_KEY[mark.kind]);
  const parts = [base];
  if (mark.latestTurn) parts.push(tr("filetree.latestTurn"));
  if (mark.owners?.length) parts.push(changedByLabel(mark.owners));
  return parts.join(" · ");
}

export default function RepositoryTree({
  projectId,
  sessionId,
  repository,
  storageNamespace,
  visible,
  activePath,
  revealToken,
  compact = false,
  showHidden = false,
  hideIgnored = true,
  autoReveal = true,
  refreshToken = 0,
  collapseToken = 0,
  status,
  changes = NO_CHANGES,
  changeSessions,
  changedOnly = false,
  sort = "name",
  onUploadFiles,
  onMoveEntry,
  onOpenFile,
  onPinFile,
  onContextMenu,
  onFocusSearch,
}: RepositoryTreeProps) {
  const folderChanges = useMemo(() => rollupFolders(changes), [changes]);
  // Which chats changed something under each folder (for its colour dots).
  const folderOwners = useMemo(() => {
    const result = new Map<string, Set<string>>();
    if (!changeSessions) return result;
    for (const [path, change] of changes) {
      const parts = path.split("/");
      parts.pop();
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        const owners = result.get(current) ?? new Set<string>();
        for (const sessionId of change.sessions ?? []) owners.add(sessionId);
        result.set(current, owners);
      }
    }
    return result;
  }, [changes, changeSessions]);
  const ownersOf = (sessionIds: Iterable<string> | undefined): readonly CheckoutSession[] | undefined => {
    if (!changeSessions || !sessionIds) return undefined;
    const ids = new Set(sessionIds);
    const owners = changeSessions.filter((entry) => ids.has(entry.sessionId));
    return owners.length > 0 ? owners : undefined;
  };
  const changedKey = useMemo(() => changesKey(changes), [changes]);
  const scope = useMemo(() => ({
    projectId,
    sessionId,
    repositoryId: repository.repositoryId,
    storageNamespace,
  }), [projectId, repository.repositoryId, sessionId, storageNamespace]);
  const scopeKey = treeScopeKey(scope);
  const [sectionOpen, setSectionOpen] = useState(compact);
  const [kids, setKids] = useState<Record<string, FileEntry[]>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [foldedChanged, setFoldedChanged] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [error, setError] = useState("");
  const [activityPath, setActivityPath] = useState<string | null>(null);
  /** Folder a drag would land in ("" = root): desktop files upload, a tree
   *  row moves. Null while nothing droppable is over the tree. */
  const [drop, setDrop] = useState<{ dir: string; mode: "upload" | "move" } | null>(null);
  const dropDir = drop?.dir ?? null;
  const springRef = useRef<{ path: string; timer: ReturnType<typeof setTimeout> | null }>({ path: "", timer: null });
  const treeRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const scopeKeyRef = useRef("");
  const prefsReadyRef = useRef(false);
  const restoredOpenRef = useRef<string[]>([]);
  const restoredScopeRef = useRef("");
  const pendingRevealRef = useRef<string | null>(null);
  const revealedPathRef = useRef<string | null>(null);
  const loadingDirsRef = useRef(new Map<string, Promise<void>>());
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; entry: FileEntry | null }>({ timer: null, entry: null });
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Loaded folders currently shown expanded (incl. changed-only auto-opens). */
  const visibleDirsRef = useRef<string[]>([]);

  useEffect(() => () => {
    if (longPressRef.current.timer) clearTimeout(longPressRef.current.timer);
    if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
    if (springRef.current.timer) clearTimeout(springRef.current.timer);
  }, []);
  // A drag that ends anywhere (Escape, a drop outside, leaving the window)
  // must not leave a highlighted folder behind.
  useEffect(() => {
    if (drop === null) return;
    const reset = () => {
      setDrop(null);
      if (springRef.current.timer) clearTimeout(springRef.current.timer);
      springRef.current = { path: "", timer: null };
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [drop !== null]);

  const loadDir = async (path: string): Promise<void> => {
    if (!visible || !sectionOpen) return;
    const requestKey = `${scopeKey}:${path}`;
    const existing = loadingDirsRef.current.get(requestKey);
    if (existing) return existing;
    const generation = generationRef.current;
    const token = beginTreeRequest(scope, generation);
    const request = (async () => {
      try {
        const entries = await api.filesTree(
          projectId,
          path || undefined,
          showHidden,
          sessionId ?? undefined,
          repository.repositoryId,
        );
        if (!isCurrentTreeRequest(token, scope, generationRef.current)) return;
        setKids((current) => ({ ...current, [path]: entries }));
        setError("");
      } catch (cause) {
        if (!isCurrentTreeRequest(token, scope, generationRef.current)) return;
        setError(messageOf(cause));
      }
    })();
    loadingDirsRef.current.set(requestKey, request);
    void request.finally(() => {
      if (loadingDirsRef.current.get(requestKey) === request) loadingDirsRef.current.delete(requestKey);
    });
    return request;
  };

  const restore = async (): Promise<void> => {
    if (!visible || !sectionOpen || restoredScopeRef.current === scopeKey) return;
    restoredScopeRef.current = scopeKey;
    await loadDir("");
    for (const path of restoredOpenRef.current) {
      if (!isCurrentTreeRequest(beginTreeRequest(scope, generationRef.current), scope, generationRef.current)) return;
      await loadDir(path);
    }
  };

  useEffect(() => {
    generationRef.current++;
    scopeKeyRef.current = scopeKey;
    restoredScopeRef.current = "";
    prefsReadyRef.current = false;
    const prefs = readTreePrefs(scope);
    restoredOpenRef.current = prefs.open;
    setSectionOpen(compact);
    setKids({});
    setOpen(new Set(prefs.open));
    setSelected(prefs.selected);
    setScrollTop(prefs.scrollTop);
    setError("");
    pendingRevealRef.current = null;
    revealedPathRef.current = null;
    setActivityPath(null);
    prefsReadyRef.current = true;
  }, [compact, scopeKey]);

  useEffect(() => {
    if (repository.state !== "ready" || !visible || !sectionOpen) return;
    void restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repository.state, sectionOpen, visible, scopeKey]);

  useEffect(() => {
    const onHydrated = (event: Event): void => {
      if (projectPresentationEventProjectId(event) !== projectId || !projectPresentationEventHasKey(event, "workspaceState")) return;
      const next = readTreePrefs(scope);
      setOpen((current) => current.size === next.open.length && next.open.every((id) => current.has(id)) ? current : new Set(next.open));
      setSelected((current) => current === next.selected ? current : next.selected);
      setScrollTop((current) => current === next.scrollTop ? current : next.scrollTop);
    };
    window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
    return () => window.removeEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
  }, [projectId, scope]);

  useEffect(() => {
    if (!prefsReadyRef.current || scopeKeyRef.current !== scopeKey) return;
    writeTreePrefs(scope, { open: [...open], selected, scrollTop });
  }, [open, scope, scopeKey, scrollTop, selected]);

  useEffect(() => {
    const tree = treeRef.current;
    if (!tree || !visible || !sectionOpen) return;
    tree.scrollTop = scrollTop;
  }, [sectionOpen, scopeKey, scrollTop, visible]);

  useEffect(() => {
    if (repository.state !== "ready" || !visible || !sectionOpen) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      for (const path of new Set(["", ...open, ...visibleDirsRef.current])) void loadDir(path);
    };
    const onFocus = () => refresh();
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    const onFilesChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; sessionId?: string | null; repositoryId?: string; path?: string; source?: string }>).detail;
      if (detail?.projectId && detail.projectId !== projectId) return;
      if (detail?.sessionId !== undefined && detail.sessionId !== sessionId) return;
      if (detail?.repositoryId && detail.repositoryId !== repository.repositoryId) return;
      if (detail?.path && detail.repositoryId === repository.repositoryId) {
        setActivityPath(detail.path);
        if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
        activityTimerRef.current = setTimeout(() => setActivityPath(null), 1600);
      }
      refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("polyth:files-changed", onFilesChanged);
    const timer = setInterval(refresh, TREE_REFRESH_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("polyth:files-changed", onFilesChanged);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repository.state, sectionOpen, visible, scopeKey]);

  const reveal = async (path: string): Promise<void> => {
    pendingRevealRef.current = path;
    if (!visible || repository.state !== "ready") return;
    if (!sectionOpen) {
      setSectionOpen(true);
      return;
    }
    const generation = generationRef.current;
    for (const directory of ancestorPaths(path)) {
      if (!isCurrentTreeRequest(beginTreeRequest(scope, generation), scope, generationRef.current)) return;
      setOpen((current) => current.has(directory) ? current : new Set([...current, directory]));
      if (!kids[directory]) await loadDir(directory);
    }
    if (!isCurrentTreeRequest(beginTreeRequest(scope, generation), scope, generationRef.current)) return;
    pendingRevealRef.current = null;
    revealedPathRef.current = path;
    requestAnimationFrame(() => {
      if (!visible || scopeKeyRef.current !== scopeKey) return;
      document.getElementById(treeItemId(repository.repositoryId, path))?.scrollIntoView({ block: "nearest" });
    });
  };

  useEffect(() => {
    if (!autoReveal || !activePath || activePath === revealedPathRef.current) return;
    pendingRevealRef.current = activePath;
  }, [activePath, autoReveal, revealToken, scopeKey]);

  useEffect(() => {
    const pending = pendingRevealRef.current;
    if (!autoReveal || !pending || !visible || repository.state !== "ready" || !sectionOpen) return;
    void reveal(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, autoReveal, repository.state, revealToken, sectionOpen, scopeKey, visible]);

  useEffect(() => {
    if (refreshToken === 0 || !visible || repository.state !== "ready" || !sectionOpen) return;
    for (const path of new Set(["", ...open, ...visibleDirsRef.current])) void loadDir(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  // A tool just wrote a file: pull the directories we show now instead of waiting for the poll.
  useEffect(() => {
    if (!changedKey || !visible || repository.state !== "ready" || !sectionOpen) return;
    for (const path of new Set(["", ...open, ...visibleDirsRef.current])) void loadDir(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedKey]);

  useEffect(() => {
    if (collapseToken === 0) return;
    setOpen(new Set());
    setSectionOpen(compact);
  }, [collapseToken, compact]);

  // Changed-only mode opens every folder with changes on its own; the user can
  // still fold one away for the rest of the filtered view.
  const autoOpen = (path: string) => changedOnly && folderChanges.has(path);
  const isExpanded = (path: string) => open.has(path) || (autoOpen(path) && !foldedChanged.has(path));
  useEffect(() => { setFoldedChanged(new Set()); }, [changedOnly, scopeKey]);

  const toggleDirectory = (path: string) => {
    if (autoOpen(path)) {
      const folding = isExpanded(path);
      setFoldedChanged((current) => {
        const next = new Set(current);
        if (folding) next.add(path);
        else next.delete(path);
        return next;
      });
      if (folding) setOpen((current) => {
        if (!current.has(path)) return current;
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }
    // A ghost folder is gone from disk: its rows come from the change map only.
    if (!open.has(path) && !kids[path] && !ghostDirs.has(path)) void loadDir(path);
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const rows: Row[] = [];
  // Expanded folders that exist on disk but whose listing is not loaded yet.
  const unloaded: string[] = [];
  const walk = (path: string, depth: number, ghostDir: boolean) => {
    const listed = kids[path];
    // Ghosts are placed only against a real listing (or inside a ghost folder),
    // so a folder still loading never flashes rows that are about to vanish.
    const known = listed ?? (ghostDir ? [] : null);
    const ghosts: FileEntry[] = known ? [
      ...deletedFolders(path, known, changes).map((ghostPath) => ({ name: baseOf(ghostPath), path: ghostPath, dir: true })),
      ...deletedChildren(path, known, changes).map((ghostPath) => ({ name: baseOf(ghostPath), path: ghostPath, dir: false })),
    ] : [];
    for (const entry of [...sortEntries(listed ?? [], sort), ...ghosts]) {
      const ghost = ghosts.includes(entry);
      if (!ghost && ((!showHidden && entry.name.startsWith(".")) || (hideIgnored && entry.ignored))) continue;
      if (changedOnly && !isVisibleWhenChangedOnly(entry.path, entry.dir, changes, folderChanges)) continue;
      rows.push({ entry, depth, ghost });
      if (!entry.dir || !isExpanded(entry.path)) continue;
      if (!ghost && !kids[entry.path]) unloaded.push(entry.path);
      walk(entry.path, depth + 1, ghost);
    }
  };
  walk("", 0, false);
  const unloadedKey = unloaded.join("\0");
  const ghostDirs = new Set(rows.filter((row) => row.ghost && row.entry.dir).map((row) => row.entry.path));
  visibleDirsRef.current = ["", ...rows.filter((row) => row.entry.dir && !row.ghost && isExpanded(row.entry.path)).map((row) => row.entry.path)];

  useEffect(() => {
    if (!unloadedKey || !visible || repository.state !== "ready" || !sectionOpen) return;
    for (const path of unloaded) void loadDir(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unloadedKey, visible, repository.state, sectionOpen]);
  const markOf = (entry: FileEntry): ChangeMark | null => {
    if (entry.dir) {
      const folder = folderChanges.get(entry.path);
      if (!folder) return null;
      const owners = ownersOf(folderOwners.get(entry.path));
      return { kind: folder.deletedOnly ? "deleted" : "modified", latestTurn: folder.latestTurn, count: folder.count, ...(owners ? { owners } : {}) };
    }
    const change = changes.get(entry.path);
    if (!change) return null;
    const owners = ownersOf(change.sessions);
    return { kind: change.kind, latestTurn: change.latestTurn, ...(owners ? { owners } : {}) };
  };

  const selectRow = (path: string) => {
    setSelected(path);
    document.getElementById(treeItemId(repository.repositoryId, path))?.scrollIntoView({ block: "nearest" });
  };

  const onTreeKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      onFocusSearch();
      return;
    }
    const index = rows.findIndex((row) => row.entry.path === selected);
    const current = rows[index]?.entry;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = rows[event.key === "ArrowDown" ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0)];
      if (next) selectRow(next.entry.path);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const edge = rows[event.key === "Home" ? 0 : rows.length - 1];
      if (edge) selectRow(edge.entry.path);
    } else if (event.key === "ArrowRight" && current?.dir) {
      event.preventDefault();
      if (!isExpanded(current.path)) toggleDirectory(current.path);
      else if (rows[index + 1] && parentOf(rows[index + 1]!.entry.path) === current.path) selectRow(rows[index + 1]!.entry.path);
    } else if (event.key === "ArrowLeft" && current) {
      event.preventDefault();
      if (current.dir && isExpanded(current.path)) toggleDirectory(current.path);
      else if (parentOf(current.path)) selectRow(parentOf(current.path));
    } else if (event.key === "Enter" && current) {
      if (current.dir) toggleDirectory(current.path);
      else if (!rows[index]?.ghost) onOpenFile(current.path, repository.repositoryId);
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const row = current ? document.getElementById(treeItemId(repository.repositoryId, current.path)) : null;
      const rect = row?.getBoundingClientRect();
      onContextMenu({
        preventDefault: () => {},
        stopPropagation: () => {},
        clientX: rect?.left ?? 0,
        clientY: rect?.top ?? 0,
      } as MouseEvent, current ?? null, repository.repositoryId);
    }
  };

  const clearLongPress = () => {
    if (longPressRef.current.timer) clearTimeout(longPressRef.current.timer);
    longPressRef.current.timer = null;
    longPressRef.current.entry = null;
  };

  const dropTargetOf = (target: EventTarget | null): string => {
    const row = target instanceof Element ? target.closest<HTMLElement>('[role="treeitem"]') : null;
    const path = row?.dataset.path;
    if (path === undefined) return "";
    return row?.dataset.dir === "true" ? path : parentOf(path);
  };
  const acceptsFiles = (event: { dataTransfer: DataTransfer | null }) =>
    Boolean(onUploadFiles) && event.dataTransfer !== null && dragKind(event.dataTransfer) === "files";
  /** The tree row being dragged, when it belongs to this tree's checkout. */
  const movingEntry = (): FileEntry | null =>
    onMoveEntry && treeDrag && treeDrag.scope === scopeKey ? treeDrag.entry : null;
  /** Spring-loaded folders: hovering a closed folder during a drag opens it,
   *  so a deep target is reachable without letting go. */
  const springOpen = (target: EventTarget | null) => {
    const row = target instanceof Element ? target.closest<HTMLElement>('[role="treeitem"]') : null;
    const path = row?.dataset.dir === "true" ? row.dataset.path ?? "" : "";
    if (springRef.current.path === path) return;
    if (springRef.current.timer) clearTimeout(springRef.current.timer);
    springRef.current = {
      path,
      timer: path && !isExpanded(path)
        ? setTimeout(() => { springRef.current.timer = null; if (!isExpanded(path)) toggleDirectory(path); }, DRAG_EXPAND_MS)
        : null,
    };
  };
  const endDrag = () => {
    setDrop(null);
    if (springRef.current.timer) clearTimeout(springRef.current.timer);
    springRef.current = { path: "", timer: null };
  };
  const now = Date.now();

  const sectionLabel = repository.state === "ready" ? repository.alias : `${repository.alias} (Unavailable)`;
  return (
    <section className={`files-repository-panel${compact ? " compact" : ""}`}>
      {!compact && (
        <button
          type="button"
          className="files-repository-heading"
          aria-expanded={sectionOpen}
          onClick={() => setSectionOpen((value) => !value)}
          disabled={repository.state !== "ready"}
        >
          <span className={`files-repository-chevron${sectionOpen ? " open" : ""}`} aria-hidden>▸</span>
          <span>{sectionLabel}</span>
          {status?.branch && <span className="files-repository-branch">{status.branch}</span>}
          {status && status.changes > 0 && <span className="files-repository-changes">•{status.changes}</span>}
          {repository.state !== "ready" && <span className="files-repository-state">{tr("filetree.unavailable")}</span>}
        </button>
      )}
      {error && sectionOpen && <div className="form-error">{error}</div>}
      {repository.state === "ready" && sectionOpen && changedOnly && rows.length === 0 && kids[""] && (
        <EmptyState variant="compact" mark={<Icon icon={FileDiffIcon} size="xl" />} title={tr("filetree.noChanges")} />
      )}
      {repository.state === "ready" && sectionOpen && (
        <div
          ref={treeRef}
          className={`ft-tree${dropDir === "" ? " ft-drop-root" : ""}`}
          role="tree"
          aria-label={compact ? tr("editorview.projectFiles") : `${repository.alias} ${tr("editorview.projectFiles")}`}
          tabIndex={0}
          onKeyDown={onTreeKeyDown}
          onContextMenu={(event) => {
            if ((event.target as HTMLElement).closest('[role="treeitem"]')) return;
            event.preventDefault();
            onContextMenu(event, null, repository.repositoryId);
          }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          onDragOver={(event) => {
            const moving = movingEntry();
            if (!moving && !acceptsFiles(event)) return;
            const next = dropTargetOf(event.target);
            springOpen(event.target);
            if (moving && !canMoveInto(moving, next)) {
              event.dataTransfer.dropEffect = "none";
              setDrop(null);
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = moving ? "move" : "copy";
            const mode = moving ? "move" as const : "upload" as const;
            setDrop((current) => current?.dir === next && current.mode === mode ? current : { dir: next, mode });
          }}
          onDragLeave={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            endDrag();
          }}
          onDrop={(event) => {
            const moving = movingEntry();
            const dir = dropTargetOf(event.target);
            if (moving) {
              event.preventDefault();
              event.stopPropagation();
              endDrag();
              treeDrag = null;
              if (canMoveInto(moving, dir)) onMoveEntry?.(moving, dir, repository.repositoryId);
              return;
            }
            if (!acceptsFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            const files = [...event.dataTransfer.files];
            endDrag();
            if (files.length > 0) onUploadFiles?.(dir, files, repository.repositoryId);
          }}
          aria-activedescendant={selected ? treeItemId(repository.repositoryId, selected) : undefined}
        >
          {rows.map(({ entry, depth, ghost }) => {
            const selectedRow = selected === entry.path;
            const active = activePath === entry.path;
            const mark = markOf(entry);
            const expanded = entry.dir && isExpanded(entry.path);
            const changeLabel = mark ? changeLabelOf(mark, entry.dir, Boolean(ghost)) : "";
            const ignored = Boolean(entry.ignored);
            const meta = ghost ? null : entryMeta(entry, sort, now);
            return (
              <div
                key={entry.path}
                id={treeItemId(repository.repositoryId, entry.path)}
                role="treeitem"
                aria-level={depth + 1}
                aria-selected={selectedRow}
                {...(entry.dir ? { "aria-expanded": expanded } : {})}
                {...(changeLabel ? { title: changeLabel } : {})}
                data-path={entry.path}
                data-dir={entry.dir ? "true" : undefined}
                className={`ft-row${entry.dir ? " ft-dir" : ""}${dropDir !== null && dropDir !== "" && dropDir === entry.path ? " ft-drop-target" : ""}${ignored ? " ft-ignored" : ""}${selectedRow ? " ft-selected" : ""}${active ? " ft-open" : ""}${activityPath === entry.path ? " ft-activity" : ""}${mark ? ` ft-changed ft-changed-${mark.kind}${mark.latestTurn ? " ft-changed-recent" : ""}` : ""}${ghost ? " ft-ghost" : ""}`}
                style={{ "--ft-depth": String(depth) } as CSSProperties}
                draggable={!ghost}
                onDragStart={(event) => {
                  clearLongPress();
                  setDragResource(event.dataTransfer, { scheme: "file", projectId, sessionId, repositoryId: repository.repositoryId, locator: entry.path }, undefined, entry.dir ? { kind: "directory" } : undefined);
                  // Copy keeps chat/editor drops working; move is this tree's own.
                  event.dataTransfer.effectAllowed = "copyMove";
                  treeDrag = { scope: scopeKey, entry };
                }}
                onDragEnd={() => {
                  if (treeDrag?.entry === entry) treeDrag = null;
                  endDrag();
                }}
                onPointerDown={(event) => {
                  if (event.pointerType === "mouse" && event.button !== 0) return;
                  clearLongPress();
                  if (ghost) return;
                  longPressRef.current.entry = entry;
                  longPressRef.current.timer = setTimeout(() => {
                    const rect = document.getElementById(treeItemId(repository.repositoryId, entry.path))?.getBoundingClientRect();
                    selectRow(entry.path);
                    onContextMenu({
                      preventDefault: () => {},
                      stopPropagation: () => {},
                      clientX: rect?.left ?? 0,
                      clientY: rect?.top ?? 0,
                    } as MouseEvent, entry, repository.repositoryId);
                    clearLongPress();
                  }, 520);
                }}
                onPointerUp={clearLongPress}
                onPointerCancel={clearLongPress}
                onPointerLeave={clearLongPress}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  selectRow(entry.path);
                  if (ghost) return; // gone from disk: no file actions apply
                  onContextMenu(event, entry, repository.repositoryId);
                }}
                onClick={() => {
                  selectRow(entry.path);
                  if (entry.dir) toggleDirectory(entry.path);
                  else if (!ghost) onOpenFile(entry.path, repository.repositoryId);
                }}
                onDoubleClick={(event) => {
                  if (entry.dir || ghost) return;
                  event.preventDefault();
                  onPinFile(entry.path, repository.repositoryId);
                }}
              >
                <span className={`ft-chevron${expanded ? " open" : ""}`} aria-hidden>
                  {entry.dir && <ChevronGlyph />}
                </span>
                <span
                  className={`ft-icon${expanded ? " open" : ""}`}
                  data-ft={entry.dir ? "folder" : fileTypeKeyOf(entry.name)}
                  aria-hidden
                >
                  {entry.dir ? <FolderGlyph open={expanded} /> : <FileTypeGlyph type={fileTypeKeyOf(entry.name)} />}
                </span>
                <span className="ft-name" dir="auto">{entry.name}</span>
                {meta && <span className="ft-meta">{meta}</span>}
                {mark && (
                  <>
                    {mark.owners && (
                      <span className="ft-change-owners" aria-hidden>
                        {mark.owners.slice(0, MAX_OWNER_DOTS).map((owner) => (
                          <span key={owner.sessionId} className="ft-change-owner" style={{ "--session-tone": sessionToneColor(owner.tone) } as CSSProperties} />
                        ))}
                      </span>
                    )}
                    <span className="ft-change-badge" data-kind={mark.kind} data-recent={mark.latestTurn || undefined} aria-hidden>
                      {mark.count !== undefined ? (mark.count > 999 ? "999+" : mark.count) : CHANGE_LETTER[mark.kind]}
                    </span>
                    <span className="sr-only">{`, ${changeLabel}`}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {drop !== null && sectionOpen && (
        <div className="ft-drop-hint" role="status">
          {tr(drop.mode === "move" ? "filetree.dropToMove" : "filetree.dropToUpload", { folder: drop.dir || tr("filetree.root") })}
        </div>
      )}
    </section>
  );
}

export { treeItemId };

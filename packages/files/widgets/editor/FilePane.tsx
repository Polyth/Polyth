// ONE file document's lifecycle —
// read, edit, preview, revision-guarded save/autosave, IME pause, conflict,
// external replacement, deletion, Reload/Overwrite/Recreate/Retry — behind
// the "file" pane provider. Live text lives in the editor runtime (pull
// model); this pane is chrome + preview. Keep-alive (hidden, inert) is
// PaneHost; revision polling pauses while hidden.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api } from "@polyth/session/web-api";
import { resolveWorkspaceContext } from "@polyth/contracts/workspace";
import { clearEditorLocation, useStore } from "../../../../apps/web/src/store.ts";
import { MarkdownDoc } from "../../../../apps/web/src/markdown.tsx";
import JsonTree, { tryParseJson } from "../../../../apps/web/src/markdown/JsonTree.tsx";
import { highlightLines, langOf } from "../../../../apps/web/src/highlight.ts";
import { formatSelectionChat } from "../../../../apps/web/src/chatclip.ts";
import { attachProjectFile } from "../../../../apps/web/src/attachments.ts";
import { requestComposerInsert } from "../../../../apps/web/src/composerInsert.ts";
import { MOD } from "../../../../apps/web/src/format.ts";
import { clampMenuPosition } from "../../../../apps/web/src/selectionActions.ts";
import { copyText } from "../../../../apps/web/src/utils.ts";
import { getEditorPrefs, setEditorPreviewDefault, useUiSettings } from "../../../../apps/web/src/uiPrefs.ts";
import { confirmAlert } from "../../../../apps/web/src/alerts.ts";
import {
  EditorSurfaceSlot,
  readEditorSelection,
  replaceEditorSelection,
  resourceViewsVersion,
  subscribeResourceViews,
  type EditorChangeSet,
  type EditorChangeTone,
} from "../../../../apps/web/src/resources/views.ts";
import {
  deleteDoc, docsVersion, fileResourceRef, installDocUnloadGuard,
  isDocDirty, openFileDoc, peekFileDoc, removeDoc, renameDoc, subscribeDocs,
} from "./fileDocs.ts";
import {
  AssistIcon,
  Button,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  EditIcon,
  IconButton,
  Menu,
  MoreIcon,
  Spinner,
  Tabs,
  TextInput,
  TreeViewIcon,
  type MenuEntry,
} from "../../../../apps/web/src/components/ui/index.ts";
import { attributeChanges, type AttributedHunk } from "./changeAttribution.ts";
import ImageViewer from "./ImageViewer.tsx";
import CsvPreview from "./CsvPreview.tsx";
import SymbolsPanel from "./SymbolsPanel.tsx";
import { extractSymbols, hasOutline, type FileSymbol } from "./outline.ts";
import { downloadUrl, triggerDownload } from "./uploads.ts";
import { sessionToneColor, type CheckoutSession } from "./checkoutEdits.ts";
import {
  changedByLabel,
  checkoutEditsVersion,
  checkoutScopeKey,
  checkoutTabMarker,
  keepHunks,
  keptHunks,
  sessionLabel,
  subscribeCheckoutEdits,
  useCheckoutFile,
} from "./sessionEditsStore.ts";
import { useOpenSessionEdits } from "../workbenchHints.ts";
import {
  htmlPreviewDocument,
  initialPreviewVisible,
  previewKindForPath,
} from "../../../../apps/web/src/resources/liveFile.ts";
import { registerPaneProvider, type PaneResourceContext } from "../../../../apps/web/src/workspace/paneProviders.ts";
import { usePaneActions } from "../../../../apps/web/src/components/workspace/PaneHost.tsx";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import { useShellMode } from "../../../../apps/web/src/responsiveShell.ts";
import EmptyState from "../../../../apps/web/src/components/EmptyState.tsx";
import { ContextMenuAnchor } from "./contextMenuAnchor.tsx";
import { isImeComposing } from "@polyth/web-sdk";

const baseOf = (p: string) => p.split("/").pop() ?? p;
/** "⌘L" on Apple platforms, "Ctrl+L" elsewhere. */
const shortcut = (key: string) => (MOD === "⌘" ? `⌘${key}` : `${MOD}+${key}`);
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** Above this many lines, fall back to a plain block (no per-line rows). */
const MAX_ROWED_LINES = 8000;
const FILE_REFRESH_MS = 8_000;

/** SVG renders as an image: scripts and network loads never run from it. */
const svgDataUrl = (text: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;

type MediaKind = "image" | "audio" | "video" | "pdf";
/** Mirrors the server's RAW_MIME allowlist: binary files of these kinds are
 *  viewable in the pane through /api/files/raw instead of an empty buffer. */
const MEDIA_EXT: Record<string, MediaKind> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image",
  ".webp": "image", ".avif": "image", ".bmp": "image", ".ico": "image",
  ".mp4": "video", ".m4v": "video", ".mov": "video", ".ogv": "video", ".webm": "video",
  ".aac": "audio", ".flac": "audio", ".m4a": "audio", ".mp3": "audio",
  ".oga": "audio", ".ogg": "audio", ".wav": "audio", ".weba": "audio",
  ".pdf": "pdf",
};
const mediaKindOf = (path: string): MediaKind | null => {
  const ext = path.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  return MEDIA_EXT[ext] ?? null;
};

/** Coordinators (tree, git) listen for this to refresh after file ops. */
export interface FilesChangedDetail {
  projectId?: string;
  sessionId?: string | null;
  repositoryId?: string;
  path?: string;
  source?: "user" | "activity";
}

export function announceFilesChanged(detail: FilesChangedDetail = {}): void {
  window.dispatchEvent(new CustomEvent<FilesChangedDetail>("polyth:files-changed", { detail }));
}

const FILES_GROUP_ID = "files";

interface GitFileDiff { diff: string; snapshotDigest: string }

/** The file's working-tree diff against the index (what Undo discards). */
async function fetchFileDiff(projectId: string, sessionId: string | null, repositoryId: string | undefined, path: string): Promise<GitFileDiff | null> {
  const query = new URLSearchParams({ projectId, path, ...(sessionId ? { sessionId } : {}), ...(repositoryId ? { repositoryId } : {}) });
  const response = await fetch(`/api/git/diff?${query}`);
  if (!response.ok) return null;
  const body = await response.json() as { diff?: unknown; snapshotDigest?: unknown };
  return typeof body.diff === "string" && typeof body.snapshotDigest === "string"
    ? { diff: body.diff, snapshotDigest: body.snapshotDigest }
    : null;
}

interface ChangeReview {
  set: EditorChangeSet;
  hunks: readonly AttributedHunk[];
  /** Chats that own at least one shown change, in colour order. */
  owners: readonly CheckoutSession[];
  unattributed: boolean;
}

/** Turn attributed hunks into the editor's change set (tones are per file). */
function changeReview(
  hunks: readonly AttributedHunk[],
  sessions: readonly CheckoutSession[],
  baseText: string,
  snapshotDigest: string,
  onAction: NonNullable<EditorChangeSet["onAction"]>,
): ChangeReview {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const tones: EditorChangeTone[] = [];
  const toneIndex = new Map<string, number>();
  const owners = new Map<string, CheckoutSession>();
  let unattributed = false;
  const toneOf = (owner: string | null): number => {
    const session = owner ? byId.get(owner) : undefined;
    const key = session?.sessionId ?? "";
    const known = toneIndex.get(key);
    if (known !== undefined) return known;
    toneIndex.set(key, tones.length);
    tones.push(session
      ? { color: sessionToneColor(session.tone), label: changedByLabel([session]), attributed: true }
      : { color: sessionToneColor(-1), label: tr("files.changes.notFromChat"), attributed: false });
    return tones.length - 1;
  };
  const note = (owner: string | null) => {
    const session = owner ? byId.get(owner) : undefined;
    if (session) owners.set(session.sessionId, session);
    else unattributed = true;
  };
  const editorHunks = hunks.map((hunk) => {
    const hunkOwners = new Map<string, CheckoutSession>();
    let plain = false;
    const lines = hunk.lines.map((entry) => {
      note(entry.owner);
      const session = entry.owner ? byId.get(entry.owner) : undefined;
      if (session) hunkOwners.set(session.sessionId, session); else plain = true;
      return { line: entry.line, tone: toneOf(entry.owner) };
    });
    const removed = hunk.removed.map((block) => {
      note(block.owner);
      const session = block.owner ? byId.get(block.owner) : undefined;
      if (session) hunkOwners.set(session.sessionId, session); else plain = true;
      return { line: block.line, text: block.text, tone: toneOf(block.owner) };
    });
    const labels = [
      ...(hunkOwners.size > 0 ? [changedByLabel([...hunkOwners.values()].sort((left, right) => left.tone - right.tone))] : []),
      ...(plain ? [tr("files.changes.notFromChat")] : []),
    ];
    return {
      id: `${hunk.index}:${hunk.digest}`,
      lines,
      removed,
      anchorLine: hunk.anchorLine,
      label: labels.join(" · "),
      // A change no chat made keeps the plain Git gutter: no Undo/Keep chips.
      ...(hunkOwners.size === 0 ? { plain: true } : {}),
    };
  });
  const signature = editorHunks.map((hunk) =>
    `${hunk.id}:${hunk.lines.map((entry) => `${entry.line}.${entry.tone}`).join(",")}:${hunk.removed.map((block) => `${block.line}.${block.tone}`).join(",")}`).join(";");
  return {
    set: {
      key: `${snapshotDigest}|${tones.map((tone) => `${tone.color}=${tone.label}`).join(",")}|${signature}`,
      baseText,
      tones,
      hunks: editorHunks,
      actions: { undo: tr("files.changes.undo"), keep: tr("files.changes.keep"), inspect: tr("files.changes.inspect") },
      labels: { moreRemoved: tr("files.changes.moreRemoved") },
      onAction,
    },
    hunks,
    owners: [...owners.values()].sort((left, right) => left.tone - right.tone),
    unattributed,
  };
}

export default function FilePane({ projectId, sessionId, repositoryId, resource: path, visible }: PaneResourceContext) {
  const sid = sessionId ?? undefined;
  const project = useStore((s) => s.projectRegistry.projects.find((candidate) => candidate.id === projectId));
  const session = useStore((s) => s.sessions.find((candidate) => candidate.id === sessionId));
  const repositoryContext = useMemo(() => {
    if (!project) return { primaryRepositoryId: "primary", alias: null as string | null, count: 0 };
    try {
      const context = resolveWorkspaceContext(project, session ?? null);
      const primary = project.primaryRepositoryId
        ?? context.repositories.find((candidate) => candidate.path === project.path)?.repositoryId
        ?? (context.repositories.length === 1 ? context.repositories[0]?.repositoryId : "primary");
      return {
        primaryRepositoryId: primary ?? "primary",
        alias: context.repositories.find((candidate) => candidate.repositoryId === repositoryId)?.alias ?? null,
        count: context.repositories.length,
      };
    } catch {
      return { primaryRepositoryId: "primary", alias: null as string | null, count: 0 };
    }
  }, [project, repositoryId, session]);
  const resourceRef = useMemo(() => fileResourceRef(projectId, sessionId, path, repositoryId), [projectId, sessionId, repositoryId, path]);
  const inlineRequest = useRef(0);
  const inlineStatusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    inlineRequest.current += 1;
    return () => {
      inlineRequest.current += 1;
      if (inlineStatusTimer.current) clearTimeout(inlineStatusTimer.current);
    };
  }, [projectId, sessionId, repositoryId, path, visible]);
  const prefs = useUiSettings();
  const location = useStore((s) => s.editorLocation);
  const editorRepositoryId = useStore((s) => s.editorRepositoryId);
  const actions = usePaneActions();
  // Touch layouts have no right-click, so the file actions get a visible
  // trigger there; wide layouts keep the trimmed toolbar + context menu.
  const touchLayout = useShellMode() !== "wide";
  useSyncExternalStore(subscribeDocs, docsVersion);
  useSyncExternalStore(subscribeResourceViews, resourceViewsVersion);

  useEffect(() => {
    if (!visible) return;
    void openFileDoc(projectId, sessionId, path, repositoryId).load();
  }, [visible, projectId, sessionId, repositoryId, path]);

  const td = peekFileDoc(projectId, sessionId, path, repositoryId);
  const snap = td?.handle.getSnapshot() ?? {
    status: "idle" as const,
    saved: "",
    dirty: false,
    readOnly: false,
    truncated: false,
    binary: false,
    live: null,
    error: "",
    composing: false,
    saveCount: 0,
    authoritativeGeneration: 0,
  };
  const doc = td?.doc ?? null;
  const editing = td?.editing ?? true;
  const error = td?.error ?? "";
  const live = snap.live;
  const dirty = snap.dirty;
  const readOnly = snap.readOnly;
  // Preview/read views need the live text; edit mode must not toString per render.
  const previewText = !editing && td ? td.handle.getBuffer() : "";

  const [wrap, setWrap] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [opError, setOpError] = useState("");
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [hlRange, setHlRange] = useState<[number, number] | null>(null);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoVal, setGotoVal] = useState("");
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number } | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
    text: string;
    startLine: number;
    endLine: number;
  } | null>(null);
  const [explainPanel, setExplainPanel] = useState<{
    x: number;
    y: number;
    text: string;
    loading: boolean;
    error: string;
  } | null>(null);
  const [inlineStatus, setInlineStatus] = useState("");
  const [symbols, setSymbols] = useState<FileSymbol[] | null>(null);
  const symbolsAnchorRef = useRef<HTMLSpanElement>(null);
  const [reveal, setReveal] = useState<{ startLine: number; endLine: number } | null>(null);

  // ---- chat change highlighting ------------------------------------------------
  // Git says what changed (working tree against the index), the checkout's
  // edit model says which chat wrote it; the editor draws the result.
  const followEdits = useOpenSessionEdits();
  const checkoutKey = checkoutScopeKey(projectId, sessionId, repositoryId);
  const checkout = useCheckoutFile(checkoutKey, path);
  const editsVersion = useSyncExternalStore(subscribeCheckoutEdits, checkoutEditsVersion);
  const [gitDiff, setGitDiff] = useState<(GitFileDiff & { scope: string }) | null>(null);
  const [diffToken, setDiffToken] = useState(0);
  const [hunkCursor, setHunkCursor] = useState(-1);
  const diffScope = `${checkoutKey}\0${path}`;
  const wantsDiff = visible && editing && snap.status === "ready" && !readOnly && !snap.binary && !snap.truncated;
  useEffect(() => {
    if (!wantsDiff) return;
    let cancelled = false;
    void fetchFileDiff(projectId, sessionId, repositoryId, path)
      .then((result) => { if (!cancelled) setGitDiff(result ? { ...result, scope: diffScope } : null); })
      .catch(() => { if (!cancelled) setGitDiff(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsDiff, diffScope, snap.authoritativeGeneration, snap.saveCount, checkout.file?.seq, checkout.file?.edits.length, diffToken]);
  // A chat (or a person elsewhere) wrote this file: look again now instead of
  // waiting for the poll.
  useEffect(() => {
    if (!visible) return;
    const onFilesChanged = (event: Event) => {
      const detail = (event as CustomEvent<FilesChangedDetail>).detail;
      if (!detail?.path || detail.path !== path) return;
      if (detail.projectId && detail.projectId !== projectId) return;
      if (detail.repositoryId && repositoryId && detail.repositoryId !== repositoryId) return;
      void peekFileDoc(projectId, sessionId, path, repositoryId)?.handle.check();
      setDiffToken((value) => value + 1);
    };
    window.addEventListener("polyth:files-changed", onFilesChanged);
    return () => window.removeEventListener("polyth:files-changed", onFilesChanged);
  }, [visible, projectId, sessionId, repositoryId, path]);
  // A chat just edited this file (the live model saw its tool finish, or the
  // server reported it): compare with the disk now instead of at the next poll.
  // Handles are fresh objects per read, so effects key on the document key.
  const docKey = td?.handle.key ?? null;
  const editSeq = checkout.file?.seq;
  useEffect(() => {
    if (!visible || editSeq === undefined || !docKey) return;
    void peekFileDoc(projectId, sessionId, path, repositoryId)?.handle.check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, editSeq, docKey]);
  // IDE mode follows the agent: a clean editor shows what is on disk now.
  const reloading = useRef(false);
  useEffect(() => {
    if (!followEdits || !docKey || live?.kind !== "external-change" || dirty || reloading.current) return;
    const handle = peekFileDoc(projectId, sessionId, path, repositoryId)?.handle;
    if (!handle) return;
    reloading.current = true;
    void handle.reload().finally(() => { reloading.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followEdits, docKey, live?.kind, dirty]);
  const kept = useMemo(
    () => keptHunks(projectId, sessionId, repositoryId, path),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, sessionId, repositoryId, path, editsVersion],
  );
  const changeActionRef = useRef<NonNullable<EditorChangeSet["onAction"]>>(() => {});
  const onChangeAction = useCallback<NonNullable<EditorChangeSet["onAction"]>>((hunkId, action) => changeActionRef.current(hunkId, action), []);
  const lastReview = useRef<ChangeReview | null>(null);
  const review = useMemo<ChangeReview | null>(() => {
    if (!gitDiff || gitDiff.scope !== diffScope || snap.status !== "ready") return null;
    const hunks = attributeChanges({ text: snap.saved, diff: gitDiff.diff, edits: checkout.file?.edits ?? [], accepted: kept });
    // The disk moved ahead of the loaded text (a reload is on its way): the
    // marks drawn for the loaded text are still the truth for what is shown.
    if (hunks === null) {
      const previous = lastReview.current;
      return previous && previous.set.baseText === snap.saved ? previous : null;
    }
    if (hunks.length === 0) return null;
    return changeReview(hunks, checkout.sessions, snap.saved, gitDiff.snapshotDigest, onChangeAction);
  }, [gitDiff, diffScope, snap.status, snap.saved, checkout.file, checkout.sessions, kept, onChangeAction]);
  useEffect(() => { lastReview.current = review; }, [review]);
  useEffect(() => { setHunkCursor(-1); }, [diffScope]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const [modeArmed, setModeArmed] = useState(false);

  useEffect(() => { installDocUnloadGuard(); }, []);

  useEffect(() => {
    if (modeArmed || snap.status !== "ready" || !td) return;
    const canEdit = !snap.truncated && !snap.binary;
    const prefsNow = getEditorPrefs();
    td.editing = canEdit && !initialPreviewVisible(path, prefsNow.openInPreview, prefsNow.previewByKind);
    setModeArmed(true);
  }, [modeArmed, path, snap.status, snap.truncated, snap.binary, td]);

  useEffect(() => {
    if (!visible || !doc || !location || location.path !== doc.path || editorRepositoryId !== (repositoryId ?? null)) return;
    if (location.startLine !== undefined) {
      gotoLine(location.startLine, location.endLine);
    }
    clearEditorLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, doc, location, editorRepositoryId, repositoryId]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 1800);
    return () => clearTimeout(t);
  }, [flash]);

  const setPreviewMode = (on: boolean, opts: { persist?: boolean } = {}) => {
    if (!doc || readOnly || !td) return;
    td.editing = !on;
    setSelectionMenu(null);
    setExplainPanel(null);
    const kind = previewKindForPath(doc.path);
    if (opts.persist !== false && kind) setEditorPreviewDefault(kind, on);
  };

  const gotoLine = (start: number, end?: number) => {
    const last = end !== undefined && end >= start ? end : start;
    if (doc && !readOnly && td && !td.editing) setPreviewMode(false, { persist: false });
    setHlRange([start, last]);
    setReveal({ startLine: start, endLine: last });
  };

  const insertToChat = (text: string) => {
    requestComposerInsert(text);
    setFlash(tr("editor.filepane.flashAdded"));
  };

  const addSelection = async (knownSelection?: { text: string; startLine: number; endLine: number }) => {
    if (!doc) return;
    if (editing) {
      const sel = readEditorSelection(resourceRef);
      if (!sel) {
        setFlash(tr("editor.filepane.flashSelectFirst"));
        return;
      }
      if (dirty) {
        insertToChat(formatSelectionChat(doc.path, sel.text, sel.startLine, sel.endLine));
      } else {
        const result = await attachProjectFile(projectId, sessionId, doc.path, [sel.startLine, sel.endLine], undefined, undefined, baseOf(doc.path), repositoryId);
        if (result.ok) setFlash(tr("editor.filepane.flashAddedSelection")); else setFlash(result.reason);
      }
      return;
    }
    if (knownSelection) {
      if (dirty) {
        insertToChat(formatSelectionChat(doc.path, knownSelection.text, knownSelection.startLine, knownSelection.endLine));
        return;
      }
      const result = await attachProjectFile(projectId, sessionId, doc.path, [knownSelection.startLine, knownSelection.endLine], undefined, undefined, baseOf(doc.path), repositoryId);
      if (result.ok) setFlash(tr("editor.filepane.flashAddedSelection")); else setFlash(result.reason);
      return;
    }
    const s = window.getSelection();
    const container = bodyRef.current;
    if (!s || s.isCollapsed || s.rangeCount === 0 || !container) {
      setFlash(tr("editor.filepane.flashSelectFirst"));
      return;
    }
    const range = s.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setFlash(tr("editor.filepane.flashSelectFirst"));
      return;
    }
    const lnOf = (node: Node | null): number | null => {
      const el = node instanceof Element ? node : node?.parentElement ?? null;
      const row = el?.closest("[data-ln]");
      const n = row ? Number(row.getAttribute("data-ln")) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const text = s.toString().replace(/\n$/, "");
    if (!text) return;
    const a = lnOf(range.startContainer) ?? 1;
    const b = lnOf(range.endContainer) ?? a;
    const startLine = Math.min(a, b);
    const endLine = Math.max(a, b);
    const result = await attachProjectFile(projectId, sessionId, doc.path, [startLine, endLine], undefined, undefined, baseOf(doc.path), repositoryId);
    if (result.ok) setFlash(tr("editor.filepane.flashAddedSelection")); else setFlash(result.reason);
  };

  const addFile = async () => {
    if (!doc) return;
    const result = await attachProjectFile(projectId, sessionId, doc.path, undefined, undefined, undefined, baseOf(doc.path), repositoryId);
    if (result.ok) setFlash(tr("editor.filepane.flashAddedFile")); else setFlash(result.reason);
  };

  const previewSelection = (): { text: string; startLine: number; endLine: number } | null => {
    const s = window.getSelection();
    const container = bodyRef.current;
    if (!s || s.isCollapsed || s.rangeCount === 0 || !container) return null;
    const range = s.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return null;
    const lnOf = (node: Node | null): number | null => {
      const el = node instanceof Element ? node : node?.parentElement ?? null;
      const row = el?.closest("[data-ln]");
      const n = row ? Number(row.getAttribute("data-ln")) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const text = s.toString().replace(/\n$/, "");
    if (!text) return null;
    const a = lnOf(range.startContainer) ?? 1;
    const b = lnOf(range.endContainer) ?? a;
    return { text, startLine: Math.min(a, b), endLine: Math.max(a, b) };
  };

  const currentSelection = (): { text: string; startLine: number; endLine: number } | null => {
    if (editing) {
      const sel = readEditorSelection(resourceRef);
      return sel?.text ? sel : null;
    }
    return previewSelection();
  };

  const openFileActionsMenu = (x: number, y: number) => {
    setFileMenu({ x, y });
    setSelectionMenu(null);
  };

  const openSelectionMenu = (x: number, y: number, sel: { text: string; startLine: number; endLine: number }) => {
    setSelectionMenu({ x, y, ...sel });
    setFileMenu(null);
  };

  const onSurfaceContextMenu = (e: { preventDefault(): void; clientX: number; clientY: number }) => {
    e.preventDefault();
    const sel = currentSelection();
    if (sel) openSelectionMenu(e.clientX, e.clientY, sel);
    else openFileActionsMenu(e.clientX, e.clientY);
  };

  const onSurfaceMouseUp = (e: { button: number; clientX: number; clientY: number }) => {
    if (e.button !== 0) return;
    const { clientX, clientY } = e;
    const reveal = () => {
      const sel = currentSelection();
      if (sel) openSelectionMenu(clientX, clientY, sel);
      else setSelectionMenu(null);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(reveal);
    else reveal();
  };

  const surfaceInteract = {
    onContextMenu: onSurfaceContextMenu,
    onMouseUp: onSurfaceMouseUp,
  };

  const runExplain = async (sel: { text: string; startLine: number; endLine: number }, anchor: { x: number; y: number }) => {
    const request = ++inlineRequest.current;
    setSelectionMenu(null);
    setExplainPanel({
      ...clampMenuPosition(anchor.x, anchor.y, 320, 240, window.innerWidth, window.innerHeight),
      text: "",
      loading: true,
      error: "",
    });
    try {
      const { text } = await api.filesInlineAi({
        action: "explain",
        projectId,
        path: doc?.path ?? path,
        selection: sel.text,
        language: langOf(doc?.path ?? path),
        ...(sid ? { sessionId: sid } : {}),
        ...(repositoryId ? { repositoryId } : {}),
      });
      if (request !== inlineRequest.current) return;
      setExplainPanel((panel) => panel ? { ...panel, text, loading: false } : null);
    } catch (err) {
      if (request !== inlineRequest.current) return;
      setExplainPanel((panel) => panel ? {
        ...panel,
        loading: false,
        error: msg(err),
      } : null);
    }
  };

  const runFix = async (sel: { text: string }) => {
    const request = ++inlineRequest.current;
    setSelectionMenu(null);
    setInlineStatus(tr("editor.filepane.fixing"));
    try {
      const { text } = await api.filesInlineAi({
        action: "fix",
        projectId,
        path: doc?.path ?? path,
        selection: sel.text,
        language: langOf(doc?.path ?? path),
        ...(sid ? { sessionId: sid } : {}),
        ...(repositoryId ? { repositoryId } : {}),
      });
      if (request !== inlineRequest.current) return;
      const applied = editing
        ? replaceEditorSelection(resourceRef, text.trim(), sel.text)
        : false;
      setInlineStatus(applied ? tr("editor.filepane.fixApplied") : tr("editor.filepane.fixFailed"));
    } catch (err) {
      if (request !== inlineRequest.current) return;
      setInlineStatus(msg(err));
    }
    if (inlineStatusTimer.current) clearTimeout(inlineStatusTimer.current);
    inlineStatusTimer.current = setTimeout(() => { if (request === inlineRequest.current) setInlineStatus(""); }, 2400);
  };

  useEffect(() => {
    setSelectionMenu(null);
    setFileMenu(null);
    setExplainPanel(null);
  }, [visible, editing, repositoryId, path]);
  useEffect(() => { setSymbols(null); }, [visible, repositoryId, path]);

  /** The outline is read from the live buffer when asked for, never per render. */
  const openSymbols = () => {
    if (!td) return;
    setFileMenu(null);
    setSelectionMenu(null);
    setSymbols(extractSymbols(td.handle.getBuffer(), path));
  };
  const pickSymbol = (symbol: FileSymbol) => {
    setSymbols(null);
    // Rendered Markdown keeps its place: scroll to the matching heading.
    if (previewKind === "markdown" && !editing && symbol.kind === "heading") {
      const order = (symbols ?? []).filter((entry) => entry.kind === "heading").indexOf(symbol);
      const heading = bodyRef.current?.querySelectorAll("h1, h2, h3, h4, h5, h6")[order];
      if (heading) { heading.scrollIntoView({ block: "start" }); return; }
    }
    gotoLine(symbol.line);
  };

  const save = async (opts: { force?: boolean } = {}) => {
    if (!td) return;
    await td.handle.save(opts);
    if (td.handle.getSnapshot().live?.kind === "saved") setFlash(tr("editor.filepane.flashSaved"));
  };

  const dirtyRef = useRef(dirty);
  const readOnlyRef = useRef(readOnly);
  dirtyRef.current = dirty;
  readOnlyRef.current = readOnly;
  const saveRef = useRef(save);
  saveRef.current = save;
  const onEditorSave = useCallback(() => {
    if (dirtyRef.current && !readOnlyRef.current) void saveRef.current();
  }, []);
  const onRevealConsumed = useCallback(() => setReveal(null), []);

  const reload = async () => {
    if (!td) return;
    await td.handle.reload();
  };

  const checkFile = async () => {
    if (!td) return;
    await td.handle.check();
  };

  useEffect(() => {
    if (!visible) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void checkFile();
    };
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(refresh, FILE_REFRESH_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, projectId, sessionId, repositoryId, path]);

  const rename = async () => {
    const to = renameTo?.trim();
    if (!doc || !to || to === doc.path) {
      setRenameTo(null);
      return;
    }
    setBusy(true);
    try {
      await renameDoc(projectId, sessionId, doc.path, to, repositoryId);
      actions?.renameSelf("file", doc.path, to, baseOf(to), repositoryId);
      setRenameTo(null);
      announceFilesChanged({ projectId, sessionId, repositoryId, path: to, source: "user" });
    } catch (err) {
      setOpError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!doc) return;
    setBusy(true);
    try {
      await removeDoc(projectId, sessionId, doc.path, repositoryId);
      setConfirmDel(false);
      actions?.closeSelf("file", doc.path, repositoryId);
      announceFilesChanged({ projectId, sessionId, repositoryId, path: doc.path, source: "user" });
    } catch (err) {
      setOpError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!visible) return;
    const h = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !readOnly) void save();
      } else if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        addSelection();
      } else if (mod && e.key.toLowerCase() === "g" && doc) {
        e.preventDefault();
        setGotoOpen(true);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o" && doc && hasOutline(doc.path)) {
        e.preventDefault();
        openSymbols();
      } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
        const sel = currentSelection();
        if (sel) {
          e.preventDefault();
          const row = bodyRef.current?.getBoundingClientRect();
          openSelectionMenu(row ? row.left + 24 : 48, row ? row.top + 24 : 48, sel);
        } else {
          e.preventDefault();
          openFileActionsMenu(48, 48);
        }
      } else if (e.key === "Escape") {
        if (isImeComposing(e)) return;
        if (fileMenu || selectionMenu || symbols) return;
        if (explainPanel) { setExplainPanel(null); return; }
        if (gotoOpen) { setGotoOpen(false); return; }
        if (confirmDel) { setConfirmDel(false); return; }
        if (renameTo !== null) return;
        actions?.closeSelf("file", path, repositoryId);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const lang = doc ? langOf(doc.path) : "";
  const mediaKind = doc && doc.tooLarge ? mediaKindOf(doc.path) : null;
  const rawUrl = doc ? api.filesRawUrl(projectId, doc.path, sid, repositoryId) : "";
  const lines = useMemo(
    () => (doc && !editing ? highlightLines(previewText, lang) : []),
    [doc, editing, lang, previewText],
  );
  const previewKind = doc && !readOnly ? previewKindForPath(doc.path) : null;
  const previewName = previewKind === "json"
    ? tr("markdown.render.tree")
    : previewKind === "csv" ? tr("editor.filepane.table") : tr("previewview.preview");
  const jsonValue = useMemo(
    () => (previewKind === "json" && doc && !editing ? tryParseJson(previewText) : undefined),
    [previewKind, doc, editing, previewText],
  );
  const shownError = opError || error;

  // Inline Undo/Keep and the gutter bars act on the hunk they belong to.
  changeActionRef.current = (hunkId, action) => {
    const hunk = review?.hunks.find((entry) => `${entry.index}:${entry.digest}` === hunkId);
    if (!hunk || !gitDiff) return;
    if (action === "keep") {
      keepHunks(projectId, sessionId, repositoryId, path, [hunk.digest]);
      return;
    }
    const identity = {
      projectId,
      sessionId,
      path,
      hunkIndex: hunk.index,
      hunkDigest: hunk.digest,
      expectedSnapshotDigest: gitDiff.snapshotDigest,
      expectedStaged: false,
    };
    if (action === "inspect") {
      window.dispatchEvent(new CustomEvent("polyth:editor-git-hunk", {
        detail: { ...identity, repositoryId: repositoryId ?? repositoryContext.primaryRepositoryId },
      }));
      return;
    }
    if (isDocDirty(projectId, sessionId, path, repositoryId)) {
      setOpError(tr("files.changes.saveBeforeUndo"));
      return;
    }
    void (async () => {
      try {
        const response = await fetch("/api/git/hunk/discard", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...identity, ...(repositoryId ? { repositoryId } : {}) }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
          throw new Error(typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : tr("files.changes.undoFailed"));
        }
        setOpError("");
        await td?.handle.reload();
        setDiffToken((value) => value + 1);
        announceFilesChanged({ projectId, sessionId, repositoryId, path, source: "user" });
      } catch (err) {
        setOpError(msg(err));
      }
    })();
  };
  const goToChange = (direction: 1 | -1) => {
    if (!review) return;
    const count = review.hunks.length;
    const next = hunkCursor < 0 || hunkCursor >= count
      ? (direction === 1 ? 0 : count - 1)
      : (hunkCursor + direction + count) % count;
    setHunkCursor(next);
    const anchor = review.hunks[next]!.anchorLine;
    setReveal({ startLine: anchor, endLine: anchor });
  };
  const fileIndex = checkout.viewerFiles.indexOf(path);
  const goToFile = (direction: 1 | -1) => {
    const files = checkout.viewerFiles;
    if (files.length < 2) return;
    const target = files[fileIndex < 0 ? 0 : (fileIndex + direction + files.length) % files.length]!;
    window.dispatchEvent(new CustomEvent("polyth:editor-open", {
      detail: { projectId, sessionId, repositoryId: repositoryId ?? repositoryContext.primaryRepositoryId, path: target },
    }));
  };
  const keepAll = () => {
    if (review) keepHunks(projectId, sessionId, repositoryId, path, review.hunks.map((hunk) => hunk.digest));
  };
  const stopSurface = (event: { stopPropagation(): void }) => event.stopPropagation();

  if (!td || td.loading || (!doc && !shownError)) {
    return (
      <div className="editor-empty">
        <EmptyState
          title={tr("editor.filepane.loading")}
          description={`${path}…`}
          mark={<Spinner />}
        />
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="editor-empty">
        <EmptyState
          title={`${tr("editor.filepane.couldnTOpen")} ${path}.`}
          description={shownError}
        />
      </div>
    );
  }

  const showToolbar = previewKind !== null
    || touchLayout
    || live?.kind === "saving"
    || live?.kind === "saved"
    || !!flash
    || !!inlineStatus
    || gotoOpen
    || (!readOnly && dirty);

  const fileActionEntries: MenuEntry[] = [
    { id: "add-file", label: tr("editor.filepane.addFileToChat"), onSelect: () => void addFile() },
    { id: "add-selection", label: tr("editor.filepane.addSelectionToChat"), ...(touchLayout ? {} : { detail: shortcut("L") }), onSelect: () => void addSelection() },
    { id: "copy-path", label: tr("editor.filepane.copyPath"), onSelect: () => void copyText(doc.path) },
    ...(!snap.binary && !mediaKind && td
      ? [{ id: "copy-contents", label: tr("editor.filepane.copyContents"), onSelect: () => void copyText(td.handle.getBuffer()) } satisfies MenuEntry]
      : []),
    {
      id: "download",
      label: tr("editor.filepane.download"),
      onSelect: () => triggerDownload(downloadUrl(projectId, doc.path, sessionId ?? null, repositoryId), doc.path.split("/").pop() ?? doc.path),
    },
    { id: "goto", label: `${tr("editor.filepane.goToLine")}…`, ...(touchLayout ? {} : { detail: shortcut("G") }), onSelect: () => setGotoOpen(true) },
    ...(hasOutline(doc.path)
      ? [{ id: "symbols", icon: TreeViewIcon, label: `${tr("editor.filepane.goToSymbol")}…`, ...(touchLayout ? {} : { detail: MOD === "⌘" ? "⇧⌘O" : `${MOD}+Shift+O` }), onSelect: openSymbols } satisfies MenuEntry]
      : []),
    {
      id: "wrap",
      label: tr("editor.filepane.wrapLines2"),
      kind: "checkbox",
      checked: wrap,
      onSelect: () => setWrap((value) => !value),
    },
    ...(!readOnly && dirty
      ? [{
          id: "discard",
          label: tr("editor.filepane.discardChanges"),
          onSelect: () => {
            void confirmAlert(tr("editor.filepane.discardUnsavedChanges"), {
              title: tr("common.discardChanges"),
              confirmLabel: tr("common.discard"),
            }).then((ok) => { if (ok) td?.handle.discard(); });
          },
        } satisfies MenuEntry]
      : []),
    { id: "rename", label: tr("editor.filepane.renameMove"), onSelect: () => setRenameTo(doc.path) },
    { id: "delete", label: tr("editor.filepane.delete"), danger: true, onSelect: () => setConfirmDel(true) },
    ...(actions
      ? ["separator" as const, { id: "close", label: tr("editor.filepane.closeFile"), onSelect: () => actions.closeSelf("file", path, repositoryId) }]
      : []),
  ];

  return (
    <>
      {repositoryContext.count > 1 && repositoryContext.alias && (
        <div className="editor-file-breadcrumb" title={`${repositoryContext.alias}: ${doc.path}`}>
          <span className="editor-file-breadcrumb-repository">{repositoryContext.alias}</span>
          <span aria-hidden="true">/</span>
          <span>{doc.path}</span>
        </div>
      )}
      {showToolbar && (
      <div className="editor-toolbar editor-toolbar--accessory">
        {previewKind !== null && (
          <Tabs
            className="editor-mode-switch"
            size="sm"
            label={tr("editor.filepane.valueMode", { previewName: previewName })}
            value={editing ? "edit" : "preview"}
            tabs={[
              { id: "edit", label: tr("common.edit") },
              { id: "preview", label: previewName },
            ]}
            onChange={(value) => { if ((value === "preview") === editing) setPreviewMode(value === "preview"); }}
          />
        )}
        {live?.kind === "saving" && <span className="editor-save-state">{tr("common.saving")}</span>}
        {live?.kind === "saved" && <span className="editor-save-state">{tr("common.saved")}</span>}
        {flash && <span className="editor-flash">{flash}</span>}
        {inlineStatus && <span className="editor-save-state">{inlineStatus}</span>}
        <span className="header-spacer" />
        {gotoOpen && (
          <span className="editor-goto">
            <TextInput
              uiSize="sm"
              autoFocus
              placeholder={tr("editor.filepane.lineEnd")}
              aria-label={tr("editor.filepane.goToLine")}
              value={gotoVal}
              size={8}
              onChange={(e) => setGotoVal(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
                if (e.key === "Escape") { setGotoOpen(false); return; }
                if (e.key !== "Enter") return;
                const m2 = /^(\d+)(?:[:-](\d+))?$/.exec(gotoVal.trim());
                if (m2) {
                  gotoLine(Number(m2[1]), m2[2] ? Number(m2[2]) : undefined);
                  setGotoOpen(false);
                  setGotoVal("");
                }
              }}
            />
          </span>
        )}
        {hasOutline(doc.path) && (
          <IconButton
            icon={TreeViewIcon}
            size="sm"
            title={`${tr("editor.filepane.goToSymbol")} (${MOD === "⌘" ? "⇧⌘O" : `${MOD}+Shift+O`})`}
            label={tr("editor.filepane.goToSymbol")}
            aria-expanded={symbols !== null}
            onClick={() => (symbols ? setSymbols(null) : openSymbols())}
          />
        )}
        {!readOnly && (editing || dirty) && (
          <IconButton
            icon={CheckIcon}
            size="sm"
            disabled={live?.kind === "saving" || !dirty}
            title={`${tr("editor.filepane.saveFile")} (${shortcut("S")})`}
            label={tr("editor.filepane.saveFile")}
            onClick={() => void save()}
          />
        )}
        {touchLayout && (
          <Menu label={tr("editor.filepane.actionsForValue", { path: doc.path })} title={tr("editor.filepane.fileActions")} entries={fileActionEntries} align="end">
            {(trigger) => <IconButton {...trigger} className="editor-more-btn" icon={MoreIcon} size="sm" label={tr("editor.filepane.fileActions")} />}
          </Menu>
        )}
      </div>
      )}
      <div className="files-symbols-anchor" aria-hidden><span ref={symbolsAnchorRef} /></div>
      <SymbolsPanel
        open={symbols !== null}
        anchorRef={symbolsAnchorRef}
        symbols={symbols ?? []}
        onPick={pickSymbol}
        onClose={() => setSymbols(null)}
      />
      <Menu
        key={fileMenu ? `file-${fileMenu.x}-${fileMenu.y}` : "file-closed"}
        label={tr("editor.filepane.actionsForValue", { path: doc.path })}
        title={tr("editor.filepane.fileActions")}
        phonePresentation="popover"
        open={fileMenu !== null}
        onOpenChange={(open) => { if (!open) setFileMenu(null); }}
        entries={fileActionEntries}
      >
        {(trigger) => (
          <ContextMenuAnchor
            trigger={trigger}
            className="editor-ctx-anchor"
            hidden={!fileMenu}
            x={fileMenu?.x ?? 0}
            y={fileMenu?.y ?? 0}
          />
        )}
      </Menu>
      <Menu
        key={selectionMenu ? `sel-${selectionMenu.x}-${selectionMenu.y}` : "sel-closed"}
        label={tr("editor.filepane.selectionActions")}
        title={tr("editor.filepane.selectionActions")}
        phonePresentation="popover"
        open={selectionMenu !== null}
        onOpenChange={(open) => { if (!open) setSelectionMenu(null); }}
        entries={selectionMenu ? [
          {
            id: "add-chat",
            icon: ChatIcon,
            label: tr("editorview.addToChat"),
            detail: shortcut("L"),
            onSelect: () => { void addSelection(selectionMenu); setSelectionMenu(null); },
          },
          {
            id: "explain",
            icon: AssistIcon,
            label: tr("editor.filepane.explainSelection"),
            onSelect: () => void runExplain(selectionMenu, selectionMenu),
          },
          ...(editing && !readOnly ? [{
            id: "fix",
            icon: EditIcon,
            label: tr("editor.filepane.fixSelection"),
            onSelect: () => void runFix(selectionMenu),
          }] : []),
        ] satisfies MenuEntry[] : []}
      >
        {(trigger) => (
          <ContextMenuAnchor
            trigger={trigger}
            className="editor-ctx-anchor"
            hidden={!selectionMenu}
            x={selectionMenu?.x ?? 0}
            y={selectionMenu?.y ?? 0}
          />
        )}
      </Menu>
      {explainPanel && typeof document !== "undefined" && createPortal(
        <div
          className="editor-explain-panel"
          style={{ left: explainPanel.x, top: explainPanel.y }}
          role="dialog"
          aria-label={tr("editor.filepane.explainSelection")}
        >
          <div className="editor-explain-head">
            <span>{tr("editor.filepane.explainSelection")}</span>
            <IconButton
              icon={CloseIcon}
              size="sm"
              label={tr("common.close")}
              onClick={() => setExplainPanel(null)}
            />
          </div>
          {explainPanel.loading && <Spinner />}
          {explainPanel.error && <p className="form-error">{explainPanel.error}</p>}
          {!explainPanel.loading && explainPanel.text && (
            <>
              <p className="editor-explain-body">{explainPanel.text}</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  insertToChat(explainPanel.text);
                  setExplainPanel(null);
                }}
              >
                {tr("editor.filepane.addExplanationToChat")}
              </Button>
            </>
          )}
        </div>,
        document.body,
      )}
      {renameTo !== null && (
        <div className="files-create editor-rename">
          <TextInput
            uiSize="sm"
            autoFocus
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === "Enter") void rename();
              else if (e.key === "Escape") setRenameTo(null);
            }}
          />
          <Button size="sm" disabled={busy} onClick={() => void rename()}>{tr("common.rename")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setRenameTo(null)}>{tr("common.cancel")}</Button>
        </div>
      )}
      {confirmDel && (
        <div className="editor-banner editor-conflict" role="alert">
          <span>{tr("common.delete")}{" "}{doc.path}?</span>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
            {tr("editor.filepane.deletePermanently")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>{tr("common.cancel")}</Button>
        </div>
      )}
      {live && !live.noticeDismissed && (live.kind === "external-change" || live.kind === "conflict") && (
        <div className="editor-banner editor-conflict" role="alert">
          <span>
            {tr("editor.filepane.fileChangedOnDisk")}{live.kind === "conflict" ? tr("editor.filepane.yourUnsavedBufferIsPreserved") : tr("editor.filepane.reloadToViewTheReplacement")}
          </span>
          <Button size="sm" onClick={() => void reload()}>{tr("editor.filepane.reloadFromDisk")}</Button>
          {snap.dirty && <Button size="sm" variant="danger" onClick={() => void save({ force: true })}>{tr("editor.filepane.overwrite")}</Button>}
          <IconButton icon={CloseIcon} size="sm" label={tr("editor.filepane.dismissFileChangeNotice")} onClick={() => td?.handle.dismissNotice()} />
        </div>
      )}
      {live && !live.noticeDismissed && live.kind === "deleted" && (
        <div className="editor-banner editor-conflict" role="alert">
          <span>{tr("editor.filepane.fileWasDeletedOnDisk")}{snap.dirty ? tr("editor.filepane.savingRecreatesItYourBufferIsPreserved") : ""}</span>
          {snap.dirty && <Button size="sm" variant="danger" onClick={() => void save({ force: true })}>{tr("editor.filepane.recreate")}</Button>}
          <IconButton icon={CloseIcon} size="sm" label={tr("editor.filepane.dismissDeletedFileNotice")} onClick={() => td?.handle.dismissNotice()} />
        </div>
      )}
      {live && !live.noticeDismissed && live.kind === "check-failed" && (
        <div className="editor-banner" role="alert">
          <span>{tr("editor.filepane.couldnTCheckForExternalChanges")}{" "}{live.message}</span>
          <Button size="sm" onClick={() => void checkFile()}>{tr("common.retry")}</Button>
          <IconButton icon={CloseIcon} size="sm" label={tr("editor.filepane.dismissFileCheckNotice")} onClick={() => td?.handle.dismissNotice()} />
        </div>
      )}
      {snap.truncated && <div className="editor-banner">{tr("editor.filepane.truncatedFileExceeds512KbReadOnly")}</div>}
      {/* A previewed image/video/audio/PDF needs no "binary" warning. */}
      {snap.binary && !mediaKind && <div className="editor-banner">{tr("editor.filepane.binaryFileDetectedReadOnly")}</div>}
      {shownError && <div className="form-error editor-error">{shownError}</div>}
      {editing && !readOnly ? (
        <div className={`editor-edit${review && review.owners.length > 0 ? " has-review" : ""}`} {...surfaceInteract}>
          <EditorSurfaceSlot
            groupId={FILES_GROUP_ID}
            resource={resourceRef}
            path={doc.path}
            readOnly={readOnly}
            wrap={wrap}
            ariaLabel={tr("editor.filepane.editValue", { path: doc.path })}
            visible={visible}
            authoritativeGeneration={snap.authoritativeGeneration}
            onSave={onEditorSave}
            reveal={reveal}
            onRevealConsumed={onRevealConsumed}
            changes={review?.set ?? null}
          />
          {review && review.owners.length > 0 && (
            <div
              className="files-review-bar"
              role="toolbar"
              aria-label={tr("files.changes.review")}
              onMouseUp={stopSurface}
              onContextMenu={stopSurface}
            >
              {(review.owners.length > 0 || review.unattributed) && (
                <span className="files-review-owners">
                  {review.owners.slice(0, 2).map((owner) => (
                    <span key={owner.sessionId} className="files-review-owner" title={changedByLabel([owner])}>
                      <span className="files-change-dot" style={{ "--session-tone": sessionToneColor(owner.tone) } as CSSProperties} aria-hidden />
                      <span className="files-review-owner-name" dir="auto">{sessionLabel(owner)}</span>
                    </span>
                  ))}
                  {review.owners.length > 2 && (
                    <span className="files-review-owner" title={changedByLabel(review.owners.slice(2))}>+{review.owners.length - 2}</span>
                  )}
                  {review.unattributed && (
                    <span className="files-review-owner" title={tr("files.changes.notFromChat")}>
                      <span className="files-change-dot" style={{ "--session-tone": sessionToneColor(-1) } as CSSProperties} aria-hidden />
                      <span className="files-review-owner-name">{tr("files.changes.other")}</span>
                    </span>
                  )}
                </span>
              )}
              <span className="files-review-group">
                <IconButton size="sm" icon={ChevronUpIcon} label={tr("files.changes.previous")} onClick={() => goToChange(-1)} />
                <span className="files-review-count" aria-live="polite">
                  {hunkCursor < 0 || hunkCursor >= review.hunks.length
                    ? tr("files.changes.count", { count: review.hunks.length })
                    : tr("files.changes.position", { index: hunkCursor + 1, count: review.hunks.length })}
                </span>
                <IconButton size="sm" icon={ChevronDownIcon} label={tr("files.changes.next")} onClick={() => goToChange(1)} />
              </span>
              <Button size="sm" variant="ghost" className="files-review-keep" onClick={keepAll}>{tr("files.changes.keepAll")}</Button>
              {checkout.viewerFiles.length > 1 && (
                <span className="files-review-group files-review-files">
                  <IconButton size="sm" icon={ChevronLeftIcon} label={tr("files.changes.previousFile")} onClick={() => goToFile(-1)} />
                  <span className="files-review-count">
                    {tr("files.changes.filePosition", { index: fileIndex < 0 ? "–" : fileIndex + 1, count: checkout.viewerFiles.length })}
                  </span>
                  <IconButton size="sm" icon={ChevronRightIcon} label={tr("files.changes.nextFile")} onClick={() => goToFile(1)} />
                </span>
              )}
            </div>
          )}
        </div>
      ) : previewKind === "markdown" && !editing ? (
        <div className="editor-body editor-md-preview" ref={bodyRef} {...surfaceInteract}>
          <div className="editor-md-content">
            <MarkdownDoc
              text={previewText}
              keyBase={`md-${doc.path}`}
              frontmatter
              resourceContext={{ projectId, sessionId, repositoryId }}
            />
          </div>
        </div>
      ) : previewKind === "html" && !editing ? (
        <div className="editor-body editor-html-preview" ref={bodyRef} {...surfaceInteract}>
          <iframe
            className="html-preview-frame"
            title={tr("editor.filepane.previewOfValue", { path: doc.path })}
            sandbox="allow-scripts"
            srcDoc={htmlPreviewDocument(previewText, `${window.location.origin}/`)}
          />
          <div className="html-preview-note muted">
            {tr("editor.filepane.sandboxedPreviewScriptsAreIsolatedAndNetwork")}</div>
        </div>
      ) : previewKind === "json" && !editing ? (
        <div className="editor-body editor-json-preview" ref={bodyRef} {...surfaceInteract}>
          {jsonValue !== undefined ? (
            <JsonTree value={jsonValue} defaultDepth={prefs.jsonTreeDepth} />
          ) : (
            <div className="editor-banner">{tr("editor.filepane.notValidJsonShowingSourceInstead")}</div>
          )}
          {jsonValue === undefined && (
            <pre className="code-view editor-plain">{previewText}</pre>
          )}
        </div>
      ) : previewKind === "csv" && !editing ? (
        <CsvPreview text={previewText} path={doc.path} />
      ) : previewKind === "svg" && !editing ? (
        <ImageViewer src={svgDataUrl(previewText)} alt={doc.path} />
      ) : mediaKind === "image" ? (
        <ImageViewer src={rawUrl} alt={doc.path} />
      ) : mediaKind ? (
        <div className="editor-body editor-media">
          {mediaKind === "video" && <video className="editor-media-item" src={rawUrl} controls preload="metadata" />}
          {mediaKind === "audio" && <audio className="editor-media-item" src={rawUrl} controls preload="metadata" />}
          {mediaKind === "pdf" && <iframe className="editor-media-item" src={rawUrl} title={doc.path} />}
        </div>
      ) : snap.binary ? (
        <div className="editor-body editor-media">
          <iframe className="editor-media-item" src={rawUrl} title={doc.path} />
          <a className="editor-file-download" href={rawUrl} download={doc.path.split(/[\\/]/).pop()}>{tr("editor.filepane.downloadPath", { path: doc.path })}</a>
        </div>
      ) : (
        <div
          className="editor-body"
          ref={bodyRef}
          {...surfaceInteract}
        >
          {lines.length <= MAX_ROWED_LINES ? (
            <div className={`code-lines${wrap ? " wrap" : ""}`}>
              {lines.map((h, i) => (
                <div
                  key={i}
                  className={`cl-row${hlRange && i + 1 >= hlRange[0] && i + 1 <= hlRange[1] ? " hl" : ""}`}
                  data-ln={i + 1}
                >
                  <span className="cl-ln">{i + 1}</span>
                  <span className="cl-code" dangerouslySetInnerHTML={{ __html: h || " " }} />
                </div>
              ))}
            </div>
          ) : (
            <pre
              className="code-view editor-plain"
              data-ln={1}
              dangerouslySetInnerHTML={{ __html: lines.join("\n") }}
            />
          )}
        </div>
      )}
    </>
  );
}

/** Slice-3 registration: the "file" kind resolves to FilePane. Idempotent by
 *  module identity — importing this file installs the provider once. */
export function registerFilePaneProvider(): () => void {
  return registerPaneProvider({
    kind: "file",
    title: baseOf,
    available: () => true,
    dirty: (scope, resourcePath) => isDocDirty(scope.projectId, scope.sessionId, resourcePath, scope.repositoryId),
    // One dot per chat that changed the file, in its colour.
    marker: checkoutTabMarker,
    discard: (scope, resourcePath) =>
      peekFileDoc(scope.projectId, scope.sessionId, resourcePath, scope.repositoryId)?.handle.discard(),
    close: (scope, resourcePath) =>
      deleteDoc(scope.projectId, scope.sessionId, resourcePath, scope.repositoryId),
    subscribe: (listener) => {
      const offDocs = subscribeDocs(listener);
      const offEdits = subscribeCheckoutEdits(listener);
      return () => { offDocs(); offEdits(); };
    },
    component: FilePane,
  });
}

registerFilePaneProvider();

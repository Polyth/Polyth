// Workspace pane host (WP6): file tree on the left, a keep-alive tab strip and
// editor filling the rest. Each open file keeps its buffer (and dirty state)
// alive across tab switches; dirty tabs block accidental close. Saves are
// revision-guarded — a file changed on disk raises a conflict banner instead
// of clobbering. Markdown/HTML/JSON previews, go-to-line, and tree context
// menus round out the surface.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { api, httpStatusOf, type FileEntry, type FileReadResult } from "../api.ts";
import { clearEditorLocation, getState, openEditorFile, setActiveView, useStore } from "../store.ts";
import { MarkdownDoc } from "../markdown.tsx";
import EmptyState from "./EmptyState.tsx";
import JsonTree, { tryParseJson } from "../markdown/JsonTree.tsx";
import { highlightLines, langOf } from "../highlight.ts";
import { formatFileChat, formatSelectionChat, lineRangeOf } from "../chatclip.ts";
import { requestComposerInsert } from "../composerInsert.ts";
import { createSession } from "../init.ts";
import { setDragPath } from "../dnd.ts";
import { MOD } from "../format.ts";
import { useEscape } from "../useEscape.ts";
import { setEditorPrefs, useEditorPrefs, useUiSettings } from "../uiPrefs.ts";
import {
  autosaveDelay,
  beginLiveFileSave,
  checkLiveFile,
  completeLiveFileSave,
  conflictLiveFile,
  dismissLiveFileNotice,
  editLiveFile,
  htmlPreviewDocument,
  initialPreviewVisible,
  loadedLiveFile,
  previewKindForPath,
  restoreLiveFileBuffer,
  type LiveFileState,
} from "../editor/liveFile.ts";
import {
  activateTab, closeTab, cycleTab, deserializePane, emptyPane, markDirty, moveTab,
  openTab, serializePane, tabId, type PaneState, type PaneTab,
} from "../workspace/paneStore.ts";

interface Row {
  e: FileEntry;
  depth: number;
}

/** Per-file keep-alive document state. Lives outside React state identity so
 *  hidden tabs keep their buffers verbatim. */
interface TabDoc {
  doc: FileReadResult | null;
  buf: string;
  editing: boolean;
  loading: boolean;
  error: string;
  live: LiveFileState | null;
  composing: boolean;
}

const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");
const baseOf = (p: string) => p.split("/").pop() ?? p;
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** Files at or below this size get inlined into "Add file to chat". */
const INLINE_FILE_CHARS = 4000;
/** Above this many lines, fall back to a plain block (no per-line rows). */
const MAX_ROWED_LINES = 8000;
const AUTOSAVE_MS = 1_500;
const FILE_REFRESH_MS = 8_000;

interface CtxMenu {
  x: number;
  y: number;
  entry: FileEntry;
}

export default function EditorView() {
  const projectId = useStore((s) => s.activeProjectId);
  // Files must follow the ACTIVE SESSION's worktree, not the project root
  // (UX-FIXTURE-VISUAL P0): every files call carries the session id.
  const sessionId = useStore((s) => s.activeSessionId);
  const sid = sessionId ?? undefined;
  const filePath = useStore((s) => s.editorFile);
  const location = useStore((s) => s.editorLocation);
  const prefs = useUiSettings();
  const editorPrefs = useEditorPrefs();

  // ---- tree ----------------------------------------------------------------
  const [kids, setKids] = useState<Record<string, FileEntry[]>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [sel, setSel] = useState("");
  const [treeErr, setTreeErr] = useState("");
  const [ctx, setCtx] = useState<CtxMenu | null>(null);

  // ---- pane tabs -------------------------------------------------------------
  const [pane, setPane] = useState<PaneState>(emptyPane);
  const cacheRef = useRef(new Map<string, TabDoc>());
  const [tick, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);

  // ---- transient editor chrome -------------------------------------------------
  const [wrap, setWrap] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [hlRange, setHlRange] = useState<[number, number] | null>(null);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoVal, setGotoVal] = useState("");
  const [previewOn, setPreviewOn] = useState(true);
  const [dragTab, setDragTab] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);

  const active = pane.tabs.find((t) => t.id === pane.activeId) ?? null;
  const activePath = active && active.kind === "file" && !active.unavailable ? active.resource : null;
  const td = activePath ? cacheRef.current.get(activePath) : undefined;
  const doc = td?.doc ?? null;
  const buf = td?.buf ?? "";
  const editing = td?.editing ?? false;
  const error = td?.error ?? "";
  const live = td?.live ?? null;
  const dirty = doc !== null && buf !== doc.content;
  const readOnly = doc ? doc.truncated || doc.tooLarge === true : false;

  const isDirtyTab = (t: PaneTab): boolean => {
    if (t.kind !== "file") return false;
    const e = cacheRef.current.get(t.resource);
    return !!e?.doc && e.buf !== e.doc.content;
  };

  // ---- pane persistence per project ------------------------------------------
  const paneKey = projectId ? `polyth.pane.${projectId}` : null;
  useEffect(() => {
    cacheRef.current.clear();
    setKids({});
    setOpen(new Set());
    setSel("");
    setCtx(null);
    if (!paneKey) {
      setPane(emptyPane);
      return;
    }
    let raw: string | null = null;
    try { raw = localStorage.getItem(paneKey); } catch { /* private mode */ }
    // Files stay resolvable (missing ones will error honestly on load); plugin
    // tab providers are not registered yet, so those restore as unavailable.
    setPane(deserializePane(raw, (kind) => kind === "file"));
    if (projectId) void loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneKey]);

  useEffect(() => {
    if (!paneKey) return;
    try { localStorage.setItem(paneKey, serializePane(pane)); } catch { /* full */ }
  }, [pane, paneKey]);

  const loadDir = async (p: string) => {
    if (!projectId) return;
    try {
      const entries = await api.filesTree(projectId, p || undefined, undefined, sid);
      setKids((k) => ({ ...k, [p]: entries }));
      setTreeErr("");
    } catch (err) {
      setTreeErr(msg(err));
    }
  };

  // A session switch can move the filesystem root to that session's worktree,
  // so cached listings and documents are stale (UX-FIXTURE-VISUAL P0).
  useEffect(() => {
    cacheRef.current.clear();
    setKids({});
    if (projectId) void loadDir("");
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Store-driven opens (file refs in chat, palette, files panel) become tabs.
  useEffect(() => {
    if (!filePath) return;
    setPane((p) => openTab(p, { id: tabId("file", filePath), kind: "file", resource: filePath, title: baseOf(filePath) }));
    setSel(filePath);
  }, [filePath]);

  // Load the active tab's document once (keep-alive afterwards).
  useEffect(() => {
    if (!projectId || !activePath) return;
    const existing = cacheRef.current.get(activePath);
    if (existing && (existing.doc || existing.loading)) return;
    const entry: TabDoc = {
      doc: null,
      buf: "",
      editing: false,
      loading: true,
      error: "",
      live: null,
      composing: false,
    };
    cacheRef.current.set(activePath, entry);
    bump();
    api.filesRead(projectId, activePath, sid)
      .then((got) => {
        entry.doc = got;
        entry.buf = got.content;
        entry.live = loadedLiveFile(got.revision);
        entry.loading = false;
        bump();
      })
      .catch((err) => {
        entry.error = msg(err);
        entry.loading = false;
        bump();
      });
    // tick re-checks after the session-switch effect clears the cache
  }, [projectId, activePath, sessionId, tick]);

  // Reset one-shot chrome when the active tab changes.
  useEffect(() => {
    setRenameTo(null);
    setConfirmDel(false);
    setHlRange(null);
    setGotoOpen(false);
    setPreviewOn(activePath ? initialPreviewVisible(activePath, editorPrefs.openInPreview) : false);
  }, [pane.activeId, editorPrefs.openInPreview]);

  // Jump to a line/range: highlight it and center it in the scroll pane.
  const gotoLine = (start: number, end?: number) => {
    const last = end !== undefined && end >= start ? end : start;
    setHlRange([start, last]);
    requestAnimationFrame(() => {
      const row = bodyRef.current?.querySelector(`[data-ln="${start}"]`);
      row?.scrollIntoView({ block: "center" });
    });
  };

  // Pending location from a file reference (chat) — consume once the doc is in.
  useEffect(() => {
    if (!doc || !location || location.path !== doc.path) return;
    if (location.startLine !== undefined) {
      setPreviewOn(false); // ranges need the line-numbered source view
      gotoLine(location.startLine, location.endLine);
    }
    clearEditorLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, location]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 1800);
    return () => clearTimeout(t);
  }, [flash]);

  const toggle = (p: string) => {
    if (!open.has(p) && !kids[p]) void loadDir(p);
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  };

  // ---- tab operations ----------------------------------------------------------
  const syncStoreToActive = (state: PaneState) => {
    const a = state.tabs.find((t) => t.id === state.activeId);
    const next = a && a.kind === "file" && !a.unavailable ? a.resource : null;
    if (getState().editorFile !== next) openEditorFile(next);
  };

  const activate = (id: string) => {
    setPane((p) => {
      const next = activateTab(p, id);
      syncStoreToActive(next);
      return next;
    });
  };

  const requestClose = (id: string) => {
    const t = pane.tabs.find((x) => x.id === id);
    if (!t) return;
    if (isDirtyTab(t) && !window.confirm(`Discard unsaved changes in ${t.title}?`)) return;
    if (t.kind === "file") cacheRef.current.delete(t.resource);
    const { state } = closeTab(markDirty(pane, id, false), id);
    setPane(state);
    syncStoreToActive(state);
  };

  const openFile = (fp: string) => {
    setSel(fp);
    openEditorFile(fp); // effect turns it into a tab
  };

  const setBufFor = (path: string, text: string) => {
    const e = cacheRef.current.get(path);
    if (!e) return;
    e.buf = text;
    const isDirty = !!e.doc && text !== e.doc.content;
    if (e.live) e.live = isDirty ? editLiveFile(e.live) : restoreLiveFileBuffer(e.live);
    bump();
    setPane((p) => markDirty(p, tabId("file", path), isDirty));
  };

  // ---- chat inserts ----------------------------------------------------------
  const insertToChat = (text: string) => {
    requestComposerInsert(text);
    const st = getState();
    if (!st.activeSessionId && st.activeProjectId) {
      void createSession(st.activeProjectId).catch(() => {});
    }
    setFlash("Added to chat ✓");
  };

  const addSelection = () => {
    if (!doc) return;
    if (editing) {
      const el = taRef.current;
      if (!el || el.selectionStart === el.selectionEnd) {
        setFlash("Select some text first");
        return;
      }
      const text = buf.slice(el.selectionStart, el.selectionEnd);
      const { startLine, endLine } = lineRangeOf(buf, el.selectionStart, el.selectionEnd);
      insertToChat(formatSelectionChat(doc.path, text, startLine, endLine));
      return;
    }
    const s = window.getSelection();
    const container = bodyRef.current;
    if (!s || s.isCollapsed || s.rangeCount === 0 || !container) {
      setFlash("Select some text first");
      return;
    }
    const range = s.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setFlash("Select some text first");
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
    insertToChat(formatSelectionChat(doc.path, text, Math.min(a, b), Math.max(a, b)));
  };

  const addFile = () => {
    if (!doc) return;
    insertToChat(readOnly ? `@${doc.path}` : formatFileChat(doc.path, doc.content, INLINE_FILE_CHARS));
  };

  const attachPath = (fp: string) => insertToChat(`@${fp}`);

  // ---- file operations ---------------------------------------------------------
  const savePath = async (path: string, opts: { force?: boolean } = {}) => {
    const e = cacheRef.current.get(path);
    if (!projectId || !path || !e?.doc || (e.doc.truncated || e.doc.tooLarge)) return;
    const content = e.buf;
    e.live = beginLiveFileSave(e.live ?? loadedLiveFile(e.doc.revision));
    bump();
    try {
      // This revision came from filesRead; only an explicit conflict overwrite
      // omits it. Autosave can therefore never silently clobber an external edit.
      const base = opts.force ? undefined : e.doc.revision;
      const res = await api.filesWrite(projectId, path, content, base, getState().activeSessionId ?? undefined);
      const stillDirty = e.buf !== content;
      e.doc = { ...e.doc, content, revision: res.revision };
      e.live = completeLiveFileSave(e.live, res.revision, stillDirty);
      e.error = "";
      setPane((p) => markDirty(p, tabId("file", path), stillDirty));
      if (path === activePath && !stillDirty) setFlash("Saved ✓");
    } catch (err) {
      if (httpStatusOf(err) === 409) {
        e.live = conflictLiveFile(e.live);
      } else {
        e.error = msg(err);
        e.live = editLiveFile(e.live);
      }
    } finally {
      bump();
    }
  };

  const save = async (opts: { force?: boolean } = {}) => {
    if (activePath) await savePath(activePath, opts);
  };

  const reloadActive = async () => {
    const path = activePath;
    const e = path ? cacheRef.current.get(path) : undefined;
    if (!projectId || !path || !e) return;
    try {
      const got = await api.filesRead(projectId, path, sid);
      e.doc = got;
      e.buf = got.content;
      e.live = loadedLiveFile(got.revision);
      e.error = "";
      setPane((p) => markDirty(p, tabId("file", path), false));
    } catch (err) {
      e.error = msg(err);
    }
    bump();
  };

  const checkActiveFile = async () => {
    const path = activePath;
    const e = path ? cacheRef.current.get(path) : undefined;
    if (!projectId || !path || !e?.doc || !e.live) return;
    try {
      const stat = await api.filesStat(projectId, path, sid);
      e.live = checkLiveFile(e.live, { kind: "present", revision: stat.revision });
    } catch (err) {
      e.live = httpStatusOf(err) === 404
        ? checkLiveFile(e.live, { kind: "deleted" })
        : checkLiveFile(e.live, { kind: "failed", message: msg(err) });
    }
    bump();
  };

  // Every dirty editing tab owns its debounce. IME composition pauses that
  // tab's timer; conflicted/deleted/check-failed states remain paused.
  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    for (const [path, entry] of cacheRef.current) {
      if (!entry.doc || !entry.live) continue;
      const delay = autosaveDelay(entry.live, {
        enabled: prefs.editorAutosave,
        editing: entry.editing,
        composing: entry.composing,
        readOnly: entry.doc.truncated || entry.doc.tooLarge === true,
      }, AUTOSAVE_MS);
      if (delay !== null) timers.push(setTimeout(() => void savePath(path), delay));
    }
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, prefs.editorAutosave, tick]);

  // One slow refresh owner: expanded directories plus the active file revision.
  // Hidden browser tabs do no filesystem work.
  useEffect(() => {
    if (!projectId) return;
    const refreshVisible = () => {
      if (document.visibilityState === "hidden") return;
      for (const path of new Set(["", ...open])) void loadDir(path);
      void checkActiveFile();
    };
    const onFocus = () => refreshVisible();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshVisible();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(refreshVisible, FILE_REFRESH_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, activePath, open]);

  const rename = async () => {
    const to = renameTo?.trim();
    if (!projectId || !doc || !to || to === doc.path) {
      setRenameTo(null);
      return;
    }
    setBusy(true);
    try {
      await api.filesRename(projectId, doc.path, to, sid);
      await Promise.all([loadDir(parentOf(doc.path)), loadDir(parentOf(to))]);
      const old = doc.path;
      const entry = cacheRef.current.get(old);
      cacheRef.current.delete(old);
      if (entry) cacheRef.current.set(to, entry);
      setPane((p) => {
        const without = closeTab(markDirty(p, tabId("file", old), false), tabId("file", old)).state;
        return openTab(without, { id: tabId("file", to), kind: "file", resource: to, title: baseOf(to) });
      });
      setRenameTo(null);
      openEditorFile(to);
    } catch (err) {
      if (td) { td.error = msg(err); bump(); }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!projectId || !doc) return;
    setBusy(true);
    try {
      await api.filesDelete(projectId, doc.path, sid);
      setConfirmDel(false);
      await loadDir(parentOf(doc.path));
      const id = tabId("file", doc.path);
      cacheRef.current.delete(doc.path);
      const { state } = closeTab(markDirty(pane, id, false), id);
      setPane(state);
      syncStoreToActive(state);
    } catch (err) {
      if (td) { td.error = msg(err); bump(); }
    } finally {
      setBusy(false);
    }
  };

  // ---- tree context menu actions ------------------------------------------------
  const ctxRename = async (entry: FileEntry) => {
    if (!projectId) return;
    const to = window.prompt("Rename / move to:", entry.path)?.trim();
    if (!to || to === entry.path) return;
    try {
      await api.filesRename(projectId, entry.path, to, sid);
      await Promise.all([loadDir(parentOf(entry.path)), loadDir(parentOf(to))]);
      if (!entry.dir && pane.tabs.some((t) => t.id === tabId("file", entry.path))) {
        const entryDoc = cacheRef.current.get(entry.path);
        cacheRef.current.delete(entry.path);
        if (entryDoc) cacheRef.current.set(to, entryDoc);
        setPane((p) => {
          const without = closeTab(markDirty(p, tabId("file", entry.path), false), tabId("file", entry.path)).state;
          return openTab(without, { id: tabId("file", to), kind: "file", resource: to, title: baseOf(to) });
        });
        openEditorFile(to);
      }
    } catch (err) {
      setTreeErr(msg(err));
    }
  };

  const ctxDelete = async (entry: FileEntry) => {
    if (!projectId) return;
    if (!window.confirm(`Delete ${entry.path}${entry.dir ? " and its contents" : ""}?`)) return;
    try {
      await api.filesDelete(projectId, entry.path, sid);
      await loadDir(parentOf(entry.path));
      if (!entry.dir) {
        const id = tabId("file", entry.path);
        cacheRef.current.delete(entry.path);
        const { state } = closeTab(markDirty(pane, id, false), id);
        setPane(state);
        syncStoreToActive(state);
      }
    } catch (err) {
      setTreeErr(msg(err));
    }
  };

  const ctxNew = async (dirPath: string, kind: "file" | "folder") => {
    if (!projectId) return;
    const name = window.prompt(`New ${kind} name:`)?.trim();
    if (!name) return;
    const rel = dirPath ? `${dirPath}/${name}` : name;
    try {
      if (kind === "folder") await api.filesMkdir(projectId, rel, sid);
      else await api.filesWrite(projectId, rel, "", undefined, sid);
      await loadDir(dirPath);
      setOpen((o) => new Set(o).add(dirPath));
      if (kind === "file") openFile(rel);
    } catch (err) {
      setTreeErr(msg(err));
    }
  };

  useEscape(renameTo !== null, () => setRenameTo(null));
  useEscape(ctx !== null, () => setCtx(null));

  // ---- keyboard: save, selection→chat, go-to-line, tab cycling, Esc ------------
  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (editing && dirty && !readOnly) void save();
      } else if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        addSelection();
      } else if (mod && e.key.toLowerCase() === "g" && doc) {
        e.preventDefault();
        setGotoOpen(true);
      } else if (e.ctrlKey && (e.key === "PageDown" || e.key === "PageUp")) {
        e.preventDefault();
        setPane((p) => {
          const next = cycleTab(p, e.key === "PageDown" ? 1 : -1);
          syncStoreToActive(next);
          return next;
        });
      } else if (e.key === "Escape") {
        if (ctx) { setCtx(null); return; }
        if (gotoOpen) { setGotoOpen(false); return; }
        if (renameTo !== null || confirmDel) return; // inner dialogs own Esc
        if (pane.activeId) requestClose(pane.activeId);
        else setActiveView("session");
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // ---- tree rows -----------------------------------------------------------------
  const rows: Row[] = [];
  const walk = (p: string, depth: number) => {
    for (const e of kids[p] ?? []) {
      rows.push({ e, depth });
      if (e.dir && open.has(e.path)) walk(e.path, depth + 1);
    }
  };
  walk("", 0);

  const onTreeKey = (e: KeyboardEvent) => {
    const i = rows.findIndex((r) => r.e.path === sel);
    const cur = rows[i]?.e;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[e.key === "ArrowDown" ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)];
      if (next) setSel(next.e.path);
    } else if (e.key === "ArrowRight" && cur?.dir && !open.has(cur.path)) {
      toggle(cur.path);
    } else if (e.key === "ArrowLeft" && cur) {
      if (cur.dir && open.has(cur.path)) toggle(cur.path);
      else if (parentOf(cur.path)) setSel(parentOf(cur.path));
    } else if (e.key === "Enter" && cur) {
      if (cur.dir) toggle(cur.path);
      else openFile(cur.path);
    }
  };

  const onRowContext = (ev: MouseEvent, entry: FileEntry) => {
    ev.preventDefault();
    setSel(entry.path);
    setCtx({ x: ev.clientX, y: ev.clientY, entry });
  };

  // ---- render -----------------------------------------------------------------
  const lines = useMemo(
    () => (doc && !editing ? highlightLines(doc.content, langOf(doc.path)) : []),
    [doc, editing],
  );
  const gutterText = useMemo(
    () => (editing ? Array.from({ length: buf.split("\n").length }, (_, i) => i + 1).join("\n") : ""),
    [editing, buf],
  );
  const previewKind = doc && !editing && !readOnly
    ? previewKindForPath(doc.path)
    : null;
  const jsonValue = useMemo(
    () => (previewKind === "json" && doc ? tryParseJson(doc.content) : undefined),
    [previewKind, doc],
  );

  if (!projectId) return <EmptyState title="No project selected" description="Open a project to browse and edit files." />;

  return (
    <div className="editor-view">
      <aside className="editor-tree" tabIndex={0} onKeyDown={onTreeKey} aria-label="Project files">
        {treeErr && <div className="files-error">{treeErr}</div>}
        {rows.length === 0 && !treeErr && <div className="empty">Empty directory.</div>}
        {rows.map(({ e, depth }) => (
          <div
            key={e.path}
            className={`ft-row${sel === e.path || activePath === e.path ? " sel" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            draggable
            onDragStart={(ev) => setDragPath(ev.dataTransfer, e.path)}
            onContextMenu={(ev) => onRowContext(ev, e)}
            onClick={() => {
              setSel(e.path);
              if (e.dir) toggle(e.path);
              else openFile(e.path);
            }}
          >
            <span className="ft-chevron">{e.dir ? (open.has(e.path) ? "▾" : "▸") : ""}</span>
            <span className="ft-name">{e.name}</span>
            {!e.dir && (
              <button
                className="ft-at"
                title="Add to chat"
                onClick={(ev) => {
                  ev.stopPropagation();
                  attachPath(e.path);
                }}
              >
                @
              </button>
            )}
          </div>
        ))}
      </aside>

      {ctx && (
        <div className="ctx-backdrop" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }}>
          <div
            className="ctx-menu"
            role="menu"
            style={{ left: Math.min(ctx.x, window.innerWidth - 200), top: Math.min(ctx.y, window.innerHeight - 220) }}
            onClick={(e) => e.stopPropagation()}
          >
            {!ctx.entry.dir && (
              <button role="menuitem" onClick={() => { openFile(ctx.entry.path); setCtx(null); }}>Open</button>
            )}
            <button role="menuitem" onClick={() => { attachPath(ctx.entry.path); setCtx(null); }}>Add to chat</button>
            <button role="menuitem" onClick={() => { void navigator.clipboard?.writeText(ctx.entry.path); setCtx(null); }}>Copy path</button>
            {ctx.entry.dir && (
              <>
                <button role="menuitem" onClick={() => { void ctxNew(ctx.entry.path, "file"); setCtx(null); }}>New file…</button>
                <button role="menuitem" onClick={() => { void ctxNew(ctx.entry.path, "folder"); setCtx(null); }}>New folder…</button>
              </>
            )}
            <button role="menuitem" onClick={() => { void ctxRename(ctx.entry); setCtx(null); }}>Rename / move…</button>
            <button role="menuitem" className="danger" onClick={() => { void ctxDelete(ctx.entry); setCtx(null); }}>Delete…</button>
          </div>
        </div>
      )}

      <section className="editor-pane">
        {pane.tabs.length > 0 && (
          <div className="pane-tabs" role="tablist" aria-label="Open files">
            {pane.tabs.map((t) => (
              <div
                key={t.id}
                role="tab"
                aria-selected={pane.activeId === t.id}
                tabIndex={pane.activeId === t.id ? 0 : -1}
                className={`pane-tab${pane.activeId === t.id ? " active" : ""}${t.unavailable ? " unavailable" : ""}`}
                title={t.resource}
                draggable
                onDragStart={() => setDragTab(t.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragTab && dragTab !== t.id) {
                    setPane((p) => moveTab(p, dragTab, p.tabs.findIndex((x) => x.id === t.id)));
                  }
                  setDragTab(null);
                }}
                onClick={() => activate(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") activate(t.id);
                  else if (e.key === "Delete") requestClose(t.id);
                }}
                onAuxClick={(e) => { if (e.button === 1) requestClose(t.id); }}
              >
                <span className="pane-tab-title">{t.title}</span>
                {isDirtyTab(t) && <span className="pane-tab-dirty" title="Unsaved changes">•</span>}
                <button
                  className="pane-tab-close"
                  title="Close tab"
                  aria-label={`Close ${t.title}`}
                  onClick={(e) => { e.stopPropagation(); requestClose(t.id); }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {active?.unavailable ? (
          <div className="editor-empty">
            <p className="muted">This tab is unavailable.</p>
            <p className="muted editor-empty-hint">
              It was contributed by a plugin that is no longer active. Close it, or re-enable the plugin.
            </p>
            <button className="small-btn" onClick={() => requestClose(active.id)}>Close tab</button>
          </div>
        ) : td?.loading ? (
          <div className="editor-empty"><p className="muted">Loading {activePath}…</p></div>
        ) : doc ? (
          <>
            <div className="editor-head">
              <span className="editor-path" title={doc.path}>
                {doc.path}
                {dirty && (
                  <span className="editor-dirty" title="Unsaved changes">
                    {" "}•
                  </span>
                )}
              </span>
              <span className="header-spacer" />
              {live?.kind === "saving" && <span className="editor-save-state">Saving…</span>}
              {live?.kind === "saved" && <span className="editor-save-state">Saved</span>}
              {flash && <span className="editor-flash">{flash}</span>}
              <button className="small-btn" title="Close file (Esc)" onClick={() => active && requestClose(active.id)}>✕</button>
            </div>
            <div className="editor-toolbar">
              <button className="small-btn" title={`Add selection to chat (${MOD}L)`} onClick={addSelection}>
                Add selection to chat
              </button>
              <button className="small-btn" onClick={addFile}>Add file to chat</button>
              <span className="header-spacer" />
              {previewKind && (
                <>
                  <button className="small-btn" aria-pressed={previewOn} onClick={() => setPreviewOn((v) => !v)}>
                    {previewOn ? "Source" : previewKind === "json" ? "Tree" : "Preview"}
                  </button>
                  <label className="editor-preview-default" title="Open Markdown, HTML, and JSON files in preview mode">
                    <input
                      type="checkbox"
                      checked={editorPrefs.openInPreview}
                      onChange={(event) => setEditorPrefs({ openInPreview: event.target.checked })}
                    />
                    Preview by default
                  </label>
                </>
              )}
              {gotoOpen ? (
                <span className="editor-goto">
                  <input
                    autoFocus
                    placeholder="line[:end]"
                    value={gotoVal}
                    size={8}
                    onChange={(e) => setGotoVal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { setGotoOpen(false); return; }
                      if (e.key !== "Enter") return;
                      const m2 = /^(\d+)(?:[:-](\d+))?$/.exec(gotoVal.trim());
                      if (m2) {
                        setPreviewOn(false);
                        gotoLine(Number(m2[1]), m2[2] ? Number(m2[2]) : undefined);
                        setGotoOpen(false);
                        setGotoVal("");
                      }
                    }}
                  />
                </span>
              ) : (
                <button className="small-btn" title={`Go to line (${MOD}G)`} onClick={() => setGotoOpen(true)}>Go to line</button>
              )}
              <button className="small-btn" aria-pressed={wrap} onClick={() => setWrap((v) => !v)}>
                {wrap ? "Wrap ✓" : "Wrap"}
              </button>
              {!readOnly &&
                (editing ? (
                  <>
                    <button className="small-btn" disabled={live?.kind === "saving" || !dirty} title={`${MOD}S`} onClick={() => void save()}>
                      Save
                    </button>
                    <button
                      className="small-btn"
                      onClick={() => {
                        if (dirty && !window.confirm("Discard unsaved changes?")) return;
                        if (activePath) setBufFor(activePath, doc.content);
                        if (td) { td.editing = false; bump(); }
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="small-btn" onClick={() => { if (td) { td.editing = true; bump(); } }}>Edit</button>
                ))}
              <button className="small-btn" onClick={() => setRenameTo(doc.path)}>Rename</button>
              {confirmDel ? (
                <>
                  <button className="small-btn danger-btn" disabled={busy} onClick={() => void remove()}>
                    Delete permanently
                  </button>
                  <button className="small-btn" onClick={() => setConfirmDel(false)}>Cancel</button>
                </>
              ) : (
                <button className="small-btn danger-btn" onClick={() => setConfirmDel(true)}>Delete</button>
              )}
            </div>
            {renameTo !== null && (
              <div className="files-create editor-rename">
                <input
                  autoFocus
                  value={renameTo}
                  onChange={(e) => setRenameTo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void rename();
                  }}
                />
                <button className="small-btn" disabled={busy} onClick={() => void rename()}>Rename</button>
                <button className="small-btn" onClick={() => setRenameTo(null)}>Cancel</button>
              </div>
            )}
            {live && !live.noticeDismissed && (live.kind === "external-change" || live.kind === "conflict") && (
              <div className="editor-banner editor-conflict" role="alert">
                <span>
                  File changed on disk.
                  {live.dirty ? " Your unsaved buffer is preserved." : " Reload to view the replacement."}
                </span>
                <button className="small-btn" onClick={() => void reloadActive()}>Reload from disk</button>
                {live.dirty && <button className="small-btn danger-btn" onClick={() => void save({ force: true })}>Overwrite</button>}
                <button className="small-btn" aria-label="Dismiss file change notice" onClick={() => { if (td?.live) td.live = dismissLiveFileNotice(td.live); bump(); }}>×</button>
              </div>
            )}
            {live && !live.noticeDismissed && live.kind === "deleted" && (
              <div className="editor-banner editor-conflict" role="alert">
                <span>File was deleted on disk.{live.dirty ? " Saving recreates it; your buffer is preserved." : ""}</span>
                {live.dirty && <button className="small-btn danger-btn" onClick={() => void save({ force: true })}>Recreate</button>}
                <button className="small-btn" aria-label="Dismiss deleted file notice" onClick={() => { if (td?.live) td.live = dismissLiveFileNotice(td.live); bump(); }}>×</button>
              </div>
            )}
            {live && !live.noticeDismissed && live.kind === "check-failed" && (
              <div className="editor-banner" role="alert">
                <span>Couldn’t check for external changes: {live.message}</span>
                <button className="small-btn" onClick={() => void checkActiveFile()}>Retry</button>
                <button className="small-btn" aria-label="Dismiss file check notice" onClick={() => { if (td?.live) td.live = dismissLiveFileNotice(td.live); bump(); }}>×</button>
              </div>
            )}
            {doc.truncated && <div className="editor-banner">Truncated — file exceeds 512 KB. Read-only.</div>}
            {doc.tooLarge && <div className="editor-banner">Binary file detected. Read-only.</div>}
            {error && <div className="files-error editor-error">{error}</div>}
            {editing && !readOnly ? (
              <div className="editor-edit">
                {!wrap && (
                  <pre className="editor-gutter" ref={gutterRef} aria-hidden="true">
                    {gutterText}
                  </pre>
                )}
                <textarea
                  ref={taRef}
                  className="editor-ta"
                  value={buf}
                  wrap={wrap ? "soft" : "off"}
                  spellCheck={false}
                  onChange={(e) => activePath && setBufFor(activePath, e.target.value)}
                  onCompositionStart={() => {
                    if (td) { td.composing = true; bump(); }
                  }}
                  onCompositionEnd={() => {
                    if (td) { td.composing = false; bump(); }
                  }}
                  onScroll={() => {
                    if (gutterRef.current && taRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop;
                  }}
                />
              </div>
            ) : previewKind === "markdown" && previewOn ? (
              <div className="editor-body editor-md-preview" ref={bodyRef}>
                <MarkdownDoc text={doc.content} keyBase={`md-${doc.path}`} />
              </div>
            ) : previewKind === "html" && previewOn ? (
              <div className="editor-body editor-html-preview" ref={bodyRef}>
                <iframe
                  className="html-preview-frame"
                  title={`Preview of ${doc.path}`}
                  sandbox="allow-scripts"
                  srcDoc={htmlPreviewDocument(doc.content, `${window.location.origin}/`)}
                />
                <div className="html-preview-note muted">
                  Sandboxed preview — scripts are isolated and network access is blocked.
                </div>
              </div>
            ) : previewKind === "json" && previewOn ? (
              <div className="editor-body editor-json-preview" ref={bodyRef}>
                {jsonValue !== undefined ? (
                  <JsonTree value={jsonValue} defaultDepth={prefs.jsonTreeDepth} />
                ) : (
                  <div className="editor-banner">Not valid JSON — showing source instead.</div>
                )}
                {jsonValue === undefined && (
                  <pre className="code-view editor-plain">{doc.content}</pre>
                )}
              </div>
            ) : (
              <div className="editor-body" ref={bodyRef}>
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
        ) : (
          <div className="editor-empty">
            <p className="muted">Select a file to view or edit.</p>
            <p className="muted editor-empty-hint">
              Enter opens · @ adds to chat · {MOD}L sends a selection to the session · right-click for file actions
            </p>
            {error && <div className="files-error">{error}</div>}
          </div>
        )}
      </section>
    </div>
  );
}

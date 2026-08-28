// UX-PANE-MODEL / EXTENSION-SEAMS slice 3: ONE file document's lifecycle —
// read, edit, preview, revision-guarded save/autosave, IME pause, conflict,
// external replacement, deletion, Reload/Overwrite/Recreate/Retry — behind
// the "file" pane provider. The buffer lives in editor/fileDocs.ts scoped by
// canonical projectId + (sessionId ?? "project"), so it survives tab,
// surface, session, and presentation switches without ever leaking into
// another scope. This component is kept alive (hidden, inert) by PaneHost;
// its UI-only revision polling pauses while hidden.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, httpStatusOf } from "@polyth/session/web-api";
import { clearEditorLocation, useStore } from "../../../../apps/web/src/store.ts";
import { MarkdownDoc } from "../../../../apps/web/src/markdown.tsx";
import JsonTree, { tryParseJson } from "../../../../apps/web/src/markdown/JsonTree.tsx";
import { highlight, highlightLines, langOf } from "../../../../apps/web/src/highlight.ts";
import { formatFileChat, formatSelectionChat, lineRangeOf } from "../../../../apps/web/src/chatclip.ts";
import { requestComposerInsert } from "../../../../apps/web/src/composerInsert.ts";
import { MOD } from "../../../../apps/web/src/format.ts";
import { useEscape } from "../../../../apps/web/src/useEscape.ts";
import { clampMenuPosition } from "../../../../apps/web/src/selectionActions.ts";
import { copyText } from "../../../../apps/web/src/utils.ts";
import { getEditorPrefs, setEditorPreviewDefault, useUiSettings } from "../../../../apps/web/src/uiPrefs.ts";
import { confirmAlert } from "../../../../apps/web/src/alerts.ts";
import {
  Button,
  CheckIcon,
  CloseIcon,
  IconButton,
  MoreIcon,
  Spinner,
  Switch,
  TextInput,
} from "../../../../apps/web/src/components/ui/index.ts";
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
} from "./liveFile.ts";
import {
  bumpDocs, deleteDoc, docScopeKey, docsVersion, ensureDoc, installDocUnloadGuard,
  isDocDirty, moveDoc, subscribeDocs,
} from "./fileDocs.ts";
import { registerPaneProvider, type PaneResourceContext } from "../../../../apps/web/src/workspace/paneProviders.ts";
import { usePaneActions } from "../../../../apps/web/src/components/workspace/PaneHost.tsx";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import EmptyState from "../../../../apps/web/src/components/EmptyState.tsx";

const baseOf = (p: string) => p.split("/").pop() ?? p;
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** Files at or below this size get inlined into "Add file to chat". */
const INLINE_FILE_CHARS = 4000;
/** Above this many lines, fall back to a plain block (no per-line rows). */
const MAX_ROWED_LINES = 8000;
const AUTOSAVE_MS = 1_500;
const FILE_REFRESH_MS = 8_000;

/** Coordinators (tree, git) listen for this to refresh after file ops. */
export function announceFilesChanged(): void {
  window.dispatchEvent(new CustomEvent("polyth:files-changed"));
}

export default function FilePane({ projectId, sessionId, resource: path, visible }: PaneResourceContext) {
  const scope = docScopeKey(projectId, sessionId);
  const sid = sessionId ?? undefined;
  const prefs = useUiSettings();
  const location = useStore((s) => s.editorLocation);
  const actions = usePaneActions();
  useSyncExternalStore(subscribeDocs, docsVersion);

  const td = ensureDoc(scope, path);
  const doc = td.doc;
  const buf = td.buf;
  const editing = td.editing;
  const error = td.error;
  const live = td.live;
  const dirty = doc !== null && buf !== doc.content;
  const readOnly = doc ? doc.truncated || doc.tooLarge === true : false;

  // ---- transient chrome (per keep-alive pane, so it survives tab switches) -----
  const [wrap, setWrap] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [hlRange, setHlRange] = useState<[number, number] | null>(null);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoVal, setGotoVal] = useState("");
  // UX-FILES-TIMELINE-03 findings 3–5: actions menu + contextual selection hint.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [selHint, setSelHint] = useState<{ x: number; y: number } | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const hlRef = useRef<HTMLPreElement>(null);

  useEffect(() => { installDocUnloadGuard(); }, []);

  // Load once; keep-alive afterwards (scope switch back reuses the buffer).
  // Finding 3/4: the landing mode is decided here — previewable kinds honor
  // the per-kind preference (preview by default), everything else editable
  // opens straight into edit mode.
  useEffect(() => {
    const entry = ensureDoc(scope, path);
    if (entry.doc || entry.loading) return;
    entry.loading = true;
    bumpDocs();
    api.filesRead(projectId, path, sid)
      .then((got) => {
        entry.doc = got;
        entry.buf = got.content;
        entry.live = loadedLiveFile(got.revision);
        const canEdit = !got.truncated && got.tooLarge !== true;
        const prefsNow = getEditorPrefs();
        entry.editing = canEdit && !initialPreviewVisible(path, prefsNow.openInPreview, prefsNow.previewByKind);
        entry.loading = false;
        bumpDocs();
      })
      .catch((err) => {
        entry.error = msg(err);
        entry.loading = false;
        bumpDocs();
      });
  }, [scope, path, projectId, sid]);

  // Pending location from a file reference (chat) — consume once the doc is in.
  useEffect(() => {
    if (!visible || !doc || !location || location.path !== doc.path) return;
    if (location.startLine !== undefined) {
      gotoLine(location.startLine, location.endLine);
    }
    clearEditorLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, doc, location]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 1800);
    return () => clearTimeout(t);
  }, [flash]);

  /** Flip preview↔edit (finding 3). User-driven flips persist per kind. */
  const setPreviewMode = (on: boolean, opts: { persist?: boolean } = {}) => {
    if (!doc || readOnly) return;
    td.editing = !on;
    bumpDocs();
    setSelHint(null);
    const kind = previewKindForPath(doc.path);
    if (opts.persist !== false && kind) setEditorPreviewDefault(kind, on);
  };

  const MENU_W = 210;
  const MENU_H = 300;
  const openMenu = (x: number, y: number) => {
    setMenu(clampMenuPosition(x, y, MENU_W, MENU_H, window.innerWidth, window.innerHeight));
  };
  useEscape(menu !== null, () => setMenu(null));

  const gotoLine = (start: number, end?: number) => {
    const last = end !== undefined && end >= start ? end : start;
    if (doc && !readOnly) {
      // Editable files select the range in the textarea (finding 4: editing
      // IS the source view now).
      if (!td.editing) setPreviewMode(false, { persist: false });
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        const rows = ta.value.split("\n");
        const from = Math.min(Math.max(1, start), rows.length);
        const to = Math.min(Math.max(from, last), rows.length);
        const offsetOf = (line: number) => rows.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
        const startOff = offsetOf(from);
        const endOff = Math.min(ta.value.length, offsetOf(to) + (rows[to - 1]?.length ?? 0));
        ta.focus();
        ta.setSelectionRange(startOff, endOff);
        const lineHeight = parseFloat(window.getComputedStyle(ta).lineHeight) || 19;
        ta.scrollTop = Math.max(0, (from - 3) * lineHeight);
        syncEditScroll();
      });
      return;
    }
    setHlRange([start, last]);
    requestAnimationFrame(() => {
      const row = bodyRef.current?.querySelector(`[data-ln="${start}"]`);
      row?.scrollIntoView({ block: "center" });
    });
  };

  /** Keep the highlight backdrop and gutter glued to the textarea scroll. */
  const syncEditScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
    if (hlRef.current) {
      hlRef.current.scrollTop = ta.scrollTop;
      hlRef.current.scrollLeft = ta.scrollLeft;
    }
  };

  const setBuf = (text: string) => {
    const e = ensureDoc(scope, path);
    e.buf = text;
    const isDirty = !!e.doc && text !== e.doc.content;
    if (e.live) e.live = isDirty ? editLiveFile(e.live) : restoreLiveFileBuffer(e.live);
    bumpDocs();
  };

  // ---- chat inserts ----------------------------------------------------------
  const insertToChat = (text: string) => {
    requestComposerInsert(text);
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

  // ---- contextual selection hint (finding 5) -----------------------------------
  // A small floating "add to chat" affordance that exists ONLY while a text
  // selection is active in this file — never a permanent toolbar button.
  const placeHint = (x: number, y: number) =>
    setSelHint(clampMenuPosition(x, y, 34, 30, window.innerWidth, window.innerHeight));

  /** Edit mode: pointer selections anchor at the pointer; keyboard selections
   *  fall back to a caret-line approximation. Collapsed selections clear it. */
  const updateEditHint = (at?: { x: number; y: number }) => {
    const ta = taRef.current;
    if (!ta || ta.selectionStart === ta.selectionEnd) {
      setSelHint(null);
      return;
    }
    if (at) {
      placeHint(at.x, at.y);
      return;
    }
    const rect = ta.getBoundingClientRect();
    const lineHeight = parseFloat(window.getComputedStyle(ta).lineHeight) || 19;
    const line = ta.value.slice(0, ta.selectionEnd).split("\n").length;
    const y = rect.top + 8 + line * lineHeight - ta.scrollTop;
    placeHint(rect.left + 24, Math.min(Math.max(y, rect.top + 4), rect.bottom - 34));
  };

  // Read/preview modes: follow the DOM selection inside this pane's body.
  useEffect(() => {
    if (!visible || editing) return;
    const onSelectionChange = () => {
      const s = window.getSelection();
      const container = bodyRef.current;
      if (!s || s.isCollapsed || s.rangeCount === 0 || !container
        || !container.contains(s.getRangeAt(0).commonAncestorContainer)) {
        setSelHint(null);
        return;
      }
      const range = s.getRangeAt(0);
      const rects = range.getClientRects();
      const r = rects.length > 0 ? rects[rects.length - 1]! : range.getBoundingClientRect();
      placeHint(r.right + 6, r.bottom + 8);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, editing]);

  // Mode, file, or visibility changes invalidate the hint position.
  useEffect(() => { setSelHint(null); }, [visible, editing, path]);

  // ---- revision-guarded save / reload / check ----------------------------------
  const save = async (opts: { force?: boolean } = {}) => {
    const e = ensureDoc(scope, path);
    if (!e.doc || e.doc.truncated || e.doc.tooLarge) return;
    const content = e.buf;
    e.live = beginLiveFileSave(e.live ?? loadedLiveFile(e.doc.revision));
    bumpDocs();
    try {
      // This revision came from filesRead; only an explicit conflict overwrite
      // omits it. Autosave can therefore never silently clobber an external edit.
      const base = opts.force ? undefined : e.doc.revision;
      const res = await api.filesWrite(projectId, path, content, base, sid);
      const stillDirty = e.buf !== content;
      e.doc = { ...e.doc, content, revision: res.revision };
      e.live = completeLiveFileSave(e.live, res.revision, stillDirty);
      e.error = "";
      if (!stillDirty) setFlash("Saved ✓");
    } catch (err) {
      if (httpStatusOf(err) === 409) {
        e.live = conflictLiveFile(e.live);
      } else {
        e.error = msg(err);
        e.live = editLiveFile(e.live);
      }
    } finally {
      bumpDocs();
    }
  };

  const reload = async () => {
    const e = ensureDoc(scope, path);
    try {
      const got = await api.filesRead(projectId, path, sid);
      e.doc = got;
      e.buf = got.content;
      e.live = loadedLiveFile(got.revision);
      e.error = "";
    } catch (err) {
      e.error = msg(err);
    }
    bumpDocs();
  };

  const checkFile = async () => {
    const e = ensureDoc(scope, path);
    if (!e.doc || !e.live) return;
    try {
      const stat = await api.filesStat(projectId, path, sid);
      e.live = checkLiveFile(e.live, { kind: "present", revision: stat.revision });
    } catch (err) {
      e.live = httpStatusOf(err) === 404
        ? checkLiveFile(e.live, { kind: "deleted" })
        : checkLiveFile(e.live, { kind: "failed", message: msg(err) });
    }
    bumpDocs();
  };

  // Autosave owns its debounce; IME composition pauses it; conflicted /
  // deleted / check-failed states remain paused (autosaveDelay).
  const docTick = docsVersion();
  useEffect(() => {
    const e = ensureDoc(scope, path);
    if (!e.doc || !e.live) return;
    const delay = autosaveDelay(e.live, {
      enabled: prefs.editorAutosave,
      editing: e.editing,
      composing: e.composing,
      readOnly: e.doc.truncated || e.doc.tooLarge === true,
    }, AUTOSAVE_MS);
    if (delay === null) return;
    const timer = setTimeout(() => void save(), delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, path, prefs.editorAutosave, docTick]);

  // One revision-check owner per document — paused while hidden (keep-alive
  // must not authorize duplicate or invisible polling).
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
  }, [visible, scope, path]);

  // ---- rename / delete ---------------------------------------------------------
  const rename = async () => {
    const to = renameTo?.trim();
    if (!doc || !to || to === doc.path) {
      setRenameTo(null);
      return;
    }
    setBusy(true);
    try {
      await api.filesRename(projectId, doc.path, to, sid);
      moveDoc(scope, doc.path, to);
      actions?.renameSelf("file", doc.path, to, baseOf(to));
      setRenameTo(null);
      announceFilesChanged();
    } catch (err) {
      td.error = msg(err);
      bumpDocs();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!doc) return;
    setBusy(true);
    try {
      await api.filesDelete(projectId, doc.path, sid);
      setConfirmDel(false);
      deleteDoc(scope, doc.path);
      actions?.closeSelf("file", doc.path);
      announceFilesChanged();
    } catch (err) {
      td.error = msg(err);
      bumpDocs();
    } finally {
      setBusy(false);
    }
  };

  // ---- keyboard: save, selection→chat, go-to-line, Escape ladder ---------------
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
      } else if (e.key === "Escape") {
        if (menu) return; // the menu's own capture-phase Escape closes it
        if (gotoOpen) { setGotoOpen(false); return; }
        if (selHint) { setSelHint(null); return; }
        if (confirmDel) { setConfirmDel(false); return; }
        if (renameTo !== null) return; // the rename input owns Esc
        actions?.closeSelf("file", path); // dirty guard applies in the host
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // ---- render -----------------------------------------------------------------
  const lang = doc ? langOf(doc.path) : "";
  const lines = useMemo(
    () => (doc && !editing ? highlightLines(doc.content, lang) : []),
    [doc, editing, lang],
  );
  const bufLineCount = useMemo(() => (editing ? buf.split("\n").length : 0), [editing, buf]);
  const gutterText = useMemo(
    () => Array.from({ length: bufLineCount }, (_, i) => i + 1).join("\n"),
    [bufLineCount],
  );
  // Finding 4: highlight WHILE editing — a backdrop <pre> mirrors the buffer
  // under a transparent-text textarea. Very large buffers fall back to the
  // plain textarea (same cap as the read view's per-line rows).
  const editHl = useMemo(
    () => (editing && !readOnly && doc && bufLineCount <= MAX_ROWED_LINES ? highlight(buf, lang) : null),
    [editing, readOnly, doc, buf, bufLineCount, lang],
  );
  useEffect(() => { syncEditScroll(); }, [editHl, wrap]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Previewable kinds keep their switch visible in BOTH modes (finding 3). */
  const previewKind = doc && !readOnly ? previewKindForPath(doc.path) : null;
  const previewName = previewKind === "json" ? tr("markdown.render.tree") : tr("previewview.preview");
  // Previews render the LIVE buffer, not the saved snapshot — flipping the
  // switch while dirty must show the pending edits (they equal doc.content
  // when clean).
  const jsonValue = useMemo(
    () => (previewKind === "json" && doc && !editing ? tryParseJson(buf) : undefined),
    [previewKind, doc, editing, buf],
  );

  if (td.loading || (!doc && !error)) {
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
          description={error}
        />
      </div>
    );
  }

  return (
    <>
      <div className="editor-head">
        <span className="editor-path" title={doc.path}>
          {doc.path}
          {dirty && (
            <span className="editor-dirty" title={tr("editor.filepane.unsavedChanges")}>
              {" "}•
            </span>
          )}
        </span>
        <span className="header-spacer" />
        {live?.kind === "saving" && <span className="editor-save-state">{tr("common.saving")}</span>}
        {live?.kind === "saved" && <span className="editor-save-state">{tr("common.saved")}</span>}
        {flash && <span className="editor-flash">{flash}</span>}
        <IconButton
          icon={CloseIcon}
          size="sm"
          label={tr("editor.filepane.closeFile")}
          title={tr("editor.filepane.closeFileEsc")}
          onClick={() => actions?.closeSelf("file", path)}
        />
      </div>
      <div className="editor-toolbar">
        {previewKind !== null && (
          <span className="editor-mode-switch">
            <span className={`editor-mode-label${editing ? " on" : ""}`}>{tr("common.edit")}</span>
            <Switch
              checked={!editing}
              label={tr("editor.filepane.valueMode", { previewName: previewName })}
              onChange={() => setPreviewMode(editing)}
            />
            <span className={`editor-mode-label${!editing ? " on" : ""}`}>{previewName}</span>
          </span>
        )}
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
        {!readOnly && (editing || dirty) && (
          <IconButton
            icon={CheckIcon}
            size="sm"
            disabled={live?.kind === "saving" || !dirty}
            title={tr("editor.filepane.saveValueS", { MOD: MOD })}
            label={tr("editor.filepane.saveFile")}
            onClick={() => void save()}
          />
        )}
        <IconButton
          icon={MoreIcon}
          size="sm"
          className="editor-more-btn"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          label={tr("editor.filepane.actionsForValue", { path: doc.path })}
          title={tr("editor.filepane.fileActions")}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.right - MENU_W, r.bottom + 4);
          }}
        />
      </div>
      {menu && (
        <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div
            className="ctx-menu"
            role="menu"
            aria-label={tr("editor.filepane.actionsForValue", { path: doc.path })}
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button role="menuitem" onClick={() => { setMenu(null); addFile(); }}>{tr("editor.filepane.addFileToChat")}</button>
            <button role="menuitem" onClick={() => { setMenu(null); addSelection(); }}>{tr("editor.filepane.addSelectionToChatValueL", { MOD: MOD })}</button>
            <button role="menuitem" onClick={() => { setMenu(null); void copyText(doc.path); }}>{tr("editor.filepane.copyPath")}</button>
            <button role="menuitem" onClick={() => { setMenu(null); setGotoOpen(true); }}>{tr("editor.filepane.goToLineValueG", { MOD: MOD })}</button>
            <button role="menuitemcheckbox" aria-checked={wrap} onClick={() => setWrap((v) => !v)}>
              {wrap ? tr("editor.filepane.wrapLines") : tr("editor.filepane.wrapLines2")}
            </button>
            {!readOnly && dirty && (
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  void confirmAlert(tr("editor.filepane.discardUnsavedChanges"), { title: tr("common.discardChanges"), confirmLabel: tr("common.discard") }).then((ok) => { if (ok) setBuf(doc.content); });
                }}
              >
                {tr("editor.filepane.discardChanges")}</button>
            )}
            <button role="menuitem" onClick={() => { setMenu(null); setRenameTo(doc.path); }}>{tr("editor.filepane.renameMove")}</button>
            <button role="menuitem" className="danger" onClick={() => { setMenu(null); setConfirmDel(true); }}>{tr("editor.filepane.delete")}</button>
          </div>
        </div>
      )}
      {selHint && (
        <button
          className="editor-sel-hint"
          style={{ left: selHint.x, top: selHint.y }}
          aria-label={tr("editor.filepane.addSelectionToChatValueL", { MOD: MOD })}
          title={tr("editor.filepane.addSelectionToChatValueL", { MOD: MOD })}
          onPointerDown={(e) => e.preventDefault() /* keep the selection + focus */}
          onClick={() => { addSelection(); setSelHint(null); }}
        >
          @
        </button>
      )}
      {renameTo !== null && (
        <div className="files-create editor-rename">
          <TextInput
            uiSize="sm"
            autoFocus
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            onKeyDown={(e) => {
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
            {tr("editor.filepane.fileChangedOnDisk")}{live.dirty ? tr("editor.filepane.yourUnsavedBufferIsPreserved") : tr("editor.filepane.reloadToViewTheReplacement")}
          </span>
          <Button size="sm" onClick={() => void reload()}>{tr("editor.filepane.reloadFromDisk")}</Button>
          {live.dirty && <Button size="sm" variant="danger" onClick={() => void save({ force: true })}>{tr("editor.filepane.overwrite")}</Button>}
          <IconButton icon={CloseIcon} size="sm" label={tr("editor.filepane.dismissFileChangeNotice")} onClick={() => { if (td.live) td.live = dismissLiveFileNotice(td.live); bumpDocs(); }} />
        </div>
      )}
      {live && !live.noticeDismissed && live.kind === "deleted" && (
        <div className="editor-banner editor-conflict" role="alert">
          <span>{tr("editor.filepane.fileWasDeletedOnDisk")}{live.dirty ? tr("editor.filepane.savingRecreatesItYourBufferIsPreserved") : ""}</span>
          {live.dirty && <Button size="sm" variant="danger" onClick={() => void save({ force: true })}>{tr("editor.filepane.recreate")}</Button>}
          <IconButton icon={CloseIcon} size="sm" label={tr("editor.filepane.dismissDeletedFileNotice")} onClick={() => { if (td.live) td.live = dismissLiveFileNotice(td.live); bumpDocs(); }} />
        </div>
      )}
      {live && !live.noticeDismissed && live.kind === "check-failed" && (
        <div className="editor-banner" role="alert">
          <span>{tr("editor.filepane.couldnTCheckForExternalChanges")}{" "}{live.message}</span>
          <Button size="sm" onClick={() => void checkFile()}>{tr("common.retry")}</Button>
          <IconButton icon={CloseIcon} size="sm" label={tr("editor.filepane.dismissFileCheckNotice")} onClick={() => { if (td.live) td.live = dismissLiveFileNotice(td.live); bumpDocs(); }} />
        </div>
      )}
      {doc.truncated && <div className="editor-banner">{tr("editor.filepane.truncatedFileExceeds512KbReadOnly")}</div>}
      {doc.tooLarge && <div className="editor-banner">{tr("editor.filepane.binaryFileDetectedReadOnly")}</div>}
      {error && <div className="files-error editor-error">{error}</div>}
      {editing && !readOnly ? (
        <div
          className="editor-edit"
          onContextMenu={(e) => {
            // The textarea keeps its native menu (paste, spell-check, …).
            if (e.target === taRef.current) return;
            e.preventDefault();
            openMenu(e.clientX, e.clientY);
          }}
        >
          {!wrap && (
            <pre className="editor-gutter" ref={gutterRef} aria-hidden="true">
              {gutterText}
            </pre>
          )}
          <div className="editor-edit-surface">
            {editHl !== null && (
              <pre
                className={`editor-hl-backdrop${wrap ? " wrap" : ""}`}
                ref={hlRef}
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: `${editHl}\n ` }}
              />
            )}
            <textarea
              ref={taRef}
              className={`editor-ta${editHl !== null ? " editor-ta-hl" : ""}`}
              value={buf}
              wrap={wrap ? "soft" : "off"}
              spellCheck={false}
              aria-label={tr("editor.filepane.editValue", { path: doc.path })}
              onChange={(e) => setBuf(e.target.value)}
              onCompositionStart={() => { td.composing = true; bumpDocs(); }}
              onCompositionEnd={() => { td.composing = false; bumpDocs(); }}
              onPointerUp={(e) => updateEditHint({ x: e.clientX + 10, y: e.clientY + 14 })}
              onKeyUp={(e) => { if (e.shiftKey || selHint) updateEditHint(); }}
              onScroll={syncEditScroll}
            />
          </div>
        </div>
      ) : previewKind === "markdown" && !editing ? (
        <div className="editor-body editor-md-preview" ref={bodyRef}>
          <div className="editor-md-content">
            <MarkdownDoc text={buf} keyBase={`md-${doc.path}`} />
          </div>
        </div>
      ) : previewKind === "html" && !editing ? (
        <div className="editor-body editor-html-preview" ref={bodyRef}>
          <iframe
            className="html-preview-frame"
            title={tr("editor.filepane.previewOfValue", { path: doc.path })}
            sandbox="allow-scripts"
            srcDoc={htmlPreviewDocument(buf, `${window.location.origin}/`)}
          />
          <div className="html-preview-note muted">
            {tr("editor.filepane.sandboxedPreviewScriptsAreIsolatedAndNetwork")}</div>
        </div>
      ) : previewKind === "json" && !editing ? (
        <div className="editor-body editor-json-preview" ref={bodyRef}>
          {jsonValue !== undefined ? (
            <JsonTree value={jsonValue} defaultDepth={prefs.jsonTreeDepth} />
          ) : (
            <div className="editor-banner">{tr("editor.filepane.notValidJsonShowingSourceInstead")}</div>
          )}
          {jsonValue === undefined && (
            <pre className="code-view editor-plain">{buf}</pre>
          )}
        </div>
      ) : (
        <div
          className="editor-body"
          ref={bodyRef}
          onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY); }}
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
    // Files stay resolvable (a missing file errors honestly on open).
    available: () => true,
    dirty: (scope, path) => isDocDirty(docScopeKey(scope.projectId, scope.sessionId), path),
    subscribe: subscribeDocs,
    component: FilePane,
  });
}

registerFilePaneProvider();

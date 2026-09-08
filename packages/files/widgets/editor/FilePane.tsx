// UX-PANE-MODEL / EXTENSION-SEAMS slice 3: ONE file document's lifecycle —
// read, edit, preview, revision-guarded save/autosave, IME pause, conflict,
// external replacement, deletion, Reload/Overwrite/Recreate/Retry — behind
// the "file" pane provider. Live text lives in the editor runtime (pull
// model); this pane is chrome + preview. Keep-alive (hidden, inert) is
// PaneHost; revision polling pauses while hidden.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@polyth/session/web-api";
import { clearEditorLocation, useStore } from "../../../../apps/web/src/store.ts";
import { MarkdownDoc } from "../../../../apps/web/src/markdown.tsx";
import JsonTree, { tryParseJson } from "../../../../apps/web/src/markdown/JsonTree.tsx";
import { highlightLines, langOf } from "../../../../apps/web/src/highlight.ts";
import { formatFileChat, formatSelectionChat } from "../../../../apps/web/src/chatclip.ts";
import { requestComposerInsert } from "../../../../apps/web/src/composerInsert.ts";
import { MOD } from "../../../../apps/web/src/format.ts";
import { clampMenuPosition } from "../../../../apps/web/src/selectionActions.ts";
import { copyText } from "../../../../apps/web/src/utils.ts";
import { getEditorPrefs, setEditorPreviewDefault, useUiSettings } from "../../../../apps/web/src/uiPrefs.ts";
import { confirmAlert } from "../../../../apps/web/src/alerts.ts";
import {
  EditorSurfaceSlot,
  readEditorSelection,
  resourceViewsVersion,
  subscribeResourceViews,
} from "../../../../apps/web/src/resources/views.ts";
import {
  deleteDoc, docsVersion, fileResourceRef, installDocUnloadGuard,
  isDocDirty, moveDoc, openFileDoc, peekFileDoc, subscribeDocs,
} from "./fileDocs.ts";
import {
  Button,
  CheckIcon,
  CloseIcon,
  IconButton,
  Menu,
  MoreIcon,
  Spinner,
  Switch,
  TextInput,
  type MenuEntry,
} from "../../../../apps/web/src/components/ui/index.ts";
import {
  htmlPreviewDocument,
  initialPreviewVisible,
  previewKindForPath,
} from "../../../../apps/web/src/resources/liveFile.ts";
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
const FILE_REFRESH_MS = 8_000;

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
export function announceFilesChanged(): void {
  window.dispatchEvent(new CustomEvent("polyth:files-changed"));
}

const FILES_GROUP_ID = "files";

export default function FilePane({ projectId, sessionId, resource: path, visible }: PaneResourceContext) {
  const sid = sessionId ?? undefined;
  const resourceRef = useMemo(() => fileResourceRef(projectId, sessionId, path), [projectId, sessionId, path]);
  const prefs = useUiSettings();
  const location = useStore((s) => s.editorLocation);
  const actions = usePaneActions();
  useSyncExternalStore(subscribeDocs, docsVersion);
  useSyncExternalStore(subscribeResourceViews, resourceViewsVersion);

  useEffect(() => {
    void openFileDoc(projectId, sessionId, path).load();
  }, [projectId, sessionId, path]);

  useEffect(() => () => {
    deleteDoc(projectId, sessionId, path);
  }, [projectId, sessionId, path]);

  const td = peekFileDoc(projectId, sessionId, path);
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
    bufferVersion: 0,
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [selHint, setSelHint] = useState<{ x: number; y: number } | null>(null);
  const [reveal, setReveal] = useState<{ startLine: number; endLine: number } | null>(null);

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

  const setPreviewMode = (on: boolean, opts: { persist?: boolean } = {}) => {
    if (!doc || readOnly || !td) return;
    td.editing = !on;
    setSelHint(null);
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
    setFlash("Added to chat ✓");
  };

  const addSelection = () => {
    if (!doc) return;
    if (editing) {
      const sel = readEditorSelection(resourceRef);
      if (!sel) {
        setFlash("Select some text first");
        return;
      }
      insertToChat(formatSelectionChat(doc.path, sel.text, sel.startLine, sel.endLine));
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
    insertToChat(readOnly || !td ? `@${doc.path}` : formatFileChat(doc.path, td.handle.getBuffer(), INLINE_FILE_CHARS));
  };

  const placeHint = (x: number, y: number) =>
    setSelHint(clampMenuPosition(x, y, 34, 30, window.innerWidth, window.innerHeight));

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

  useEffect(() => { setSelHint(null); }, [visible, editing, path]);

  const save = async (opts: { force?: boolean } = {}) => {
    if (!td) return;
    await td.handle.save(opts);
    if (td.handle.getSnapshot().live?.kind === "saved") setFlash("Saved ✓");
  };

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
  }, [visible, projectId, sessionId, path]);

  const rename = async () => {
    const to = renameTo?.trim();
    if (!doc || !to || to === doc.path) {
      setRenameTo(null);
      return;
    }
    setBusy(true);
    try {
      await api.filesRename(projectId, doc.path, to, sid);
      moveDoc(projectId, sessionId, doc.path, to);
      actions?.renameSelf("file", doc.path, to, baseOf(to));
      setRenameTo(null);
      announceFilesChanged();
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
      await api.filesDelete(projectId, doc.path, sid);
      setConfirmDel(false);
      deleteDoc(projectId, sessionId, doc.path);
      actions?.closeSelf("file", doc.path);
      announceFilesChanged();
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
      } else if (e.key === "Escape") {
        if (menuOpen) return;
        if (gotoOpen) { setGotoOpen(false); return; }
        if (selHint) { setSelHint(null); return; }
        if (confirmDel) { setConfirmDel(false); return; }
        if (renameTo !== null) return;
        actions?.closeSelf("file", path);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const lang = doc ? langOf(doc.path) : "";
  const mediaKind = doc && doc.tooLarge ? mediaKindOf(doc.path) : null;
  const rawUrl = doc ? api.filesRawUrl(projectId, doc.path, sid) : "";
  const lines = useMemo(
    () => (doc && !editing ? highlightLines(previewText, lang) : []),
    [doc, editing, lang, previewText],
  );
  const previewKind = doc && !readOnly ? previewKindForPath(doc.path) : null;
  const previewName = previewKind === "json" ? tr("markdown.render.tree") : tr("previewview.preview");
  const jsonValue = useMemo(
    () => (previewKind === "json" && doc && !editing ? tryParseJson(previewText) : undefined),
    [previewKind, doc, editing, previewText],
  );
  const shownError = opError || error;

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
        <Menu
          label={tr("editor.filepane.actionsForValue", { path: doc.path })}
          title={tr("editor.filepane.fileActions")}
          align="end"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          entries={([
            { id: "add-file", label: tr("editor.filepane.addFileToChat"), onSelect: () => addFile() },
            { id: "add-selection", label: tr("editor.filepane.addSelectionToChatValueL", { MOD }), onSelect: () => addSelection() },
            { id: "copy-path", label: tr("editor.filepane.copyPath"), onSelect: () => void copyText(doc.path) },
            { id: "goto", label: tr("editor.filepane.goToLineValueG", { MOD }), onSelect: () => setGotoOpen(true) },
            {
              id: "wrap",
              label: wrap ? tr("editor.filepane.wrapLines") : tr("editor.filepane.wrapLines2"),
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
          ] satisfies MenuEntry[])}
        >
          {(trigger) => (
            <IconButton
              {...trigger}
              icon={MoreIcon}
              size="sm"
              className="editor-more-btn"
              label={tr("editor.filepane.actionsForValue", { path: doc.path })}
              title={tr("editor.filepane.fileActions")}
            />
          )}
        </Menu>
      </div>
      {selHint && (
        <button
          className="editor-sel-hint"
          style={{ left: selHint.x, top: selHint.y }}
          aria-label={tr("editor.filepane.addSelectionToChatValueL", { MOD: MOD })}
          title={tr("editor.filepane.addSelectionToChatValueL", { MOD: MOD })}
          onPointerDown={(e) => e.preventDefault()}
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
      {snap.binary && <div className="editor-banner">{tr("editor.filepane.binaryFileDetectedReadOnly")}</div>}
      {shownError && <div className="form-error editor-error">{shownError}</div>}
      {editing && !readOnly ? (
        <div className="editor-edit">
          <EditorSurfaceSlot
            groupId={FILES_GROUP_ID}
            ref={resourceRef}
            path={doc.path}
            readOnly={readOnly}
            wrap={wrap}
            ariaLabel={tr("editor.filepane.editValue", { path: doc.path })}
            visible={visible}
            onSave={() => { if (dirty && !readOnly) void save(); }}
            reveal={reveal}
            onRevealConsumed={() => setReveal(null)}
          />
        </div>
      ) : previewKind === "markdown" && !editing ? (
        <div className="editor-body editor-md-preview" ref={bodyRef}>
          <div className="editor-md-content">
            <MarkdownDoc text={previewText} keyBase={`md-${doc.path}`} />
          </div>
        </div>
      ) : previewKind === "html" && !editing ? (
        <div className="editor-body editor-html-preview" ref={bodyRef}>
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
        <div className="editor-body editor-json-preview" ref={bodyRef}>
          {jsonValue !== undefined ? (
            <JsonTree value={jsonValue} defaultDepth={prefs.jsonTreeDepth} />
          ) : (
            <div className="editor-banner">{tr("editor.filepane.notValidJsonShowingSourceInstead")}</div>
          )}
          {jsonValue === undefined && (
            <pre className="code-view editor-plain">{previewText}</pre>
          )}
        </div>
      ) : mediaKind ? (
        <div className="editor-body editor-media">
          {mediaKind === "image" && <img className="editor-media-item" src={rawUrl} alt={doc.path} />}
          {mediaKind === "video" && <video className="editor-media-item" src={rawUrl} controls preload="metadata" />}
          {mediaKind === "audio" && <audio className="editor-media-item" src={rawUrl} controls preload="metadata" />}
          {mediaKind === "pdf" && <iframe className="editor-media-item" src={rawUrl} title={doc.path} />}
        </div>
      ) : snap.binary ? (
        <div className="editor-body editor-media">
          <iframe className="editor-media-item" src={rawUrl} title={doc.path} />
          <a className="editor-file-download" href={rawUrl} download={doc.path.split(/[\\/]/).pop()}>Download {doc.path}</a>
        </div>
      ) : (
        <div
          className="editor-body"
          ref={bodyRef}
          onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}
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
    dirty: (scope, resourcePath) => isDocDirty(scope.projectId, scope.sessionId, resourcePath),
    discard: (scope, resourcePath) => {
      peekFileDoc(scope.projectId, scope.sessionId, resourcePath)?.handle.discard();
    },
    close: (scope, resourcePath) => {
      deleteDoc(scope.projectId, scope.sessionId, resourcePath);
    },
    subscribe: subscribeDocs,
    component: FilePane,
  });
}

registerFilePaneProvider();

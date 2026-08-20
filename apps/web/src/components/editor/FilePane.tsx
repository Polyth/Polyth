// UX-PANE-MODEL / EXTENSION-SEAMS slice 3: ONE file document's lifecycle —
// read, edit, preview, revision-guarded save/autosave, IME pause, conflict,
// external replacement, deletion, Reload/Overwrite/Recreate/Retry — behind
// the "file" pane provider. The buffer lives in editor/fileDocs.ts scoped by
// canonical projectId + (sessionId ?? "project"), so it survives tab,
// surface, session, and presentation switches without ever leaking into
// another scope. This component is kept alive (hidden, inert) by PaneHost;
// its UI-only revision polling pauses while hidden.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, httpStatusOf } from "../../api.ts";
import { clearEditorLocation, getState, useStore } from "../../store.ts";
import { MarkdownDoc } from "../../markdown.tsx";
import JsonTree, { tryParseJson } from "../../markdown/JsonTree.tsx";
import { highlightLines, langOf } from "../../highlight.ts";
import { formatFileChat, formatSelectionChat, lineRangeOf } from "../../chatclip.ts";
import { requestComposerInsert } from "../../composerInsert.ts";
import { createSession } from "../../init.ts";
import { MOD } from "../../format.ts";
import { setEditorPrefs, useEditorPrefs, useUiSettings } from "../../uiPrefs.ts";
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
} from "../../editor/liveFile.ts";
import {
  bumpDocs, deleteDoc, docScopeKey, docsVersion, ensureDoc, installDocUnloadGuard,
  isDocDirty, moveDoc, subscribeDocs,
} from "../../editor/fileDocs.ts";
import { registerPaneProvider, type PaneResourceContext } from "../../workspace/paneProviders.ts";
import { usePaneActions } from "../workspace/PaneHost.tsx";

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
  const prefs = useUiSettings();
  const editorPrefs = useEditorPrefs();
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
  const [previewOn, setPreviewOn] = useState(() => initialPreviewVisible(path, editorPrefs.openInPreview));

  const bodyRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);

  useEffect(() => { installDocUnloadGuard(); }, []);

  // Load once; keep-alive afterwards (scope switch back reuses the buffer).
  useEffect(() => {
    const entry = ensureDoc(scope, path);
    if (entry.doc || entry.loading) return;
    entry.loading = true;
    bumpDocs();
    api.filesRead(projectId, path)
      .then((got) => {
        entry.doc = got;
        entry.buf = got.content;
        entry.live = loadedLiveFile(got.revision);
        entry.loading = false;
        bumpDocs();
      })
      .catch((err) => {
        entry.error = msg(err);
        entry.loading = false;
        bumpDocs();
      });
  }, [scope, path, projectId]);

  // Pending location from a file reference (chat) — consume once the doc is in.
  useEffect(() => {
    if (!visible || !doc || !location || location.path !== doc.path) return;
    if (location.startLine !== undefined) {
      setPreviewOn(false); // ranges need the line-numbered source view
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

  const gotoLine = (start: number, end?: number) => {
    const last = end !== undefined && end >= start ? end : start;
    setHlRange([start, last]);
    requestAnimationFrame(() => {
      const row = bodyRef.current?.querySelector(`[data-ln="${start}"]`);
      row?.scrollIntoView({ block: "center" });
    });
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
      const res = await api.filesWrite(projectId, path, content, base);
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
      const got = await api.filesRead(projectId, path);
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
      const stat = await api.filesStat(projectId, path);
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
      await api.filesRename(projectId, doc.path, to);
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
      await api.filesDelete(projectId, doc.path);
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
        if (editing && dirty && !readOnly) void save();
      } else if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        addSelection();
      } else if (mod && e.key.toLowerCase() === "g" && doc) {
        e.preventDefault();
        setGotoOpen(true);
      } else if (e.key === "Escape") {
        if (gotoOpen) { setGotoOpen(false); return; }
        if (renameTo !== null || confirmDel) return; // inner dialogs own Esc
        actions?.closeSelf("file", path); // dirty guard applies in the host
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // ---- render -----------------------------------------------------------------
  const lines = useMemo(
    () => (doc && !editing ? highlightLines(doc.content, langOf(doc.path)) : []),
    [doc, editing],
  );
  const gutterText = useMemo(
    () => (editing ? Array.from({ length: buf.split("\n").length }, (_, i) => i + 1).join("\n") : ""),
    [editing, buf],
  );
  const previewKind = doc && !editing && !readOnly ? previewKindForPath(doc.path) : null;
  const jsonValue = useMemo(
    () => (previewKind === "json" && doc ? tryParseJson(doc.content) : undefined),
    [previewKind, doc],
  );

  if (td.loading || (!doc && !error)) {
    return <div className="editor-empty"><p className="muted">Loading {path}…</p></div>;
  }
  if (!doc) {
    return (
      <div className="editor-empty">
        <p className="muted">Couldn’t open {path}.</p>
        {error && <div className="files-error">{error}</div>}
      </div>
    );
  }

  return (
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
        <button className="small-btn" title="Close file (Esc)" onClick={() => actions?.closeSelf("file", path)}>✕</button>
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
                  setBuf(doc.content);
                  td.editing = false;
                  bumpDocs();
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button className="small-btn" onClick={() => { td.editing = true; bumpDocs(); }}>Edit</button>
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
              else if (e.key === "Escape") setRenameTo(null);
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
          <button className="small-btn" onClick={() => void reload()}>Reload from disk</button>
          {live.dirty && <button className="small-btn danger-btn" onClick={() => void save({ force: true })}>Overwrite</button>}
          <button className="small-btn" aria-label="Dismiss file change notice" onClick={() => { if (td.live) td.live = dismissLiveFileNotice(td.live); bumpDocs(); }}>×</button>
        </div>
      )}
      {live && !live.noticeDismissed && live.kind === "deleted" && (
        <div className="editor-banner editor-conflict" role="alert">
          <span>File was deleted on disk.{live.dirty ? " Saving recreates it; your buffer is preserved." : ""}</span>
          {live.dirty && <button className="small-btn danger-btn" onClick={() => void save({ force: true })}>Recreate</button>}
          <button className="small-btn" aria-label="Dismiss deleted file notice" onClick={() => { if (td.live) td.live = dismissLiveFileNotice(td.live); bumpDocs(); }}>×</button>
        </div>
      )}
      {live && !live.noticeDismissed && live.kind === "check-failed" && (
        <div className="editor-banner" role="alert">
          <span>Couldn’t check for external changes: {live.message}</span>
          <button className="small-btn" onClick={() => void checkFile()}>Retry</button>
          <button className="small-btn" aria-label="Dismiss file check notice" onClick={() => { if (td.live) td.live = dismissLiveFileNotice(td.live); bumpDocs(); }}>×</button>
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
            onChange={(e) => setBuf(e.target.value)}
            onCompositionStart={() => { td.composing = true; bumpDocs(); }}
            onCompositionEnd={() => { td.composing = false; bumpDocs(); }}
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

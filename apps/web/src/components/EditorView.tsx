// Full-screen IDE surface: file tree (~220px) on the left, editor filling the
// rest. Preview mode is highlighted + line-numbered and selectable; edit mode
// is a textarea with a synced gutter, Save/Cancel, dirty •, and Ctrl/Cmd+S.
// "Add selection/file to chat" goes through the composer insert queue, so it
// works even while the Composer is unmounted.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, type FileEntry, type FileReadResult } from "../api.ts";
import { getState, openEditorFile, setActiveView, useStore } from "../store.ts";
import { highlightLines, langOf } from "../highlight.ts";
import { formatFileChat, formatSelectionChat, lineRangeOf } from "../chatclip.ts";
import { requestComposerInsert } from "../composerInsert.ts";
import { createSession } from "../init.ts";
import { setDragPath } from "../dnd.ts";
import { MOD } from "../format.ts";
import { useEscape } from "../useEscape.ts";

interface Row {
  e: FileEntry;
  depth: number;
}

const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** Files at or below this size get inlined into "Add file to chat". */
const INLINE_FILE_CHARS = 4000;
/** Above this many lines, fall back to a plain block (no per-line rows). */
const MAX_ROWED_LINES = 8000;

export default function EditorView() {
  const projectId = useStore((s) => s.activeProjectId);
  const filePath = useStore((s) => s.editorFile);

  // ---- tree ----------------------------------------------------------------
  const [kids, setKids] = useState<Record<string, FileEntry[]>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [sel, setSel] = useState("");
  const [treeErr, setTreeErr] = useState("");

  // ---- editor ----------------------------------------------------------------
  const [doc, setDoc] = useState<FileReadResult | null>(null);
  const [buf, setBuf] = useState("");
  const [editing, setEditing] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);

  const dirty = doc !== null && buf !== doc.content;
  const readOnly = doc ? doc.truncated || doc.tooLarge === true : false;

  const loadDir = async (p: string) => {
    if (!projectId) return;
    try {
      const entries = await api.filesTree(projectId, p || undefined);
      setKids((k) => ({ ...k, [p]: entries }));
      setTreeErr("");
    } catch (err) {
      setTreeErr(msg(err));
    }
  };

  useEffect(() => {
    setKids({});
    setOpen(new Set());
    setSel("");
    if (projectId) void loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Load the open file; keep the tree mounted and its expansion untouched.
  useEffect(() => {
    if (!projectId || !filePath) {
      setDoc(null);
      setEditing(false);
      return;
    }
    let stale = false;
    api
      .filesRead(projectId, filePath)
      .then((got) => {
        if (stale) return;
        setDoc(got);
        setBuf(got.content);
        setEditing(false);
        setRenameTo(null);
        setConfirmDel(false);
        setError("");
      })
      .catch((err) => {
        if (!stale) setError(msg(err));
      });
    return () => {
      stale = true;
    };
  }, [projectId, filePath]);

  useEffect(() => {
    if (filePath) setSel(filePath);
  }, [filePath]);

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

  const confirmDiscard = () => !dirty || window.confirm("Discard unsaved changes?");

  const openFile = (fp: string) => {
    if (fp === filePath) return;
    if (!confirmDiscard()) return;
    openEditorFile(fp);
  };

  const closeFile = () => {
    if (!confirmDiscard()) return;
    openEditorFile(null);
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
    // Truncated/binary reads never inline — reference by path only.
    insertToChat(readOnly ? `@${doc.path}` : formatFileChat(doc.path, doc.content, INLINE_FILE_CHARS));
  };

  const attachPath = (fp: string) => insertToChat(`@${fp}`);

  // ---- file operations ---------------------------------------------------------
  const save = async () => {
    if (!projectId || !doc || readOnly) return;
    setBusy(true);
    try {
      await api.filesWrite(projectId, doc.path, buf);
      setDoc({ ...doc, content: buf });
      setError("");
      setFlash("Saved ✓");
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    const to = renameTo?.trim();
    if (!projectId || !doc || !to || to === doc.path) {
      setRenameTo(null);
      return;
    }
    setBusy(true);
    try {
      await api.filesRename(projectId, doc.path, to);
      await Promise.all([loadDir(parentOf(doc.path)), loadDir(parentOf(to))]);
      setRenameTo(null);
      openEditorFile(to);
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!projectId || !doc) return;
    setBusy(true);
    try {
      await api.filesDelete(projectId, doc.path);
      setConfirmDel(false);
      await loadDir(parentOf(doc.path));
      openEditorFile(null);
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  };

  useEscape(renameTo !== null, () => setRenameTo(null));

  // ---- keyboard: Ctrl/Cmd+S save, Ctrl/Cmd+L selection→chat, Esc back ---------
  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (editing && dirty && !readOnly) void save();
      } else if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        addSelection();
      } else if (e.key === "Escape") {
        if (renameTo !== null || confirmDel) return; // inner dialogs own Esc
        if (dirty && !window.confirm("Discard unsaved changes?")) return;
        if (filePath) openEditorFile(null);
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

  // ---- render -----------------------------------------------------------------
  const lines = useMemo(
    () => (doc && !editing ? highlightLines(doc.content, langOf(doc.path)) : []),
    [doc, editing],
  );
  const gutterText = useMemo(
    () => (editing ? Array.from({ length: buf.split("\n").length }, (_, i) => i + 1).join("\n") : ""),
    [editing, buf],
  );

  if (!projectId) return <div className="view-empty">Open a project to browse and edit files.</div>;

  return (
    <div className="editor-view">
      <aside className="editor-tree" tabIndex={0} onKeyDown={onTreeKey} aria-label="Project files">
        {treeErr && <div className="files-error">{treeErr}</div>}
        {rows.length === 0 && !treeErr && <div className="empty">Empty directory.</div>}
        {rows.map(({ e, depth }) => (
          <div
            key={e.path}
            className={`ft-row${sel === e.path || filePath === e.path ? " sel" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            draggable
            onDragStart={(ev) => setDragPath(ev.dataTransfer, e.path)}
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

      <section className="editor-pane">
        {doc ? (
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
              {flash && <span className="editor-flash">{flash}</span>}
              <button className="small-btn" title="Close file (Esc)" onClick={closeFile}>✕</button>
            </div>
            <div className="editor-toolbar">
              <button className="small-btn" title={`Add selection to chat (${MOD}L)`} onClick={addSelection}>
                Add selection to chat
              </button>
              <button className="small-btn" onClick={addFile}>Add file to chat</button>
              <span className="header-spacer" />
              <button className="small-btn" aria-pressed={wrap} onClick={() => setWrap((v) => !v)}>
                {wrap ? "Wrap ✓" : "Wrap"}
              </button>
              {!readOnly &&
                (editing ? (
                  <>
                    <button className="small-btn" disabled={busy || !dirty} title={`${MOD}S`} onClick={() => void save()}>
                      Save
                    </button>
                    <button
                      className="small-btn"
                      onClick={() => {
                        if (!confirmDiscard()) return;
                        setBuf(doc.content);
                        setEditing(false);
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="small-btn" onClick={() => setEditing(true)}>Edit</button>
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
                  onScroll={() => {
                    if (gutterRef.current && taRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop;
                  }}
                />
              </div>
            ) : (
              <div className="editor-body" ref={bodyRef}>
                {lines.length <= MAX_ROWED_LINES ? (
                  <div className={`code-lines${wrap ? " wrap" : ""}`}>
                    {lines.map((h, i) => (
                      <div key={i} className="cl-row" data-ln={i + 1}>
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
              Enter opens · @ adds to chat · {MOD}L sends a selection to the session
            </p>
            {error && <div className="files-error">{error}</div>}
          </div>
        )}
      </section>
    </div>
  );
}

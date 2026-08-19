// Files panel: nested lazy tree with keyboard nav, drag-out to the composer,
// drop-in uploads, and a syntax-highlighted viewer with inline editing.
import { useState, useEffect, useCallback, useRef, type DragEvent, type KeyboardEvent } from "react";
import { api, type FileEntry, type FileReadResult } from "../api.ts";
import { openEditorFile, useStore } from "../store.ts";
import { highlight, langOf } from "../highlight.ts";
import { setDragPath, uploadFiles } from "../dnd.ts";
import { requestComposerInsert } from "../composerInsert.ts";
import { useEscape } from "../useEscape.ts";
import CopyButton from "./CopyButton.tsx";

interface Row { e: FileEntry; depth: number }

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");

export default function FilesPanel() {
  const projectId = useStore((s) => s.activeProjectId);
  const [kids, setKids] = useState<Record<string, FileEntry[]>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [sel, setSel] = useState("");
  const [view, setView] = useState<FileReadResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[] | null>(null);
  const [newKind, setNewKind] = useState<"file" | "folder" | null>(null);
  const [newName, setNewName] = useState("");
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [wrapText, setWrapText] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadDir = useCallback(async (p: string) => {
    if (!projectId) return;
    try {
      const entries = await api.filesTree(projectId, p || undefined, hidden);
      setKids((k) => ({ ...k, [p]: entries }));
      setError("");
    } catch (err) {
      setError(msg(err));
    }
  }, [projectId, hidden]);

  useEffect(() => {
    setKids({}); setOpen(new Set()); setSel(""); setView(null);
    void loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Toggling hidden files refetches the visible dirs without resetting the tree (UX-14).
  const hiddenRef = useRef(hidden);
  useEffect(() => {
    if (hiddenRef.current === hidden) return;
    hiddenRef.current = hidden;
    void loadDir("");
    for (const p of open) void loadDir(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, loadDir]);

  const dirty = editing && view !== null && content !== view.content;
  const closeView = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setView(null); setEditing(false);
  };

  // Esc unwinds one layer at a time: confirm → rename → create → preview (UX-24).
  useEscape(confirmDel || renameTo !== null || newKind !== null || view !== null, () => {
    if (confirmDel) setConfirmDel(false);
    else if (renameTo !== null) setRenameTo(null);
    else if (newKind !== null) setNewKind(null);
    else closeView();
  });

  const toggle = (p: string) => {
    if (!open.has(p) && !kids[p]) void loadDir(p);
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(p)) n.delete(p); else n.add(p);
      return n;
    });
  };

  // Files open in the full-screen editor view — never a rail-width preview.
  const openFile = async (fp: string) => {
    openEditorFile(fp);
  };

  // Queues when no composer is mounted; lands on next mount (UX-15).
  const attach = (fp: string) => requestComposerInsert(`@${fp}`);

  // Flatten expanded dirs into visible rows (server already sorts dirs first).
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
      if (cur.dir) toggle(cur.path); else void openFile(cur.path);
    }
  };

  const onUpload = async (ev: DragEvent, dir: string) => {
    ev.preventDefault(); ev.stopPropagation();
    setDropDir(null);
    const files = Array.from(ev.dataTransfer.files);
    if (!projectId || files.length === 0) return;
    try {
      await uploadFiles(projectId, dir, files);
      await loadDir(dir);
      if (dir) setOpen((o) => new Set(o).add(dir));
    } catch (err) {
      setError(msg(err));
    }
  };

  const allowFileDrop = (ev: DragEvent, dir: string) => {
    if (!ev.dataTransfer.types.includes("Files")) return;
    ev.preventDefault(); ev.stopPropagation();
    setDropDir(dir);
  };

  const selEntry = rows.find((r) => r.e.path === sel)?.e ?? null;
  const baseDir = selEntry ? (selEntry.dir ? selEntry.path : parentOf(selEntry.path)) : "";

  const createEntry = async () => {
    const name = newName.trim();
    if (!projectId || !newKind || !name) return;
    const p = baseDir ? `${baseDir}/${name}` : name;
    setBusy(true);
    try {
      if (newKind === "folder") await api.filesMkdir(projectId, p);
      else await api.filesWrite(projectId, p, "");
      setNewKind(null); setNewName("");
      await loadDir(baseDir);
      if (baseDir) setOpen((o) => new Set(o).add(baseDir));
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  };

  const saveFile = async () => {
    if (!projectId || !view) return;
    setBusy(true);
    try {
      await api.filesWrite(projectId, view.path, content);
      setView({ ...view, content }); setEditing(false); setError("");
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  };

  const renameFile = async () => {
    const to = renameTo?.trim();
    if (!projectId || !view || !to) return;
    setBusy(true);
    try {
      await api.filesRename(projectId, view.path, to);
      await Promise.all([loadDir(parentOf(view.path)), loadDir(parentOf(to))]);
      setRenameTo(null);
      await openFile(to);
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  };

  const deleteFile = async () => {
    if (!projectId || !view) return;
    setBusy(true);
    try {
      await api.filesDelete(projectId, view.path);
      setView(null); setConfirmDel(false);
      await loadDir(parentOf(view.path));
    } catch (err) { setError(msg(err)); } finally { setBusy(false); }
  };

  const search = async () => {
    if (!projectId || !query.trim()) { setResults(null); return; }
    setResults(await api.filesSearch(projectId, query.trim()));
  };

  if (!projectId) return <div className="empty">Select a project first.</div>;

  const readOnly = view ? view.tooLarge || view.truncated : false;

  return (
    <div className="files-panel">
      <div className="files-search">
        <input
          type="text"
          placeholder="Search files…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setResults(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
        />
        <button className="small-btn" onClick={() => void search()}>Go</button>
      </div>
      <div className="files-actions">
        <button className="small-btn" onClick={() => setNewKind("file")}>+ File</button>
        <button className="small-btn" onClick={() => setNewKind("folder")}>+ Folder</button>
        {baseDir && <span className="ft-basedir">in {baseDir}/</span>}
        <span className="header-spacer" />
        <button className="small-btn" title="Show hidden files" aria-pressed={hidden} onClick={() => setHidden((v) => !v)}>
          Hidden files
        </button>
      </div>
      {newKind && (
        <div className="files-create">
          <input
            autoFocus
            value={newName}
            placeholder={newKind === "file" ? "example.ts" : "components"}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void createEntry(); }}
          />
          <button className="small-btn" disabled={busy} onClick={() => void createEntry()}>Create</button>
          <button className="small-btn" onClick={() => setNewKind(null)}>Cancel</button>
        </div>
      )}
      {error && <div className="files-error">{error}</div>}

      {view && (
        <div className="files-viewer">
          <div className="files-viewer-head">
            <button className="small-btn" onClick={closeView}>← Back to tree</button>
            <span className="files-viewer-name">{view.path}{dirty ? " ●" : ""}</span>
            <button className="small-btn" aria-pressed={wrapText} title="Wrap long lines" onClick={() => setWrapText((v) => !v)}>Wrap</button>
            <button className="small-btn" aria-label="Close preview" onClick={closeView}>✕</button>
          </div>
          {renameTo !== null && (
            <div className="files-create">
              <input autoFocus value={renameTo} onChange={(e) => setRenameTo(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void renameFile(); }} />
              <button className="small-btn" disabled={busy} onClick={() => void renameFile()}>Rename</button>
              <button className="small-btn" onClick={() => setRenameTo(null)}>Cancel</button>
            </div>
          )}
          <div className="files-viewer-wrap copy-wrap">
            {editing && !readOnly ? (
              <textarea className="files-editor" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
            ) : (
              <>
                <pre
                  className={`files-viewer-content code-view${wrapText ? " wrap" : ""}`}
                  dangerouslySetInnerHTML={{ __html: highlight(content, langOf(view.path)) }}
                />
                <CopyButton text={content} />
              </>
            )}
            {view.truncated && <div className="files-viewer-note">Truncated — file exceeds 512 KB. Read-only.</div>}
            {view.tooLarge && <div className="files-viewer-note">Binary file detected. Read-only.</div>}
          </div>
          <div className="files-viewer-actions">
            {!readOnly && (editing ? (
              <>
                <button className="small-btn" disabled={busy || content === view.content} onClick={() => void saveFile()}>Save</button>
                <button className="small-btn" onClick={() => { setContent(view.content); setEditing(false); }}>Cancel</button>
              </>
            ) : (
              <button className="small-btn" onClick={() => setEditing(true)}>Edit</button>
            ))}
            <button className="small-btn" onClick={() => attach(view.path)}>Attach to chat</button>
            <button className="small-btn" onClick={() => setRenameTo(view.path)}>Rename</button>
            {confirmDel ? (
              <><button className="small-btn danger-btn" disabled={busy} onClick={() => void deleteFile()}>Delete permanently</button><button className="small-btn" onClick={() => setConfirmDel(false)}>Cancel</button></>
            ) : <button className="small-btn danger-btn" onClick={() => setConfirmDel(true)}>Delete</button>}
          </div>
        </div>
      )}
      {!view && results !== null && (
        <div className="files-list">
          {results.length === 0 && <div className="empty">No matches.</div>}
          {results.map((fp) => (
            <div key={fp} className="ft-row" draggable onDragStart={(ev) => setDragPath(ev.dataTransfer, fp)} onClick={() => void openFile(fp)}>
              <span className="ft-chevron" />
              <span className="ft-name">{fp}</span>
              <button className="ft-at" title={`Insert @${fp} into the composer`} onClick={(ev) => { ev.stopPropagation(); attach(fp); }}>@</button>
            </div>
          ))}
        </div>
      )}
      {/* Tree stays mounted while previewing — expansion and scroll survive (UX-13). */}
      <div
        className="ft-tree"
        style={view || results !== null ? { display: "none" } : undefined}
        tabIndex={0}
        onKeyDown={onTreeKey}
        onDragOver={(ev) => allowFileDrop(ev, "")}
        onDragLeave={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setDropDir(null); }}
        onDrop={(ev) => void onUpload(ev, "")}
      >
        {rows.length === 0 && <div className="empty">Empty directory.</div>}
        {rows.map(({ e, depth }) => (
          <div
            key={e.path}
            className={`ft-row${sel === e.path ? " sel" : ""}${dropDir === e.path && e.dir ? " drop" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            draggable
            onDragStart={(ev) => setDragPath(ev.dataTransfer, e.path)}
            onDragOver={e.dir ? (ev) => allowFileDrop(ev, e.path) : undefined}
            onDrop={e.dir ? (ev) => void onUpload(ev, e.path) : undefined}
            onClick={() => { setSel(e.path); if (e.dir) toggle(e.path); else void openFile(e.path); }}
          >
            <span className="ft-chevron">{e.dir ? (open.has(e.path) ? "▾" : "▸") : ""}</span>
            <span className="ft-name">{e.name}</span>
            {!e.dir && e.size !== undefined && <span className="ft-size">{fmtSize(e.size)}</span>}
            {!e.dir && <button className="ft-at" title={`Insert @${e.path} into the composer`} onClick={(ev) => { ev.stopPropagation(); attach(e.path); }}>@</button>}
          </div>
        ))}
        {dropDir !== null && (
          <div className="drop-hint">Drop to upload{dropDir ? ` into ${dropDir}/` : ""}</div>
        )}
      </div>
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1048576).toFixed(1)}M`;
}

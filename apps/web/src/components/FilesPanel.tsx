// Files panel for Context Rail: one-level lazy tree, search, read-only viewer.
import { useState, useEffect, useCallback, type ReactNode } from "react";
import { api, type FileEntry, type FileReadResult } from "../api.ts";
import { getState, setUiError, useStore } from "../store.ts";
import { attachProjectFile } from "../attachments.ts";
import FileRowActions from "./FileRowActions.tsx";

const EMPTY_FILES: FileEntry[] = [];

function FilesRow({ children, onOpen, className = "", actions }: {
  children: ReactNode;
  onOpen: () => void;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <div className={`files-row ${className}`}>
      <button type="button" className="files-row-main" onClick={onOpen}>{children}</button>
      {actions}
    </div>
  );
}

export default function FilesPanel({ active = true }: { active?: boolean }) {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [tree, setTree] = useState<FileEntry[]>(EMPTY_FILES);
  const [currentPath, setCurrentPath] = useState("");
  const [breadcrumbs, setBreadcrumbs] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<string[] | null>(null);
  const [viewFile, setViewFile] = useState<FileReadResult | null>(null);
  const [content, setContent] = useState("");
  const [newKind, setNewKind] = useState<"file" | "folder" | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renamePath, setRenamePath] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const projectId = activeProjectId;

  const loadTree = useCallback(
    async (p: string) => {
      if (!projectId) return;
      try {
        const entries = await api.filesTree(projectId, p || undefined);
        setTree(entries);
        setCurrentPath(p);
        setBreadcrumbs(p ? p.split("/") : []);
        setViewFile(null);
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [projectId],
  );

  useEffect(() => { loadTree(""); }, [loadTree]);
  useEffect(() => {
    if (!projectId || !active) return;
    const refreshCurrent = () => {
      if (document.visibilityState === "hidden") return;
      void api.filesTree(projectId, currentPath || undefined).then(setTree).catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshCurrent();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(refreshCurrent, 8_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
    };
  }, [active, projectId, currentPath]);

  const onDirClick = (p: string) => {
    setSearchResults(null);
    setQuery("");
    void loadTree(p);
  };

  const onFileClick = async (fp: string) => {
    if (!projectId) return;
    try {
      const got = await api.filesRead(projectId, fp);
      setViewFile(got);
      setContent(got.content);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const search = async () => {
    if (!projectId || !query.trim()) { setSearchResults(null); return; }
    const got = await api.filesSearch(projectId, query.trim());
    setSearchResults(got);
  };

  const handleSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void search();
  };

  // Add to chat = attachment pill on the active composer (F2).
  const attachToChat = (fp: string) => {
    if (!projectId) return;
    void attachProjectFile(projectId, getState().activeSessionId, fp).then((r) => {
      if (!r.ok) setUiError(`Couldn’t attach: ${r.reason}`);
    });
  };

  const createEntry = async () => {
    if (!projectId || !newKind || !newName.trim()) return;
    const path = currentPath ? `${currentPath}/${newName.trim()}` : newName.trim();
    setSaving(true);
    try {
      if (newKind === "folder") await api.filesMkdir(projectId, path);
      else await api.filesWrite(projectId, path, "");
      setNewKind(null);
      setNewName("");
      await loadTree(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const saveFile = async () => {
    if (!projectId || !viewFile) return;
    setSaving(true);
    try {
      const result = await api.filesWrite(projectId, viewFile.path, content, viewFile.revision);
      setViewFile({ ...viewFile, content, revision: result.revision });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const renameFile = async () => {
    if (!projectId || !viewFile || !renamePath.trim()) return;
    setSaving(true);
    try {
      await api.filesRename(projectId, viewFile.path, renamePath.trim());
      await loadTree(currentPath);
      await onFileClick(renamePath.trim());
      setRenaming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteFile = async () => {
    if (!projectId || !viewFile) return;
    setSaving(true);
    try {
      await api.filesDelete(projectId, viewFile.path);
      setViewFile(null);
      setConfirmDelete(false);
      await loadTree(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!projectId) return <div className="empty">Select a project first.</div>;

  return (
    <div className="files-panel">
      <div className="files-search">
        <input
          type="text"
          placeholder="Search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleSearchKey}
        />
        <button className="small-btn" onClick={() => void search()}>Go</button>
      </div>
      <div className="files-actions">
        <button className="small-btn" onClick={() => setNewKind("file")}>+ File</button>
        <button className="small-btn" onClick={() => setNewKind("folder")}>+ Folder</button>
      </div>
      {newKind && (
        <div className="files-create">
          <input
            autoFocus
            value={newName}
            placeholder={newKind === "file" ? "src/example.ts" : "src/components"}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void createEntry(); }}
          />
          <button className="small-btn" disabled={saving} onClick={() => void createEntry()}>Create</button>
          <button className="small-btn" onClick={() => setNewKind(null)}>Cancel</button>
        </div>
      )}
      {error && <div className="files-error">{error}</div>}

      {breadcrumbs.length > 0 && (
        <div className="files-breadcrumbs">
          <button type="button" className="files-crumb" onClick={() => void loadTree("")}>/</button>
          {breadcrumbs.map((seg, i) => {
            const p = breadcrumbs.slice(0, i + 1).join("/");
            return (
              <span key={i}>
                <span className="files-sep">/</span>
                <button type="button" className="files-crumb" onClick={() => void loadTree(p)}>{seg}</button>
              </span>
            );
          })}
        </div>
      )}

      {viewFile ? (
        <div className="files-viewer">
          <div className="files-viewer-head">
            <span className="files-viewer-name">{viewFile.path}</span>
            <button className="small-btn" onClick={() => setViewFile(null)}>✕</button>
          </div>
          {renaming && (
            <div className="files-create">
              <input autoFocus value={renamePath} onChange={(e) => setRenamePath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void renameFile(); }} />
              <button className="small-btn" disabled={saving} onClick={() => void renameFile()}>Rename</button>
              <button className="small-btn" onClick={() => setRenaming(false)}>Cancel</button>
            </div>
          )}
          <div className="files-viewer-wrap">
            {viewFile.tooLarge || viewFile.truncated ? (
              <pre className="files-viewer-content">{viewFile.content}</pre>
            ) : (
              <textarea className="files-editor" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
            )}
            {viewFile.truncated && <div className="files-viewer-note">Truncated — file exceeds 512 KB.</div>}
            {viewFile.tooLarge && <div className="files-viewer-note">Binary file detected.</div>}
          </div>
          <div className="files-viewer-actions">
            {!viewFile.tooLarge && !viewFile.truncated && <button className="small-btn" disabled={saving || content === viewFile.content} onClick={() => void saveFile()}>Save</button>}
            <button className="small-btn" onClick={() => attachToChat(viewFile.path)}>Attach to chat</button>
            <button className="small-btn" onClick={() => { setRenamePath(viewFile.path); setRenaming(true); }}>Rename</button>
            {confirmDelete ? (
              <><button className="small-btn danger-btn" disabled={saving} onClick={() => void deleteFile()}>Delete permanently</button><button className="small-btn" onClick={() => setConfirmDelete(false)}>Cancel</button></>
            ) : <button className="small-btn danger-btn" onClick={() => setConfirmDelete(true)}>Delete</button>}
          </div>
        </div>
      ) : searchResults !== null ? (
        <div className="files-list">
          {searchResults.length === 0 && <div className="empty">No matches.</div>}
          {searchResults.map((fp) => (
            <FilesRow
              key={fp}
              onOpen={() => void onFileClick(fp)}
              actions={<FileRowActions projectId={projectId} path={fp} onOpen={() => void onFileClick(fp)} />}
            >
              <span className="files-file-icon file-glyph" aria-hidden>▤</span>
              <span className="files-file-name">{fp}</span>
            </FilesRow>
          ))}
        </div>
      ) : (
        <div className="files-list">
          {currentPath && (
            <FilesRow className="files-up" onOpen={() => {
              const parts = currentPath.split("/");
              parts.pop();
              void loadTree(parts.join("/"));
            }}>
              <span className="files-file-icon">↩</span>
              <span className="files-file-name">..</span>
            </FilesRow>
          )}
          {tree.length === 0 && <div className="empty">Empty directory.</div>}
          {tree.map((e) =>
            e.dir ? (
              <FilesRow key={e.path} className="files-dir" onOpen={() => onDirClick(e.path)}>
                <span className="files-file-icon dir-glyph" aria-hidden>▸</span>
                <span className="files-file-name">{e.name}</span>
              </FilesRow>
            ) : (
              <FilesRow
                key={e.path}
                onOpen={() => void onFileClick(e.path)}
                actions={<FileRowActions projectId={projectId} path={e.path} onOpen={() => void onFileClick(e.path)} />}
              >
                <span className="files-file-icon file-glyph" aria-hidden>▤</span>
                <span className="files-file-name">{e.name}</span>
                {e.size !== undefined && <span className="files-size">{fmtSize(e.size)}</span>}
              </FilesRow>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1048576).toFixed(1)}M`;
}

// Full-screen folder picker (the "open project" dialog). A real file manager
// over the localhost-only /api/browse route: breadcrumb path bar, directory
// list with keyboard navigation, hidden toggle, optional new-folder creation.
// Replaces the old inline path-textfield ProjectForm everywhere.
import { useCallback, useEffect, useRef, useState } from "react";
import Dialog from "./a11y/Dialog.tsx";
import { api, type BrowseEntryDto } from "../api.ts";
import { addProject } from "../init.ts";
import { ago } from "../format.ts";
import { Icon } from "../icons.tsx";

const folderIcon = (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6.5h7l2 2h9v10H3z" />
  </svg>
);

export default function ProjectFolderDialog({
  onClose,
  onOpened,
  title = "Open a project",
  subtitle = "Choose a local folder. Polyth never uploads your workspace.",
}: {
  onClose: () => void;
  /** Called after the project has been added/activated. */
  onOpened?: (path: string) => void;
  title?: string;
  subtitle?: string;
}) {
  const [path, setPath] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [home, setHome] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntryDto[]>([]);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (target?: string, showHidden?: boolean) => {
    try {
      setError("");
      const r = await api.browseHost(target, showHidden ?? hidden);
      setPath(r.path);
      setPathInput(r.path);
      setHome(r.home);
      setParent(r.parent);
      setEntries(r.entries);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [hidden]);

  useEffect(() => { void load(); /* default: home dir */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleHidden = () => {
    const next = !hidden;
    setHidden(next);
    void load(path, next);
  };

  const enter = (entry: BrowseEntryDto) => void load(entry.path);

  const openProject = async () => {
    const target = selected ?? path;
    if (!target) return;
    setBusy(true);
    setError("");
    try {
      await addProject(target);
      onOpened?.(target);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const target = `${path.replace(/\/$/, "")}/${name}`;
      await api.browseMkdir(target);
      setCreating(false);
      setNewName("");
      await load(path);
      setSelected(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ↑/↓ move the highlight, Enter descends into the highlighted folder
  // (matching the mockup legend); the primary button confirms the choice.
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    e.preventDefault();
    const idx = entries.findIndex((x) => x.path === selected);
    if (e.key === "Enter") {
      const current = entries[idx];
      if (current) enter(current);
      return;
    }
    const next = e.key === "ArrowDown"
      ? entries[Math.min(entries.length - 1, idx + 1)] ?? entries[0]
      : entries[Math.max(0, idx - 1)] ?? entries[0];
    if (next) {
      setSelected(next.path);
      listRef.current
        ?.querySelector(`[data-path="${CSS.escape(next.path)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  };

  return (
    <Dialog title={title} onClose={onClose} size="lg" className="folder-dialog" initialFocus=".folder-list">
      <div className="folder-dialog-head">
        <div>
          <div className="folder-dialog-title">{title}</div>
          <div className="folder-dialog-subtitle">{subtitle}</div>
        </div>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
      </div>

      <div className="folder-toolbar">
        <button className="small-btn" title="Home directory" aria-label="Go to home directory" onClick={() => void load(home || "~")}>~</button>
        <button className="small-btn" title="Parent folder" aria-label="Go to parent folder" disabled={!parent} onClick={() => parent && void load(parent)}>↑</button>
        <input
          className="folder-path mono"
          value={pathInput}
          aria-label="Current path"
          spellCheck={false}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void load(pathInput.trim() || "~"); }}
          onBlur={() => setPathInput(path)}
        />
        <button className={`hidden-toggle ${hidden ? "on" : ""}`} type="button" aria-pressed={hidden} onClick={toggleHidden}>
          <span className="toggle-track" aria-hidden="true" />
          Hidden
        </button>
      </div>

      <div className="folder-cols" aria-hidden="true"><span>Name</span><span>Modified</span></div>

      <div
        ref={listRef}
        className="folder-list"
        role="listbox"
        aria-label="Folders"
        tabIndex={0}
        onKeyDown={onListKeyDown}
      >
        {parent && (
          <div className="folder-row folder-up" role="option" aria-selected="false" onDoubleClick={() => void load(parent)} onClick={() => void load(parent)}>
            <span className="folder-row-icon">{folderIcon}</span>
            <span className="folder-row-name mono">..</span>
            <span className="folder-row-meta" />
          </div>
        )}
        {entries.map((entry) => (
          <div
            key={entry.path}
            data-path={entry.path}
            className={`folder-row ${selected === entry.path ? "selected" : ""}`}
            role="option"
            aria-selected={selected === entry.path}
            onClick={() => setSelected(entry.path)}
            onDoubleClick={() => enter(entry)}
          >
            <span className="folder-row-icon">{folderIcon}</span>
            <span className="folder-row-name">{entry.name}</span>
            <span className="folder-row-meta mono">{entry.modifiedAt ? `${ago(entry.modifiedAt)} ago` : ""}</span>
          </div>
        ))}
        {entries.length === 0 && !error && <div className="folder-empty">No sub-folders here — open this folder itself, or create one.</div>}
      </div>

      <div className="folder-legend">
        <span className="legend-item"><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span>
        <span className="legend-item"><span className="kbd">↵</span> enter folder</span>
        <span className="legend-item"><span className="kbd">Esc</span> close</span>
      </div>

      {error && <div className="form-error folder-error" role="alert">{error}</div>}

      <div className="folder-foot">
        {creating ? (
          <span className="folder-newname">
            <input
              autoFocus
              value={newName}
              placeholder="new-folder-name"
              aria-label="New folder name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createFolder();
                else if (e.key === "Escape") { e.stopPropagation(); setCreating(false); }
              }}
            />
            <button className="small-btn" disabled={busy || !newName.trim()} onClick={() => void createFolder()}>Create</button>
          </span>
        ) : (
          <button className="ghost-link" onClick={() => setCreating(true)}><Icon.plus /> New folder</button>
        )}
        <span className="header-spacer" />
        <span className="folder-selected mono" title={selected ?? path}>{selected ?? path}</span>
        <button className="primary-btn" disabled={busy || (!selected && !path)} onClick={() => void openProject()}>
          {busy ? "Opening…" : "Open project"}
        </button>
      </div>
    </Dialog>
  );
}

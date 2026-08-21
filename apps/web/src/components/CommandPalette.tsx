// Unified palette (WP13): commands, projects, sessions, and files in one box.
// Mod+P opens file-focused mode; `is:archived` reveals archived sessions.
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { commandHint, filterPalette, listCommands, type PaletteCommand } from "../commands.ts";
import { api, type FileSearchHitDto, type WorkspaceSearchItemDto } from "../api.ts";
import { activateProject, openEditorFile, setOverlay, setUiError, useStore } from "../store.ts";
import { openSession } from "../init.ts";
import { announce } from "./a11y/live.tsx";
import { useModalSurface } from "./a11y/Dialog.tsx";

type Entry =
  | { kind: "cmd"; id: string; cmd: PaletteCommand }
  | { kind: "workspace"; id: string; item: WorkspaceSearchItemDto }
  | { kind: "file"; id: string; hit: FileSearchHitDto };

/** Pull an `is:archived` token out of the raw query. */
export function parseQuery(raw: string): { text: string; archived: boolean } {
  const archived = /(^|\s)is:archived(\s|$)/i.test(raw);
  return { text: raw.replace(/(^|\s)is:archived(?=\s|$)/gi, " ").trim(), archived };
}

export default function CommandPalette() {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const [files, setFiles] = useState<FileSearchHitDto[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSearchItemDto[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const projectId = useStore((s) => s.activeProjectId);
  // File search resolves against the active session's worktree (P0).
  const sessionId = useStore((s) => s.activeSessionId);
  const mode = useStore((s) => s.paletteMode);
  const filesMode = mode === "files";
  const { text, archived } = useMemo(() => parseQuery(q), [q]);

  const cmds = useMemo(
    () => (filesMode ? [] : filterPalette(listCommands(), text)),
    [filesMode, text],
  );
  useModalSurface({
    open: true,
    onClose: () => setOverlay(null),
    containerRef: panelRef,
    initialFocus: ".palette-input",
  });
  useEffect(() => { setI(0); }, [q]);

  // Debounced remote searches; stale responses are dropped by sequence.
  useEffect(() => {
    const mySeq = ++seq.current;
    const wantFiles = !!projectId && text.length >= (filesMode ? 1 : 2);
    // `is:archived` alone lists recent archived sessions (server-bounded).
    const wantWorkspaces = !filesMode && (archived || text.length >= 2);
    if (!wantFiles) setFiles([]);
    if (!wantWorkspaces) setWorkspaces([]);
    if (!wantFiles && !wantWorkspaces) return;
    const h = setTimeout(() => {
      if (wantFiles) {
        void api.filesSearchScored(projectId!, text, filesMode ? 20 : 8, false, sessionId ?? undefined).then((hits) => {
          if (mySeq === seq.current) setFiles(hits);
        });
      }
      if (wantWorkspaces) {
        void api.searchWorkspaces(text, 10, archived).then((items) => {
          if (mySeq === seq.current) setWorkspaces(items);
        });
      }
    }, 150);
    return () => clearTimeout(h);
  }, [text, archived, filesMode, projectId, sessionId]);

  const entries = useMemo<Entry[]>(
    () => [
      ...cmds.map((c): Entry => ({ kind: "cmd", id: c.id, cmd: c })),
      ...workspaces.map((w): Entry => ({ kind: "workspace", id: `${w.kind}:${w.id}`, item: w })),
      ...files.map((f): Entry => ({ kind: "file", id: `file:${f.path}`, hit: f })),
    ],
    [cmds, workspaces, files],
  );

  const run = (entry: Entry) => {
    setOverlay(null);
    if (entry.kind === "cmd") {
      entry.cmd.run();
    } else if (entry.kind === "workspace") {
      // Capture ids now: activation must not race a store update mid-switch.
      const { kind, id } = entry.item;
      if (kind === "project") {
        activateProject(id);
      } else {
        // openSession switches the owning project first, atomically.
        void openSession(id).catch(() => {
          announce("That session no longer exists");
          setUiError("That session no longer exists.");
        });
      }
    } else {
      openEditorFile(entry.hit.path);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME safety
    if (e.key === "ArrowDown") { e.preventDefault(); setI((n) => (n + 1) % Math.max(entries.length, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setI((n) => (n - 1 + entries.length) % Math.max(entries.length, 1)); }
    else if (e.key === "Enter" && entries[i]) { e.preventDefault(); run(entries[i]!); }
  };

  const groupOf = (entry: Entry): string => {
    if (entry.kind === "cmd") return entry.cmd.group ?? "";
    if (entry.kind === "workspace") return entry.item.kind === "project" ? "Projects" : "Sessions";
    return "Files";
  };

  const dirOf = (p: string): string => {
    const idx = p.lastIndexOf("/");
    return idx < 0 ? "" : p.slice(0, idx);
  };
  const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

  return (
    <div className="scrim palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOverlay(null); }}>
      <div
        ref={panelRef}
        className="dialog-panel palette"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        aria-describedby="palette-close-hint"
        tabIndex={-1}
      >
      <div className="palette-heading">
        <span className="palette-heading-title">Search workspace</span>
        <span className="palette-heading-description">
          Commands, projects, sessions, and files
        </span>
      </div>
      <input
        className="palette-input"
        value={q}
        role="combobox"
        aria-expanded={entries.length > 0}
        aria-controls="palette-listbox"
        aria-activedescendant={entries[i] ? `palette-opt-${i}` : undefined}
        aria-autocomplete="list"
        placeholder={filesMode ? "Search files…" : "Search commands, projects, sessions, files… (is:archived)"}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="palette-list" role="listbox" id="palette-listbox" aria-label="Palette results">
        {entries.length === 0 && <div className="palette-empty">No matches</div>}
        {entries.map((entry, n) => (
          <Fragment key={entry.id}>
            {groupOf(entry) && (n === 0 || groupOf(entries[n - 1]!) !== groupOf(entry)) && (
              <div className="palette-group" role="presentation">{groupOf(entry)}</div>
            )}
            <button
              className={`palette-item ${n === i ? "active" : ""} ${entry.kind === "workspace" ? `palette-${entry.item.kind}` : ""}`}
              role="option"
              id={`palette-opt-${n}`}
              aria-selected={n === i}
              ref={n === i ? (el) => el?.scrollIntoView({ block: "nearest" }) : null}
              onClick={() => run(entry)}
            >
                {entry.kind === "cmd" && (
                  <>
                    {entry.cmd.checked && (
                      <span className="palette-check" aria-hidden="true">{entry.cmd.checked() ? "✓" : "\u00a0"}</span>
                    )}
                    <span className="palette-label">
                      {entry.cmd.label}
                      {entry.cmd.checked?.() && <span className="sr-only"> (current)</span>}
                    </span>
                    {commandHint(entry.cmd) && <kbd>{commandHint(entry.cmd)}</kbd>}
                  </>
                )}
                {entry.kind === "workspace" && (
                  <>
                    <span className="palette-col">
                      <span className="palette-label">
                        {entry.item.title}
                        {entry.item.archived && <span className="palette-status archived"> archived</span>}
                      </span>
                      {entry.item.subtitle && <span className="palette-sub">{entry.item.subtitle}</span>}
                    </span>
                    <span className="palette-meta">
                      {entry.item.kind === "project" ? "switch project" : "open session"}
                    </span>
                  </>
                )}
                {entry.kind === "file" && (
                  <>
                    <span className="palette-col">
                      <span className="palette-label mono">{baseOf(entry.hit.path)}</span>
                      {dirOf(entry.hit.path) && <span className="palette-sub mono">{dirOf(entry.hit.path)}</span>}
                    </span>
                    <span className="palette-meta">{entry.hit.kind === "dir" ? "folder" : "open in editor"}</span>
                  </>
                )}
            </button>
          </Fragment>
        ))}
      </div>
      <div className="palette-footer" id="palette-close-hint"><kbd>Esc</kbd> close</div>
      </div>
    </div>
  );
}

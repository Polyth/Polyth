import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { filterPalette, listCommands, type PaletteCommand } from "../commands.ts";
import { api } from "../api.ts";
import { openEditorFile, setOverlay, useStore } from "../store.ts";
import { pluginOn } from "../prefs.ts";

type Entry =
  | { kind: "cmd"; id: string; cmd: PaletteCommand }
  | { kind: "file"; id: string; path: string };

export default function CommandPalette() {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const projectId = useStore((s) => s.activeProjectId);
  const cmds = useMemo(() => filterPalette(listCommands(), q), [q]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setI(0); }, [q]);

  // File search: same box, debounced against /api/files/search (files plugin).
  useEffect(() => {
    const query = q.trim();
    if (!projectId || query.length < 2 || !pluginOn("files")) { setFiles([]); return; }
    const h = setTimeout(() => {
      void api.filesSearch(projectId, query, 8).then(setFiles);
    }, 150);
    return () => clearTimeout(h);
  }, [q, projectId]);

  const entries = useMemo<Entry[]>(
    () => [
      ...cmds.map((c): Entry => ({ kind: "cmd", id: c.id, cmd: c })),
      ...files.map((p): Entry => ({ kind: "file", id: `file:${p}`, path: p })),
    ],
    [cmds, files],
  );

  const run = (entry: Entry) => {
    setOverlay(null);
    if (entry.kind === "cmd") entry.cmd.run();
    else openEditorFile(entry.path);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setI((n) => (n + 1) % Math.max(entries.length, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setI((n) => (n - 1 + entries.length) % Math.max(entries.length, 1)); }
    else if (e.key === "Enter" && entries[i]) { e.preventDefault(); run(entries[i]!); }
    else if (e.key === "Escape") setOverlay(null);
  };

  const groupOf = (entry: Entry): string => (entry.kind === "cmd" ? entry.cmd.group ?? "" : "Files");

  return (
    <div className="overlay" onClick={() => setOverlay(null)}>
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input ref={input} value={q} placeholder="Run a command or search files…" onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
        <div className="palette-list">
          {entries.length === 0 && <div className="palette-empty">No matches</div>}
          {entries.map((entry, n) => (
            <Fragment key={entry.id}>
              {groupOf(entry) && (n === 0 || groupOf(entries[n - 1]!) !== groupOf(entry)) && (
                <div className="palette-group">{groupOf(entry)}</div>
              )}
              <button
                className={`palette-item ${n === i ? "active" : ""}`}
                ref={n === i ? (el) => el?.scrollIntoView({ block: "nearest" }) : null}
                onClick={() => run(entry)}
              >
                {entry.kind === "cmd" ? (
                  <>
                    <span className="palette-label">{entry.cmd.label}</span>
                    {entry.cmd.hint && <kbd>{entry.cmd.hint}</kbd>}
                  </>
                ) : (
                  <>
                    <span className="palette-label mono">{entry.path}</span>
                    <span className="palette-meta">open in editor</span>
                  </>
                )}
              </button>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

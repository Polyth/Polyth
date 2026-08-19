// Cmd/Ctrl+K command palette: fuzzy filter, arrow keys + Enter, Escape closes.
import { useEffect, useMemo, useRef, useState } from "react";
import { getState, setActiveView, type AppView } from "../store.ts";
import { createSession, exportSessionMarkdown, forkSession } from "../init.ts";
import { shortcutLabel } from "../settings.ts";

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

// Loose subsequence match: every query char appears in order.
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return q.length === 0;
}

const VIEWS: Array<[AppView, string]> = [
  ["session", "Chat"],
  ["git", "Git"],
  ["terminal", "Terminal"],
  ["preview", "Preview"],
  ["goals", "Goals"],
  ["multirun", "Multi-run"],
  ["fusion", "Fusion"],
  ["walkthrough", "Walkthrough"],
];

function buildCommands(onToggleRail: () => void, close: () => void): Command[] {
  const wrap = (fn: () => void) => () => { close(); fn(); };
  const cmds: Command[] = [
    {
      id: "new-session",
      label: "New session",
      run: wrap(() => {
        const pid = getState().activeProjectId;
        if (pid) void createSession(pid);
      }),
    },
    {
      id: "open-project",
      label: "Open project",
      run: wrap(() => window.dispatchEvent(new CustomEvent("polyth:open-project"))),
    },
    {
      id: "open-settings",
      label: "Open settings",
      hint: shortcutLabel(","),
      run: wrap(() => window.dispatchEvent(new CustomEvent("polyth:open-settings"))),
    },
    ...VIEWS.map(([view, label]): Command => ({
      id: `view-${view}`,
      label: `Go to ${label}`,
      hint: "View",
      run: wrap(() => setActiveView(view)),
    })),
    { id: "toggle-rail", label: "Toggle right rail", run: wrap(onToggleRail) },
    {
      id: "fork",
      label: "Fork session",
      run: wrap(() => {
        const sid = getState().activeSessionId;
        if (sid) void forkSession(sid).catch(() => {});
      }),
    },
    { id: "export", label: "Export session as Markdown", run: wrap(exportSessionMarkdown) },
    {
      id: "focus-composer",
      label: "Focus composer",
      run: wrap(() => {
        setActiveView("session");
        window.dispatchEvent(new CustomEvent("polyth:composer-focus"));
      }),
    },
  ];
  return cmds;
}

export default function CommandPalette({ onToggleRail }: { onToggleRail: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setIndex(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const commands = useMemo(() => buildCommands(onToggleRail, () => setOpen(false)), [onToggleRail]);
  const filtered = useMemo(
    () => commands.filter((c) => fuzzyMatch(query.trim(), c.label)),
    [commands, query],
  );

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => (i + 1) % Math.max(1, filtered.length)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => (i - 1 + Math.max(1, filtered.length)) % Math.max(1, filtered.length)); return; }
    if (e.key === "Enter") { e.preventDefault(); filtered[Math.min(index, filtered.length - 1)]?.run(); }
  };

  return (
    <div className="palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="Type a command…"
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">No matching commands.</div>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              className={`palette-item ${i === Math.min(index, filtered.length - 1) ? "active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => c.run()}
            >
              <span>{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

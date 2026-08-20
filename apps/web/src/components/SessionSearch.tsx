// Session search (WP5): local title filter merges with server search over
// metadata, branch, labels and message text — results carry bounded snippets.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useStore, setOverlay } from "../store.ts";
import { api, type SessionSearchResult } from "../api.ts";
import { openSession } from "../init.ts";
import { ago, deriveSessionTitle } from "../format.ts";
import { firstUserText } from "../utils.ts";

export default function SessionSearch() {
  const sessions = useStore((s) => s.sessions);
  const events = useStore((s) => s.events);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const [remote, setRemote] = useState<SessionSearchResult[]>([]);
  const input = useRef<HTMLInputElement>(null);

  // Debounced server search: metadata/branch/labels/message text with snippets.
  useEffect(() => {
    const n = q.trim();
    if (!n) { setRemote([]); return; }
    const t = setTimeout(() => {
      void api.searchSessions(n, activeProjectId ?? undefined).then(setRemote);
    }, 160);
    return () => clearTimeout(t);
  }, [q, activeProjectId]);

  const items = useMemo(() => {
    const n = q.trim().toLowerCase();
    const local = sessions.filter((s) => !n || (s.title || "").toLowerCase().includes(n) || s.id.toLowerCase().includes(n));
    const localIds = new Set(local.map((s) => s.id));
    const snippets = new Map(remote.map((r) => [r.sessionId, r.matches] as const));
    const extra = remote
      .filter((r) => !localIds.has(r.sessionId))
      .map((r) => sessions.find((s) => s.id === r.sessionId))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    return [...local, ...extra].map((s) => ({ s, matches: snippets.get(s.id) ?? [] }));
  }, [sessions, q, remote]);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setI(0); }, [q]);

  const pick = (id: string) => { setOverlay(null); void openSession(id); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setI((n) => (n + 1) % Math.max(items.length, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setI((n) => (n - 1 + items.length) % Math.max(items.length, 1)); }
    else if (e.key === "Enter" && items[i]) { e.preventDefault(); pick(items[i]!.s.id); }
    else if (e.key === "Escape") setOverlay(null);
  };

  return (
    <div className="scrim palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOverlay(null); }}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Search sessions">
        <input className="palette-input" ref={input} value={q} placeholder="Search title, branch, labels, messages" onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
        <div className="palette-list">
          {items.length === 0 && <div className="palette-empty">No sessions</div>}
          {items.map(({ s, matches }, n) => (
            <button
              key={s.id}
              className={`palette-item ${n === i ? "active" : ""}`}
              ref={n === i ? (el) => el?.scrollIntoView({ block: "nearest" }) : null}
              onClick={() => pick(s.id)}
            >
              <span className={`dot ${s.status}`} />
              <span className="palette-col">
                <span className="palette-label">{deriveSessionTitle(s.title, firstUserText(events[s.id]))}</span>
                {matches.filter((m) => m.field !== "title").slice(0, 2).map((m, k) => (
                  <span key={k} className="palette-snippet"><em>{m.field}</em> {m.snippet}</span>
                ))}
              </span>
              <span className="palette-meta">{ago(s.updatedAt)} · {s.status}</span>
            </button>
          ))}
        </div>
        <div className="palette-footer"><kbd>↑↓</kbd> navigate · <kbd>↵</kbd> open · <kbd>Esc</kbd> close</div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useStore, setOverlay } from "../store.ts";
import { openSession } from "../init.ts";
import { ago, deriveSessionTitle } from "../format.ts";
import { firstUserText } from "../utils.ts";

export default function SessionSearch() {
  const sessions = useStore((s) => s.sessions);
  const events = useStore((s) => s.events);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const items = useMemo(() => {
    const n = q.trim().toLowerCase();
    return sessions.filter((s) => !n || (s.title || "").toLowerCase().includes(n) || s.id.toLowerCase().includes(n));
  }, [sessions, q]);
  useEffect(() => { input.current?.focus(); }, []);

  const pick = (id: string) => { setOverlay(null); void openSession(id); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setI((n) => (n + 1) % Math.max(items.length, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setI((n) => (n - 1 + items.length) % Math.max(items.length, 1)); }
    else if (e.key === "Enter" && items[i]) { e.preventDefault(); pick(items[i]!.id); }
    else if (e.key === "Escape") setOverlay(null);
  };

  return (
    <div className="overlay" onClick={() => setOverlay(null)}>
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Search sessions">
        <input ref={input} value={q} placeholder="Filter sessions by title" onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
        <div className="palette-list">
          {items.length === 0 && <div className="palette-empty">No sessions</div>}
          {items.map((s, n) => (
            <button
              key={s.id}
              className={`palette-item ${n === i ? "active" : ""}`}
              ref={n === i ? (el) => el?.scrollIntoView({ block: "nearest" }) : null}
              onClick={() => pick(s.id)}
            >
              <span className={`dot ${s.status}`} />
              <span className="palette-label">{deriveSessionTitle(s.title, firstUserText(events[s.id]))}</span>
              <span className="palette-meta">{ago(s.updatedAt)} · {s.status}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

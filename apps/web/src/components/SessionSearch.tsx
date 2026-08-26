// Session search (WP5): local title filter merges with server search over
// metadata, branch, labels and message text — results carry bounded snippets.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useStore, setOverlay } from "../store.ts";
import { api, type SessionSearchResult } from "@polyth/session/web-api";
import { openSession } from "../init.ts";
import { ago, deriveSessionTitle } from "../format.ts";
import { firstUserText } from "../utils.ts";
import Dialog from "./a11y/Dialog.tsx";
import { tr } from "../i18n/index.ts";

export default function SessionSearch() {
  const sessions = useStore((s) => s.sessions);
  const events = useStore((s) => s.events);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const [remote, setRemote] = useState<SessionSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const searchSequence = useRef(0);
  const mobile = typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches;

  // Debounced server search: metadata/branch/labels/message text with snippets.
  useEffect(() => {
    const sequence = ++searchSequence.current;
    const n = q.trim();
    setRemote([]);
    setSearchFailed(false);
    if (!n) {
      setLoading(false);
      return;
    }

    let active = true;
    const controller = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      void api.searchSessions(n, activeProjectId ?? undefined, 30, controller.signal)
        .then((results) => {
          if (active && searchSequence.current === sequence) setRemote(results);
        })
        .catch(() => {
          if (active && !controller.signal.aborted && searchSequence.current === sequence) {
            setSearchFailed(true);
          }
        })
        .finally(() => {
          if (active && searchSequence.current === sequence) setLoading(false);
        });
    }, 160);
    return () => {
      active = false;
      clearTimeout(t);
      controller.abort();
    };
  }, [q, activeProjectId, retry]);

  const items = useMemo(() => {
    const n = q.trim().toLowerCase();
    const local = sessions.filter((s) => !n || (s.title || "").toLowerCase().includes(n) || s.id.toLowerCase().includes(n));
    const localIds = new Set(local.map((s) => s.id));
    const snippets = new Map(remote.map((r) => [r.sessionId, r.matches] as const));
    const extra = remote
      .filter((r) => !localIds.has(r.sessionId))
      .map((r) => sessions.find((s) => s.id === r.sessionId))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);
    return [...local, ...extra]
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .map((s) => ({ s, matches: snippets.get(s.id) ?? [] }));
  }, [sessions, q, remote]);

  useEffect(() => { setI(0); }, [q]);

  const pick = (id: string) => { setOverlay(null); void openSession(id); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setI((n) => (n + 1) % Math.max(items.length, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setI((n) => (n - 1 + items.length) % Math.max(items.length, 1)); }
    else if (e.key === "Enter" && items[i]) { e.preventDefault(); pick(items[i]!.s.id); }
  };

  return (
    <Dialog
      title={tr("sessionsearch.searchSessions")}
      onClose={() => setOverlay(null)}
      className="palette"
      backdropClassName="palette-overlay"
      initialFocus={mobile ? ".palette-heading" : ".palette-input"}
    >
      <div className="palette-heading" tabIndex={-1}>
        <span className="palette-heading-title">{tr("sessionsearch.sessionHistory")}</span>
        <span className="palette-heading-description">
          {tr("sessionsearch.recentSessionsAndConversationContent")}</span>
      </div>
      <input className="palette-input" value={q} placeholder={tr("sessionsearch.searchTitleBranchLabelsMessages")} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
      <div className="palette-list">
        {loading && <div className="palette-empty" role="status">{tr("sessionsearch.searchingSessions")}</div>}
        {!loading && searchFailed && (
          <div className="palette-empty" role="status">
            {tr("sessionsearch.couldnTSearchSessionContents")}<button className="small-btn palette-retry" onClick={() => setRetry((n) => n + 1)}>{tr("common.retry")}</button>
          </div>
        )}
        {!loading && !searchFailed && items.length === 0 && <div className="palette-empty">{tr("sessionsearch.noSessions")}</div>}
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
      <div className="palette-footer"><kbd>↑↓</kbd> {tr("sessionsearch.navigate")}{" "}<kbd>↵</kbd> {tr("sessionsearch.open")}{" "}<kbd>{tr("sessionsearch.esc")}</kbd> {tr("sessionsearch.close")}</div>
    </Dialog>
  );
}

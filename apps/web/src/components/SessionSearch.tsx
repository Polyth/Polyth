// Session search (WP5): local title filter merges with server search over
// metadata, branch, labels and message text — results carry bounded snippets.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useStore, setOverlay } from "../store.ts";
import { api, type SessionSearchResult } from "@polyth/session/web-api";
import { openSession } from "../init.ts";
import { ago, deriveSessionTitle } from "../format.ts";
import { firstUserText } from "../utils.ts";
import { tr } from "../i18n/index.ts";
import { Button, Checkbox, ResponsiveOverlay, TextInput } from "./ui/index.ts";
import { useShellMode } from "../responsiveShell.ts";
import {
  matchesSessionSearchFacets,
  parseSessionSearchQuery,
} from "../sessionSearchQuery.ts";

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
  const [allProjects, setAllProjects] = useState(false);
  const searchSequence = useRef(0);
  const phone = useShellMode() === "phone";
  const query = useMemo(() => parseSessionSearchQuery(q), [q]);

  // Debounced server search: metadata/branch/labels/message text with snippets.
  useEffect(() => {
    const sequence = ++searchSequence.current;
    const n = query.text;
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
      void api.searchSessions(n, allProjects ? undefined : activeProjectId ?? undefined, 30, controller.signal)
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
  }, [query.text, activeProjectId, allProjects, retry]);

  const items = useMemo(() => {
    const n = query.text.toLowerCase();
    const inScope = (projectId: string) => allProjects || !activeProjectId || projectId === activeProjectId;
    const local = sessions.filter((s) =>
      inScope(s.projectId)
      && matchesSessionSearchFacets(s, query)
      && (!n || (s.title || "").toLowerCase().includes(n) || s.id.toLowerCase().includes(n)));
    const localIds = new Set(local.map((s) => s.id));
    const snippets = new Map(remote.map((r) => [r.sessionId, r.matches] as const));
    const extra = remote
      .filter((r) => !localIds.has(r.sessionId))
      .map((r) => sessions.find((s) => s.id === r.sessionId))
      .filter((s): s is NonNullable<typeof s> =>
        s !== undefined && inScope(s.projectId) && matchesSessionSearchFacets(s, query));
    return [...local, ...extra]
      .sort((a, b) => (b.lastTurnAt ?? b.createdAt) - (a.lastTurnAt ?? a.createdAt) || a.id.localeCompare(b.id))
      .map((s) => ({ s, matches: snippets.get(s.id) ?? [] }));
  }, [sessions, query, remote, allProjects, activeProjectId]);

  useEffect(() => { setI(0); }, [q, allProjects]);

  const pick = (id: string) => { setOverlay(null); void openSession(id); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setI((n) => (n + 1) % Math.max(items.length, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setI((n) => (n - 1 + items.length) % Math.max(items.length, 1)); }
    else if (e.key === "Enter" && items[i]) { e.preventDefault(); pick(items[i]!.s.id); }
  };

  const placeholder = tr("sessionsearch.searchTitleBranchLabelsMessages");
  const footer = <div className="palette-footer"><kbd>↑↓</kbd> {tr("sessionsearch.navigate")}{" "}<kbd>↵</kbd> {tr("sessionsearch.open")}{" "}<kbd>{tr("sessionsearch.esc")}</kbd> {tr("sessionsearch.close")}</div>;

  return (
    <ResponsiveOverlay
      open
      title={tr("sessionsearch.searchSessions")}
      onClose={() => setOverlay(null)}
      desktop="dialog"
      phone="sheet"
      dialogSize="md"
      className="palette"
      initialFocus=".palette-input"
      sheetSize="tall"
      {...(phone ? {
        sheetSearch: {
          value: q,
          onChange: setQ,
          placeholder,
          ariaLabel: placeholder,
          role: "combobox" as const,
          ariaExpanded: items.length > 0,
          ariaControls: "session-search-listbox",
          ...(items[i] ? { ariaActiveDescendant: `session-search-opt-${i}` } : {}),
          onKeyDown: onKey,
        },
        sheetAction: {
          label: tr("sessionsearch.allProjects"),
          onClick: () => setAllProjects((value) => !value),
          pressed: allProjects,
        },
      } : {})}
      sheetFooter={footer}
      dialogFooter={footer}
    >
      <div className="palette-heading">
        <span className="palette-heading-title">{tr("sessionsearch.sessionHistory")}</span>
        <span className="palette-heading-description">
          {tr("sessionsearch.recentSessionsAndConversationContent")}</span>
        {!phone && (
          <div className="session-search-scope">
            <Checkbox
              checked={allProjects}
              onChange={setAllProjects}
              label={tr("sessionsearch.allProjects")}
            />
          </div>
        )}
      </div>
      {!phone && (
        <TextInput
          className="palette-input"
          value={q}
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls="session-search-listbox"
          aria-activedescendant={items[i] ? `session-search-opt-${i}` : undefined}
          aria-autocomplete="list"
          placeholder={placeholder}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
      )}
      <div className="palette-list" id="session-search-listbox" role="listbox">
        {loading && <div className="palette-empty" role="status">{tr("sessionsearch.searchingSessions")}</div>}
        {!loading && searchFailed && (
          <div className="palette-empty" role="status">
            {tr("sessionsearch.couldnTSearchSessionContents")}<Button size="sm" className="palette-retry" onClick={() => setRetry((n) => n + 1)}>{tr("common.retry")}</Button>
          </div>
        )}
        {!loading && !searchFailed && items.length === 0 && <div className="palette-empty">{tr("sessionsearch.noSessions")}</div>}
        {items.map(({ s, matches }, n) => (
          <button
            key={s.id}
            id={`session-search-opt-${n}`}
            className={`palette-item ${n === i ? "active" : ""}`}
            role="option"
            aria-selected={n === i}
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
            <span className="palette-meta">{ago(s.lastTurnAt ?? s.createdAt)} · {s.status}</span>
          </button>
        ))}
      </div>
    </ResponsiveOverlay>
  );
}

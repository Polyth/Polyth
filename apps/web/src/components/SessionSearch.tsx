// Session search: one surface that finds any chat and any message anywhere.
// Instant local title/branch matches render on the first keystroke while the
// server's FTS5 message index answers with ranked, highlighted snippets.
// Session rows open the chat; message rows open the chat and reveal the
// matching message through the conversation reveal seam.
import { draftTitleSource } from "../sessionDraft.ts";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { getState, useStore, setOverlay } from "../store.ts";
import { api, type SessionSearchMatch, type SessionSearchResult } from "@polyth/session/web-api";
import type { SessionProjection } from "@polyth/contracts";
import { openSession } from "../init.ts";
import { requestConversationReveal } from "../conversationReveal.ts";
import { ago, deriveSessionTitle } from "../format.ts";
import { firstUserText } from "../utils.ts";
import { tr } from "../i18n/index.ts";
import { Button, Icon, IconButton, ResponsiveOverlay, Spinner } from "./ui/index.ts";
import { useShellMode } from "../responsiveShell.ts";
import {
  SESSION_SEARCH_FACETS,
  highlightRanges,
  matchesSessionSearchFacets,
  parseSessionSearchQuery,
  segmentHighlights,
  toggleSessionSearchFacet,
} from "../sessionSearchQuery.ts";

const DEBOUNCE_MS = 110;
const RECENT_LIMIT = 24;
const SERVER_LIMIT = 40;
const VISIBLE_MESSAGE_HITS = 3;

interface SessionEntry {
  kind: "session";
  key: string;
  session: SessionProjection;
  matches: SessionSearchMatch[];
  messageHits: number;
}
interface MessageEntry {
  kind: "message";
  key: string;
  session: SessionProjection;
  match: SessionSearchMatch & { seq: number };
}
type Entry = SessionEntry | MessageEntry;

const FACET_LABEL: Record<(typeof SESSION_SEARCH_FACETS)[number], () => string> = {
  "is:waiting": () => tr("sessionsearch.facetWaiting"),
  "is:running": () => tr("sessionsearch.facetRunning"),
  "is:archived": () => tr("sessionsearch.facetArchived"),
  "from:me": () => tr("sessionsearch.facetFromMe"),
  "from:agent": () => tr("sessionsearch.facetFromAgent"),
};

function Highlighted({ text, ranges }: { text: string; ranges: ReadonlyArray<readonly [number, number]> }): ReactNode {
  if (ranges.length === 0) return text;
  return segmentHighlights(text, ranges).map((seg, i) =>
    seg.hit ? <mark key={i} className="session-search-mark">{seg.text}</mark> : <span key={i}>{seg.text}</span>);
}

export default function SessionSearch() {
  const sessions = useStore((s) => s.sessions);
  const events = useStore((s) => s.events);
  const projects = useStore((s) => s.projectRegistry.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [remote, setRemote] = useState<SessionSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [tookMs, setTookMs] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [allProjects, setAllProjects] = useState(!activeProjectId);
  const searchSequence = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const phone = useShellMode() === "phone";
  const query = useMemo(() => parseSessionSearchQuery(q), [q]);
  const terms = useMemo(() => query.text.split(" ").filter(Boolean), [query.text]);
  const scopeProjectId = allProjects ? undefined : activeProjectId ?? undefined;

  // Debounced, abortable server search; a stale response can never win.
  useEffect(() => {
    const sequence = ++searchSequence.current;
    const text = query.text;
    setSearchFailed(false);
    if (!text) {
      setRemote([]);
      setTookMs(null);
      setLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      const started = performance.now();
      void api.searchSessions(text, {
        limit: SERVER_LIMIT,
        ...(scopeProjectId ? { projectId: scopeProjectId } : {}),
        ...(query.role ? { role: query.role } : {}),
      }, controller.signal)
        .then((results) => {
          if (!active || searchSequence.current !== sequence) return;
          setRemote(results);
          setTookMs(Math.max(1, Math.round(performance.now() - started)));
        })
        .catch(() => {
          if (active && !controller.signal.aborted && searchSequence.current === sequence) setSearchFailed(true);
        })
        .finally(() => {
          if (active && searchSequence.current === sequence) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(t);
      controller.abort();
    };
  }, [query.text, query.role, scopeProjectId, retry]);

  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name] as const)), [projects]);

  const { entries, chatCount, messageCount, isRecent } = useMemo(() => {
    const inScope = (s: SessionProjection) => (!scopeProjectId || s.projectId === scopeProjectId)
      && matchesSessionSearchFacets(s, query);
    const byId = new Map(sessions.map((s) => [s.id, s] as const));
    const remoteById = new Map(remote.map((r) => [r.sessionId, r] as const));
    const recency = (s: SessionProjection) => s.lastTurnAt ?? s.updatedAt ?? s.createdAt;

    let sessionRows: Array<{ session: SessionProjection; matches: SessionSearchMatch[]; messageHits: number }>;
    if (!query.text) {
      sessionRows = sessions
        .filter((s) => inScope(s) && (query.archived || s.status !== "archived"))
        .sort((a, b) => recency(b) - recency(a) || a.id.localeCompare(b.id))
        .slice(0, RECENT_LIMIT)
        .map((session) => ({ session, matches: [], messageHits: 0 }));
    } else {
      // Instant local metadata matches (title/branch/id), newest first.
      const local = query.role ? [] : sessions.filter((s) => {
        if (!inScope(s)) return false;
        const title = deriveSessionTitle(s.title, firstUserText(events[s.id]) ?? draftTitleSource(s));
        return highlightRanges(title, terms).length === terms.length
          || highlightRanges(s.branch ?? "", terms).length === terms.length
          || s.id.toLowerCase().startsWith(query.text.toLowerCase());
      }).sort((a, b) => recency(b) - recency(a) || a.id.localeCompare(b.id));
      const localIds = new Set(local.map((s) => s.id));
      sessionRows = local.map((session) => {
        const r = remoteById.get(session.id);
        return { session, matches: r?.matches ?? [], messageHits: r?.messageHits ?? 0 };
      });
      for (const r of remote) {
        if (localIds.has(r.sessionId)) continue;
        const session = byId.get(r.sessionId);
        if (!session || !inScope(session)) continue;
        sessionRows.push({ session, matches: r.matches, messageHits: r.messageHits });
      }
    }

    const out: Entry[] = [];
    let messages = 0;
    for (const row of sessionRows) {
      out.push({ kind: "session", key: `s:${row.session.id}`, session: row.session, matches: row.matches, messageHits: row.messageHits });
      messages += row.messageHits;
      const hits = row.matches.filter((m): m is SessionSearchMatch & { seq: number } => m.field === "message" && typeof m.seq === "number");
      for (const match of hits.slice(0, VISIBLE_MESSAGE_HITS)) {
        out.push({ kind: "message", key: `m:${row.session.id}:${match.seq}`, session: row.session, match });
      }
    }
    return { entries: out, chatCount: sessionRows.length, messageCount: messages, isRecent: !query.text };
  }, [sessions, events, query, terms, remote, scopeProjectId]);

  useEffect(() => { setCursor(0); }, [q, allProjects]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor, entries]);

  const close = () => setOverlay(null);
  const activate = (entry: Entry) => {
    close();
    if (entry.kind === "session") { void openSession(entry.session.id); return; }
    const id = entry.session.id;
    void openSession(id).then(() => requestConversationReveal(id, entry.match.seq, {
      current: () => getState().activeSessionId === id,
    }));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const n = Math.max(entries.length, 1);
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % n); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + n) % n); }
    else if (e.key === "Home") { e.preventDefault(); setCursor(0); }
    else if (e.key === "End") { e.preventDefault(); setCursor(n - 1); }
    else if (e.key === "Enter" && entries[cursor]) { e.preventDefault(); activate(entries[cursor]!); }
    else if (e.key === "Escape" && q) { e.preventDefault(); e.stopPropagation(); setQ(""); }
  };

  const placeholder = tr("sessionsearch.placeholder");
  const activeId = entries[cursor] ? `session-search-opt-${cursor}` : undefined;
  const footer = (
    <div className="palette-footer session-search-footer">
      <span className="session-search-summary" role="status" aria-live="polite">
        {loading
          ? tr("sessionsearch.searchingSessions")
          : isRecent
            ? tr("sessionsearch.recent")
            : tr("sessionsearch.summary", { chats: chatCount, messages: messageCount })}
        {!loading && !isRecent && tookMs !== null && (
          <span className="session-search-took"> · {tr("sessionsearch.took", { ms: tookMs })}</span>
        )}
      </span>
      {!phone && (
        <span className="session-search-keys">
          <kbd>↑↓</kbd> {tr("sessionsearch.navigate")}{" "}<kbd>↵</kbd> {tr("sessionsearch.open")}{" "}<kbd>{tr("sessionsearch.esc")}</kbd> {tr("sessionsearch.close")}
        </span>
      )}
    </div>
  );

  const scope = (
    <div className="session-search-scope" role="group" aria-label={tr("sessionsearch.scope")}>
      <button
        type="button"
        className={`session-search-scope-btn${!allProjects ? " active" : ""}`}
        aria-pressed={!allProjects}
        disabled={!activeProjectId}
        onClick={() => setAllProjects(false)}
      >
        {tr("sessionsearch.thisProject")}
      </button>
      <button
        type="button"
        className={`session-search-scope-btn${allProjects ? " active" : ""}`}
        aria-pressed={allProjects}
        onClick={() => setAllProjects(true)}
      >
        {tr("sessionsearch.allProjects")}
      </button>
    </div>
  );

  const facets = (
    <div className="session-search-facets" role="group" aria-label={tr("sessionsearch.filters")}>
      {SESSION_SEARCH_FACETS.map((token) => {
        const on = token === "is:waiting" ? query.waiting
          : token === "is:running" ? query.running
          : token === "is:archived" ? query.archived
          : token === "from:me" ? query.role === "user"
          : query.role === "assistant";
        return (
          <button
            key={token}
            type="button"
            className={`session-search-facet${on ? " active" : ""}`}
            aria-pressed={on}
            onClick={() => setQ((raw) => toggleSessionSearchFacet(raw, token))}
          >
            {FACET_LABEL[token]()}
          </button>
        );
      })}
    </div>
  );

  return (
    <ResponsiveOverlay
      open
      title={tr("sessionsearch.searchSessions")}
      onClose={close}
      desktop="dialog"
      phone="sheet"
      dialogSize="lg"
      className="palette session-search"
      initialFocus=".session-search-input"
      sheetSize="tall"
      {...(phone ? {
        sheetSearch: {
          value: q,
          onChange: setQ,
          placeholder,
          ariaLabel: placeholder,
          role: "combobox" as const,
          ariaExpanded: entries.length > 0,
          ariaControls: "session-search-listbox",
          ...(activeId ? { ariaActiveDescendant: activeId } : {}),
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
      {!phone && (
        <div className="session-search-field">
          <Icon icon={Search} className="session-search-field-icon" />
          <input
            className="session-search-input"
            type="search"
            value={q}
            role="combobox"
            aria-expanded={entries.length > 0}
            aria-controls="session-search-listbox"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={placeholder}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <span className="session-search-field-trail">
            {loading && <Spinner size="sm" label={tr("sessionsearch.searchingSessions")} />}
            {!loading && q && (
              <IconButton icon={X} size="sm" label={tr("sessionsearch.clear")} onClick={() => setQ("")} />
            )}
          </span>
        </div>
      )}
      <div className="session-search-toolbar">
        {!phone && scope}
        {facets}
      </div>
      <div className="palette-list session-search-list" id="session-search-listbox" role="listbox" ref={listRef} aria-busy={loading}>
        {!loading && searchFailed && (
          <div className="palette-empty" role="status">
            {tr("sessionsearch.couldnTSearchSessionContents")}
            <Button size="sm" className="palette-retry" onClick={() => setRetry((n) => n + 1)}>{tr("common.retry")}</Button>
          </div>
        )}
        {!loading && !searchFailed && entries.length === 0 && (
          <div className="palette-empty session-search-empty">
            <Icon icon={Search} size="lg" />
            <span>{query.text ? tr("sessionsearch.noResults", { query: query.text }) : tr("sessionsearch.noSessions")}</span>
          </div>
        )}
        {entries.map((entry, n) => {
          const selected = n === cursor;
          if (entry.kind === "session") {
            const { session: s } = entry;
            const title = deriveSessionTitle(s.title, firstUserText(events[s.id]) ?? draftTitleSource(s));
            const metaMatches = entry.matches.filter((m) => m.field === "branch" || m.field === "label");
            const hidden = Math.max(0, entry.messageHits - Math.min(VISIBLE_MESSAGE_HITS, entry.matches.filter((m) => m.field === "message").length));
            return (
              <button
                key={entry.key}
                type="button"
                id={`session-search-opt-${n}`}
                className={`session-search-row session-search-row--session${selected ? " active" : ""}`}
                role="option"
                aria-selected={selected}
                onClick={() => activate(entry)}
                onMouseMove={() => { if (cursor !== n) setCursor(n); }}
              >
                <span className={`dot ${s.status}`} aria-hidden="true" />
                <span className="session-search-row-main">
                  <span className="session-search-title"><Highlighted text={title} ranges={highlightRanges(title, terms)} /></span>
                  <span className="session-search-sub">
                    {allProjects && projectName.get(s.projectId) && <span className="session-search-project">{projectName.get(s.projectId)}</span>}
                    {s.branch && <span className="session-search-branch"><Highlighted text={s.branch} ranges={highlightRanges(s.branch, terms)} /></span>}
                    {metaMatches.filter((m) => m.field === "label").map((m, k) => (
                      <span key={k} className="session-search-label"><Highlighted text={m.snippet} ranges={highlightRanges(m.snippet, terms)} /></span>
                    ))}
                    {s.status === "archived" && <span className="session-search-archived">{tr("sessionsearch.facetArchived")}</span>}
                  </span>
                </span>
                <span className="session-search-row-meta">
                  {hidden > 0 && <span className="session-search-more">{tr("sessionsearch.moreMatches", { count: hidden })}</span>}
                  <time className="session-search-time">{ago(s.lastTurnAt ?? s.updatedAt ?? s.createdAt)}</time>
                </span>
              </button>
            );
          }
          const { match } = entry;
          return (
            <button
              key={entry.key}
              type="button"
              id={`session-search-opt-${n}`}
              className={`session-search-row session-search-row--message${selected ? " active" : ""}`}
              role="option"
              aria-selected={selected}
              aria-label={tr("sessionsearch.openMessage")}
              onClick={() => activate(entry)}
              onMouseMove={() => { if (cursor !== n) setCursor(n); }}
            >
              <span className={`session-search-role session-search-role--${match.role ?? "assistant"}`} aria-hidden="true">
                {match.role === "user" ? tr("sessionsearch.you") : tr("sessionsearch.agent")}
              </span>
              <span className="session-search-snippet"><Highlighted text={match.snippet} ranges={match.ranges ?? []} /></span>
              {typeof match.time === "number" && <time className="session-search-time">{ago(match.time)}</time>}
            </button>
          );
        })}
      </div>
    </ResponsiveOverlay>
  );
}

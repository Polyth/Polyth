// Archived sessions: one project's archive as its own surface. Paged server
// summaries (title/branch/path search) merge with transcript hits, then the
// archive-date and branch filters narrow the loaded rows; paging continues on
// scroll until a recency window is satisfied. Rows open read-only, restore
// into the navigator or delete permanently, singly or as a selection.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { SessionProjection } from "@polyth/contracts";
import { api, type SessionSearchResult } from "@polyth/session/web-api";
import { getState, setOverlay, setUiError, useStore } from "../store.ts";
import { deleteSession, openSession, refreshSessions } from "../init.ts";
import { requestConversationReveal } from "../conversationReveal.ts";
import { createSummaryPager, type SummaryPageState } from "../sessionSummaryPages.ts";
import { displaySessionTitle, modelBadge } from "../format.ts";
import { friendlyError } from "../settings.ts";
import { announce } from "./a11y/live.tsx";
import { getLocale, tr } from "../i18n/index.ts";
import { sessionDateGroupLabel } from "../sessionDates.ts";
import { highlightRanges, segmentHighlights } from "../sessionSearchQuery.ts";
import { useShellMode } from "../responsiveShell.ts";
import {
  ARCHIVED_ANY_BRANCH,
  ARCHIVED_DATE_PRESETS,
  ARCHIVED_MAIN_BRANCH,
  archivedAt,
  archivedBranchOptions,
  archivedPagingSatisfied,
  groupArchivedByDay,
  matchesArchivedFilters,
  mergeArchivedEntries,
  type ArchivedDatePreset,
  type ArchivedEntry,
} from "../archivedSessions.ts";
import {
  ArchiveIcon,
  BranchIcon,
  Button,
  Checkbox,
  CloseIcon,
  DeleteIcon,
  Icon,
  IconButton,
  ResponsiveOverlay,
  RestoreIcon,
  SearchIcon,
  Select,
  Skeleton,
  Spinner,
  confirmAlert,
} from "./ui/index.ts";
import ProjectGlyph from "./ProjectGlyph.tsx";
import "./ArchivedSessionsDialog.css";

const DEBOUNCE_MS = 140;
const PAGE_SIZE = 50;
const CONTENT_LIMIT = 40;

const PRESET_LABEL: Record<ArchivedDatePreset, () => string> = {
  any: () => tr("archivedsessions.anyTime"),
  today: () => tr("archivedsessions.today"),
  week: () => tr("archivedsessions.pastWeek"),
  month: () => tr("archivedsessions.pastMonth"),
  older: () => tr("archivedsessions.older"),
};

function Highlighted({ text, ranges }: { text: string; ranges: ReadonlyArray<readonly [number, number]> }): ReactNode {
  if (ranges.length === 0) return text;
  return segmentHighlights(text, ranges).map((segment, index) => segment.hit
    ? <mark key={index} className="archived-sessions-mark">{segment.text}</mark>
    : <span key={index}>{segment.text}</span>);
}

function mergeRows(previous: readonly SessionProjection[], next: readonly SessionProjection[]): SessionProjection[] {
  const byId = new Map(previous.map((row) => [row.id, row] as const));
  for (const row of next) byId.set(row.id, row);
  return [...byId.values()];
}

export default function ArchivedSessionsDialog() {
  const projectId = useStore((state) => state.archivedSessionsProjectId);
  const project = useStore((state) => state.projectRegistry.projects.find((candidate) => candidate.id === projectId));
  const relativeTime = useStore((state) => state.settings.relativeTime);
  const phone = useShellMode() === "phone";
  const [q, setQ] = useState("");
  const [text, setText] = useState("");
  const [preset, setPreset] = useState<ArchivedDatePreset>("any");
  const [branch, setBranch] = useState(ARCHIVED_ANY_BRANCH);
  const [rows, setRows] = useState<SessionProjection[]>([]);
  const [pageState, setPageState] = useState<SummaryPageState>({ busy: true, hasMore: true });
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hits, setHits] = useState<SessionSearchResult[]>([]);
  const [contentBusy, setContentBusy] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [retry, setRetry] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const now = useMemo(() => Date.now(), [rows, preset]);
  const terms = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);

  useEffect(() => {
    const handle = setTimeout(() => setText(q.trim()), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [q]);

  const pager = useMemo(() => createSummaryPager(
    api.listSessionSummaries,
    (page) => setRows((previous) => mergeRows(previous, page)),
    setPageState,
  ), []);
  const loadMore = () => pager.more()
    .then(() => setLoaded(true))
    .catch(() => { setFailed(true); setLoaded(true); });

  useEffect(() => {
    if (!projectId) return;
    setRows([]);
    setLoaded(false);
    setFailed(false);
    pager.reset({ projectId, archived: true, limit: PAGE_SIZE, ...(text ? { query: text } : {}) });
    void loadMore();
    return () => pager.cancel();
  }, [projectId, text, retry, pager]);

  // Transcript hits find archived chats by what was said, not only by title.
  useEffect(() => {
    setHits([]);
    if (!projectId || !text) { setContentBusy(false); return; }
    const controller = new AbortController();
    setContentBusy(true);
    void api.searchSessions(text, { projectId, limit: CONTENT_LIMIT }, controller.signal)
      .then((results) => { if (!controller.signal.aborted) setHits(results); })
      .catch(() => { /* metadata matches still render; content search is additive */ })
      .finally(() => { if (!controller.signal.aborted) setContentBusy(false); });
    return () => controller.abort();
  }, [projectId, text]);

  // Rows with a restore/delete in flight leave the list at once (optimistic);
  // a failed request brings them back in place.
  const entries = useMemo(
    () => (projectId
      ? mergeArchivedEntries(rows, hits, projectId).filter((entry) => !busyIds.has(entry.session.id))
      : []),
    [rows, hits, projectId, busyIds],
  );
  const branches = useMemo(() => archivedBranchOptions(entries), [entries]);
  const visible = useMemo(
    () => entries.filter((entry) => matchesArchivedFilters(entry, { preset, branch }, now)),
    [entries, preset, branch, now],
  );
  const groups = useMemo(() => groupArchivedByDay(visible), [visible]);
  const satisfied = archivedPagingSatisfied(rows, preset, now);
  const canLoadMore = pageState.hasMore && !failed && !satisfied;
  const filtersActive = preset !== "any" || branch !== ARCHIVED_ANY_BRANCH || text !== "";

  // Keep paging while the sentinel is in view: a narrow filter over a long
  // archive fills the list instead of showing an empty first page.
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !canLoadMore || pageState.busy || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) void loadMore();
    }, { root: listRef.current, rootMargin: "240px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [canLoadMore, pageState.busy, visible.length]);

  useEffect(() => { setCursor(0); }, [text, preset, branch]);
  useEffect(() => {
    setSelected((current) => {
      const ids = new Set(entries.map((entry) => entry.session.id));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [entries]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".archived-sessions-row.is-cursor")?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  if (!projectId) return null;

  const close = () => setOverlay(null);
  const removeLocally = (ids: readonly string[]) => {
    const gone = new Set(ids);
    setRows((previous) => previous.filter((row) => !gone.has(row.id)));
    setHits((previous) => previous.filter((hit) => !gone.has(hit.sessionId)));
    setSelected((previous) => new Set([...previous].filter((id) => !gone.has(id))));
  };
  const markBusy = (ids: readonly string[], busy: boolean) => setBusyIds((previous) => {
    const next = new Set(previous);
    for (const id of ids) {
      if (busy) next.add(id);
      else next.delete(id);
    }
    return next;
  });

  const open = (entry: ArchivedEntry) => {
    close();
    const id = entry.session.id;
    const seq = entry.match?.seq;
    void openSession(id).then(() => {
      if (seq !== undefined) requestConversationReveal(id, seq, { current: () => getState().activeSessionId === id });
    });
  };

  const restore = async (ids: readonly string[]) => {
    if (ids.length === 0) return;
    markBusy(ids, true);
    try {
      const result = await api.bulkSessions("restore", [...ids]);
      removeLocally(result.succeeded);
      announce(result.succeeded.length === 1
        ? tr("archivedsessions.restoredOne")
        : tr("archivedsessions.restoredCount", { count: result.succeeded.length }));
      if (result.failed.length > 0) {
        setUiError(tr("archivedsessions.restoreFailed", { count: result.failed.length }));
      }
      void refreshSessions(projectId);
    } catch (error) {
      setUiError(friendlyError(tr("archivedsessions.restoreFailed", { count: ids.length }), error));
    } finally {
      markBusy(ids, false);
    }
  };

  const remove = async (ids: readonly string[]) => {
    if (ids.length === 0) return;
    const single = ids.length === 1
      ? entries.find((entry) => entry.session.id === ids[0])
      : undefined;
    const ok = await confirmAlert(
      single
        ? tr("archivedsessions.confirmDeleteOne", { title: displaySessionTitle(single.session.title, single.session.id) })
        : tr("archivedsessions.confirmDeleteMany", { count: ids.length }),
      { title: tr("archivedsessions.deletePermanently"), confirmLabel: tr("common.delete"), destructive: true },
    );
    if (!ok) return;
    markBusy(ids, true);
    const deleted: string[] = [];
    for (const id of ids) {
      try {
        await deleteSession(id);
        deleted.push(id);
      } catch {
        // Counted below; the rest of the selection still proceeds.
      }
    }
    removeLocally(deleted);
    markBusy(ids, false);
    announce(deleted.length === 1
      ? tr("archivedsessions.deletedOne")
      : tr("archivedsessions.deletedCount", { count: deleted.length }));
    if (deleted.length < ids.length) {
      setUiError(tr("archivedsessions.deleteFailed", { count: ids.length - deleted.length }));
    }
  };

  const toggleSelected = (id: string) => setSelected((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const allVisibleSelected = visible.length > 0 && visible.every((entry) => selected.has(entry.session.id));
  const selectAllVisible = () => setSelected(allVisibleSelected
    ? new Set()
    : new Set(visible.map((entry) => entry.session.id)));

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const count = Math.max(visible.length, 1);
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor((value) => (value + 1) % count); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setCursor((value) => (value - 1 + count) % count); }
    else if (event.key === "Enter" && visible[cursor]) { event.preventDefault(); open(visible[cursor]!); }
    else if (event.key === "Escape" && q) { event.preventDefault(); event.stopPropagation(); setQ(""); }
  };

  const locale = getLocale();
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
  const fullFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const dayFormat = (timestamp: number) => new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(new Date(timestamp).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  }).format(timestamp);
  const branchLabel = (key: string) => key === ARCHIVED_MAIN_BRANCH ? tr("sidebar.sessionlist.mainWorktree") : key;
  const projectName = project?.name || project?.path || "";
  const placeholder = tr("archivedsessions.searchPlaceholder");
  const searching = contentBusy || (pageState.busy && !loaded);
  const countLabel = canLoadMore
    ? tr("archivedsessions.countMore", { count: entries.length })
    : tr("archivedsessions.count", { count: entries.length });

  const toolbar = (
    <div className="archived-sessions-toolbar">
      <div className="archived-sessions-presets" role="group" aria-label={tr("archivedsessions.archivedWhen")}>
        {ARCHIVED_DATE_PRESETS.map((value) => (
          <button
            key={value}
            type="button"
            className={`archived-sessions-chip${preset === value ? " active" : ""}`}
            aria-pressed={preset === value}
            onClick={() => setPreset(value)}
          >
            {PRESET_LABEL[value]()}
          </button>
        ))}
      </div>
      {branches.length > 1 && (
        <Select
          className="archived-sessions-branch"
          label={tr("archivedsessions.branch")}
          value={branch}
          onChange={setBranch}
          options={[
            { value: ARCHIVED_ANY_BRANCH, label: tr("archivedsessions.allBranches") },
            ...branches.map((key) => ({ value: key, label: branchLabel(key) })),
          ]}
        />
      )}
    </div>
  );

  const selectionBar = selected.size > 0 && (
    <div className="archived-sessions-selection" role="toolbar" aria-label={tr("archivedsessions.selection")}>
      <span className="archived-sessions-selection-count">{tr("archivedsessions.selectedCount", { count: selected.size })}</span>
      <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>{tr("common.cancel")}</Button>
      <span className="header-spacer" />
      <Button size="sm" variant="danger" iconStart={DeleteIcon} onClick={() => void remove([...selected])}>
        {tr("common.delete")}
      </Button>
      <Button size="sm" variant="primary" iconStart={RestoreIcon} onClick={() => void restore([...selected])}>
        {tr("common.restore")}
      </Button>
    </div>
  );

  const footer = selectionBar || (
    <div className="archived-sessions-footer">
      <span className="archived-sessions-summary" role="status" aria-live="polite">
        {searching ? tr("archivedsessions.searching") : filtersActive
          ? tr("archivedsessions.showingOf", { shown: visible.length, total: countLabel })
          : countLabel}
      </span>
      {!phone && (
        <span className="archived-sessions-keys">
          <kbd>↑↓</kbd> {tr("sessionsearch.navigate")}{" "}<kbd>↵</kbd> {tr("sessionsearch.open")}{" "}<kbd>{tr("sessionsearch.esc")}</kbd> {tr("sessionsearch.close")}
        </span>
      )}
    </div>
  );

  const row = (entry: ArchivedEntry, index: number) => {
    const { session, match } = entry;
    const title = displaySessionTitle(session.title, session.id);
    const at = archivedAt(session);
    const busy = busyIds.has(session.id);
    const checked = selected.has(session.id);
    const model = session.model ? modelBadge(session.model) : undefined;
    return (
      <div
        key={session.id}
        role="listitem"
        className={`archived-sessions-row${index === cursor ? " is-cursor" : ""}${checked ? " is-selected" : ""}${busy ? " is-busy" : ""}`}
        onMouseMove={() => { if (cursor !== index) setCursor(index); }}
      >
        <Checkbox
          className="archived-sessions-check"
          checked={checked}
          onChange={() => toggleSelected(session.id)}
          label={<span className="sr-only">{tr("archivedsessions.selectValue", { title })}</span>}
        />
        <button type="button" className="archived-sessions-open" onClick={() => open(entry)} disabled={busy}>
          <span className="archived-sessions-title"><Highlighted text={title} ranges={highlightRanges(title, terms)} /></span>
          <span className="archived-sessions-sub">
            {session.branch && (
              <span className="archived-sessions-branch-tag">
                <Icon icon={BranchIcon} size="sm" />
                <Highlighted text={session.branch} ranges={highlightRanges(session.branch, terms)} />
              </span>
            )}
            {model && <span className="archived-sessions-model"><span className="archived-sessions-model-dot" style={{ background: model.color }} />{model.label}</span>}
            {session.parentId && <span className="archived-sessions-tag">{tr("archivedsessions.subagent")}</span>}
            <span className="archived-sessions-created">{tr("archivedsessions.createdOn", { date: dayFormat(session.createdAt) })}</span>
          </span>
          {match && (
            <span className="archived-sessions-snippet">
              <span className={`archived-sessions-role archived-sessions-role--${match.role ?? "assistant"}`}>
                {match.role === "user" ? tr("sessionsearch.you") : tr("sessionsearch.agent")}
              </span>
              <span className="archived-sessions-snippet-text"><Highlighted text={match.snippet} ranges={match.ranges ?? []} /></span>
              {entry.messageHits > 1 && <span className="archived-sessions-more">{tr("sessionsearch.moreMatches", { count: entry.messageHits - 1 })}</span>}
            </span>
          )}
        </button>
        <span className="archived-sessions-meta">
          <time className="archived-sessions-time" dateTime={new Date(at).toISOString()} title={tr("archivedsessions.archivedOn", { date: fullFormat.format(at) })}>
            {timeFormat.format(at)}
          </time>
          <span className="archived-sessions-actions">
            <IconButton
              icon={RestoreIcon}
              size="sm"
              label={tr("archivedsessions.restoreValue", { title })}
              busy={busy}
              onClick={() => void restore([session.id])}
            />
            <IconButton
              icon={DeleteIcon}
              size="sm"
              variant="danger"
              label={tr("archivedsessions.deleteValue", { title })}
              disabled={busy}
              onClick={() => void remove([session.id])}
            />
          </span>
        </span>
      </div>
    );
  };

  let index = 0;
  const body = (() => {
    if (!loaded && rows.length === 0) {
      return (
        <div className="archived-sessions-skeleton" aria-busy="true" role="status" aria-label={tr("common.loading")}>
          {Array.from({ length: 6 }, (_, n) => (
            <div key={n} className="archived-sessions-skeleton-row">
              <Skeleton width="58%" />
              <Skeleton width="34%" />
            </div>
          ))}
        </div>
      );
    }
    if (failed && entries.length === 0) {
      return (
        <div className="archived-sessions-empty" role="alert">
          <Icon icon={ArchiveIcon} size="xl" />
          <span>{tr("archivedsessions.loadFailed")}</span>
          <Button size="sm" onClick={() => setRetry((value) => value + 1)}>{tr("common.retry")}</Button>
        </div>
      );
    }
    if (entries.length === 0 && !filtersActive && !pageState.busy) {
      return (
        <div className="archived-sessions-empty">
          <Icon icon={ArchiveIcon} size="xl" />
          <strong>{tr("archivedsessions.emptyTitle")}</strong>
          <span>{tr("archivedsessions.emptyHint")}</span>
        </div>
      );
    }
    if (visible.length === 0 && !canLoadMore && !pageState.busy && !contentBusy) {
      return (
        <div className="archived-sessions-empty">
          <Icon icon={SearchIcon} size="xl" />
          <span>{text ? tr("sessionsearch.noResults", { query: text }) : tr("archivedsessions.noMatches")}</span>
          <Button size="sm" onClick={() => { setQ(""); setText(""); setPreset("any"); setBranch(ARCHIVED_ANY_BRANCH); }}>
            {tr("archivedsessions.clearFilters")}
          </Button>
        </div>
      );
    }
    return (
      <div role="list" aria-label={tr("archivedsessions.title")}>
        {groups.map((group) => {
          const raw = sessionDateGroupLabel(group.timestamp, relativeTime, locale, now);
          const label = raw.charAt(0).toLocaleUpperCase(locale) + raw.slice(1);
          return (
            <section key={group.key} className="archived-sessions-day" aria-label={label}>
              <div className="archived-sessions-day-head" role="presentation">
                <span>{label}</span>
                <span className="archived-sessions-day-count">{group.entries.length}</span>
              </div>
              {group.entries.map((entry) => row(entry, index++))}
            </section>
          );
        })}
      </div>
    );
  })();

  return (
    <ResponsiveOverlay
      open
      title={tr("archivedsessions.title")}
      onClose={close}
      desktop="dialog"
      phone="sheet"
      dialogSize="lg"
      sheetSize="tall"
      className="palette archived-sessions"
      {...(phone ? {} : { initialFocus: ".archived-sessions-input" })}
      {...(phone ? {
        sheetSearch: { value: q, onChange: setQ, placeholder, ariaLabel: placeholder, onKeyDown: onKey },
      } : {})}
      sheetFooter={footer}
      dialogFooter={footer}
    >
      <div className="archived-sessions-head">
        {project && <ProjectGlyph project={project} className="archived-sessions-glyph" />}
        <span className="archived-sessions-project">{projectName}</span>
        <span className="archived-sessions-total">{countLabel}</span>
        {visible.length > 0 && (
          <button type="button" className="archived-sessions-select-all" onClick={selectAllVisible}>
            {allVisibleSelected ? tr("archivedsessions.clearSelection") : tr("archivedsessions.selectAll")}
          </button>
        )}
      </div>
      {!phone && (
        <div className="archived-sessions-field">
          <Icon icon={SearchIcon} className="archived-sessions-field-icon" />
          <input
            className="archived-sessions-input"
            type="search"
            value={q}
            aria-label={placeholder}
            aria-controls="archived-sessions-list"
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={onKey}
          />
          <span className="archived-sessions-field-trail">
            {searching && <Spinner size="sm" label={tr("archivedsessions.searching")} />}
            {!searching && q && <IconButton icon={CloseIcon} size="sm" label={tr("sessionsearch.clear")} onClick={() => setQ("")} />}
          </span>
        </div>
      )}
      {toolbar}
      <div className="archived-sessions-list ui-scroll" id="archived-sessions-list" ref={listRef} aria-busy={pageState.busy}>
        {body}
        {(canLoadMore || (pageState.busy && loaded)) && (
          <div className="archived-sessions-more-row" ref={sentinelRef}>
            {pageState.busy
              ? <Spinner size="sm" label={tr("common.loading")} />
              : <Button size="sm" variant="ghost" onClick={() => void loadMore()}>{tr("archivedsessions.loadMore")}</Button>}
          </div>
        )}
      </div>
    </ResponsiveOverlay>
  );
}

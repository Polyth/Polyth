import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  catalogSections,
  catalogStats,
  endpoint,
  filterEntries,
  isLocal,
  type CatalogPayload,
  type CatalogSection,
} from "../src/catalog.ts";
import { CATEGORY_ORDER, type IntegrationCategory, type IntegrationManifest } from "../src/manifest.ts";
import { brandMarkFor } from "../src/brand.ts";
import {
  planInstall,
  type InstallScope,
  type InstalledIntegration,
} from "../src/install.ts";
import { catalogStrings, fill, type CatalogStrings } from "../src/strings.ts";

const ENTRIES_PATH = "/api/integration-catalog/entries";
const LOGO_PATH = "/api/integration-catalog/logo";
const INSTALL_PATH = "/api/integration-catalog/install";
const UNINSTALL_PATH = "/api/integration-catalog/uninstall";

type Load =
  | { state: "loading" }
  | { state: "ready"; payload: CatalogPayload }
  | { state: "failed" };

/** A mutation in flight: which entry, and whether it is an install or remove. */
type Busy = { entryId: string; kind: "install" | "uninstall" } | null;

/** The page's own classification of why a connection is (or is not) offered. */
type Action =
  | { kind: "connect"; scope: InstallScope; needsToken: boolean; tokenOptional: boolean }
  | { kind: "disconnect"; catalogManaged: boolean }
  | { kind: "blocked"; reason: "token-header-missing" | "local-unpinned" };

function scopeLabel(scope: InstallScope, s: CatalogStrings): string {
  if (scope === "project") return s.detailScopeProject;
  if (scope === "space") return s.detailScopeSpace;
  return s.detailScopePerson;
}

/** Decide what the action area offers for one entry, from pure rules. */
function actionFor(
  entry: IntegrationManifest,
  installed: InstalledIntegration | undefined,
): Action {
  if (installed) {
    return { kind: "disconnect", catalogManaged: installed.catalogManaged };
  }
  const auth = entry.mcp.auth;

  // A token entry that never says how the key travels cannot connect: it is
  // a structural gap in the manifest, not something the person can fill in.
  if (auth === "token" && entry.mcp.remote && !entry.mcp.remote.tokenHeader) {
    return { kind: "blocked", reason: "token-header-missing" };
  }

  if (auth === "token") {
    const tokenOptional = entry.mcp.remote?.tokenOptional === true;
    return { kind: "connect", scope: "person", needsToken: !tokenOptional, tokenOptional };
  }

  if (isLocal(entry)) {
    const plan = planInstall(entry);
    if (!plan.ok && plan.failure === "local-unpinned") {
      return { kind: "blocked", reason: "local-unpinned" };
    }
    return { kind: "connect", scope: plan.ok ? plan.scope : "project", needsToken: false, tokenOptional: false };
  }

  // OAuth and no-auth remotes install into the project (or the Space).
  const plan = planInstall(entry);
  return { kind: "connect", scope: plan.ok ? plan.scope : "project", needsToken: false, tokenOptional: false };
}

function sectionTitle(section: CatalogSection, s: CatalogStrings): string {
  if (section.id === "featured") return s.featured;
  if (section.id in s.category) return s.category[section.id as IntegrationCategory];
  return section.id;
}

function probeText(entry: IntegrationManifest): string {
  const probe = entry.evidence.probe;
  if (probe.state === "observed") {
    const status = probe.httpStatus !== undefined ? `HTTP ${probe.httpStatus}` : "HTTP ?";
    return `${status}${probe.challenge ? ` · ${probe.challenge}` : ""}${probe.note ? ` — ${probe.note}` : ""}`;
  }
  if (probe.state === "documented") return `Documented by the vendor${probe.note ? ` — ${probe.note}` : ""}`;
  return `Not checked yet${probe.note ? ` — ${probe.note}` : ""}`;
}

function requirementLabel(requirement: string): string {
  if (requirement === "node") return "Node.js";
  if (requirement === "python") return "Python (uv)";
  return "Docker";
}

/**
 * The Integrations page: the catalog in place of Chat. A geometric two-pane
 * surface — a fixed-height list of services on the left, a structured detail
 * panel on the right — with the connection itself as the primary action.
 */
export default function IntegrationsPage({ projectId, locale, onOpenMcpSettings }: {
  projectId?: string | null;
  locale?: string;
  /** Opens the host's MCP settings; absent on a host without that route. */
  onOpenMcpSettings?: () => void;
}) {
  const s = catalogStrings(locale);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<IntegrationCategory | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotes, setActionNotes] = useState<string[]>([]);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  /** Narrow enough that the detail replaces the list instead of sitting beside
   *  it. Read from the page's own width, the same measure the CSS queries. */
  const [narrow, setNarrow] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    const node = pageRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setNarrow((entry?.contentRect.width ?? node.clientWidth) < 820);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // A refresh after an action keeps the list on screen; only the first load
    // shows the skeleton, so a server note is not wiped by the re-read.
    setLoad((current) => (current.state === "ready" ? current : { state: "loading" }));
    const queryString = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    void (async () => {
      try {
        const response = await fetch(`${ENTRIES_PATH}${queryString}`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as CatalogPayload;
        if (controller.signal.aborted) return;
        setLoad({ state: "ready", payload });
      } catch {
        if (controller.signal.aborted) return;
        setLoad({ state: "failed" });
      }
    })();
    return () => controller.abort();
  }, [attempt, projectId]);

  const payload = load.state === "ready" ? load.payload : null;
  const entries = payload?.entries ?? [];

  const visible = useMemo(
    () => (payload ? filterEntries(payload.entries, { query, category }) : []),
    [payload, query, category],
  );

  const sections = useMemo(
    () => (payload && !query.trim() && category === "all" ? catalogSections(payload.entries) : []),
    [payload, query, category],
  );

  const flat = useMemo(() => {
    if (sections.length > 0) return sections.flatMap((section) => section.entries);
    return visible;
  }, [sections, visible]);

  const selected = useMemo(() => {
    const byId = entries.find((entry) => entry.id === selectedId);
    if (byId && flat.some((entry) => entry.id === byId.id)) return byId;
    return flat[0] ?? null;
  }, [entries, selectedId, flat]);

  const installedById = useMemo(() => {
    const map = new Map<string, InstalledIntegration>();
    for (const row of payload?.installed ?? []) {
      if (!map.has(row.entryId)) map.set(row.entryId, row);
    }
    return map;
  }, [payload]);

  const totals = useMemo(() => (payload ? catalogStats(payload.entries) : null), [payload]);
  // Counts describe what the search leaves, so a filtered view never advertises
  // entries it is not showing.
  const shownTotals = useMemo(() => {
    if (!payload) return null;
    if (!query.trim()) return totals;
    return catalogStats(visible);
  }, [payload, query, totals, visible]);

  const installed = selected ? installedById.get(selected.id) : undefined;
  const action = useMemo(
    () => (selected ? actionFor(selected, installed) : null),
    [selected, installed],
  );

  // Reset per-entry form state whenever the selection changes.
  const selectedKey = selected?.id ?? null;
  useEffect(() => {
    setToken("");
    setShowToken(false);
    setActionError(null);
    setActionNotes([]);
  }, [selectedId]);

  const onSelect = useCallback((id: string) => {
    setSelectedId(id);
    // On a phone the tap opens the entry's own screen; there is no second pane
    // to show it in.
    if (narrow) setDetailOpen(true);
  }, [narrow]);

  const closeDetail = useCallback(() => setDetailOpen(false), []);

  const runInstall = useCallback(async () => {
    if (!selected || busy) return;
    const tokenValue = token.trim();
    const plan = planInstall(selected, { token: tokenValue || undefined });
    if (!plan.ok) {
      setActionError(plan.message);
      setActionNotes([]);
      return;
    }
    setBusy({ entryId: selected.id, kind: "install" });
    setActionError(null);
    setActionNotes([]);
    try {
      const response = await fetch(INSTALL_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          entryId: selected.id,
          ...(projectId ? { projectId } : {}),
          ...(plan.scope === "person" ? { token: tokenValue } : {}),
          scope: plan.scope,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        notes?: string[];
      };
      if (!response.ok) {
        setActionError(body.message || s.errorGeneric);
        return;
      }
      setActionNotes(body.notes ?? []);
      setToken("");
      setShowToken(false);
      setAttempt((value) => value + 1);
    } catch {
      setActionError(s.errorGeneric);
    } finally {
      setBusy(null);
    }
  }, [selected, busy, token, projectId, s]);

  const runUninstall = useCallback(async () => {
    if (!selected || !installed || busy) return;
    setBusy({ entryId: selected.id, kind: "uninstall" });
    setActionError(null);
    setActionNotes([]);
    try {
      const response = await fetch(UNINSTALL_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ entryId: selected.id, ...(projectId ? { projectId } : {}) }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!response.ok) {
        setActionError(body.message || s.errorGeneric);
        return;
      }
      setAttempt((value) => value + 1);
    } catch {
      setActionError(s.errorGeneric);
    } finally {
      setBusy(null);
    }
  }, [selected, installed, busy, projectId, s]);

  // Keyboard: "/" focuses search, Esc clears it, arrows move, Enter opens.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const inSearch = target === searchRef.current;
      const inInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

      if (event.key === "/" && !inInput) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        if (narrow && detailOpen) {
          event.preventDefault();
          setDetailOpen(false);
          return;
        }
        if (inSearch && query) {
          event.preventDefault();
          setQuery("");
          searchRef.current?.focus();
        }
        return;
      }
      if (inInput) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (flat.length === 0) return;
        event.preventDefault();
        const index = selected ? flat.findIndex((entry) => entry.id === selected.id) : -1;
        const next = event.key === "ArrowDown"
          ? Math.min(index + 1, flat.length - 1)
          : Math.max(index - 1, 0);
        setSelectedId(flat[next]?.id ?? flat[0]?.id ?? null);
        return;
      }
    },
    [flat, selected, query, narrow, detailOpen],
  );

  // Keep the active list row scrolled into view as selection changes.
  useEffect(() => {
    const active = listRef.current?.querySelector('[aria-selected="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const emptyVisible = payload !== null && entries.length > 0 && visible.length === 0;

  return (
    <div className="icat-page" data-project={projectId ?? undefined} onKeyDown={onKeyDown} ref={pageRef}>
      <div className="icat-shell">
      <header className="icat-head" data-hidden={narrow && detailOpen ? "true" : undefined}>
        <h1>{s.title}</h1>
        <p className="icat-subtitle">{s.subtitle}</p>
      </header>

      {load.state === "loading" ? <Skeleton s={s} /> : null}

      {load.state === "failed" ? (
        <div className="icat-state">
          <p className="icat-state-text">{s.loadFailed}</p>
          <button type="button" className="icat-btn-secondary" onClick={() => setAttempt((value) => value + 1)}>
            {s.retry}
          </button>
        </div>
      ) : null}

      {payload && payload.problems.length > 0 ? <Problems problems={payload.problems} s={s} /> : null}

      {payload && payload.entries.length === 0 ? (
        <div className="icat-state">
          <p className="icat-state-text">{s.empty}</p>
        </div>
      ) : null}

      {payload && payload.entries.length > 0 ? (
        <div
          className="icat-body"
          /* A filter that empties the list while an entry is open must not
             leave a phone on a blank screen: the directory owns the view when
             there is nothing to show beside it. */
          data-view={narrow ? (detailOpen && selected ? "detail" : "list") : "split"}
          data-empty={emptyVisible ? "true" : undefined}
        >
          {/* The search and the categories belong to the directory, so they live
              inside its column: the entry's own screen has no list to filter,
              and hiding them with the column is honest (display: none) instead
              of leaving them in the tab order. */}
          <div className="icat-col-list">
            <div className="icat-list-head">
              <label className="icat-search">
                <span className="icat-sr">{s.search}</span>
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  placeholder={s.search}
                  aria-label={s.search}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <div className="icat-chips" role="group" aria-label={s.sections}>
                <button
                  type="button"
                  className="icat-chip"
                  aria-pressed={category === "all"}
                  onClick={() => setCategory("all")}
                >
                  {s.all}
                  <span className="icat-chip-count">{shownTotals?.total ?? 0}</span>
                </button>
                {CATEGORY_ORDER.filter((id) => (totals?.byCategory[id] ?? 0) > 0).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="icat-chip"
                    aria-pressed={category === id}
                    onClick={() => setCategory(id)}
                  >
                    {s.category[id]}
                  </button>
                ))}
              </div>
            </div>
            <div
              className="icat-list"
              ref={listRef}
              role="listbox"
              aria-label={s.title}
              aria-activedescendant={selected ? `icat-opt-${selected.id}` : undefined}
            >
              {emptyVisible ? (
                <div className="icat-empty">
                  <p className="icat-empty-text">{fill(s.searchEmpty, { query })}</p>
                  <button type="button" className="icat-btn-secondary" onClick={() => setQuery("")}>
                    {s.searchClear}
                  </button>
                </div>
              ) : sections.length > 0 ? (
                sections.map((section) => (
                  <section key={section.id} className="icat-section">
                    <h2 className="icat-section-title">
                      {sectionTitle(section, s)}
                      <span className="icat-section-count">{section.entries.length}</span>
                    </h2>
                    {section.entries.map((entry) => (
                      <Row
                        key={entry.id}
                        entry={entry}
                        active={selected?.id === entry.id}
                        installed={installedById.get(entry.id)}
                        s={s}
                        onSelect={onSelect}
                      />
                    ))}
                  </section>
                ))
              ) : (
                visible.map((entry) => (
                  <Row
                    key={entry.id}
                    entry={entry}
                    active={selected?.id === entry.id}
                    installed={installedById.get(entry.id)}
                    s={s}
                    onSelect={onSelect}
                  />
                ))
              )}
            </div>
          </div>

          {selected && (!narrow || detailOpen) ? (
            <div className="icat-pane">
              {narrow ? (
                <button type="button" className="icat-back" onClick={closeDetail}>
                  <span className="icat-back-glyph" aria-hidden="true">←</span>
                  {s.back}
                </button>
              ) : null}
              <Detail
                entry={selected}
                installed={installed}
                action={action}
                busy={busy?.entryId === selected.id ? busy.kind : null}
                token={token}
                showToken={showToken}
                onTokenChange={setToken}
                onToggleToken={() => setShowToken((value) => !value)}
                onInstall={runInstall}
                onUninstall={runUninstall}
                actionError={actionError}
                actionNotes={actionNotes}
                onOpenMcpSettings={onOpenMcpSettings}
                s={s}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
    </div>
  );
}

/**
 * The service's own glyph on a brand-tinted tile. Vector marks are drawn as a
 * mask so the glyph follows the theme; the two raster marks are alpha-only for
 * the same reason. Without a mark the entry keeps a letter, never a broken
 * image.
 */
function Mark({ entry, size }: { entry: IntegrationManifest; size: "row" | "detail" }) {
  const mark = brandMarkFor(entry.id);
  const style = mark ? ({ "--icat-brand": mark.color } as React.CSSProperties) : undefined;
  return (
    <span
      className={`icat-mark icat-mark-${size}${mark ? "" : " icat-mark-letter"}`}
      style={style}
      aria-hidden="true"
    >
      {mark
        ? (
          <span
            className="icat-mark-glyph"
            style={{ maskImage: `url(${LOGO_PATH}/${entry.id})`, WebkitMaskImage: `url(${LOGO_PATH}/${entry.id})` }}
          />
        )
        : entry.name.slice(0, 1)}
    </span>
  );
}

/** A catalog row: the service mark, its name, one line of what it gives the
 *  agent, and whether it is connected. */
function Row(props: {
  entry: IntegrationManifest;
  active: boolean;
  installed: InstalledIntegration | undefined;
  s: CatalogStrings;
  onSelect: (id: string) => void;
}) {
  const { entry, active, installed, s, onSelect } = props;
  return (
    <button
      type="button"
      id={`icat-opt-${entry.id}`}
      className="icat-row"
      role="option"
      aria-selected={active}
      data-active={active ? "true" : undefined}
      onClick={() => onSelect(entry.id)}
    >
      <Mark entry={entry} size="row" />
      <span className="icat-row-text">
        <span className="icat-row-title">
          <span className="icat-row-name">{entry.name}</span>
          {entry.status === "beta" ? <span className="icat-badge">{s.beta}</span> : null}
          {isLocal(entry) ? <span className="icat-badge">{s.local}</span> : null}
        </span>
        <span className="icat-row-summary">{entry.summary}</span>
      </span>
      {installed
        ? <span className={`icat-row-status${installed.enabled ? " icat-row-status-on" : ""}`} role="img" aria-label={s.installed} title={s.installed} />
        : <span className="icat-row-status" aria-hidden="true" />}
    </button>
  );
}

/** The structured detail panel for the selected entry. */
function Detail(props: {
  entry: IntegrationManifest;
  installed: InstalledIntegration | undefined;
  action: Action | null;
  busy: "install" | "uninstall" | null;
  token: string;
  showToken: boolean;
  onTokenChange: (value: string) => void;
  onToggleToken: () => void;
  onInstall: () => void;
  onUninstall: () => void;
  actionError: string | null;
  actionNotes: string[];
  onOpenMcpSettings?: (() => void) | undefined;
  s: CatalogStrings;
}) {
  const {
    entry, installed, action, busy, token, showToken,
    onTokenChange, onToggleToken, onInstall, onUninstall, actionError, actionNotes,
    onOpenMcpSettings, s,
  } = props;
  const local = isLocal(entry);
  const target = endpoint(entry);
  const probe = entry.evidence.probe;
  const skills = entry.skills ?? [];
  const requires = entry.mcp.local?.requires ?? [];

  const connectDisabled =
    busy !== null || action === null || action.kind !== "connect"
    || (action.kind === "connect" && action.needsToken && token.trim().length === 0);
  const showTokenField = action?.kind === "connect" && action.scope === "person"
    && entry.mcp.auth === "token";

  return (
    <article className="icat-detail" aria-labelledby="icat-detail-title">
      <header className="icat-detail-head">
        <Mark entry={entry} size="detail" />
        <div className="icat-detail-head-text">
          <div className="icat-detail-title-row">
            <h2 id="icat-detail-title">{entry.name}</h2>
            {entry.status === "beta" ? <span className="icat-pill">{s.beta}</span> : null}
            {installed ? <span className="icat-pill icat-pill-on">{s.installed}</span> : null}
          </div>
          <p className="icat-detail-summary">{entry.summary}</p>
          <p className="icat-detail-publisher">
            <span>{entry.publisher}</span>
            <span className="icat-dot" aria-hidden="true">·</span>
            <span>{entry.verified ? s.detailVerified : s.detailThirdParty}</span>
            <a className="icat-home" href={entry.homepage} target="_blank" rel="noreferrer noopener">
              {s.detailHomepage}
              <span aria-hidden="true">↗</span>
            </a>
          </p>
        </div>
      </header>

      {/* The one filled box on the page: the facts, the field they may need and
          the action that depends on both. The action keeps one place — the
          card's bottom-inline-end — for every entry. */}
      <section className="icat-card">
        <h3 className="icat-card-title">{s.detailConnection}</h3>
        <div className="icat-card-main">
          <dl className="icat-facts">
            <div className="icat-fact">
              <dt>{s.detailSignIn}</dt>
              <dd>
                <span>
                  {entry.mcp.auth === "oauth"
                    ? s.authOauth
                    : entry.mcp.auth === "token"
                      ? (entry.mcp.remote?.tokenOptional === true ? s.authTokenOptional : s.authToken)
                      : (local ? s.authLocal : s.authNone)}
                </span>
                {entry.mcp.auth === "oauth" ? <span className="icat-fact-note">{s.authOauthNote}</span> : null}
              </dd>
            </div>
            {(installed || action?.kind === "connect") ? (
              <div className="icat-fact">
                <dt>{s.detailScope}</dt>
                <dd>
                  <span>{scopeLabel(installed ? installed.scope : (action as Extract<Action, { kind: "connect" }>).scope, s)}</span>
                  {action?.kind === "connect" && action.scope === "person"
                    ? <span className="icat-fact-note">{s.detailTokenScope}</span>
                    : null}
                </dd>
              </div>
            ) : null}
          </dl>

          {showTokenField ? (
            <TokenField
              entryId={entry.id}
              tokenHelpUrl={entry.mcp.tokenHelpUrl}
              token={token}
              showToken={showToken}
              onTokenChange={onTokenChange}
              onToggleToken={onToggleToken}
              s={s}
            />
          ) : null}

          {action?.kind === "blocked" && action.reason === "local-unpinned" ? (
            <div className="icat-blocked">
              <p className="icat-blocked-text">{s.detailLocalPin}</p>
              <span className="icat-mono">{endpoint(entry)}</span>
            </div>
          ) : null}

          {action?.kind === "blocked" && action.reason === "token-header-missing" ? (
            <p className="icat-blocked-text">{s.detailTokenMissing}</p>
          ) : null}
        </div>

        <div className="icat-card-action" aria-live="polite">
          {action?.kind === "connect" ? (
            <button type="button" className="icat-btn-primary" disabled={connectDisabled} onClick={onInstall}>
              {busy === "install" ? <span className="icat-spinner" aria-hidden="true" /> : null}
              {busy === "install" ? s.installing : s.install}
            </button>
          ) : null}
          {action?.kind === "disconnect" ? (
            action.catalogManaged ? (
              <button
                type="button"
                className="icat-btn-secondary icat-btn-danger"
                disabled={busy !== null}
                onClick={onUninstall}
              >
                {busy === "uninstall" ? <span className="icat-spinner" aria-hidden="true" /> : null}
                {busy === "uninstall" ? s.uninstalling : s.uninstall}
              </button>
            ) : (
              <div className="icat-card-manual">
                <span className="icat-manual">{s.installedManual}</span>
                {onOpenMcpSettings ? (
                  <button type="button" className="icat-btn-secondary" onClick={onOpenMcpSettings}>
                    {s.manageInSettings}
                  </button>
                ) : null}
              </div>
            )
          ) : null}
        </div>

        {actionError ? <p className="icat-action-error" role="alert">{actionError}</p> : null}
        {actionNotes.length > 0 ? (
          <ul className="icat-action-notes">
            {actionNotes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        ) : null}
      </section>

      <section className="icat-sec">
        <h3 className="icat-sec-label">{s.detailAbout}</h3>
        <p className="icat-sec-body">{entry.description}</p>
      </section>

      <section className="icat-sec">
        <h3 className="icat-sec-label">{s.detailComponents}</h3>
        <dl className="icat-facts">
          <div className="icat-fact">
            <dt>{s.detailType}</dt>
            <dd>{local ? s.componentsLocal : s.componentsRemote}</dd>
          </div>
          {target ? (
            <div className="icat-fact">
              <dt>{local ? s.detailCommand : s.detailEndpoint}</dt>
              <dd><span className="icat-mono">{target}</span></dd>
            </div>
          ) : null}
          {requires.length > 0 ? (
            <div className="icat-fact">
              <dt>{s.requiresLabel}</dt>
              <dd>{requires.map(requirementLabel).join(", ")}</dd>
            </div>
          ) : null}
          {skills.length > 0 ? (
            <div className="icat-fact">
              <dt>{s.detailSkills}</dt>
              <dd>{skills.map((skill) => skill.name).join(", ")}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="icat-sec">
        <h3 className="icat-sec-label">{s.detailEvidence}</h3>
        <dl className="icat-facts">
          <div className="icat-fact">
            <dt>{s.detailChecked}</dt>
            <dd>{entry.evidence.checkedAt}</dd>
          </div>
          <div className="icat-fact">
            <dt>{s.detailSource}</dt>
            <dd>
              <a className="icat-link" href={entry.evidence.source} target="_blank" rel="noreferrer noopener">
                {entry.evidence.source}
              </a>
            </dd>
          </div>
          <div className="icat-fact">
            <dt>{s.detailProbe}</dt>
            <dd>
              <details className="icat-evidence">
                <summary>{s.detailProbeMore}</summary>
                <p className="icat-evidence-body">{probeText(entry)}</p>
              </details>
            </dd>
          </div>
        </dl>
      </section>
    </article>
  );
}

/** The API key field: a token entry asks for the key before it can act. */
function TokenField(props: {
  entryId: string;
  tokenHelpUrl: string | undefined;
  token: string;
  showToken: boolean;
  onTokenChange: (value: string) => void;
  onToggleToken: () => void;
  s: CatalogStrings;
}) {
  const { entryId, tokenHelpUrl, token, showToken, onTokenChange, onToggleToken, s } = props;
  return (
    <div className="icat-token">
      <label className="icat-token-label" htmlFor={`icat-token-${entryId}`}>{s.detailTokenLabel}</label>
      <div className="icat-token-row">
        <input
          id={`icat-token-${entryId}`}
          className="icat-token-input"
          type={showToken ? "text" : "password"}
          value={token}
          placeholder={s.detailTokenPlaceholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onTokenChange(event.target.value)}
        />
        <button
          type="button"
          className="icat-token-toggle"
          aria-pressed={showToken}
          aria-label={showToken ? s.detailTokenHide : s.detailTokenShow}
          onClick={onToggleToken}
        >
          {showToken ? s.detailTokenHide : s.detailTokenShow}
        </button>
      </div>
      <p className="icat-token-hint">{s.detailTokenVault}</p>
      {tokenHelpUrl ? (
        <a className="icat-link icat-token-help" href={tokenHelpUrl} target="_blank" rel="noreferrer noopener">
          {s.detailToken}
        </a>
      ) : null}
    </div>
  );
}

function Problems({ problems, s }: { problems: string[]; s: CatalogStrings }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="icat-problems" data-open={open ? "true" : undefined}>
      <button type="button" className="icat-problems-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="icat-problems-dot" aria-hidden="true" />
        <span>{s.problems} ({problems.length})</span>
        <span className="icat-problems-toggle" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <ul className="icat-problems-list">
          {problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

function Skeleton({ s }: { s: CatalogStrings }) {
  return (
    <div className="icat-skeleton">
      <span className="icat-sr" role="status">{s.loading}</span>
      <div className="icat-skeleton-list" aria-hidden="true">
        {Array.from({ length: 7 }, (_, index) => (
          <div className="icat-skeleton-row" key={index}>
            <span className="icat-skeleton-mark" />
            <span className="icat-skeleton-lines">
              <span className="icat-skeleton-line" style={{ inlineSize: `${60 + (index % 3) * 14}%` }} />
              <span className="icat-skeleton-line icat-skeleton-line-dim" style={{ inlineSize: `${80 + (index % 2) * 10}%` }} />
            </span>
          </div>
        ))}
      </div>
      <div className="icat-skeleton-detail">
        <span className="icat-skeleton-line icat-skeleton-title" />
        <span className="icat-skeleton-line" style={{ inlineSize: "72%" }} />
        <span className="icat-skeleton-line icat-skeleton-line-dim" style={{ inlineSize: "90%" }} />
        <span className="icat-skeleton-line icat-skeleton-line-dim" style={{ inlineSize: "84%" }} />
      </div>
    </div>
  );
}

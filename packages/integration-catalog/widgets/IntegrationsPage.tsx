import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  catalogStats,
  directorySections,
  endpoint,
  filterEntries,
  isLocal,
  type CatalogPayload,
  type CatalogSection,
} from "../src/catalog.ts";
import {
  CATEGORY_ORDER,
  inputValueError,
  interpolateInputs,
  type IntegrationCategory,
  type IntegrationInput,
  type IntegrationManifest,
} from "../src/manifest.ts";
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

/** Below this page width one screen replaces the list-and-document pair. The
 *  stylesheet's container query uses the same number. */
const SPLIT_MIN_WIDTH = 900;

type Load =
  | { state: "loading" }
  | { state: "ready"; payload: CatalogPayload }
  | { state: "failed"; offline: boolean };

/** A mutation in flight: which entry, and whether it is an install or remove. */
type Busy = { entryId: string; kind: "install" | "uninstall" } | null;

type Filter = IntegrationCategory | "all" | "connected";

/** The page's own classification of why a connection is (or is not) offered. */
type Action =
  | { kind: "connect"; scope: InstallScope; needsToken: boolean; tokenOptional: boolean }
  | { kind: "disconnect"; catalogManaged: boolean; enabled: boolean; personalKey: boolean }
  | { kind: "blocked"; reason: "token-header-missing" | "local-unpinned" };

/** What the person sees after an action, until they pick another entry. */
type Outcome = { tone: "error" | "done"; text: string; notes: string[] } | null;

function scopeLabel(scope: InstallScope, hasProject: boolean, s: CatalogStrings): string {
  if (scope === "project") return hasProject ? s.detailScopeProject : s.detailScopeSpaceNoProject;
  if (scope === "space") return s.detailScopeSpace;
  return s.detailScopePerson;
}

/** Decide what the action area offers for one entry, from pure rules. */
function actionFor(entry: IntegrationManifest, installed: InstalledIntegration | undefined): Action {
  if (installed) {
    return {
      kind: "disconnect",
      catalogManaged: installed.catalogManaged,
      enabled: installed.enabled,
      personalKey: installed.scope === "person" && entry.mcp.auth === "token",
    };
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
  // Defaults satisfy the inputs here: the question is only whether the
  // command itself is pinned.
  const plan = planInstall(entry, { inputs: defaultInputs(entry) });
  if (!plan.ok && plan.failure === "local-unpinned") return { kind: "blocked", reason: "local-unpinned" };
  return { kind: "connect", scope: plan.ok ? plan.scope : "project", needsToken: false, tokenOptional: false };
}

/** Every input at its default, or a placeholder value that passes, so a
 *  scope can be computed before the person typed anything. */
function defaultInputs(entry: IntegrationManifest): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of entry.mcp.inputs ?? []) {
    values[input.id] = input.default ?? input.choices?.[0]?.value ?? "x";
  }
  return values;
}

function sectionTitle(section: CatalogSection, s: CatalogStrings): string {
  if (section.id === "featured") return s.featured;
  if (section.id === "connected") return s.connected;
  if (section.id in s.category) return s.category[section.id as IntegrationCategory];
  return section.id;
}

function probeText(entry: IntegrationManifest, s: CatalogStrings): string {
  const probe = entry.evidence.probe;
  if (probe.state === "observed") {
    const status = probe.httpStatus !== undefined ? `HTTP ${probe.httpStatus}` : "HTTP ?";
    return `${status}${probe.challenge ? ` · ${probe.challenge}` : ""}${probe.note ? ` — ${probe.note}` : ""}`;
  }
  if (probe.state === "documented") return `${s.detailVerified}${probe.note ? ` — ${probe.note}` : ""}`;
  return probe.note ?? "";
}

function requirementLabel(requirement: string): string {
  if (requirement === "node") return "Node.js";
  if (requirement === "python") return "Python (uv)";
  return "Docker";
}

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return !!element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT");
};

/**
 * The Integrations page: the catalog in place of Chat. On a phone it is one
 * screen at a time — the directory, or one service with a way back; from
 * 900px of page width the directory and the chosen service sit side by side.
 */
export default function IntegrationsPage({ projectId, locale, onOpenMcpSettings, resource }: {
  projectId?: string | null;
  locale?: string;
  /** Opens the host's MCP settings; absent on a host without that route. */
  onOpenMcpSettings?: () => void;
  /** An entry id to open directly, as passed to `openPage`. */
  resource?: string | null;
}) {
  const s = catalogStrings(locale);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(resource ?? null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [inputsTouched, setInputsTouched] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [confirming, setConfirming] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  /** Where the directory was scrolled when an entry opened on a phone. */
  const listScroll = useRef(0);
  const [narrow, setNarrow] = useState(false);
  const [detailOpen, setDetailOpen] = useState(Boolean(resource));

  useLayoutEffect(() => {
    const node = pageRef.current;
    if (!node) return;
    setNarrow(node.clientWidth > 0 && node.clientWidth < SPLIT_MIN_WIDTH);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? node.clientWidth;
      setNarrow(width > 0 && width < SPLIT_MIN_WIDTH);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // A deep link that changes while the page is open selects the new entry.
  useEffect(() => {
    if (!resource) return;
    setSelectedId(resource);
    setDetailOpen(true);
  }, [resource]);

  useEffect(() => {
    const controller = new AbortController();
    // A refresh after an action keeps the list on screen; only the first load
    // shows the skeleton, so an outcome is not wiped by the re-read.
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
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        setLoad((current) => (current.state === "ready" ? current : { state: "failed", offline }));
      }
    })();
    return () => controller.abort();
  }, [attempt, projectId]);

  // A catalog that failed because the network dropped reloads by itself when
  // the network returns; nobody should have to find the retry button.
  useEffect(() => {
    if (load.state !== "failed") return;
    const retry = () => setAttempt((value) => value + 1);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [load.state]);

  const payload = load.state === "ready" ? load.payload : null;
  const entries = payload?.entries ?? [];

  const installedById = useMemo(() => {
    const map = new Map<string, InstalledIntegration>();
    for (const row of payload?.installed ?? []) {
      if (!map.has(row.entryId)) map.set(row.entryId, row);
    }
    return map;
  }, [payload]);
  const connectedIds = useMemo(() => new Set(installedById.keys()), [installedById]);

  const searching = query.trim().length > 0;
  const visible = useMemo(() => {
    if (!payload) return [];
    if (filter === "connected") {
      return filterEntries(payload.entries, { query }).filter((entry) => connectedIds.has(entry.id));
    }
    return filterEntries(payload.entries, { query, category: filter });
  }, [payload, query, filter, connectedIds]);

  const sections = useMemo(
    () => (payload && !searching && filter === "all" ? directorySections(payload.entries, connectedIds) : []),
    [payload, searching, filter, connectedIds],
  );

  const flat = useMemo(
    () => (sections.length > 0 ? sections.flatMap((section) => section.entries) : visible),
    [sections, visible],
  );

  const selected = useMemo(() => {
    const byId = entries.find((entry) => entry.id === selectedId);
    // An entry opened on its own screen stays open even when a filter hides
    // it in the directory behind it.
    if (byId && (flat.some((entry) => entry.id === byId.id) || (narrow && detailOpen))) return byId;
    return narrow ? (byId ?? null) : (flat[0] ?? null);
  }, [entries, selectedId, flat, narrow, detailOpen]);

  const totals = useMemo(() => (payload ? catalogStats(payload.entries) : null), [payload]);

  const installed = selected ? installedById.get(selected.id) : undefined;
  const action = useMemo(() => (selected ? actionFor(selected, installed) : null), [selected, installed]);

  // Per-entry form state belongs to the entry on screen, whichever way the
  // selection changed (a click, an arrow key, a filter that hid the old one).
  const selectedKey = selected?.id ?? null;
  useEffect(() => {
    setToken("");
    setShowToken(false);
    setInputs(selected ? defaultInputsForForm(selected) : {});
    setInputsTouched(false);
    setOutcome(null);
    setConfirming(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id
  }, [selectedKey]);

  const openEntry = useCallback((id: string) => {
    setSelectedId(id);
    if (!narrow) return;
    listScroll.current = shellRef.current?.scrollTop ?? 0;
    setDetailOpen(true);
  }, [narrow]);

  const closeDetail = useCallback(() => {
    setDetailOpen(false);
  }, []);

  // On a phone the entry is its own screen: it starts at the top with focus on
  // the way back, and returning restores the directory where it was.
  const wasOpen = useRef(detailOpen);
  useLayoutEffect(() => {
    if (!narrow) {
      wasOpen.current = detailOpen;
      return;
    }
    const shell = shellRef.current;
    if (detailOpen && !wasOpen.current) {
      if (shell) shell.scrollTop = 0;
      backRef.current?.focus({ preventScroll: true });
    } else if (!detailOpen && wasOpen.current) {
      if (shell) shell.scrollTop = listScroll.current;
      const row = selectedId ? document.getElementById(`icat-opt-${selectedId}`) : null;
      row?.focus({ preventScroll: true });
    }
    wasOpen.current = detailOpen;
  }, [detailOpen, narrow, selectedId]);

  const inputErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    for (const input of selected?.mcp.inputs ?? []) {
      const value = (inputs[input.id] ?? "").trim();
      if (!value) {
        if (input.default === undefined) errors[input.id] = fill(s.inputInvalid, { label: input.label });
        continue;
      }
      const problem = inputValueError(input, value);
      if (problem) errors[input.id] = problem;
    }
    return errors;
  }, [selected, inputs, s]);

  const runInstall = useCallback(async () => {
    if (!selected || busy) return;
    setInputsTouched(true);
    if (Object.keys(inputErrors).length > 0) return;
    const tokenValue = token.trim();
    const plan = planInstall(selected, { token: tokenValue || undefined, inputs });
    if (!plan.ok) {
      setOutcome({ tone: "error", text: plan.message, notes: [] });
      return;
    }
    setBusy({ entryId: selected.id, kind: "install" });
    setOutcome(null);
    try {
      const response = await fetch(INSTALL_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          entryId: selected.id,
          ...(projectId ? { projectId } : {}),
          ...(plan.scope === "person" && tokenValue ? { token: tokenValue } : {}),
          ...((selected.mcp.inputs?.length ?? 0) > 0 ? { inputs } : {}),
          scope: plan.scope,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string; notes?: string[] };
      // Another tab, or a double tap, got there first: the result the person
      // wanted exists, so show it instead of an error.
      if (response.status === 409 && body.error === "already-installed") {
        setAttempt((value) => value + 1);
        return;
      }
      if (!response.ok) {
        setOutcome({ tone: "error", text: body.message || s.errorGeneric, notes: [] });
        return;
      }
      setOutcome({ tone: "done", text: s.connectedNow, notes: body.notes ?? [] });
      setToken("");
      setShowToken(false);
      setAttempt((value) => value + 1);
    } catch {
      setOutcome({ tone: "error", text: s.errorGeneric, notes: [] });
    } finally {
      setBusy(null);
    }
  }, [selected, busy, token, inputs, inputErrors, projectId, s]);

  const runUninstall = useCallback(async () => {
    if (!selected || !installed || busy) return;
    setBusy({ entryId: selected.id, kind: "uninstall" });
    setOutcome(null);
    try {
      const response = await fetch(UNINSTALL_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ entryId: selected.id, ...(projectId ? { projectId } : {}) }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!response.ok) {
        setOutcome({ tone: "error", text: body.message || s.errorGeneric, notes: [] });
        return;
      }
      setConfirming(false);
      setAttempt((value) => value + 1);
    } catch {
      setOutcome({ tone: "error", text: s.errorGeneric, notes: [] });
    } finally {
      setBusy(null);
    }
  }, [selected, installed, busy, projectId, s]);

  // Keyboard: "/" focuses search, Esc steps back, arrows move through the list.
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    const inSearch = event.target === searchRef.current;
    const typing = isTyping(event.target);
    if (event.key === "/" && !typing) {
      event.preventDefault();
      if (narrow && detailOpen) setDetailOpen(false);
      searchRef.current?.focus();
      return;
    }
    if (event.key === "Escape") {
      if (confirming) {
        event.preventDefault();
        setConfirming(false);
        return;
      }
      if (narrow && detailOpen) {
        event.preventDefault();
        setDetailOpen(false);
        return;
      }
      if (inSearch && query) {
        event.preventDefault();
        setQuery("");
      }
      return;
    }
    if (typing || (narrow && detailOpen)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (flat.length === 0) return;
      event.preventDefault();
      const index = selected ? flat.findIndex((entry) => entry.id === selected.id) : -1;
      const next = event.key === "ArrowDown" ? Math.min(index + 1, flat.length - 1) : Math.max(index - 1, 0);
      const id = flat[next]?.id ?? null;
      setSelectedId(id);
      if (id) document.getElementById(`icat-opt-${id}`)?.focus({ preventScroll: false });
    }
  }, [flat, selected, query, narrow, detailOpen, confirming]);

  // Keep the active row in view when the selection moves on a wide page.
  useEffect(() => {
    if (narrow) return;
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, narrow]);

  const emptyVisible = payload !== null && entries.length > 0 && visible.length === 0;
  const view = narrow ? (detailOpen && selected ? "detail" : "list") : "split";
  const connectedCount = connectedIds.size;

  return (
    <div className="icat-page" data-project={projectId ?? undefined} onKeyDown={onKeyDown} ref={pageRef}>
      <div className="icat-shell" ref={shellRef} data-view={view}>
        <header className="icat-head" hidden={view === "detail"}>
          <div className="icat-head-text">
            <h1>{s.title}</h1>
            <p className="icat-subtitle">{s.subtitle}</p>
          </div>
          {totals ? (
            <p className="icat-count">
              {connectedCount > 0
                ? fill(s.countConnected, { total: totals.total, connected: connectedCount })
                : fill(s.countAll, { total: totals.total })}
            </p>
          ) : null}
        </header>

        {load.state === "loading" ? <Skeleton s={s} /> : null}

        {load.state === "failed" ? (
          <div className="icat-state" role="alert">
            <p className="icat-state-text">{load.offline ? s.offline : s.loadFailed}</p>
            <button type="button" className="icat-btn-secondary" onClick={() => setAttempt((value) => value + 1)}>
              {s.retry}
            </button>
          </div>
        ) : null}

        {payload && view !== "detail" && payload.problems.length > 0 ? <Problems problems={payload.problems} s={s} /> : null}
        {payload && view !== "detail" && payload.connections === "unavailable" ? (
          <p className="icat-notice" role="status">{s.connectionsUnavailable}</p>
        ) : null}

        {payload && payload.entries.length === 0 ? (
          <div className="icat-state">
            <p className="icat-state-text">{s.empty}</p>
          </div>
        ) : null}

        {payload && payload.entries.length > 0 ? (
          <div className="icat-body" data-view={view} data-empty={emptyVisible ? "true" : undefined}>
            {/* The search and the categories belong to the directory, so they
                live inside its column and leave with it on a phone (display:
                none, not a hidden-but-tabbable row). */}
            <div className="icat-col-list" hidden={view === "detail"}>
              <div className="icat-list-head">
                <label className="icat-search">
                  <span className="icat-sr">{s.search}</span>
                  <span className="icat-search-glyph" aria-hidden="true" />
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    placeholder={s.search}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="search"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <div className="icat-chips" role="group" aria-label={s.sections}>
                  <Chip pressed={filter === "all"} onClick={() => setFilter("all")} count={totals?.total}>{s.all}</Chip>
                  {connectedCount > 0 ? (
                    <Chip pressed={filter === "connected"} onClick={() => setFilter("connected")} count={connectedCount} tone="on">
                      {s.connected}
                    </Chip>
                  ) : null}
                  {CATEGORY_ORDER.filter((id) => (totals?.byCategory[id] ?? 0) > 0).map((id) => (
                    <Chip key={id} pressed={filter === id} onClick={() => setFilter(id)}>{s.category[id]}</Chip>
                  ))}
                </div>
              </div>
              <div
                className="icat-list"
                ref={listRef}
                role="listbox"
                aria-label={s.title}
                aria-activedescendant={!narrow && selected ? `icat-opt-${selected.id}` : undefined}
              >
                {emptyVisible ? (
                  <div className="icat-empty" role="presentation">
                    <p className="icat-empty-text" role="status">
                      {filter !== "all" && filter !== "connected"
                        ? fill(s.searchEmptyIn, { query, category: s.category[filter] })
                        : fill(s.searchEmpty, { query })}
                    </p>
                    {filter !== "all" ? (
                      <button type="button" className="icat-btn-secondary" onClick={() => setFilter("all")}>
                        {s.searchEverywhere}
                      </button>
                    ) : (
                      <button type="button" className="icat-btn-secondary" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>
                        {s.searchClear}
                      </button>
                    )}
                  </div>
                ) : sections.length > 0 ? (
                  sections.map((section) => (
                    <SectionGroup key={section.id} title={sectionTitle(section, s)} count={section.entries.length}>
                      {section.entries.map((entry) => (
                        <Row
                          key={entry.id}
                          entry={entry}
                          active={!narrow && selected?.id === entry.id}
                          installed={installedById.get(entry.id)}
                          s={s}
                          onSelect={openEntry}
                        />
                      ))}
                    </SectionGroup>
                  ))
                ) : (
                  visible.map((entry) => (
                    <Row
                      key={entry.id}
                      entry={entry}
                      active={!narrow && selected?.id === entry.id}
                      installed={installedById.get(entry.id)}
                      s={s}
                      onSelect={openEntry}
                    />
                  ))
                )}
              </div>
            </div>

            {selected && view !== "list" ? (
              <div className="icat-pane">
                {narrow ? (
                  <div className="icat-pane-top">
                    <button type="button" className="icat-back" onClick={closeDetail} ref={backRef}>
                      <span className="icat-back-glyph" aria-hidden="true" />
                      {s.back}
                    </button>
                  </div>
                ) : null}
                <Detail
                  entry={selected}
                  installed={installed}
                  action={action}
                  hasProject={Boolean(projectId)}
                  busy={busy?.entryId === selected.id ? busy.kind : null}
                  token={token}
                  showToken={showToken}
                  inputs={inputs}
                  inputErrors={inputsTouched ? inputErrors : {}}
                  canConnect={Object.keys(inputErrors).length === 0}
                  confirming={confirming}
                  onTokenChange={setToken}
                  onToggleToken={() => setShowToken((value) => !value)}
                  onInputChange={(id, value) => setInputs((current) => ({ ...current, [id]: value }))}
                  onInputBlur={() => setInputsTouched(true)}
                  onInstall={runInstall}
                  onUninstall={() => (action?.kind === "disconnect" && action.personalKey && !confirming ? setConfirming(true) : void runUninstall())}
                  onCancelConfirm={() => setConfirming(false)}
                  outcome={outcome}
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

/** The form starts from the manifest defaults; free-text inputs start empty. */
function defaultInputsForForm(entry: IntegrationManifest): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of entry.mcp.inputs ?? []) values[input.id] = input.default ?? "";
  return values;
}

function Chip(props: {
  pressed: boolean;
  onClick: () => void;
  count?: number | undefined;
  tone?: "on";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="icat-chip"
      aria-pressed={props.pressed}
      data-tone={props.tone}
      onClick={props.onClick}
    >
      {props.tone === "on" ? <span className="icat-chip-dot" aria-hidden="true" /> : null}
      {props.children}
      {props.count !== undefined ? <span className="icat-chip-count">{props.count}</span> : null}
    </button>
  );
}

/** A labelled group of options: a heading may not sit directly in a listbox. */
function SectionGroup({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const id = useId();
  return (
    <div className="icat-section" role="group" aria-labelledby={id}>
      <div className="icat-section-title" id={id} role="presentation">
        <span>{title}</span>
        <span className="icat-section-count" aria-hidden="true">{count}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * The service's own tile: a finished square image (a simple-icons glyph on its
 * brand colour, or the vendor's app icon), rounded and outlined here. Row
 * marks load lazily, so a 200-entry directory asks only for what is on screen.
 * A mark that fails to load leaves the entry's initial, never a broken image.
 */
function Mark({ entry, size }: { entry: IntegrationManifest; size: "row" | "detail" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [entry.id]);
  return (
    <span className={`icat-mark icat-mark-${size}`} data-fallback={failed ? "true" : undefined} aria-hidden="true">
      {failed
        ? <span className="icat-mark-letter">{entry.name.slice(0, 1)}</span>
        : (
          <img
            src={`${LOGO_PATH}/${encodeURIComponent(entry.id)}`}
            alt=""
            width={size === "row" ? 40 : 64}
            height={size === "row" ? 40 : 64}
            loading={size === "row" ? "lazy" : "eager"}
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
          />
        )}
    </span>
  );
}

/** A directory row: the mark, the name, one line of what it gives the agent,
 *  and whether it is connected. */
function Row(props: {
  entry: IntegrationManifest;
  active: boolean;
  installed: InstalledIntegration | undefined;
  s: CatalogStrings;
  onSelect: (id: string) => void;
}) {
  const { entry, active, installed, s, onSelect } = props;
  const status = installed ? (installed.enabled ? s.installed : s.installedOff) : undefined;
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
        {status ? <span className="icat-sr">, {status}</span> : null}
      </span>
      <span className="icat-row-end">
        {installed ? (
          <span
            className="icat-row-status"
            data-on={installed.enabled ? "true" : undefined}
            title={status}
            aria-hidden="true"
          />
        ) : null}
        <span className="icat-row-chevron" aria-hidden="true" />
      </span>
    </button>
  );
}

/** The chosen service as a short document with the connection card on top. */
function Detail(props: {
  entry: IntegrationManifest;
  installed: InstalledIntegration | undefined;
  action: Action | null;
  hasProject: boolean;
  busy: "install" | "uninstall" | null;
  token: string;
  showToken: boolean;
  inputs: Record<string, string>;
  inputErrors: Record<string, string>;
  canConnect: boolean;
  confirming: boolean;
  onTokenChange: (value: string) => void;
  onToggleToken: () => void;
  onInputChange: (id: string, value: string) => void;
  onInputBlur: () => void;
  onInstall: () => void;
  onUninstall: () => void;
  onCancelConfirm: () => void;
  outcome: Outcome;
  onOpenMcpSettings?: (() => void) | undefined;
  s: CatalogStrings;
}) {
  const {
    entry, installed, action, hasProject, busy, token, showToken, inputs, inputErrors, canConnect, confirming,
    onTokenChange, onToggleToken, onInputChange, onInputBlur, onInstall, onUninstall, onCancelConfirm,
    outcome, onOpenMcpSettings, s,
  } = props;
  const local = isLocal(entry);
  // The endpoint as it will be installed: with the chosen site or
  // organization filled in, not the manifest's template.
  const template = endpoint(entry);
  const target = template && entry.mcp.inputs?.length
    ? interpolateInputs(template, Object.fromEntries((entry.mcp.inputs ?? []).map((input) => [
      input.id,
      inputs[input.id]?.trim() || input.default || `{${input.id}}`,
    ])))
    : template;
  const skills = entry.skills ?? [];
  const requires = entry.mcp.local?.requires ?? [];
  const registration = entry.evidence.probe.registration;
  const connect = action?.kind === "connect" ? action : null;
  const disconnect = action?.kind === "disconnect" ? action : null;
  const tokenMissing = Boolean(connect?.needsToken && token.trim().length === 0);
  const connectDisabled = busy !== null || !connect || tokenMissing;
  const showTokenField = connect?.scope === "person" && entry.mcp.auth === "token";
  const showInputs = !installed && (entry.mcp.inputs?.length ?? 0) > 0;
  const titleId = useId();

  return (
    <article className="icat-detail" aria-labelledby={titleId}>
      <header className="icat-detail-head">
        <Mark entry={entry} size="detail" />
        <div className="icat-detail-head-text">
          <div className="icat-detail-title-row">
            <h2 id={titleId}>{entry.name}</h2>
            {entry.status === "beta" ? <span className="icat-pill">{s.beta}</span> : null}
            {local ? <span className="icat-pill">{s.local}</span> : null}
            {installed ? (
              <span className="icat-pill icat-pill-on" data-off={installed.enabled ? undefined : "true"}>
                {installed.enabled ? s.installed : s.installedOff}
              </span>
            ) : null}
          </div>
          <p className="icat-detail-summary">{entry.summary}</p>
          <p className="icat-detail-publisher">
            <span>{fill(s.publishedBy, { publisher: entry.publisher })}</span>
            <span className="icat-dot" aria-hidden="true">·</span>
            <span>{entry.verified ? s.detailVerified : s.detailThirdParty}</span>
          </p>
        </div>
      </header>

      {/* The one filled box on the page: the facts, the fields they may need
          and the action that depends on both. */}
      <section className="icat-card" aria-label={s.detailConnection}>
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
              {entry.mcp.auth === "oauth" && !installed ? <span className="icat-fact-note">{s.authOauthNote}</span> : null}
            </dd>
          </div>
          {installed || connect ? (
            <div className="icat-fact">
              <dt>{s.detailScope}</dt>
              <dd>
                <span>{scopeLabel(installed ? installed.scope : connect!.scope, hasProject || installed?.scope === "project", s)}</span>
                {connect?.scope === "person" ? <span className="icat-fact-note">{s.detailTokenScope}</span> : null}
              </dd>
            </div>
          ) : null}
          {requires.length > 0 ? (
            <div className="icat-fact">
              <dt>{s.requiresLabel}</dt>
              <dd>{requires.map(requirementLabel).join(", ")}</dd>
            </div>
          ) : null}
        </dl>

        {showInputs ? (
          <fieldset className="icat-inputs">
            <legend className="icat-sr">{s.inputsTitle}</legend>
            {(entry.mcp.inputs ?? []).map((input) => (
              <InputField
                key={input.id}
                entryId={entry.id}
                input={input}
                value={inputs[input.id] ?? ""}
                error={inputErrors[input.id]}
                onChange={(value) => onInputChange(input.id, value)}
                onBlur={onInputBlur}
              />
            ))}
          </fieldset>
        ) : null}

        {showTokenField ? (
          <TokenField
            entryId={entry.id}
            tokenHelpUrl={entry.mcp.tokenHelpUrl}
            token={token}
            showToken={showToken}
            optional={connect?.tokenOptional === true}
            onTokenChange={onTokenChange}
            onToggleToken={onToggleToken}
            onSubmit={() => { if (!connectDisabled && canConnect) onInstall(); }}
            s={s}
          />
        ) : null}

        {action?.kind === "blocked" && action.reason === "local-unpinned" ? (
          <div className="icat-blocked">
            <p className="icat-blocked-text">{s.detailLocalPin}</p>
            <span className="icat-mono">{target}</span>
          </div>
        ) : null}
        {action?.kind === "blocked" && action.reason === "token-header-missing" ? (
          <p className="icat-blocked-text">{s.detailTokenMissing}</p>
        ) : null}

        {disconnect && !disconnect.enabled ? <p className="icat-fact-note">{s.installedOffNote}</p> : null}

        <div className="icat-card-action" aria-live="polite">
          {connect ? (
            <>
              <button type="button" className="icat-btn-primary" disabled={connectDisabled} aria-disabled={connectDisabled || !canConnect} onClick={onInstall}>
                {busy === "install" ? <span className="icat-spinner" aria-hidden="true" /> : null}
                {busy === "install" ? s.installing : s.install}
              </button>
              {tokenMissing ? <span className="icat-action-hint">{s.tokenNeeded}</span> : null}
            </>
          ) : null}
          {disconnect && disconnect.catalogManaged && confirming ? (
            <div className="icat-confirm" role="group" aria-label={s.uninstall}>
              <p className="icat-confirm-text">{fill(s.disconnectKeyWarning, { name: entry.name })}</p>
              <div className="icat-confirm-actions">
                <button type="button" className="icat-btn-secondary" onClick={onCancelConfirm} disabled={busy !== null}>{s.cancel}</button>
                <button type="button" className="icat-btn-secondary icat-btn-danger" onClick={onUninstall} disabled={busy !== null}>
                  {busy === "uninstall" ? <span className="icat-spinner" aria-hidden="true" /> : null}
                  {busy === "uninstall" ? s.uninstalling : s.disconnectConfirm}
                </button>
              </div>
            </div>
          ) : null}
          {disconnect && disconnect.catalogManaged && !confirming ? (
            <div className="icat-card-buttons">
              {!disconnect.enabled && onOpenMcpSettings ? (
                <button type="button" className="icat-btn-secondary" onClick={onOpenMcpSettings}>{s.manageInSettings}</button>
              ) : null}
              <button type="button" className="icat-btn-secondary icat-btn-danger" disabled={busy !== null} onClick={onUninstall}>
                {busy === "uninstall" ? <span className="icat-spinner" aria-hidden="true" /> : null}
                {busy === "uninstall" ? s.uninstalling : s.uninstall}
              </button>
            </div>
          ) : null}
          {disconnect && !disconnect.catalogManaged ? (
            <div className="icat-card-manual">
              <span className="icat-manual">{s.installedManual}</span>
              {onOpenMcpSettings ? (
                <button type="button" className="icat-btn-secondary" onClick={onOpenMcpSettings}>{s.manageInSettings}</button>
              ) : null}
            </div>
          ) : null}
        </div>

        {outcome ? (
          <div className="icat-outcome" data-tone={outcome.tone} role={outcome.tone === "error" ? "alert" : "status"}>
            <p className="icat-outcome-text">{outcome.text}</p>
            {outcome.notes.length > 0 ? (
              <ul className="icat-outcome-notes">
                {outcome.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="icat-sec">
        <h3 className="icat-sec-label">{s.detailAbout}</h3>
        <p className="icat-sec-body">{entry.description}</p>
        <a className="icat-link icat-home" href={entry.homepage} target="_blank" rel="noreferrer noopener">
          {fill(s.openService, { name: entry.name })}
          <span aria-hidden="true"> ↗</span>
        </a>
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
          {entry.mcp.auth === "oauth" || registration === "none" ? (
            <div className="icat-fact">
              <dt>{s.detailSignInMethod}</dt>
              <dd>{registration === "none" ? s.registrationNone : s.registrationDynamic}</dd>
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
                {entry.evidence.source.replace(/^https:\/\//, "")}
              </a>
            </dd>
          </div>
        </dl>
        <details className="icat-evidence">
          <summary>{s.detailProbeMore}</summary>
          <p className="icat-evidence-body">{probeText(entry, s)}</p>
        </details>
      </section>
    </article>
  );
}

/** A region, site or organization the endpoint needs. A choice is a native
 *  select (the phone's own picker); free text is checked as it is typed. */
function InputField(props: {
  entryId: string;
  input: IntegrationInput;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const { entryId, input, value, error, onChange, onBlur } = props;
  const id = `icat-input-${entryId}-${input.id}`;
  const hintId = `${id}-hint`;
  return (
    <div className="icat-field" data-invalid={error ? "true" : undefined}>
      <label className="icat-field-label" htmlFor={id}>{input.label}</label>
      {input.choices ? (
        <select
          id={id}
          className="icat-select"
          value={value}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        >
          {input.default === undefined ? <option value="" disabled>{input.placeholder ?? "—"}</option> : null}
          {input.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
      ) : (
        <input
          id={id}
          className="icat-text-input"
          type="text"
          value={value}
          placeholder={input.placeholder}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
      )}
      <p className="icat-field-hint" id={hintId} role={error ? "alert" : undefined}>{error ?? input.hint ?? ""}</p>
    </div>
  );
}

/** The API key field. A required key gates the action; an optional one says so. */
function TokenField(props: {
  entryId: string;
  tokenHelpUrl: string | undefined;
  token: string;
  showToken: boolean;
  optional: boolean;
  onTokenChange: (value: string) => void;
  onToggleToken: () => void;
  onSubmit: () => void;
  s: CatalogStrings;
}) {
  const { entryId, tokenHelpUrl, token, showToken, optional, onTokenChange, onToggleToken, onSubmit, s } = props;
  const id = `icat-token-${entryId}`;
  return (
    <div className="icat-field icat-token">
      <div className="icat-token-label-row">
        <label className="icat-field-label" htmlFor={id}>{s.detailTokenLabel}</label>
        {tokenHelpUrl ? (
          <a className="icat-link icat-token-help" href={tokenHelpUrl} target="_blank" rel="noreferrer noopener">
            {s.detailToken}
            <span aria-hidden="true"> ↗</span>
          </a>
        ) : null}
      </div>
      <div className="icat-token-row">
        <input
          id={id}
          className="icat-text-input icat-token-input"
          type={showToken ? "text" : "password"}
          value={token}
          placeholder={optional ? s.detailTokenOptional : s.detailTokenPlaceholder}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="go"
          onChange={(event) => onTokenChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onSubmit(); } }}
        />
        <button
          type="button"
          className="icat-token-toggle"
          aria-pressed={showToken}
          aria-controls={id}
          onClick={onToggleToken}
        >
          {showToken ? s.detailTokenHide : s.detailTokenShow}
        </button>
      </div>
      <p className="icat-field-hint">{s.detailTokenVault}</p>
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
        <span className="icat-skeleton-search" />
        <span className="icat-skeleton-chips">
          {Array.from({ length: 5 }, (_, index) => <span key={index} className="icat-skeleton-chip" />)}
        </span>
        {Array.from({ length: 8 }, (_, index) => (
          <div className="icat-skeleton-row" key={index}>
            <span className="icat-skeleton-mark" />
            <span className="icat-skeleton-lines">
              <span className="icat-skeleton-line" style={{ inlineSize: `${42 + (index % 3) * 12}%` }} />
              <span className="icat-skeleton-line icat-skeleton-line-dim" style={{ inlineSize: `${64 + (index % 2) * 14}%` }} />
            </span>
          </div>
        ))}
      </div>
      <div className="icat-skeleton-detail" aria-hidden="true">
        <span className="icat-skeleton-hero">
          <span className="icat-skeleton-mark icat-skeleton-mark-lg" />
          <span className="icat-skeleton-lines">
            <span className="icat-skeleton-line icat-skeleton-title" />
            <span className="icat-skeleton-line" style={{ inlineSize: "56%" }} />
          </span>
        </span>
        <span className="icat-skeleton-card" />
        <span className="icat-skeleton-line icat-skeleton-line-dim" style={{ inlineSize: "90%" }} />
        <span className="icat-skeleton-line icat-skeleton-line-dim" style={{ inlineSize: "84%" }} />
      </div>
    </div>
  );
}

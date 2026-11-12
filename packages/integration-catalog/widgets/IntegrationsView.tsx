import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
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
import { planInstall, type InstallScope, type InstalledIntegration } from "../src/install.ts";
import { catalogStrings, fill, type CatalogStrings } from "../src/strings.ts";

const ENTRIES_PATH = "/api/integration-catalog/entries";
const LOGO_PATH = "/api/integration-catalog/logo";
const INSTALL_PATH = "/api/integration-catalog/install";
const UNINSTALL_PATH = "/api/integration-catalog/uninstall";

/** From this pane width the directory and the chosen service sit side by
 *  side. The stylesheet's `@container icat` query uses the same number. */
export const SPLIT_MIN_WIDTH = 720;

type Ui = WebPackageHost["ui"];
type Load = { state: "loading" } | { state: "ready"; payload: CatalogPayload } | { state: "failed"; offline: boolean };
type Busy = { entryId: string; kind: "install" | "uninstall" } | null;
type Filter = IntegrationCategory | "all" | "connected";
type Action =
  | { kind: "connect"; scope: InstallScope; needsToken: boolean; tokenOptional: boolean }
  | { kind: "disconnect"; catalogManaged: boolean; enabled: boolean; personalKey: boolean }
  | { kind: "blocked"; reason: "token-header-missing" | "local-unpinned" };
type Outcome = { tone: "error" | "done"; text: string; notes: string[] } | null;

function scopeLabel(scope: InstallScope, hasProject: boolean, s: CatalogStrings): string {
  if (scope === "project") return hasProject ? s.detailScopeProject : s.detailScopeSpaceNoProject;
  return scope === "space" ? s.detailScopeSpace : s.detailScopePerson;
}

/** Every input at its default, or a placeholder value that passes, so a
 *  scope can be computed before the person typed anything. */
function defaultInputs(entry: IntegrationManifest): Record<string, string> {
  return Object.fromEntries((entry.mcp.inputs ?? []).map((input) => [input.id, input.default ?? input.choices?.[0]?.value ?? "x"]));
}

/** The form starts from the manifest defaults; free-text inputs start empty. */
function formInputs(entry: IntegrationManifest): Record<string, string> {
  return Object.fromEntries((entry.mcp.inputs ?? []).map((input) => [input.id, input.default ?? ""]));
}

/** What the action area offers for one entry, from pure rules. */
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
  // A token entry that never says how the key travels cannot connect: a gap in
  // the manifest, not something the person can fill in.
  if (auth === "token" && entry.mcp.remote && !entry.mcp.remote.tokenHeader) return { kind: "blocked", reason: "token-header-missing" };
  if (auth === "token") {
    const tokenOptional = entry.mcp.remote?.tokenOptional === true;
    return { kind: "connect", scope: "person", needsToken: !tokenOptional, tokenOptional };
  }
  const plan = planInstall(entry, { inputs: defaultInputs(entry) });
  if (!plan.ok && plan.failure === "local-unpinned") return { kind: "blocked", reason: "local-unpinned" };
  return { kind: "connect", scope: plan.ok ? plan.scope : "project", needsToken: false, tokenOptional: false };
}

function sectionTitle(section: CatalogSection, s: CatalogStrings): string {
  if (section.id === "featured") return s.featured;
  if (section.id === "connected") return s.connected;
  return section.id in s.category ? s.category[section.id as IntegrationCategory] : section.id;
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

const REQUIREMENT_LABEL: Record<string, string> = { node: "Node.js", python: "Python (uv)", docker: "Docker" };

function signInText(entry: IntegrationManifest, s: CatalogStrings): string {
  if (entry.mcp.auth === "oauth") return s.authOauth;
  if (entry.mcp.auth === "token") return entry.mcp.remote?.tokenOptional === true ? s.authTokenOptional : s.authToken;
  return isLocal(entry) ? s.authLocal : s.authNone;
}

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

async function postJson(path: string, body: unknown): Promise<{ response: Response; body: { error?: string; message?: string; notes?: string[] } }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => ({})) };
}

/**
 * The Integrations window's content. The host `ModuleView` owns the title,
 * Back/Close, safe areas and the phone layer; this is the directory and one
 * service. A narrow pane shows one at a time; from `SPLIT_MIN_WIDTH` of pane
 * width both sit side by side.
 */
export default function IntegrationsView({ ui, projectId, locale, resource, resourceSeq, onOpenMcpSettings }: {
  ui: Ui;
  projectId?: string | null;
  locale?: string;
  /** An entry id to open directly (`openWorkspacePane(id, entryId)`). */
  resource?: string | null;
  /** Grows per request, so asking for the same entry again reopens it. */
  resourceSeq?: number;
  /** Opens the host's MCP settings, where a manually added server lives. */
  onOpenMcpSettings?: () => void;
}) {
  const s = catalogStrings(locale);
  const { Button, Tabs, EmptyState, TextInput } = ui.components;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(resource ?? null);
  const [detailOpen, setDetailOpen] = useState(Boolean(resource));
  const [narrow, setNarrow] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [inputsTouched, setInputsTouched] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [confirming, setConfirming] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const detailScrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listScroll = useRef(0);

  // The pane, not the viewport, decides the layout: a docked window on a wide
  // screen is as narrow as a phone.
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const measure = (width: number) => setNarrow(width < SPLIT_MIN_WIDTH);
    measure(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => measure(entry?.contentRect.width ?? node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!resource) return;
    setSelectedId(resource);
    setDetailOpen(true);
  }, [resource, resourceSeq]);

  useEffect(() => {
    const controller = new AbortController();
    // A refresh after an action keeps the list; only the first load is empty.
    setLoad((current) => (current.state === "ready" ? current : { state: "loading" }));
    const queryString = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    void (async () => {
      try {
        const response = await fetch(`${ENTRIES_PATH}${queryString}`, { headers: { accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as CatalogPayload;
        if (!controller.signal.aborted) setLoad({ state: "ready", payload });
      } catch {
        if (controller.signal.aborted) return;
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        setLoad((current) => (current.state === "ready" ? current : { state: "failed", offline }));
      }
    })();
    return () => controller.abort();
  }, [attempt, projectId]);

  // Back online after a failed load: reload by itself.
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
    for (const row of payload?.installed ?? []) if (!map.has(row.entryId)) map.set(row.entryId, row);
    return map;
  }, [payload]);
  const connectedIds = useMemo(() => new Set(installedById.keys()), [installedById]);
  const totals = useMemo(() => (payload ? catalogStats(payload.entries) : null), [payload]);

  const searching = query.trim().length > 0;
  const visible = useMemo(() => {
    if (!payload) return [];
    if (filter === "connected") return filterEntries(payload.entries, { query }).filter((entry) => connectedIds.has(entry.id));
    return filterEntries(payload.entries, { query, category: filter });
  }, [payload, query, filter, connectedIds]);
  const sections = useMemo(
    () => (payload && !searching && filter === "all" ? directorySections(payload.entries, connectedIds) : []),
    [payload, searching, filter, connectedIds],
  );
  const flat = useMemo(() => (sections.length > 0 ? sections.flatMap((section) => section.entries) : visible), [sections, visible]);

  const selected = useMemo(() => {
    const byId = entries.find((entry) => entry.id === selectedId);
    // An entry opened on its own screen stays open even when a filter hides it.
    if (byId && (flat.some((entry) => entry.id === byId.id) || (narrow && detailOpen))) return byId;
    return narrow ? (byId ?? null) : (flat[0] ?? null);
  }, [entries, selectedId, flat, narrow, detailOpen]);
  const installed = selected ? installedById.get(selected.id) : undefined;
  const action = useMemo(() => (selected ? actionFor(selected, installed) : null), [selected, installed]);
  const view = narrow ? (detailOpen && selected ? "detail" : "list") : "split";
  // On a phone the window's own Back returns to the directory, so the
  // content draws no second arrow under it.
  const closeDetail = useCallback(() => setDetailOpen(false), []);
  const windowBack = ui.useWindowBack?.(view === "detail" ? closeDetail : null) ?? false;

  // Per-entry form state belongs to the entry on screen.
  const selectedKey = selected?.id ?? null;
  useEffect(() => {
    setToken("");
    setShowToken(false);
    setInputs(selected ? formInputs(selected) : {});
    setInputsTouched(false);
    setOutcome(null);
    setConfirming(false);
    detailScrollRef.current?.scrollTo?.({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id
  }, [selectedKey]);

  const openEntry = useCallback((id: string) => {
    setSelectedId(id);
    if (!narrow) return;
    listScroll.current = listScrollRef.current?.scrollTop ?? 0;
    setDetailOpen(true);
  }, [narrow]);

  // Returning from a service restores the directory where it was and puts
  // focus back on the row that opened it.
  const wasDetail = useRef(view === "detail");
  useLayoutEffect(() => {
    if (wasDetail.current && view === "list") {
      if (listScrollRef.current) listScrollRef.current.scrollTop = listScroll.current;
      if (selectedId) document.getElementById(`icat-opt-${selectedId}`)?.focus({ preventScroll: true });
    }
    wasDetail.current = view === "detail";
  }, [view, selectedId]);

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
      const { response, body } = await postJson(INSTALL_PATH, {
        entryId: selected.id,
        ...(projectId ? { projectId } : {}),
        ...(plan.scope === "person" && tokenValue ? { token: tokenValue } : {}),
        ...((selected.mcp.inputs?.length ?? 0) > 0 ? { inputs } : {}),
        scope: plan.scope,
      });
      // Another tab, or a double tap, got there first: show the result.
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
      const { response, body } = await postJson(UNINSTALL_PATH, { entryId: selected.id, ...(projectId ? { projectId } : {}) });
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

  // "/" focuses search, Esc steps back one level, arrows walk the directory.
  // A key the content handles stops here, so the window does not also close.
  const onKeyDown = useCallback((event: KeyboardEvent) => {
    const typing = isTyping(event.target);
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.key === "/" && !typing) {
      handled();
      if (view === "detail") setDetailOpen(false);
      searchRef.current?.focus();
      return;
    }
    if (event.key === "Escape") {
      if (confirming) { handled(); setConfirming(false); return; }
      if (view === "detail") { handled(); setDetailOpen(false); return; }
      if (event.target === searchRef.current && query) { handled(); setQuery(""); }
      return;
    }
    if (typing || view === "detail" || (event.key !== "ArrowDown" && event.key !== "ArrowUp") || flat.length === 0) return;
    handled();
    const index = selected ? flat.findIndex((entry) => entry.id === selected.id) : -1;
    const next = event.key === "ArrowDown" ? Math.min(index + 1, flat.length - 1) : Math.max(index - 1, 0);
    const id = flat[next]?.id ?? null;
    setSelectedId(id);
    if (id) document.getElementById(`icat-opt-${id}`)?.focus();
  }, [flat, selected, query, view, confirming]);

  const row = (entry: IntegrationManifest) => (
    <Row key={entry.id} entry={entry} active={!narrow && selected?.id === entry.id} installed={installedById.get(entry.id)} s={s} onSelect={openEntry} />
  );
  const emptyVisible = payload !== null && entries.length > 0 && visible.length === 0;
  const tabs = [
    { id: "all", label: <>{s.all}<span className="icat-tab-count">{totals?.total ?? ""}</span></> },
    ...(connectedIds.size > 0 ? [{ id: "connected", label: <>{s.connected}<span className="icat-tab-count">{connectedIds.size}</span></> }] : []),
    ...CATEGORY_ORDER.filter((id) => (totals?.byCategory[id] ?? 0) > 0).map((id) => ({ id, label: s.category[id] })),
  ];

  let body: ReactNode;
  if (load.state === "loading") {
    body = (
      <div className="icat-loading" role="status">
        <span className="icat-sr">{s.loading}</span>
        {Array.from({ length: 6 }, (_, index) => <span key={index} className="icat-placeholder" aria-hidden="true" />)}
      </div>
    );
  } else if (load.state === "failed") {
    body = <EmptyState title={load.offline ? s.offline : s.loadFailed} actionLabel={s.retry} onAction={() => setAttempt((value) => value + 1)} />;
  } else if (entries.length === 0) {
    body = <EmptyState title={s.empty} />;
  } else {
    body = (
      <div className="icat-body" data-view={view}>
        <div className="icat-list-col" hidden={view === "detail"}>
          <div className="icat-toolbar">
            <TextInput
              ref={searchRef}
              type="search"
              className="icat-search"
              value={query}
              placeholder={s.search}
              aria-label={s.search}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
            <Tabs size="sm" className="icat-filter" label={s.sections} value={filter} onChange={(id: string) => setFilter(id as Filter)} tabs={tabs} />
          </div>
          <div className="icat-list-scroll" ref={listScrollRef}>
          {payload!.problems.length > 0 ? (
            <details className="icat-notice">
              <summary>{s.problems} ({payload!.problems.length})</summary>
              <ul>{payload!.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
            </details>
          ) : null}
          {payload!.connections === "unavailable" ? <p className="icat-notice" role="status">{s.connectionsUnavailable}</p> : null}
          {emptyVisible ? (
            <EmptyState
              title={filter !== "all" && filter !== "connected" ? fill(s.searchEmptyIn, { query, category: s.category[filter] }) : fill(s.searchEmpty, { query })}
              actionLabel={filter !== "all" ? s.searchEverywhere : s.searchClear}
              onAction={() => (filter !== "all" ? setFilter("all") : (setQuery(""), searchRef.current?.focus()))}
            />
          ) : (
            <div className="icat-list" role="listbox" aria-label={s.title} aria-activedescendant={!narrow && selected ? `icat-opt-${selected.id}` : undefined}>
              {sections.length > 0
                ? sections.map((section) => (
                  <SectionGroup key={section.id} title={sectionTitle(section, s)} count={section.entries.length}>
                    {section.entries.map(row)}
                  </SectionGroup>
                ))
                : visible.map(row)}
            </div>
          )}
          </div>
        </div>
        {selected && view !== "list" ? (
          <div className="icat-detail-col" ref={detailScrollRef}>
            {narrow && !windowBack ? (
              <div className="icat-back">
                <Button variant="ghost" size="sm" iconStart={ui.icons.back} onClick={closeDetail}>{s.back}</Button>
              </div>
            ) : null}
            <Detail
              ui={ui}
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
    );
  }

  return (
    <div className="icat" ref={rootRef} onKeyDown={onKeyDown} data-project={projectId ?? undefined}>
      {body}
    </div>
  );
}

/** A labelled group of options: a heading may not sit directly in a listbox. */
function SectionGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const id = useId();
  return (
    <div className="icat-section" role="group" aria-labelledby={id}>
      <div className="icat-section-title" id={id} role="presentation">
        {title}<span className="icat-section-count" aria-hidden="true">{count}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * The service's own tile: a finished square image (a simple-icons glyph on its
 * brand colour, or the vendor's app icon). Row marks load lazily. A mark that
 * fails leaves a quiet monogram, never a broken image.
 */
function Mark({ entry, size }: { entry: IntegrationManifest; size: "row" | "detail" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [entry.id]);
  return (
    <span className="icat-mark" data-size={size} data-fallback={failed ? "true" : undefined} aria-hidden="true">
      {failed ? entry.name.slice(0, 1) : (
        <img
          src={`${LOGO_PATH}/${encodeURIComponent(entry.id)}`}
          alt=""
          loading={size === "row" ? "lazy" : "eager"}
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

function Tags({ entry, s }: { entry: IntegrationManifest; s: CatalogStrings }) {
  return (
    <>
      {entry.status === "beta" ? <span className="icat-tag">{s.beta}</span> : null}
      {isLocal(entry) ? <span className="icat-tag">{s.local}</span> : null}
    </>
  );
}

/** A directory row: mark, name, one line of what it gives the agent, and
 *  whether it is connected. */
function Row({ entry, active, installed, s, onSelect }: {
  entry: IntegrationManifest;
  active: boolean;
  installed: InstalledIntegration | undefined;
  s: CatalogStrings;
  onSelect: (id: string) => void;
}) {
  return (
    <button type="button" id={`icat-opt-${entry.id}`} className="icat-row" role="option" aria-selected={active} onClick={() => onSelect(entry.id)}>
      <Mark entry={entry} size="row" />
      <span className="icat-row-text">
        <span className="icat-row-name">{entry.name}<Tags entry={entry} s={s} /></span>
        <span className="icat-row-summary">{entry.summary}</span>
      </span>
      {installed ? (
        <span className="icat-row-state" data-on={installed.enabled ? "true" : undefined}>
          {installed.enabled ? s.installed : s.installedOff}
        </span>
      ) : null}
    </button>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="icat-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="icat-link" href={href} target="_blank" rel="noreferrer noopener">{children}<span aria-hidden="true"> ↗</span></a>;
}

/** The chosen service as a short document: heading, the connection, then facts. */
function Detail(props: {
  ui: Ui;
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
  const { ui, entry, installed, action, hasProject, busy, token, inputs, confirming, outcome, onOpenMcpSettings, s } = props;
  const { Button } = ui.components;
  const local = isLocal(entry);
  // The endpoint as it will be installed, with the chosen site filled in.
  const template = endpoint(entry);
  const target = template && entry.mcp.inputs?.length
    ? interpolateInputs(template, Object.fromEntries((entry.mcp.inputs ?? []).map((input) => [input.id, inputs[input.id]?.trim() || input.default || `{${input.id}}`])))
    : template;
  const registration = entry.evidence.probe.registration;
  const connect = action?.kind === "connect" ? action : null;
  const disconnect = action?.kind === "disconnect" ? action : null;
  const tokenMissing = Boolean(connect?.needsToken && token.trim().length === 0);
  const connectDisabled = busy !== null || !connect || tokenMissing;
  const titleId = useId();

  return (
    <article className="icat-detail" aria-labelledby={titleId}>
      <header className="icat-detail-head">
        <Mark entry={entry} size="detail" />
        <div className="icat-detail-title">
          <h2 id={titleId}>{entry.name}<Tags entry={entry} s={s} />
            {installed ? <span className="icat-tag" data-on={installed.enabled ? "true" : undefined}>{installed.enabled ? s.installed : s.installedOff}</span> : null}
          </h2>
          <p className="icat-detail-summary">{entry.summary}</p>
          <p className="icat-meta">{fill(s.publishedBy, { publisher: entry.publisher })} · {entry.verified ? s.detailVerified : s.detailThirdParty}</p>
        </div>
      </header>

      <section className="icat-connection" aria-label={s.detailConnection}>
        <dl className="icat-facts">
          <Fact label={s.detailSignIn}>
            {signInText(entry, s)}
            {entry.mcp.auth === "oauth" && !installed ? <span className="icat-note">{s.authOauthNote}</span> : null}
          </Fact>
          {installed || connect ? (
            <Fact label={s.detailScope}>
              {scopeLabel(installed ? installed.scope : connect!.scope, hasProject || installed?.scope === "project", s)}
              {connect?.scope === "person" ? <span className="icat-note">{s.detailTokenScope}</span> : null}
            </Fact>
          ) : null}
          {(entry.mcp.local?.requires?.length ?? 0) > 0 ? (
            <Fact label={s.requiresLabel}>{entry.mcp.local!.requires!.map((id) => REQUIREMENT_LABEL[id] ?? id).join(", ")}</Fact>
          ) : null}
        </dl>

        {!installed && (entry.mcp.inputs?.length ?? 0) > 0 ? (
          <fieldset className="icat-fields">
            <legend className="icat-sr">{s.inputsTitle}</legend>
            {(entry.mcp.inputs ?? []).map((input) => (
              <InputField key={input.id} ui={ui} entryId={entry.id} input={input} value={inputs[input.id] ?? ""} error={props.inputErrors[input.id]}
                onChange={(value) => props.onInputChange(input.id, value)} onBlur={props.onInputBlur} />
            ))}
          </fieldset>
        ) : null}

        {connect?.scope === "person" && entry.mcp.auth === "token" ? (
          <TokenField ui={ui} entryId={entry.id} tokenHelpUrl={entry.mcp.tokenHelpUrl} token={token} showToken={props.showToken}
            optional={connect.tokenOptional} onTokenChange={props.onTokenChange} onToggleToken={props.onToggleToken}
            onSubmit={() => { if (!connectDisabled && props.canConnect) props.onInstall(); }} s={s} />
        ) : null}

        {action?.kind === "blocked" ? (
          <p className="icat-note">
            {action.reason === "local-unpinned" ? <>{s.detailLocalPin} <code className="icat-mono">{target}</code></> : s.detailTokenMissing}
          </p>
        ) : null}
        {disconnect && !disconnect.enabled ? <p className="icat-note">{s.installedOffNote}</p> : null}

        <div className="icat-actions" aria-live="polite">
          {connect ? (
            <>
              <Button variant="primary" busy={busy === "install"} disabled={connectDisabled} onClick={props.onInstall}>
                {busy === "install" ? s.installing : s.install}
              </Button>
              {tokenMissing ? <span className="icat-note">{s.tokenNeeded}</span> : null}
            </>
          ) : null}
          {disconnect?.catalogManaged && confirming ? (
            <div className="icat-confirm" role="group" aria-label={s.uninstall}>
              <p>{fill(s.disconnectKeyWarning, { name: entry.name })}</p>
              <div className="icat-actions">
                <Button variant="ghost" disabled={busy !== null} onClick={props.onCancelConfirm}>{s.cancel}</Button>
                <Button variant="danger" busy={busy === "uninstall"} disabled={busy !== null} onClick={props.onUninstall}>
                  {busy === "uninstall" ? s.uninstalling : s.disconnectConfirm}
                </Button>
              </div>
            </div>
          ) : null}
          {disconnect?.catalogManaged && !confirming ? (
            <>
              {!disconnect.enabled && onOpenMcpSettings ? <Button variant="ghost" onClick={onOpenMcpSettings}>{s.manageInSettings}</Button> : null}
              <Button variant="danger" busy={busy === "uninstall"} disabled={busy !== null} onClick={props.onUninstall}>
                {busy === "uninstall" ? s.uninstalling : s.uninstall}
              </Button>
            </>
          ) : null}
          {disconnect && !disconnect.catalogManaged ? (
            <>
              <span className="icat-note">{s.installedManual}</span>
              {onOpenMcpSettings ? <Button variant="ghost" onClick={onOpenMcpSettings}>{s.manageInSettings}</Button> : null}
            </>
          ) : null}
        </div>

        {outcome ? (
          <div className="icat-outcome" data-tone={outcome.tone} role={outcome.tone === "error" ? "alert" : "status"}>
            <p>{outcome.text}</p>
            {outcome.notes.length > 0 ? <ul>{outcome.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
          </div>
        ) : null}
      </section>

      <section className="icat-sec">
        <h3>{s.detailAbout}</h3>
        <p className="icat-prose">{entry.description}</p>
        <ExternalLink href={entry.homepage}>{fill(s.openService, { name: entry.name })}</ExternalLink>
      </section>

      <section className="icat-sec">
        <h3>{s.detailComponents}</h3>
        <dl className="icat-facts">
          <Fact label={s.detailType}>{local ? s.componentsLocal : s.componentsRemote}</Fact>
          {target ? <Fact label={local ? s.detailCommand : s.detailEndpoint}><code className="icat-mono">{target}</code></Fact> : null}
          {entry.mcp.auth === "oauth" || registration === "none" ? (
            <Fact label={s.detailSignInMethod}>{registration === "none" ? s.registrationNone : s.registrationDynamic}</Fact>
          ) : null}
          {(entry.skills?.length ?? 0) > 0 ? <Fact label={s.detailSkills}>{entry.skills!.map((skill) => skill.name).join(", ")}</Fact> : null}
        </dl>
      </section>

      <section className="icat-sec">
        <h3>{s.detailEvidence}</h3>
        <dl className="icat-facts">
          <Fact label={s.detailChecked}>{entry.evidence.checkedAt}</Fact>
          <Fact label={s.detailSource}><ExternalLink href={entry.evidence.source}>{entry.evidence.source.replace(/^https:\/\//, "")}</ExternalLink></Fact>
        </dl>
        <details className="icat-evidence">
          <summary>{s.detailProbeMore}</summary>
          <p className="icat-prose">{probeText(entry, s)}</p>
        </details>
      </section>
    </article>
  );
}

/** A region, site or organization the endpoint needs. A choice is a native
 *  select (the phone's own picker); free text is checked as it is typed. */
function InputField({ ui, entryId, input, value, error, onChange, onBlur }: {
  ui: Ui;
  entryId: string;
  input: IntegrationInput;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const { TextInput } = ui.components;
  const id = `icat-input-${entryId}-${input.id}`;
  const hintId = `${id}-hint`;
  return (
    <div className="icat-field" data-invalid={error ? "true" : undefined}>
      <label htmlFor={id}>{input.label}</label>
      {input.choices ? (
        <select id={id} className="icat-select" value={value} aria-describedby={hintId} onChange={(event) => onChange(event.target.value)} onBlur={onBlur}>
          {input.default === undefined ? <option value="" disabled>{input.placeholder ?? "—"}</option> : null}
          {input.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </select>
      ) : (
        <TextInput id={id} value={value} placeholder={input.placeholder} autoComplete="off" autoCapitalize="none" spellCheck={false}
          invalid={Boolean(error)} aria-describedby={hintId} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} />
      )}
      <p className="icat-hint" id={hintId} role={error ? "alert" : undefined}>{error ?? input.hint ?? ""}</p>
    </div>
  );
}

/** The API key field. A required key gates the action; an optional one says so. */
function TokenField({ ui, entryId, tokenHelpUrl, token, showToken, optional, onTokenChange, onToggleToken, onSubmit, s }: {
  ui: Ui;
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
  const { Button } = ui.components;
  const { TextInput } = ui.components;
  const id = `icat-token-${entryId}`;
  return (
    <div className="icat-field">
      <div className="icat-field-head">
        <label htmlFor={id}>{s.detailTokenLabel}</label>
        {tokenHelpUrl ? <ExternalLink href={tokenHelpUrl}>{s.detailToken}</ExternalLink> : null}
      </div>
      <div className="icat-token-row">
        <TextInput id={id} type={showToken ? "text" : "password"} value={token} placeholder={optional ? s.detailTokenOptional : s.detailTokenPlaceholder}
          autoComplete="off" autoCapitalize="none" spellCheck={false} enterKeyHint="go"
          onChange={(event) => onTokenChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onSubmit(); } }} />
        <Button variant="ghost" aria-pressed={showToken} onClick={onToggleToken}>{showToken ? s.detailTokenHide : s.detailTokenShow}</Button>
      </div>
      <p className="icat-hint">{s.detailTokenVault}</p>
    </div>
  );
}

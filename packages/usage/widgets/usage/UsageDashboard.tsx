import { rootProjects } from "@polyth/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import type { SurfaceComponentProps } from "@polyth/web-sdk";
import { useShellMode } from "../../../../apps/web/src/responsiveShell.ts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import { subscribeSessionEvents, useStore } from "../../../../apps/web/src/store.ts";
import {
  Button,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DragHandleIcon,
  EmptyState,
  Icon,
  IconButton,
  LayersIcon,
  MinusIcon,
  PlusIcon,
  RefreshIcon,
  Select,
  Switch,
  Tabs,
  UndoIcon,
} from "../../../../apps/web/src/components/ui/index.ts";
import { useArrange } from "../../../../apps/web/src/workspaceArrange.ts";
import { useUsageStats } from "./usageStatsClient.ts";
import { LimitsView } from "./LimitsView.tsx";
import {
  ActivityBlock,
  CacheBurnBlock,
  CoverageNote,
  HarnessBreakdown,
  ModelsBlock,
  ProjectsBlock,
  ScopedOverview,
  SessionOverview,
  SessionsBlock,
  TimingBlock,
  TokenMix,
  TurnsBlock,
} from "./dashboardBlocks.tsx";
import { formatClock, rangeLabel } from "./dashboardFormat.ts";
import {
  effectiveUsageView,
  isDefaultUsageLayout,
  moveUsageBlock,
  resetUsageLayout,
  updateUsageDashboardPrefs,
  updateUsageLayout,
  useUsageDashboardPrefs,
  visibleUsageBlocks,
  type UsageBlockId,
  type UsageBlockLayout,
  type UsageDashboardRange,
  type UsageDashboardView,
  type UsageLayoutScope,
} from "./dashboardLayout.ts";
import type { UsageChartMetric, UsageStatsQuery, UsageStatsReport } from "../../src/analytics/contracts.ts";
import { subscribeUsageViewRequest, takeUsageViewRequest } from "./viewRequest.ts";

export type UsageView = UsageDashboardView;

/** Live usage arrives per model step; coalesce each burst into one revalidation. */
const LIVE_REFRESH_DELAY_MS = 900;

export const viewerTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const blockTitle = (id: UsageBlockId): string => {
  switch (id) {
    case "overview": return tr("usage.blockOverview");
    case "activity": return tr("usage.activity");
    case "tokens": return tr("usage.tokenMix");
    case "cache": return tr("usage.cacheBurn");
    case "timing": return tr("usage.timing");
    case "turns": return tr("usage.turns");
    case "projects": return tr("usage.projects");
    case "harnesses": return tr("usage.harnesses");
    case "models": return tr("usage.models");
    case "sessions": return tr("usage.sessions");
  }
};

const blockDescription = (id: UsageBlockId, scope: UsageLayoutScope): string => {
  switch (id) {
    case "overview": return tr("usage.blockOverviewDescription");
    case "activity": return tr("usage.actualRecordedUsage");
    case "tokens": return scope === "session" ? tr("usage.recordedTokenComposition") : tr("usage.tokenMixDescription");
    case "cache": return tr("usage.cacheBurnDescription");
    case "timing": return tr("usage.turnTelemetryCountedOnce");
    case "turns": return tr("usage.recentMeasuredTurns");
    case "projects": return tr("usage.whereUsageHappening");
    case "harnesses": return tr("usage.harnessesDescription");
    case "models": return tr("usage.modelsUsedInScope");
    case "sessions": return tr("usage.mostRecentlyActiveSessions");
  }
};

const scopeLabel = (scope: UsageLayoutScope): string =>
  scope === "session" ? tr("usage.session") : scope === "project" ? tr("usage.project") : tr("usage.global");

/** The exact query each scope sends; exported so activation can warm it. */
export function queryFor(
  view: UsageView,
  sessionId: string | null,
  projectId: string | null,
  range: UsageDashboardRange,
  timezone: string,
): UsageStatsQuery {
  if (view === "session") {
    return {
      range: "all",
      timezone,
      ...(sessionId ? { sessionIds: [sessionId] } : {}),
      detailLimit: 100,
      detailSort: "activity",
    };
  }
  if (view === "project") {
    return {
      range,
      timezone,
      ...(projectId ? { projectIds: [projectId] } : {}),
      detailLimit: 50,
      detailSort: "activity",
    };
  }
  return {
    range,
    timezone,
    detailLimit: 50,
    detailSort: "activity",
  };
}

function ReportBlocks({
  scope,
  report,
  layout,
  range,
  metric,
  session,
  onArrange,
  editing,
  onEditing,
}: {
  scope: UsageLayoutScope;
  report: UsageStatsReport;
  layout: UsageBlockLayout;
  range: UsageDashboardRange;
  metric: UsageChartMetric;
  session: Parameters<typeof SessionOverview>[0]["session"];
  onArrange: () => void;
  /** Phone Home Screen editing: blocks sway, − hides, a drag reorders. */
  editing: boolean;
  /** Set on a phone: holding a block turns editing on and lifts it. */
  onEditing?: (editing: boolean) => void;
}) {
  const setMetric = useCallback((next: UsageChartMetric) => updateUsageDashboardPrefs({ metric: next }), []);
  const render = (id: UsageBlockId): ReactNode => {
    switch (id) {
      case "overview":
        return scope === "session" ? <SessionOverview report={report} session={session} /> : <ScopedOverview report={report} range={range} />;
      case "activity": return <ActivityBlock report={report} metric={metric} onMetric={setMetric} />;
      case "tokens": return <TokenMix metrics={report.totals} description={blockDescription("tokens", scope)} />;
      // Reports from older servers carry no burn field at all.
      case "cache": return report.totals.cacheBurn === undefined ? null : <CacheBurnBlock report={report} scope={scope} />;
      case "timing": return <TimingBlock metrics={report.totals} />;
      case "turns": return <TurnsBlock report={report} />;
      case "projects": return <ProjectsBlock report={report} range={range} />;
      // Cached and older-server reports predate the harness breakdown.
      case "harnesses": return report.harnesses ? <HarnessBreakdown harnesses={report.harnesses} /> : null;
      case "models": return <ModelsBlock report={report} range={range} />;
      case "sessions": return <SessionsBlock report={report} />;
    }
  };
  // Blocks with nothing to draw for this report keep their slot but are not
  // drawn, so they are not arrangeable either.
  const drawn = visibleUsageBlocks(layout)
    .map((id) => ({ id, content: render(id) }))
    .filter((entry) => entry.content !== null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const arrange = useArrange({
    items: drawn.map(({ id }) => ({ id, shape: "row" as const })),
    enabled: editing,
    scroller: () => listRef.current?.closest<HTMLElement>(".usage-clean") ?? null,
    ghostHost: () => listRef.current,
    // As the phone Workspace: holding a block turns editing on and the same
    // press carries on as a drag.
    ...(onEditing ? {
      activate: () => {
        if (editingRef.current) return false;
        editingRef.current = true;
        flushSync(() => onEditing(true));
        return true;
      },
    } : {}),
    onCommit: (next) => {
      // Hidden and undrawn blocks keep their slots; the drawn ones take the new order.
      const moved = new Set<string>(next);
      let cursor = 0;
      updateUsageLayout(scope, { ...layout, order: layout.order.map((id) => moved.has(id) ? next[cursor++] as UsageBlockId : id) });
    },
  });
  const listElement = useCallback((element: HTMLDivElement | null) => {
    listRef.current = element;
    arrange.engine.listRef(element);
  }, [arrange.engine]);
  const byId = new Map(drawn.map((entry) => [entry.id, entry.content]));
  const shown: UsageBlockId[] = arrange.draggingId
    ? arrange.order.filter((id): id is UsageBlockId => byId.has(id as UsageBlockId))
    : drawn.map(({ id }) => id);
  const setHidden = (id: UsageBlockId, hidden: boolean) => {
    arrange.engine.animateNextLayout();
    updateUsageLayout(scope, {
      ...layout,
      hidden: hidden ? [...new Set([...layout.hidden, id])] : layout.hidden.filter((candidate) => candidate !== id),
    });
  };
  return (
    <div
      ref={listElement}
      className="usage-clean-stack"
      data-arrange-editing={editing || undefined}
      data-arranging={arrange.draggingId ? "" : undefined}
    >
      <CoverageNote report={report} />
      {shown.map((id, index) => (
        <div
          key={id}
          className={`usage-clean-block${arrange.draggingId === id ? " is-arrange-held" : ""}`}
          data-block={id}
          style={{ "--jiggle-phase": index % 7 } as CSSProperties}
          {...(editing || onEditing ? arrange.engine.itemProps(id) : {})}
          {...(editing ? { tabIndex: 0, "aria-label": blockTitle(id), onKeyDown: (event: KeyboardEvent<HTMLElement>) => arrange.engine.onArrangeKey(id, event) } : {})}
        >
          <div className="usage-clean-block-body" inert={editing || undefined}>{byId.get(id)}</div>
          {editing && (
            <button
              type="button"
              className="arrange-badge"
              data-arrange-control=""
              aria-label={tr("usage.hideBlock", { block: blockTitle(id) })}
              onClick={() => setHidden(id, true)}
            >
              <Icon icon={MinusIcon} size="sm" />
            </button>
          )}
        </div>
      ))}
      {editing && layout.hidden.length > 0 && (
        <section className="usage-clean-hidden" aria-label={tr("usage.hiddenBlocks")}>
          <h3>{tr("usage.hiddenBlocks")}</h3>
          {layout.hidden.map((id) => (
            <button key={id} type="button" className="usage-clean-hidden-row" onClick={() => setHidden(id, false)} aria-label={tr("usage.showBlock", { block: blockTitle(id) })}>
              <span className="arrange-badge arrange-badge--add" aria-hidden="true"><Icon icon={PlusIcon} size="sm" /></span>
              <span><strong>{blockTitle(id)}</strong><small>{blockDescription(id, scope)}</small></span>
            </button>
          ))}
        </section>
      )}
      {drawn.length === 0 && !editing ? (
        <EmptyState
          variant="panel"
          title={tr("usage.allBlocksHidden")}
          description={tr("usage.allBlocksHiddenDescription")}
          actionLabel={tr("usage.customizeLayout")}
          onAction={onArrange}
        />
      ) : null}
    </div>
  );
}

function ArrangePanel({ scope, layout, onDone }: { scope: UsageLayoutScope; layout: UsageBlockLayout; onDone: () => void }) {
  const listRef = useRef<HTMLOListElement>(null);
  const [preview, setPreview] = useState<UsageBlockId[] | null>(null);
  const [dragging, setDragging] = useState<UsageBlockId | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const order = preview ?? layout.order;

  const announce = (id: UsageBlockId, next: readonly UsageBlockId[]): void =>
    setAnnouncement(tr("usage.blockMoved", { block: blockTitle(id), position: next.indexOf(id) + 1, count: next.length }));
  const commit = (id: UsageBlockId, next: UsageBlockId[]): void => {
    if (next.join() !== layout.order.join()) {
      updateUsageLayout(scope, { ...layout, order: next });
      announce(id, next);
    }
  };
  const step = (id: UsageBlockId, direction: -1 | 1): void => {
    const index = layout.order.indexOf(id);
    if (index + direction < 0 || index + direction >= layout.order.length) return;
    commit(id, moveUsageBlock(layout.order, id, index + direction));
  };
  const setVisible = (id: UsageBlockId, visible: boolean): void => {
    const hidden = visible ? layout.hidden.filter((candidate) => candidate !== id) : [...new Set([...layout.hidden, id])];
    updateUsageLayout(scope, { ...layout, hidden });
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: UsageBlockId): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    step(id, event.key === "ArrowUp" ? -1 : 1);
  };

  const onHandlePointerDown = (event: PointerEvent<HTMLButtonElement>, id: UsageBlockId): void => {
    if (event.button !== 0 || !listRef.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.focus({ preventScroll: true });
    const base = layout.order;
    let next = base;
    setDragging(id);
    const move = (moveEvent: globalThis.PointerEvent): void => {
      const rows = [...listRef.current?.querySelectorAll<HTMLElement>("[data-arrange-row]") ?? []]
        .filter((row) => row.dataset.arrangeRow !== id);
      const index = rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return moveEvent.clientY > rect.top + rect.height / 2;
      }).length;
      const candidate = moveUsageBlock(base, id, index);
      if (candidate.join() !== next.join()) {
        next = candidate;
        setPreview(candidate);
      }
    };
    const finish = (cancelled: boolean): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel);
      handle.removeEventListener("keydown", escape);
      setDragging(null);
      setPreview(null);
      if (!cancelled) commit(id, next);
    };
    const up = (): void => finish(false);
    const cancel = (): void => finish(true);
    const escape = (keyEvent: globalThis.KeyboardEvent): void => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      finish(true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    handle.addEventListener("keydown", escape);
  };

  return (
    <section className="usage-clean-arrange" aria-labelledby="usage-arrange-title">
      <header>
        <div>
          <h3 id="usage-arrange-title">{tr("usage.arrangeTitle", { scope: scopeLabel(scope) })}</h3>
          <p>{tr("usage.arrangeDescription")}</p>
        </div>
        <div className="usage-clean-arrange-actions">
          <Button size="sm" variant="ghost" iconStart={UndoIcon} disabled={isDefaultUsageLayout(scope, layout)} onClick={() => resetUsageLayout(scope)}>
            {tr("usage.resetLayout")}
          </Button>
          <Button size="sm" variant="primary" iconStart={CheckIcon} onClick={onDone}>{tr("usage.done")}</Button>
        </div>
      </header>
      <ol ref={listRef} className="usage-clean-arrange-list">
        {order.map((id, index) => {
          const visible = !layout.hidden.includes(id);
          const title = blockTitle(id);
          return (
            <li
              key={id}
              className="usage-clean-arrange-row"
              data-arrange-row={id}
              data-hidden={visible ? undefined : "true"}
              data-dragging={dragging === id ? "true" : undefined}
            >
              <button
                type="button"
                className="usage-clean-arrange-handle"
                aria-label={tr("usage.dragBlock", { block: title })}
                aria-keyshortcuts="ArrowUp ArrowDown"
                onPointerDown={(event) => onHandlePointerDown(event, id)}
                onKeyDown={(event) => onHandleKeyDown(event, id)}
              >
                <Icon icon={DragHandleIcon} size="sm" />
              </button>
              <span className="usage-clean-arrange-index" aria-hidden="true">{index + 1}</span>
              <div className="usage-clean-arrange-copy">
                <strong>{title}</strong>
                <small>{blockDescription(id, scope)}</small>
              </div>
              <div className="usage-clean-arrange-controls">
                <IconButton size="sm" icon={ChevronUpIcon} label={tr("usage.moveUp", { block: title })} disabled={index === 0} onClick={() => step(id, -1)} />
                <IconButton size="sm" icon={ChevronDownIcon} label={tr("usage.moveDown", { block: title })} disabled={index === order.length - 1} onClick={() => step(id, 1)} />
                <Switch checked={visible} label={tr("usage.showBlock", { block: title })} onChange={(checked) => setVisible(id, checked)} />
              </div>
            </li>
          );
        })}
      </ol>
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </section>
  );
}

export function UsageDashboard({ active = true, projectId: shellProjectId, sessionId: shellSessionId }: SurfaceComponentProps = {}): ReactNode {
  const storeSessionId = useStore((state) => state.activeSessionId);
  const storeProjectId = useStore((state) => state.activeProjectId);
  const activeSessionId = shellSessionId === undefined ? storeSessionId : shellSessionId;
  const activeProjectId = shellProjectId === undefined ? storeProjectId : shellProjectId;
  // Select only what renders: the whole session list changes on every status tick.
  const activeSession = useStore((state) => activeSessionId ? state.sessions.find((session) => session.id === activeSessionId) ?? null : null);
  const projects = useStore((state) => state.projectRegistry.projects);
  const prefs = useUsageDashboardPrefs();

  // The tab is a persisted preference: a kept-alive pane remounting, a reload
  // or a moment without an active session must not reset it.
  const view = effectiveUsageView(prefs.view, activeSessionId);
  const setView = useCallback((next: UsageView) => updateUsageDashboardPrefs({ view: next }), []);
  const [projectId, setProjectId] = useState<string | null>(activeProjectId);
  const [arranging, setArranging] = useState(false);
  // Phone: Home Screen editing in place of the arrange panel.
  const phone = useShellMode() === "phone";
  const [editing, setEditing] = useState(false);
  const timezone = useMemo(() => viewerTimezone(), []);
  const range = prefs.range;

  useEffect(() => {
    const apply = () => {
      const requested = takeUsageViewRequest();
      if (requested) setView(requested);
    };
    apply();
    return subscribeUsageViewRequest(apply);
  }, [setView]);

  useEffect(() => {
    if (projectId && projects.some((project) => project.id === projectId)) return;
    setProjectId(activeProjectId && projects.some((project) => project.id === activeProjectId)
      ? activeProjectId
      : projects[0]?.id ?? null);
  }, [activeProjectId, projectId, projects]);

  useEffect(() => {
    if (view === "limits" || !phone) setEditing(false);
    if (view === "limits") setArranging(false);
  }, [view, phone]);
  useEffect(() => {
    if (!editing) return;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setEditing(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  const enabled = view !== "limits" && (
    view === "global" || (view === "session" ? !!activeSessionId : !!projectId)
  );
  const query = useMemo(
    () => queryFor(view, activeSessionId, projectId, range, timezone),
    [view, activeSessionId, projectId, range, timezone],
  );
  // A kept-alive pane that is closed keeps its last report on screen but
  // neither polls nor follows live usage; showing it again revalidates once.
  const stats = useUsageStats(query, { enabled, paused: !active });
  const { refresh } = stats;

  useEffect(() => {
    if (!enabled || !active) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeSessionEvents((event) => {
      if (event.type !== "usage/recorded" && event.type !== "turn/stopped") return;
      if (view === "session" && event.sessionId !== activeSessionId) return;
      // Throttle, not debounce: concurrent sessions can emit faster than the
      // delay, and a resetting timer would never let the dashboard refresh.
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, LIVE_REFRESH_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [active, activeSessionId, enabled, refresh, view]);

  const scope: UsageLayoutScope | null = view === "limits" ? null : view;
  const layout = scope ? prefs.layouts[scope] : null;
  const report = stats.report;
  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const title = view === "session"
    ? activeSession?.title ?? tr("usage.session")
    : view === "project"
      ? selectedProject?.name ?? tr("usage.project")
      : tr("usage.allProjects");
  const subtitle = view === "session"
    ? tr("usage.lifetimeSessionTelemetry")
    : `${rangeLabel(range)} · ${timezone}`;
  const hiddenCount = layout?.hidden.length ?? 0;

  return (
    <div className="usage-clean" aria-busy={stats.loading || stats.refreshing}>
      <header className="usage-clean-toolbar">
        <Tabs
          className="usage-clean-scope-tabs"
          size="sm"
          label={tr("usage.usageScope")}
          value={view}
          tabs={[
            { id: "session", label: tr("usage.session") },
            { id: "project", label: tr("usage.project") },
            { id: "global", label: tr("usage.global") },
            { id: "limits", label: tr("usage.limits") },
          ]}
          onChange={(value) => setView(value as UsageView)}
        />

        {view === "project" ? (
          <Select
            className="usage-clean-project"
            label={tr("usage.projectLabel")}
            ariaLabel={tr("usage.projectLabel")}
            value={projectId ?? ""}
            options={rootProjects(projects).map((project) => ({ value: project.id, label: project.name, detail: project.path }))}
            onChange={(value) => setProjectId(value)}
            mobileSheet
          />
        ) : null}

        {view === "project" || view === "global" ? (
          <Tabs
            className="usage-clean-range"
            size="sm"
            label={tr("usage.usageRange")}
            value={range}
            tabs={[
              { id: "7d", label: tr("usage.daysShort", { count: 7 }) },
              { id: "30d", label: tr("usage.daysShort", { count: 30 }) },
              { id: "90d", label: tr("usage.daysShort", { count: 90 }) },
              { id: "all", label: tr("usage.all") },
            ]}
            onChange={(value) => updateUsageDashboardPrefs({ range: value as UsageDashboardRange })}
          />
        ) : null}

        <span className="usage-clean-spacer" />
        {view !== "limits" ? (
          <>
            <span className="usage-clean-freshness" aria-live="polite">
              {stats.refreshing
                ? tr("usage.refreshing")
                : report
                  ? tr("usage.updated", { time: formatClock(report.generatedAt) })
                  : ""}
            </span>
            <span className="usage-clean-toolbar-actions">
              {phone && editing ? (
                <Button size="sm" variant="primary" className="usage-clean-done" onClick={() => setEditing(false)}>{tr("usage.done")}</Button>
              ) : (
                <IconButton
                  icon={LayersIcon}
                  label={hiddenCount > 0 ? `${tr("usage.customizeLayout")} · ${tr("usage.layoutHiddenCount", { count: hiddenCount })}` : tr("usage.customizeLayout")}
                  pressed={arranging}
                  onClick={() => phone ? setEditing(true) : setArranging((value) => !value)}
                />
              )}
              <IconButton
                icon={RefreshIcon}
                label={tr("usage.refresh")}
                busy={stats.refreshing}
                disabled={!enabled}
                onClick={refresh}
              />
            </span>
          </>
        ) : null}
      </header>

      {view !== "limits" ? (
        <div className="usage-clean-heading">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      ) : null}

      {view !== "limits" && stats.error && report ? (
        <div className="usage-clean-error" role="status">
          <strong>{tr("usage.usageCouldNotRefresh")}</strong>
          <span>{stats.stale ? `${tr("usage.showingLastSuccessfulReport")} ` : ""}{stats.error}</span>
          <Button size="sm" onClick={refresh}>{tr("usage.retry")}</Button>
        </div>
      ) : null}

      {view === "limits" ? (
        <div className="usage-clean-content usage-clean-content-limits">
          <LimitsView />
        </div>
      ) : scope && layout && arranging ? (
        <div className="usage-clean-content">
          <ArrangePanel scope={scope} layout={layout} onDone={() => setArranging(false)} />
        </div>
      ) : !enabled ? (
        <EmptyState
          variant="panel"
          title={view === "session" ? tr("usage.noActiveSession") : tr("usage.noProjectSelected")}
          description={view === "session" ? tr("usage.openSessionToInspect") : tr("usage.createOrSelectProject")}
        />
      ) : stats.loading && !report ? (
        <div className="usage-clean-content">
          <div className="usage-clean-skeleton" aria-hidden="true">
            <div className="usage-clean-overview">
              {Array.from({ length: 6 }, (_, index) => <div key={index} className="usage-clean-kpi" data-primary={index === 0 ? "true" : undefined} />)}
            </div>
            <div className="usage-clean-section" />
            <div className="usage-clean-section" />
          </div>
          <p className="sr-only" role="status">{tr("usage.readingTelemetry")}</p>
        </div>
      ) : stats.error && !report ? (
        <EmptyState
          variant="panel"
          title={tr("usage.unavailable")}
          description={stats.error}
          actionLabel={tr("usage.retry")}
          onAction={refresh}
        />
      ) : report && scope && layout ? (
        <div className="usage-clean-content">
          <ReportBlocks
            scope={scope}
            report={report}
            layout={layout}
            range={range}
            metric={prefs.metric}
            session={activeSession}
            onArrange={() => phone ? setEditing(true) : setArranging(true)}
            editing={phone && editing}
            {...(phone ? { onEditing: setEditing } : {})}
          />
        </div>
      ) : (
        <EmptyState variant="panel" title={tr("usage.noUsageData")} description={tr("usage.recordedUsageWillAppear")} />
      )}
    </div>
  );
}

export default UsageDashboard;

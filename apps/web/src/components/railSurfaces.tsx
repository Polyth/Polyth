// F17 + UX-PANE-MODEL: built-in right-rail surfaces. Each panel is a
// self-contained component (own hooks/state) registered into the surface
// registry — ContextRail renders whatever is registered and never enumerates
// panels itself. Importing this module registers the built-ins once.
//
// The four CANONICAL workspace surfaces (Files/Git/Terminal/Preview) register
// here with presentation metadata: the same full implementations that used to
// be primary views, now docked/expanded/full-screen beside a still-mounted
// Chat. The reduced FilesPanel/ChangesPanel duplicates are gone — surface
// switching changes presentation, never implementation identity.
import { useActiveModel, useStore } from "../store.ts";
import { fmtCost, fmtTokens } from "../format.ts";
import type { SessionEvent } from "@polyth/contracts";
import { resolveModelPresentation } from "@polyth/contracts/model-presentation";
import {
  contextGaugeForTelemetry,
  contextTelemetryNotice,
  contextTelemetryStatus,
  formatContextPercent,
} from "../reduce.ts";
import { RAIL_ICONS } from "../railIcons.ts";
import {
  registerSurface,
  type RailSurfaceComponentProps,
} from "../surfaces.ts";
import EmptyState from "./EmptyState.tsx";
import { Button } from "./ui/index.ts";
import { getLocale, tr } from "../i18n/index.ts";
import { loadOlderEvents } from "../init.ts";
import { useProjectContextSnapshots } from "../packages/projectContext.ts";
import type { ProjectContextEntry } from "../packages/projectContext.ts";

const NO_EVENTS: SessionEvent[] = [];

export function ProjectContextList({ entries }: { entries: readonly ProjectContextEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div>
      {entries.map((entry) => (
        <section key={entry.id} data-project-context={entry.id} data-owner-package={entry.ownerPackageId}>
          <div className="stat-label">{entry.snapshot.title}</div>
          {(entry.snapshot.items ?? []).map((item) => (
            <div key={`${item.label}:${item.value}`} className="stat-row">
              <span className="k">{item.label}</span>
              <span>{item.value}</span>
            </div>
          ))}
          {entry.snapshot.needsSetup && (
            <div className="stat-row">
              <Button type="button" size="sm" onClick={() => entry.snapshot.needsSetup!.open()}>
                {entry.snapshot.needsSetup.label}
              </Button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function ContextView() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const projectId = useStore((s) => s.activeProjectId);
  const packageContext = useProjectContextSnapshots(projectId);
  const models = useStore((s) => s.models);
  const model = useActiveModel();
  const runtimeFeatures = useStore((s) => s.activeSessionId ? s.runtimeFeatures[s.activeSessionId] : undefined);
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  if (!session) {
    if (packageContext.length === 0) {
      return <div className="rail-empty">{tr("railsurfaces.sessionStatusUsageAndPinnedContextWill")}</div>;
    }
    return <ProjectContextList entries={packageContext} />;
  }

  // Pinned messages = context/pinned minus context/unpinned (last event wins).
  const pinned = new Map<number, boolean>();
  for (const e of events) {
    const sourceEventSeq = Number((e.data as Record<string, unknown>).sourceEventSeq);
    if (!Number.isSafeInteger(sourceEventSeq)) continue;
    if (e.type === "context/pinned") pinned.set(sourceEventSeq, true);
    if (e.type === "context/unpinned") pinned.set(sourceEventSeq, false);
  }
  const pinnedMessages = [...pinned.entries()]
    .filter(([, active]) => active)
    .map(([seq]) => events.find((event) => event.seq === seq))
    .filter((event): event is SessionEvent =>
      !!event && (event.type === "user/message" || event.type === "assistant/message"));
  const activeModel = model.contextUsage?.model ?? model.turn?.model ?? session.model;
  const modelPresentation = resolveModelPresentation(activeModel, models, session.resolvedHarnessId);
  const descriptor = modelPresentation.descriptor;
  const telemetryStatus = contextTelemetryStatus(runtimeFeatures?.telemetry);
  const gauge = contextGaugeForTelemetry(model, descriptor?.context, session.contextWindow ?? null, telemetryStatus);
  const contextPercent = formatContextPercent(gauge);
  const contextNotice = contextTelemetryNotice(telemetryStatus, gauge);

  return (
    <div>
      <ProjectContextList entries={packageContext} />
      <div className="stat-row">
        <span className="k">{tr("railsurfaces.status")}</span>
        <span className="status-line rail-status-line">
          <span className={`dot ${session.status}`} />
          <span>{session.status}</span>
        </span>
      </div>
      <div className="stat-row">
        <span className="k">{tr("railsurfaces.model")}</span>
        <span>{activeModel ? modelPresentation.name : "—"}</span>
      </div>
      <div className="stat-row">
        <span className="k">{tr("railsurfaces.agent")}</span>
        <span>{session.agent ?? "—"}</span>
      </div>
      <div className="stat-row">
        <span className="k">{tr("railsurfaces.tokens")}</span>
        <span className="mono">{fmtTokens(model.totals.input + model.totals.output)}</span>
      </div>
      <div className="stat-row context-estimate-row">
        <span className="k">{tr("railsurfaces.contextEstimate")}</span>
        <span className="mono">
          {contextNotice
            ? tr("railsurfaces.unknown")
            : contextPercent && gauge.known
            ? `${fmtTokens(gauge.inputTokens)} / ${fmtTokens(gauge.contextTokens)} (${contextPercent})`
            : contextPercent ?? tr("railsurfaces.unknown")}
        </span>
      </div>
      <div
        className={`context-meter ${gauge.level}`}
        role="meter"
        aria-label={gauge.known ? tr("railsurfaces.valueContextEstimate", { percent: gauge.percent }) : tr("railsurfaces.contextEstimateUnknown")}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(gauge.known ? { "aria-valuenow": gauge.percent } : {})}
      >
        <span style={{ width: `${gauge.known ? gauge.percent : 0}%` }} />
      </div>
      {contextNotice && <div className="muted context-estimate-note">{contextNotice}</div>}
      <div className="stat-row">
        <span className="k">{tr("railsurfaces.cost")}</span>
        <span className="mono">{model.totals.cost > 0 ? fmtCost(model.totals.cost) : "—"}</span>
      </div>
      <div className="stat-label">{tr("railsurfaces.pinned")}</div>
      {pinnedMessages.length === 0 && (
        <EmptyState
          title={tr("railsurfaces.nothingPinnedYet")}
          description={tr("railsurfaces.sessionStatusUsageAndPinnedContextWill")}
        />
      )}
      {pinnedMessages.map((event) => (
        <div key={event.seq} className="pinned-file">
          <span className="mono">#{event.seq}</span>{" "}
          {String((event.data as Record<string, unknown>).text ?? "").slice(0, 120)}
        </div>
      ))}
    </div>
  );
}

function ActiveEventsView() {
  const sessionId = useStore((s) => s.activeSessionId);
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  if (events.length === 0) {
    return (
      <EmptyState
        title={tr("railsurfaces.noEventsYet")}
        description={tr("railsurfaces.sessionStatusUsageAndPinnedContextWill")}
      />
    );
  }
  return (
    <div className="event-list">
      {sessionId && events[0]?.seq !== 1 && (
        <Button type="button" size="sm" variant="ghost" onClick={() => { void loadOlderEvents(sessionId); }}>
          Load older session events
        </Button>
      )}
      {[...events].reverse().map((e) => (
        <details key={e.id} className="event-row">
          <summary>
            <span className="e-seq">#{e.seq}</span>
            <span className="e-type">{e.type}</span>
            <span className="e-time">{new Date(e.time).toLocaleTimeString(getLocale())}</span>
          </summary>
          <div className="event-json">
            <pre>{JSON.stringify(e, null, 2)}</pre>
          </div>
        </details>
      ))}
    </div>
  );
}

function EventsView(props?: RailSurfaceComponentProps) {
  return props?.active !== false ? <ActiveEventsView /> : null;
}

registerSurface({ id: "context", title: tr("railsurfaces.context"), description: "Inspect session status, usage, and pinned context.", capabilityId: "context", order: 30, icon: RAIL_ICONS.context, component: ContextView });
registerSurface({
  id: "events", title: tr("railsurfaces.events"), description: "Inspect the session event stream.", capabilityId: "events", order: 60, icon: RAIL_ICONS.events,
  component: EventsView, badge: (ctx) => ctx.eventCount,
});

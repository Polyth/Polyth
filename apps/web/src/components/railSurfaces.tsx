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
import { contextGauge } from "../reduce.ts";
import { RAIL_ICONS } from "../railIcons.ts";
import {
  registerSurface,
  type RailSurfaceComponentProps,
  type WorkspacePanePresentation,
} from "../surfaces.ts";
import EditorView from "./EditorView.tsx";
import GitView from "./GitView.tsx";
import TerminalView from "./TerminalView.tsx";
import PreviewView from "./PreviewView.tsx";
import KnowledgePanel from "./KnowledgePanel.tsx";
import { getLocale, tr } from "../i18n/index.ts";

const NO_EVENTS: SessionEvent[] = [];

function ContextView() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const models = useStore((s) => s.models);
  const model = useActiveModel();
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  if (!session) return <div className="rail-empty">{tr("railsurfaces.sessionStatusUsageAndPinnedContextWill")}</div>;

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
  const descriptor = activeModel
    ? models.find((candidate) =>
        candidate.providerID === activeModel.providerID && candidate.modelID === activeModel.modelID)
    : undefined;
  const gauge = contextGauge(model, descriptor?.context);

  return (
    <div>
      <div className="stat-row">
        <span className="k">{tr("railsurfaces.status")}</span>
        <span className="status-line" style={{ padding: 0 }}>
          <span className={`dot ${session.status}`} />
          <span>{session.status}</span>
        </span>
      </div>
      <div className="stat-row">
        <span className="k">{tr("railsurfaces.model")}</span>
        <span>{session.model ? `${session.model.providerID}/${session.model.modelID}` : "—"}</span>
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
          {gauge.known
            ? `${fmtTokens(gauge.inputTokens)} / ${fmtTokens(gauge.contextTokens)} (${gauge.percent}%)`
            : tr("railsurfaces.unknown")}
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
      {!gauge.known && <div className="muted context-estimate-note">{tr("railsurfaces.modelContextMetadataIsUnavailable")}</div>}
      <div className="stat-row">
        <span className="k">{tr("railsurfaces.cost")}</span>
        <span className="mono">{model.totals.cost > 0 ? fmtCost(model.totals.cost) : "—"}</span>
      </div>
      <div className="stat-label">{tr("railsurfaces.pinned")}</div>
      {pinnedMessages.length === 0 && <div className="muted" style={{ fontSize: "calc(12.5px * var(--ui-font-scale, 1))" }}>{tr("railsurfaces.nothingPinnedYet")}</div>}
      {pinnedMessages.map((event) => (
        <div key={event.seq} className="pinned-file">
          <span className="mono">#{event.seq}</span>{" "}
          {String((event.data as Record<string, unknown>).text ?? "").slice(0, 120)}
        </div>
      ))}
    </div>
  );
}

function UsagePanel() {
  const model = useActiveModel();
  const total = model.totals.input + model.totals.output;
  return (
    <div>
      <div className="stat-row"><span className="k">{tr("railsurfaces.input")}</span><span className="mono">{fmtTokens(model.totals.input)}</span></div>
      <div className="stat-row"><span className="k">{tr("railsurfaces.output")}</span><span className="mono">{fmtTokens(model.totals.output)}</span></div>
      <div className="stat-row"><span className="k">{tr("railsurfaces.total")}</span><span className="mono">{fmtTokens(total)}</span></div>
      <div className="stat-row"><span className="k">{tr("railsurfaces.cost")}</span><span className="mono">{model.totals.cost > 0 ? fmtCost(model.totals.cost) : "—"}</span></div>
      {total === 0 && <div className="rail-empty">{tr("railsurfaces.tokenAndCostTotalsAppearOnceThe")}</div>}
    </div>
  );
}

function ActiveEventsView() {
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  if (events.length === 0) return <div className="empty">{tr("railsurfaces.noEventsYet")}</div>;
  return (
    <div className="event-list">
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

// Canonical workspace surfaces (spec starting values). Layout policy lives in
// the host; these components never decide dock versus full-screen geometry.
const pane = (over: Partial<WorkspacePanePresentation>): WorkspacePanePresentation => ({
  kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760,
  keepAlive: true, escape: "close", ...over,
});

function EventsView(props?: RailSurfaceComponentProps) {
  return props?.active !== false ? <ActiveEventsView /> : null;
}

registerSurface({
  id: "files", title: tr("railsurfaces.projectFiles"), capabilityId: "files", order: 1, icon: RAIL_ICONS.files,
  component: EditorView, presentation: pane({ defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760 }),
});
registerSurface({
  id: "git", title: tr("railsurfaces.sourceControl"), capabilityId: "git", order: 2, icon: RAIL_ICONS.git,
  component: GitView, badge: (ctx) => ctx.changeCount,
  presentation: pane({ defaultRatio: 0.4, minWidth: 340, preferredMaxWidth: 640 }),
});
registerSurface({
  id: "terminal", title: tr("railsurfaces.terminal"), capabilityId: "terminal", order: 3, icon: RAIL_ICONS.terminal,
  component: TerminalView,
  presentation: pane({ defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, escape: "content" }),
});
registerSurface({
  id: "browser", title: tr("railsurfaces.browser"), capabilityId: "browser", order: 4, icon: RAIL_ICONS.browser,
  component: PreviewView, presentation: pane({ defaultRatio: 0.45, minWidth: 380, preferredMaxWidth: 760 }),
});

registerSurface({ id: "context", title: tr("railsurfaces.context"), capabilityId: "context", order: 30, icon: RAIL_ICONS.context, component: ContextView });
registerSurface({ id: "knowledge", title: tr("railsurfaces.knowledge"), capabilityId: "knowledge", order: 40, icon: RAIL_ICONS.knowledge, component: KnowledgePanel });
registerSurface({
  id: "usage", title: tr("railsurfaces.usage"), capabilityId: "usage", order: 50, icon: RAIL_ICONS.usage,
  component: UsagePanel,
});
registerSurface({
  id: "events", title: tr("railsurfaces.events"), capabilityId: "events", order: 60, icon: RAIL_ICONS.events,
  component: EventsView, badge: (ctx) => ctx.eventCount,
});

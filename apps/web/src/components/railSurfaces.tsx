// F17: built-in right-rail surfaces. Each panel is a self-contained component
// (own hooks/state) registered into the surface registry — ContextRail renders
// whatever is registered and never enumerates panels itself. Importing this
// module registers the built-ins once.
import { useActiveModel, useStore } from "../store.ts";
import { fmtCost, fmtTokens } from "../format.ts";
import { Icon } from "../icons.tsx";
import type { SessionEvent } from "@polyth/contracts";
import { contextGauge } from "../reduce.ts";
import { registerSurface, type RailSurfaceComponentProps } from "../surfaces.ts";
import ChangesPanel from "./ChangesPanel.tsx";
import FilesPanel from "./FilesPanel.tsx";
import KnowledgePanel from "./KnowledgePanel.tsx";

const NO_EVENTS: SessionEvent[] = [];

function ContextView() {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const models = useStore((s) => s.models);
  const model = useActiveModel();
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  if (!session) return <div className="rail-empty">Session status, usage, and pinned context will appear here.</div>;

  // Pinned files = context/pinned minus context/unpinned (last event wins per path).
  const pinned = new Map<string, boolean>();
  for (const e of events) {
    if (e.type === "context/pinned") pinned.set(String((e.data as Record<string, unknown>).path ?? ""), true);
    if (e.type === "context/unpinned") pinned.set(String((e.data as Record<string, unknown>).path ?? ""), false);
  }
  const pinnedPaths = [...pinned.entries()].filter(([, v]) => v).map(([k]) => k);
  const activeModel = model.contextUsage?.model ?? model.turn?.model ?? session.model;
  const descriptor = activeModel
    ? models.find((candidate) =>
        candidate.providerID === activeModel.providerID && candidate.modelID === activeModel.modelID)
    : undefined;
  const gauge = contextGauge(model, descriptor?.context);

  return (
    <div>
      <div className="stat-row">
        <span className="k">Status</span>
        <span className="status-line" style={{ padding: 0 }}>
          <span className={`dot ${session.status}`} />
          <span>{session.status}</span>
        </span>
      </div>
      <div className="stat-row">
        <span className="k">Model</span>
        <span>{session.model ? `${session.model.providerID}/${session.model.modelID}` : "—"}</span>
      </div>
      <div className="stat-row">
        <span className="k">Agent</span>
        <span>{session.agent ?? "—"}</span>
      </div>
      <div className="stat-row">
        <span className="k">Tokens</span>
        <span className="mono">{fmtTokens(model.totals.input + model.totals.output)}</span>
      </div>
      <div className="stat-row context-estimate-row">
        <span className="k">Context estimate</span>
        <span className="mono">
          {gauge.known
            ? `${fmtTokens(gauge.inputTokens)} / ${fmtTokens(gauge.contextTokens)} (${gauge.percent}%)`
            : "Unknown"}
        </span>
      </div>
      <div
        className={`context-meter ${gauge.level}`}
        role="meter"
        aria-label={gauge.known ? `${gauge.percent}% context estimate` : "Context estimate unknown"}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(gauge.known ? { "aria-valuenow": gauge.percent } : {})}
      >
        <span style={{ width: `${gauge.known ? gauge.percent : 0}%` }} />
      </div>
      {!gauge.known && <div className="muted context-estimate-note">Model context metadata is unavailable.</div>}
      <div className="stat-row">
        <span className="k">Cost</span>
        <span className="mono">{model.totals.cost > 0 ? fmtCost(model.totals.cost) : "—"}</span>
      </div>
      <div className="stat-label">Pinned</div>
      {pinnedPaths.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>Nothing pinned yet.</div>}
      {pinnedPaths.map((p) => (
        <div key={p} className="pinned-file mono">{p}</div>
      ))}
    </div>
  );
}

function UsagePanel() {
  const model = useActiveModel();
  const total = model.totals.input + model.totals.output;
  return (
    <div>
      <div className="stat-row"><span className="k">Input</span><span className="mono">{fmtTokens(model.totals.input)}</span></div>
      <div className="stat-row"><span className="k">Output</span><span className="mono">{fmtTokens(model.totals.output)}</span></div>
      <div className="stat-row"><span className="k">Total</span><span className="mono">{fmtTokens(total)}</span></div>
      <div className="stat-row"><span className="k">Cost</span><span className="mono">{model.totals.cost > 0 ? fmtCost(model.totals.cost) : "—"}</span></div>
      {total === 0 && <div className="rail-empty">Token and cost totals appear once the session runs.</div>}
    </div>
  );
}

function ActiveEventsView() {
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  if (events.length === 0) return <div className="empty">No events yet.</div>;
  return (
    <div className="event-list">
      {[...events].reverse().map((e) => (
        <details key={e.id} className="event-row">
          <summary>
            <span className="e-seq">#{e.seq}</span>
            <span className="e-type">{e.type}</span>
            <span className="e-time">{new Date(e.time).toLocaleTimeString()}</span>
          </summary>
          <div className="event-json">
            <pre>{JSON.stringify(e, null, 2)}</pre>
          </div>
        </details>
      ))}
    </div>
  );
}

function EventsView({ active }: RailSurfaceComponentProps) {
  return active ? <ActiveEventsView /> : null;
}

registerSurface({ id: "files", title: "Files", plugin: "files", order: 10, icon: Icon.files, component: FilesPanel });
registerSurface({
  id: "changes", title: "Changes", plugin: "git", order: 20, icon: Icon.tree,
  component: ChangesPanel, badge: (ctx) => ctx.changeCount,
});
registerSurface({ id: "context", title: "Context", plugin: "context", order: 30, icon: Icon.context, component: ContextView });
registerSurface({ id: "knowledge", title: "Knowledge", plugin: "knowledge", order: 40, icon: Icon.book, component: KnowledgePanel });
registerSurface({
  id: "usage", title: "Usage", plugin: "usage", order: 50, icon: Icon.usage,
  component: UsagePanel,
  // content-driven (OC#2418): nothing to show until the session spends tokens
  visible: (ctx) => !ctx.hasSession || ctx.totalTokens > 0,
});
registerSurface({
  id: "events", title: "Events", plugin: "events", order: 60, icon: Icon.events,
  component: EventsView, badge: (ctx) => ctx.eventCount,
});

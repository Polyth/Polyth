import { Fragment, useState, type JSX } from "react";
import { renderSlot } from "../slots.ts";
import { useActiveModel, useStore, setActiveView, setOverlay, setRailPlugin, toggleRailPlugin, type AppView, type RailPlugin } from "../store.ts";
import { PLUGIN_LABELS, togglePlugin, usePrefs, type PluginId } from "../prefs.ts";
import { fmtCost, fmtTokens } from "../format.ts";
import { Icon } from "../icons.tsx";
import { useEscape } from "../useEscape.ts";
import type { SessionProjection } from "@polyth/contracts";
import ChangesPanel from "./ChangesPanel.tsx";
import FilesPanel from "./FilesPanel.tsx";
import KnowledgePanel from "./KnowledgePanel.tsx";
import { useGitStatus } from "../gitStatusStore.ts";
import { gitChangedFiles } from "../pendingChanges.ts";

// Rail panels toggled in place; each is backed by a plugin toggle.
const PANELS: Array<{ rail: RailPlugin; plugin: PluginId; label: string; icon: () => JSX.Element }> = [
  { rail: "files", plugin: "files", label: "Files", icon: Icon.files },
  { rail: "changes", plugin: "git", label: "Changes", icon: Icon.tree },
  { rail: "context", plugin: "context", label: "Context", icon: Icon.context },
  { rail: "knowledge", plugin: "knowledge", label: "Knowledge", icon: Icon.book },
  { rail: "usage", plugin: "usage", label: "Usage", icon: Icon.usage },
  { rail: "events", plugin: "events", label: "Events", icon: Icon.events },
];

// Full-view jumps that live on the strip when their plugin is on.
const JUMPS: Array<{ view: AppView; plugin: PluginId; label: string; shortLabel: string; icon: () => JSX.Element }> = [
  { view: "preview", plugin: "preview", label: "Preview", shortLabel: "Preview", icon: Icon.globe },
  { view: "multirun", plugin: "multirun", label: "Compare models", shortLabel: "Compare", icon: Icon.compare },
  { view: "fusion", plugin: "fusion", label: "Fuse models", shortLabel: "Fusion", icon: Icon.fuse },
  { view: "terminal", plugin: "terminal", label: "Terminal", shortLabel: "Terminal", icon: Icon.term },
  { view: "schedule", plugin: "schedule", label: "Scheduled prompts", shortLabel: "Schedule", icon: Icon.clock },
  { view: "github", plugin: "github", label: "GitHub", shortLabel: "GitHub", icon: Icon.github },
];

function ContextView({ session, model }: { session: SessionProjection | null; model: ReturnType<typeof useActiveModel> }) {
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  if (!session) return <div className="rail-empty">Session status, usage, and pinned context will appear here.</div>;

  // Pinned files = context/pinned minus context/unpinned (last event wins per path).
  const pinned = new Map<string, boolean>();
  for (const e of events) {
    if (e.type === "context/pinned") pinned.set(String((e.data as Record<string, unknown>).path ?? ""), true);
    if (e.type === "context/unpinned") pinned.set(String((e.data as Record<string, unknown>).path ?? ""), false);
  }
  const pinnedPaths = [...pinned.entries()].filter(([, v]) => v).map(([k]) => k);

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

function UsagePanel({ model }: { model: ReturnType<typeof useActiveModel> }) {
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

function EventsView({ events }: { events: readonly import("@polyth/contracts").SessionEvent[] }) {
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

const NO_EVENTS: never[] = [];

// Small count badge on strip buttons (UX-33).
function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span className="strip-badge">{n > 9 ? "9+" : n}</span>;
}

export default function ContextRail() {
  const rail = useStore((s) => s.railPlugin);
  const view = useStore((s) => s.activeView);
  const projectId = useStore((s) => s.activeProjectId);
  const prefs = usePrefs();
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const model = useActiveModel();
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);
  const [picker, setPicker] = useState(false);
  useEscape(picker, () => setPicker(false));

  const gitOn = prefs.plugins.includes("git");
  const gitStatus = useGitStatus(gitOn ? projectId : null, model.turn?.status === "working");
  const changeCount = gitStatus ? gitChangedFiles(gitStatus).length : 0;

  const panels = PANELS.filter((p) => prefs.plugins.includes(p.plugin));
  const jumps = JUMPS.filter((j) => prefs.plugins.includes(j.plugin));
  const open = panels.find((p) => p.rail === rail) ?? null;
  const togglable = (Object.keys(PLUGIN_LABELS) as PluginId[]).filter((id) => id !== "session");
  const slotTabs = renderSlot("contextRail.tabs", { tab: rail, onSelect: toggleRailPlugin });
  const badgeOf = (railId: RailPlugin): number =>
    railId === "changes" ? changeCount : railId === "events" ? events.length : 0;

  return (
    <aside className="railbar">
      {open && (
        <div className="rail">
          <div className="rail-head">
            <span className="rail-title">{open.label}</span>
            <span className="header-spacer" />
            <div className="rail-tabs">{slotTabs.map((n, i) => <Fragment key={i}>{n}</Fragment>)}</div>
            <button className="rail-toggle" onClick={() => setRailPlugin(null)} title="Close panel" aria-label="Close panel">»</button>
          </div>
          <div className="rail-body">
            {open.rail === "context" && <ContextView session={session} model={model} />}
            {open.rail === "usage" && <UsagePanel model={model} />}
            {open.rail === "events" && <EventsView events={events} />}
            {open.rail === "changes" && <ChangesPanel />}
            {open.rail === "files" && <FilesPanel />}
            {open.rail === "knowledge" && <KnowledgePanel />}
          </div>
        </div>
      )}
      <div className="rail-icon-col plugin-strip" aria-label="Workspace panels">
        {panels.map((p) => (
          <button
            key={p.rail}
            className={`rail-icon strip-btn ${rail === p.rail ? "active" : ""}`}
            title={p.label}
            aria-label={p.label}
            aria-pressed={rail === p.rail}
            onClick={() => toggleRailPlugin(p.rail)}
          >
            <p.icon />
            <span className="strip-label">{p.label}</span>
            <Badge n={badgeOf(p.rail)} />
          </button>
        ))}
        {jumps.length > 0 && <span className="strip-sep" />}
        {jumps.map((j) => (
          <button
            key={j.view}
            className={`rail-icon strip-btn ${view === j.view ? "active" : ""}`}
            title={j.label}
            aria-label={j.label}
            aria-pressed={view === j.view}
            onClick={() => setActiveView(j.view)}
          >
            <j.icon />
            <span className="strip-label">{j.shortLabel}</span>
          </button>
        ))}
        <span className="strip-spacer" />
        <button
          className="rail-icon strip-btn"
          title="Add or remove plugins"
          aria-label="Add or remove plugins"
          aria-expanded={picker}
          onClick={() => setPicker((v) => !v)}
        >
          <Icon.plus />
          <span className="strip-label">Plugins</span>
        </button>
        {picker && (
          <>
            <div className="menu-backdrop" onClick={() => setPicker(false)} />
            <div className="strip-picker" role="menu">
              <div className="strip-picker-label">Plugins</div>
              {togglable.map((id) => {
                const on = prefs.plugins.includes(id);
                return (
                  <button key={id} aria-pressed={on} onClick={() => togglePlugin(id)}>
                    <span className="strip-picker-check">{on ? "✓" : ""}</span>
                    {PLUGIN_LABELS[id]}
                  </button>
                );
              })}
              <button className="strip-picker-manage" onClick={() => { setPicker(false); setOverlay("settings"); }}>
                Manage in settings…
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

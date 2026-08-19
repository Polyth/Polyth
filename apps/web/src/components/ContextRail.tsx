import { useState, Fragment } from "react";
import { renderSlot, registerSlot } from "../slots.ts";
import { useActiveModel, useStore } from "../store.ts";
import { fmtCost, fmtTokens } from "../format.ts";
import type { SessionProjection } from "@polyth/contracts";
import ChangesPanel from "./ChangesPanel.tsx";
import FilesPanel from "./FilesPanel.tsx";

type TabId = "context" | "files" | "changes" | "events";

// Built-in tabs register into the contextRail.tabs slot — proves the
// extensibility path: a plugin adds a third tab via window.__polythSlots.
const TAB_ORDER: Array<[TabId, string, number]> = [
  ["context", "Context", 0],
  ["files", "Files", 10],
  ["changes", "Changes", 20],
  ["events", "Events", 30],
];
for (const [id, label, prio] of TAB_ORDER) {
  registerSlot("contextRail.tabs", `builtin.${id}`, (props) => {
    const tab = props.tab as TabId;
    const onSelect = props.onSelect as (t: TabId) => void;
    return (
      <button className={`tab ${tab === id ? "active" : ""}`} onClick={() => onSelect(id)}>
        {label}
      </button>
    );
  }, prio);
}

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

export default function ContextRail({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [tab, setTab] = useState<TabId>("context");
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const model = useActiveModel();
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? NO_EVENTS);

  if (!open) {
    return (
      <aside className="rail closed">
        <button className="rail-toggle" onClick={onToggle} title="Open context rail">«</button>
      </aside>
    );
  }

  const tabs = renderSlot("contextRail.tabs", { tab, onSelect: setTab });

  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="rail-tabs">{tabs.map((n, i) => <Fragment key={i}>{n}</Fragment>)}</div>
        <button className="rail-toggle" onClick={onToggle} title="Close context rail">»</button>
      </div>
      <div className="rail-body">
        {tab === "context" && <ContextView session={session} model={model} />}
        {tab === "events" && <EventsView events={events} />}
        {tab === "changes" && <ChangesPanel />}
        {tab === "files" && <FilesPanel />}
      </div>
    </aside>
  );
}

import { useState, Fragment } from "react";
import { renderSlot, registerSlot } from "../slots.ts";
import { useActiveModel, useStore } from "../store.ts";
import { fmtCost, fmtTokens } from "../format.ts";
import type { SessionProjection } from "@polyth/contracts";
import ChangesPanel from "./ChangesPanel.tsx";
import FilesPanel from "./FilesPanel.tsx";

type TabId = "activity" | "events" | "changes" | "files";

// Built-in tabs register into the contextRail.tabs slot — proves the
// extensibility path: a plugin adds a third tab via window.__polythSlots.
registerSlot("contextRail.tabs", "builtin.activity", (props) => {
  const tab = props.tab as TabId;
  const onSelect = props.onSelect as (t: TabId) => void;
  return (
    <button className={`tab ${tab === "activity" ? "active" : ""}`} onClick={() => onSelect("activity")}>
      Activity
    </button>
  );
}, 0);

registerSlot("contextRail.tabs", "builtin.events", (props) => {
  const tab = props.tab as TabId;
  const onSelect = props.onSelect as (t: TabId) => void;
  return (
    <button className={`tab ${tab === "events" ? "active" : ""}`} onClick={() => onSelect("events")}>
      Events
    </button>
  );
}, 10);

registerSlot("contextRail.tabs", "builtin.changes", (props) => {
  const tab = props.tab as TabId;
  const onSelect = props.onSelect as (t: TabId) => void;
  return (
    <button className={`tab ${tab === "changes" ? "active" : ""}`} onClick={() => onSelect("changes")}>
      Changes
    </button>
  );
}, 20);

registerSlot("contextRail.tabs", "builtin.files", (props) => {
  const tab = props.tab as TabId;
  const onSelect = props.onSelect as (t: TabId) => void;
  return (
    <button className={`tab ${tab === "files" ? "active" : ""}`} onClick={() => onSelect("files")}>
      Files
    </button>
  );
}, 30);

function ActivityView({ session, model }: { session: SessionProjection | null; model: ReturnType<typeof useActiveModel> }) {
  if (!session) return <div className="rail-empty">Session status, usage, and activity will appear here.</div>;
  const pendingPermissions = model.permissions.filter((p) => p.status === "pending").length;
  const pendingQuestions = model.questions.filter((q) => q.status === "pending").length;
  return (
    <div>
      <div className="stat-label">Session</div>
      <div className="status-line">
        <span className={`dot ${session?.status ?? "idle"}`} />
        <span>{session?.status ?? "—"}</span>
      </div>
      <div className="stat-label">Model / Agent</div>
      <div className="stat-row">
        <span className="k">model</span>
        <span>{session?.model ? `${session.model.providerID}/${session.model.modelID}` : "—"}</span>
      </div>
      <div className="stat-row">
        <span className="k">agent</span>
        <span>{session?.agent ?? "—"}</span>
      </div>
      <div className="stat-label">Tokens (usage/recorded)</div>
      <div className="stat-row">
        <span className="k">input</span>
        <span>{fmtTokens(model.totals.input)}</span>
      </div>
      <div className="stat-row">
        <span className="k">output</span>
        <span>{fmtTokens(model.totals.output)}</span>
      </div>
      <div className="stat-row">
        <span className="k">reasoning</span>
        <span>{fmtTokens(model.totals.reasoning)}</span>
      </div>
      <div className="stat-row">
        <span className="k">cost</span>
        <span>{model.totals.cost > 0 ? fmtCost(model.totals.cost) : "—"}</span>
      </div>
      <div className="stat-label">Pending</div>
      <div className="stat-row">
        <span className="k">permissions</span>
        <span>{pendingPermissions}</span>
      </div>
      <div className="stat-row">
        <span className="k">questions</span>
        <span>{pendingQuestions}</span>
      </div>
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
  const [tab, setTab] = useState<TabId>("activity");
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
        {tab === "activity" && <ActivityView session={session} model={model} />}
        {tab === "events" && <EventsView events={events} />}
        {tab === "changes" && <ChangesPanel />}
        {tab === "files" && <FilesPanel />}
      </div>
    </aside>
  );
}

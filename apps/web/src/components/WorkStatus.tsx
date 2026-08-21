// Work-status panel + floating tracker pills (WP8). The panel summarizes the
// session's live working state (usage, tasks, delegated agents); each section
// hides individually, and a hidden-everything panel always keeps a Restore
// affordance. Pills above the composer show only *active* trackers and jump
// to their section without moving the transcript.
import { useMemo } from "react";
import type { RenderModel } from "../reduce.ts";
import { setUiSettings, useUiSettings } from "../uiPrefs.ts";
import { fmtCost, fmtTokens } from "../format.ts";
import SlotHost from "./slots/SlotHost.ts";

const SECTIONS = ["usage", "tasks", "agents"] as const;
type SectionId = typeof SECTIONS[number];

const SECTION_LABEL: Record<SectionId, string> = {
  usage: "Usage",
  tasks: "Tasks",
  agents: "Delegated agents",
};

function scrollToSection(id: SectionId) {
  document.getElementById(`ws-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

export function TrackerPills({ model }: { model: RenderModel }) {
  const ui = useUiSettings();
  if (!ui.workStatusPanelEnabled) return null;
  const activeTask = model.tasks?.items.find((t) => t.status === "active");
  const runningAgents = model.subagents?.agents.filter((a) => a.status === "running") ?? [];
  if (!activeTask && runningAgents.length === 0) return null;
  const show = (id: SectionId) => {
    if (ui.workStatusHiddenSections.includes(id)) {
      setUiSettings({ workStatusHiddenSections: ui.workStatusHiddenSections.filter((s) => s !== id) });
    }
    // Defer until an un-hide re-render mounted the section.
    requestAnimationFrame(() => scrollToSection(id));
  };
  return (
    <div className="tracker-pills" aria-label="Active work trackers">
      {activeTask && (
        <button className="tracker-pill" title={activeTask.text} onClick={() => show("tasks")}>
          <span className="tracker-dot task" /> {activeTask.text.slice(0, 60)}
        </button>
      )}
      {runningAgents.map((a) => (
        <button key={a.sessionId} className="tracker-pill" title={a.currentTask ?? a.label} onClick={() => show("agents")}>
          <span className="tracker-dot agent" /> {a.label.slice(0, 40)}
        </button>
      ))}
    </div>
  );
}

export default function WorkStatus({ model }: { model: RenderModel }) {
  const ui = useUiSettings();
  const hidden = ui.workStatusHiddenSections;

  const visible = useMemo(
    () => SECTIONS.filter((s) => !hidden.includes(s)),
    [hidden],
  );

  if (!ui.workStatusPanelEnabled) return null;
  const hasContent =
    model.totals.input + model.totals.output > 0 || model.tasks !== null || model.subagents !== null;
  if (!hasContent) return null;

  const hide = (id: SectionId) => setUiSettings({ workStatusHiddenSections: [...hidden, id] });
  const restoreAll = () => setUiSettings({ workStatusHiddenSections: [] });

  if (visible.length === 0) {
    return (
      <div className="work-status all-hidden">
        <span className="muted">Work status sections hidden.</span>
        <button className="small-btn" onClick={restoreAll}>Restore sections</button>
      </div>
    );
  }

  return (
    <div className="work-status" aria-label="Work status">
      {visible.includes("usage") && (
        <section className="work-status-section" id="ws-usage">
          <header>
            <span>{SECTION_LABEL.usage}</span>
            <button className="ws-hide" title="Hide section" onClick={() => hide("usage")}>✕</button>
          </header>
          <div className="ws-body ws-usage">
            <span className="mono">{fmtTokens(model.totals.input + model.totals.output)} tokens</span>
            {model.totals.cost > 0 && <span className="mono">{fmtCost(model.totals.cost)}</span>}
            {model.turn?.status === "working" && <span className="tag">working</span>}
          </div>
        </section>
      )}
      {visible.includes("tasks") && model.tasks && (
        <section className="work-status-section" id="ws-tasks">
          <header>
            <span>{SECTION_LABEL.tasks} ({model.tasks.items.filter((t) => t.status === "done").length}/{model.tasks.items.length})</span>
            <button className="ws-hide" title="Hide section" onClick={() => hide("tasks")}>✕</button>
          </header>
          <div className="ws-body">
            {model.tasks.items.map((t) => (
              <div key={t.id} className={`ws-task ${t.status}`}>
                <span className="ws-task-mark">
                  {t.status === "done" ? "✓" : t.status === "active" ? "●" : t.status === "failed" ? "✗" : "○"}
                </span>
                <span className="ws-task-text">{t.text}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {visible.includes("agents") && model.subagents && model.subagents.agents.length > 0 && (
        <section className="work-status-section" id="ws-agents">
          <header>
            <span>{SECTION_LABEL.agents} ({model.subagents.agents.length})</span>
            <button className="ws-hide" title="Hide section" onClick={() => hide("agents")}>✕</button>
          </header>
          <div className="ws-body">
            {model.subagents.agents.map((a) => (
              <div key={a.sessionId} className={`ws-agent ${a.status}`}>
                <span className={`tracker-dot agent${a.status === "running" ? "" : " idle"}`} />
                <span className="ws-agent-label">{a.label}</span>
                <span className="tag">{a.status}</span>
                {a.currentTask && <span className="muted ws-agent-task">{a.currentTask}</span>}
              </div>
            ))}
          </div>
        </section>
      )}
      <SlotHost
        slot="workStatus.sections"
        context={{
          turnStatus: model.turn?.status ?? null,
          totals: model.totals,
          tasks: model.tasks,
          subagents: model.subagents,
        }}
      />
      {hidden.length > 0 && (
        <button className="ghost-link ws-restore" onClick={restoreAll}>Restore hidden sections →</button>
      )}
    </div>
  );
}

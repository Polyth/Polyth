import { useEffect, useMemo, useState } from "react";
import { api } from "@polyth/session/web-api";
import { displaySessionTitle } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { openSession } from "../../init.ts";
import { resolveSessionStatus } from "../../sessionStatus.ts";
import { setOverlay, setRailPlugin, setSidebarOpen, startNewSession, useActiveModel, useStore } from "../../store.ts";
import { firstUserTextCached } from "../../utils.ts";
import { useResolvedCapabilities } from "../../capabilities.ts";
import { railIconFor } from "../../railIcons.ts";
import { ClockIcon, ComposeIcon, IconButton, LayersIcon, MenuIcon } from "../ui/index.ts";
import Sheet, { SheetRow, SheetSection } from "./Sheet.tsx";

function TaskOverview({
  sessionId,
  fallbackBrief,
  activeTask,
  tasks,
  onClose,
}: {
  sessionId: string | undefined;
  fallbackBrief: string;
  activeTask: string | undefined;
  tasks: Array<{ id: string; text: string; status: "pending" | "active" | "done" | "failed" }>;
  onClose: () => void;
}) {
  const [brief, setBrief] = useState(fallbackBrief);

  useEffect(() => {
    setBrief(fallbackBrief);
    if (!sessionId) return;
    void api.taskBrief(sessionId).then(({ brief: next }) => {
      if (next) setBrief(next);
    }).catch(() => { /* The generated session title remains a useful fallback. */ });
  }, [fallbackBrief, sessionId]);

  return (
    <Sheet title={activeTask ? "Task in progress" : "Session overview"} size="tall" className="mobile-task-overview" onClose={onClose}>
      <div className="mobile-task-hero">
        <span className="mobile-task-eyebrow">{activeTask ? "Working on" : "Latest prompt"}</span>
        <strong>{activeTask ?? brief}</strong>
        {activeTask && <p>{brief}</p>}
      </div>
      <SheetSection title="Task list" count={tasks.length}>
        {tasks.length > 0 ? <ul className="mobile-task-list">
          {tasks.map((task) => <li key={task.id} className={task.status}>
            <span aria-hidden="true">{task.status === "done" ? "✓" : task.status === "failed" ? "×" : task.status === "active" ? "●" : "○"}</span>
            <span>{task.text}</span>
            {task.status === "active" && <small>In progress</small>}
          </li>)}
        </ul> : <p className="sheet-empty">No task list for this session yet.</p>}
      </SheetSection>
    </Sheet>
  );
}

function SessionSwitcher({ onClose }: { onClose: () => void }) {
  const sessions = useStore((state) => state.sessions);
  const events = useStore((state) => state.events);
  const activeSessionId = useStore((state) => state.activeSessionId);
  const [query, setQuery] = useState("");
  const items = useMemo(() => sessions
    .filter((session) => session.status !== "archived" && displaySessionTitle(session.title, session.id, firstUserTextCached(events[session.id]))
      .toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (b.lastTurnAt ?? b.updatedAt) - (a.lastTurnAt ?? a.updatedAt)), [events, query, sessions]);
  return (
    <Sheet title="Select a session" size="tall" className="mobile-session-switcher" onClose={onClose}
      search={{ value: query, onChange: setQuery, placeholder: "Search sessions...", role: "searchbox" }}>
      <SheetSection title="Recent">
        {items.map((session) => {
          const status = resolveSessionStatus(session);
          return <SheetRow key={session.id} title={displaySessionTitle(session.title, session.id, firstUserTextCached(events[session.id]))} meta={status.label}
            icon={<Icon.chat />} selected={session.id === activeSessionId} onClick={() => {
              void openSession(session.id);
              onClose();
            }} />;
        })}
        {items.length === 0 && <p className="sheet-empty">No matching sessions.</p>}
      </SheetSection>
    </Sheet>
  );
}

export function Tools({ onClose }: { onClose: () => void }) {
  const capabilities = useResolvedCapabilities().filter((capability) => capability.descriptor.available());
  const groups = [
    ["Workspace", capabilities.filter((capability) => ["files", "git", "terminal", "browser"].includes(capability.descriptor.id))],
    ["Agent", capabilities.filter((capability) => ["workflow", "commands", "knowledge"].includes(capability.descriptor.id))],
    ["System", capabilities.filter((capability) => !["session", "files", "git", "terminal", "browser", "workflow", "commands", "knowledge"].includes(capability.descriptor.id))],
  ] as const;
  return (
    <Sheet title="Tools" size="tall" className="mobile-tools-sheet" onClose={onClose}
      footer={<button className="mobile-surface-footer" onClick={() => { onClose(); setOverlay("settings"); }}><Icon.sliders /> Customize tools</button>}>
      {groups.map(([title, items]) => items.length > 0 && <SheetSection key={title} title={title}>
        {items.map((capability) => {
          const CapabilityIcon = railIconFor(capability.descriptor.id);
          return <SheetRow key={capability.descriptor.id} title={capability.descriptor.label}
          icon={<CapabilityIcon />} trailing={<span className="mobile-surface-chevron"><Icon.chevronRight /></span>}
          onClick={() => { setSidebarOpen(false); setRailPlugin(null); capability.descriptor.open(); onClose(); }} />;
        })}
      </SheetSection>)}
    </Sheet>
  );
}

/** Phone navigation is intentionally a small overlay, not a second application header. */
export default function MobileSessionHeader() {
  const projectId = useStore((state) => state.activeProjectId);
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const events = useStore((state) => state.events);
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const model = useActiveModel();
  const [surface, setSurface] = useState<"recents" | "task" | "tools" | null>(null);
  const title = session ? displaySessionTitle(session.title, session.id, firstUserTextCached(events[session.id])) : "New chat";
  const activeTask = model.tasks?.items.find((task) => task.status === "active");
  const taskLabel = activeTask?.text ?? title;
  return <>
    <div className="mobile-session-floats" aria-label="Workspace navigation">
      <div className="mobile-float-navigation">
        <IconButton icon={MenuIcon} label="Open navigation" size="lg" variant="quiet" aria-expanded={sidebarOpen} onClick={() => {
          setRailPlugin(null);
          setSidebarOpen(true);
        }} />
        <IconButton icon={ClockIcon} label="Recent sessions" size="lg" variant="quiet" aria-haspopup="dialog" aria-expanded={surface === "recents"} onClick={() => setSurface("recents")} />
      </div>
      <button className="mobile-session-selector" aria-label={`Open task overview, ${taskLabel}`} aria-haspopup="dialog" aria-expanded={surface === "task"} onClick={() => setSurface("task")}>
        {activeTask && <span className="mobile-task-status" aria-hidden="true" />}
        <span>{taskLabel}</span><Icon.chevronDown />
      </button>
      <div className="mobile-float-actions">
        <IconButton icon={ComposeIcon} label="New session" size="lg" variant="ghost" disabled={!projectId} onClick={() => projectId && startNewSession(projectId)} />
        <IconButton icon={LayersIcon} label="Open tools" size="lg" variant="ghost" aria-expanded={surface === "tools"} onClick={() => setSurface("tools")} />
      </div>
    </div>
    {surface === "recents" && <SessionSwitcher onClose={() => setSurface(null)} />}
    {surface === "task" && <TaskOverview sessionId={session?.id} fallbackBrief={title} activeTask={activeTask?.text} tasks={model.tasks?.items ?? []} onClose={() => setSurface(null)} />}
    {surface === "tools" && <Tools onClose={() => setSurface(null)} />}
  </>;
}

import { useMemo, useRef, useState } from "react";
import { displaySessionTitle } from "../format.ts";
import { openSession } from "../init.ts";
import { recentSessionsForIsland, sessionTitleOf } from "../mobileIsland.ts";
import { resolveSessionStatus } from "../sessionStatus.ts";
import { useActiveModel, useStore } from "../store.ts";
import { firstUserTextCached } from "../utils.ts";
import { Icon } from "../icons.tsx";
import { Popover } from "./ui/index.ts";

function TaskMark({ status }: { status: "pending" | "active" | "done" | "failed" }) {
  return <span className={`desktop-session-task-mark ${status}`} aria-hidden="true">
    {status === "done" ? "✓" : status === "failed" ? "×" : status === "active" ? "◌" : "○"}
  </span>;
}

/** Desktop counterpart to the phone session island: status at a glance, detail on demand. */
export default function DesktopSessionStatus() {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const sessions = useStore((state) => state.sessions);
  const events = useStore((state) => state.events);
  const activeSessionId = useStore((state) => state.activeSessionId);
  const session = sessions.find((item) => item.id === activeSessionId) ?? null;
  const model = useActiveModel();
  const recent = useMemo(() => recentSessionsForIsland(sessions, activeSessionId ?? undefined, 5), [sessions, activeSessionId]);
  if (!session) return null;

  const status = resolveSessionStatus(session);
  const title = displaySessionTitle(session.title, session.id, firstUserTextCached(events[session.id]));
  const tasks = model.tasks?.items ?? [];
  const completed = tasks.filter((task) => task.status === "done").length;

  return <div className="desktop-session-status">
    <button
      ref={anchorRef}
      type="button"
      className="desktop-session-status-trigger"
      aria-label={`Session status: ${status.label}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => setOpen((value) => !value)}
    >
      <span className={`desktop-session-status-dot ${status.kind}`} aria-hidden="true" />
      <span className="desktop-session-status-copy">{status.label}</span>
      <Icon.chevronDown />
    </button>
    <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="end" ariaLabel="Session overview">
      <div className="desktop-session-status-popover">
        <header>
          <span className={`desktop-session-status-dot ${status.kind}`} aria-hidden="true" />
          <div><strong>{title}</strong><small>{status.label}</small></div>
        </header>
        <section>
          <h3>Session tasks{tasks.length > 0 ? ` · ${completed}/${tasks.length}` : ""}</h3>
          {tasks.length > 0 ? <ul>{tasks.map((task) => <li key={task.id} className={task.status}><TaskMark status={task.status} /><span>{task.text}</span></li>)}</ul> : <p>No tasks yet.</p>}
        </section>
        <section>
          <h3>Recent sessions</h3>
          {recent.length > 0 ? <ul>{recent.map((item) => {
            const itemStatus = resolveSessionStatus(item);
            return <li key={item.id}><button type="button" onClick={() => { void openSession(item.id); setOpen(false); }}><span className={`desktop-session-status-dot ${itemStatus.kind}`} aria-hidden="true" /><span>{sessionTitleOf(item, events)}</span><small>{itemStatus.label}</small></button></li>;
          })}</ul> : <p>No recent sessions.</p>}
        </section>
      </div>
    </Popover>
  </div>;
}

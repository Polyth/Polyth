import { useEffect, useMemo, useRef, useState } from "react";
import { displaySessionTitle, titleFromPrompt } from "../format.ts";
import { openSession } from "../init.ts";
import { recentSessionsForIsland, sessionTitleOf } from "../mobileIsland.ts";
import { resolveSessionStatus } from "../sessionStatus.ts";
import { useActiveModel, useStore } from "../store.ts";
import { firstUserTextCached, lastUserTextCached } from "../utils.ts";
import { Icon } from "../icons.tsx";
import { nextSessionSwitcherIndex } from "../sessionSwitcher.ts";
import { Popover } from "./ui/index.ts";

const CYCLE_MS = 4000;

type SwitcherItem = { id: "session" | "task" | "intent"; text: string };

function TaskMark({ status }: { status: "pending" | "active" | "done" | "failed" }) {
  return <span className={`desktop-session-task-mark ${status}`} aria-hidden="true">
    {status === "done" ? "✓" : status === "failed" ? "×" : status === "active" ? "◌" : "○"}
  </span>;
}

/** The centered desktop session overview; it only rotates cached session data. */
export default function DesktopSessionStatus() {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const direction = useRef<1 | -1>(1);
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [index, setIndex] = useState(0);
  const sessions = useStore((state) => state.sessions);
  const events = useStore((state) => state.events);
  const activeSessionId = useStore((state) => state.activeSessionId);
  const session = sessions.find((item) => item.id === activeSessionId) ?? null;
  const model = useActiveModel();
  const recent = useMemo(() => recentSessionsForIsland(sessions, activeSessionId ?? undefined, 5), [sessions, activeSessionId]);
  const status = session ? resolveSessionStatus(session) : null;
  const title = session ? displaySessionTitle(session.title, session.id, firstUserTextCached(events[session.id])) : "";
  const activeTask = session ? model.tasks?.items.find((task) => task.status === "active") : undefined;
  const prompt = lastUserTextCached(session ? events[session.id] : undefined);
  const intent = prompt ? titleFromPrompt(prompt, 120) : undefined;
  const showContext = status?.kind !== "regular";
  const items: SwitcherItem[] = [
    { id: "session", text: title },
    ...(showContext && activeTask ? [{ id: "task" as const, text: activeTask.text }] : []),
    ...(showContext && intent ? [{ id: "intent" as const, text: intent }] : []),
  ];
  const key = items.map((item) => item.id).join(":");
  const visible = items[index] ?? items[0]!;

  useEffect(() => {
    direction.current = 1;
    setIndex(0);
  }, [key]);
  useEffect(() => {
    if (paused || open || items.length < 2 || typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setIndex((current) => {
      const [next, step] = nextSessionSwitcherIndex(current, direction.current, items.length);
      direction.current = step;
      return next;
    }), CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [paused, open, key, items.length]);

  if (!session || !status) return null;

  return <div className="desktop-session-status" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
    <button
      ref={anchorRef}
      type="button"
      className="desktop-session-status-trigger header-control"
      aria-label={`Session: ${title}. Status: ${status.label}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      title={status.label}
      onClick={() => setOpen((value) => !value)}
    >
      <span className={`desktop-session-status-dot ${status.kind}`} aria-hidden="true" />
      <span className="desktop-session-status-mask">
        <span className="desktop-session-status-copy" data-direction={direction.current > 0 ? "up" : "down"} key={`${visible.id}:${index}`}>
          {visible.id === "task" && <span aria-hidden="true"><Icon.target /></span>}
          {visible.id === "intent" && <span aria-hidden="true"><Icon.chat /></span>}
          <span>{visible.text}</span>
        </span>
      </span>
      <Icon.chevronDown />
    </button>
    <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="center" ariaLabel="Session overview">
      <div className="desktop-session-status-popover">
        <header>
          <span className={`desktop-session-status-dot ${status.kind}`} aria-hidden="true" />
          <div><strong>{title}</strong><small>{status.label}</small></div>
        </header>
        <section>
          <h3>Active task</h3>
          {activeTask ? <p>{activeTask.text}</p> : <p>No active task.</p>}
        </section>
        {prompt && <section><h3>Current intent</h3><p>{prompt}</p></section>}
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

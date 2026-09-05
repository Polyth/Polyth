import { useMemo, useRef, useState } from "react";
import { displaySessionTitle, fmtTokens } from "../format.ts";
import { openSession } from "../init.ts";
import { recentSessionsForIsland, sessionTitleOf } from "../mobileIsland.ts";
import { resolveSessionStatus } from "../sessionStatus.ts";
import { useActiveModel, useStore } from "../store.ts";
import { firstUserTextCached, lastUserTextCached } from "../utils.ts";
import { Icon } from "../icons.tsx";
import { Popover } from "./ui/index.ts";
import { contextGauge } from "../reduce.ts";
import { useUiSettings } from "../uiPrefs.ts";
import ContextIndicator from "./ContextIndicator.tsx";

/** The centered desktop session overview with a stable, readable title. */
export default function DesktopSessionStatus() {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const ui = useUiSettings();
  const sessions = useStore((state) => state.sessions);
  const events = useStore((state) => state.events);
  const models = useStore((state) => state.models);
  const activeSessionId = useStore((state) => state.activeSessionId);
  const session = sessions.find((item) => item.id === activeSessionId) ?? null;
  const model = useActiveModel();
  const recent = useMemo(() => recentSessionsForIsland(sessions, activeSessionId ?? undefined, 5), [sessions, activeSessionId]);
  const status = session ? resolveSessionStatus(session) : null;
  const title = session ? displaySessionTitle(session.title, session.id, firstUserTextCached(events[session.id])) : "";
  const activeTask = session ? model.tasks?.items.find((task) => task.status === "active") : undefined;
  const prompt = lastUserTextCached(session ? events[session.id] : undefined);
  const activeModel = model.contextUsage?.model ?? model.turn?.model ?? session?.model;
  const descriptor = activeModel ? models.find((item) => item.providerID === activeModel.providerID && item.modelID === activeModel.modelID) : undefined;
  const gauge = contextGauge(model, descriptor?.context);

  if (!session || !status) return null;

  return <div className="desktop-session-status">
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
      <ContextIndicator gauge={gauge} mode={ui.contextIndicatorMode} providerID={activeModel?.providerID} providerName={descriptor?.providerName} active={status.kind === "working"} />
      <span className="desktop-session-status-mask">
        <span className="desktop-session-status-copy"><span>{title}</span></span>
      </span>
      <Icon.chevronDown />
    </button>
    <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="center" ariaLabel="Session overview">
      <div className="desktop-session-status-popover">
        <header>
          <span className={`desktop-session-status-dot ${status.kind}`} aria-hidden="true" />
          <div><strong>{title}</strong><small>{status.label}</small></div>
        </header>
        <section className="session-context-details">
          <h3>Context{gauge.known ? ` · ${gauge.percent}%` : ""}</h3>
          <p>{gauge.known ? `${fmtTokens(gauge.inputTokens)} / ${fmtTokens(gauge.contextTokens)} tokens` : "Model context metadata is unavailable."}</p>
        </section>
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

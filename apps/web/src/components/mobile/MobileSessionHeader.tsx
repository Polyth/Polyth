import { useEffect, useMemo, useState } from "react";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { ago, displaySessionTitle } from "../../format.ts";
import { Icon } from "../../icons.tsx";
import { tr } from "../../i18n/index.ts";
import {
  buildIslandItems,
  eventsHaveCodeChanges,
  ISLAND_CYCLE_MS,
  notablePeers,
  promptExcerpt,
  recentSessionsForIsland,
  sessionTitleOf,
  type IslandItem,
  type IslandTask,
} from "../../mobileIsland.ts";
import { railIconFor } from "../../railIcons.ts";
import { resolveSessionStatus, type SessionRowStatus } from "../../sessionStatus.ts";
import { openSession, prefetchSessionTail } from "../../init.ts";
import { setOverlay, setRailPlugin, setSidebarOpen, startNewSession, useActiveModel, useStore } from "../../store.ts";
import { firstUserTextCached, lastUserTextCached } from "../../utils.ts";
import { useResolvedCapabilities } from "../../capabilities.ts";
import { ComposeIcon, IconButton, LayersIcon, MenuIcon } from "../ui/index.ts";
import Sheet, { SheetRow, SheetSection } from "./Sheet.tsx";

function motionOff(): boolean {
  if (typeof document !== "undefined") {
    if (document.body.dataset.desktopLowResource === "true") return true;
    if (document.documentElement.dataset.reduceAnimations === "true") return true;
  }
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useCyclingItem(items: IslandItem[]): IslandItem | undefined {
  const [index, setIndex] = useState(0);
  const key = items.map((item) => item.id).join("\0");
  useEffect(() => { setIndex(0); }, [key]);
  useEffect(() => {
    if (items.length <= 1 || motionOff()) return;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % items.length), ISLAND_CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [items.length, key]);
  if (items.length === 0) return undefined;
  return items[index % items.length];
}

function SessionLiveIcon({ status }: { status: SessionRowStatus }) {
  if (status.kind === "working") {
    return <span className="mobile-island-live working" title={status.label} aria-label={status.label} />;
  }
  if (status.kind === "needs-approval") {
    return <span className="mobile-island-live approval" title={status.label} aria-label={status.label} />;
  }
  if (status.kind === "needs-reply") {
    return <span className="mobile-island-live reply" title={status.label} aria-label={status.label} />;
  }
  if (status.kind === "failed") {
    return <span className="mobile-island-live failed" title={status.label} aria-label={status.label} />;
  }
  if (status.kind === "unread" || status.kind === "reconciling" || status.kind === "epoch-pending") {
    return <span className={`mobile-island-live ${status.kind}`} title={status.label} aria-label={status.label} />;
  }
  return <span className="mobile-island-live idle" title={status.label} aria-label={status.label} />;
}

function CodeChangedMark() {
  return (
    <span className="mobile-island-diff" title={tr("mobile.island.codeChanged")} aria-label={tr("mobile.island.codeChanged")}>
      <i className="add" /><i className="del" />
    </span>
  );
}

function PromptExcerpt({ text }: { text: string }) {
  const excerpt = promptExcerpt(text);
  const expandable = text.trim() !== excerpt;
  const [open, setOpen] = useState(false);
  return (
    <div className="mobile-island-prompt">
      <span className="mobile-island-prompt-label">{tr("mobile.island.prompt")}</span>
      <p className={open ? "full" : undefined}>{open ? text : excerpt}</p>
      {expandable && (
        <button type="button" className="mobile-island-prompt-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? tr("mobile.island.hideFullPrompt") : tr("mobile.island.showFullPrompt")}
        </button>
      )}
    </div>
  );
}

function TaskMark({ status }: { status: IslandTask["status"] }) {
  if (status === "done") return <span className="mobile-task-mark done" aria-hidden="true"><Icon.check /></span>;
  if (status === "failed") return <span className="mobile-task-mark failed" aria-hidden="true">×</span>;
  if (status === "active") return <span className="mobile-task-mark active" aria-hidden="true"><i /></span>;
  return <span className="mobile-task-mark pending" aria-hidden="true" />;
}

function IslandOverview({
  title,
  prompt,
  tasks,
  recent,
  events,
  onClose,
}: {
  title: string;
  prompt: string | undefined;
  tasks: IslandTask[];
  recent: SessionProjection[];
  events: Record<string, readonly SessionEvent[] | undefined>;
  onClose: () => void;
}) {
  return (
    <Sheet
      title={tr("mobile.island.overview")}
      origin="top"
      className="mobile-island-sheet"
      onClose={onClose}
    >
      <div className="mobile-island-now">
        <strong className="mobile-island-session">{title}</strong>
        {prompt
          ? <PromptExcerpt text={prompt} />
          : <p className="mobile-island-empty">{tr("mobile.island.noPrompt")}</p>}
      </div>
      <SheetSection title={tr("mobile.island.tasks")}>
        {tasks.length > 0 ? (
          <ul className="mobile-task-list">
            {tasks.map((task) => (
              <li key={task.id} className={task.status}>
                <TaskMark status={task.status} />
                <span className="mobile-task-text">{task.text}</span>
                {task.status === "active" && <small>{tr("mobile.island.inProgress")}</small>}
              </li>
            ))}
          </ul>
        ) : <p className="sheet-empty">{tr("mobile.island.noTasks")}</p>}
      </SheetSection>
      <SheetSection title={tr("mobile.island.recent")}>
        {recent.map((item) => {
          const status = resolveSessionStatus(item);
          const itemTitle = sessionTitleOf(item, events);
          return (
            <SheetRow
              key={item.id}
              title={itemTitle}
              meta={status.kind === "regular" ? ago(item.lastTurnAt ?? item.updatedAt) : status.label}
              icon={<SessionLiveIcon status={status} />}
              trailing={eventsHaveCodeChanges(events[item.id]) ? <CodeChangedMark /> : undefined}
              onClick={() => {
                void openSession(item.id);
                onClose();
              }}
            />
          );
        })}
        {recent.length === 0 && <p className="sheet-empty">{tr("mobile.island.noRecent")}</p>}
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
  const sessions = useStore((state) => state.sessions);
  const session = useStore((state) => state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const model = useActiveModel();
  const [surface, setSurface] = useState<"island" | "tools" | null>(null);
  const title = session
    ? displaySessionTitle(session.title, session.id, firstUserTextCached(events[session.id]))
    : tr("mobile.island.newChat");
  const prompt = lastUserTextCached(session ? events[session.id] : undefined);
  const labels = useMemo(() => ({
    task: tr("mobile.island.kindTask"),
    request: tr("mobile.island.kindRequest"),
    session: tr("mobile.island.kindSession"),
    peer: tr("mobile.island.kindPeer"),
    working: tr("mobile.island.working"),
    newChat: tr("mobile.island.newChat"),
  }), []);
  const peers = useMemo(
    () => notablePeers(sessions, session?.id, events),
    [sessions, session?.id, events],
  );
  const items = useMemo(() => buildIslandItems({
    sessionTitle: title,
    hasSession: session !== null,
    tasks: model.tasks?.items,
    permissions: model.permissions,
    questions: model.questions,
    secrets: model.secrets,
    peers,
    labels,
  }), [title, session, model.tasks, model.permissions, model.questions, model.secrets, peers, labels]);
  const visible = useCyclingItem(items);
  const recent = useMemo(
    () => recentSessionsForIsland(sessions, session?.id),
    [sessions, session?.id],
  );
  useEffect(() => {
    for (const peer of peers) prefetchSessionTail(peer.id);
    for (const item of recent) prefetchSessionTail(item.id);
  }, [peers, recent]);
  const islandLabel = visible ? `${visible.mark} · ${visible.text}` : title;

  return <>
    <div className="mobile-session-floats" aria-label="Workspace navigation">
      <div className="mobile-float-navigation">
        <IconButton icon={MenuIcon} label="Open navigation" size="lg" variant="quiet" aria-expanded={sidebarOpen} onClick={() => {
          setRailPlugin(null);
          setSidebarOpen(true);
        }} />
      </div>
      <button
        className="mobile-session-selector"
        data-kind={visible?.kind}
        data-live={visible?.live ? "true" : undefined}
        aria-label={tr("mobile.island.openOverview", { label: islandLabel })}
        aria-haspopup="dialog"
        aria-expanded={surface === "island"}
        onClick={() => setSurface("island")}
      >
        {visible?.live && <span className={`mobile-island-dot ${visible.tone ?? visible.kind}`} aria-hidden="true" />}
        {visible && <span className="mobile-island-kind">{visible.mark}</span>}
        <span className="mobile-island-text" key={visible?.id}>{visible?.text ?? title}</span>
        <Icon.chevronDown />
      </button>
      <div className="mobile-float-actions">
        <IconButton icon={ComposeIcon} label="New session" size="lg" variant="ghost" disabled={!projectId} onClick={() => projectId && startNewSession(projectId)} />
        <IconButton icon={LayersIcon} label="Open tools" size="lg" variant="ghost" aria-expanded={surface === "tools"} onClick={() => setSurface("tools")} />
      </div>
    </div>
    {surface === "island" && (
      <IslandOverview
        title={title}
        prompt={prompt}
        tasks={model.tasks?.items ?? []}
        recent={recent}
        events={events}
        onClose={() => setSurface(null)}
      />
    )}
    {surface === "tools" && <Tools onClose={() => setSurface(null)} />}
  </>;
}

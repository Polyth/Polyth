import {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
} from "react";
import type { ScheduleTaskDto } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { fmtSessionElapsed } from "../../../apps/web/src/format.ts";
import { tapFeedback } from "../../../apps/web/src/haptics.ts";
import {
  BotIcon, ChevronRightIcon, CopyIcon, DeleteIcon, EditIcon, Icon, Menu, MoreVerticalIcon, PauseIcon, PlayIcon,
  PlusIcon, SettingsIcon, ShieldAlertIcon, Spinner, StopIcon, SuccessIcon, type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import { AGENT_ICONS, AgentMark } from "./AgentGlyph.tsx";
import { conversationMenuEntries } from "./agentConversationsMenu.ts";
import type { AgentIconId } from "../src/agentPrompt.ts";
import { agentLive, isScheduledMessage, type AgentLive } from "./agentLive.ts";
import { statusLine } from "./agentText.ts";
import { useNow } from "./agentClock.ts";
import { useAgents } from "./agentsStore.ts";
import {
  AGENTS_PAGE_ID, agentName, deleteAgent, duplicateAgent, markAgentRead, openAgent, openAgentsHome,
  openNewAgent, pauseAgent, renameAgent, runAgent, stopAgent,
} from "./agentActions.ts";
import { isImeComposing } from "@polyth/web-sdk";

export interface AgentNavContext {
  projectId?: unknown;
  activeSessionId?: unknown;
  query?: unknown;
  attentionOnly?: unknown;
  /** Called after a row opens something, so a drawer gets out of the way. */
  onNavigate?: unknown;
  /** "phone": the phone navigator, whose rows have their own metrics. */
  surface?: unknown;
}

// ---- collapsed groups --------------------------------------------------------
// Presentation only: which projects show their agents folded. Kept on this
// device, never in history.

const COLLAPSED_KEY = "polyth.agents.navCollapsed.v1";
const collapseListeners = new Set<() => void>();
let collapsedCache: Readonly<Record<string, true>> | null = null;

function readCollapsed(): Readonly<Record<string, true>> {
  if (collapsedCache) return collapsedCache;
  let parsed: Record<string, true> = {};
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(COLLAPSED_KEY);
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (value && typeof value === "object") {
      for (const [key, flag] of Object.entries(value)) if (flag === true) parsed[key] = true;
    }
  } catch {
    parsed = {};
  }
  collapsedCache = parsed;
  return parsed;
}

function writeCollapsed(next: Record<string, true>): void {
  collapsedCache = next;
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* private mode keeps it in memory */ }
  for (const listener of [...collapseListeners]) listener();
}

/** Fold or unfold one project's agents; `everywhere` applies it to every
 *  project listed in the navigator. */
export function setAgentsCollapsed(projectIds: readonly string[], collapsed: boolean): void {
  const next: Record<string, true> = { ...readCollapsed() };
  for (const id of projectIds) {
    if (collapsed) next[id] = true;
    else delete next[id];
  }
  writeCollapsed(next);
}

function useCollapsed(projectId: string): boolean {
  return useSyncExternalStore(
    (listener) => { collapseListeners.add(listener); return () => collapseListeners.delete(listener); },
    () => readCollapsed()[projectId] === true,
    () => false,
  );
}

/** The next wake at a glance: "06:00" within a day, "Tue" within a week,
 *  "14 Oct" later. The row's tooltip says which day. */
function wakeLabel(at: number, now = Date.now()): string {
  const locale = getLocale();
  const date = new Date(at);
  if (at - now < 20 * 60 * 60_000) return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (at - now < 6 * 24 * 60 * 60_000) return date.toLocaleDateString(locale, { weekday: "short" });
  return date.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

// ---- one row -----------------------------------------------------------------

/** The leading mark: the agent's glyph, or its state when it has one — the
 *  same column and marks a chat row uses (spinner, shield, dot). */
function Lead({ agent, live }: { agent: ScheduleTaskDto; live: AgentLive }) {
  switch (live.phase) {
    case "needs-you":
    case "review":
      return <span className="agent-nav-mark" data-mark="attention"><Icon icon={ShieldAlertIcon} size="sm" /></span>;
    case "stopped":
      return <span className="agent-nav-mark" data-mark="stopped">!</span>;
    case "working":
      // Its own glyph, with an arc travelling round it: who is at work.
      return <AgentMark icon={agent.icon} color={agent.color} working size="sm" />;
    case "alert":
      return <span className="agent-nav-dot" data-tone="alert" />;
    case "unread":
      return <span className="agent-nav-dot" />;
    default: {
      const glyph = AGENT_ICONS[agent.icon as AgentIconId] ?? BotIcon;
      return <span className="agent-nav-glyph" data-color={agent.color ?? "neutral"}><Icon icon={glyph} size="sm" /></span>;
    }
  }
}

/** The trailing measure: how long it has worked, or when it wakes next. */
function Meta({ live, now }: { live: AgentLive; now: number }) {
  if (live.phase === "working" && live.running) {
    return <span className="agent-nav-meta">{fmtSessionElapsed(now - live.running.startedAt)}</span>;
  }
  if (live.phase === "paused") return <span className="agent-nav-meta">{tr("agents.statePaused")}</span>;
  if (live.phase === "draft") return <span className="agent-nav-meta">{tr("agents.stateDraft")}</span>;
  if (live.phase === "idle" && live.nextWake) {
    return <span className="agent-nav-meta">{wakeLabel(live.nextWake.at)}</span>;
  }
  return null;
}

function AgentRow({ host, agent, live, active, onNavigate }: {
  host: WebPackageHost;
  agent: ScheduleTaskDto;
  live: AgentLive;
  active: boolean;
  onNavigate?: () => void;
}) {
  const name = agentName(agent);
  const repository = agent.source === "loop-file";
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuReturnRef = useRef<HTMLElement | null>(null);
  const longPress = useRef<{ timer: ReturnType<typeof setTimeout> | null; opened: boolean }>({ timer: null, opened: false });
  const now = useNow(live.phase === "working");

  useEffect(() => () => { if (longPress.current.timer) clearTimeout(longPress.current.timer); }, []);

  const open = (): void => {
    if (openAgent(host, agent)) onNavigate?.();
  };
  const openFromRow = (): void => {
    menuReturnRef.current = buttonRef.current;
    setMenuOpen(true);
  };
  const cancelLongPress = (): void => {
    if (longPress.current.timer) clearTimeout(longPress.current.timer);
    longPress.current.timer = null;
  };
  const startLongPress = (): void => {
    cancelLongPress();
    longPress.current.opened = false;
    longPress.current.timer = setTimeout(() => {
      longPress.current.timer = null;
      longPress.current.opened = true;
      tapFeedback();
      openFromRow();
    }, 550);
  };
  const commitRename = (): void => {
    setRenaming(false);
    void renameAgent(agent, draftName);
  };

  const running = live.running !== undefined;
  const paused = !agent.enabled;
  const entries: MenuEntry[] = [
    running
      ? { id: "stop", label: tr("agents.stop"), icon: StopIcon, onSelect: () => void stopAgent(agent) }
      : { id: "run", label: tr("scheduleview.runNow"), icon: PlayIcon, disabled: live.phase === "review", onSelect: () => void runAgent(agent) },
    ...(live.phase === "review" || live.phase === "draft" ? [] : [paused
      ? { id: "resume", label: tr("agents.resume"), icon: PlayIcon, onSelect: () => void pauseAgent(agent, false) } satisfies MenuEntry
      : { id: "pause", label: tr("agents.pauseWakes"), icon: PauseIcon, onSelect: () => void pauseAgent(agent, true) } satisfies MenuEntry]),
    ...(live.unread > 0 ? [{ id: "read", label: tr("agents.markRead"), icon: SuccessIcon, onSelect: () => void markAgentRead(agent) } satisfies MenuEntry] : []),
    "separator",
    ...(repository ? [] : [{
      id: "rename",
      label: tr("common.rename"),
      icon: EditIcon,
      onSelect: () => { setDraftName(name); setRenaming(true); },
    } satisfies MenuEntry]),
    ...conversationMenuEntries(host, agent, onNavigate),
    { id: "settings", label: tr("agents.settings"), icon: SettingsIcon, onSelect: () => { if (openAgent(host, agent, "settings")) onNavigate?.(); } },
    ...(repository ? [] : [
      {
        id: "duplicate",
        label: tr("scheduleview.duplicate"),
        icon: CopyIcon,
        onSelect: () => void duplicateAgent(agent).then((copy) => { if (copy && openAgent(host, copy, "settings")) onNavigate?.(); }),
      } satisfies MenuEntry,
      "separator" as const,
      { id: "delete", label: tr("agents.deleteAgent"), icon: DeleteIcon, danger: true, onSelect: () => void deleteAgent(agent) } satisfies MenuEntry,
    ]),
  ];
  const actionsLabel = tr("agents.actionsForValue", { name });

  return (
    <div
      className={`agent-nav-row${active ? " active" : ""}${live.unread ? " unread" : ""}${menuOpen ? " menu-open" : ""}`}
      data-phase={live.phase}
      data-paused={paused || undefined}
      onContextMenu={(event: ReactMouseEvent) => {
        if (renaming) return;
        event.preventDefault();
        openFromRow();
      }}
    >
      {renaming ? (
        <input
          className="agent-nav-rename"
          // A rename the person just asked for: the field is where they type.
          ref={(node) => { if (node && document.activeElement !== node) { node.focus(); node.select(); } }}
          value={draftName}
          aria-label={tr("common.rename")}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (isImeComposing(event)) return;
            if (event.key === "Enter") { event.preventDefault(); commitRename(); }
            else if (event.key === "Escape") { event.preventDefault(); setRenaming(false); }
          }}
        />
      ) : (
        <button
          ref={buttonRef}
          type="button"
          className="agent-nav-btn"
          aria-label={tr("agents.navOpenValue", { name })}
          aria-current={active ? "page" : undefined}
          title={`${name} · ${statusLine(agent, live)}`}
          onClick={(event) => {
            if (longPress.current.opened) {
              event.preventDefault();
              longPress.current.opened = false;
              return;
            }
            open();
          }}
          onDoubleClick={() => { if (!repository) { setDraftName(name); setRenaming(true); } }}
          onTouchStart={startLongPress}
          onTouchEnd={cancelLongPress}
          onTouchCancel={cancelLongPress}
          onTouchMove={cancelLongPress}
          onKeyDown={(event) => {
            if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
              event.preventDefault();
              openFromRow();
            } else if (event.key === "F2" && !repository) {
              event.preventDefault();
              setDraftName(name);
              setRenaming(true);
            }
          }}
        >
          <span className="agent-nav-lead" aria-hidden="true"><Lead agent={agent} live={live} /></span>
          {/* A name in the other script direction truncates at its own end. */}
          <span className="agent-nav-title" dir="auto">{name}</span>
          <Meta live={live} now={now} />
        </button>
      )}
      {!renaming && (
        <Menu
          label={actionsLabel}
          title={name}
          align="end"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          returnFocusRef={menuReturnRef}
          entries={entries}
        >
          {(trigger) => (
            <button
              {...trigger}
              type="button"
              className="agent-nav-more"
              title={actionsLabel}
              aria-label={actionsLabel}
              onClick={() => {
                menuReturnRef.current = null;
                trigger.onClick();
              }}
            >
              <Icon icon={MoreVerticalIcon} size="sm" />
            </button>
          )}
        </Menu>
      )}
    </div>
  );
}

// ---- the group ---------------------------------------------------------------

/** Folded, the group still says what matters: who waits for you, who works,
 *  who has news. */
function FoldedSummary({ rows }: { rows: ReadonlyArray<{ live: AgentLive }> }) {
  const waiting = rows.filter(({ live }) => live.phase === "needs-you" || live.phase === "review").length;
  const stopped = rows.filter(({ live }) => live.phase === "stopped").length;
  const working = rows.some(({ live }) => live.phase === "working");
  const unread = rows.filter(({ live }) => live.unread > 0).length;
  // An unread alert colours the news, as it does its own row.
  const alert = rows.some(({ live }) => live.unreadAlerts > 0);
  const parts = [
    waiting ? tr("agents.navNeedsYouValue", { count: waiting }) : "",
    stopped ? tr("agents.navStoppedValue", { count: stopped }) : "",
    working ? tr("agents.workingNow") : "",
    unread ? tr("agents.navNewValue", { count: unread }) : "",
  ].filter(Boolean);
  if (!parts.length) {
    return <span className="agent-nav-count">{rows.length.toLocaleString(getLocale())}</span>;
  }
  return (
    <span className="agent-nav-summary" title={parts.join(" · ")}>
      {waiting > 0 && <span className="agent-nav-mark" data-mark="attention"><Icon icon={ShieldAlertIcon} size="sm" /></span>}
      {stopped > 0 && <span className="agent-nav-mark" data-mark="stopped">!</span>}
      {working && <Spinner size="sm" className="agent-nav-spinner" />}
      {unread > 0 && <span className="agent-nav-dot" data-tone={alert ? "alert" : undefined} />}
      <span className="sr-only">{parts.join(", ")}</span>
    </span>
  );
}

/** A project's agents, above its pinned chats. A row opens the agent's own
 *  page in place of Chat; the header folds the group away. */
export default function AgentNavSection({ host, context }: { host: WebPackageHost; context: AgentNavContext }) {
  const projectId = typeof context.projectId === "string" ? context.projectId : "";
  const query = typeof context.query === "string" ? context.query.trim().toLocaleLowerCase() : "";
  const attentionOnly = context.attentionOnly === true;
  const onNavigate = typeof context.onNavigate === "function" ? context.onNavigate as () => void : undefined;
  const phone = context.surface === "phone";
  const { agents } = useAgents();
  const collapsed = useCollapsed(projectId);
  const [menuOpen, setMenuOpen] = useState(false);
  const activePage = useSyncExternalStore(
    host.store.subscribe,
    () => host.store.getSnapshot().activePage ?? null,
    () => null,
  );
  const activeAgentId = activePage?.pageId === AGENTS_PAGE_ID ? activePage.resource : null;

  const all = useMemo(() => (agents ?? [])
    .filter((agent) => agent.projectId === projectId && !isScheduledMessage(agent))
    .sort((a, b) => a.createdAt - b.createdAt), [agents, projectId]);
  const rows = useMemo(() => all
    .filter((agent) => !query || agentName(agent).toLocaleLowerCase().includes(query))
    .map((agent) => ({ agent, live: agentLive(agent) }))
    .filter(({ live }) => !attentionOnly || ["needs-you", "working", "alert", "stopped", "review"].includes(live.phase)),
  [all, query, attentionOnly]);

  if (!rows.length) return null;
  // A search or the attention filter shows matches even in a folded group.
  const folded = collapsed && !query && !attentionOnly;
  const toggle = (everywhere: boolean): void => {
    const ids = everywhere ? [...new Set((agents ?? []).map((agent) => agent.projectId))] : [projectId];
    setAgentsCollapsed(ids, !collapsed);
  };
  const headerEntries: MenuEntry[] = [
    { id: "new", label: tr("agents.newAgent"), icon: PlusIcon, onSelect: () => { if (openNewAgent(host, projectId)) onNavigate?.(); } },
    { id: "home", label: tr("agents.allAgents"), icon: BotIcon, onSelect: () => { if (openAgentsHome(host)) onNavigate?.(); } },
    "separator",
    {
      id: "fold-all",
      label: collapsed ? tr("agents.expandEverywhere") : tr("agents.collapseEverywhere"),
      onSelect: () => toggle(true),
    },
  ];
  const groupLabel = tr("agents.navSection");

  return (
    <div
      className="agent-nav"
      role="group"
      aria-label={groupLabel}
      data-collapsed={folded || undefined}
      data-surface={phone ? "phone" : undefined}
    >
      <div
        className={`agent-nav-head${menuOpen ? " menu-open" : ""}`}
        onContextMenu={(event) => { event.preventDefault(); setMenuOpen(true); }}
      >
        <button
          type="button"
          className="agent-nav-toggle"
          aria-expanded={!folded}
          title={folded ? tr("agents.expandHint") : tr("agents.collapseHint")}
          onClick={(event) => toggle(event.altKey)}
          onKeyDown={(event) => {
            if ((event.key === "ArrowLeft" && !folded) || (event.key === "ArrowRight" && folded)) {
              event.preventDefault();
              toggle(false);
            }
          }}
        >
          <Icon icon={ChevronRightIcon} size="sm" className="agent-nav-chevron" />
          <span className="agent-nav-label">{groupLabel}</span>
          {folded && <FoldedSummary rows={rows} />}
        </button>
        <span className="agent-nav-head-actions">
          <Menu label={tr("agents.groupActions")} align="end" open={menuOpen} onOpenChange={setMenuOpen} entries={headerEntries}>
            {(trigger) => (
              <button
                {...trigger}
                type="button"
                className="agent-nav-head-action"
                aria-label={tr("agents.groupActions")}
                title={tr("agents.groupActions")}
              >
                <Icon icon={MoreVerticalIcon} size="sm" />
              </button>
            )}
          </Menu>
        </span>
      </div>
      {!folded && (
        <div className="agent-nav-rows">
          {rows.map(({ agent, live }) => (
            <AgentRow
              key={agent.id}
              host={host}
              agent={agent}
              live={live}
              active={activeAgentId === agent.id}
              {...(onNavigate ? { onNavigate } : {})}
            />
          ))}
        </div>
      )}
    </div>
  );
}

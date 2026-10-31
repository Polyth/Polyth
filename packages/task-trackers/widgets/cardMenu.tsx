import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import type {
  SessionProjection,
  TaskTrackerColumnDto,
  TaskTrackerTaskDto,
} from "@polyth/contracts";
import {
  ArchiveIcon,
  BoardViewIcon,
  ChatIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DeleteIcon,
  DockSideIcon,
  EditIcon,
  ExternalLinkIcon,
  Icon,
  LinkIcon,
  Menu,
  NewChatIcon,
  SendIcon,
  TasksIcon,
  type LucideIcon,
} from "../../../apps/web/src/components/ui/index.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import { copyText } from "../../../apps/web/src/utils.ts";
import { PROVIDER_LABELS } from "./brand.tsx";
import { tt } from "./i18n.ts";
import type { TaskTrackerTaskLinkDto } from "../src/types.ts";

/**
 * Right-click (long-press on touch, Shift+F10 / the Menu key) menu for one
 * task card. Submenus drill in place inside the same anchored menu: Move to
 * lists the board's columns, Sessions lists the sessions this task can go to,
 * and each session opens its quick actions.
 */

const LONG_PRESS_MS = 550;
/** Sessions offered besides the linked ones and the open one. */
const RECENT_SESSIONS = 8;
const ACTIVE = new Set(["working", "waiting", "reconciling", "epoch-pending"]);

export interface TaskCardMenuOptions {
  /** The caller may change the tracker (link, move, start agents). */
  canWrite: boolean;
  /** Agent handoff is on. */
  handoff: boolean;
  /** Project new agent sessions start in. */
  projectId: string | null;
  /** The session the board is opened for. */
  sessionId: string | null;
  /** Columns a task can move to; null when moves are unavailable. */
  columns: readonly TaskTrackerColumnDto[] | null;
  /** Sessions this task was handed to. */
  links: readonly TaskTrackerTaskLinkDto[];
  /** The task is linked to `sessionId`. */
  linkedHere: boolean;
  onOpen: (task: TaskTrackerTaskDto) => void;
  /** Opens the details with the title and description in edit mode. */
  onEdit?: (task: TaskTrackerTaskDto) => void;
  onMove: (task: TaskTrackerTaskDto, column: TaskTrackerColumnDto) => void;
  onDispatch: (task: TaskTrackerTaskDto) => void;
  onLink: (task: TaskTrackerTaskDto, session: { id: string; title: string }, startAgent: boolean) => void;
  onOpenSession: (sessionId: string) => void;
  onPick: (task: TaskTrackerTaskDto) => void;
  /** Archive or delete the task in the tracker; the board confirms first. */
  onRemove: (task: TaskTrackerTaskDto, mode: "archive" | "delete") => void;
  onNotice: (text: string) => void;
}

/** Spread onto the card's button. `consumeClick` is true once for the click
 *  that ends a long-press, which must not also open the task. */
export interface TaskCardMenuBinding {
  ref: Ref<HTMLButtonElement>;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onTouchStart: () => void;
  onTouchEnd: () => void;
  onTouchMove: () => void;
  onTouchCancel: () => void;
  consumeClick: () => boolean;
}

type View =
  | { kind: "root" }
  | { kind: "move" }
  | { kind: "sessions" }
  | { kind: "session"; id: string; title: string };

interface SessionChoice {
  id: string;
  title: string;
  status: string;
  linked: boolean;
  current: boolean;
}

/** Linked sessions first, then the open one, then the project's most recent
 *  chats. Archived, package-owned and delegated sessions are left out. */
export function sessionChoices(
  sessions: readonly SessionProjection[],
  options: Pick<TaskCardMenuOptions, "links" | "linkedHere" | "projectId" | "sessionId">,
): SessionChoice[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const linkedIds = new Set(options.links.map((link) => link.sessionId));
  if (options.sessionId && options.linkedHere) linkedIds.add(options.sessionId);
  const choice = (id: string, fallback: string): SessionChoice => {
    const session = byId.get(id);
    return {
      id,
      title: session?.title || fallback,
      status: session?.status ?? "",
      linked: linkedIds.has(id),
      current: id === options.sessionId,
    };
  };
  const seen = new Set<string>();
  const out: SessionChoice[] = [];
  const add = (item: SessionChoice) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  };
  for (const link of options.links) add(choice(link.sessionId, link.taskKey));
  if (options.sessionId) add(choice(options.sessionId, tt("tasktrackers.menu.thisSession")));
  const recent = sessions
    .filter((session) => session.projectId === options.projectId
      && session.status !== "archived"
      && !session.purpose
      && !session.parentId
      && !seen.has(session.id))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, RECENT_SESSIONS);
  for (const session of recent) add(choice(session.id, tt("tasktrackers.menu.untitledSession")));
  return out;
}

function MenuRow({
  icon,
  label,
  detail,
  sheet,
  submenu = false,
  checked,
  disabled,
  danger = false,
  onSelect,
  children,
}: {
  icon?: LucideIcon;
  label: string;
  detail?: string;
  sheet: boolean;
  submenu?: boolean;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
  children?: ReactNode;
}) {
  const radio = checked !== undefined;
  return (
    <button
      type="button"
      role={sheet ? undefined : radio ? "menuitemradio" : "menuitem"}
      aria-checked={!sheet && radio ? checked : undefined}
      aria-haspopup={!sheet && submenu ? "menu" : undefined}
      data-submenu={submenu ? "true" : undefined}
      className={`${sheet ? "ui-menu-sheet-item" : "ui-menu-item"} tt-menu-row${checked ? " ui-menu-item--checked" : ""}${danger ? " ui-menu-item--danger" : ""}`}
      disabled={disabled}
      onClick={onSelect}
    >
      {children}
      {icon && <Icon icon={icon} size={sheet ? "lg" : "sm"} />}
      <span className="ui-menu-item-copy">
        <span className="ui-menu-item-label">{label}</span>
        {detail && <span className="ui-menu-item-detail">{detail}</span>}
      </span>
      {checked && <Icon icon={CheckIcon} size="sm" />}
      {submenu && <span className="tt-menu-chevron" aria-hidden="true"><Icon icon={ChevronRightIcon} size="sm" /></span>}
    </button>
  );
}

function SessionDot({ status }: { status: string }) {
  const tone = ACTIVE.has(status) ? "working" : status === "failed" ? "failed" : "idle";
  return <i className={`tt-menu-session-dot ${tone}`} aria-hidden="true" />;
}

function SessionsView({
  task,
  options,
  sheet,
  onChoose,
  onNewSession,
}: {
  task: TaskTrackerTaskDto;
  options: TaskCardMenuOptions;
  sheet: boolean;
  onChoose: (choice: SessionChoice) => void;
  onNewSession: () => void;
}) {
  const sessions = useStore((state) => state.sessions);
  const choices = sessionChoices(sessions, options);
  const linked = choices.filter((item) => item.linked);
  const others = choices.filter((item) => !item.linked);
  const row = (item: SessionChoice) => (
    <MenuRow
      key={item.id}
      sheet={sheet}
      submenu
      label={item.title}
      detail={item.current ? tt("tasktrackers.menu.thisSession") : ACTIVE.has(item.status) ? tt("tasktrackers.menu.agentWorking") : undefined}
      onSelect={() => onChoose(item)}
    >
      <SessionDot status={item.status} />
    </MenuRow>
  );
  return (
    <>
      {options.canWrite && options.handoff && (
        <MenuRow
          sheet={sheet}
          icon={NewChatIcon}
          label={tt("tasktrackers.menu.newSession")}
          detail={options.projectId ? tt("tasktrackers.menu.startAgentOnTask") : tt("tasktrackers.menu.openProjectFirst")}
          disabled={!options.projectId}
          onSelect={onNewSession}
        />
      )}
      {linked.length > 0 && <div className="ui-menu-heading" aria-hidden="true">{tt("tasktrackers.menu.workingOn", { key: task.key })}</div>}
      {linked.map(row)}
      {others.length > 0 && <div className="ui-menu-heading" aria-hidden="true">{tt("tasktrackers.menu.sessions")}</div>}
      {others.map(row)}
      {choices.length === 0 && <p className="tt-menu-empty">{tt("tasktrackers.menu.noSessions")}</p>}
    </>
  );
}

export function TaskCardMenu({
  task,
  options,
  disabled = false,
  children,
}: {
  task: TaskTrackerTaskDto;
  options: TaskCardMenuOptions;
  /** Select mode: a tap picks the card and no menu opens. */
  disabled?: boolean;
  children: (binding: TaskCardMenuBinding) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "root" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const cancelLongPress = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => () => cancelLongPress(), []);
  useEffect(() => {
    if (!open) return;
    // A left press anywhere outside the anchored menu closes it — also on the
    // card that opened it and inside the detail panel, which the shared menu
    // dismissal leaves alone. Capture phase, so a board handler that stops the
    // press can't keep the menu up. The phone sheet dismisses itself.
    const onPointer = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const surface = contentRef.current?.closest(".ui-menu");
      if (!surface || surface.contains(event.target as Node)) return;
      setOpen(false);
      setView({ kind: "root" });
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [open]);
  useEffect(() => {
    // A drill-in or back step moves focus to the new list's first item, as
    // opening the menu does.
    contentRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled), button:not(:disabled)')?.focus();
  }, [view]);

  const show = () => {
    if (disabled) return;
    setView({ kind: "root" });
    setOpen(true);
  };
  const binding: Omit<TaskCardMenuBinding, "ref"> = {
    onContextMenu: (event) => {
      if (disabled) return;
      event.preventDefault();
      show();
    },
    onKeyDown: (event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        if (disabled) return;
        event.preventDefault();
        show();
      }
    },
    onTouchStart: () => {
      cancelLongPress();
      longPressed.current = false;
      if (disabled) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        longPressed.current = true;
        show();
      }, LONG_PRESS_MS);
    },
    onTouchEnd: cancelLongPress,
    onTouchMove: cancelLongPress,
    onTouchCancel: cancelLongPress,
    consumeClick: () => {
      if (!longPressed.current) return false;
      longPressed.current = false;
      return true;
    },
  };

  const copy = async (text: string, what: string) => {
    options.onNotice(await copyText(text) ? tt("tasktrackers.menu.copied", { what }) : tt("tasktrackers.menu.clipboardUnavailable"));
  };
  const moves = options.canWrite ? options.columns : null;
  const tracker = PROVIDER_LABELS[task.provider];

  const content = ({ close, sheet }: { close: () => void; sheet: boolean }) => {
    const run = (action: () => void) => () => {
      close();
      action();
    };
    const back = (to: View, label: string) => (
      <MenuRow sheet={sheet} icon={ChevronLeftIcon} label={label} onSelect={() => setView(to)} />
    );
    let body: ReactNode;
    if (view.kind === "move" && moves) {
      body = (
        <>
          {back({ kind: "root" }, tt("tasktrackers.menu.moveTo"))}
          <div className="ui-separator ui-separator--horizontal" role="separator" />
          {moves.map((column) => (
            <MenuRow
              key={column.id}
              sheet={sheet}
              label={column.name}
              checked={column.statusIds.includes(task.status.id)}
              onSelect={run(() => {
                if (!column.statusIds.includes(task.status.id)) options.onMove(task, column);
              })}
            />
          ))}
        </>
      );
    } else if (view.kind === "sessions") {
      body = (
        <>
          {back({ kind: "root" }, tt("tasktrackers.menu.sessions"))}
          <div className="ui-separator ui-separator--horizontal" role="separator" />
          <SessionsView
            task={task}
            options={options}
            sheet={sheet}
            onChoose={(choice) => setView({ kind: "session", id: choice.id, title: choice.title })}
            onNewSession={run(() => options.onDispatch(task))}
          />
        </>
      );
    } else if (view.kind === "session") {
      const session = { id: view.id, title: view.title };
      const linked = options.links.some((link) => link.sessionId === view.id)
        || (view.id === options.sessionId && options.linkedHere);
      body = (
        <>
          {back({ kind: "sessions" }, view.title)}
          <div className="ui-separator ui-separator--horizontal" role="separator" />
          {options.canWrite && options.handoff && (
            <MenuRow
              sheet={sheet}
              icon={SendIcon}
              label={linked ? tt("tasktrackers.menu.startAgentHere") : tt("tasktrackers.menu.linkStart")}
              detail={tt("tasktrackers.menu.goesToSession", { key: task.key })}
              onSelect={run(() => options.onLink(task, session, true))}
            />
          )}
          {options.canWrite && !linked && (
            <MenuRow
              sheet={sheet}
              icon={LinkIcon}
              label={tt("tasktrackers.menu.linkOnly")}
              detail={tt("tasktrackers.menu.recordOnly")}
              onSelect={run(() => options.onLink(task, session, false))}
            />
          )}
          <MenuRow sheet={sheet} icon={ChatIcon} label={tt("tasktrackers.menu.openSession")} onSelect={run(() => options.onOpenSession(view.id))} />
        </>
      );
    } else {
      body = (
        <>
          <MenuRow sheet={sheet} icon={DockSideIcon} label={tt("tasktrackers.menu.openDetails")} onSelect={run(() => options.onOpen(task))} />
          {options.canWrite && options.onEdit && (
            <MenuRow sheet={sheet} icon={EditIcon} label={tt("tasktrackers.menu.editTitleDescription")} onSelect={run(() => options.onEdit!(task))} />
          )}
          {task.url && (
            <MenuRow
              sheet={sheet}
              icon={ExternalLinkIcon}
              label={tt("tasktrackers.menu.openIn", { tracker })}
              onSelect={run(() => window.open(task.url, "_blank", "noopener,noreferrer"))}
            />
          )}
          <MenuRow sheet={sheet} icon={CopyIcon} label={tt("tasktrackers.menu.copyKey", { key: task.key })} onSelect={run(() => void copy(task.key, task.key))} />
          {task.url && (
            <MenuRow sheet={sheet} icon={LinkIcon} label={tt("tasktrackers.menu.copyLink")} onSelect={run(() => void copy(task.url!, tt("tasktrackers.menu.copyLink")))} />
          )}
          {(moves?.length ?? 0) > 0 && (
            <>
              <div className="ui-separator ui-separator--horizontal" role="separator" />
              <MenuRow sheet={sheet} icon={BoardViewIcon} label={tt("tasktrackers.menu.moveTo")} submenu onSelect={() => setView({ kind: "move" })} />
            </>
          )}
          <div className="ui-separator ui-separator--horizontal" role="separator" />
          {options.canWrite && options.handoff && (
            <MenuRow
              sheet={sheet}
              icon={SendIcon}
              label={tt("tasktrackers.menu.startInNew")}
              disabled={!options.projectId}
              {...(!options.projectId ? { detail: tt("tasktrackers.menu.openProjectFirst") } : {})}
              onSelect={run(() => options.onDispatch(task))}
            />
          )}
          <MenuRow
            sheet={sheet}
            icon={ChatIcon}
            label={tt("tasktrackers.menu.sessions")}
            {...(options.links.length > 0 ? { detail: tt("tasktrackers.menu.workingCount", { count: options.links.length }) } : {})}
            submenu
            onSelect={() => setView({ kind: "sessions" })}
          />
          {options.canWrite && options.handoff && (
            <MenuRow sheet={sheet} icon={TasksIcon} label={tt("tasktrackers.menu.selectForAgents")} onSelect={run(() => options.onPick(task))} />
          )}
          {options.canWrite && (
            <>
              <div className="ui-separator ui-separator--horizontal" role="separator" />
              <MenuRow
                sheet={sheet}
                icon={ArchiveIcon}
                label={tt("tasktrackers.menu.archive")}
                detail={tt("tasktrackers.menu.restorableIn", { tracker })}
                onSelect={run(() => options.onRemove(task, "archive"))}
              />
              <MenuRow
                sheet={sheet}
                icon={DeleteIcon}
                label={tt("tasktrackers.menu.delete")}
                danger
                onSelect={run(() => options.onRemove(task, "delete"))}
              />
            </>
          )}
        </>
      );
    }
    return (
      <div
        ref={contentRef}
        className="tt-card-menu"
        data-view={view.kind}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            const target = event.target as HTMLElement;
            if (target.dataset.submenu === "true") {
              event.preventDefault();
              target.click();
            }
          } else if (event.key === "ArrowLeft" && view.kind !== "root") {
            event.preventDefault();
            setView(view.kind === "session" ? { kind: "sessions" } : { kind: "root" });
          }
        }}
      >
        {body}
      </div>
    );
  };

  return (
    <Menu
      label={tt("tasktrackers.menu.actions", { key: task.key })}
      title={tt("tasktrackers.menu.title", { key: task.key, title: task.title })}
      className="tt-card-menu-surface"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView({ kind: "root" });
      }}
      entries={[]}
      renderContent={content}
    >
      {(trigger) => children({ ...binding, ref: trigger.ref })}
    </Menu>
  );
}

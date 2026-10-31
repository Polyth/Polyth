import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  TaskTrackerAttachmentDto,
  TaskTrackerAttachmentInput,
  TaskTrackerBoardColumnsDto,
  TaskTrackerBoardDto,
  TaskTrackerColumnDto,
  TaskTrackerBoardType,
  TaskTrackerCommentDto,
  TaskTrackerProjectDto,
  TaskTrackerProvider,
  TaskTrackerProviderDto,
  TaskTrackerSessionTaskDto,
  TaskTrackerStatusCategory,
  TaskTrackerStatusDto,
  TaskTrackerTaskDto,
  TaskTrackerViewerDto,
} from "@polyth/contracts";
import {
  friendlyError,
  isImeComposing,
  type WebPackageHost,
  type WebUiPreferenceAdapter,
  type WidgetDefinition,
  type WidgetPlugin,
  type WidgetRenderContext,
  type WidgetSettingsContext,
} from "@polyth/web-sdk";
import { api } from "./api.ts";
import {
  boardsKey,
  cacheKey,
  columnsKey,
  dropCache,
  projectsKey,
  readCache,
  reviseCache,
  taskKey,
  tasksKey,
  viewerKey,
  writeCache,
} from "./cache.ts";
import { BoardComposer, BoardScopeDialog, projectNouns } from "./boards.tsx";
import { connectCopy, PROVIDER_LABELS, ProviderMark, providerNouns } from "./brand.tsx";
import type { TaskTrackersMessageKey } from "../src/i18n/en.ts";
import { TaskCardMenu, type TaskCardMenuBinding, type TaskCardMenuOptions } from "./cardMenu.tsx";
import { ConnectWizard } from "./connect.tsx";
import { isPendingColumn, KanbanBoard, kanbanLanes, PENDING_COLUMN_PREFIX } from "./kanban.tsx";
import { DisplayMenu, isListGrouping, PeopleFilter, type ListGrouping } from "./filters.tsx";
import { AvatarStack, PersonAvatar, PriorityGlyph } from "./glyphs.tsx";
import { listGroups, TaskList } from "./list.tsx";
import { widgetCopy } from "./management.tsx";
import { hasLocale, setTaskTrackersLocaleHost, tt, uiLocale } from "./i18n.ts";
import { TaskTrackerOverview } from "./overview.tsx";
import {
  BOARD_SCOPE_PREFERENCE,
  boardScopeAdapter,
  localBoardMemory,
  PROJECT_BOARD_SCOPE_PREFERENCE,
  projectBoardScopeAdapter,
  projectChangedAt,
  projectMemoryKey,
  projectTracker,
  providerScope,
  resolveBoard,
  resolveProject,
  useProviderScope,
  visibleBoards,
  visibleProjects,
} from "./scope.ts";
import {
  currentPreferences,
  loadManagement,
  managementSnapshot,
  setTaskTrackerHost,
  subscribeManagement,
  TASK_TRACKER_CHANGED,
  useManagement,
} from "./store.ts";
import {
  boardPeople,
  emptyAssigneeTitle,
  matchesAssignees,
  ME,
  normalizeAssignees,
  ownViewer,
  taskPeople,
} from "./people.ts";
import {
  TASK_TRACKER_PROVIDERS,
  type TaskTrackerTaskLinkDto,
  type TaskTrackerWidgetId,
} from "../src/types.ts";
import {
  AgentSessions,
  DispatchBar,
  dispatchTasks,
  openSession,
  hasComposerDraft,
  restoreFieldDraft,
  TaskComposer,
  takeFieldDraft,
  useActiveProjectId,
  useFieldDraft,
  useTaskLinks,
} from "./work.tsx";
import {
  AttachmentIcon,
  BoardViewIcon,
  Button,
  ChatIcon,
  CheckIcon,
  Checkbox,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  confirmAlert,
  Dialog,
  EditIcon,
  ExternalLinkIcon,
  FileIcon,
  IconButton,
  LinkIcon,
  ListViewIcon,
  PlusIcon,
  RefreshIcon,
  Select,
  type SelectOption,
  SendIcon,
  TextInput,
  Textarea,
  UploadIcon,
  ViewOptionsIcon,
} from "../../../apps/web/src/components/ui/index.ts";

type BoardView = "kanban" | "list";

type TaskTrackerIcons = Record<
  "check" | "close" | "external" | "filter" | "link" | "list" | "refresh" | "search" | "send" | "widgets",
  () => ReactNode
>;

const EmptyIcon = (): ReactNode => null;
let Icon: TaskTrackerIcons = {
  check: EmptyIcon,
  close: EmptyIcon,
  external: EmptyIcon,
  filter: EmptyIcon,
  link: EmptyIcon,
  list: EmptyIcon,
  refresh: EmptyIcon,
  search: EmptyIcon,
  send: EmptyIcon,
  widgets: EmptyIcon,
};
let formatError = friendlyError;

export function configureTaskTrackerHost(host: WebPackageHost): void {
  const icon = (name: keyof TaskTrackerIcons): (() => ReactNode) =>
    host.ui.icons[name] ?? EmptyIcon;
  Icon = {
    check: icon("check"),
    close: icon("close"),
    external: icon("external"),
    filter: icon("filter"),
    link: icon("link"),
    list: icon("list"),
    refresh: icon("refresh"),
    search: icon("search"),
    send: icon("send"),
    widgets: icon("widgets"),
  };
  formatError = host.errors.friendly;
  setTaskTrackersLocaleHost(host);
  setTaskTrackerHost(host);
  taskTrackerHostRef = host;
}

const CATEGORY_KEYS = {
  todo: "tasktrackers.kanban.category.todo",
  in_progress: "tasktrackers.kanban.category.inProgress",
  done: "tasktrackers.kanban.category.done",
  unknown: "tasktrackers.kanban.category.other",
} as const;

const categoryLabel = (category: TaskTrackerStatusCategory): string => tt(CATEGORY_KEYS[category]);

const CATEGORY_ORDER: Record<TaskTrackerStatusCategory, number> = {
  todo: 0,
  in_progress: 1,
  unknown: 2,
  done: 3,
};

const boardSettings = () => ({
  type: "object",
  properties: {
    defaultView: {
      type: "string",
      title: tt("tasktrackers.board.defaultView"),
      enum: ["kanban", "list"],
      default: "kanban",
    },
    hideCompleted: {
      type: "boolean",
      title: tt("tasktrackers.board.hideCompleted"),
      default: false,
    },
  },
}) as const;

const changed = (): void => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(TASK_TRACKER_CHANGED));
  }
};

const messageOf = (action: string, cause: unknown): string =>
  formatError(action, cause);

export const defaultViewForBoard = (type: TaskTrackerBoardType): BoardView =>
  type === "simple" || type === "unknown" ? "list" : "kanban";

/** Items with the same group next to each other, groups in first-seen order. */
function groupedBy<T>(items: readonly T[], groupOf: (item: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(groupOf(item), [...groups.get(groupOf(item)) ?? [], item]);
  return [...groups.values()].flat();
}

/** Keep the current reference when a refresh returns the same data, so a
 *  revalidation that changes nothing re-renders nothing. */
function keepIfSame<T>(current: T, next: T): T {
  if (current === next) return current;
  try {
    return JSON.stringify(current) === JSON.stringify(next) ? current : next;
  } catch {
    return next;
  }
}

export interface TaskStatusGroup {
  id: string;
  name: string;
  category: TaskTrackerStatusCategory;
  tasks: TaskTrackerTaskDto[];
}

export function groupTasksByStatus(tasks: readonly TaskTrackerTaskDto[]): TaskStatusGroup[] {
  const groups = new Map<string, TaskStatusGroup>();
  for (const task of tasks) {
    const key = `${task.status.category}:${task.status.id || task.status.name}`;
    const current = groups.get(key) ?? {
      id: key,
      name: task.status.name || categoryLabel(task.status.category),
      category: task.status.category,
      tasks: [],
    };
    current.tasks.push(task);
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) =>
    CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category]
    || left.name.localeCompare(right.name));
}

function providerMark(provider: TaskTrackerProvider): ReactNode {
  return <ProviderMark provider={provider} size="sm" />;
}

function StatusPill({ status }: { status: TaskTrackerStatusDto }) {
  return <span className={`tt-status ${status.category}`}>{status.name}</span>;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(dateString?: string): string {
  if (!dateString) return "";
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return dateString;
  const locale = uiLocale();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return tt("tasktrackers.board.justNow");
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return relative.format(-diffMin, "minute");
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return relative.format(-diffHours, "hour");
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return relative.format(-diffDays, "day");
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** A due date as the person's own calendar day. Jira and Linear send a bare
 *  date ("2026-10-20"), which `new Date` would read as UTC midnight and show
 *  as the day before west of UTC; it is that local day, until its end. */
function dueDate(value: string | undefined): Date | null {
  if (!value) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = day
    ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 59, 999)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dueLabel(value: string | undefined): string | null {
  return dueDate(value)?.toLocaleDateString(uiLocale(), { month: "short", day: "numeric" }) ?? null;
}

/** Attachments the board can show as pictures. */
export const imageAttachments = (task: TaskTrackerTaskDto): TaskTrackerAttachmentDto[] =>
  (task.attachments ?? []).filter((item) => item.mimeType.startsWith("image/") && Boolean(item.thumbnailUrl || item.url));

/** List responses carry only a comment total; the detail carries the comments. */
export const commentCountOf = (task: TaskTrackerTaskDto): number =>
  Math.max(task.comments?.length ?? 0, task.commentCount ?? 0);

/** The picture a card and its detail lead with: the tracker's chosen cover
 *  (Trello), else the first image, like Trello's automatic cover. */
export const coverImageOf = (task: TaskTrackerTaskDto): TaskTrackerAttachmentDto | undefined => {
  const images = imageAttachments(task);
  return images.find((item) => item.id === task.coverAttachmentId) ?? images[0];
};

/** Natural aspect ratios seen this document, so a card that re-renders (or a
 *  board that reopens) reserves the right height before the image decodes. */
const coverRatios = new Map<string, number>();

/** An attachment picture that falls back to a file glyph when the tracker
 *  refuses or no longer has the file. */
function AttachmentImage({
  src,
  alt,
  eager = false,
  onRatio,
}: {
  src: string | undefined;
  alt: string;
  eager?: boolean;
  onRatio?: (ratio: number) => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return <span className="tt-image-fallback" role="img" aria-label={alt}><FileIcon size={18} /></span>;
  }
  return (
    <img
      src={src}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      onLoad={onRatio ? (event) => {
        const image = event.currentTarget;
        if (image.naturalWidth > 0 && image.naturalHeight > 0) onRatio(image.naturalWidth / image.naturalHeight);
      } : undefined}
      onError={() => setFailed(true)}
    />
  );
}

/** Card cover: the picture's own shape (clamped so a panorama is not a
 *  sliver and a portrait does not swallow the column). */
function CardCover({ task }: { task: TaskTrackerTaskDto }) {
  const images = imageAttachments(task);
  const cover = coverImageOf(task);
  const src = cover ? cover.thumbnailUrl || cover.url : undefined;
  const [ratio, setRatio] = useState(() => (src && coverRatios.get(src)) || 0);
  if (!cover) return null;
  const remember = (value: number) => {
    const clamped = Math.min(2.4, Math.max(0.9, value));
    if (src) coverRatios.set(src, clamped);
    setRatio(clamped);
  };
  return (
    <span
      className={`tt-card-cover${ratio ? " sized" : ""}`}
      style={ratio ? { "--tt-cover-ratio": String(ratio) } as Record<string, string> : undefined}
    >
      <AttachmentImage src={src} alt={cover.name} onRatio={remember} />
      {images.length > 1 && (
        <span className="tt-card-cover-count" aria-label={tt("tasktrackers.board.imagesCount", { count: images.length })}>
          <AttachmentIcon size={11} /> {images.length}
        </span>
      )}
    </span>
  );
}

function MetaBadges({ task }: { task: TaskTrackerTaskDto }) {
  const attachmentCount = task.attachments?.length ?? 0;
  const commentCount = commentCountOf(task);
  return (
    <>
      {attachmentCount > 0 && (
        <span className="tt-meta-badge" title={tt("tasktrackers.board.attachmentsCount", { count: attachmentCount })}>
          <AttachmentIcon size={12} /> {attachmentCount}
        </span>
      )}
      {commentCount > 0 && (
        <span className="tt-meta-badge" title={tt("tasktrackers.board.commentsCount", { count: commentCount })}>
          <ChatIcon size={12} /> {commentCount}
        </span>
      )}
    </>
  );
}

/** Labels lead the card, as on a Trello card; three at most, then a count. */
function CardLabels({ task }: { task: TaskTrackerTaskDto }) {
  if (task.labels.length === 0) return null;
  const shown = task.labels.slice(0, 3);
  return (
    <span className="tt-card-labels">
      {shown.map((label) => <span className="tt-label" key={label} title={label}>{label}</span>)}
      {task.labels.length > shown.length && (
        <span className="tt-label more" title={task.labels.slice(shown.length).join(", ")}>+{task.labels.length - shown.length}</span>
      )}
    </span>
  );
}

/** Past due and not done: the date turns into a warning. */
const overdue = (task: TaskTrackerTaskDto): boolean => {
  if (task.status.category === "done") return false;
  const due = dueDate(task.dueAt);
  return due !== null && due.getTime() < Date.now();
};

/** The card's last row: priority, key, due date and counts; the people at
 *  the end. Items keep their size and the row wraps, so nothing overlaps. */
function TaskMeta({ task }: { task: TaskTrackerTaskDto }) {
  const due = dueLabel(task.dueAt);
  const late = overdue(task);
  return (
    <div className="tt-task-meta">
      <PriorityGlyph priority={task.priority} />
      <span className="tt-task-key">{task.key}</span>
      {due && <time className={`tt-due${late ? " overdue" : ""}`} dateTime={task.dueAt} title={late ? tt("tasktrackers.board.overdueSince", { date: due }) : tt("tasktrackers.board.due", { date: due })}>{due}</time>}
      <MetaBadges task={task} />
      {task.assignees.length > 0 && <span className="tt-assignees"><AvatarStack people={taskPeople(task)} /></span>}
    </div>
  );
}

/** Where focus goes back to after a task closes: its card or row, even when
 *  a status change moved it to another column or section meanwhile. */
const taskRef = (task: Pick<TaskTrackerTaskDto, "provider" | "id">): string => `${task.provider}:${task.id}`;

function AgentChip({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="tt-agent-chip" title={tt("tasktrackers.board.agentSessionsCount", { count })}>
      <Icon.send /> {count}
    </span>
  );
}

function PickMark({ picked }: { picked: boolean }) {
  return <span className={`tt-pick${picked ? " on" : ""}`} aria-hidden="true">{picked && <Icon.check />}</span>;
}

function ImageLightbox({
  attachment,
  allImages,
  onClose,
  onSelectImage,
}: {
  attachment: TaskTrackerAttachmentDto;
  allImages?: readonly TaskTrackerAttachmentDto[];
  onClose: () => void;
  onSelectImage?: (attachment: TaskTrackerAttachmentDto) => void;
}) {
  const images = allImages && allImages.length > 0 ? allImages : [attachment];
  const currentIndex = images.findIndex((img) => img.id === attachment.id);
  const index = currentIndex >= 0 ? currentIndex : 0;
  const current = images[index] ?? attachment;
  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;
  const overlayRef = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);

  // The viewer takes focus while it is open and hands it back on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayRef.current?.querySelector<HTMLElement>(`button[aria-label="${tt("tasktrackers.board.closePreview")}"]`)?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  useEffect(() => {
    // Captured first and stopped, so Escape closes only the preview and not
    // the task detail or window underneath it.
    const handleKeyDown = (event: KeyboardEvent) => {
      const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (event.key !== "Escape" && step === 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") onClose();
      else if (onSelectImage && images[index + step]) onSelectImage(images[index + step]!);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [index, images, onClose, onSelectImage]);

  // Portaled: the animated detail panel would otherwise contain the overlay.
  return createPortal(
    <div
      ref={overlayRef}
      className="tt-lightbox-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={tt("tasktrackers.board.preview", { name: current.name })}
      data-owns-swipe=""
      onClick={onClose}
      // A horizontal swipe pages through the images on touch screens.
      onPointerDown={(event) => {
        if (event.pointerType !== "mouse") swipe.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const start = swipe.current;
        swipe.current = null;
        if (!start || !onSelectImage) return;
        const dx = event.clientX - start.x;
        if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(event.clientY - start.y) * 1.5) return;
        const rtl = document.documentElement.dir === "rtl";
        const step = (dx < 0) !== rtl ? 1 : -1;
        const next = images[index + step];
        if (next) onSelectImage(next);
      }}
      onPointerCancel={() => { swipe.current = null; }}
    >
      <div className="tt-lightbox-content" onClick={(event) => event.stopPropagation()}>
        <header className="tt-lightbox-header">
          <div className="tt-lightbox-title">
            <span>{current.name}</span>
            {current.size ? <small>({formatBytes(current.size)})</small> : null}
          </div>
          <div className="tt-lightbox-actions">
            {current.url && (
              <a
                href={current.url}
                target="_blank"
                rel="noreferrer"
                className="tt-lightbox-button"
                title={tt("tasktrackers.board.openOriginal")}
                aria-label={tt("tasktrackers.board.openOriginal")}
              >
                <ExternalLinkIcon size={16} />
              </a>
            )}
            <IconButton icon={CloseIcon} size="sm" label={tt("tasktrackers.board.closePreview")} onClick={onClose} />
          </div>
        </header>
        <div className="tt-lightbox-image-wrap">
          {hasPrev && onSelectImage && (
            <button
              type="button"
              className="tt-lightbox-nav prev"
              aria-label={tt("tasktrackers.board.previousImage")}
              onClick={() => onSelectImage(images[index - 1]!)}
            >
              <ChevronLeftIcon size={24} />
            </button>
          )}
          <span className="tt-lightbox-image" key={current.id}>
            <AttachmentImage src={current.url || current.thumbnailUrl} alt={current.name} eager />
          </span>
          {hasNext && onSelectImage && (
            <button
              type="button"
              className="tt-lightbox-nav next"
              aria-label={tt("tasktrackers.board.nextImage")}
              onClick={() => onSelectImage(images[index + 1]!)}
            >
              <ChevronRightIcon size={24} />
            </button>
          )}
        </div>
        {images.length > 1 && (
          <footer className="tt-lightbox-footer">
            <span>{tt("tasktrackers.board.imageOf", { index: index + 1, total: images.length })}</span>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

function TaskCard({
  task,
  linked,
  selected,
  agents = 0,
  picking = false,
  picked = false,
  index = 0,
  showStatus = true,
  menu,
  onOpen,
}: {
  task: TaskTrackerTaskDto;
  linked: boolean;
  selected: boolean;
  agents?: number;
  picking?: boolean;
  picked?: boolean;
  index?: number;
  /** Off inside a kanban column, whose header already names the status. */
  showStatus?: boolean;
  /** Right-click / long-press menu wiring. */
  menu?: TaskCardMenuBinding;
  onOpen: (task: TaskTrackerTaskDto, trigger: HTMLElement) => void;
}) {
  const badges = linked || agents > 0 || picking;
  const { consumeClick, ...menuProps } = menu ?? {};
  const coverImage = coverImageOf(task);

  return (
    <button
      type="button"
      {...menuProps}
      data-task-ref={taskRef(task)}
      style={{ "--tt-i": Math.min(index, 12) } as Record<string, number>}
      className={`tt-task-card${linked ? " linked" : ""}${selected ? " selected" : ""}${picked ? " picked" : ""}${coverImage ? " has-cover" : ""}`}
      onClick={(event) => {
        if (consumeClick?.()) return;
        onOpen(task, event.currentTarget);
      }}
      aria-label={picking ? tt("tasktrackers.board.selectTask", { key: task.key, title: task.title }) : tt("tasktrackers.board.openTask", { key: task.key, title: task.title })}
      aria-pressed={picking ? picked : selected}
    >
      {/* Like Trello, the cover is part of the card: a click opens the task,
          whose detail leads with the same picture. */}
      <CardCover task={task} />
      {(showStatus || badges) && <span className="tt-card-top">
        {showStatus && <StatusPill status={task.status} />}
        {badges && <span className="tt-card-badges">
          {linked && <span className="tt-linked-chip"><Icon.link /> {tt("tasktrackers.board.linked")}</span>}
          <AgentChip count={agents} />
          {picking && <PickMark picked={picked} />}
        </span>}
      </span>}
      <CardLabels task={task} />
      <strong>{task.title}</strong>
      <TaskMeta task={task} />
    </button>
  );
}

function BoardEmpty({
  icon,
  title,
  body,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="tt-empty">
      <span className="tt-empty-icon">{icon}</span>
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
      {hint && <small className="tt-empty-hint">{hint}</small>}
    </div>
  );
}

type HandoffTarget = "new" | "current";

/** What the trackers accept as attachments (see `imageFiles` on the server). */
const ATTACHABLE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

/** A comment shown before the tracker has it; `failed` once it refused. */
interface PendingComment {
  key: string;
  taskId: string;
  text: string;
  failed: boolean;
}

const editDraftKey = (task: TaskTrackerTaskDto) => `edit:${task.provider}:${task.id}`;
const commentDraftKey = (task: TaskTrackerTaskDto) => `comment:${task.provider}:${task.id}`;
let pendingCommentSeq = 0;
let pendingColumnSeq = 0;

function TaskDetail({
  task,
  sessionId,
  projectId,
  linked,
  links,
  demo,
  loading,
  initialEditing = false,
  onClose,
  onTaskChanged,
  onTaskRevised,
  onBackgroundError,
}: {
  task: TaskTrackerTaskDto;
  sessionId: string | null;
  projectId: string | null;
  linked: boolean;
  links: readonly TaskTrackerTaskLinkDto[];
  demo: boolean;
  loading: boolean;
  initialEditing?: boolean;
  onClose: () => void;
  onTaskChanged: (task: TaskTrackerTaskDto, linked?: boolean) => void;
  /** Applies a change to the task wherever the board holds it, without
   *  reopening it: optimistic edits and their rollback. */
  onTaskRevised: (taskId: string, revise: (task: TaskTrackerTaskDto) => TaskTrackerTaskDto) => void;
  /** Reports a late failure once this detail shows another task or closed. */
  onBackgroundError: (message: string) => void;
}) {
  const { data, preferences } = useManagement();
  const canWrite = data?.canConnect !== false;
  // Survives the window closing under it, like the new-task composer.
  const [instructions, setInstructions] = useFieldDraft(`instructions:${task.provider}:${task.id}`);
  const [statusId, setStatusId] = useState(task.status.id);
  const [target, setTarget] = useState<HandoffTarget>(sessionId ? "current" : "new");
  const [busy, setBusy] = useState<"link" | "select" | "dispatch" | "status" | "complete" | null>(null);
  const [notice, setNotice] = useState("");
  const [startedSession, setStartedSession] = useState<string | null>(null);
  const [error, setError] = useState("");

  const [editing, setEditing] = useState(initialEditing);
  const [editTitle, setEditTitle] = useState(task.title);
  const [editDescription, setEditDescription] = useState(task.description ?? "");

  const [previewImage, setPreviewImage] = useState<TaskTrackerAttachmentDto | null>(null);
  const [attaching, setAttaching] = useState(false);
  // Files dragged over any part of the card, as in Trello.
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Survives the detail closing, and takes back a comment the tracker refused.
  const [commentText, setCommentText] = useFieldDraft(commentDraftKey(task));
  const [pendingComments, setPendingComments] = useState<PendingComment[]>([]);

  // Writes outlive the detail: a late answer for a task no longer shown must
  // neither reopen it nor write into another task's fields.
  const live = useRef({ mounted: true, task });
  live.current.task = task;
  useEffect(() => {
    live.current.mounted = true;
    return () => { live.current.mounted = false; };
  }, []);
  const showing = (taskId: string) => live.current.mounted && live.current.task.id === taskId;

  useEffect(() => {
    setNotice("");
    setError("");
    setStartedSession(null);
    setPreviewImage(null);
    // An edit the tracker refused while this task was not shown comes back.
    const refused = takeFieldDraft(editDraftKey(task));
    const draft = refused ? JSON.parse(refused) as { title: string; description: string } : null;
    setEditing(initialEditing || draft !== null);
    setEditTitle(draft?.title ?? task.title);
    setEditDescription(draft?.description ?? task.description ?? "");
  }, [task.id, initialEditing]);

  // A refresh must not overwrite what the user is typing.
  useEffect(() => {
    // An open editor keeps what the person typed (or a refused edit).
    if (editing) return;
    setEditTitle(task.title);
    setEditDescription(task.description ?? "");
  }, [task.title, task.description, editing]);

  useEffect(() => {
    if (!sessionId) setTarget("new");
  }, [sessionId]);

  useEffect(() => {
    setStatusId(task.status.id);
  }, [task.id, task.status.id]);

  const statuses = task.availableStatuses ?? [];
  const doneStatus = statuses.find((status) => status.category === "done");
  // A status change shows at once (card and detail); a rejection restores the
  // previous task and reports. One write at a time, each sent once.
  const statusWrite = useRef(false);
  const mutate = async (_action: "status" | "complete", nextStatusId: string) => {
    if (!nextStatusId || nextStatusId === task.status.id || statusWrite.current) return;
    const target = statuses.find((status) => status.id === nextStatusId);
    const previous = task;
    statusWrite.current = true;
    setError("");
    if (target) {
      onTaskRevised(task.id, (current) => ({
        ...current,
        status: { id: target.id, name: target.name, category: target.category },
      }));
      setNotice(target.category === "done" ? tt("tasktrackers.board.taskMarkedComplete") : tt("tasktrackers.board.movedTo", { name: target.name }));
    }
    try {
      const updated = await api.taskTrackerUpdateStatus(task.provider, task.id, {
        ...(sessionId ? { sessionId } : {}),
        statusId: nextStatusId,
      });
      onTaskRevised(previous.id, () => updated);
      if (showing(previous.id)) {
        setNotice(updated.status.category === "done" ? tt("tasktrackers.board.taskMarkedComplete") : tt("tasktrackers.board.movedTo", { name: updated.status.name }));
      }
      changed();
    } catch (cause) {
      onTaskRevised(previous.id, (current) => current.status.id === nextStatusId
        ? { ...current, status: previous.status }
        : current);
      const message = messageOf(tt("tasktrackers.board.couldNotUpdateStatus", { key: previous.key }), cause);
      if (showing(previous.id)) {
        setNotice("");
        setError(message);
      } else {
        onBackgroundError(message);
      }
    } finally {
      statusWrite.current = false;
    }
  };
  const dispatch = async () => {
    if (!projectId) return;
    setBusy("dispatch");
    setError("");
    try {
      const [result] = await dispatchTasks(projectId, [task], instructions);
      if (!result?.sessionId) throw new Error(result?.error || tt("tasktrackers.board.agentDidNotStart"));
      setStartedSession(result.sessionId);
      setNotice(tt("tasktrackers.board.agentStarted"));
      setInstructions("");
    } catch (cause) {
      setError(messageOf(tt("tasktrackers.board.couldNotStartAgent"), cause));
    } finally {
      setBusy(null);
    }
  };
  const link = async (startAgent: boolean) => {
    if (!sessionId) return;
    setBusy(startAgent ? "link" : "select");
    setError("");
    try {
      const result = await api.taskTrackerLink(task.provider, task.id, {
        sessionId,
        startAgent,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });
      onTaskChanged(result.task, true);
      if (startAgent) setInstructions("");
      setNotice(startAgent ? tt("tasktrackers.board.linkedStarting") : tt("tasktrackers.board.taskLinked"));
      changed();
    } catch (cause) {
      setError(messageOf(tt("tasktrackers.board.couldNotLink"), cause));
    } finally {
      setBusy(null);
    }
  };

  // Save closes the editor and shows the new title and description at once.
  // A rejection restores the previous text on the task and hands the edit back
  // to the editor (or keeps it for when the task is reopened). Sent once.
  const handleSaveTask = async () => {
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) return;
    const edited = task;
    const description = editDescription;
    const previous = { title: edited.title, description: edited.description };
    const restore = (current: TaskTrackerTaskDto) =>
      current.title === trimmedTitle && (current.description ?? "") === description
        ? { ...current, title: previous.title, description: previous.description }
        : current;
    setError("");
    onTaskRevised(edited.id, (current) => ({ ...current, title: trimmedTitle, description }));
    setEditing(false);
    setNotice(tt("tasktrackers.board.taskUpdated"));
    try {
      const updated = await api.taskTrackerUpdateTask(edited.provider, edited.id, {
        title: trimmedTitle,
        description,
      });
      onTaskRevised(edited.id, () => updated);
      changed();
    } catch (cause) {
      onTaskRevised(edited.id, restore);
      const message = messageOf(tt("tasktrackers.board.couldNotUpdate", { key: edited.key }), cause);
      if (showing(edited.id)) {
        setNotice("");
        setError(message);
        setEditTitle(trimmedTitle);
        setEditDescription(description);
        setEditing(true);
      } else {
        restoreFieldDraft(editDraftKey(edited), JSON.stringify({ title: trimmedTitle, description }), false);
        onBackgroundError(tt("tasktrackers.board.editKept", { message }));
      }
    }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;
    setAttaching(true);
    setError("");
    try {
      const accepted = Array.from(files).filter((file) => ATTACHABLE_TYPES.split(",").includes(file.type));
      if (accepted.length === 0) throw new Error(tt("tasktrackers.work.imageTypes"));
      const inputs: TaskTrackerAttachmentInput[] = [];
      for (const file of accepted) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const commaIndex = dataUrl.indexOf(",");
        inputs.push({
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          data: commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl,
        });
      }
      const result = await api.taskTrackerAttach(task.provider, task.id, inputs);
      onTaskChanged(result.task ?? await api.taskTrackerTask(task.provider, task.id));
      setNotice(tt("tasktrackers.board.attached", { count: inputs.length }));
      changed();
    } catch (cause) {
      setError(messageOf(tt("tasktrackers.board.couldNotAttach"), cause));
    } finally {
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // The comment shows at once as pending and the field clears. A rejection
  // marks it failed with its text kept (back to the field in one click, or
  // into the task's comment draft when the task is no longer shown). Sent once.
  const postComment = async () => {
    const text = commentText.trim();
    if (!text) return;
    const commented = task;
    const key = `pending-${++pendingCommentSeq}`;
    setError("");
    setCommentText("");
    setPendingComments((current) => [...current, { key, taskId: commented.id, text, failed: false }]);
    try {
      const result = await api.taskTrackerAddComment(commented.provider, commented.id, text);
      // The comment is saved: a failed re-read must not mark it failed and
      // invite a duplicate resend.
      const updated = result.task
        ?? await api.taskTrackerTask(commented.provider, commented.id).catch(() => null);
      if (updated) onTaskRevised(commented.id, () => updated);
      setPendingComments((current) => current.filter((item) => item.key !== key));
      changed();
    } catch (cause) {
      const message = messageOf(tt("tasktrackers.board.couldNotComment"), cause);
      if (showing(commented.id)) {
        setPendingComments((current) => current.map((item) => item.key === key ? { ...item, failed: true } : item));
        setError(message);
      } else {
        setPendingComments((current) => current.filter((item) => item.key !== key));
        restoreFieldDraft(commentDraftKey(commented), text);
        onBackgroundError(tt("tasktrackers.board.commentKept", { message, key: commented.key }));
      }
    }
  };
  const editFailedComment = (pending: PendingComment) => {
    setPendingComments((current) => current.filter((item) => item.key !== pending.key));
    const typed = commentText.trim();
    setCommentText(typed ? `${typed}\n\n${pending.text}` : pending.text);
    setError("");
  };

  const shownPending = pendingComments.filter((item) => item.taskId === task.id);
  const images = imageAttachments(task);
  const files = (task.attachments ?? []).filter((att) => !images.includes(att));
  const commentCount = commentCountOf(task);
  const attachmentCount = task.attachments?.length ?? 0;
  const cover = coverImageOf(task);
  const coverSrc = cover ? cover.thumbnailUrl || cover.url : undefined;
  const due = dueLabel(task.dueAt);

  return (
    <Dialog
      title={tt("tasktrackers.board.taskDetailsTitle", { key: task.key })}
      onClose={onClose}
      size="lg"
      hideHeader
      initialFocus=".tt-detail"
      className="tt-detail tt-task-modal"
    >
      <div
        className={`tt-modal${dropping ? " is-dropping" : ""}`}
        aria-busy={loading || busy !== null}
        onDragEnter={canWrite ? (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDropping(true);
        } : undefined}
        onDragOver={canWrite ? (event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        } : undefined}
        onDragLeave={canWrite ? () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDropping(false);
        } : undefined}
        onDrop={canWrite ? (event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDropping(false);
          if (event.dataTransfer.files.length > 0) void uploadFiles(event.dataTransfer.files);
        } : undefined}
      >
        <header className="tt-detail-header">
          <span className="tt-eyebrow">
            {providerMark(task.provider)}
            <span>{PROVIDER_LABELS[task.provider]}</span>
            <b>{task.key}</b>
            {demo && <i>{tt("tasktrackers.board.demo")}</i>}
          </span>
          <span className="tt-detail-tools">
            {task.url && (
              <a
                className="tt-external"
                href={task.url}
                target="_blank"
                rel="noreferrer"
                aria-label={tt("tasktrackers.board.openIn", { provider: PROVIDER_LABELS[task.provider] })}
                title={tt("tasktrackers.board.openIn", { provider: PROVIDER_LABELS[task.provider] })}
              >
                <Icon.external />
              </a>
            )}
            <IconButton icon={CloseIcon} size="sm" label={tt("tasktrackers.board.closeDetails")} onClick={onClose} />
          </span>
        </header>

        <div className="tt-detail-scroll">
          {cover && (
            <button
              type="button"
              className="tt-modal-cover"
              onClick={() => setPreviewImage(cover)}
              aria-label={tt("tasktrackers.board.viewCover", { name: cover.name })}
            >
              {/* A blurred copy fills the band behind a picture of any shape. */}
              {coverSrc && <img className="tt-modal-cover-glow" src={coverSrc} alt="" aria-hidden="true" decoding="async" />}
              <AttachmentImage src={coverSrc} alt={cover.name} eager />
            </button>
          )}

          <div className="tt-detail-layout">
            <div className="tt-detail-main">
              <div className="tt-detail-title-row">
                <h3>{task.title}</h3>
                {canWrite && !editing && (
                  <IconButton
                    icon={EditIcon}
                    size="sm"
                    label={tt("tasktrackers.board.editTask")}
                    title={tt("tasktrackers.board.editTask")}
                    onClick={() => {
                      setEditTitle(task.title);
                      setEditDescription(task.description ?? "");
                      setEditing(true);
                    }}
                  />
                )}
              </div>
              <div className="tt-detail-summary">
                <span className="tt-detail-in">{tt("tasktrackers.board.in")}</span>
                <StatusPill status={task.status} />
                {linked && <span className="tt-linked-chip"><Icon.link /> {tt("tasktrackers.board.linkedToSession")}</span>}
                {loading && <span className="tt-detail-loading" role="status"><span className="tt-button-spinner" aria-hidden="true" /> {tt("tasktrackers.board.refreshing")}</span>}
              </div>

              {(task.assignees.length > 0 || task.labels.length > 0 || due || (task.priority && task.priority.level !== "none")) && (
                <dl className="tt-facts">
                  {task.assignees.length > 0 && <div>
                    <dt>{tt("tasktrackers.board.assigned")}</dt>
                    <dd className="tt-fact-people">
                      {taskPeople(task).map((person) => (
                        <span key={`${person.id}:${person.name}`} className="tt-person" title={person.name}>
                          <PersonAvatar person={person} size="xs" />{person.name}
                        </span>
                      ))}
                    </dd>
                  </div>}
                  {task.priority && task.priority.level !== "none" && <div>
                    <dt>{tt("tasktrackers.board.priority")}</dt>
                    <dd className="tt-fact-priority"><PriorityGlyph priority={task.priority} />{task.priority.name}</dd>
                  </div>}
                  {task.labels.length > 0 && <div>
                    <dt>{tt("tasktrackers.board.labels")}</dt>
                    <dd className="tt-fact-chips">{task.labels.map((label) => <span className="tt-label" key={label}>{label}</span>)}</dd>
                  </div>}
                  {due && <div>
                    <dt>{tt("tasktrackers.board.dueLabel")}</dt>
                    <dd><time className={`tt-due-chip${overdue(task) ? " overdue" : ""}`} dateTime={task.dueAt}>{due}</time></dd>
                  </div>}
                </dl>
              )}

              {notice && <p className="tt-notice" role="status" aria-live="polite">{notice}</p>}
              {error && <p className="tt-error" role="alert">{error}</p>}

              <section className="tt-detail-section tt-description-section" aria-label={tt("tasktrackers.board.description")}>
                <div className="tt-section-heading"><div><strong>{tt("tasktrackers.board.description")}</strong></div></div>
                {editing ? (
                  <div className="tt-detail-edit-form">
                    <label className="tt-edit-field">
                      <span className="tt-field-label">{tt("tasktrackers.board.taskTitle")}</span>
                      <TextInput
                        value={editTitle}
                        onChange={(event) => setEditTitle(event.target.value)}
                        placeholder={tt("tasktrackers.board.taskTitle")}
                        aria-label={tt("tasktrackers.board.taskTitle")}
                      />
                    </label>
                    <label className="tt-edit-field">
                      <span className="tt-field-label">{tt("tasktrackers.board.description")}</span>
                      <Textarea
                        value={editDescription}
                        onChange={(event) => setEditDescription(event.target.value)}
                        placeholder={tt("tasktrackers.board.taskDescription")}
                        aria-label={tt("tasktrackers.board.taskDescriptionLabel")}
                        minRows={4}
                      />
                    </label>
                    <div className="tt-edit-actions">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={!editTitle.trim()}
                        onClick={() => void handleSaveTask()}
                      >
                        {tt("tasktrackers.board.save")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(false)}
                      >
                        {tt("tasktrackers.board.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  task.description
                    ? <p className="tt-description">{task.description}</p>
                    : <p className="tt-description muted">{tt("tasktrackers.board.noDescription")}</p>
                )}
              </section>

              <section className="tt-detail-section tt-attachments-section" aria-label={tt("tasktrackers.board.attachments")}>
                <div className="tt-section-heading">
                  <div>
                    <strong>{tt("tasktrackers.board.attachments")}</strong>
                    <small>
                      {attachmentCount > 0
                        ? tt("tasktrackers.board.attachedFiles", { count: attachmentCount })
                        : canWrite ? tt("tasktrackers.board.dropImagesHint") : tt("tasktrackers.board.noFiles")}
                    </small>
                  </div>
                  {canWrite && (
                    <Button
                      size="sm"
                      variant="ghost"
                      iconStart={attaching ? undefined : PlusIcon}
                      busy={attaching}
                      disabled={attaching}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {attaching ? tt("tasktrackers.board.uploading") : tt("tasktrackers.board.attachImage")}
                    </Button>
                  )}
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ATTACHABLE_TYPES}
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.target.files && event.target.files.length > 0) {
                      void uploadFiles(event.target.files);
                    }
                  }}
                />

                {images.length > 0 && (
                  <div className="tt-attachment-grid" role="group" aria-label={tt("tasktrackers.board.attachedImages")}>
                    {images.map((img, index) => (
                      <button
                        key={img.id}
                        type="button"
                        className="tt-attachment-thumb-card"
                        style={{ "--tt-i": Math.min(index, 8) } as Record<string, number>}
                        onClick={() => setPreviewImage(img)}
                        aria-label={tt("tasktrackers.board.previewImage", { name: img.name })}
                      >
                        <span className="tt-thumb-media">
                          <AttachmentImage src={img.thumbnailUrl || img.url} alt={img.name} />
                          {img.id === cover?.id && <span className="tt-thumb-cover-badge">{tt("tasktrackers.board.cover")}</span>}
                        </span>
                        <span className="tt-thumb-caption">
                          <span className="tt-thumb-name" title={img.name}>{img.name}</span>
                          <small>{[formatBytes(img.size), formatRelativeTime(img.createdAt)].filter(Boolean).join(" · ")}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {files.length > 0 && (
                  <div className="tt-attachment-list" role="list" aria-label={tt("tasktrackers.board.attachedDocuments")}>
                    {files.map((file) => (
                      <div key={file.id} className="tt-attachment-file-row" role="listitem">
                        <span className="tt-file-badge" aria-hidden="true"><FileIcon size={16} /></span>
                        <div className="tt-file-info">
                          <span className="tt-file-name" title={file.name}>{file.name}</span>
                          <span className="tt-file-meta">
                            {file.size ? <span>{formatBytes(file.size)}</span> : null}
                            {file.createdAt ? <span>{formatRelativeTime(file.createdAt)}</span> : null}
                          </span>
                        </div>
                        {file.url && (
                          <a
                            href={file.url}
                            target="_blank"
                            rel="noreferrer"
                            className="tt-file-download-link"
                            title={tt("tasktrackers.board.openDownload")}
                            aria-label={tt("tasktrackers.board.openFile", { name: file.name })}
                          >
                            <ExternalLinkIcon size={14} />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="tt-detail-section tt-comments-section" aria-label={tt("tasktrackers.board.comments")}>
                <div className="tt-section-heading">
                  <div>
                    <strong>{tt("tasktrackers.board.comments")}</strong>
                    <small>
                      {commentCount > 0
                        ? `${tt("tasktrackers.board.commentCount", { count: commentCount })}${(task.comments?.length ?? 0) < commentCount ? tt("tasktrackers.board.latestComments", { count: task.comments?.length ?? 0 }) : ""}`
                        : tt("tasktrackers.board.noComments")}
                    </small>
                  </div>
                </div>

                {canWrite && (
                  <form
                    className="tt-comment-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void postComment();
                    }}
                  >
                    <Textarea
                      value={commentText}
                      onChange={(event) => setCommentText(event.target.value)}
                      onKeyDown={(event) => {
                        if (isImeComposing(event)) return;
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          void postComment();
                        }
                      }}
                      placeholder={tt("tasktrackers.board.commentPlaceholder")}
                      aria-label={tt("tasktrackers.board.commentAria")}
                      minRows={2}
                    />
                    {commentText.trim() && (
                      <div className="tt-comment-form-actions">
                        <Button
                          type="submit"
                          variant="primary"
                          size="sm"
                          disabled={!commentText.trim()}
                        >
                          {tt("tasktrackers.board.addComment")}
                        </Button>
                      </div>
                    )}
                  </form>
                )}

                {((task.comments?.length ?? 0) > 0 || shownPending.length > 0) && (
                  <div className="tt-comments-list" role="feed" aria-label={tt("tasktrackers.board.comments")}>
                    {(task.comments ?? []).map((comment) => (
                      <article key={comment.id} className="tt-comment-item">
                        {comment.authorAvatarUrl ? (
                          <img src={comment.authorAvatarUrl} alt="" className="tt-comment-avatar-img" />
                        ) : (
                          <span className="tt-comment-avatar-initial" aria-hidden="true">
                            {(comment.author || "?").slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <div className="tt-comment-content">
                          <header className="tt-comment-header">
                            <span className="tt-comment-author">{comment.author}</span>
                            {comment.createdAt && (
                              <time className="tt-comment-time" dateTime={comment.createdAt}>
                                {formatRelativeTime(comment.createdAt)}
                              </time>
                            )}
                          </header>
                          <div className="tt-comment-body">
                            <p>{comment.text || <em>{tt("tasktrackers.board.noText")}</em>}</p>
                          </div>
                        </div>
                      </article>
                    ))}
                    {shownPending.map((pending) => (
                      <article
                        key={pending.key}
                        className={`tt-comment-item ${pending.failed ? "failed" : "pending"}`}
                        aria-busy={!pending.failed}
                      >
                        <span className="tt-comment-avatar-initial" aria-hidden="true">·</span>
                        <div className="tt-comment-content">
                          <header className="tt-comment-header">
                            <span className="tt-comment-author">{tt("tasktrackers.board.you")}</span>
                            <span className="tt-comment-time" role={pending.failed ? undefined : "status"}>
                              {pending.failed ? tt("tasktrackers.board.notSent") : tt("tasktrackers.board.sending")}
                            </span>
                          </header>
                          <div className="tt-comment-body">
                            <p>{pending.text}</p>
                          </div>
                          {pending.failed && (
                            <div className="tt-comment-failed-actions">
                              <Button size="sm" variant="ghost" onClick={() => editFailedComment(pending)}>
                                {tt("tasktrackers.board.editResend")}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setPendingComments((current) => current.filter((item) => item.key !== pending.key))}
                              >
                                {tt("tasktrackers.board.discard")}
                              </Button>
                            </div>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <aside className="tt-detail-side" aria-label={tt("tasktrackers.board.taskActions")}>
              {preferences.statusUpdates && canWrite && <section className="tt-detail-section tt-side-section">
                <div className="tt-section-heading">
                  <div>
                    <strong>{demo ? tt("tasktrackers.board.updateSandbox") : tt("tasktrackers.board.updateTracker")}</strong>
                    <small>{demo ? tt("tasktrackers.board.sandboxHint") : tt("tasktrackers.board.trackerHint")}</small>
                  </div>
                </div>
                {statuses.length > 0 ? (
                  <>
                    <div className="tt-status-row">
                      <Select
                        label={tt("tasktrackers.board.taskStatus")}
                        ariaLabel={tt("tasktrackers.board.taskStatus")}
                        value={statusId}
                        disabled={busy !== null}
                        onChange={setStatusId}
                        options={[
                          { value: task.status.id, label: task.status.name },
                          ...statuses.filter((status) => status.id !== task.status.id).map((status) => ({
                            value: status.id,
                            label: status.name,
                          })),
                        ]}
                      />
                      <Button
                        busy={busy === "status"}
                        disabled={busy !== null || statusId === task.status.id}
                        onClick={() => void mutate("status", statusId)}
                      >
                        {tt("tasktrackers.board.updateStatus")}
                      </Button>
                    </div>
                    {doneStatus && task.status.category !== "done" && (
                      <Button
                        className="tt-complete"
                        iconStart={CheckIcon}
                        busy={busy === "complete"}
                        disabled={busy !== null}
                        onClick={() => void mutate("complete", doneStatus.id)}
                      >
                        {tt("tasktrackers.board.markComplete")}
                      </Button>
                    )}
                  </>
                ) : (
                  <p className="tt-inline-hint">{tt("tasktrackers.board.noTransitions")}</p>
                )}
              </section>}

              {canWrite && <section className="tt-detail-section tt-side-section">
                <div className="tt-section-heading">
                  <div>
                    <strong>{preferences.agentHandoff ? tt("tasktrackers.board.handOff") : tt("tasktrackers.board.linkToSession")}</strong>
                    <small>{preferences.agentHandoff
                      ? demo ? tt("tasktrackers.board.sampleLogged") : tt("tasktrackers.board.contextLogged")
                      : tt("tasktrackers.board.handoffOff")}</small>
                  </div>
                </div>
                {preferences.agentHandoff && (
                  <div className="tt-target" role="radiogroup" aria-label={tt("tasktrackers.board.whereAgentWorks")}>
                    {([["new", tt("tasktrackers.board.newSession")], ["current", tt("tasktrackers.board.thisSession")]] as const).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={target === id}
                        className={target === id ? "active" : ""}
                        disabled={(id === "current" && !sessionId) || busy !== null}
                        onClick={() => setTarget(id)}
                      >{label}</button>
                    ))}
                  </div>
                )}
                {preferences.agentHandoff && <Textarea
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder={tt("tasktrackers.board.instructionsPlaceholder")}
                  aria-label={tt("tasktrackers.board.instructionsAria")}
                  maxLength={2000}
                  minRows={3}
                  disabled={busy !== null}
                />}
                {preferences.agentHandoff && target === "new" ? (
                  <div className="tt-action-row single">
                    <Button
                      variant="primary"
                      iconStart={SendIcon}
                      busy={busy === "dispatch"}
                      disabled={!projectId || busy !== null}
                      onClick={() => void dispatch()}
                    >
                      {tt("tasktrackers.board.startAgentNew")}
                    </Button>
                  </div>
                ) : (
                  <div className="tt-action-row">
                    {preferences.agentHandoff && <Button
                      variant="primary"
                      iconStart={SendIcon}
                      busy={busy === "link"}
                      disabled={!sessionId || busy !== null}
                      onClick={() => void link(true)}
                    >
                      {linked ? tt("tasktrackers.board.startAgent") : tt("tasktrackers.board.linkStart")}
                    </Button>}
                    <Button
                      iconStart={LinkIcon}
                      busy={busy === "select"}
                      disabled={!sessionId || busy !== null}
                      onClick={() => void link(false)}
                    >
                      {linked ? tt("tasktrackers.board.refreshLink") : tt("tasktrackers.board.linkOnly")}
                    </Button>
                  </div>
                )}
                {startedSession && (
                  <Button size="sm" variant="quiet" onClick={() => openSession(startedSession)}>{tt("tasktrackers.board.openNewSession")}</Button>
                )}
                {target === "new" && !projectId && preferences.agentHandoff && <small className="tt-inline-hint">{tt("tasktrackers.board.openProjectForAgents")}</small>}
                {(target === "current" || !preferences.agentHandoff) && !sessionId && <small className="tt-inline-hint">{tt("tasktrackers.board.openSessionToLink")}</small>}
              </section>}

              {links.length > 0 && <section className="tt-detail-section tt-side-section">
                <div className="tt-section-heading">
                  <div>
                    <strong>{tt("tasktrackers.board.agentSessions")}</strong>
                    <small>{tt("tasktrackers.board.agentReports")}</small>
                  </div>
                </div>
                <AgentSessions links={links} />
              </section>}
            </aside>
          </div>
        </div>
        {dropping && (
          <div className="tt-modal-drop" aria-hidden="true">
            <UploadIcon size={22} />
            <strong>{tt("tasktrackers.board.dropImages")}</strong>
            <small>{tt("tasktrackers.board.imageFormats")}</small>
          </div>
        )}
      </div>

      {previewImage && (
        <ImageLightbox
          attachment={previewImage}
          allImages={images}
          onClose={() => setPreviewImage(null)}
          onSelectImage={setPreviewImage}
        />
      )}
    </Dialog>
  );
}

/** Tasks one board request reads; a board that returns this many has more. */
const TASK_PAGE = 100;

const BOARD_TYPE_KEYS = {
  kanban: "tasktrackers.board.boardType.kanban",
  scrum: "tasktrackers.board.boardType.scrum",
  simple: "tasktrackers.board.boardType.simple",
  unknown: "",
} as const;

const BOARD_TYPE_LABELS: Record<TaskTrackerBoardType, string> = BOARD_TYPE_KEYS;

/** A board's line in the picker: under its project when every project is
 *  shown, with what kind of board it is when that says something. */
function boardOption(board: TaskTrackerBoardDto, group: string | null): SelectOption {
  const detail = board.provider === "linear"
    ? board.id.includes(":") ? tt("tasktrackers.board.project") : tt("tasktrackers.board.allIssues")
    : board.provider === "jira" ? tt(BOARD_TYPE_KEYS[board.type] as TaskTrackersMessageKey) : "";
  return {
    value: board.id,
    label: board.name,
    ...(group ? { group } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** Nothing matches: say which filter hid everything and offer the way back. */
function FilteredEmpty({
  provider,
  searching,
  assignees,
  people,
  knowsMe,
  onlyDone,
  onClear,
  onShowCompleted,
}: {
  provider: TaskTrackerProvider;
  searching: boolean;
  assignees: ReadonlySet<string>;
  people: Parameters<typeof emptyAssigneeTitle>[1];
  knowsMe: boolean;
  /** Every task on the board is done and completed tasks are hidden. */
  onlyDone: boolean;
  onClear: () => void;
  onShowCompleted: () => void;
}) {
  if (onlyDone) {
    return (
      <BoardEmpty
        icon={<Icon.check />}
        title={tt("tasktrackers.board.everythingDone")}
        body={tt("tasktrackers.board.completedHidden")}
        action={<Button size="sm" onClick={onShowCompleted}>{tt("tasktrackers.board.showCompleted")}</Button>}
      />
    );
  }
  if (searching || assignees.size === 0) {
    return (
      <BoardEmpty
        icon={<Icon.search />}
        title={tt("tasktrackers.board.noMatches")}
        body={assignees.size > 0
          ? tt("tasktrackers.board.clearSearchOrChoose")
          : tt("tasktrackers.board.clearSearch")}
        action={<Button size="sm" onClick={onClear}>{tt("tasktrackers.board.clearFilters")}</Button>}
      />
    );
  }
  const unknownMe = assignees.has(ME) && !knowsMe;
  return (
    <BoardEmpty
      icon={<Icon.filter />}
      title={unknownMe ? tt("tasktrackers.board.unknownAccount") : emptyAssigneeTitle(assignees, people)}
      body={unknownMe
        ? tt("tasktrackers.board.unknownAccountBody", { provider: PROVIDER_LABELS[provider] })
        : tt("tasktrackers.board.chooseSomeoneElse")}
      action={<Button size="sm" onClick={onClear}>{tt("tasktrackers.board.showEveryone")}</Button>}
    />
  );
}

function taskTrackerHostNavigate(): void {
  loadManagement();
  taskTrackerHostRef?.navigation.openSettingsPage("task-trackers");
}

let taskTrackerHostRef: WebPackageHost | null = null;

/** A board outcome ("POL-2 deleted", "3 agents started"), shown through the
 *  host's notification stack. One board notice at a time: the next replaces
 *  it in place. One that offers its session waits to be closed. */
function showBoardNotice(notice: { text: string; sessionId?: string; failed?: boolean }): void {
  const sessionId = notice.sessionId;
  taskTrackerHostRef?.notifications?.show({
    id: "task-trackers.board-notice",
    kind: notice.failed ? "warning" : "success",
    title: notice.text,
    ...(sessionId
      ? { actions: [{ label: tt("tasktrackers.board.openSession"), primary: true, run: () => openSession(sessionId) }], duration: "sticky" as const }
      : { duration: 6_000 }),
  });
}

type TaskTrackerBoardProps = Pick<WidgetRenderContext, "sessionId" | "config" | "updateConfig"> & {
  /** localStorage key under which this window remembers what it last showed. */
  memoryKey?: string;
  /** The Polyth project whose boards this window shows (a widget's own);
   *  defaults to the active project. */
  activeProjectId?: string | null;
};

/**
 * The board of one Polyth project. Each project keeps its own board choice
 * and window memory, so a project change starts the board afresh.
 */
export function TaskTrackerBoard(props: TaskTrackerBoardProps) {
  const storeProjectId = useActiveProjectId();
  const activeProjectId = props.activeProjectId ?? storeProjectId;
  return <ProjectTaskBoard key={activeProjectId ?? ""} {...props} activeProjectId={activeProjectId} />;
}

function ProjectTaskBoard({
  sessionId,
  config,
  updateConfig,
  memoryKey,
  activeProjectId,
}: TaskTrackerBoardProps & { activeProjectId: string | null }) {
  const providerPanelId = useId();
  const configuredDefault = config.defaultView === "list" ? "list" : "kanban";
  // The project's choice of what opens, made after the window last showed
  // something, wins over that memory.
  const memory = useMemo(
    () => memoryKey
      ? localBoardMemory(projectMemoryKey(memoryKey, activeProjectId), {
        since: projectChangedAt(activeProjectId),
        legacyKey: memoryKey,
      })
      : null,
    [memoryKey, activeProjectId],
  );
  const [providers, setProviders] = useState<TaskTrackerProviderDto[] | null>(null);
  const [provider, setProvider] = useState<TaskTrackerProvider>(() =>
    memory?.read().provider ?? (projectTracker(activeProjectId) || "jira"));
  const [projects, setProjects] = useState<TaskTrackerProjectDto[]>([]);
  // The project filter a provider opens with: what this window last showed
  // ("all" included), else the default. Set before the first board request
  // so the list loads once; the project list validates it later.
  const initialProject = (next: TaskTrackerProvider): string => {
    const remembered = memory?.read().selections[next];
    return remembered ? remembered.projectId : providerScope(activeProjectId, next).defaultProjectId;
  };
  const [projectId, setProjectId] = useState(() => initialProject(provider));
  const [projectProvider, setProjectProvider] = useState(provider);
  if (projectProvider !== provider) {
    setProjectProvider(provider);
    setProjectId(initialProject(provider));
  }
  const [boards, setBoards] = useState<TaskTrackerBoardDto[]>([]);
  const [boardId, setBoardId] = useState("");
  const [boardsEpoch, setBoardsEpoch] = useState(0);
  const [scoping, setScoping] = useState(false);
  const [composingBoard, setComposingBoard] = useState(false);
  const pendingBoardRef = useRef<string | null>(null);
  const scope = useProviderScope(activeProjectId, provider);
  const shownProjects = useMemo(() => visibleProjects(projects, scope), [projects, scope]);
  const shownBoards = useMemo(() => visibleBoards(boards, scope), [boards, scope]);
  const [tasks, setTasks] = useState<TaskTrackerTaskDto[]>([]);
  // The cache key the shown tasks belong to; local edits (moves, renames,
  // new cards) are written back under it so the next paint shows them.
  const tasksOwner = useRef<string | null>(null);
  const showTasks = (key: string, items: TaskTrackerTaskDto[]) => {
    tasksOwner.current = key;
    setTasks((current) => keepIfSame(current, items));
  };
  const clearTasks = () => {
    tasksOwner.current = null;
    setTasks([]);
  };
  const [columns, setColumns] = useState<TaskTrackerBoardColumnsDto | null>(null);
  const [columnsEpoch, setColumnsEpoch] = useState(0);
  const [linkedTasks, setLinkedTasks] = useState<TaskTrackerSessionTaskDto[]>([]);
  const [selected, setSelected] = useState<TaskTrackerTaskDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [view, setView] = useState<BoardView>(configuredDefault);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  // The assignee filter (people.ts tokens), remembered per tracker on this
  // device; it follows the tracker the window shows.
  const initialAssignees = (next: TaskTrackerProvider): ReadonlySet<string> =>
    new Set(memory?.read().assignees?.[next] ?? []);
  const [assignees, setAssigneesState] = useState(() => initialAssignees(provider));
  const [assigneeProvider, setAssigneeProvider] = useState(provider);
  if (assigneeProvider !== provider) {
    setAssigneeProvider(provider);
    setAssigneesState(initialAssignees(provider));
  }
  const [viewer, setViewer] = useState<TaskTrackerViewerDto | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const me = useMemo(() => ownViewer(viewer), [viewer]);
  const setAssignees = (next: Iterable<string>) => {
    const normalized = normalizeAssignees(next, me);
    setAssigneesState(normalized);
    memory?.write({ assignees: { [provider]: [...normalized] } });
  };
  const grouping: ListGrouping = isListGrouping(config.listGroup) ? config.listGroup : "status";
  const showCompleted = config.hideCompleted !== true;
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const boardRootRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState<"providers" | "boards" | "tasks" | null>("providers");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadEpoch, setLoadEpoch] = useState(0);
  const selectedTriggerRef = useRef<HTMLElement | null>(null);
  const detailRequestRef = useRef(0);
  const [connecting, setConnecting] = useState(false);
  const [composing, setComposing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [editSelectedOnOpen, setEditSelectedOnOpen] = useState(false);
  const links = useTaskLinks();
  const { data: management, preferences } = useManagement();
  const canWrite = management?.canConnect !== false;
  // Only trackers the server reports: an older server knows fewer of them.
  const enabledProviders = TASK_TRACKER_PROVIDERS.filter((id) =>
    providers?.some((item) => item.provider === id && item.enabled !== false));

  const providerInfo = providers?.find((item) => item.provider === provider);
  const providerReady = providerInfo?.configured === true || providerInfo?.mode === "demo";
  const demoMode = providerInfo?.mode === "demo";
  const board = shownBoards.find((item) => item.provider === provider && item.id === boardId) ?? null;

  useEffect(() => {
    let active = true;
    setLoading("providers");
    setError("");
    void api.taskTrackerProviders()
      .then((items) => {
        if (!active) return;
        setError("");
        setProviders(items);
        const usable = (item: TaskTrackerProviderDto) =>
          item.enabled !== false && (item.mode === "live" || item.configured || item.mode === "demo");
        // The provider this window last showed wins while it is still usable,
        // then the one the project opens with.
        const remembered = memory?.read().provider;
        const preferred = projectTracker(activeProjectId);
        const firstLive = items.find((item) => item.provider === remembered && usable(item))
          ?? items.find((item) => item.provider === preferred && usable(item))
          ?? items.find((item) => item.enabled !== false && (item.mode === "live" || item.configured))
          ?? items.find((item) => item.enabled !== false);
        if (firstLive) setProvider(firstLive.provider);
      })
      .catch((cause) => {
        if (active) setError(messageOf(tt("tasktrackers.board.couldNotLoadProviders"), cause));
      })
      .finally(() => {
        if (active) setLoading((current) => current === "providers" ? null : current);
      });
    return () => { active = false; };
  }, [loadEpoch]);

  useEffect(() => {
    // Settings or connection changes elsewhere re-resolve the provider list.
    let seen = managementSnapshot().data;
    return subscribeManagement(() => {
      const next = managementSnapshot().data;
      if (!next || next === seen) return;
      seen = next;
      setProviders(next.providers);
    });
  }, []);

  useEffect(() => {
    if (!providers || enabledProviders.length === 0) return;
    if (!enabledProviders.includes(provider)) setProvider(enabledProviders[0]!);
  }, [providers, provider, enabledProviders.join(",")]);

  useEffect(() => {
    if (!providerReady) {
      setProjects([]);
      setBoards([]);
      setBoardId("");
      clearTasks();
      return;
    }
    let active = true;
    const scopeNow = scope;
    setBoardId("");
    clearTasks();
    setSelected(null);
    const apply = (items: TaskTrackerProjectDto[]) => {
      setProjects((current) => keepIfSame(current, items));
      // "All" is always valid; a remembered project that is gone falls
      // back to the default.
      setProjectId((current) => !current || items.some((item) => item.id === current)
        ? current
        : resolveProject(items, scopeNow));
    };
    const cached = readCache<TaskTrackerProjectDto[]>(projectsKey(provider));
    if (cached) apply(cached.value);
    void api.taskTrackerProjects(provider)
      .then((items) => {
        writeCache(projectsKey(provider), items);
        if (active) apply(items);
      })
      .catch((cause) => { if (active && !cached) setError(messageOf(tt("tasktrackers.board.couldNotLoadProjects"), cause)); });
    return () => { active = false; };
  }, [loadEpoch, provider, providerReady]);

  // Who "Mine" is: the account this tracker acts as, when it is the caller's
  // own. Cached per document; a new connection (source or account) re-asks.
  const viewerSource = `${providerInfo?.source ?? ""}:${providerInfo?.account?.name ?? ""}`;
  useEffect(() => {
    if (!providerReady) {
      setViewer(null);
      setViewerLoading(false);
      return;
    }
    let active = true;
    const key = viewerKey(`${provider}:${viewerSource}`);
    const cached = readCache<TaskTrackerViewerDto>(key);
    setViewer(cached ? cached.value : null);
    if (cached?.fresh) {
      setViewerLoading(false);
      return;
    }
    setViewerLoading(!cached);
    void api.taskTrackerViewer(provider)
      .then((value) => {
        writeCache(key, value);
        if (active) setViewer((current) => keepIfSame(current, value));
      })
      .catch(() => { /* "Mine" needs it; the rest of the board does not */ })
      .finally(() => { if (active) setViewerLoading(false); });
    return () => { active = false; };
  }, [loadEpoch, provider, providerReady, viewerSource]);

  useEffect(() => {
    // A project hidden later (or a hidden default) falls back to "all".
    if (projects.length === 0 || !projectId) return;
    if (!shownProjects.some((item) => item.id === projectId)) {
      setProjectId(resolveProject(projects, scope));
    }
  }, [projectId, projects, scope, shownProjects]);

  useEffect(() => {
    if (!providerReady) return;
    let active = true;
    const key = boardsKey(provider, projectId);
    const cached = readCache<TaskTrackerBoardDto[]>(key);
    setError("");
    // A cached list paints at once and keeps the open board; the request
    // below only refreshes it.
    if (cached) {
      setBoards((current) => keepIfSame(current, cached.value));
    } else {
      setLoading("boards");
      setBoards([]);
      setBoardId("");
      clearTasks();
    }
    void api.taskTrackerBoards(provider, projectId || undefined)
      .then((items) => {
        writeCache(key, items);
        if (active) setBoards((current) => keepIfSame(current, items));
      })
      .catch((cause) => {
        if (active && !cached) setError(messageOf(tt("tasktrackers.board.couldNotLoadBoards"), cause));
      })
      .finally(() => {
        if (active) setLoading((current) => current === "boards" ? null : current);
      });
    return () => { active = false; };
  }, [boardsEpoch, loadEpoch, provider, projectId, providerReady]);

  useEffect(() => {
    // Resolve the open board whenever the list or the visibility changes:
    // a just-created board, then what this window last showed, then the
    // default, then the first visible one.
    const pending = pendingBoardRef.current;
    if (pending && shownBoards.some((item) => item.id === pending)) {
      pendingBoardRef.current = null;
      if (pending !== boardId) setBoardId(pending);
      return;
    }
    if (shownBoards.some((item) => item.id === boardId)) return;
    const remembered = memory?.read().selections[provider]?.boardId;
    const next = resolveBoard(boards, scope, [pendingBoardRef.current, remembered]);
    if (next && next === pendingBoardRef.current) pendingBoardRef.current = null;
    if (next !== boardId) setBoardId(next);
  }, [boardId, boards, provider, scope, shownBoards]);

  // An unsent task draft reopens its composer with the board, so text typed
  // before the window closed is where the user left it.
  useEffect(() => {
    if (board && hasComposerDraft(provider, board.id)) setComposing(true);
  }, [board?.id, provider]);

  useEffect(() => {
    if (!memory || !board) return;
    memory.write({ provider, selections: { [provider]: { projectId, boardId: board.id } } });
  }, [board?.id, memory, projectId, provider]);

  useEffect(() => {
    if (!board || !providerReady) return;
    let active = true;
    const key = tasksKey(provider, board.id);
    const cached = readCache<TaskTrackerTaskDto[]>(key);
    if (cached) showTasks(key, cached.value);
    else if (tasksOwner.current !== key) clearTasks();
    setLoading("tasks");
    setError("");
    void api.taskTrackerTasks(provider, { boardId: board.id, limit: TASK_PAGE })
      .then((items) => {
        writeCache(key, items);
        if (active) showTasks(key, items);
      })
      .catch((cause) => {
        if (active) setError(messageOf(tt("tasktrackers.board.couldNotLoadTasks"), cause));
      })
      .finally(() => {
        if (active) setLoading((current) => current === "tasks" ? null : current);
      });
    return () => { active = false; };
  }, [board?.id, loadEpoch, provider, providerReady, refreshKey]);

  useEffect(() => {
    const key = tasksOwner.current;
    if (key) reviseCache<TaskTrackerTaskDto[]>(key, () => tasks);
  }, [tasks]);

  useEffect(() => {
    if (!board || !providerReady) {
      setColumns(null);
      return;
    }
    let active = true;
    const key = columnsKey(provider, board.id);
    const cached = readCache<TaskTrackerBoardColumnsDto>(key);
    setColumns((current) => cached ? keepIfSame(current, cached.value) : null);
    // Without columns the board still shows lanes made from task statuses.
    void api.taskTrackerColumns(provider, board.id)
      .then((value) => {
        writeCache(key, value);
        if (active) setColumns((current) => keepIfSame(current, value));
      })
      .catch(() => { if (active && !cached) setColumns(null); });
    return () => { active = false; };
  }, [board?.id, columnsEpoch, loadEpoch, provider, providerReady, refreshKey]);

  useEffect(() => {
    if (!sessionId) {
      setLinkedTasks([]);
      return;
    }
    let active = true;
    const load = () => {
      void api.taskTrackerSessionTasks(sessionId)
        .then((items) => { if (active) setLinkedTasks(items); })
        .catch(() => { if (active) setLinkedTasks([]); });
    };
    load();
    window.addEventListener(TASK_TRACKER_CHANGED, load);
    return () => {
      active = false;
      window.removeEventListener(TASK_TRACKER_CHANGED, load);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!board) return;
    const next = config.defaultView === "kanban" || config.defaultView === "list"
      ? config.defaultView
      : defaultViewForBoard(board.type);
    setView(next);
  }, [board?.id, board?.type, config.defaultView]);

  const linkedIds = useMemo(
    () => new Set(linkedTasks.map((task) => `${task.provider}:${task.taskId}`)),
    [linkedTasks],
  );
  const statuses = useMemo(() => groupTasksByStatus(tasks), [tasks]);
  // What the board holds before the search, status and assignee filters:
  // people counts and "N of M" come from here, so chips don't reshuffle
  // while someone types.
  const boardTasks = useMemo(
    () => showCompleted ? tasks : tasks.filter((task) => task.status.category !== "done"),
    [showCompleted, tasks],
  );
  const { people, unassigned } = useMemo(() => boardPeople(boardTasks, me), [boardTasks, me]);
  const visibleTasks = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return boardTasks.filter((task) => {
      if (statusFilter !== "all" && task.status.id !== statusFilter) return false;
      if (!matchesAssignees(task, assignees, me)) return false;
      return !needle || `${task.key} ${task.title} ${task.labels.join(" ")} ${task.assignees.join(" ")}`
        .toLocaleLowerCase().includes(needle);
    });
  }, [assignees, boardTasks, me, query, statusFilter]);
  const filtering = query.trim() !== "" || statusFilter !== "all" || assignees.size > 0;
  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
    setAssignees([]);
  };
  // "Mine" remembered from before matches nothing until the viewer loads; the
  // board waits for it rather than claiming nothing is yours.
  const waitingForMe = assignees.has(ME) && !me && viewerLoading;
  const lanes = useMemo(() => {
    const all = kanbanLanes(columns?.columns ?? null, visibleTasks);
    // A status filter shows only its column; hidden completed tasks take
    // their empty done columns with them.
    return all.filter((lane) => lane.tasks.length > 0 || (
      statusFilter === "all"
      && lane.column !== undefined
      && !(!showCompleted && lane.category === "done")
    ));
  }, [columns, showCompleted, statusFilter, visibleTasks]);
  const totalOf = (column: TaskTrackerColumnDto) =>
    tasks.filter((task) => column.statusIds.includes(task.status.id)).length;
  const columnFailed = (action: string, cause: unknown) => {
    setError(messageOf(action, cause));
    setColumnsEpoch((value) => value + 1);
  };
  // The column shows at once as a pending placeholder (no actions, no drops)
  // and becomes the tracker's column when it answers. A rejection removes it
  // and names it in the error, so the typed name is not lost. Sent once.
  const createColumn = async (name: string): Promise<boolean> => {
    if (!board) return false;
    const placeholder: TaskTrackerColumnDto = {
      id: `${PENDING_COLUMN_PREFIX}${++pendingColumnSeq}`,
      name,
      category: "todo",
      statusIds: [],
    };
    const swap = (next: TaskTrackerColumnDto | null) => setColumns((current) => current
      ? {
          ...current,
          columns: !next
            ? current.columns.filter((item) => item.id !== placeholder.id)
            : current.columns.some((item) => item.id === placeholder.id)
              ? current.columns.map((item) => item.id === placeholder.id ? next : item)
              // A re-read replaced the list meanwhile; keep the new column once.
              : current.columns.some((item) => item.id === next.id) ? current.columns : [...current.columns, next],
        }
      : current);
    setError("");
    const position = columns?.columns.filter((item) => !isPendingColumn(item)).length ?? 0;
    setColumns((current) => current ? { ...current, columns: [...current.columns, placeholder] } : current);
    void api.taskTrackerCreateColumn(provider, board.id, { name, position })
      .then(swap)
      .catch((cause) => {
        swap(null);
        setError(messageOf(tt("tasktrackers.board.couldNotAddColumn", { name }), cause));
      });
    return true;
  };
  // Rename shows the new name at once; a rejection restores the column (and
  // its cards' status names) and reports. The request is sent once.
  const renameColumn = async (column: TaskTrackerColumnDto, name: string): Promise<boolean> => {
    if (!board) return false;
    const relabel = (next: TaskTrackerColumnDto) => {
      setColumns((current) => current
        ? { ...current, columns: current.columns.map((item) => item.id === column.id ? next : item) }
        : current);
      setTasks((current) => current.map((task) => column.statusIds.includes(task.status.id)
        ? { ...task, status: { ...task.status, name: next.name, category: next.category } }
        : task));
    };
    relabel({ ...column, name });
    setError("");
    void api.taskTrackerUpdateColumn(provider, board.id, column.id, { name })
      .then(relabel)
      .catch((cause) => {
        relabel(column);
        setError(messageOf(tt("tasktrackers.board.couldNotRenameColumn"), cause));
      });
    return true;
  };
  const reorderColumn = (column: TaskTrackerColumnDto, position: number) => {
    if (!board || !columns) return;
    const rest = columns.columns.filter((item) => item.id !== column.id);
    rest.splice(position, 0, column);
    setColumns({ ...columns, columns: rest });
    void api.taskTrackerUpdateColumn(provider, board.id, column.id, { position })
      .catch((cause) => columnFailed(tt("tasktrackers.board.couldNotMoveColumn"), cause));
  };
  const removeColumn = async (column: TaskTrackerColumnDto) => {
    if (!board || !columns) return;
    const count = totalOf(column);
    const archive = columns.removal === "archive";
    const confirmed = await confirmAlert(
      archive
        ? count > 0
          ? tt("tasktrackers.board.archiveCardsConfirm", { name: column.name, count, provider: PROVIDER_LABELS[provider] })
          : tt("tasktrackers.board.archiveListConfirm", { name: column.name, provider: PROVIDER_LABELS[provider] })
        : tt("tasktrackers.board.removeColumnConfirm", { name: column.name }),
      {
        title: archive ? tt("tasktrackers.board.archiveThisList") : tt("tasktrackers.board.deleteThisColumn"),
        confirmLabel: archive ? tt("tasktrackers.board.archiveListAction") : tt("tasktrackers.board.deleteColumnAction"),
      },
    );
    if (!confirmed) return;
    // The column and its cards leave at once. A rejection re-reads the
    // columns (columnFailed) and puts the removed cards back.
    const removedTasks = tasks.filter((task) => column.statusIds.includes(task.status.id));
    setColumns((current) => current
      ? { ...current, columns: current.columns.filter((item) => item.id !== column.id) }
      : current);
    setTasks((current) => current.filter((task) => !column.statusIds.includes(task.status.id)));
    if (selected && column.statusIds.includes(selected.status.id)) closeTask(false);
    setError("");
    try {
      await api.taskTrackerRemoveColumn(provider, board.id, column.id);
      showBoardNotice({ text: archive ? tt("tasktrackers.board.columnArchived", { name: column.name }) : tt("tasktrackers.board.columnDeleted", { name: column.name }) });
    } catch (cause) {
      setTasks((current) => [
        ...current,
        ...removedTasks.filter((task) => !current.some((item) => item.id === task.id)),
      ]);
      columnFailed(archive ? tt("tasktrackers.board.couldNotArchiveList") : tt("tasktrackers.board.couldNotDeleteColumn"), cause);
    }
  };
  const moveTask = (task: TaskTrackerTaskDto, column: TaskTrackerColumnDto) => {
    if (!board) return;
    const previous = task;
    const optimistic: TaskTrackerTaskDto = {
      ...task,
      status: { id: column.statusIds[0] ?? task.status.id, name: column.name, category: column.category },
    };
    setTasks((current) => current.map((item) => item.id === task.id ? optimistic : item));
    setError("");
    const linkedHere = sessionId && linkedIds.has(`${task.provider}:${task.id}`) ? sessionId : "";
    void api.taskTrackerMoveTask(task.provider, task.id, {
      boardId: board.id,
      columnId: column.id,
      ...(linkedHere ? { sessionId: linkedHere } : {}),
    })
      .then((updated) => {
        setTasks((current) => current.map((item) => item.id === updated.id ? updated : item));
        setSelected((current) => current?.id === updated.id ? updated : current);
        if (linkedHere) changed();
      })
      .catch((cause) => {
        setTasks((current) => current.map((item) => item.id === previous.id ? previous : item));
        setError(messageOf(tt("tasktrackers.board.couldNotMove", { key: task.key }), cause));
      });
  };

  const agentsFor = (task: TaskTrackerTaskDto) => links.get(`${task.provider}:${task.id}`) ?? [];
  const togglePick = (task: TaskTrackerTaskDto) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(task.id)) next.delete(task.id);
      else if (next.size < 10) next.add(task.id);
      return next;
    });
  };
  const stopPicking = () => {
    setPicking(false);
    setPicked(new Set());
  };
  const openTask = (task: TaskTrackerTaskDto, trigger?: HTMLElement, editMode = false) => {
    if (picking) {
      togglePick(task);
      return;
    }
    setEditSelectedOnOpen(editMode);
    if (trigger) selectedTriggerRef.current = trigger;
    setComposing(false);
    const requestId = ++detailRequestRef.current;
    // A task opened before shows its comments and statuses at once; the
    // card's own fields win, since the board may have changed them since.
    const cached = readCache<TaskTrackerTaskDto>(taskKey(task.provider, task.id))?.value;
    setSelected(cached
      ? {
          ...cached,
          ...task,
          comments: task.comments ?? cached.comments,
          availableStatuses: task.availableStatuses ?? cached.availableStatuses,
        }
      : task);
    setDetailLoading(true);
    setError("");
    void api.taskTrackerTask(task.provider, task.id)
      .then((detail) => {
        writeCache(taskKey(detail.provider, detail.id), detail);
        if (detailRequestRef.current === requestId) {
          setSelected((current) => current?.id === task.id ? detail : current);
        }
        // The card shows what the detail loaded: comments, fresh attachments.
        setTasks((current) => current.map((item) => item.id === detail.id && item.provider === detail.provider ? detail : item));
      })
      .catch((cause) => {
        if (detailRequestRef.current === requestId) {
          setError(messageOf(tt("tasktrackers.board.couldNotRefresh", { key: task.key }), cause));
        }
      })
      .finally(() => {
        if (detailRequestRef.current === requestId) setDetailLoading(false);
      });
  };
  const closeTask = (restoreFocus = true) => {
    detailRequestRef.current++;
    const closed = selected;
    setSelected(null);
    setDetailLoading(false);
    if (!restoreFocus) return;
    const trigger = selectedTriggerRef.current;
    window.requestAnimationFrame(() => {
      // A status change can move the card to another column or section while
      // the task is open; focus then goes to where it is now.
      const target = trigger?.isConnected
        ? trigger
        : closed
          ? [...boardRootRef.current?.querySelectorAll<HTMLElement>("[data-task-ref]") ?? []]
            .find((element) => element.dataset.taskRef === taskRef(closed))
          : null;
      target?.focus();
    });
  };
  const chooseProvider = (next: TaskTrackerProvider) => {
    if (next === provider) return;
    closeTask();
    setComposing(false);
    stopPicking();
    setProvider(next);
    memory?.write({ provider: next });
    setQuery("");
    setStatusFilter("all");
    setCollapsedGroups(new Set());
  };
  const boardCreated = (created: TaskTrackerBoardDto) => {
    setComposingBoard(false);
    closeTask();
    pendingBoardRef.current = created.id;
    // The cached lists predate the board: reload them from the tracker.
    dropCache(cacheKey("boards", provider, ""));
    // Keep the filter where the new board lives, then reload the list.
    if (projectId && created.projectId && created.projectId !== projectId) setProjectId(created.projectId);
    setBoardsEpoch((value) => value + 1);
    showBoardNotice({ text: tt("tasktrackers.board.created", { name: created.name }) });
  };
  const handleProviderKeys = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: TaskTrackerProvider,
  ) => {
    const order: TaskTrackerProvider[] = enabledProviders;
    const index = order.indexOf(current);
    const nextIndex = event.key === "ArrowRight"
      ? (index + 1) % order.length
      : event.key === "ArrowLeft"
        ? (index - 1 + order.length) % order.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? order.length - 1
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = order[nextIndex]!;
    chooseProvider(next);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-provider="${next}"]`)
      ?.focus();
  };
  const markLinked = (updated: TaskTrackerTaskDto) => {
    setLinkedTasks((current) => current.some((task) =>
      task.provider === updated.provider && task.taskId === updated.id)
      ? current
      : [...current, {
          provider: updated.provider,
          taskId: updated.id,
          taskKey: updated.key,
          title: updated.title,
          statusId: updated.status.id,
          statusName: updated.status.name,
          completed: updated.status.category === "done",
          selectedAtSeq: 0,
          updatedAtSeq: 0,
        }]);
  };
  const updateTask = (updated: TaskTrackerTaskDto, linked = false) => {
    setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
    // A late answer must not reopen a task the person closed or left.
    setSelected((current) => current?.id === updated.id ? updated : current);
    if (linked) markLinked(updated);
  };
  const reviseTask = (taskId: string, revise: (task: TaskTrackerTaskDto) => TaskTrackerTaskDto) => {
    setTasks((current) => current.map((task) => task.id === taskId ? revise(task) : task));
    setSelected((current) => current?.id === taskId ? revise(current) : current);
  };
  // Card menu actions report through a board notice and the error bar.
  const linkFromMenu: TaskCardMenuOptions["onLink"] = (task, target, startAgent) => {
    setError("");
    void api.taskTrackerLink(task.provider, task.id, { sessionId: target.id, startAgent })
      .then((result) => {
        setTasks((current) => current.map((item) => item.id === result.task.id ? result.task : item));
        setSelected((current) => current?.id === result.task.id ? result.task : current);
        if (target.id === sessionId) markLinked(result.task);
        changed();
        showBoardNotice({
          text: startAgent ? tt("tasktrackers.board.sent", { key: task.key, title: target.title }) : tt("tasktrackers.board.linkedTo", { key: task.key, title: target.title }),
          ...(target.id !== sessionId ? { sessionId: target.id } : {}),
        });
      })
      .catch((cause) => setError(messageOf(tt("tasktrackers.board.couldNotLinkKey", { key: task.key }), cause)));
  };
  const dispatchFromMenu = (task: TaskTrackerTaskDto) => {
    if (!activeProjectId) return;
    setError("");
    void dispatchTasks(activeProjectId, [task])
      .then(([result]) => {
        if (!result?.sessionId) throw new Error(result?.error || tt("tasktrackers.board.agentDidNotStart"));
        showBoardNotice({ text: tt("tasktrackers.board.agentStartedKey", { key: task.key }), sessionId: result.sessionId });
      })
      .catch((cause) => setError(messageOf(tt("tasktrackers.board.couldNotStartAgentOn", { key: task.key }), cause)));
  };
  const removeTask = async (task: TaskTrackerTaskDto, mode: "archive" | "delete") => {
    const tracker = PROVIDER_LABELS[task.provider];
    const archive = mode === "archive";
    const confirmed = await confirmAlert(
      archive
        ? tt("tasktrackers.board.archiveTaskConfirm", { key: task.key, title: task.title, tracker })
        : task.provider === "linear"
          // Linear keeps deleted issues in its trash for 30 days.
          ? tt("tasktrackers.board.trashTaskConfirm", { key: task.key, title: task.title })
          : tt("tasktrackers.board.deleteTaskConfirm", { key: task.key, title: task.title, tracker }),
      {
        title: archive ? tt("tasktrackers.board.archiveThisTask") : tt("tasktrackers.board.deleteThisTask"),
        confirmLabel: archive ? tt("tasktrackers.board.archive") : tt("tasktrackers.board.delete"),
        destructive: !archive,
      },
    );
    if (!confirmed) return;
    // The card leaves at once; a rejection puts it back where it was.
    setError("");
    const index = tasks.findIndex((item) => item.id === task.id);
    setTasks((current) => current.filter((item) => item.id !== task.id));
    if (selected?.id === task.id) closeTask(false);
    try {
      await (archive
        ? api.taskTrackerArchiveTask(task.provider, task.id)
        : api.taskTrackerDeleteTask(task.provider, task.id));
      showBoardNotice({ text: archive ? tt("tasktrackers.board.archived", { key: task.key }) : tt("tasktrackers.board.deleted", { key: task.key }) });
    } catch (cause) {
      setTasks((current) => current.some((item) => item.id === task.id)
        ? current
        : index < 0 ? [...current, task] : [...current.slice(0, index), task, ...current.slice(index)]);
      setError(messageOf(archive ? tt("tasktrackers.board.couldNotArchive", { key: task.key }) : tt("tasktrackers.board.couldNotDelete", { key: task.key }), cause));
    }
  };
  const menuFor = (task: TaskTrackerTaskDto): TaskCardMenuOptions => ({
    canWrite,
    handoff: preferences.agentHandoff,
    projectId: activeProjectId,
    sessionId,
    columns: board && preferences.statusUpdates ? columns?.columns ?? null : null,
    links: agentsFor(task),
    linkedHere: linkedIds.has(`${task.provider}:${task.id}`),
    onOpen: (item) => openTask(item),
    onEdit: (item) => openTask(item, undefined, true),
    onMove: moveTask,
    onDispatch: dispatchFromMenu,
    onLink: linkFromMenu,
    onOpenSession: openSession,
    onPick: (item) => {
      closeTask(false);
      setComposing(false);
      setPicking(true);
      setPicked(new Set([item.id]));
    },
    onRemove: (item, mode) => void removeTask(item, mode),
    onNotice: (text) => showBoardNotice({ text }),
  });
  const renderCard = (task: TaskTrackerTaskDto, index: number) => (
    <TaskCardMenu task={task} options={menuFor(task)} disabled={picking}>
      {(menu) => (
        <TaskCard
          index={index}
          task={task}
          linked={linkedIds.has(`${task.provider}:${task.id}`)}
          selected={selected?.id === task.id}
          agents={agentsFor(task).length}
          picking={picking}
          picked={picked.has(task.id)}
          showStatus={false}
          menu={menu}
          onOpen={openTask}
        />
      )}
    </TaskCardMenu>
  );
  const renderRow = (task: TaskTrackerTaskDto, groupId: string) => {
    const assigned = taskPeople(task);
    const due = dueLabel(task.dueAt);
    return (
      <TaskCardMenu key={`${groupId}:${task.id}`} task={task} options={menuFor(task)} disabled={picking}>
        {({ consumeClick, ...menu }) => (
          <button
            type="button"
            {...menu}
            data-task-ref={taskRef(task)}
            className={`tt-list-row${selected?.id === task.id ? " selected" : ""}${picked.has(task.id) ? " picked" : ""}`}
            onClick={(event) => {
              if (consumeClick()) return;
              openTask(task, event.currentTarget);
            }}
            aria-label={picking ? tt("tasktrackers.board.selectTask", { key: task.key, title: task.title }) : tt("tasktrackers.board.openTask", { key: task.key, title: task.title })}
            aria-pressed={picking ? picked.has(task.id) : selected?.id === task.id}
          >
            <span className="tt-list-title">
              <small>{picking && <PickMark picked={picked.has(task.id)} />}<PriorityGlyph priority={task.priority} reserve />{task.key}</small>
              <strong>{task.title}</strong>
              <span className="tt-list-meta">
                {linkedIds.has(`${task.provider}:${task.id}`) && <i><Icon.link /> {tt("tasktrackers.board.linked")}</i>}
                <AgentChip count={agentsFor(task).length} />
                {due && <time className={`tt-due${overdue(task) ? " overdue" : ""}`} dateTime={task.dueAt}>{due}</time>}
                <MetaBadges task={task} />
                {task.labels.slice(0, 2).map((label) => <span className="tt-label" key={label}>{label}</span>)}
              </span>
            </span>
            {grouping !== "status" && <StatusPill status={task.status} />}
            {grouping !== "assignee" && (
              <span className="tt-list-assignee">
                {assigned.length > 0
                  ? <><AvatarStack people={assigned} max={2} /><span className="tt-list-assignee-name">{task.assignees.join(", ")}</span></>
                  : <span className="tt-list-assignee-name muted">{tt("tasktrackers.list.unassigned")}</span>}
              </span>
            )}
          </button>
        )}
      </TaskCardMenu>
    );
  };
  const chooseView = (next: BoardView) => {
    setView(next);
    updateConfig({ ...config, defaultView: next });
  };
  const projectName = (item: TaskTrackerBoardDto): string =>
    projects.find((project) => project.id === item.projectId)?.name ?? tt("tasktrackers.boards.otherBoards");
  const truncated = tasks.length >= TASK_PAGE;

  if (providers === null && loading === "providers") {
    return <div className="tt-board tt-loading-state" role="status"><span className="tt-spinner" /> {tt("tasktrackers.board.loadingTrackers")}</div>;
  }

  if (providers === null) {
    return (
      <div className="tt-board">
        <BoardEmpty
          icon={<Icon.refresh />}
          title={tt("tasktrackers.board.didNotLoad")}
          body={error || tt("tasktrackers.board.serverNoProviders")}
          action={<Button size="sm" onClick={() => setLoadEpoch((value) => value + 1)}>{tt("tasktrackers.boards.tryAgain")}</Button>}
        />
      </div>
    );
  }

  if (enabledProviders.length === 0) {
    return (
      <div className="tt-board">
        <BoardEmpty
          icon={<Icon.widgets />}
          title={tt("tasktrackers.board.allOff")}
          body={tt("tasktrackers.board.turnOnHint")}
          action={<Button size="sm" onClick={() => taskTrackerHostNavigate()}>{tt("tasktrackers.board.manageTrackers")}</Button>}
        />
      </div>
    );
  }

  return (
    <div
      ref={boardRootRef}
      className={`tt-board${composing ? " has-detail has-compose" : ""}${picking ? " floating" : ""}`}
      aria-busy={loading !== null}
    >
      <header className="tt-board-header">
        <div className="tt-provider-tabs" role="tablist" aria-label={tt("tasktrackers.board.providerTabs")}>
          {enabledProviders.map((id) => {
            const info = providers?.find((item) => item.provider === id);
            return (
              <button
                key={id}
                type="button"
                role="tab"
                id={`${providerPanelId}-${id}`}
                aria-controls={providerPanelId}
                aria-selected={provider === id}
                tabIndex={provider === id ? 0 : -1}
                data-provider={id}
                title={PROVIDER_LABELS[id]}
                className={provider === id ? "active" : ""}
                onClick={() => chooseProvider(id)}
                onKeyDown={(event) => handleProviderKeys(event, id)}
              >
                {providerMark(id)}
                {/* A narrow board keeps only the open tracker's name visible;
                    the others stay named for assistive technology. */}
                <span className="tt-provider-name">{PROVIDER_LABELS[id]}</span>
                <i className={info?.mode === "demo" ? "demo" : info?.configured ? "configured" : ""} aria-hidden="true" />
                <span className="sr-only">
                  {info?.mode === "demo" ? tt("tasktrackers.board.demoSandbox") : info?.configured ? tt("tasktrackers.board.configured") : tt("tasktrackers.board.notConfigured")}
                </span>
              </button>
            );
          })}
        </div>
        <div className="tt-header-actions">
          <div className="tt-view-toggle" aria-label={tt("tasktrackers.board.boardView")}>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              iconStart={BoardViewIcon}
              className={view === "kanban" ? "active" : ""}
              aria-pressed={view === "kanban"}
              aria-label={tt("tasktrackers.board.board")}
              onClick={() => chooseView("kanban")}
              title={tt("tasktrackers.board.kanbanView")}
            >{tt("tasktrackers.board.board")}</Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              iconStart={ListViewIcon}
              className={view === "list" ? "active" : ""}
              aria-pressed={view === "list"}
              aria-label={tt("tasktrackers.board.list")}
              onClick={() => chooseView("list")}
              title={tt("tasktrackers.board.listView")}
            >{tt("tasktrackers.board.list")}</Button>
          </div>
          {board && providerReady && canWrite && preferences.agentHandoff && (
            <Button
              size="sm"
              variant="ghost"
              className={picking ? "active" : ""}
              aria-pressed={picking}
              onClick={() => {
                if (picking) stopPicking();
                else {
                  closeTask();
                  setComposing(false);
                  setPicking(true);
                }
              }}
            >{picking ? tt("tasktrackers.boards.done") : tt("tasktrackers.board.select")}</Button>
          )}
          {board && providerReady && canWrite && (
            <Button size="sm" variant="primary" iconStart={PlusIcon} onClick={() => {
              closeTask(false);
              stopPicking();
              setComposing(true);
            }}>
              {tt("tasktrackers.board.newTask")}
            </Button>
          )}
          <IconButton
            icon={RefreshIcon}
            size="sm"
            label={tt("tasktrackers.board.refreshTasks")}
            busy={loading === "tasks"}
            disabled={!board || loading !== null}
            onClick={() => setRefreshKey((value) => value + 1)}
          />
        </div>
      </header>

      <div
        id={providerPanelId}
        className={`tt-provider-panel${providerReady && board ? " tt-provider-panel--filtered" : ""}${providerReady && board && demoMode ? " tt-provider-panel--demo" : ""}`}
        role="tabpanel"
        aria-labelledby={`${providerPanelId}-${provider}`}
      >
        {!providerReady ? (
          <BoardEmpty
            icon={providerMark(provider)}
            title={tt("tasktrackers.board.connectProvider", { provider: PROVIDER_LABELS[provider] })}
            body={connectCopy(provider).board}
            hint={providerInfo?.requiredEnv.length
              ? tt("tasktrackers.board.adminsEnv", { env: providerInfo.requiredEnv.join(", ") })
              : undefined}
            action={canWrite
              ? <Button size="sm" variant="primary" onClick={() => setConnecting(true)}>{tt("tasktrackers.board.connectProvider", { provider: PROVIDER_LABELS[provider] })}</Button>
              : undefined}
          />
        ) : (
          <>
          {demoMode && (
            <p className="tt-demo-banner" role="note">
              <strong>{tt("tasktrackers.board.demoSandbox")}</strong>
              <span>{tt("tasktrackers.board.demoData", { provider: PROVIDER_LABELS[provider] })}</span>
            </p>
          )}
          <div className="tt-board-picker">
            <label>
              <span className="sr-only">{projectNouns(provider).singular}</span>
              <Select
                label={projectNouns(provider).singular}
                value={projectId}
                onChange={(value) => {
                  setProjectId(value);
                  setStatusFilter("all");
                  closeTask();
                }}
                options={[
                  { value: "", label: projectNouns(provider).all },
                  ...shownProjects.map((project) => ({ value: project.id, label: project.name })),
                ]}
              />
            </label>
            <label>
              <span className="sr-only">{tt("tasktrackers.board.boardLabel")}</span>
              <Select
                label={tt("tasktrackers.board.boardLabel")}
                value={boardId}
                disabled={loading === "boards" || shownBoards.length === 0}
                onChange={(value) => {
                  setBoardId(value);
                  setStatusFilter("all");
                  closeTask();
                }}
                options={shownBoards.length === 0
                  ? [{ value: "", label: boards.length > 0 ? tt("tasktrackers.board.allBoardsHidden") : tt("tasktrackers.board.noBoardsFound") }]
                  : (projectId
                    ? shownBoards.map((item) => boardOption(item, null))
                    : groupedBy(shownBoards, projectName).map((item) => boardOption(item, projectName(item))))}
              />
            </label>
            <div className="tt-board-picker-actions">
              <IconButton
                icon={ViewOptionsIcon}
                size="sm"
                label={tt("tasktrackers.board.chooseBoards")}
                pressed={scoping}
                onClick={() => setScoping(true)}
              />
              {canWrite && (
                <Button
                  size="sm"
                  variant="ghost"
                  iconStart={PlusIcon}
                  aria-label={tt("tasktrackers.board.newNoun", { noun: providerNouns(provider).board })}
                  title={tt("tasktrackers.board.newNoun", { noun: providerNouns(provider).board })}
                  onClick={() => setComposingBoard(true)}
                >
                  {tt("tasktrackers.board.newNoun", { noun: providerNouns(provider).board })}
                </Button>
              )}
            </div>
          </div>

          {board && (
            <div className="tt-filters">
              <label className="tt-search">
                <span className="sr-only">{tt("tasktrackers.board.searchTasks")}</span>
                <TextInput
                  type="search"
                  uiSize="sm"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={tt("tasktrackers.board.searchTasks")}
                  aria-label={tt("tasktrackers.board.searchTasks")}
                />
              </label>
              <Select
                className="tt-filter-select"
                label={tt("tasktrackers.board.filterByStatus")}
                ariaLabel={tt("tasktrackers.board.filterByStatus")}
                value={statusFilter}
                onChange={setStatusFilter}
                options={[
                  { value: "all", label: tt("tasktrackers.board.allStatuses", { count: tasks.length }) },
                  ...statuses.map((status) => ({
                    value: status.tasks[0]?.status.id ?? status.id,
                    label: tt("tasktrackers.board.statusWithCount", { status: status.name, count: status.tasks.length }),
                  })),
                ]}
              />
              <DisplayMenu
                list={view === "list"}
                grouping={grouping}
                showCompleted={showCompleted}
                onGrouping={(value) => {
                  setCollapsedGroups(new Set());
                  updateConfig({ ...config, listGroup: value });
                }}
                onShowCompleted={(value) => updateConfig({ ...config, hideCompleted: !value })}
              />
              {(people.length > 0 || unassigned > 0 || assignees.size > 0) && (
                <PeopleFilter
                  people={people}
                  unassigned={unassigned}
                  selected={assignees}
                  me={me}
                  onChange={setAssignees}
                />
              )}
              {filtering && (
                <p
                  className={`tt-filter-summary${assignees.size > 0 && !query.trim() && statusFilter === "all" ? " people-only" : ""}`}
                  role="status"
                >
                  <span>{tt("tasktrackers.board.visibleOf", { visible: visibleTasks.length, total: boardTasks.length })}</span>
                  <button type="button" className="tt-filter-clear" onClick={clearFilters}>{tt("tasktrackers.board.clearFilters")}</button>
                </p>
              )}
            </div>
          )}

          <div className={`tt-board-content${composing ? " has-detail has-compose" : ""}`}>
            <main className="tt-task-surface" aria-busy={loading === "tasks"}>
              {loading === "tasks" && tasks.length === 0 ? (
                <div className="tt-loading-state" role="status"><span className="tt-spinner" /> {tt("tasktrackers.board.loadingTasks")}</div>
              ) : shownBoards.length === 0 && loading !== "boards" ? (
                boards.length > 0 ? (
                  <BoardEmpty
                    icon={<Icon.filter />}
                    title={tt("tasktrackers.board.allHiddenTitle")}
                    body={tt("tasktrackers.board.allHiddenBody")}
                    action={<Button size="sm" onClick={() => setScoping(true)}>{tt("tasktrackers.board.chooseBoardsAction")}</Button>}
                  />
                ) : (
                  <BoardEmpty
                    icon={<Icon.widgets />}
                    title={tt("tasktrackers.board.noBoardsFound")}
                    body={canWrite
                      ? tt("tasktrackers.board.noBoardsBody", { noun: projectNouns(provider).singular.toLocaleLowerCase() })
                      : tt("tasktrackers.board.noBoardsBodyReadOnly", { noun: projectNouns(provider).singular.toLocaleLowerCase() })}
                    action={canWrite ? <Button size="sm" onClick={() => setComposingBoard(true)}>{tt("tasktrackers.board.newBoard")}</Button> : undefined}
                  />
                )
              ) : view === "kanban" && board && columns && (visibleTasks.length > 0 || tasks.length === 0) ? (
                <KanbanBoard
                  label={tt("tasktrackers.board.boardNameKanban", { name: board.name })}
                  provider={provider}
                  lanes={lanes}
                  filtered={query.trim() !== "" || assignees.size > 0}
                  columns={columns}
                  canWrite={canWrite}
                  canMove={preferences.statusUpdates}
                  totalOf={totalOf}
                  renderCard={renderCard}
                  onMove={moveTask}
                  onCreate={createColumn}
                  onRename={renameColumn}
                  onReorder={reorderColumn}
                  onRemove={(column) => void removeColumn(column)}
                />
              ) : tasks.length === 0 && board ? (
                <BoardEmpty icon={<Icon.check />} title={tt("tasktrackers.board.boardIsClear")} body={tt("tasktrackers.board.noOpenTasks")} />
              ) : visibleTasks.length === 0 && waitingForMe ? (
                <div className="tt-loading-state" role="status"><span className="tt-spinner" /> {tt("tasktrackers.board.findingTasks")}</div>
              ) : visibleTasks.length === 0 ? (
                <FilteredEmpty
                  provider={provider}
                  searching={query.trim() !== "" || statusFilter !== "all"}
                  assignees={assignees}
                  people={people}
                  knowsMe={me !== null}
                  onlyDone={boardTasks.length === 0 && tasks.length > 0}
                  onClear={clearFilters}
                  onShowCompleted={() => updateConfig({ ...config, hideCompleted: false })}
                />
              ) : view === "kanban" ? (
                <KanbanBoard
                  label={tt("tasktrackers.board.boardNameKanban", { name: board?.name ?? tt("tasktrackers.board.taskFallback") })}
                  provider={provider}
                  lanes={lanes}
                  columns={null}
                  canWrite={false}
                  canMove={false}
                  totalOf={totalOf}
                  renderCard={renderCard}
                  onMove={moveTask}
                  onCreate={createColumn}
                  onRename={renameColumn}
                  onReorder={reorderColumn}
                  onRemove={(column) => void removeColumn(column)}
                />
              ) : (
                <TaskList
                  label={tt("tasktrackers.board.boardNameList", { name: board?.name ?? tt("tasktrackers.board.taskFallback") })}
                  grouping={grouping}
                  groups={listGroups(grouping, lanes, visibleTasks, people)}
                  collapsed={collapsedGroups}
                  onToggle={(id) => setCollapsedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })}
                  renderRow={renderRow}
                />
              )}
              {truncated && visibleTasks.length > 0 && (
                <p className="tt-board-note">
                  {tt("tasktrackers.board.truncated", { count: TASK_PAGE })}
                  {board?.url ? <> <a href={board.url} target="_blank" rel="noreferrer">{tt("tasktrackers.board.openBoardIn", { provider: PROVIDER_LABELS[provider] })}</a></> : null}
                </p>
              )}
            </main>
            {composing && board ? (
              <TaskComposer
                provider={provider}
                board={board}
                projectId={activeProjectId}
                canStartAgent={preferences.agentHandoff}
                onClose={() => setComposing(false)}
                onCreated={(task, startedSessionId) => {
                  setComposing(false);
                  setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
                  showBoardNotice({
                    text: startedSessionId ? tt("tasktrackers.board.createdAgent", { key: task.key }) : tt("tasktrackers.board.createdKey", { key: task.key }),
                    ...(startedSessionId ? { sessionId: startedSessionId } : {}),
                  });
                }}
              />
            ) : selected && (
              <TaskDetail
                task={selected}
                sessionId={sessionId}
                projectId={activeProjectId}
                links={agentsFor(selected)}
                linked={linkedIds.has(`${selected.provider}:${selected.id}`)}
                demo={demoMode}
                loading={detailLoading}
                initialEditing={editSelectedOnOpen}
                onClose={closeTask}
                onTaskChanged={updateTask}
                onTaskRevised={reviseTask}
                onBackgroundError={setError}
              />
            )}
          </div>
          </>
        )}
      </div>
      {picking && board && (
        <DispatchBar
          tasks={tasks.filter((task) => picked.has(task.id))}
          projectId={activeProjectId}
          onClear={stopPicking}
          onDone={(results) => {
            const started = results.filter((result) => result.sessionId);
            const failed = results.filter((result) => result.error);
            stopPicking();
            showBoardNotice({
              failed: failed.length > 0,
              text: failed.length
                ? tt("tasktrackers.board.dispatchFailed", { started: started.length, failed: failed.length, list: failed.map((item) => `${item.taskKey ?? item.taskId} (${item.error})`).join(", ") })
                : tt("tasktrackers.board.agentsStarted", { count: started.length }),
              ...(started.length === 1 ? { sessionId: started[0]!.sessionId! } : {}),
            });
          }}
        />
      )}
      {connecting && (
        <ConnectWizard
          provider={provider}
          scope={management?.canManage ? "space" : "personal"}
          onClose={() => setConnecting(false)}
        />
      )}
      {scoping && (
        <BoardScopeDialog provider={provider} projects={projects} projectId={activeProjectId} onClose={() => setScoping(false)} />
      )}
      {composingBoard && (
        <BoardComposer
          provider={provider}
          projects={shownProjects}
          projectId={projectId}
          onClose={() => setComposingBoard(false)}
          onCreated={boardCreated}
        />
      )}
      {error && <div className="tt-board-error" role="alert">
        <span>{error}</span>
        <div>
          <Button
            size="sm"
            onClick={() => {
              setError("");
              if (selected) openTask(selected);
              else setLoadEpoch((value) => value + 1);
            }}
          >{tt("tasktrackers.boards.tryAgain")}</Button>
          <Button size="sm" onClick={() => setError("")}>{tt("tasktrackers.board.dismiss")}</Button>
        </div>
      </div>}
    </div>
  );
}

export function LinkedTaskWidget({ sessionId }: Pick<WidgetRenderContext, "sessionId">) {
  const { preferences } = useManagement();
  const [linked, setLinked] = useState<TaskTrackerSessionTaskDto | null>(null);
  const [task, setTask] = useState<TaskTrackerTaskDto | null>(null);
  const [statusId, setStatusId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!sessionId) {
      setLinked(null);
      setTask(null);
      return;
    }
    let active = true;
    const load = () => {
      setLoading(true);
      setError("");
      void api.taskTrackerSessionTasks(sessionId)
        .then(async (items) => {
          const latest = [...items].sort((a, b) => b.updatedAtSeq - a.updatedAtSeq)[0] ?? null;
          if (!active) return;
          setLinked(latest);
          if (!latest) {
            setTask(null);
            return;
          }
          const detail = await api.taskTrackerTask(latest.provider, latest.taskId);
          if (active) {
            setTask(detail);
            setStatusId(detail.status.id);
          }
        })
        .catch((cause) => {
          if (active) setError(messageOf(tt("tasktrackers.board.couldNotLoadLinked"), cause));
        })
        .finally(() => { if (active) setLoading(false); });
    };
    load();
    window.addEventListener(TASK_TRACKER_CHANGED, load);
    return () => {
      active = false;
      window.removeEventListener(TASK_TRACKER_CHANGED, load);
    };
  }, [reloadKey, sessionId]);

  const update = async (nextStatusId: string) => {
    if (!sessionId || !task || !nextStatusId || nextStatusId === task.status.id) return;
    setLoading(true);
    setError("");
    try {
      const updated = await api.taskTrackerUpdateStatus(task.provider, task.id, {
        sessionId,
        statusId: nextStatusId,
      });
      setTask(updated);
      setStatusId(updated.status.id);
      setLinked((current) => current ? {
        ...current,
        statusId: updated.status.id,
        statusName: updated.status.name,
        completed: updated.status.category === "done",
      } : current);
      changed();
    } catch (cause) {
      setError(messageOf(tt("tasktrackers.board.couldNotUpdateLinked"), cause));
    } finally {
      setLoading(false);
    }
  };

  if (!sessionId) return <div className="tt-linked-empty"><Icon.link /><span>{tt("tasktrackers.board.openSessionToLink")}</span></div>;
  if (loading && !linked) return <div className="tt-linked-empty" role="status"><span className="tt-spinner" /> {tt("tasktrackers.board.loadingLinked")}</div>;
  if (!linked && error) return <div className="tt-linked-empty tt-linked-load-error" role="alert">
    <span>{error}</span>
    <Button size="sm" onClick={() => setReloadKey((value) => value + 1)}>{tt("tasktrackers.boards.tryAgain")}</Button>
  </div>;
  if (!linked) return <div className="tt-linked-empty"><Icon.link /><span>{tt("tasktrackers.board.noLinkedTask")}</span></div>;

  const status: TaskTrackerStatusDto = task?.status ?? {
    id: linked.statusId,
    name: linked.statusName,
    category: linked.completed ? "done" : "unknown",
  };
  const statuses = task?.availableStatuses ?? [];
  const doneStatus = statuses.find((item) => item.category === "done");
  return (
    <div className="tt-linked-widget" aria-busy={loading}>
      <div className="tt-linked-main">
        {providerMark(linked.provider)}
        <div>
          <span>{linked.taskKey}</span>
          <strong>{linked.title}</strong>
        </div>
        <StatusPill status={status} />
      </div>
      {task && statuses.length > 0 && !linked.completed && preferences.statusUpdates && (
        <div className="tt-linked-actions">
          <Select
            label={tt("tasktrackers.board.linkedTaskStatus")}
            ariaLabel={tt("tasktrackers.board.linkedTaskStatus")}
            value={statusId}
            disabled={loading}
            onChange={setStatusId}
            options={[
              { value: task.status.id, label: task.status.name },
              ...statuses.filter((item) => item.id !== task.status.id).map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
          />
          <Button
            size="sm"
            disabled={loading || statusId === task.status.id}
            onClick={() => void update(statusId)}
          >{tt("tasktrackers.board.update")}</Button>
          {doneStatus && (
            <Button
              size="sm"
              className="tt-complete"
              iconStart={CheckIcon}
              disabled={loading}
              onClick={() => void update(doneStatus.id)}
            >{tt("tasktrackers.board.complete")}</Button>
          )}
          {task.url && <a href={task.url} target="_blank" rel="noreferrer" aria-label={tt("tasktrackers.board.openKeyIn", { key: task.key, provider: PROVIDER_LABELS[task.provider] })}>
            <Icon.external />
          </a>}
        </div>
      )}
      {loading && linked && <div className="tt-linked-updating" role="status">
        <span className="tt-button-spinner" aria-hidden="true" /> {tt("tasktrackers.board.updatingTracker")}
      </div>}
      {linked.completed && <div className="tt-linked-done">
        <span><Icon.check /> {tt("tasktrackers.board.completed")}</span>
        {task?.url && <a
          href={task.url}
          target="_blank"
          rel="noreferrer"
          aria-label={tt("tasktrackers.board.openKeyIn", { key: task.key, provider: PROVIDER_LABELS[task.provider] })}
        ><Icon.external /></a>}
      </div>}
      {error && <p className="tt-error" role="alert">{error}</p>}
    </div>
  );
}

function TaskTrackerSettings({ config, updateConfig }: WidgetSettingsContext) {
  return (
    <div className="widget-schema-settings" aria-label={tt("tasktrackers.board.settingsAria")}>
      <Select
        label={tt("tasktrackers.board.defaultView")}
        value={config.defaultView === "list" ? "list" : "kanban"}
        onChange={(value) => updateConfig({ ...config, defaultView: value })}
        options={[
          { value: "kanban", label: tt("tasktrackers.board.kanbanBoard") },
          { value: "list", label: tt("tasktrackers.board.taskList") },
        ]}
      />
      <Checkbox
        checked={config.hideCompleted === true}
        onChange={(checked) => updateConfig({ ...config, hideCompleted: checked })}
        label={<strong>{tt("tasktrackers.board.hideCompleted")}</strong>}
      />
    </div>
  );
}

const RENDERERS: Record<string, (context: WidgetRenderContext) => ReactNode> = {
  "task-trackers.board": (context) => (
    <TaskTrackerBoard
      {...context}
      activeProjectId={context.projectId}
      memoryKey={`polyth.task-trackers.widget.${context.instanceId}`}
    />
  ),
  "task-trackers.linked-task": (context) => <LinkedTaskWidget sessionId={context.sessionId} />,
  "task-trackers.overview": (context) => <TaskTrackerOverview projectId={context.projectId} />,
};

export const TASK_TRACKER_WIDGET_PLUGIN: WidgetPlugin = {
  id: "task-trackers",
  name: tt("tasktrackers.surface.settingsLabel"),
  widgets: [
    {
      id: "task-trackers.board",
      title: tt("tasktrackers.widget.board.title"),
      description: tt("tasktrackers.widget.board.body"),
      kind: "widget",
      defaultSlot: "workspace.main",
      supportedSlots: ["workspace.left", "workspace.main", "workspace.right", "workspace.bottom"],
      category: tt("tasktrackers.surface.settingsLabel"),
      capabilities: ["polyth.taskTrackers", "jira", "trello", "linear", "kanban"],
      defaultSize: { w: 8, h: 7 },
      minSize: { w: 4, h: 4 },
      maxSize: { w: 12, h: 12 },
      audience: "standard",
      scope: "workspace",
      resizable: true,
      recommended: true,
      defaultVisible: false,
      settingsSchema: boardSettings(),
      render: RENDERERS["task-trackers.board"]!,
      settingsRender: (context) => <TaskTrackerSettings {...context} />,
    },
    {
      id: "task-trackers.linked-task",
      title: tt("tasktrackers.widget.linked.title"),
      description: tt("tasktrackers.widget.linked.body"),
      kind: "mini-widget",
      defaultSlot: "session.composer.before",
      supportedSlots: ["session.composer.before", "workspace.header", "workspace.left", "workspace.right"],
      category: tt("tasktrackers.surface.settingsLabel"),
      capabilities: ["polyth.taskTrackers", "agent handoff"],
      defaultSize: { w: 5, h: 2 },
      minSize: { w: 3, h: 2 },
      maxSize: { w: 8, h: 5 },
      audience: "standard",
      scope: "plugin",
      resizable: true,
      recommended: true,
      defaultVisible: false,
      render: RENDERERS["task-trackers.linked-task"]!,
      settingsRender: () => (
        <div className="builtin-widget-settings">
          <span>{tt("tasktrackers.board.linkedWidgetUses")}</span>
          <small>{tt("tasktrackers.board.linkedWidgetWrites")}</small>
        </div>
      ),
    },
    {
      id: "task-trackers.overview",
      title: tt("tasktrackers.widget.overview.title"),
      description: tt("tasktrackers.widget.overview.body"),
      kind: "widget",
      defaultSlot: "workspace.right",
      supportedSlots: ["workspace.left", "workspace.main", "workspace.right", "workspace.bottom"],
      category: tt("tasktrackers.surface.settingsLabel"),
      capabilities: ["polyth.taskTrackers", "jira", "trello", "linear", "progress"],
      defaultSize: { w: 4, h: 3 },
      minSize: { w: 3, h: 2 },
      maxSize: { w: 8, h: 6 },
      audience: "standard",
      scope: "workspace",
      resizable: true,
      recommended: true,
      defaultVisible: false,
      render: RENDERERS["task-trackers.overview"]!,
      settingsRender: () => (
        <div className="builtin-widget-settings">
          <span>{tt("tasktrackers.board.overviewWidgetShows")}</span>
          <small>{tt("tasktrackers.board.overviewWidgetChoose")}</small>
        </div>
      ),
    },
  ] satisfies readonly WidgetDefinition[],
};

/** The catalog filtered by the Space's widget preferences. */
export function enabledWidgetPlugin(
  enabled: Readonly<Record<TaskTrackerWidgetId, boolean>>,
  base: WidgetPlugin = TASK_TRACKER_WIDGET_PLUGIN,
): WidgetPlugin {
  return {
    ...base,
    widgets: (base.widgets ?? []).filter((widget) =>
      enabled[widget.id as TaskTrackerWidgetId] !== false),
  };
}

/** The catalog with its registration text in the active locale. */
function localizedWidgetPlugin(): WidgetPlugin {
  return {
    ...TASK_TRACKER_WIDGET_PLUGIN,
    name: tt("tasktrackers.surface.settingsLabel"),
    widgets: (TASK_TRACKER_WIDGET_PLUGIN.widgets ?? []).map((widget) => {
      const copy = widgetCopy(widget.id as TaskTrackerWidgetId);
      return {
        ...widget,
        title: copy.title,
        description: copy.body,
        category: tt("tasktrackers.surface.settingsLabel"),
        ...(widget.id === "task-trackers.board" ? { settingsSchema: boardSettings() } : {}),
      };
    }),
  };
}

export function createTaskTrackerInstaller(host: WebPackageHost): () => () => void {
  configureTaskTrackerHost(host);
  let uninstall: (() => void) | null = null;
  return () => {
    uninstall?.();
    // Register the full catalog immediately; narrow it once the Space's
    // widget preferences arrive and whenever they change.
    let key = "";
    const base = hasLocale() ? localizedWidgetPlugin() : TASK_TRACKER_WIDGET_PLUGIN;
    let unregister = host.widgets.registerPlugin(base);
    const sync = () => {
      const enabled = currentPreferences().widgets;
      const next = JSON.stringify(enabled);
      if (next === key) return;
      const first = key === "";
      key = next;
      if (first && Object.values(enabled).every(Boolean)) return;
      unregister();
      unregister = host.widgets.registerPlugin(enabledWidgetPlugin(enabled, base));
    };
    let stopSync: (() => void) | null = null;
    if (typeof window !== "undefined" && typeof fetch === "function") {
      stopSync = subscribeManagement(() => {
        if (managementSnapshot().data) sync();
      });
      void loadManagement();
    }
    // The per-person board selections (account-wide and per project) follow
    // the account; the local cache keeps working without a preference seam.
    const preferences: Array<[string, WebUiPreferenceAdapter]> = [
      [BOARD_SCOPE_PREFERENCE, boardScopeAdapter],
      [PROJECT_BOARD_SCOPE_PREFERENCE, projectBoardScopeAdapter],
    ];
    const stopPreferences = preferences.flatMap(([id, adapter]) => {
      try {
        const stop = host.preferences?.register(id, adapter);
        return stop ? [stop] : [];
      } catch {
        return [];
      }
    });
    const current = () => {
      for (const stop of stopPreferences) stop();
      stopSync?.();
      unregister();
      if (uninstall === current) uninstall = null;
    };
    uninstall = current;
    return current;
  };
}

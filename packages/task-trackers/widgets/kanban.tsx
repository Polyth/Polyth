import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  TaskTrackerBoardColumnsDto,
  TaskTrackerColumnDto,
  TaskTrackerProvider,
  TaskTrackerStatusCategory,
  TaskTrackerTaskDto,
} from "@polyth/contracts";
import { PROVIDER_LABELS, providerNouns } from "./brand.tsx";
import { tt } from "./i18n.ts";
import {
  ArchiveIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DeleteIcon,
  EditIcon,
  ExternalLinkIcon,
  IconButton,
  Menu,
  MoreIcon,
  PlusIcon,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";
import { isImeComposing } from "@polyth/web-sdk";

/** One kanban column with the tasks shown in it. `column` is absent for a
 *  lane made only from task statuses: the board's columns are unknown, or a
 *  task's status is on none of them. */
export interface KanbanLane {
  id: string;
  name: string;
  category: TaskTrackerStatusCategory;
  tasks: TaskTrackerTaskDto[];
  column?: TaskTrackerColumnDto;
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

const statusLanes = (tasks: readonly TaskTrackerTaskDto[]): KanbanLane[] => {
  const lanes = new Map<string, KanbanLane>();
  for (const task of tasks) {
    const key = `${task.status.category}:${task.status.id || task.status.name}`;
    const lane = lanes.get(key) ?? {
      id: key,
      name: task.status.name || categoryLabel(task.status.category),
      category: task.status.category,
      tasks: [],
    };
    lane.tasks.push(task);
    lanes.set(key, lane);
  }
  return [...lanes.values()].sort((left, right) =>
    CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category]
    || left.name.localeCompare(right.name));
};

/** Board columns in board order, empty ones included; tasks whose status is
 *  on no column follow in lanes of their own. Without columns, lanes come
 *  from the tasks' statuses. */
export function kanbanLanes(
  columns: readonly TaskTrackerColumnDto[] | null,
  tasks: readonly TaskTrackerTaskDto[],
): KanbanLane[] {
  if (!columns) return statusLanes(tasks);
  const lanes: KanbanLane[] = columns.map((column) => ({
    id: column.id,
    name: column.name,
    category: column.category,
    tasks: [],
    column,
  }));
  const rest: TaskTrackerTaskDto[] = [];
  for (const task of tasks) {
    const lane = lanes.find((item) => item.column!.statusIds.includes(task.status.id));
    if (lane) lane.tasks.push(task);
    else rest.push(task);
  }
  return [...lanes, ...statusLanes(rest)];
}

const TASK_MIME = "application/x-polyth-tracker-task";

/** A column shown before the tracker created it: no actions, no drops. */
export const PENDING_COLUMN_PREFIX = "pending-column:";
export const isPendingColumn = (column: TaskTrackerColumnDto): boolean =>
  column.id.startsWith(PENDING_COLUMN_PREFIX);

export interface KanbanBoardProps {
  label: string;
  provider: TaskTrackerProvider;
  lanes: readonly KanbanLane[];
  /** A search or people filter is on: a narrow board, which shows one column
   *  at a time, skips the columns it emptied. */
  filtered?: boolean;
  /** The board's columns; null while unknown. */
  columns: TaskTrackerBoardColumnsDto | null;
  /** The caller may change this board (columns and task moves). */
  canWrite: boolean;
  /** Task moves are allowed (Status updates on). */
  canMove: boolean;
  /** Tasks per column across the whole board, filters aside. */
  totalOf: (column: TaskTrackerColumnDto) => number;
  renderCard: (task: TaskTrackerTaskDto, index: number) => ReactNode;
  onMove: (task: TaskTrackerTaskDto, column: TaskTrackerColumnDto) => void;
  onCreate: (name: string) => Promise<boolean>;
  onRename: (column: TaskTrackerColumnDto, name: string) => Promise<boolean>;
  onReorder: (column: TaskTrackerColumnDto, position: number) => void;
  onRemove: (column: TaskTrackerColumnDto) => void;
}

function ColumnNameField({
  initial,
  label,
  onSubmit,
  onCancel,
}: {
  initial: string;
  label: string;
  onSubmit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  // Enter submits and then the input blurs; Escape unmounts it. A ref, not
  // state, so the blur that follows sees either.
  const settled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const submit = async () => {
    const name = value.trim();
    if (settled.current) return;
    settled.current = true;
    if (!name || name === initial) {
      onCancel();
      return;
    }
    setBusy(true);
    const done = await onSubmit(name);
    setBusy(false);
    if (done) {
      onCancel();
      return;
    }
    settled.current = false;
    inputRef.current?.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      settled.current = true;
      onCancel();
    }
  };
  return (
    <TextInput
      ref={inputRef}
      uiSize="sm"
      className="tt-column-name-input"
      value={value}
      maxLength={255}
      disabled={busy}
      aria-label={label}
      placeholder={tt("tasktrackers.kanban.columnName")}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => void submit()}
    />
  );
}

const reducedMotion = (): boolean =>
  typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && (window.matchMedia("(prefers-reduced-motion: reduce)").matches
    || document.documentElement.dataset.reduceAnimations === "true");

const isRtl = (element: Element): boolean =>
  typeof getComputedStyle === "function" && getComputedStyle(element).direction === "rtl";

/** Scrolls `container` sideways so `child` starts at its inline start, without
 *  moving anything vertically (scrollIntoView would also scroll the page). */
function scrollInlineTo(container: HTMLElement, child: HTMLElement, smooth: boolean): void {
  const box = container.getBoundingClientRect();
  const rect = child.getBoundingClientRect();
  const style = typeof getComputedStyle === "function" ? getComputedStyle(container) : null;
  const pad = Number.parseFloat(style?.scrollPaddingInlineStart ?? "") || 0;
  const delta = isRtl(container) ? rect.right - box.right + pad : rect.left - box.left - pad;
  if (Math.abs(delta) < 1) return;
  if (typeof container.scrollBy === "function") container.scrollBy({ left: delta, behavior: smooth ? "smooth" : "auto" });
  else container.scrollLeft += delta;
}

/** The child of `container` that shows the most of itself. */
function mostVisible(container: HTMLElement, children: readonly HTMLElement[]): number {
  const box = container.getBoundingClientRect();
  let best = -1;
  let bestWidth = 0;
  children.forEach((child, index) => {
    const rect = child.getBoundingClientRect();
    const visible = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
    if (visible > bestWidth + 1) {
      best = index;
      bestWidth = visible;
    }
  });
  return best;
}

/**
 * A narrow board shows one column at a time. This row names every column
 * with its count, follows the swipe and jumps to a column on a tap. Wide
 * boards hide it (CSS): every column is in view there.
 */
function ColumnPager({ lanes, scroller }: { lanes: readonly KanbanLane[]; scroller: RefObject<HTMLDivElement | null> }) {
  const [active, setActive] = useState(0);
  const pagerRef = useRef<HTMLElement>(null);
  const columns = () => [...scroller.current?.children ?? []]
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("tt-column"));
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const index = mostVisible(element, columns());
      if (index >= 0) setActive(index);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      element.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller, lanes.length]);
  // Keep the current column's tab in view when the pager itself overflows.
  useEffect(() => {
    const pager = pagerRef.current;
    const item = pager?.children[active];
    if (!pager || !(item instanceof HTMLElement) || pager.scrollWidth <= pager.clientWidth) return;
    const box = pager.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    if (rect.left < box.left || rect.right > box.right) scrollInlineTo(pager, item, !reducedMotion());
  }, [active]);
  if (lanes.length < 2) return null;
  return (
    <nav ref={pagerRef} className="tt-pager" aria-label={tt("tasktrackers.kanban.boardColumns")}>
      {lanes.map((lane, index) => (
        <button
          key={lane.id}
          type="button"
          className={`tt-pager-item ${lane.category}${lane.tasks.length === 0 ? " empty" : ""}`}
          aria-current={index === active ? "true" : undefined}
          aria-label={tt(lane.tasks.length === 1 ? "tasktrackers.kanban.laneAriaOne" : "tasktrackers.kanban.laneAria", { name: lane.name, count: lane.tasks.length })}
          onClick={() => {
            const target = columns()[index];
            setActive(index);
            if (target && scroller.current) scrollInlineTo(scroller.current, target, !reducedMotion());
          }}
        >
          <span className="tt-column-dot" aria-hidden="true" />
          <span className="tt-pager-name">{lane.name}</span>
          <span className="tt-pager-count" aria-hidden="true">{lane.tasks.length}</span>
        </button>
      ))}
    </nav>
  );
}

export function KanbanBoard({
  label,
  provider,
  lanes,
  filtered = false,
  columns,
  canWrite,
  canMove,
  totalOf,
  renderCard,
  onMove,
  onCreate,
  onRename,
  onReorder,
  onRemove,
}: KanbanBoardProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** Column whose menu a right-click on its header opened. */
  const [columnMenu, setColumnMenu] = useState<string | null>(null);
  const editable = canWrite && columns?.editable === true;
  const draggable = canWrite && canMove && columns !== null;
  const columnCount = columns?.columns.filter((column) => !isPendingColumn(column)).length ?? 0;
  const taskOf = (id: string) => lanes.flatMap((lane) => lane.tasks).find((task) => task.id === id);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const dragStart = (event: ReactDragEvent<HTMLDivElement>, task: TaskTrackerTaskDto) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(TASK_MIME, task.id);
    setDragging(task.id);
  };
  const dragEnd = () => {
    setDragging(null);
    setOver(null);
  };
  const dragOver = (event: ReactDragEvent<HTMLElement>, lane: KanbanLane) => {
    if (!lane.column || isPendingColumn(lane.column) || !event.dataTransfer.types.includes(TASK_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (over !== lane.id) setOver(lane.id);
  };
  const drop = (event: ReactDragEvent<HTMLElement>, lane: KanbanLane) => {
    if (!lane.column || isPendingColumn(lane.column)) return;
    event.preventDefault();
    const task = taskOf(event.dataTransfer.getData(TASK_MIME));
    dragEnd();
    if (task && !lane.tasks.some((item) => item.id === task.id)) onMove(task, lane.column);
  };

  return (
    <div className={`tt-kanban-frame${filtered ? " filtered" : ""}`}>
    <ColumnPager lanes={lanes} scroller={scrollerRef} />
    <div ref={scrollerRef} className={`tt-kanban${dragging ? " dragging" : ""}`} aria-label={label}>
      {lanes.map((lane) => {
        const pending = lane.column !== undefined && isPendingColumn(lane.column);
        // A pending column has no actions until the tracker has created it.
        const column = pending ? undefined : lane.column;
        const index = column ? columns?.columns.findIndex((item) => item.id === column.id) ?? -1 : -1;
        const total = column ? totalOf(column) : lane.tasks.length;
        const removable = columns?.removal === "archive" || total === 0;
        return (
          <section
            className={`tt-column ${lane.category}${over === lane.id ? " drop-target" : ""}${pending ? " pending" : ""}${lane.tasks.length === 0 ? " empty" : ""}`}
            key={lane.id}
            aria-busy={pending || undefined}
            aria-label={tt(lane.tasks.length === 1 ? "tasktrackers.kanban.laneAriaOne" : "tasktrackers.kanban.laneAria", { name: lane.name, count: lane.tasks.length })}
            onDragOver={(event) => dragOver(event, lane)}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(event) => drop(event, lane)}
          >
            <header
              onContextMenu={editable && column && renaming !== column.id ? (event) => {
                event.preventDefault();
                setColumnMenu(column.id);
              } : undefined}
            >
              <span className="tt-column-dot" />
              {column && renaming === column.id ? (
                <ColumnNameField
                  initial={column.name}
                  label={tt("tasktrackers.kanban.renameColumn", { name: column.name })}
                  onSubmit={(name) => onRename(column, name)}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <strong
                  onDoubleClick={editable && column ? () => setRenaming(column.id) : undefined}
                  title={lane.name}
                >{lane.name}</strong>
              )}
              <span className="tt-column-count">{lane.tasks.length}</span>
              {editable && column && renaming !== column.id && (
                <Menu
                  label={tt("tasktrackers.kanban.columnActions", { name: column.name })}
                  title={column.name}
                  align="end"
                  open={columnMenu === column.id}
                  onOpenChange={(open) => setColumnMenu(open ? column.id : null)}
                  entries={[
                    { id: "rename", label: tt("tasktrackers.kanban.rename"), icon: EditIcon, onSelect: () => setRenaming(column.id) },
                    {
                      id: "left",
                      label: tt("tasktrackers.kanban.moveLeft"),
                      icon: ChevronLeftIcon,
                      disabled: index <= 0,
                      onSelect: () => onReorder(column, index - 1),
                    },
                    {
                      id: "right",
                      label: tt("tasktrackers.kanban.moveRight"),
                      icon: ChevronRightIcon,
                      disabled: index < 0 || index >= columnCount - 1,
                      onSelect: () => onReorder(column, index + 1),
                    },
                    "separator",
                    columns?.removal === "archive"
                      ? {
                          id: "archive",
                          label: tt("tasktrackers.kanban.archiveList"),
                          icon: ArchiveIcon,
                          danger: true,
                          onSelect: () => onRemove(column),
                        }
                      : {
                          id: "delete",
                          label: tt("tasktrackers.kanban.deleteColumn"),
                          icon: DeleteIcon,
                          danger: true,
                          disabled: !removable || columnCount <= 1,
                          ...(!removable ? { detail: tt("tasktrackers.kanban.moveTasksFirst") } : {}),
                          onSelect: () => onRemove(column),
                        },
                  ]}
                >
                  {(trigger) => (
                    <IconButton
                      {...trigger}
                      className="tt-column-menu"
                      icon={MoreIcon}
                      size="sm"
                      label={tt("tasktrackers.kanban.columnActions", { name: column.name })}
                    />
                  )}
                </Menu>
              )}
            </header>
            <div className="tt-column-cards">
              {lane.tasks.map((task, taskIndex) => draggable ? (
                <div
                  key={task.id}
                  className={`tt-card-drag${dragging === task.id ? " dragging" : ""}`}
                  draggable
                  onDragStart={(event) => dragStart(event, task)}
                  onDragEnd={dragEnd}
                >{renderCard(task, taskIndex)}</div>
              ) : <div key={task.id} className="tt-card-drag">{renderCard(task, taskIndex)}</div>)}
              {lane.tasks.length === 0 && column && (
                <p className="tt-column-empty">{dragging ? tt("tasktrackers.kanban.dropHere") : tt("tasktrackers.kanban.noTasks")}</p>
              )}
              {pending && <p className="tt-column-empty" role="status">{tt("tasktrackers.kanban.adding")}</p>}
            </div>
          </section>
        );
      })}
      {editable && (
        <div className="tt-column-add">
          {adding ? (
            <ColumnNameField
              initial=""
              label={tt("tasktrackers.kanban.newColumnName")}
              onSubmit={onCreate}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button type="button" className="tt-column-add-button" onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden="true" size={16} />
              <span>{tt("tasktrackers.kanban.addColumn")}</span>
            </button>
          )}
        </div>
      )}
      {canWrite && columns && !columns.editable && columns.manageUrl && (
        <div className="tt-column-add">
          <a className="tt-column-add-button" href={columns.manageUrl} target="_blank" rel="noreferrer">
            <ExternalLinkIcon aria-hidden="true" size={16} />
            <span>{tt("tasktrackers.kanban.editIn", { noun: providerNouns(provider).columns, provider: PROVIDER_LABELS[provider] })}</span>
          </a>
        </div>
      )}
    </div>
    </div>
  );
}

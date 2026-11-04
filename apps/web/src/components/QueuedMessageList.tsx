// Queued follow-up messages: quiet lines above the composer. A pointer that
// hovers brings a row's handle and actions over it; on touch the whole block
// opens the queue sheet with the same actions at full size. Editing belongs in
// the main composer, which keeps the queued item's original position; its row
// stays in place meanwhile with a way out.
import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { QueueItemDto, SessionEvent } from "@polyth/contracts";
import { queuePausedAfterUserInterrupt } from "@polyth/session/queue-pause";
import { api } from "@polyth/session/web-api";
import { setUiError, usePendingSends, useStore } from "../store.ts";
import { announce } from "./a11y/live.tsx";
import { markQueuedPromptLaunch, playQueueChipExit, queueChipExitAvailable } from "../queueLaunchMotion.ts";
import { useShellMode } from "../responsiveShell.ts";
import { tr } from "../i18n/index.ts";
import Button from "./ui/Button.tsx";
import IconButton from "./ui/IconButton.tsx";
import Icon from "./ui/Icon.tsx";
import ResponsiveOverlay from "./ui/ResponsiveOverlay.tsx";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DeleteIcon,
  DragHandleIcon,
  EditIcon,
  EnterIcon,
  MoreIcon,
  PauseIcon,
  PlayIcon,
  QueueNextIcon,
  WarningIcon,
} from "./ui/icons.ts";

const QUEUE_DRAG_TYPE = "application/x-polyth-queued-message";
/** Rows shown before the rest fold away behind "N more". */
const QUEUE_PREVIEW_ROWS = 2;

const HOVERLESS_QUERY = "(hover: none)";
function subscribeHoverless(listener: () => void): () => void {
  const query = window.matchMedia?.(HOVERLESS_QUERY);
  query?.addEventListener?.("change", listener);
  return () => query?.removeEventListener?.("change", listener);
}
const readHoverless = (): boolean => window.matchMedia?.(HOVERLESS_QUERY)?.matches ?? false;

/** Move one item to the target item's position without changing its metadata. */
export function moveQueuedItem(
  items: readonly QueueItemDto[],
  sourceId: string,
  targetId: string,
): QueueItemDto[] {
  const from = items.findIndex((item) => item.id === sourceId);
  const to = items.findIndex((item) => item.id === targetId);
  if (from < 0 || to < 0 || from === to) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next.map((item, position) => ({ ...item, position }));
}

/** The newest ordinary queue item is the one an empty follow-up Send promotes. */
export function latestSteerableQueuedItem(items: readonly QueueItemDto[]): QueueItemDto | null {
  return items.findLast((item) => !item.heldForReview && !item.hiddenUserMessage) ?? null;
}

const QUEUE_LEFT_EVENT_TYPES = new Set(["queue/dispatched", "queue/removed"]);
const TURN_END_EVENT_TYPES = new Set(["turn/stopped", "turn/failed"]);
const NO_IDS: ReadonlySet<string> = new Set();

/** Queue rows the event log already shows outside the queue. The server keeps
 *  a dispatched row (reserved) until the runtime confirms the turn, but its
 *  `user/message` — stamped with the `queueId` — is in the chat from the start
 *  of admission. Waiting for the confirmation and a queue re-read showed the
 *  same prompt in both places. A turn that ends without `queue/dispatched` was
 *  refused, and its row is back in the queue. */
export function departedQueueIds(events: readonly Pick<SessionEvent, "type" | "data">[]): Set<string> {
  const departed = new Set<string>();
  let admitted: string | null = null;
  for (const event of events) {
    const queueId = (event.data as { queueId?: unknown } | undefined)?.queueId;
    if (QUEUE_LEFT_EVENT_TYPES.has(event.type)) {
      if (typeof queueId === "string") departed.add(queueId);
    } else if (event.type === "user/message") {
      admitted = typeof queueId === "string" ? queueId : null;
    } else if (TURN_END_EVENT_TYPES.has(event.type)) {
      admitted = null;
    }
  }
  if (admitted) departed.add(admitted);
  return departed;
}

// Fallback reasons the queue does not drain from by itself: the session's
// runtime could not be recovered (or its state is uncertain), so nothing will
// dispatch until another send or an explicit Resume retries the recovery. The
// rest (a running turn, a pending answer, an in-flight mutation) clear alone.
const STALLED_QUEUE_REASONS = new Set([
  "runtime-recovery-unavailable",
  "reconciliation-blocked",
  "reconciliation-unknown",
  "session-epoch-pending",
  "session-unknown",
]);

/** True when a waiting row was queued because the session's runtime could not
 *  take it. Without this the row just sat there and repeated sends ("????")
 *  queued silently behind it. */
export function queueStalledOnRecovery(
  events: readonly Pick<SessionEvent, "type" | "data">[],
  items: readonly Pick<QueueItemDto, "id" | "heldForReview">[],
): boolean {
  const waiting = new Set(items.filter((item) => !item.heldForReview).map((item) => item.id));
  if (waiting.size === 0) return false;
  for (const event of events) {
    if (event.type !== "delivery/fallback-queued") continue;
    const data = event.data as { queueId?: unknown; reason?: unknown } | undefined;
    if (typeof data?.queueId === "string" && waiting.has(data.queueId)
      && typeof data.reason === "string" && STALLED_QUEUE_REASONS.has(data.reason)) return true;
  }
  return false;
}

type LeavingChip = { item: QueueItemDto; index: number; launch: boolean; animation: Animation | null; started: boolean };

/** The queue on demand: whole prompts and full-size targets. A tap on the text
 *  edits, the handle drags (pointer events, so touch and mouse behave alike) and
 *  arrow keys on the handle move a row one place. */
function QueueSheet({
  open,
  onClose,
  anchorRef,
  items,
  shown,
  busy,
  onEdit,
  onSteer,
  onRemove,
  onReorder,
  onMoveBy,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** The whole queue, the source of a reorder. */
  items: readonly QueueItemDto[];
  /** The rows this list shows, in order. */
  shown: readonly QueueItemDto[];
  busy: boolean;
  onEdit?: (item: QueueItemDto) => void;
  onSteer?: (item: QueueItemDto) => void;
  onRemove: (id: string) => void;
  onReorder: (next: QueueItemDto[], movedId: string) => void;
  onMoveBy: (id: string, delta: number) => void;
}) {
  const [preview, setPreview] = useState<QueueItemDto[] | null>(null);
  const [liftedId, setLiftedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<{ pointerId: number; id: string; stop: () => void } | null>(null);
  const shownIds = new Set(shown.map((item) => item.id));
  const rows = preview ? preview.filter((item) => shownIds.has(item.id)) : shown;

  // A drag owns the finger, also where touch-action alone does not hold it.
  useEffect(() => {
    if (!open) return;
    const keep = (event: TouchEvent) => { if (gesture.current && event.cancelable) event.preventDefault(); };
    document.addEventListener("touchmove", keep, { passive: false });
    return () => document.removeEventListener("touchmove", keep);
  }, [open]);
  // Closing the sheet or leaving the session mid-drag ends the gesture unsaved.
  useEffect(() => {
    if (open) return;
    gesture.current?.stop();
    gesture.current = null;
    setLiftedId(null);
    setPreview(null);
  }, [open]);
  useEffect(() => () => { gesture.current?.stop(); }, []);

  // The gesture listens on the window: reordering re-inserts the row, so the
  // handle that took the press cannot be relied on to see the release.
  const startReorder = (id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (busy || gesture.current) return;
    event.preventDefault();
    const { pointerId } = event;
    let current: QueueItemDto[] = [...items];
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const elements = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-sheet-row]") ?? [])];
      const from = elements.findIndex((element) => element.dataset.sheetRow === id);
      // A row takes a neighbour's place once the finger passes that row's middle,
      // so rows of different heights cannot swap back and forth.
      let target: string | undefined;
      for (const [at, element] of elements.entries()) {
        if (at === from || element.dataset.sheetHeld !== undefined) continue;
        const rect = element.getBoundingClientRect();
        const middle = rect.top + rect.height / 2;
        if (at < from && move.clientY < middle) { target = element.dataset.sheetRow; break; }
        if (at > from && move.clientY > middle) target = element.dataset.sheetRow;
      }
      if (!target) return;
      current = moveQueuedItem(current, id, target);
      setPreview(current);
    };
    const onEnd = (end: PointerEvent) => {
      if (end.pointerId !== pointerId) return;
      gesture.current?.stop();
      gesture.current = null;
      setLiftedId(null);
      setPreview(null);
      if (end.type === "pointerup" && current.some((item, at) => item.id !== items[at]?.id)) onReorder(current, id);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    gesture.current = {
      pointerId,
      id,
      stop: () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onEnd);
        window.removeEventListener("pointercancel", onEnd);
      },
    };
    setLiftedId(id);
    setPreview(current);
  };
  const keyMove = (id: string, event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    onMoveBy(id, event.key === "ArrowUp" ? -1 : 1);
  };

  return (
    <ResponsiveOverlay
      open={open}
      onClose={onClose}
      title={tr("queuedmessagelist.sheetTitleValue", { length: shown.length })}
      phone="sheet"
      anchorRef={anchorRef}
      side="up"
      align="end"
      sheetSize="auto"
    >
      <div ref={listRef} className="queue-sheet" role="list">
        {rows.map((item, at) => {
          const n = at + 1;
          const text = item.hiddenUserMessage ? tr("queuedmessagelist.heldForReview") : item.text;
          return (
            <div
              key={item.id}
              className="queue-sheet-row"
              role="listitem"
              data-sheet-row={item.id}
              data-sheet-held={item.heldForReview ? "" : undefined}
              data-lifted={liftedId === item.id ? "" : undefined}
            >
              {item.heldForReview ? <span className="queue-sheet-grip" aria-hidden="true" /> : (
                <span
                  className="queue-sheet-grip"
                  role="button"
                  tabIndex={0}
                  aria-keyshortcuts="ArrowUp ArrowDown"
                  data-owns-swipe=""
                  aria-label={tr("queuedmessagelist.reorderQueuedMessageValue", { value: n })}
                  onPointerDown={(event) => startReorder(item.id, event)}
                  onKeyDown={(event) => keyMove(item.id, event)}
                >
                  <Icon icon={DragHandleIcon} size="sm" />
                </span>
              )}
              <button
                type="button"
                className="queue-sheet-text"
                aria-label={tr("queuedmessagelist.editQueuedMessageValue", { value: n })}
                disabled={busy || !onEdit}
                onClick={() => onEdit?.(item)}
              >
                <span>{text}</span>
              </button>
              {item.heldForReview && !item.hiddenUserMessage && (
                <span className="queue-held">{tr("queuedmessagelist.heldForReview")}</span>
              )}
              {!item.heldForReview && (
                <IconButton
                  className="queue-steer"
                  icon={EnterIcon}
                  label={tr("queuedmessagelist.steer")}
                  size="md"
                  variant="ghost"
                  pressed={item.delivery === "steer"}
                  busy={busy}
                  disabled={busy || !onSteer}
                  onClick={() => onSteer?.(item)}
                />
              )}
              <IconButton
                className="queue-remove"
                icon={DeleteIcon}
                label={tr("queuedmessagelist.removeQueuedMessageValue", { value: n })}
                size="md"
                variant="ghost"
                busy={busy}
                disabled={busy}
                onClick={() => onRemove(item.id)}
              />
            </div>
          );
        })}
      </div>
    </ResponsiveOverlay>
  );
}

export default function QueuedMessageList({
  sessionId,
  editingId = null,
  launchingId = null,
  onEdit,
  onCancelEdit,
  onSteer,
  onItemsChange,
}: {
  sessionId: string;
  editingId?: string | null;
  /** A row the composer is promoting into the chat right now (its echo is
   *  already in the timeline). Hidden at once, not after the queue re-read. */
  launchingId?: string | null;
  onEdit?: (item: QueueItemDto) => void;
  /** Ends the composer's edit of the row in `editingId`, leaving it as it was. */
  onCancelEdit?: () => void;
  onSteer?: (item: QueueItemDto) => void | Promise<void>;
  onItemsChange?: (sessionId: string, items: QueueItemDto[]) => void;
}) {
  const [items, setItems] = useState<QueueItemDto[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [, setExitTick] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const shellMode = useShellMode();
  const hoverless = useSyncExternalStore(subscribeHoverless, readHoverless, () => false);
  // No pointer to hover with, or no room for a row's actions: one sheet instead.
  const touchQueue = shellMode === "phone" || hoverless;
  const scope = useMemo(() => ({
    alive: true,
    request: 0,
    busy: false,
    removing: new Set<string>(),
    // Promoted rows: `active` while their send runs, `ended` until a queue
    // read issued after it answers — success has removed them by then, and a
    // failed promotion gets its row back from that read.
    launched: new Map<string, "active" | "ended">(),
    lastLaunchingId: null as string | null,
    rendered: [] as QueueItemDto[],
    foldedAway: new Set<string>(),
    leaving: new Map<string, LeavingChip>(),
  }), [sessionId]);
  useEffect(() => {
    scope.alive = true;
    setItems([]);
    setBusyId(null);
    setExpanded(false);
    setSheetOpen(false);
    return () => { scope.alive = false; scope.request++; };
  }, [scope]);
  // queue/* events bump the model version; refetch on any event activity
  const events = useStore((s) => s.events[sessionId]);
  const eventCount = events?.length ?? 0;

  const refresh = useCallback(async () => {
    const request = ++scope.request;
    const settling = [...scope.launched].filter(([, phase]) => phase === "ended").map(([id]) => id);
    try {
      const listed = await api.queueList(sessionId);
      if (!scope.alive || request !== scope.request) return;
      for (const id of settling) if (scope.launched.get(id) === "ended") scope.launched.delete(id);
      // A removal still in flight stays hidden; its own refresh settles it.
      const next = scope.removing.size ? listed.filter((item) => !scope.removing.has(item.id)) : listed;
      setItems(next);
      onItemsChange?.(sessionId, next);
    } catch (error) {
      if (scope.alive && request === scope.request) setUiError(String(error));
    }
  }, [sessionId, onItemsChange, scope]);

  useEffect(() => { refresh(); }, [refresh, eventCount]);

  // Track the composer's promotion in render so the row never flashes back
  // between its send ending and the queue re-read that settles it.
  if (scope.lastLaunchingId !== launchingId) {
    if (scope.lastLaunchingId && scope.launched.has(scope.lastLaunchingId)) scope.launched.set(scope.lastLaunchingId, "ended");
    if (launchingId) scope.launched.set(launchingId, "active");
    scope.lastLaunchingId = launchingId;
  }
  const launchEnded = scope.launched.size > 0 && launchingId === null;
  useEffect(() => { if (launchEnded) void refresh(); }, [launchEnded, refresh]);

  // An interrupt parks its prompt on the queue only until the running turn
  // stops. The timeline already shows that prompt as its in-flight echo, so
  // listing it here as well would say the same thing twice above the composer.
  const echoes = usePendingSends(sessionId);
  const inFlight = new Set(echoes
    .filter((echo) => echo.delivery === "interrupt")
    .map((echo) => echo.text.trim()));
  const hasItems = items.length > 0;
  const departed = useMemo(() => hasItems ? departedQueueIds(events ?? []) : NO_IDS, [events, hasItems]);
  const visibleItems = items.filter((item) =>
    item.sessionId === sessionId
    && item.id !== editingId
    && !departed.has(item.id)
    && !scope.launched.has(item.id)
    && !(item.delivery === "interrupt" && inFlight.has(item.text.trim()))
    && (!item.hiddenUserMessage || item.heldForReview));

  // A row that leaves folds away in place instead of vanishing. The edited row
  // moves into the composer, and a session switch is not a departure.
  const visibleIds = new Set(visibleItems.map((item) => item.id));
  for (const id of visibleIds) {
    // A refused promotion brings its row back: drop the fold mid-way.
    scope.leaving.get(id)?.animation?.cancel();
    scope.leaving.delete(id);
  }
  if (queueChipExitAvailable()) {
    scope.rendered.forEach((item, index) => {
      if (visibleIds.has(item.id) || item.id === editingId || scope.leaving.has(item.id)) return;
      // A row hidden by the fold has no slot to close.
      if (scope.foldedAway.has(item.id)) return;
      const launch = departed.has(item.id) || scope.launched.has(item.id);
      scope.leaving.set(item.id, { item, index, launch, animation: null, started: false });
    });
  }
  scope.rendered = visibleItems;

  useLayoutEffect(() => {
    for (const [id, chip] of scope.leaving) {
      if (chip.started) continue;
      chip.started = true;
      const element = listRef.current?.querySelector<HTMLElement>(`[data-queue-id="${CSS.escape(id)}"]`);
      if (!element) { scope.leaving.delete(id); continue; }
      // Measured before the chip moves: chatMotion flies the prompt row up
      // from here when it lands in the timeline in this same commit.
      if (chip.launch) markQueuedPromptLaunch(element);
      chip.animation = playQueueChipExit(element);
      const done = () => {
        if (scope.leaving.get(id) !== chip) return;
        scope.leaving.delete(id);
        if (scope.alive) setExitTick((tick) => tick + 1);
      };
      if (chip.animation) void chip.animation.finished.then(done, () => {});
      else done();
    }
  });

  // An emptied queue closes the sheet for good: the next prompt must not reopen it.
  const queueEmpty = visibleItems.length === 0;
  useEffect(() => { if (queueEmpty) setSheetOpen(false); }, [queueEmpty]);

  const resumable = visibleItems.find((item) => !item.heldForReview) ?? null;
  const queuePaused = resumable !== null
    && queuePausedAfterUserInterrupt(events ?? [], visibleItems);
  const queueStalled = resumable !== null && !queuePaused
    && queueStalledOnRecovery(events ?? [], visibleItems);
  const editingItem = editingId ? items.find((item) => item.id === editingId && item.sessionId === sessionId) ?? null : null;
  if (visibleItems.length === 0 && scope.leaving.size === 0 && !editingItem) return null;
  const editingBefore = editingItem ? visibleItems.filter((item) => item.position < editingItem.position).length : 0;
  // A row edited from below the fold unfolds the list, so its place reads true.
  const foldedAway = !expanded && visibleItems.length > QUEUE_PREVIEW_ROWS && editingBefore <= QUEUE_PREVIEW_ROWS
    ? new Set(visibleItems.slice(QUEUE_PREVIEW_ROWS).map((item) => item.id))
    : null;
  scope.foldedAway = foldedAway ?? new Set();
  const rows: Array<{ item: QueueItemDto; leaving?: boolean; editing?: boolean }> = visibleItems
    .filter((item) => !foldedAway?.has(item.id))
    .map((item) => ({ item }));
  for (const chip of [...scope.leaving.values()].sort((a, b) => a.index - b.index)) {
    rows.splice(Math.min(chip.index, rows.length), 0, { item: chip.item, leaving: true });
  }
  if (editingItem) rows.splice(Math.min(editingBefore, rows.length), 0, { item: editingItem, editing: true });

  const persistOrder = async (next: QueueItemDto[], movedId: string) => {
    if (scope.busy) return;
    scope.busy = true;
    ++scope.request;
    setItems(next);
    onItemsChange?.(sessionId, next);
    try {
      const updated = await api.queueReorder(sessionId, next.map((item) => item.id));
      if (!scope.alive) return;
      ++scope.request;
      setItems(updated);
      onItemsChange?.(sessionId, updated);
      const updatedVisible = updated.filter((item) => !item.hiddenUserMessage || item.heldForReview);
      const position = updatedVisible.findIndex((item) => item.id === movedId);
      announce(tr("queuedmessagelist.queuedMessageMovedToPositionValueOf", { value: position + 1, length: updatedVisible.length }));
    } catch {
      await refresh(); // reorder rejected (dispatch raced) — resync
    } finally {
      scope.busy = false;
    }
  };

  const startDrag = (id: string, event: ReactDragEvent<HTMLElement>) => {
    if (scope.busy) { event.preventDefault(); return; }
    setDraggedId(id);
    event.dataTransfer?.setData(QUEUE_DRAG_TYPE, id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  };

  const drop = (targetId: string, event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sourceId = draggedId || event.dataTransfer?.getData(QUEUE_DRAG_TYPE);
    setDraggedId(null);
    setDropTargetId(null);
    if (!sourceId || sourceId === targetId) return;
    void persistOrder(moveQueuedItem(items, sourceId, targetId), sourceId);
  };

  // moveQueuedItem takes the target's index, so dragging down lands after it.
  const dropSide = (targetId: string): "before" | "after" =>
    items.findIndex((item) => item.id === draggedId) < items.findIndex((item) => item.id === targetId) ? "after" : "before";

  /** One place up or down among the prompts that can move. */
  const moveBy = (id: string, delta: number) => {
    const movable = visibleItems.filter((item) => !item.heldForReview);
    const at = movable.findIndex((item) => item.id === id);
    const target = at < 0 ? undefined : movable[at + delta];
    if (!target) return;
    setExpanded(true);
    // Reordering re-inserts keyed rows, which can blur what the keyboard is on.
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void persistOrder(moveQueuedItem(items, id, target.id), id).finally(() => {
      if (focused?.isConnected && document.activeElement !== focused) focused.focus();
    });
  };

  // Alt+arrows from anywhere on a row; plain arrows on its focused handle.
  const moveFromKey = (id: string, event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!event.altKey && !(event.target as HTMLElement).classList.contains("queue-grip")) return;
    event.preventDefault();
    event.stopPropagation();
    moveBy(id, event.key === "ArrowUp" ? -1 : 1);
  };

  const remove = async (id: string) => {
    if (scope.busy || scope.removing.has(id)) return;
    ++scope.request;
    // Optimistic: the item leaves the list at once and further removals stay
    // available. The refresh below is the authority — a rejected removal
    // brings the item back with an error notice; nothing is retried.
    scope.removing.add(id);
    const next = items.filter((item) => !scope.removing.has(item.id));
    setItems(next);
    onItemsChange?.(sessionId, next);
    try {
      await api.queueRemove(sessionId, id);
      announce(tr("queuedmessagelist.queuedMessageRemoved"));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (scope.alive && code !== "not-found") setUiError(String(error));
    } finally {
      scope.removing.delete(id);
      await refresh();
    }
  };

  const steer = async (item: QueueItemDto) => {
    if (!onSteer || item.heldForReview || scope.busy) return;
    scope.busy = true;
    ++scope.request;
    // The prompt's echo enters the chat in this same commit; the row leaves it.
    scope.launched.set(item.id, "active");
    setBusyId(item.id);
    try {
      await onSteer(item);
    } catch (error) {
      if (scope.alive) setUiError(String(error));
    } finally {
      if (scope.launched.get(item.id) === "active" && scope.lastLaunchingId !== item.id) scope.launched.set(item.id, "ended");
      await refresh();
      scope.busy = false;
      if (scope.alive) setBusyId(null);
    }
  };

  const hiddenCount = foldedAway?.size ?? 0;
  const canFold = visibleItems.length > QUEUE_PREVIEW_ROWS && (expanded || hiddenCount > 0);
  const resumeRow = (className: string, mark: typeof PauseIcon, text: string, wrap: boolean) => resumable && (
    <div className={`queue-chip ${className}`} role="status" aria-live="polite">
      <span className="queue-mark" aria-hidden="true">
        <Icon icon={mark} size="sm" />
      </span>
      <span className={`queue-text${wrap ? " queue-text-wrap" : ""}`}>{text}</span>
      <div className="queue-actions" onPointerDown={(event) => event.stopPropagation()}>
        <Button
          className="queue-action-word"
          size="sm"
          variant="ghost"
          iconStart={PlayIcon}
          busy={busyId === resumable.id}
          disabled={busyId !== null || !onSteer}
          onClick={() => void steer(resumable)}
        >
          {tr("common.resume")}
        </Button>
      </div>
    </div>
  );

  return (
    <div ref={listRef} className="queue-list" data-touch={touchQueue ? "" : undefined}>
      {queuePaused && resumeRow("queue-chip-paused", PauseIcon, tr("queuedmessagelist.valueQueuedMessages", { length: visibleItems.length }), false)}
      {queueStalled && resumeRow("queue-chip-stalled", WarningIcon, tr("queuedmessagelist.stalledOnRecovery"), true)}
      <div className="queue-block">
        <div
          className="queue-prompts"
          role="list"
          aria-label={tr("queuedmessagelist.valueQueuedMessages", { length: visibleItems.length })}
          data-expanded={expanded && canFold ? "" : undefined}
        >
          {rows.map(({ item, leaving, editing }) => {
            if (leaving) {
              return (
                <div key={item.id} data-queue-id={item.id} className="queue-chip queue-chip-leaving" aria-hidden="true" inert>
                  <span className="queue-mark">
                    <Icon icon={QueueNextIcon} size="sm" />
                  </span>
                  <span className="queue-text">
                    {item.hiddenUserMessage ? tr("queuedmessagelist.heldForReview") : item.text}
                  </span>
                </div>
              );
            }
            if (editing) {
              return (
                <div key={item.id} className="queue-chip queue-chip-editing" role="listitem">
                  <span className="queue-mark" aria-hidden="true">
                    <Icon icon={EditIcon} size="sm" />
                  </span>
                  <span className="queue-text">{tr("queuedmessagelist.editingInComposer")}</span>
                  {onCancelEdit && (
                    <Button
                      className="queue-action-word"
                      size="sm"
                      variant="ghost"
                      onClick={() => onCancelEdit()}
                    >
                      {tr("common.cancel")}
                    </Button>
                  )}
                </div>
              );
            }
            const n = visibleItems.indexOf(item) + 1;
            const busy = busyId !== null;
            const reorderLabel = tr("queuedmessagelist.reorderQueuedMessageValue", { value: n });
            return (
              <div
                key={item.id}
                data-queue-id={item.id}
                data-drop={dropTargetId === item.id ? dropSide(item.id) : undefined}
                className={`queue-chip${draggedId === item.id ? " dragging" : ""}${dropTargetId === item.id ? " drag-over" : ""}${item.heldForReview ? " held" : ""}`}
                role="listitem"
                onKeyDown={item.heldForReview ? undefined : (event) => moveFromKey(item.id, event)}
                onDragEnd={() => { setDraggedId(null); setDropTargetId(null); }}
                onDragOver={(event) => {
                  if (!draggedId || draggedId === item.id) return;
                  event.preventDefault();
                  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                  setDropTargetId(item.id);
                }}
                onDragLeave={() => { if (dropTargetId === item.id) setDropTargetId(null); }}
                onDrop={(event) => drop(item.id, event)}
              >
                <span className="queue-mark" aria-hidden="true">
                  <Icon icon={QueueNextIcon} size="sm" />
                </span>
                {!touchQueue && !item.heldForReview && (
                  <span
                    className="queue-grip"
                    role="button"
                    tabIndex={0}
                    draggable
                    aria-keyshortcuts="ArrowUp ArrowDown Alt+ArrowUp Alt+ArrowDown"
                    aria-label={reorderLabel}
                    title={reorderLabel}
                    onDragStart={(event) => startDrag(item.id, event)}
                  >
                    <Icon icon={DragHandleIcon} size="sm" />
                  </span>
                )}
                <span className="queue-text" title={item.hiddenUserMessage ? undefined : item.text}>
                  {item.hiddenUserMessage ? tr("queuedmessagelist.heldForReview") : item.text}
                </span>
                {item.heldForReview && !item.hiddenUserMessage && (
                  <span className="queue-held">{tr("queuedmessagelist.heldForReview")}</span>
                )}
                {!touchQueue && (
                  <div
                    className="queue-actions"
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    {!item.heldForReview && (
                      <IconButton
                        className="queue-steer"
                        icon={EnterIcon}
                        label={tr("queuedmessagelist.steer")}
                        size="sm"
                        variant="ghost"
                        pressed={item.delivery === "steer"}
                        busy={busy}
                        disabled={busy || !onSteer}
                        onClick={() => void steer(item)}
                      />
                    )}
                    <IconButton
                      className="queue-remove"
                      icon={DeleteIcon}
                      label={tr("queuedmessagelist.removeQueuedMessageValue", { value: n })}
                      size="sm"
                      variant="ghost"
                      busy={busy}
                      disabled={busy}
                      onClick={() => void remove(item.id)}
                    />
                    <IconButton
                      className="queue-edit"
                      icon={EditIcon}
                      label={tr("queuedmessagelist.editQueuedMessageValue", { value: n })}
                      size="sm"
                      variant="ghost"
                      disabled={busy || !onEdit}
                      onClick={() => { if (!scope.busy) onEdit?.(item); }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {canFold && (touchQueue
          ? hiddenCount > 0 && <span className="queue-fold">{tr("queuedmessagelist.moreValue", { count: hiddenCount })}</span>
          : (
            <button
              type="button"
              className="queue-fold"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? tr("queuedmessagelist.showLess") : tr("queuedmessagelist.moreValue", { count: hiddenCount })}
              <Icon icon={expanded ? ChevronUpIcon : ChevronDownIcon} size="sm" />
            </button>
          ))}
        {touchQueue && visibleItems.length > 0 && (
          <button
            type="button"
            className="queue-open"
            aria-label={tr("queuedmessagelist.openQueueValue", { length: visibleItems.length })}
            onClick={() => setSheetOpen(true)}
          >
            <Icon icon={MoreIcon} size="sm" />
          </button>
        )}
      </div>
      {touchQueue && (
        <QueueSheet
          open={sheetOpen && visibleItems.length > 0}
          onClose={() => setSheetOpen(false)}
          anchorRef={listRef}
          items={items}
          shown={visibleItems}
          busy={busyId !== null}
          {...(onEdit ? { onEdit: (item: QueueItemDto) => { setSheetOpen(false); if (!scope.busy) onEdit(item); } } : {})}
          {...(onSteer ? { onSteer: (item: QueueItemDto) => { setSheetOpen(false); void steer(item); } } : {})}
          onRemove={(id) => void remove(id)}
          onReorder={(next, movedId) => void persistOrder(next, movedId)}
          onMoveBy={moveBy}
        />
      )}
    </div>
  );
}

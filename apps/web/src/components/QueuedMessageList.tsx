// Queued follow-up messages: drag reorder and removal. Editing belongs
// in the main composer, which keeps the queued item's original position.
import { type DragEvent as ReactDragEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { QueueItemDto, SessionEvent } from "@polyth/contracts";
import { queuePausedAfterUserInterrupt } from "@polyth/session/queue-pause";
import { api } from "@polyth/session/web-api";
import { setUiError, usePendingSends, useStore } from "../store.ts";
import { announce } from "./a11y/live.tsx";
import { markQueuedPromptLaunch, playQueueChipExit, queueChipExitAvailable } from "../queueLaunchMotion.ts";
import { tr } from "../i18n/index.ts";
import Button from "./ui/Button.tsx";
import IconButton from "./ui/IconButton.tsx";
import Icon from "./ui/Icon.tsx";
import { DeleteIcon, DragHandleIcon, EditIcon, EnterIcon, PauseIcon, PlayIcon, WarningIcon } from "./ui/icons.ts";

const QUEUE_DRAG_TYPE = "application/x-polyth-queued-message";

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

export default function QueuedMessageList({
  sessionId,
  editingId = null,
  launchingId = null,
  onEdit,
  onSteer,
  onItemsChange,
}: {
  sessionId: string;
  editingId?: string | null;
  /** A row the composer is promoting into the chat right now (its echo is
   *  already in the timeline). Hidden at once, not after the queue re-read. */
  launchingId?: string | null;
  onEdit?: (item: QueueItemDto) => void;
  onSteer?: (item: QueueItemDto) => void | Promise<void>;
  onItemsChange?: (sessionId: string, items: QueueItemDto[]) => void;
}) {
  const [items, setItems] = useState<QueueItemDto[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, setExitTick] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
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
    leaving: new Map<string, LeavingChip>(),
  }), [sessionId]);
  useEffect(() => {
    scope.alive = true;
    setItems([]);
    setBusyId(null);
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

  const resumable = visibleItems.find((item) => !item.heldForReview) ?? null;
  const queuePaused = resumable !== null
    && queuePausedAfterUserInterrupt(events ?? [], visibleItems);
  const queueStalled = resumable !== null && !queuePaused
    && queueStalledOnRecovery(events ?? [], visibleItems);
  if (visibleItems.length === 0 && scope.leaving.size === 0) return null;
  const rows: Array<{ item: QueueItemDto; leaving: boolean }> = visibleItems.map((item) => ({ item, leaving: false }));
  for (const chip of [...scope.leaving.values()].sort((a, b) => a.index - b.index)) {
    rows.splice(Math.min(chip.index, rows.length), 0, { item: chip.item, leaving: true });
  }

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

  return (
    <div ref={listRef} className="queue-list" role="list" aria-label={tr("queuedmessagelist.valueQueuedMessages", { length: visibleItems.length })}>
      {queuePaused && resumable && (
        <div className="queue-chip" role="status" aria-live="polite">
          <span className="queue-grip" aria-hidden="true">
            <Icon icon={PauseIcon} size="sm" />
          </span>
          <span className="queue-text">
            {tr("queuedmessagelist.valueQueuedMessages", { length: visibleItems.length })}
          </span>
          <div
            className="queue-actions"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Button
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
      )}
      {queueStalled && resumable && (
        <div className="queue-chip queue-chip-stalled" role="status" aria-live="polite">
          <span className="queue-grip" aria-hidden="true">
            <Icon icon={WarningIcon} size="sm" />
          </span>
          <span className="queue-text queue-text-wrap">
            {tr("queuedmessagelist.stalledOnRecovery")}
          </span>
          <div
            className="queue-actions"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Button
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
      )}
      {rows.map(({ item, leaving }) => {
        if (leaving) {
          return (
            <div key={item.id} data-queue-id={item.id} className="queue-chip queue-chip-leaving" aria-hidden="true" inert>
              <span className="queue-grip">
                <Icon icon={DragHandleIcon} size="sm" />
              </span>
              <span className="queue-text">
                {item.hiddenUserMessage ? tr("queuedmessagelist.heldForReview") : item.text}
              </span>
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
            className={`queue-chip${draggedId === item.id ? " dragging" : ""}${dropTargetId === item.id ? " drag-over" : ""}${item.heldForReview ? " held" : ""}`}
            role="listitem"
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
            <span
              className="queue-grip"
              draggable={!item.heldForReview}
              aria-label={reorderLabel}
              title={reorderLabel}
              onDragStart={(event) => {
                if (item.heldForReview) {
                  event.preventDefault();
                  return;
                }
                startDrag(item.id, event);
              }}
            >
              <Icon icon={DragHandleIcon} size="sm" />
            </span>
            <span className="queue-text" title={item.hiddenUserMessage ? undefined : item.text}>
              {item.hiddenUserMessage ? tr("queuedmessagelist.heldForReview") : item.text}
            </span>
            {item.heldForReview && !item.hiddenUserMessage && (
              <span className="queue-held">{tr("queuedmessagelist.heldForReview")}</span>
            )}
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
                disabled={busy || !onEdit}
                onClick={() => { if (!scope.busy) onEdit?.(item); }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

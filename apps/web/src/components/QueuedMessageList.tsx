// Queued follow-up messages (WP3): drag reorder and removal. Editing belongs
// in the main composer, which keeps the queued item's original position.
import { type DragEvent as ReactDragEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { QueueItemDto } from "@polyth/contracts";
import { queuePausedAfterUserInterrupt } from "@polyth/session/queue-pause";
import { api } from "@polyth/session/web-api";
import { setUiError, useStore } from "../store.ts";
import { announce } from "./a11y/live.tsx";
import { tr } from "../i18n/index.ts";
import Button from "./ui/Button.tsx";
import IconButton from "./ui/IconButton.tsx";
import Icon from "./ui/Icon.tsx";
import Menu from "./ui/Menu.tsx";
import { DeleteIcon, DragHandleIcon, EditIcon, EnterIcon, MoreIcon, PauseIcon, PlayIcon } from "./ui/icons.ts";

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

export default function QueuedMessageList({
  sessionId,
  editingId = null,
  onEdit,
  onSteer,
  onItemsChange,
}: {
  sessionId: string;
  editingId?: string | null;
  onEdit?: (item: QueueItemDto) => void;
  onSteer?: (item: QueueItemDto) => void | Promise<void>;
  onItemsChange?: (sessionId: string, items: QueueItemDto[]) => void;
}) {
  const [items, setItems] = useState<QueueItemDto[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const scope = useMemo(() => ({ alive: true, request: 0, busy: false }), [sessionId]);
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
    try {
      const next = await api.queueList(sessionId);
      if (!scope.alive || request !== scope.request) return;
      setItems(next);
      onItemsChange?.(sessionId, next);
    } catch (error) {
      if (scope.alive && request === scope.request) setUiError(String(error));
    }
  }, [sessionId, onItemsChange, scope]);

  useEffect(() => { refresh(); }, [refresh, eventCount]);

  const visibleItems = items.filter((item) =>
    item.sessionId === sessionId
    && item.id !== editingId
    && (!item.hiddenUserMessage || item.heldForReview));
  const resumable = visibleItems.find((item) => !item.heldForReview) ?? null;
  const queuePaused = resumable !== null
    && queuePausedAfterUserInterrupt(events ?? [], items);
  if (visibleItems.length === 0) return null;

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

  const move = (item: QueueItemDto, delta: -1 | 1) => {
    if (item.heldForReview || item.hiddenUserMessage) return;
    const index = visibleItems.findIndex((candidate) => candidate.id === item.id);
    const target = visibleItems[index + delta];
    if (!target) return;
    void persistOrder(moveQueuedItem(items, item.id, target.id), item.id);
  };

  const remove = async (id: string) => {
    if (scope.busy) return;
    scope.busy = true;
    ++scope.request;
    setBusyId(id);
    try {
      await api.queueRemove(sessionId, id);
      announce(tr("queuedmessagelist.queuedMessageRemoved"));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (scope.alive && code !== "not-found") setUiError(String(error));
    } finally {
      await refresh();
      scope.busy = false;
      if (scope.alive) setBusyId(null);
    }
  };

  const steer = async (item: QueueItemDto) => {
    if (!onSteer || item.heldForReview || scope.busy) return;
    scope.busy = true;
    ++scope.request;
    setBusyId(item.id);
    try {
      await onSteer(item);
    } catch (error) {
      if (scope.alive) setUiError(String(error));
    } finally {
      await refresh();
      scope.busy = false;
      if (scope.alive) setBusyId(null);
    }
  };

  return (
    <div className="queue-list" role="list" aria-label={tr("queuedmessagelist.valueQueuedMessages", { length: visibleItems.length })}>
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
      {visibleItems.map((item, visibleIndex) => {
        const n = visibleIndex + 1;
        const busy = busyId !== null;
        const itemIndex = visibleIndex;
        const reorderLabel = tr("queuedmessagelist.reorderQueuedMessageValue", { value: n });
        return (
          <div
            key={item.id}
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
                <Menu
                  label={reorderLabel}
                  entries={[
                    {
                      id: "up",
                      label: tr("queuedmessagelist.moveQueuedMessageValueUp", { value: n }),
                      disabled: busy || itemIndex <= 0,
                      onSelect: () => move(item, -1),
                    },
                    {
                      id: "down",
                      label: tr("queuedmessagelist.moveQueuedMessageValueDown", { value: n }),
                      disabled: busy || itemIndex >= visibleItems.length - 1,
                      onSelect: () => move(item, 1),
                    },
                  ]}
                >
                  {(trigger) => (
                    <IconButton
                      {...trigger}
                      className="queue-reorder"
                      icon={MoreIcon}
                      label={reorderLabel}
                      size="sm"
                      disabled={busy}
                    />
                  )}
                </Menu>
              )}
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

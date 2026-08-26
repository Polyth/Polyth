// Queued follow-up messages (WP3): drag reorder and removal. Editing belongs
// in the main composer, which keeps the queued item's original position.
import { type DragEvent as ReactDragEvent, useCallback, useEffect, useState } from "react";
import type { QueueItemDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { announce } from "./a11y/live.tsx";
import { tr } from "../i18n/index.ts";
import MoveControls from "./MoveControls.tsx";

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

export default function QueuedMessageList({
  sessionId,
  editingId = null,
  onEdit,
}: {
  sessionId: string;
  editingId?: string | null;
  onEdit?: (item: QueueItemDto) => void;
}) {
  const [items, setItems] = useState<QueueItemDto[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // queue/* events bump the model version; refetch on any event activity
  const eventCount = useStore((s) => (s.events[sessionId] ?? []).length);

  const refresh = useCallback(() => {
    void api.queueList(sessionId).then(setItems);
  }, [sessionId]);

  useEffect(() => { refresh(); }, [refresh, eventCount]);

  const visibleItems = items.filter((item) => item.id !== editingId);
  if (visibleItems.length === 0) return null;

  const persistOrder = async (next: QueueItemDto[], movedId: string) => {
    setItems(next);
    try {
      const updated = await api.queueReorder(sessionId, next.map((item) => item.id));
      setItems(updated);
      const position = updated.findIndex((item) => item.id === movedId);
      announce(tr("queuedmessagelist.queuedMessageMovedToPositionValueOf", { value: position + 1, length: updated.length }));
    } catch {
      refresh(); // reorder rejected (dispatch raced) — resync
    }
  };

  const startDrag = (id: string, event: ReactDragEvent<HTMLDivElement>) => {
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

  const moveToVisibleIndex = (id: string, targetIndex: number) => {
    const target = visibleItems[targetIndex];
    if (!target) return;
    void persistOrder(moveQueuedItem(items, id, target.id), id);
  };

  const remove = async (id: string) => {
    try {
      await api.queueRemove(sessionId, id);
      announce(tr("queuedmessagelist.queuedMessageRemoved"));
    } finally {
      refresh();
    }
  };

  return (
    <div className="queue-list" role="list" aria-label={tr("queuedmessagelist.valueQueuedMessages", { length: visibleItems.length })}>
      {visibleItems.map((item, index) => (
        <div
          key={item.id}
          className={`queue-chip${draggedId === item.id ? " dragging" : ""}${dropTargetId === item.id ? " drag-over" : ""}`}
          role="listitem"
          draggable
          onDragStart={(event) => startDrag(item.id, event)}
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
          <span className="queue-grip" aria-hidden="true">⠿</span>
          <span className="queue-pos">#{item.position + 1}</span>
          <span className="queue-text" title={item.text}>{item.text}</span>
          <span className="muted queue-delivery">{item.delivery === "steer" ? tr("queuedmessagelist.steer") : tr("queuedmessagelist.queued")}</span>
          <MoveControls
            label={item.text}
            index={index}
            count={visibleItems.length}
            previousLabel={tr("queuedmessagelist.moveQueuedMessageValueUp", { value: item.position + 1 })}
            nextLabel={tr("queuedmessagelist.moveQueuedMessageValueDown", { value: item.position + 1 })}
            onMove={(targetIndex) => moveToVisibleIndex(item.id, targetIndex)}
          />
          <button aria-label={tr("queuedmessagelist.editQueuedMessageValue", { value: item.position + 1 })} onClick={() => onEdit?.(item)}>✎</button>
          <button aria-label={tr("queuedmessagelist.removeQueuedMessageValue", { value: item.position + 1 })} onClick={() => void remove(item.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}

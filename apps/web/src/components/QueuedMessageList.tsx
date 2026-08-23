// Queued follow-up messages (WP3): durable edit, drag/keyboard reorder, and
// remove controls. Persisted mutations are announced after server confirmation.
import { type DragEvent as ReactDragEvent, useCallback, useEffect, useState } from "react";
import type { QueueItemDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { announce } from "./a11y/live.tsx";

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

export default function QueuedMessageList({ sessionId }: { sessionId: string }) {
  const [items, setItems] = useState<QueueItemDto[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // queue/* events bump the model version; refetch on any event activity
  const eventCount = useStore((s) => (s.events[sessionId] ?? []).length);

  const refresh = useCallback(() => {
    void api.queueList(sessionId).then(setItems);
  }, [sessionId]);

  useEffect(() => { refresh(); }, [refresh, eventCount]);

  if (items.length === 0) return null;

  const persistOrder = async (next: QueueItemDto[], movedId: string) => {
    setItems(next);
    try {
      const updated = await api.queueReorder(sessionId, next.map((item) => item.id));
      setItems(updated);
      const position = updated.findIndex((item) => item.id === movedId);
      announce(`Queued message moved to position ${position + 1} of ${updated.length}`);
    } catch {
      refresh(); // reorder rejected (dispatch raced) — resync
    }
  };

  const move = async (index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= items.length) return;
    const movedId = items[index]!.id;
    await persistOrder(moveQueuedItem(items, movedId, items[j]!.id), movedId);
  };

  const beginEdit = (item: QueueItemDto) => {
    setEditingId(item.id);
    setDraft(item.text);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const text = draft.trim();
    if (!text) return;
    const current = items.find((item) => item.id === editingId);
    if (current?.text === text) {
      cancelEdit();
      return;
    }
    setSaving(true);
    try {
      const updated = await api.queueEdit(sessionId, editingId, text);
      setItems((existing) => existing.map((item) => item.id === updated.id ? updated : item));
      cancelEdit();
      announce("Queued message updated");
    } catch {
      refresh(); // edit rejected (dispatch raced) — keep the draft for retry
      announce("Couldn’t update queued message");
    } finally {
      setSaving(false);
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

  const remove = async (id: string) => {
    try {
      await api.queueRemove(sessionId, id);
      announce("Queued message removed");
    } finally {
      refresh();
    }
  };

  return (
    <div className="queue-list" role="list" aria-label={`${items.length} queued messages`}>
      {items.map((item, i) => (
        <div
          key={item.id}
          className={`queue-chip${draggedId === item.id ? " dragging" : ""}${dropTargetId === item.id ? " drag-over" : ""}${editingId === item.id ? " editing" : ""}`}
          role="listitem"
          draggable={editingId !== item.id}
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
          <span className="queue-pos">#{i + 1}</span>
          {editingId === item.id ? (
            <textarea
              className="queue-edit"
              aria-label={`Edit queued message ${i + 1}`}
              autoFocus
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") cancelEdit();
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void saveEdit();
                }
              }}
            />
          ) : (
            <span className="queue-text" title={item.text}>{item.text}</span>
          )}
          <span className="muted queue-delivery">{item.delivery === "steer" ? "steer" : "queued"}</span>
          {editingId === item.id ? (
            <>
              <button aria-label={`Save queued message ${i + 1}`} disabled={saving || !draft.trim()} onClick={() => void saveEdit()}>Save</button>
              <button aria-label={`Cancel editing queued message ${i + 1}`} disabled={saving} onClick={cancelEdit}>Cancel</button>
            </>
          ) : (
            <>
              <button aria-label={`Edit queued message ${i + 1}`} onClick={() => beginEdit(item)}>✎</button>
              <button aria-label={`Move queued message ${i + 1} up`} disabled={i === 0} onClick={() => void move(i, -1)}>↑</button>
              <button aria-label={`Move queued message ${i + 1} down`} disabled={i === items.length - 1} onClick={() => void move(i, 1)}>↓</button>
              <button aria-label={`Remove queued message ${i + 1}`} onClick={() => void remove(item.id)}>✕</button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

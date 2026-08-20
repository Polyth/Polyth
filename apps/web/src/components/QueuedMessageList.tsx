// Queued follow-up messages (WP3): FIFO chips above the composer toolbar with
// keyboard-accessible reorder + remove. Order changes are announced politely.
import { useCallback, useEffect, useState } from "react";
import type { QueueItemDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { announce } from "./a11y/live.tsx";

export default function QueuedMessageList({ sessionId }: { sessionId: string }) {
  const [items, setItems] = useState<QueueItemDto[]>([]);
  // queue/* events bump the model version; refetch on any event activity
  const eventCount = useStore((s) => (s.events[sessionId] ?? []).length);

  const refresh = useCallback(() => {
    void api.queueList(sessionId).then(setItems);
  }, [sessionId]);

  useEffect(() => { refresh(); }, [refresh, eventCount]);

  if (items.length === 0) return null;

  const move = async (index: number, dir: -1 | 1) => {
    const next = [...items];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    const tmp = next[index]!;
    next[index] = next[j]!;
    next[j] = tmp;
    try {
      const updated = await api.queueReorder(sessionId, next.map((i) => i.id));
      setItems(updated);
      announce(`Queued message moved to position ${j + 1} of ${updated.length}`);
    } catch {
      refresh(); // reorder rejected (dispatch raced) — resync
    }
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
        <div key={item.id} className="queue-chip" role="listitem">
          <span className="queue-pos">#{i + 1}</span>
          <span className="queue-text" title={item.text}>{item.text}</span>
          <span className="muted" style={{ fontSize: 10.5 }}>{item.delivery === "steer" ? "steer" : "queued"}</span>
          <button aria-label={`Move queued message ${i + 1} up`} disabled={i === 0} onClick={() => void move(i, -1)}>↑</button>
          <button aria-label={`Move queued message ${i + 1} down`} disabled={i === items.length - 1} onClick={() => void move(i, 1)}>↓</button>
          <button aria-label={`Remove queued message ${i + 1}`} onClick={() => void remove(item.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}

// Pointer + keyboard reordering for the new chat's Customize panel: the
// screen's widget rows (a column) and its pinned app tiles (a wrapping grid)
// share one gesture. Items carry `data-sort-id`; the drop target is the item
// whose centre is nearest the pointer, which reads the same in a list and a
// grid. The drag is tracked on the window because reordering moves the
// dragged node, which would drop a pointer capture held by it mid-gesture.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export interface SortableRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Pure: index of the item whose centre is nearest (x, y); -1 when none. */
export function nearestSortIndex(rects: readonly SortableRect[], x: number, y: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  rects.forEach((rect, index) => {
    const dx = rect.left + rect.width / 2 - x;
    const dy = rect.top + rect.height / 2 - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Pure: where a reorder key sends the item at `index`, or null for other keys. */
export function sortKeyTarget(key: string, index: number, count: number): number | null {
  if (key === "ArrowUp" || key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "ArrowDown" || key === "ArrowRight") return Math.min(count - 1, index + 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function useSortable<T extends string>({ ids, onMove }: {
  ids: readonly T[];
  onMove: (id: T, index: number) => void;
}) {
  const listRef = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState<T | null>(null);
  const latest = useRef({ ids, onMove });
  latest.current = { ids, onMove };

  const focusItem = (id: T) => requestAnimationFrame(() => {
    [...listRef.current?.querySelectorAll<HTMLElement>("[data-sort-handle]") ?? []]
      .find((node) => node.dataset.sortHandle === id)?.focus();
  });

  useEffect(() => {
    if (!dragging) return;
    const id = dragging;
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const list = listRef.current;
      if (!list) return;
      const rects = [...list.querySelectorAll<HTMLElement>("[data-sort-id]")].map((node) => {
        const rect = node.getBoundingClientRect();
        return { id: node.dataset.sortId ?? "", left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      });
      const index = nearestSortIndex(rects, event.clientX, event.clientY);
      const target = rects[index];
      if (!target) return;
      const { ids: current, onMove: move } = latest.current;
      const to = current.indexOf(target.id as T);
      if (to >= 0 && to !== current.indexOf(id)) move(id, to);
    };
    const onEnd = () => setDragging(null);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [dragging]);

  return {
    listRef,
    dragging,
    /** Spread on the element that starts a drag and takes reorder keys. */
    handleProps: (id: T) => ({
      "data-sort-handle": id,
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        setDragging(id);
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const { ids: current, onMove: move } = latest.current;
        const target = sortKeyTarget(event.key, current.indexOf(id), current.length);
        if (target === null) return;
        event.preventDefault();
        if (target !== current.indexOf(id)) move(id, target);
        focusItem(id);
      },
    }),
  };
}

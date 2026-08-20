// Roving-tabindex list navigation (WP2). Pure movement math, node-testable;
// the hook applies it to keyboard events for listbox/menu/tree-like widgets.
import { useCallback, useState, type KeyboardEvent } from "react";

export interface RovingKey {
  key: string;
  isComposing?: boolean;
}

/** Compute the next active index for a vertical roving list. Returns the same
 *  index when the key is not a navigation key. Wraps at edges. */
export function moveRoving(count: number, index: number, e: RovingKey): number {
  if (count <= 0 || e.isComposing) return index;
  switch (e.key) {
    case "ArrowDown": return (index + 1) % count;
    case "ArrowUp": return (index - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return index;
  }
}

export function isActivateKey(e: RovingKey): boolean {
  return !e.isComposing && (e.key === "Enter" || e.key === " ");
}

export interface RovingList {
  index: number;
  setIndex: (i: number) => void;
  /** Attach to the container's onKeyDown; returns true when consumed. */
  onKeyDown: (e: KeyboardEvent, count: number, activate?: (i: number) => void) => boolean;
}

export function useRovingList(initial = 0): RovingList {
  const [index, setIndex] = useState(initial);
  const onKeyDown = useCallback(
    (e: KeyboardEvent, count: number, activate?: (i: number) => void): boolean => {
      const like: RovingKey = { key: e.key, isComposing: (e.nativeEvent as { isComposing?: boolean }).isComposing };
      if (isActivateKey(like) && activate) {
        e.preventDefault();
        activate(index);
        return true;
      }
      const next = moveRoving(count, index, like);
      if (next !== index) {
        e.preventDefault();
        setIndex(next);
        return true;
      }
      return false;
    },
    [index],
  );
  return { index, setIndex, onKeyDown };
}

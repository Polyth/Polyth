// Roving-tabindex list navigation (WP2). Pure movement math, node-testable.

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

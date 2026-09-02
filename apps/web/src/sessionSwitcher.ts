/** Next index for a non-wrapping, bidirectional session-switcher cycle. */
export function nextSessionSwitcherIndex(index: number, direction: 1 | -1, length: number): [number, 1 | -1] {
  const next = index + direction;
  if (next >= length) return [Math.max(0, length - 2), -1];
  if (next < 0) return [Math.min(1, length - 1), 1];
  return [next, direction];
}

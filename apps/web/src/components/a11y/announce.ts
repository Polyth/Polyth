type Listener = (text: string) => void;
const listeners = new Set<Listener>();
let lastText = "";

/** Post a polite live-region announcement (queue reorders, tab moves, saves…).
 *  Passing `null` (or an empty string) clears the region: producers that track
 *  a status which later resolves must forward that resolution here instead of
 *  skipping the update, or the stale status strands in the region and a
 *  screen-reader user is told a hardware/state claim that is no longer true. */
export function announce(text: string | null): void {
  if (!text) {
    lastText = "";
    for (const l of [...listeners]) l("");
    return;
  }
  // Duplicate text would be silently ignored by AT; nudge with a suffix space.
  lastText = text === lastText ? `${text}\u00a0` : text;
  for (const l of [...listeners]) l(lastText);
}

export function subscribeLiveAnnouncements(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

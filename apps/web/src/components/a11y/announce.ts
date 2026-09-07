type Listener = (text: string) => void;
const listeners = new Set<Listener>();
let lastText = "";

/** Post a polite live-region announcement (queue reorders, tab moves, saves…). */
export function announce(text: string): void {
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

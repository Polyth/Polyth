// Screen-reader live announcements (WP2). One visually-hidden polite region is
// mounted by the app shell; `announce()` can be called from anywhere.
import { useEffect, useState } from "react";

type Listener = (text: string) => void;
const listeners = new Set<Listener>();
let lastText = "";

/** Post a polite live-region announcement (queue reorders, tab moves, saves…). */
export function announce(text: string): void {
  // Duplicate text would be silently ignored by AT; nudge with a suffix space.
  lastText = text === lastText ? `${text}\u00a0` : text;
  for (const l of [...listeners]) l(lastText);
}

export function LiveRegion() {
  const [text, setText] = useState("");
  useEffect(() => {
    const l: Listener = (t) => setText(t);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return (
    <div aria-live="polite" role="status" className="sr-only">
      {text}
    </div>
  );
}

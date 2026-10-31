// Pin-to-context for one conversation row, shared by the user-message and
// answer quick-action bars. The pinned state is derived from the session's
// context/pinned and context/unpinned events (latest wins).
import { useRef, useState } from "react";
import type { SessionEvent } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { applyEvent, setUiError, useStore } from "../store.ts";

const pinnedBySource = new WeakMap<readonly SessionEvent[], Map<number, boolean>>();

export function pinnedState(events: readonly SessionEvent[] | undefined, seq: number): boolean {
  if (!events) return false;
  let map = pinnedBySource.get(events);
  if (!map) {
    map = new Map();
    for (const event of events) {
      if (event.type !== "context/pinned" && event.type !== "context/unpinned") continue;
      const source = Number((event.data as { sourceEventSeq?: unknown }).sourceEventSeq);
      if (Number.isFinite(source)) map.set(source, event.type === "context/pinned");
    }
    pinnedBySource.set(events, map);
  }
  return map.get(seq) === true;
}

export function useMessagePin(sessionId: string | null | undefined, eventSeq: number): {
  pinned: boolean;
  busy: boolean;
  /** Pins or unpins. The button shows the requested state at once; the
   *  canonical event replaces it, and a rejection reverts it with a notice.
   *  Resolves true once the server applied it. */
  toggle: () => Promise<boolean>;
} {
  const canonical = useStore((state) => pinnedState(sessionId ? state.events[sessionId] : undefined, eventSeq));
  // Display-only intent: the model-visible state stays event-derived.
  const [requested, setRequested] = useState<boolean | null>(null);
  const inFlight = useRef(false);
  const pinned = requested ?? canonical;
  const toggle = async (): Promise<boolean> => {
    if (!sessionId || inFlight.current) return false;
    inFlight.current = true;
    const next = !pinned;
    setRequested(next);
    try {
      applyEvent(await (next ? api.pinContext(sessionId, eventSeq) : api.unpinContext(sessionId, eventSeq)));
      return true;
    } catch (error) {
      setUiError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      inFlight.current = false;
      setRequested(null);
    }
  };
  return { pinned, busy: false, toggle };
}

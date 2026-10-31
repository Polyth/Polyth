// React seam for the interactive edge-swipe Back (edgeSwipeBack.ts). The
// listeners attach only while the layer can actually be popped; the callbacks
// always read the newest closures, so a re-render never re-attaches them.
import { useEffect, useRef } from "react";
import { attachEdgeSwipeBack } from "./edgeSwipeBack.ts";
import type { SwipeZone } from "./mobileGestures.ts";

export interface UseEdgeSwipeBackOptions {
  /** Whether this layer can be popped right now (also gates the listeners). */
  enabled: boolean;
  /** The layer that follows the finger. */
  layer(): HTMLElement | null;
  /** The layer revealed beneath it, when there is one to peek at. */
  under?(): HTMLElement | null;
  /** The element that plays `under`'s settle-back (default: its first child). */
  underMotion?(): HTMLElement | null;
  /** Checked per touch on top of `enabled` (e.g. nothing modal open over the layer). */
  canStart?(): boolean;
  /** Where a swipe may start (read per touch): the edge (default) or anywhere on the layer. */
  zone?: SwipeZone;
  /** Complete the Back. */
  onBack(): void;
}

export function useEdgeSwipeBack(options: UseEdgeSwipeBackOptions): void {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!options.enabled) return;
    return attachEdgeSwipeBack({
      layer: () => latest.current.layer(),
      under: () => latest.current.under?.() ?? null,
      underMotion: () => latest.current.underMotion?.() ?? null,
      enabled: () => latest.current.enabled && (latest.current.canStart?.() ?? true),
      zone: () => latest.current.zone ?? "edge",
      onBack: () => latest.current.onBack(),
    });
  }, [options.enabled]);
}

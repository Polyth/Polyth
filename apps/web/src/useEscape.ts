// Shared Escape handling for inline forms and popovers (UX-24).
import { useEffect, useRef } from "react";

interface EscapeLayer {
  id: symbol;
  close: () => void;
}

const layers: EscapeLayer[] = [];
let listening = false;

const onKeyDown = (event: KeyboardEvent) => {
  if (event.key !== "Escape") return;
  const top = layers.at(-1);
  if (!top) return;
  event.stopPropagation();
  top.close();
};

function syncListener(): void {
  if (typeof window === "undefined") return;
  if (layers.length > 0 && !listening) {
    window.addEventListener("keydown", onKeyDown, true);
    listening = true;
  } else if (layers.length === 0 && listening) {
    window.removeEventListener("keydown", onKeyDown, true);
    listening = false;
  }
}

export function useEscape(active: boolean, onEscape: () => void): void {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const layer: EscapeLayer = { id: Symbol("escape-layer"), close: () => cb.current() };
    layers.push(layer);
    syncListener();
    return () => {
      const index = layers.findIndex((candidate) => candidate.id === layer.id);
      if (index >= 0) layers.splice(index, 1);
      syncListener();
    };
  }, [active]);
}

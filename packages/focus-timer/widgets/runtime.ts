// The active controller and host, set by the installer and cleared on
// disable, so the window, the rail mark, the chip and the settings page share
// one timer without prop drilling.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { TimerController, TimerSnapshot } from "./controller.ts";

let controller: TimerController | null = null;
let host: WebPackageHost | null = null;
const listeners = new Set<() => void>();

export function setRuntime(next: { controller: TimerController; host: WebPackageHost } | null): void {
  controller = next?.controller ?? null;
  host = next?.host ?? null;
  for (const listener of [...listeners]) listener();
}

export function timerController(): TimerController | null {
  return controller;
}

export function timerHost(): WebPackageHost | null {
  return host;
}

const subscribeRuntime = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const EMPTY = () => () => {};

/** The live snapshot, or null while the package is not active. */
export function useTimer(): TimerSnapshot | null {
  const active = useSyncExternalStore(subscribeRuntime, () => controller, () => controller);
  return useSyncExternalStore(
    active ? active.subscribe : EMPTY,
    () => active?.getSnapshot() ?? null,
    () => active?.getSnapshot() ?? null,
  );
}

/** The wall clock, re-read on every whole second of a running timer whose
 *  end is `endsAt`, so the digits change exactly on the second. */
export function useNow(endsAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) {
      setNow(Date.now());
      return;
    }
    let handle: ReturnType<typeof setTimeout> | null = null;
    const step = () => {
      if (handle !== null) clearTimeout(handle);
      handle = null;
      const current = Date.now();
      setNow(current);
      const left = endsAt - current;
      if (left <= 0) return;
      // Wake just after the next whole second of the remaining time.
      const wait = (left % 1000 || 1000) + 8;
      handle = setTimeout(step, wait);
    };
    step();
    const visible = () => { if (!document.hidden) step(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      if (handle !== null) clearTimeout(handle);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [endsAt]);
  return now;
}

/** `true` under the person's reduced-motion preference. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

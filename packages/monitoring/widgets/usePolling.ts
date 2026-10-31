import { useCallback, useEffect, useRef, useState } from "react";

/** One request at a time, keyed results, and no polling while hidden/inactive. */
export function usePolling<T>(key: string, load: (signal: AbortSignal) => Promise<T>, active: boolean, live: boolean) {
  const [state, setState] = useState<{ key: string; value?: T; error?: string; busy: boolean }>({ key, busy: false });
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    const request = ++sequence.current;
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let resumeWhenSettled = false;
    const run = async () => {
      if (disposed || document.visibilityState === "hidden" || controller) return;
      const running = new AbortController();
      controller = running;
      setState((prior) => ({ key, value: prior.key === key ? prior.value : undefined, busy: true }));
      try {
        const value = await load(running.signal);
        if (!disposed && !running.signal.aborted && request === sequence.current) setState({ key, value, busy: false });
      } catch (cause) {
        if (!disposed && !running.signal.aborted && request === sequence.current) setState((prior) => ({ key, value: prior.key === key ? prior.value : undefined,
          error: cause instanceof Error ? cause.message : String(cause), busy: false }));
      } finally {
        controller = undefined;
        if (resumeWhenSettled && !disposed && !document.hidden) { resumeWhenSettled = false; void run(); }
        else if (!disposed && live && !document.hidden) timer = setTimeout(() => void run(), 5_000);
      }
    };
    const visible = () => {
      if (document.visibilityState === "hidden") { clearTimeout(timer); controller?.abort(); }
      else { clearTimeout(timer); if (controller?.signal.aborted) resumeWhenSettled = true; else if (!controller) void run(); }
    };
    document.addEventListener("visibilitychange", visible);
    void run();
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [key, load, active, live, refresh]);
  return { ...(state.key === key ? state : { key, busy: false }), refresh: useCallback(() => setRefresh((value) => value + 1), []) };
}

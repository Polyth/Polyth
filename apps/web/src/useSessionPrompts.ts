import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionPromptDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";

/** Component-local, Space/session-keyed preview cache. Closed panels do no
 * work; reopening reuses pages until a prompt/rewind changes the head. */
export function useSessionPrompts({ sessionId, spaceId, revision, open }: {
  sessionId: string | null;
  spaceId?: string;
  revision: string;
  open: boolean;
}) {
  const key = JSON.stringify([spaceId, sessionId, revision]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const flight = useRef<AbortController | null>(null);
  const [state, setState] = useState<{
    key: string;
    prompts: SessionPromptDto[];
    beforeSeq: number | null | undefined;
    busy: boolean;
    error: boolean;
  }>({ key, prompts: [], beforeSeq: undefined, busy: false, error: false });

  useEffect(() => {
    flight.current?.abort();
    flight.current = null;
    setState({ key, prompts: [], beforeSeq: undefined, busy: false, error: false });
    return () => { flight.current?.abort(); flight.current = null; };
  }, [key]);

  const load = useCallback(async (beforeSeq?: number) => {
    if (!sessionId || flight.current) return false;
    const controller = new AbortController();
    flight.current = controller;
    setState((s) => ({ ...s, busy: true, error: false }));
    try {
      const page = await api.sessionPrompts(sessionId, beforeSeq, { signal: controller.signal });
      if (controller.signal.aborted || currentKey.current !== key) return false;
      setState((s) => ({
        key,
        // API is newest-first; the panel shares desktop's chronological rows.
        prompts: beforeSeq === undefined ? page.prompts.toReversed() : [...page.prompts.toReversed(), ...s.prompts],
        beforeSeq: page.beforeSeq,
        busy: false,
        error: false,
      }));
      return true;
    } catch {
      if (controller.signal.aborted || currentKey.current !== key) return false;
      setState((s) => ({ ...s, busy: false, error: true }));
      return false;
    } finally {
      if (flight.current === controller) flight.current = null;
    }
  }, [key, sessionId]);

  useEffect(() => {
    if (open && state.key === key && state.beforeSeq === undefined && !state.busy && !state.error) void load();
  }, [open, key, state, load]);

  return {
    prompts: state.key === key ? state.prompts : [],
    busy: state.key === key && state.busy,
    error: state.key === key && state.error,
    loaded: state.key === key && state.beforeSeq !== undefined,
    hasOlder: state.key === key && typeof state.beforeSeq === "number",
    loadOlder: () => load(typeof state.beforeSeq === "number" ? state.beforeSeq : undefined),
  };
}

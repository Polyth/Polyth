// Per-session composer draft: restored on session switch, autosaved while
// typing. UX-PANE-MODEL: pane/session transitions never rely on the 250ms
// debounce — the outgoing text is flushed synchronously on session switch,
// pagehide, and composer unmount (legacy navigation adapters), so nothing
// typed is lost when a workspace surface opens, expands, or closes.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { loadDraft, saveDraft } from "./utils.ts";

interface DraftState {
  id: string | null;
  text: string;
}

export function useDraft(sessionId: string | null): {
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  clearDraft: () => void;
} {
  const [state, setState] = useState<DraftState>(() => (
    { id: sessionId, text: sessionId ? loadDraft(sessionId) : "" }
  ));

  // Session switch adjusts state during render (the supported "derive state
  // from props" pattern) so the {id, text} pair is never mismatched in any
  // commit. The outgoing draft is flushed synchronously first; the write is
  // idempotent, so a repeated render is harmless.
  if (state.id !== sessionId) {
    if (state.id !== null) saveDraft(state.id, state.text);
    setState({ id: sessionId, text: sessionId ? loadDraft(sessionId) : "" });
  }

  // Latest committed pair for the flush paths below.
  const live = useRef(state);
  useEffect(() => {
    live.current = state;
  });

  useEffect(() => {
    const { id, text } = state;
    if (id === null) return;
    const t = setTimeout(() => saveDraft(id, text), 250);
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => {
    const flush = () => {
      if (live.current.id !== null) saveDraft(live.current.id, live.current.text);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush(); // unmount: legacy adapters must not lose the draft
    };
  }, []);

  const setDraft = useCallback<Dispatch<SetStateAction<string>>>((action) => {
    setState((prev) => ({
      id: prev.id,
      text: typeof action === "function" ? action(prev.text) : action,
    }));
  }, []);

  const clearDraft = useCallback(() => {
    if (live.current.id !== null) saveDraft(live.current.id, "");
    live.current = { id: live.current.id, text: "" };
    setState((prev) => ({ id: prev.id, text: "" }));
  }, []);

  return { draft: state.text, setDraft, clearDraft };
}

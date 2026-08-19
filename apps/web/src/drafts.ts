// Per-session composer draft: restored on session switch, autosaved while typing.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { loadDraft, saveDraft } from "./utils.ts";

export function useDraft(sessionId: string | null): {
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  clearDraft: () => void;
} {
  const [draft, setDraft] = useState(() => (sessionId ? loadDraft(sessionId) : ""));
  const id = useRef(sessionId);

  useEffect(() => {
    id.current = sessionId;
    setDraft(sessionId ? loadDraft(sessionId) : "");
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const t = setTimeout(() => saveDraft(sessionId, draft), 250);
    return () => clearTimeout(t);
  }, [sessionId, draft]);

  const clearDraft = useCallback(() => {
    setDraft("");
    if (id.current) saveDraft(id.current, "");
  }, []);

  return { draft, setDraft, clearDraft };
}

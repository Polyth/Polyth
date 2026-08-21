// Per-session composer draft: restored on session switch, autosaved while typing.
// Also owns marker-seeded draft provenance (UX-MSG-ACTIONS): a rewind or fork
// marker seeds the composer at most once, and reload never overwrites an
// edited draft or reinserts a deliberately cleared one.
// UX-PANE-MODEL: pane/session transitions never rely on the 250ms
// debounce — the outgoing text is flushed synchronously on session switch,
// pagehide, and composer unmount (legacy navigation adapters), so nothing
// typed is lost when a workspace surface opens, expands, or closes.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AttachmentRef } from "@polyth/contracts";
import { loadDraft, saveDraft } from "./utils.ts";
import { seedAttachments } from "./attachments.ts";
import { shouldApplySeed, type SeedRecord } from "./messageActions.ts";

// localStorage: polyth.draft.seed.<sessionId> — which marker seeded the draft
// and the untouched seed text (edited/cleared states derive from it).
const SEED_META = "polyth.draft.seed.";

export function loadSeedRecord(sessionId: string): SeedRecord | null {
  try {
    const raw = localStorage.getItem(SEED_META + sessionId);
    if (!raw) return null;
    const v = JSON.parse(raw) as { key?: unknown; seedText?: unknown };
    if (typeof v.key !== "string" || typeof v.seedText !== "string") return null;
    return { key: v.key, seedText: v.seedText };
  } catch {
    return null;
  }
}

export function saveSeedRecord(sessionId: string, record: SeedRecord): void {
  try {
    localStorage.setItem(SEED_META + sessionId, JSON.stringify(record));
  } catch {
    // best-effort, like text drafts
  }
}

export function clearSeedRecord(sessionId: string): void {
  try {
    localStorage.removeItem(SEED_META + sessionId);
  } catch {
    // best-effort
  }
}

/** Apply a marker-owned seed at most once: writes the draft text, the pending
 *  attachment pills, and the provenance record. Returns false (and changes
 *  nothing) when this marker already seeded the session — an edit or a
 *  deliberate clear must survive reload. */
export function applyComposerSeed(
  sessionId: string,
  key: string,
  draft: { text: string; attachments?: AttachmentRef[] },
): boolean {
  if (!shouldApplySeed(loadSeedRecord(sessionId), key)) return false;
  saveDraft(sessionId, draft.text);
  seedAttachments(sessionId, draft.attachments ?? []);
  saveSeedRecord(sessionId, { key, seedText: draft.text });
  return true;
}

/** Drop a seeded draft entirely (successful Restore of the original timeline). */
export function discardComposerSeed(sessionId: string): void {
  saveDraft(sessionId, "");
  seedAttachments(sessionId, []);
  clearSeedRecord(sessionId);
}

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

import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentRef, PromptHistoryEntryDto, PromptHistoryScope } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import {
  attachmentsForRecall,
  emptyPromptHistoryCursor,
  restorePromptHistoryDraft,
  stepPromptHistory,
  type PromptHistoryCursor,
  type PromptHistoryDraft,
  type PromptHistoryStep,
} from "./history.ts";

export function usePromptHistory(opts: {
  sessionId: string | null;
  projectId: string | null;
  worktreePath?: string | null;
  scope: PromptHistoryScope;
  limit: number;
}): {
  items: readonly PromptHistoryEntryDto[];
  displayedAttachments: AttachmentRef[] | null;
  isBrowsing: () => boolean;
  snapshot: () => PromptHistoryDraft | null;
  reset: () => void;
  cancelToDraft: (apply: (draft: PromptHistoryDraft) => void) => boolean;
  step: (
    current: PromptHistoryDraft,
    direction: "up" | "down",
    apply: (draft: PromptHistoryDraft) => void,
  ) => boolean;
  takeDisplayedForSend: () => AttachmentRef[] | null;
  reload: () => void;
} {
  const { sessionId, projectId, worktreePath, scope, limit } = opts;
  const cursor = useRef<PromptHistoryCursor>(emptyPromptHistoryCursor());
  const displayedRef = useRef<AttachmentRef[] | null>(null);
  const loadGen = useRef(0);
  const [items, setItems] = useState<PromptHistoryEntryDto[]>([]);
  const [displayedAttachments, setDisplayedAttachments] = useState<AttachmentRef[] | null>(null);
  const fetchSessionId = scope === "session" ? sessionId : null;

  const setDisplayed = useCallback((refs: AttachmentRef[] | null) => {
    displayedRef.current = refs;
    setDisplayedAttachments(refs);
  }, []);

  const reset = useCallback(() => {
    cursor.current = emptyPromptHistoryCursor();
    setDisplayed(null);
  }, [setDisplayed]);

  const load = useCallback((token: number) => {
    if (scope === "session" && !fetchSessionId) {
      setItems([]);
      return;
    }
    const q = scope === "session"
      ? { scope: "session" as const, sessionId: fetchSessionId!, limit }
      : { scope: "space" as const, limit };
    void api.promptHistory(q)
      .then((dto) => {
        if (token !== loadGen.current) return;
        setItems(dto.entries);
      })
      .catch(() => {
        if (token !== loadGen.current) return;
        setItems([]);
      });
  }, [fetchSessionId, limit, scope]);

  // Fetch is keyed separately from browsing. Context change must not destroy
  // the draft snapshot here: Composer owns the textarea and has to flush or
  // restore it first (hook effects run before Composer's session-switch
  // effect). reset() stays a Composer-owned end-of-browse call.
  useEffect(() => {
    const token = ++loadGen.current;
    setItems([]);
    load(token);
  }, [fetchSessionId, load]);

  const applyStep = useCallback((
    next: PromptHistoryStep,
    apply: (draft: PromptHistoryDraft) => void,
  ) => {
    cursor.current = next.cursor;
    if (next.entry) {
      const attachments = attachmentsForRecall(next.entry, {
        projectId: projectId ?? "",
        worktreePath,
      });
      setDisplayed(attachments);
      apply({ text: next.entry.text, attachments });
      return;
    }
    setDisplayed(null);
    apply({ text: next.text, attachments: next.attachments });
  }, [projectId, setDisplayed, worktreePath]);

  const step = useCallback((
    current: PromptHistoryDraft,
    direction: "up" | "down",
    apply: (draft: PromptHistoryDraft) => void,
  ): boolean => {
    const next = stepPromptHistory(items, current, cursor.current, direction);
    if (!next) return false;
    applyStep(next, apply);
    return true;
  }, [applyStep, items]);

  const cancelToDraft = useCallback((apply: (draft: PromptHistoryDraft) => void): boolean => {
    const next = restorePromptHistoryDraft(cursor.current);
    if (!next) return false;
    applyStep(next, apply);
    return true;
  }, [applyStep]);

  const takeDisplayedForSend = useCallback((): AttachmentRef[] | null => {
    if (!cursor.current.entryId) return null;
    const atts = displayedRef.current ?? [];
    reset();
    return atts;
  }, [reset]);

  const reload = useCallback(() => {
    load(++loadGen.current);
  }, [load]);

  return {
    items,
    displayedAttachments,
    isBrowsing: () => cursor.current.entryId !== null,
    snapshot: () => cursor.current.entryId ? cursor.current.draft : null,
    reset,
    cancelToDraft,
    step,
    takeDisplayedForSend,
    reload,
  };
}

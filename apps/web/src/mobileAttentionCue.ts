import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { useEffect, useRef, useState } from "react";
import { resolveSessionStatus, type SessionStatusKind } from "./sessionStatus.ts";
import { sessionTitleOf } from "./mobileIsland.ts";
import { tr } from "./i18n/index.ts";

export type AttentionKind = "needs-approval" | "needs-reply" | "failed";

export const ATTENTION_CUE_DURATION_MS = 5_000;

export interface SessionAttentionSnapshot {
  id: string;
  status: string;
  resolvedKind: SessionStatusKind;
  questions: number;
  permissions: number;
}

export interface AttentionCue {
  sessionId: string;
  sessionTitle: string;
  kind: AttentionKind;
  label: string;
  key: string;
}

export function isAttentionKind(kind: SessionStatusKind): kind is AttentionKind {
  return kind === "needs-approval" || kind === "needs-reply" || kind === "failed";
}

export function attentionKindLabel(kind: AttentionKind): string {
  if (kind === "needs-approval") {
    return tr("sidebar.sessionlist.approvalRequired");
  }
  if (kind === "needs-reply") {
    return tr("sidebar.sessionlist.replyNeeded");
  }
  return tr("notificationcentre.failed");
}

export function takeAttentionSnapshot(sessions: readonly SessionProjection[]): Map<string, SessionAttentionSnapshot> {
  const map = new Map<string, SessionAttentionSnapshot>();
  for (const s of sessions) {
    const resolved = resolveSessionStatus(s);
    map.set(s.id, {
      id: s.id,
      status: s.status,
      resolvedKind: resolved.kind,
      questions: s.attention?.questions ?? 0,
      permissions: s.attention?.permissions ?? 0,
    });
  }
  return map;
}

/** Rank attention kinds so higher urgency wins if multiple sessions transition simultaneously. */
function rankAttention(kind: AttentionKind): number {
  if (kind === "needs-approval") return 0;
  if (kind === "needs-reply") return 1;
  return 2; // failed
}

export function deriveAttentionCue(
  previous: Map<string, SessionAttentionSnapshot>,
  currentSessions: readonly SessionProjection[],
  activeSessionId: string | undefined,
  events: Record<string, readonly SessionEvent[] | undefined>,
): AttentionCue | null {
  const candidates: Array<{ session: SessionProjection; kind: AttentionKind }> = [];

  for (const session of currentSessions) {
    // Only detect state changes in OTHER sessions
    if (session.id === activeSessionId) continue;
    if (session.status === "archived") continue;

    const resolved = resolveSessionStatus(session);
    if (!isAttentionKind(resolved.kind)) continue;

    const before = previous.get(session.id);
    if (!before) {
      // New session created in an attention state
      candidates.push({ session, kind: resolved.kind });
      continue;
    }

    const kind = resolved.kind;
    const questionsNow = session.attention?.questions ?? 0;
    const permissionsNow = session.attention?.permissions ?? 0;

    let isNewTransition = false;
    if (before.resolvedKind !== kind) {
      // Transitioned from another status kind into this attention state
      isNewTransition = true;
    } else if (kind === "needs-approval" && permissionsNow > before.permissions) {
      isNewTransition = true;
    } else if (kind === "needs-reply" && questionsNow > before.questions) {
      isNewTransition = true;
    } else if (kind === "failed" && session.status === "failed" && before.status !== "failed") {
      isNewTransition = true;
    }

    if (isNewTransition) {
      candidates.push({ session, kind });
    }
  }

  // Sort by urgency: needs-approval > needs-reply > failed, then latest activity
  candidates.sort((a, b) => {
    const byRank = rankAttention(a.kind) - rankAttention(b.kind);
    if (byRank !== 0) return byRank;
    return (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0);
  });

  const chosen = candidates[0];
  if (chosen === undefined) return null;
  const sessionTitle = sessionTitleOf(chosen.session, events);
  const label = attentionKindLabel(chosen.kind);

  return {
    sessionId: chosen.session.id,
    sessionTitle,
    kind: chosen.kind,
    label,
    key: `${chosen.session.id}:${chosen.kind}:${Date.now()}`,
  };
}

export function useAttentionCue(
  activeSessionId: string | undefined,
  sessions: readonly SessionProjection[],
  events: Record<string, readonly SessionEvent[] | undefined>,
): {
  attentionCue: AttentionCue | null;
  dismissAttentionCue: () => void;
} {
  const [cue, setCue] = useState<AttentionCue | null>(null);
  const prevRef = useRef<Map<string, SessionAttentionSnapshot>>(takeAttentionSnapshot(sessions));
  const activeRef = useRef(activeSessionId);

  useEffect(() => {
    // If active session changed to the cue's target session, clear immediately
    if (activeSessionId !== activeRef.current) {
      activeRef.current = activeSessionId;
      if (cue?.sessionId === activeSessionId) {
        setCue(null);
      }
    }

    // If cue session is no longer in an attention state, clear
    if (cue) {
      const cueSession = sessions.find((s) => s.id === cue.sessionId);
      if (!cueSession || !isAttentionKind(resolveSessionStatus(cueSession).kind)) {
        setCue(null);
      }
    }

    // Check for transitions in other sessions
    const newCue = deriveAttentionCue(prevRef.current, sessions, activeSessionId, events);
    prevRef.current = takeAttentionSnapshot(sessions);

    if (newCue) {
      setCue(newCue);
    }
  }, [sessions, activeSessionId, events, cue]);

  // Auto-dismiss after ATTENTION_CUE_DURATION_MS
  useEffect(() => {
    if (!cue) return;
    const timer = window.setTimeout(() => {
      setCue((curr) => (curr?.key === cue.key ? null : curr));
    }, ATTENTION_CUE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [cue]);

  const dismissAttentionCue = () => setCue(null);

  return { attentionCue: cue, dismissAttentionCue };
}

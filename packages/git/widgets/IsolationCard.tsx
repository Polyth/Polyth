import { handoffReviewScope } from "./reviewScopeHandoff.ts";
import { cloneElement, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type RefObject } from "react";
import type { IsolationStatusDto, IsolationTargetDto, SessionIsolation, SessionProjection } from "@polyth/contracts";
import { isManagedIsolationBranch, isolationActions, isolationBlocksUserMutation, isolationNeedsRecovery } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { reportGitError } from "./gitRefusal.ts";
import { activateSession, clearRuntimeFeatures, getState, openChanges, setSessions, upsertSession, useStore, workspacePresentationKey } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { createIsolationClient } from "./isolationClient.ts";
import {
  CARD_DONE_BEAT_MS,
  cardCanAnimate,
  cardMotionRunning,
  collapsedCardBox,
  measureNaturalCardBox,
  playCardMotion,
  readCardBox,
  settleCardMotion,
  type CardBox,
} from "./isolationCardMotion.ts";
import {
  BranchIcon,
  Button,
  ChevronDownIcon,
  CombineIcon,
  DeleteIcon,
  Dialog,
  HideIcon,
  Icon,
  IconButton,
  LockIcon,
  Menu,
  MoreIcon,
  PushIcon,
  Spinner,
  TextInput,
  WarningIcon,
  WorktreeIcon,
  confirmAlert,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";

const isolationOf = (session: SessionProjection | null | undefined): SessionIsolation | null =>
  session?.isolation?.kind === "git-worktree" ? session.isolation : null;

function applySession(next: SessionProjection): void {
  upsertSession(next);
}

type StepState = "done" | "current" | "pending";

const ISOLATION_STATE_KEYS = {
  active: "isolation.stateActive", "merge-ready": "isolation.stateMergeReady", merging: "isolation.stateMerging",
  publishing: "isolation.statePublishing", conflict: "isolation.stateConflict", "rebind-pending": "isolation.stateRebindPending",
  "cleanup-pending": "isolation.stateCleanupPending", missing: "isolation.stateMissing", unowned: "isolation.stateUnowned",
  corrupt: "isolation.stateCorrupt",
} as const;
const STALLED_PHASE_MS = 4_000;
const RESOLVE_START_GRACE_MS = 15_000;

type BusyKind = "merge" | "resolve" | "recover" | "delete" | "abandon" | "push";

/** Backoff for a status read that failed in transit. A phone resumed from the
 *  background can spend longer than the shared read retry (about 4 s) getting
 *  its Link connection back, and a busy repository can fail one read with a
 *  5xx, which that retry never repeats. The card only shows once a read
 *  succeeds, so without another one an idle, merge-ready session kept no
 *  card until something else about the session changed. */
const STATUS_RETRY_MS: readonly number[] = [1_000, 3_000, 10_000, 30_000, 60_000];

/** `value: null` records the server refusing this session (a 4xx): nothing
 *  is shown for it, not even the projection's provisional answer. */
type HeldStatus = { sessionId: string; key: string; value: IsolationStatusDto | null };

/** Recent answers per session, keyed by connection/account/Space/project/
 *  session, so returning to a session shows its card at once while a fresh
 *  read confirms it. In memory only, bounded, and used only for the exact
 *  state it was read for. */
const statusCache = new Map<string, { key: string; value: IsolationStatusDto }>();
const STATUS_CACHE_LIMIT = 48;

function rememberStatus(cacheKey: string, key: string, value: IsolationStatusDto): void {
  statusCache.delete(cacheKey);
  statusCache.set(cacheKey, { key, value });
  while (statusCache.size > STATUS_CACHE_LIMIT) statusCache.delete(statusCache.keys().next().value!);
}

/** A merge-ready projection already carries the server's verdict from the end
 *  of the turn, so the card can say "Changes ready" before the status read
 *  returns. The server re-checks everything when Merge is pressed, and the
 *  read replaces this answer as soon as it lands. */
function provisionalStatus(isolation: SessionIsolation): IsolationStatusDto {
  return {
    isolation,
    suggestion: {
      eligible: true,
      hasChanges: true,
      targetBranch: isolation.targetBranch,
      targetDirty: false,
      revision: "",
    },
    effectiveState: "merge-ready",
    actions: {
      canReview: true,
      canMerge: true,
      canKeep: true,
      canResolve: false,
      canDiscard: true,
      canRecover: false,
      canAbandon: false,
    },
  };
}

/** The answer the card shows: one read for this exact state, then the
 *  projection's own merge-ready verdict, then (to avoid a blank flash) the
 *  same session's last answer. Never another session's, and never an answer
 *  for another state over a conflict the projection already records ("Changes
 *  ready" read before the merge attempt): the card then shows the recorded
 *  conflict, and its actions wait for the server's own read. */
function currentStatus(
  held: HeldStatus | null,
  sessionId: string | null,
  key: string | null,
  cacheKey: string | null,
  isolation: SessionIsolation | null,
  working: boolean,
): IsolationStatusDto | null {
  if (!sessionId || !key || !isolation) return null;
  if (held?.sessionId === sessionId && held.key === key) return held.value;
  const cached = cacheKey ? statusCache.get(cacheKey) : undefined;
  if (cached?.key === key) return cached.value;
  if (isolation.state === "merge-ready" && !working) return provisionalStatus(isolation);
  const previous = held?.sessionId === sessionId ? held.value : null;
  if (isolation.state === "conflict" && previous?.isolation?.state !== "conflict") return null;
  return previous;
}

/** Worth asking again: no answer, or a gateway/server failure. A 4xx is the
 *  server's actual verdict on this session. */
function transientStatusFailure(cause: unknown): boolean {
  const status = (cause as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status >= 500 || status === 408 || status === 429;
}

function recoverySteps(integrating: boolean, liveState: string): Array<{ id: string; label: string; state: StepState }> {
  const returningDone = liveState === "cleanup-pending";
  const returning = {
    id: "returning",
    label: returningDone ? tr("isolation.returnedWorkspace") : tr("isolation.returningWorkspace"),
    state: (liveState === "rebind-pending" ? "current" : returningDone ? "done" : "pending") as StepState,
  };
  const cleaning = {
    id: "cleaning",
    label: tr("isolation.cleaningWorkspace"),
    state: (returningDone ? "current" : "pending") as StepState,
  };
  if (!integrating) return [returning, cleaning];
  return [
    {
      id: "integrating",
      label: tr("isolation.integratingChanges"),
      state: liveState === "merging" || liveState === "publishing" ? "current" : "done",
    },
    returning,
    cleaning,
  ];
}

/** A delegated agent merges into its parent's isolated workspace; that
 *  managed branch name means nothing to a person reading the card. */
const targetLabel = (branch: string): string =>
  isManagedIsolationBranch(branch) ? tr("isolation.parentWorkspace") : branch;

function badgeDetails(isolation: SessionIsolation): string {
  return [
    isolation.targetBranch,
    isolation.worktreeBranch,
    isolation.worktreePath,
    isolation.createdAt,
  ].join(" · ");
}

/** A step mark. Each state mounts its own element (keyed by state at the call
 *  site), so a step that completes draws its check in rather than swapping a
 *  glyph in place. */
function StepMark({ state }: { state: StepState }) {
  if (state === "done") return <DrawnCheck className="isolation-card-progress-mark" state="done" />;
  return <span className="isolation-card-progress-mark" data-state={state} aria-hidden="true" />;
}

function DrawnCheck({ className, state }: { className: string; state?: StepState }) {
  return (
    <svg className={`isolation-card-check ${className}`} data-state={state} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle className="isolation-card-check-disc" cx="8" cy="8" r="8" />
      <path className="isolation-card-check-tick" d="M4.6 8.3l2.25 2.25L11.4 5.9" pathLength={1} />
    </svg>
  );
}

function ProgressSteps({ steps }: { steps: Array<{ id: string; label: string; state: StepState }> }) {
  return (
    <ol className="isolation-card-progress">
      {steps.map((step, index) => (
        <li
          key={step.id}
          className={step.state === "done" ? "isolation-card-progress-done" : undefined}
          aria-current={step.state === "current" ? "step" : undefined}
          style={{ "--isolation-step": index } as CSSProperties}
        >
          <StepMark key={step.state} state={step.state} />
          <span key={step.label} className="isolation-card-progress-label">{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** The card's root element; a held copy is cloned with `inert`. */
type CardElement = ReactElement<{ inert?: boolean }>;

type CardView = {
  sessionId: string | null;
  /** The live card, or null when this session has nothing to say. */
  card: CardElement | null;
  /** The merged state shown once the isolation has been integrated. */
  done: CardElement | null;
  /** Dialogs, rendered outside the animated card. */
  overlays: ReactNode;
  /** The live card is integrating this session's work (or asked to). */
  integrating: boolean;
  /** When the session's merge receipt was recorded (ms epoch), if any. */
  mergedAt: number | null;
};

/** A merge receipt this recent belongs to the card that just left, even when
 *  no integrating phase reached this client before the final projection. */
const FRESH_MERGE_MS = 120_000;

function mergedCard(cardRef: RefObject<HTMLElement | null>, targetBranch: string): CardElement {
  const title = tr("isolation.mergedIntoBranch", { branch: targetBranch });
  return (
    <section ref={cardRef} className="isolation-card ui-glass-dock isolation-card--done" role="status" aria-label={title}>
      <div className="isolation-card-head">
        <span className="isolation-card-glyph" aria-hidden="true">
          <span key="done" className="isolation-card-glyph-swap"><DrawnCheck className="isolation-card-done-mark" /></span>
        </span>
        <div className="isolation-card-copy">
          <strong key={title} className="isolation-card-title">{title}</strong>
        </div>
      </div>
      {/* The live card's child slots (note, conflict files, steps, path,
          actions), so React keeps the steps that were already done and only
          the last one draws its check. */}
      {null}
      {null}
      <ProgressSteps
        steps={[
          { id: "integrating", label: tr("isolation.integratingChanges"), state: "done" },
          { id: "returning", label: tr("isolation.returnedWorkspace"), state: "done" },
          { id: "cleaning", label: tr("isolation.cleanedWorkspace"), state: "done" },
        ]}
      />
      {null}
      <div className="isolation-card-actions" />
    </section>
  );
}

/**
 * The isolation card with presence. The card lives below the last transcript
 * row, so its box is transcript geometry: it grows in, morphs between states
 * and, once the work is back in the original workspace, shows the merged
 * state for a beat and then collapses into nothing while the merge notice
 * takes over in the transcript. Nothing in the conversation jumps; see
 * isolationCardMotion.ts.
 */
export function IsolationCard() {
  const cardRef = useRef<HTMLElement | null>(null);
  const { sessionId, card, done, overlays, integrating, mergedAt } = useIsolationCardView(cardRef);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const lastLive = useRef<{ sessionId: string; node: CardElement; integrating: boolean } | null>(null);
  const leaving = useRef<{ sessionId: string; node: CardElement; stage: "done" | "exit" } | null>(null);
  const morph = useRef<{ element: HTMLElement | null; box: CardBox | null; signature: string | null; observer: ResizeObserver | null }>({
    element: null, box: null, signature: null, observer: null,
  });

  // Presence is decided while rendering so the card's DOM node is reused from
  // the live state into the held one: the commit that loses the isolation
  // never removes the card first and re-inserts a copy.
  if (sessionId === null || (lastLive.current !== null && lastLive.current.sessionId !== sessionId)) {
    // A session switch is not an exit: the other session's card goes at once.
    lastLive.current = null;
    leaving.current = null;
  }
  if (card && sessionId) {
    lastLive.current = { sessionId, node: card, integrating: integrating || lastLive.current?.integrating === true };
    leaving.current = null;
  } else if (!card && lastLive.current && !leaving.current) {
    if (cardCanAnimate(cardRef.current)) {
      // An old receipt from an earlier merge must not dress up a discard.
      const merged = done && (lastLive.current.integrating || (mergedAt !== null && Date.now() - mergedAt < FRESH_MERGE_MS))
        ? done
        : null;
      leaving.current = {
        sessionId: lastLive.current.sessionId,
        node: merged ?? lastLive.current.node,
        stage: merged ? "done" : "exit",
      };
    } else {
      lastLive.current = null;
    }
  }
  const held = card ? null : leaving.current;
  const stage = card ? "live" : held?.stage ?? null;
  // A held card is a picture of the last state, never a control surface.
  const rendered = card ?? (held ? cloneElement(held.node, { inert: true }) : null);

  // Morph: any change to the card's content animates its box from where it is
  // now to its new natural size. Passive resizes (a narrower window, a font
  // load) only refresh the remembered box.
  useLayoutEffect(() => {
    const state = morph.current;
    const element = cardRef.current;
    if (state.element !== element) {
      state.observer?.disconnect();
      state.observer = null;
      state.box = null;
      state.signature = null;
    }
    if (!element) {
      state.element = null;
      return;
    }
    const fresh = state.element !== element;
    const signature = `${element.className}\u0000${element.innerHTML}`;
    if (!fresh && signature === state.signature) return;
    const motion = cardMotionRunning(element);
    if (motion === "exit" && stage === "exit") return;
    state.element = element;
    state.signature = signature;
    if (fresh && typeof ResizeObserver === "function") {
      state.observer = new ResizeObserver(() => {
        if (morph.current.element === element && morph.current.box && !cardMotionRunning(element)) {
          morph.current.box = readCardBox(element);
        }
      });
      state.observer.observe(element);
    }
    if (!cardCanAnimate(element)) {
      settleCardMotion(element);
      state.box = null;
      return;
    }
    const from = fresh ? collapsedCardBox(element) : motion ? readCardBox(element) : state.box;
    settleCardMotion(element);
    const to = measureNaturalCardBox(element, from?.height ?? 0);
    state.box = to;
    if (from) playCardMotion(element, fresh || motion === "enter" || motion === "exit" ? "enter" : "morph", from, to);
  });

  useEffect(() => () => morph.current.observer?.disconnect(), []);

  // The merged beat: long enough to read once, then the card hands over.
  useEffect(() => {
    if (stage !== "done") return;
    const timer = setTimeout(() => {
      if (leaving.current?.stage !== "done") return;
      leaving.current = { ...leaving.current, stage: "exit" };
      rerender();
    }, CARD_DONE_BEAT_MS);
    return () => clearTimeout(timer);
  }, [stage, sessionId]);

  // The exit collapses the card's whole share of the timeline (box, padding
  // and the gap before it) and unmounts it only once that share is zero.
  useLayoutEffect(() => {
    if (stage !== "exit") return;
    const element = cardRef.current;
    const finish = () => {
      if (leaving.current?.stage !== "exit") return;
      leaving.current = null;
      lastLive.current = null;
      rerender();
    };
    if (!cardCanAnimate(element)) {
      finish();
      return;
    }
    playCardMotion(element, "exit", readCardBox(element), collapsedCardBox(element), finish);
  }, [stage, sessionId]);

  return (
    <>
      {rendered && sessionId ? cloneElement(rendered, { key: sessionId }) : null}
      {overlays}
    </>
  );
}

function useIsolationCardView(cardRef: RefObject<HTMLElement | null>): CardView {
  const sessionId = useStore((state) => state.activeSessionId);
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null,
  );
  const isolation = isolationOf(session);
  const sessionWorking = session ? isolationBlocksUserMutation(session.status) : false;
  // What a status answer describes: read while the agent worked, for an
  // earlier isolation state or for a target since changed, it says nothing
  // about the session now.
  const statusKey = session && isolation
    ? `${session.id}\u0000${isolation.state}\u0000${isolation.dismissedRevision ?? ""}\u0000${sessionWorking ? "working" : "resting"}\u0000${isolation.targetBranch}\u0000${isolation.originPath ?? ""}`
    : null;
  const cacheKey = session && isolation ? workspacePresentationKey("isolation-status", session.projectId, session.id) : null;
  // The last answer and the session it belongs to: a failed or pending read
  // keeps it only for that same session, never another session's card.
  const [held, setHeld] = useState<HeldStatus | null>(null);
  // Delegated agents still merging into this checkout block Merge, which the
  // projection alone cannot tell; such a card waits for the server's answer.
  const worktreePath = isolation?.worktreePath ?? null;
  const hostsDelegated = useStore((state) => worktreePath !== null && state.sessions.some((candidate) =>
    candidate.id !== state.activeSessionId
    && candidate.isolation?.kind === "git-worktree"
    && candidate.isolation.originPath === worktreePath));
  const status = currentStatus(held, sessionId, statusKey, cacheKey, isolation, sessionWorking || hostsDelegated);
  // Requests in flight belong to the session they were made for. The card is
  // one component across session switches, so a merge still running for one
  // session must never dress another session's card as integrating.
  const [busyBySession, setBusyBySession] = useState<Readonly<Record<string, BusyKind>>>({});
  const busy = sessionId ? busyBySession[sessionId] ?? null : null;
  const markBusy = useCallback((id: string, kind: BusyKind | null) => setBusyBySession((current) => {
    if (kind !== null) return { ...current, [id]: kind };
    if (!(id in current)) return current;
    const { [id]: _done, ...rest } = current;
    return rest;
  }), []);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // "Hide until next turn" is view-only: the card comes back with the session's
  // next admitted turn, because `lastTurnAt` is stamped at every turn start.
  // Keyed by session so switching chats never inherits another card's dismissal.
  const [hiddenFor, setHiddenFor] = useState<{ sessionId: string; turn: number | null } | null>(null);
  const turn = session?.lastTurnAt ?? null;
  const cardHidden = hiddenFor !== null && hiddenFor.sessionId === sessionId && hiddenFor.turn === turn;
  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [pushBranchName, setPushBranchName] = useState("");
  const [pushMessage, setPushMessage] = useState("");
  const statusRequest = useRef(0);
  const [statusFailures, setStatusFailures] = useState(0);
  // The session waiting for its agent to finish resolving conflicts before
  // an automatic merge. Set by "Resolve with AI and proceed"; `started` once
  // its resolve turn has been seen running.
  const [pendingAutoMergeOf, setPendingAutoMergeOf] = useState<{ sessionId: string; started: boolean } | null>(null);
  const pendingAutoMergeFor = pendingAutoMergeOf?.sessionId ?? null;
  const pendingAutoMerge = sessionId !== null && pendingAutoMergeFor === sessionId;
  const [rowBusyFor, setRowBusyFor] = useState<{ sessionId: string; key: string } | null>(null);
  const rowBusy = rowBusyFor && rowBusyFor.sessionId === sessionId ? rowBusyFor.key : null;
  // The branch a chosen-target merge in flight goes to, so its progress names
  // that branch before the server's status read reports the new target.
  const [mergingIntoFor, setMergingIntoFor] = useState<{ sessionId: string; branch: string } | null>(null);
  const mergingInto = mergingIntoFor && mergingIntoFor.sessionId === sessionId ? mergingIntoFor.branch : null;
  const rowClient = useRef(createIsolationClient()).current;

  const refresh = useCallback(async () => {
    const request = ++statusRequest.current;
    // Do NOT null-clear status here — keeping the previous status during a
    // refresh avoids the blank-flash between states (e.g. the merge animation
    // jump or the conflict card disappearing while status reloads).
    // Only null-clear when there is genuinely nothing to show (no session /
    // no isolation).
    if (!sessionId || !isolation || !statusKey || !cacheKey) {
      setHeld(null);
      setStatusFailures(0);
      return;
    }
    try {
      const next = await api.isolationStatus(sessionId);
      if (request !== statusRequest.current) return;
      rememberStatus(cacheKey, statusKey, next);
      setHeld({ sessionId, key: statusKey, value: next });
      setStatusFailures(0);
    } catch (cause) {
      if (request !== statusRequest.current) return;
      if (transientStatusFailure(cause)) {
        // Keep what this session already showed; the retry below asks again.
        setHeld((current) => current?.sessionId === sessionId ? current : null);
        setStatusFailures((count) => count + 1);
      } else {
        statusCache.delete(cacheKey);
        setHeld({ sessionId, key: statusKey, value: null });
        setStatusFailures(0);
      }
    }
    // While the agent works the answer is fixed ("working"); projection churn
    // from the turn must not re-ask the server on every update.
  }, [sessionId, statusKey, cacheKey, sessionWorking ? "working" : session?.updatedAt]);

  // A request that finishes after a session switch re-reads the session now
  // shown; the old session's closure would cancel that session's own read.
  const refreshLatest = useRef(refresh);
  refreshLatest.current = refresh;

  useEffect(() => {
    void refresh();
    return () => { statusRequest.current += 1; };
  }, [refresh]);

  // A failed read is retried with backoff, and at once when the page returns
  // to the foreground or the network comes back. A hidden page waits for the
  // foreground instead of spending its retries.
  useEffect(() => {
    if (statusFailures === 0) return;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const retry = () => { if (!hidden()) void refresh(); };
    const delay = STATUS_RETRY_MS[Math.min(statusFailures - 1, STATUS_RETRY_MS.length - 1)]!;
    const timer = setTimeout(retry, delay);
    window.addEventListener("online", retry);
    window.addEventListener("pageshow", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", retry);
      window.removeEventListener("pageshow", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [statusFailures, refresh]);

  useEffect(() => {
    setConfirmingDelete(false);
    setPushDialogOpen(false);
    setStatusFailures(0);
  }, [sessionId]);

  // Auto-merge when the agent finishes resolving conflicts. When
  // pendingAutoMerge is set we watch for the session to leave "working"/"waiting"
  // and then fire an automatic merge.
  // The pending session is watched even while another one is shown.
  const pendingAutoMergeStatus = useStore((state) => pendingAutoMergeFor === null
    ? undefined
    : state.sessions.find((candidate) => candidate.id === pendingAutoMergeFor)?.status);
  const isolationState = isolation?.state;
  useEffect(() => {
    const pending = pendingAutoMergeOf;
    if (!pending) return;
    const target = pending.sessionId;
    if (pendingAutoMergeStatus !== undefined && isolationBlocksUserMutation(pendingAutoMergeStatus)) {
      // Still resolving — wait.
      if (!pending.started) setPendingAutoMergeOf({ sessionId: target, started: true });
      return;
    }
    const proceed = () => {
      setPendingAutoMergeOf(null);
      markBusy(target, "merge");
      api.isolationMerge(target)
        .then((result) => { applySession(result.session); })
        .catch((cause) => { reportGitError(tr("common.error"), cause); })
        .finally(() => {
          markBusy(target, null);
          void refreshLatest.current();
        });
    };
    // Agent has finished. Attempt automatic merge.
    if (pending.started) { proceed(); return; }
    // The resolve request returns before this client necessarily sees its
    // turn start; an idle status then is not yet the agent finishing.
    const timer = setTimeout(proceed, RESOLVE_START_GRACE_MS);
    return () => clearTimeout(timer);
  }, [pendingAutoMergeOf, pendingAutoMergeStatus]);

  // A merging/publishing phase is normally a request in flight — possibly
  // from another client, so `busy` cannot see it. Retry is offered only once
  // that phase has sat unchanged long enough to be a stalled one.
  const phase = status?.effectiveState ?? isolationState;
  const [stalledPhase, setStalledPhase] = useState<string | null>(null);
  useEffect(() => {
    setStalledPhase(null);
    if (busy !== null || (phase !== "merging" && phase !== "publishing")) return;
    const timer = setTimeout(() => setStalledPhase(phase), STALLED_PHASE_MS);
    return () => clearTimeout(timer);
  }, [sessionId, phase, busy]);

  if (!sessionId || !session || !isolation) {
    const merged = session && !isolation ? session.isolationMerge : undefined;
    return {
      sessionId,
      card: null,
      done: merged ? mergedCard(cardRef, targetLabel(merged.targetBranch)) : null,
      overlays: null,
      integrating: false,
      mergedAt: merged?.at ?? null,
    };
  }

  const suggestion = status?.suggestion;
  const live = status?.isolation ?? isolation;
  const serverState = status?.effectiveState ?? live.state;
  // The server persists its first integration phase only once it has
  // snapshotted the workspace and built the merge, which takes seconds on a
  // busy host. This card's own merge request is that integration from the
  // press on, so it shows the integrating step at once.
  const mergeRequested = busy === "merge" && !isolationNeedsRecovery(serverState);
  const liveState = mergeRequested ? "merging" : serverState;
  const targetBranch = targetLabel(mergeRequested && mergingInto ? mergingInto : live.targetBranch);
  const delegated = status?.delegated ?? [];
  const conflict = liveState === "conflict" && suggestion?.eligible !== true;
  const unavailable = liveState === "missing" || liveState === "unowned" || liveState === "corrupt" || suggestion?.reason === "missing";
  const ownershipUnverified = liveState === "unowned" || liveState === "corrupt";
  // New servers carry compatible dirty-target work forward. The reason is
  // retained as a legacy block when this client talks to an older server.
  const dirtyBlocked = suggestion?.reason === "dirty-target";
  const targetDirty = suggestion?.targetDirty === true;
  const destinationUnavailable = suggestion?.reason === "destination-unavailable";
  // Work waits on a chat whose runtime is not yet proven settled. Integrating
  // stays blocked, but the card says so rather than disappearing.
  const runtimeRecovering = suggestion?.reason === "runtime-recovering" && suggestion.hasChanges;
  const recovering = liveState === "merging" || liveState === "publishing" || liveState === "rebind-pending" || liveState === "cleanup-pending";
  const discarding = recovering && liveState !== "merging" && liveState !== "publishing" && !live.resultCommit;
  const integrating = recovering && !discarding;
  const working = isolationBlocksUserMutation(session.status);
  // While the delegating agent runs, integrating its children is its job;
  // once it rests, the card explains why this session cannot integrate yet.
  const delegatedPending = delegated.length > 0 && !working;
  // Retry is for an unfinished phase nobody is driving: never while this
  // card's own request runs, the session works, or a merge is still moving.
  const recoveryNeeded = recovering && busy === null && !working
    && (liveState === "rebind-pending" || liveState === "cleanup-pending" || stalledPhase === liveState);
  const repositoryRows = session.workspace?.repositories.filter((row) => row.isolation) ?? [];
  const runRepositoryAction = async (repositoryId: string, action: "merge" | "keep" | "discard" | "recover") => {
    setRowBusyFor({ sessionId, key: `${repositoryId}:${action}` });
    try {
      const result = await rowClient[action](sessionId, repositoryId);
      applySession("session" in result ? result.session : result);
      await refreshLatest.current();
    } catch (cause) {
      reportGitError(tr("common.error"), cause);
    } finally {
      setRowBusyFor((current) => current?.sessionId === sessionId ? null : current);
    }
  };
  if (repositoryRows.length > 1) {
    return { sessionId, done: null, overlays: null, integrating: false, mergedAt: null, card: <section ref={cardRef} className="isolation-card" aria-label={tr("isolation.repoActionsAria")}>
      <div className="isolation-card-head"><WorktreeIcon size="sm" /><strong>{tr("isolation.repoWorkspaces")}</strong></div>
      {repositoryRows.map((row) => {
        const rowIsolation = row.isolation!;
        const recoveringRow = ["merging", "publishing", "rebind-pending", "cleanup-pending"].includes(rowIsolation.state);
        const action = recoveringRow ? "recover" as const : rowIsolation.state === "merge-ready" || rowIsolation.state === "conflict" ? "merge" as const : "keep" as const;
        return <div className="isolation-repository-row" key={row.repositoryId}>
          <div><strong>{row.alias ?? row.repositoryId}</strong><span className="muted">{tr(ISOLATION_STATE_KEYS[rowIsolation.state] ?? "isolation.stateActive")} · {rowIsolation.targetBranch}</span></div>
          <div className="isolation-repository-actions">
            <Button size="sm" disabled={working || rowBusy !== null} busy={rowBusy === `${row.repositoryId}:${action}`} onClick={() => void runRepositoryAction(row.repositoryId, action)}>{action === "recover" ? tr("isolation.repoRecover") : action === "merge" ? tr("isolation.merge") : tr("isolation.repoKeep")}</Button>
            {!recoveringRow && <Button size="sm" disabled={working || rowBusy !== null} onClick={() => void runRepositoryAction(row.repositoryId, "discard")}>{tr("gitview.discard")}</Button>}
          </div>
        </div>;
      })}
    </section> };
  }
  const fallbackActions = status ? isolationActions(status, session.status) : null;
  const actions = status?.actions ?? (fallbackActions ? {
    canReview: fallbackActions.canReview,
    canMerge: fallbackActions.canMerge,
    canResolve: fallbackActions.canResolve,
    canRecover: fallbackActions.needsRecovery,
    canAbandon: false,
    canChooseTarget: false,
  } : undefined);
  const ready = actions?.canMerge === true && !mergeRequested;
  // Other checked-out branches the work can go to instead. When the recorded
  // origin checkout has since switched branches, its new branch is offered as
  // the way forward rather than a dead end.
  const otherTargets = actions?.canChooseTarget === true && !mergeRequested
    ? (status?.targets ?? []).filter((target) => !target.current)
    : [];
  const originSwitched = destinationUnavailable ? otherTargets.find((target) => target.origin) : undefined;
  const canDelete = status !== null && !working && !recovering && !ownershipUnverified;
  // Once resolving is handed to the agent, the conflict is its work in
  // progress: the card steps aside until the turn ends and the merge runs.
  const resolving = conflict && (busy === "resolve" || pendingAutoMerge || working);
  if (resolving || (!conflict && !unavailable && !dirtyBlocked && !destinationUnavailable && !ready && !recovering && !delegatedPending && !runtimeRecovering)) {
    return { sessionId, card: null, done: null, overlays: null, integrating: false, mergedAt: null };
  }

  // A switched origin checkout is not a dead end: its new branch takes the
  // work, so the card stays the calm ready card and only notes the switch.
  const stranded = destinationUnavailable && !originSwitched;
  const warn = conflict || unavailable || dirtyBlocked || stranded || delegatedPending || runtimeRecovering;

  const run = async (kind: "merge" | "resolve" | "recover" | "abandon", action: () => Promise<void>) => {
    markBusy(sessionId, kind);
    try {
      await action();
      await refreshLatest.current();
    } catch (cause) {
      reportGitError(tr("common.error"), cause);
      await refreshLatest.current();
    } finally {
      markBusy(sessionId, null);
    }
  };

  const confirmDelete = async () => {
    setConfirmingDelete(false);
    markBusy(sessionId, "delete");
    try {
      const projectId = session.projectId;
      await api.deleteSession(sessionId);
      clearRuntimeFeatures(sessionId);
      const current = getState();
      setSessions(
        projectId,
        current.sessions.filter((candidate) => candidate.projectId === projectId && candidate.id !== sessionId),
      );
      if (current.activeSessionId === sessionId) activateSession(null);
    } catch (cause) {
      reportGitError(tr("common.error"), cause);
      await refreshLatest.current();
    } finally {
      markBusy(sessionId, null);
    }
  };

  const abandon = async () => {
    if (!await confirmAlert(tr("isolation.finishWithoutCleanupConfirm"), {
      title: tr("isolation.finishWithoutCleanup"),
      confirmLabel: tr("common.continue"),
    })) return;
    await run("abandon", async () => {
      applySession(await api.isolationAbandon(sessionId));
    });
  };

  const openPushDialog = () => {
    setPushBranchName(live.worktreeBranch);
    setPushMessage(session.title?.trim() && session.title !== "New session" ? session.title.trim() : "");
    setPushDialogOpen(true);
  };

  const submitPush = async () => {
    markBusy(sessionId, "push");
    try {
      await api.isolationPush(sessionId, {
        branch: pushBranchName.trim() || undefined,
        message: pushMessage.trim() || undefined,
      });
      setPushDialogOpen(false);
      await refreshLatest.current();
    } catch (cause) {
      reportGitError(tr("common.error"), cause);
    } finally {
      markBusy(sessionId, null);
    }
  };

  // The merge ran in a throwaway checkout, so the session's own working tree
  // has nothing conflicted to show. Source Control's Conflicts view previews
  // the merge against the current target and opens at the chosen file.
  const reviewConflicts = (file = live.conflict?.files[0]) => {
    handoffReviewScope(workspacePresentationKey("git-review-handoff", session.projectId, sessionId), "conflicts", file);
    openChanges();
  };

  const title = stranded
    ? tr("isolation.cantReturnYet", { branch: targetBranch })
    : (liveState === "rebind-pending" || liveState === "cleanup-pending") && busy === null
      ? tr("isolation.recoveryNeeded")
    : recovering
      ? integrating
        ? liveState === "merging" || liveState === "publishing"
          ? tr("isolation.integratingInto", { branch: targetBranch })
          : liveState === "rebind-pending"
            ? tr("isolation.returningWorkspace")
            : tr("isolation.cleaningWorkspace")
        : liveState === "rebind-pending"
          ? tr("isolation.returningWorkspace")
          : tr("isolation.cleaningWorkspace")
      : ownershipUnverified
        ? tr("isolation.ownershipUnverified")
        : unavailable
          ? tr("isolation.missingWorkspace")
          : runtimeRecovering
            ? tr("isolation.runtimeRecovering")
          : dirtyBlocked
            ? tr("isolation.cantIntegrateYet", { branch: targetBranch })
            : conflict
              ? tr("isolation.mergeNeedsAttention")
              : delegatedPending
                ? tr("isolation.delegatedPending")
                : tr("isolation.changesAreReady");

  const detail = originSwitched
    ? tr("isolation.originSwitchedDetail", {
      path: originSwitched.path,
      current: targetLabel(originSwitched.branch),
      branch: targetBranch,
    })
    : stranded
    ? tr(otherTargets.length ? "isolation.restoreOriginOrChoose" : "isolation.restoreOrigin", {
      path: live.originPath ?? live.targetPath,
      branch: targetBranch,
    })
    // "Retry cleanup" only describes a cleanup nobody is driving; while this
    // card's merge request still runs, the progress steps say what happens.
    : liveState === "cleanup-pending" && busy === null
      ? tr("isolation.cleanupPendingDetail")
      : ownershipUnverified
        ? tr("isolation.ownershipDetail")
        : recovering
          ? null
          : runtimeRecovering
            ? tr("isolation.runtimeRecoveringDetail")
          : conflict
            ? (live.conflict?.message || tr("isolation.conflictDetail", { branch: targetBranch }))
            : delegatedPending
              ? tr("isolation.delegatedPendingDetail", { count: String(delegated.length) })
              : dirtyBlocked || (targetDirty && ready)
                ? tr("isolation.dirtyTargetDetail", { branch: targetBranch })
                : null;

  const showPath = unavailable || (recovering && busy === null);
  const steps = recovering ? recoverySteps(integrating, liveState) : null;
  // A durable recovery phase can be idle awaiting Retry. Motion belongs to
  // the request in flight (or a merge not yet judged stalled), rather than
  // the persisted unfinished phase.
  const moving = busy !== null
    || (!recoveryNeeded && (liveState === "merging" || liveState === "publishing"));
  const glyphIcon = unavailable ? WorktreeIcon : recovering || conflict || warn ? WarningIcon : CombineIcon;
  const glyphKey = recovering && moving
    ? "spinner"
    : unavailable ? "worktree" : recovering || conflict || warn ? "warning" : "combine";
  const glyph = recovering && moving
    ? <Spinner size="sm" />
    : <Icon icon={glyphIcon} size="sm" />;

  // Conflict file list — shown inline under the detail when files are known.
  const conflictFiles = conflict ? (live.conflict?.files ?? []) : [];

  // Integrating elsewhere rewrites the session's target on the server, then
  // runs the same merge-back; a conflict there is shown against that branch.
  const integrateInto = (target: IsolationTargetDto) => {
    setMergingIntoFor({ sessionId, branch: target.branch });
    void run("merge", async () => {
      applySession((await api.isolationMerge(sessionId, { target: { branch: target.branch, path: target.path } })).session);
    }).finally(() => setMergingIntoFor((current) => current?.sessionId === sessionId ? null : current));
  };
  const targetRows: MenuEntry[] = otherTargets
    .filter((target) => target !== originSwitched)
    .map((target) => ({
      id: `target:${target.path}`,
      label: targetLabel(target.branch),
      detail: target.path,
      icon: BranchIcon,
      disabled: busy !== null || working,
      onSelect: () => integrateInto(target),
    }));
  const canChooseTarget = targetRows.length > 0 && !recovering && !unavailable && !working && !runtimeRecovering;
  // Another branch is an alternative, so it waits one level down in the
  // overflow and the card keeps its two-plus-one shape. Only when no default
  // target can take the work is choosing one the card's own way forward.
  const chooseOnCard = canChooseTarget && stranded;

  // Destructive endings live behind the overflow whenever a better action is
  // on the card. They stay in the open only when they are the only way out.
  const overflow: MenuEntry[] = [];
  if (canChooseTarget && !chooseOnCard) {
    overflow.push({
      id: "integrate-elsewhere",
      label: tr("isolation.integrateElsewhere"),
      icon: CombineIcon,
      entries: targetRows,
      onSelect: () => {},
    });
  }
  overflow.push({
    id: "hide",
    label: tr("isolation.hideUntilNextTurn"),
    icon: HideIcon,
    onSelect: () => setHiddenFor({ sessionId, turn }),
  });
  if (canDelete && !unavailable) {
    overflow.push({
      id: "delete",
      label: tr("sidebar.sessionlist.deleteSession"),
      icon: DeleteIcon,
      danger: true,
      disabled: busy !== null || working,
      onSelect: () => setConfirmingDelete(true),
    });
  }
  if (recovering && actions?.canAbandon === true) {
    overflow.push({
      id: "abandon",
      label: tr("isolation.finishWithoutCleanup"),
      icon: WorktreeIcon,
      danger: true,
      disabled: busy !== null || working,
      onSelect: () => { void abandon(); },
    });
  }

  const card = (
      <section
        ref={cardRef}
        className={`isolation-card ui-glass-dock${warn ? " isolation-card--warn" : ""}`}
        role="status"
        aria-label={title}
        aria-busy={busy !== null}
        data-moving={recovering && moving ? "" : undefined}
      >
        <div className="isolation-card-head">
          {/* Keyed swaps: a new glyph or title mounts fresh and crossfades in. */}
          <span className="isolation-card-glyph" aria-hidden="true">
            <span key={glyphKey} className="isolation-card-glyph-swap">{glyph}</span>
          </span>
          <div className="isolation-card-copy">
            <strong key={title} className="isolation-card-title">{title}</strong>
            {(ready || originSwitched) && (
              <span className="isolation-card-meta">
                <Icon icon={BranchIcon} size="sm" />
                {tr("isolation.basedOn", { branch: targetBranch })}
              </span>
            )}
          </div>
          {overflow.length > 0 && (
            <Menu label={tr("common.more")} align="end" entries={overflow}>
              {(trigger) => (
                <IconButton
                  {...trigger}
                  icon={MoreIcon}
                  size="sm"
                  className="isolation-card-overflow"
                  disabled={busy !== null || working}
                  label={tr("common.more")}
                />
              )}
            </Menu>
          )}
        </div>
        {detail && <p className="isolation-card-note">{detail}</p>}
        {conflictFiles.length > 0 && (
          <ul className="isolation-card-conflict-files">
            {conflictFiles.slice(0, 8).map((file) => (
              <li key={file}>
                <button
                  type="button"
                  className="isolation-card-conflict-file"
                  onClick={() => reviewConflicts(file)}
                >
                  {file}
                </button>
              </li>
            ))}
            {conflictFiles.length > 8 && (
              <li className="isolation-card-conflict-more">
                {tr("isolation.conflictFilesMore", { count: String(conflictFiles.length - 8) })}
              </li>
            )}
          </ul>
        )}
        {delegatedPending && !conflict && !recovering && (
          <ul className="isolation-card-conflict-files" aria-label={tr("isolation.delegatedPending")}>
            {delegated.slice(0, 8).map((child) => (
              <li key={child.sessionId}>
                <button
                  type="button"
                  className="isolation-card-conflict-file isolation-card-delegated-agent"
                  onClick={() => activateSession(child.sessionId)}
                >
                  {child.title}
                </button>
              </li>
            ))}
            {delegated.length > 8 && (
              <li className="isolation-card-conflict-more">
                {tr("isolation.conflictFilesMore", { count: String(delegated.length - 8) })}
              </li>
            )}
          </ul>
        )}
        {steps && <ProgressSteps steps={steps} />}
        {showPath && <p className="isolation-card-path mono">{live.worktreePath}</p>}
        <div className="isolation-card-actions">
          {(stranded || dirtyBlocked) && (
            <Button size="sm" disabled={busy !== null} onClick={() => void refresh()}>
              {tr("gitview.checkAgain")}
            </Button>
          )}
          {actions?.canReview === true && !recovering && !unavailable && !dirtyBlocked ? (
            <Button size="sm" disabled={busy !== null} onClick={conflict ? () => reviewConflicts() : () => { handoffReviewScope(workspacePresentationKey("git-review-handoff", session.projectId, sessionId), "branch"); openChanges(); }}>
              {conflict ? tr("isolation.reviewConflicts") : tr("isolation.reviewChanges")}
            </Button>
          ) : null}
          {status !== null && !recovering && !unavailable && !working && (
            <Button
              size="sm"
              iconStart={PushIcon}
              disabled={busy !== null || working}
              busy={busy === "push"}
              onClick={openPushDialog}
            >
              {tr("isolation.commitAndPush")}
            </Button>
          )}
          {unavailable && canDelete && (
            <Button
              size="sm"
              variant="danger"
              className="isolation-card-primary"
              disabled={busy !== null || working}
              busy={busy === "delete"}
              onClick={() => setConfirmingDelete(true)}
            >
              {tr("sidebar.sessionlist.deleteSession")}
            </Button>
          )}
          {recoveryNeeded && actions?.canRecover === true && (
            <Button
              size="sm"
              variant="primary"
              className="isolation-card-primary"
              onClick={() => void run("recover", async () => {
                applySession(await api.isolationRecover(sessionId));
              })}
            >
              {tr("isolation.retryRecovery")}
            </Button>
          )}
          {conflict && actions?.canResolve === true && (
            <Button
              size="sm"
              variant="primary"
              className="isolation-card-primary"
              disabled={busy !== null || working}
              onClick={() => void run("resolve", async () => {
                await api.isolationResolve(sessionId);
                setPendingAutoMergeOf({ sessionId, started: false });
              })}
            >
              {tr("isolation.resolveAndProceed")}
            </Button>
          )}
          {chooseOnCard && (
            <Menu label={tr("isolation.integrateElsewhere")} align="end" entries={targetRows}>
              {(trigger) => (
                <Button
                  {...trigger}
                  size="sm"
                  variant="primary"
                  className="isolation-card-primary"
                  iconStart={CombineIcon}
                  iconEnd={ChevronDownIcon}
                  disabled={busy !== null || working}
                  busy={busy === "merge"}
                >
                  {tr("isolation.integrateElsewhere")}
                </Button>
              )}
            </Menu>
          )}
          {originSwitched && !recovering && (
            <Button
              size="sm"
              variant="primary"
              className="isolation-card-primary"
              iconStart={CombineIcon}
              disabled={busy !== null || working}
              busy={busy === "merge"}
              onClick={() => integrateInto(originSwitched)}
            >
              {tr("isolation.integrateInto", { branch: targetLabel(originSwitched.branch) })}
            </Button>
          )}
          {!conflict && !unavailable && !dirtyBlocked && ready && (
            <Button
              size="sm"
              variant="primary"
              className="isolation-card-primary"
              iconStart={CombineIcon}
              disabled={busy !== null || working}
              busy={busy === "merge"}
              onClick={() => void run("merge", async () => {
                applySession((await api.isolationMerge(sessionId)).session);
              })}
            >
              {tr("isolation.integrateInto", { branch: targetBranch })}
            </Button>
          )}
        </div>
      </section>
  );

  const overlays = (
    <>
      {confirmingDelete && (
        <Dialog
          title={tr("sidebar.sessionlist.deleteSession")}
          onClose={() => setConfirmingDelete(false)}
          footer={(
            <>
              <Button size="sm" onClick={() => setConfirmingDelete(false)}>{tr("common.cancel")}</Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy !== null}
                busy={busy === "delete"}
                onClick={() => { void confirmDelete(); }}
              >
                {tr("common.delete")}
              </Button>
            </>
          )}
        >
          <p>{tr("isolation.discardConfirmGeneric")}</p>
          <p>{tr("isolation.discardTargetUnchanged", { branch: targetBranch })}</p>
        </Dialog>
      )}
      {pushDialogOpen && (
        <Dialog
          title={tr("isolation.commitAndPush")}
          onClose={() => setPushDialogOpen(false)}
          footer={(
            <>
              <Button size="sm" onClick={() => setPushDialogOpen(false)}>{tr("common.cancel")}</Button>
              <Button
                size="sm"
                variant="primary"
                iconStart={PushIcon}
                disabled={busy !== null || !pushBranchName.trim()}
                busy={busy === "push"}
                onClick={() => { void submitPush(); }}
              >
                {tr("isolation.commitAndPush")}
              </Button>
            </>
          )}
        >
          <label className="isolation-push-field">
            <span>{tr("gitview.branch")}</span>
            <TextInput
              uiSize="sm"
              value={pushBranchName}
              placeholder={tr("gitview.branchNamePlaceholder")}
              aria-label={tr("gitview.branch")}
              onChange={(event) => setPushBranchName(event.target.value)}
            />
          </label>
          <label className="isolation-push-field">
            <span>{tr("gitview.commitMessage")}</span>
            <TextInput
              uiSize="sm"
              value={pushMessage}
              placeholder={tr("gitview.commitMessage")}
              aria-label={tr("gitview.commitMessage")}
              onChange={(event) => setPushMessage(event.target.value)}
            />
          </label>
          <p className="muted">{tr("isolation.commitAndPushHint")}</p>
        </Dialog>
      )}
    </>
  );

  return {
    sessionId,
    card: cardHidden ? null : card,
    done: null,
    overlays,
    integrating: busy === "merge" || pendingAutoMerge || integrating,
    mergedAt: null,
  };
}

export function IsolationLock() {
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null,
  );
  const isolation = isolationOf(session);
  if (!session || !isolation) return null;
  const branch = targetLabel(isolation.targetBranch);
  const details = badgeDetails(isolation);
  return (
    <span className="isolation-lock" title={details} aria-label={`${tr("isolation.isolatedBranch", { branch })}. ${details}`}>
      <LockIcon aria-hidden="true" />
    </span>
  );
}

export function IsolationListBadge({ sessionId }: { sessionId: string }) {
  // A merge receipt outranks the isolation marker: a published merge whose
  // cleanup is still pending is merged, not isolated work in progress.
  const mergedInto = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === sessionId)?.isolationMerge?.targetBranch ?? null,
  );
  const isolated = useStore((state) => {
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    return session?.isolationSummary === "git-worktree" || session?.isolation?.kind === "git-worktree"
      || session?.branch?.startsWith("polyth/isolate/") === true;
  });
  if (mergedInto !== null) {
    const label = tr("isolation.mergedIntoBranch", { branch: targetLabel(mergedInto) });
    return (
      <span className="isolation-list-badge is-merged" title={label} aria-label={label}>
        <BranchIcon aria-hidden="true" />
      </span>
    );
  }
  if (!isolated) return null;
  const label = tr("isolation.isolated");
  return (
    <span className="isolation-list-badge" title={label} aria-label={label}>
      <LockIcon aria-hidden="true" />
    </span>
  );
}

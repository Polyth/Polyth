import type { HarnessSelection, ModelRef, SessionProjection } from "@polyth/contracts";
import type { TurnState } from "./reduce.ts";

/** The presentation-only prompt state needed to resolve the activity dock. */
export interface PendingActivitySend {
  model?: ModelRef;
  harness?: HarnessSelection;
  delivery?: "steer" | "interrupt" | "normal";
}

export type SessionActivitySession = Pick<
  SessionProjection,
  "status" | "resolvedHarnessId" | "runtimeLeg" | "harnessTransition" | "model"
>;

export type SessionActivityTurn = Pick<
  TurnState,
  "status" | "model" | "harnessId" | "runtimeLegId"
>;

export interface SessionActivityState {
  /** True when the live dock owns the activity zone. */
  working: boolean;
  /** True when a submitted prompt owns the startup handoff. */
  awaitingTurn: boolean;
  pendingSend?: PendingActivitySend;
  /** Model for the currently visible activity, never a stale previous turn. */
  model?: ModelRef;
  /** Harness that owns the visible activity or startup handoff. */
  harnessId?: string;
}

const sameIdentityOrUnknown = (expected: string | undefined, actual: string | undefined): boolean =>
  expected === undefined || actual === undefined || expected === actual;

function pinnedHarnessId(selection: HarnessSelection | undefined): string | undefined {
  return selection?.mode === "pinned" ? selection.harnessId : undefined;
}

/**
 * Resolve the one activity owner for a session.
 *
 * The event reducer and projection stream are intentionally separate. During a
 * harness epoch switch the old turn can therefore remain in the render cache
 * after the projection has released its runtime. Keep both startup and live
 * surfaces on this resolver so that stale turns cannot revive the old model or
 * make two docks visible during the handoff.
 */
export function resolveSessionActivity(
  session: SessionActivitySession | null | undefined,
  turn: SessionActivityTurn | null | undefined,
  pendingSends: readonly PendingActivitySend[],
): SessionActivityState {
  const pendingSend = pendingSends.at(-1);
  const transition = session?.harnessTransition;
  const runtimeHandoff = session?.status === "epoch-pending"
    || transition?.phase === "released"
    || transition?.phase === "failed";

  // A turn is current only while its runtime leg still owns the projection.
  // Missing identity fields remain compatible with legacy events, but once a
  // provider supplies either identity a mismatched old turn is fenced out.
  const currentTurnWorking = turn?.status === "working"
    && !runtimeHandoff
    && sameIdentityOrUnknown(session?.runtimeLeg?.id, turn.runtimeLegId)
    && sameIdentityOrUnknown(session?.resolvedHarnessId, turn.harnessId);
  const projectionWorking = session?.status === "working" && !runtimeHandoff;
  const working = projectionWorking || currentTurnWorking;
  const awaitingTurn = pendingSend !== undefined && !working;

  const pendingHarnessId = pinnedHarnessId(pendingSend?.harness);
  const pendingSwitchTarget = pendingSend && transition ? transition.targetHarnessId : undefined;
  const handoffTarget = runtimeHandoff ? transition?.targetHarnessId : undefined;
  const harnessId = pendingHarnessId
    ?? pendingSwitchTarget
    ?? handoffTarget
    ?? (currentTurnWorking ? turn?.harnessId : undefined)
    ?? session?.resolvedHarnessId
    ?? transition?.targetHarnessId;

  // A submitted selection is the freshest user intent. Once it retires, a
  // current turn's own model wins; importantly, an Auto turn with no model
  // must not fall back to the previous projection model. Before turn hydration
  // the canonical working projection is the safe source instead.
  const model = pendingSend?.model
    ?? (currentTurnWorking ? turn?.model : undefined)
    ?? (projectionWorking && !currentTurnWorking ? session?.model : undefined);

  return {
    working,
    awaitingTurn,
    ...(pendingSend ? { pendingSend } : {}),
    ...(model ? { model } : {}),
    ...(harnessId ? { harnessId } : {}),
  };
}

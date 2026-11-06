// Wire shapes of /api/limit-windows, shared with the settings page. Type-only
// imports: this file adds nothing to the browser graph.
import type { Decision, HoldReason, PingRecord } from "./decide.ts";
import type { PlannedWindow, PlanModel, StartReason, WindowPlan } from "./plan.ts";
import type { WindowPhase } from "./windows.ts";

export type { HoldReason, PingRecord, PlannedWindow, PlanModel, StartReason, WindowPhase, WindowPlan, Decision };

export interface WindowView {
  id: string;
  label: string;
  phase: WindowPhase;
  /** Share used, 0..1. */
  used: number;
  resetsAt?: number;
  periodMs?: number;
}

export interface ModelOption extends PlanModel {
  name: string;
}

/** Why a meter has no way to start a window. */
export type RouteProblem =
  /** No registered harness can reach this source. */
  | "no-route"
  /** Its harness lists no model that this meter's windows answer to. */
  | "no-model";

export interface MeterView {
  id: string;
  label?: string;
  windows: WindowView[];
  /** The window a chosen hour lines up. */
  primaryId: string;
  /** The current window of the primary, when one is running. */
  running?: { from: number; to: number };
  planned: PlannedWindow[];
  next?: { at: number; reason: StartReason; targetAt?: number };
  hold?: HoldReason;
  holdUntil?: number;
  /** The model a request would use. */
  model?: ModelOption;
  /** The plan's chosen model is no longer offered, so this one replaces it. */
  modelReplaced?: boolean;
  options: ModelOption[];
  problem?: RouteProblem;
  /** Newest first. */
  history: PingRecord[];
  /** A request of this meter is on its way. */
  busy: boolean;
  /** A request went out and its effect is not read yet. */
  checking?: boolean;
}

export interface SourceView {
  id: string;
  title: string;
  /** The harness a request runs on. */
  harnessId?: string;
  /** Only this person's own private login. */
  private: boolean;
  access: "edit" | "view";
  plan: WindowPlan;
  /** Whether the person saved a plan yet. */
  saved: boolean;
  fetchedAt: number;
  stale: boolean;
  error?: string;
  meters: MeterView[];
}

export interface LimitWindowsState {
  /** False on a deployment that does not run host logins for tenants. */
  available: boolean;
  now: number;
  sources: SourceView[];
}

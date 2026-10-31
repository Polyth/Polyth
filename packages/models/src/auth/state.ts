import type { AuthPhase } from "@polyth/contracts";

const WAITING: ReadonlySet<AuthPhase> = new Set([
  "starting",
  "browser_action_required",
  "device_action_required",
  "awaiting_code",
  "waiting",
  "validating",
]);

const TERMINAL: ReadonlySet<AuthPhase> = new Set([
  "connected",
  "configured_unverified",
  "failed",
  "denied",
  "expired",
  "cancelled",
  "stale",
]);

export const isWaitingPhase = (phase: AuthPhase): boolean => WAITING.has(phase);
export const isTerminalPhase = (phase: AuthPhase): boolean => TERMINAL.has(phase);

export const canTransition = (from: AuthPhase, to: AuthPhase): boolean => {
  if (from === to) return true;
  if (TERMINAL.has(from) && to !== "stale") return false;
  const allowed: Partial<Record<AuthPhase, readonly AuthPhase[]>> = {
    starting: [
      "browser_action_required", "device_action_required",
      "awaiting_code", "waiting", "validating", "configured_unverified",
      "failed", "denied", "cancelled", "stale",
    ],
    browser_action_required: ["waiting", "validating", "awaiting_code", "failed", "denied", "cancelled", "expired", "stale"],
    device_action_required: ["waiting", "validating", "failed", "denied", "cancelled", "expired", "stale"],
    awaiting_code: ["validating", "waiting", "failed", "denied", "cancelled", "expired", "stale"],
    waiting: ["validating", "connected", "configured_unverified", "failed", "denied", "cancelled", "expired", "stale"],
    validating: ["connected", "configured_unverified", "failed", "denied", "expired", "stale", "cancelled"],
    connected: ["stale"],
    configured_unverified: ["stale"],
    failed: ["stale"],
    denied: ["stale"],
    expired: ["stale"],
    cancelled: ["stale"],
    stale: [],
  };
  return (allowed[from] ?? []).includes(to);
};

export const transitionPhase = (from: AuthPhase, to: AuthPhase): AuthPhase =>
  canTransition(from, to) ? to : from;

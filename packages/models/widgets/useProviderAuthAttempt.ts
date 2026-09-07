import { useEffect, useRef, useState } from "react";
import { api, errorCodeOf, httpStatusOf } from "@polyth/session/web-api";
import type { AuthAttemptDto, AuthErrorDto } from "@polyth/contracts";
import { isTerminalPhase, isWaitingPhase } from "../src/auth/state.ts";

const BASE_MS = 1500;
const MAX_MS = 12_000;
const TRANSIENT_AUTH_CODES = new Set(["AUTH_NETWORK_ERROR", "AUTH_PROVIDER_UNREACHABLE"]);

const nextDelay = (failures: number): number => {
  const exp = Math.min(MAX_MS, BASE_MS * (2 ** Math.min(failures, 4)));
  return Math.floor(exp * (0.8 + Math.random() * 0.4));
};

const isObservablePhase = (phase: AuthAttemptDto["phase"]): boolean =>
  isWaitingPhase(phase)
  || phase === "awaiting_code"
  || phase === "browser_action_required"
  || phase === "device_action_required";

const isTransientPollFailure = (caught: unknown): boolean => {
  const code = errorCodeOf(caught);
  const status = httpStatusOf(caught);
  if (code.startsWith("AUTH_") && !TRANSIENT_AUTH_CODES.has(code)) return false;
  if (status === 429 || status === 408) return true;
  if (status >= 400 && status < 500) return false;
  return true;
};

/**
 * Owns attempt observation: every DTO — restored, poll, or mutation result —
 * goes through applyAttempt so terminal phases always notify once.
 */
export function useProviderAuthAttempt(input: {
  restored?: AuthAttemptDto;
  onConnected: () => void;
  onMethodError: (methodId: string, error: AuthErrorDto) => void;
}): {
  attempt: AuthAttemptDto | null;
  setAttempt: (next: AuthAttemptDto | null) => void;
  watching: boolean;
} {
  const [attempt, setAttemptState] = useState<AuthAttemptDto | null>(input.restored ?? null);
  const attemptRef = useRef<AuthAttemptDto | null>(attempt);
  const onConnectedRef = useRef(input.onConnected);
  const onMethodErrorRef = useRef(input.onMethodError);
  onConnectedRef.current = input.onConnected;
  onMethodErrorRef.current = input.onMethodError;
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const notifiedRef = useRef<string | null>(null);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    inFlight.current = false;
  };

  const applyAttempt = (next: AuthAttemptDto | null): "stop" | "continue" => {
    attemptRef.current = next;
    setAttemptState(next);
    if (!next) {
      stop();
      notifiedRef.current = null;
      return "stop";
    }
    const terminalKey = `${next.id}:${next.phase}:${next.error?.code ?? ""}`;
    if (next.phase === "connected" || next.phase === "configured_unverified") {
      stop();
      if (notifiedRef.current !== terminalKey) {
        notifiedRef.current = terminalKey;
        onConnectedRef.current();
      }
      attemptRef.current = null;
      setAttemptState(null);
      return "stop";
    }
    if (isTerminalPhase(next.phase)) {
      stop();
      if (next.error && notifiedRef.current !== terminalKey) {
        notifiedRef.current = terminalKey;
        onMethodErrorRef.current(next.methodId, next.error);
      }
      attemptRef.current = null;
      setAttemptState(null);
      return "stop";
    }
    notifiedRef.current = null;
    return "continue";
  };

  useEffect(() => {
    const id = attempt?.id;
    if (!id || !isObservablePhase(attempt.phase)) {
      stop();
      return;
    }
    let cancelled = false;
    let failures = 0;
    const poll = async () => {
      if (cancelled || inFlight.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        timerRef.current = setTimeout(() => void poll(), MAX_MS);
        return;
      }
      inFlight.current = true;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const fresh = await api.providerAuthAttempt(id, controller.signal);
        failures = 0;
        inFlight.current = false;
        if (cancelled || attemptRef.current?.id !== id) return;
        if (applyAttempt(fresh) === "continue") {
          timerRef.current = setTimeout(() => void poll(), BASE_MS);
        }
      } catch (caught) {
        inFlight.current = false;
        if (cancelled || controller.signal.aborted) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        const code = (errorCodeOf(caught) || (caught as { code?: string }).code || "AUTH_NETWORK_ERROR") as AuthErrorDto["code"];
        if (!isTransientPollFailure(caught)) {
          const current = attemptRef.current;
          const error: AuthErrorDto = {
            code,
            message,
            ...((caught as { details?: string }).details ? { details: (caught as { details: string }).details } : {}),
            ...((caught as { field?: string }).field ? { field: (caught as { field: string }).field } : {}),
          };
          const phase: AuthAttemptDto["phase"] = code === "AUTH_EXPIRED"
            ? "expired"
            : code === "AUTH_DENIED"
              ? "denied"
              : code === "AUTH_CANCELLED"
                ? "cancelled"
                : "stale";
          applyAttempt(current ? { ...current, phase, error } : null);
          return;
        }
        failures += 1;
        timerRef.current = setTimeout(() => void poll(), nextDelay(failures));
        if (failures === 1) {
          onMethodErrorRef.current(attemptRef.current?.methodId ?? "", {
            code: "AUTH_NETWORK_ERROR",
            message,
          });
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      stop();
    };
  }, [attempt?.id, attempt?.phase]);

  useEffect(() => {
    if (!input.restored) return;
    if (input.restored.id !== attemptRef.current?.id) {
      applyAttempt(input.restored);
      return;
    }
    if (
      notifiedRef.current === null
      && (input.restored.phase === "connected" || input.restored.phase === "configured_unverified")
    ) {
      applyAttempt(input.restored);
    }
  }, [input.restored?.id]);

  return {
    attempt,
    setAttempt: applyAttempt,
    watching: Boolean(attempt && !isTerminalPhase(attempt.phase)),
  };
}

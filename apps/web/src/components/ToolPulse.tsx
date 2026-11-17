import { useEffect, useRef, useState } from "react";
import { api } from "@polyth/session/web-api";
import { fmtDuration } from "../format.ts";
import { tr } from "../i18n/index.ts";
import { useToolLastOutputAt } from "../toolProgress.ts";
import { Button } from "./ui/index.ts";
import "./ToolPulse.css";

/** The server's silence watchdog stops a tool call after this long without
 *  activity (packages/server/src/sessions.ts); on harnesses without progress
 *  signals that is counted from the call's start. */
export const TOOL_SILENCE_STOP_MS = 10 * 60_000;
/** From here on (the last two minutes), a call says when Polyth will stop it. */
export const TOOL_SILENCE_HINT_MS = 8 * 60_000;

/** The server's hard ceiling: no command runs longer, kept or not. */
export const TOOL_HARD_STOP_MS = 60 * 60_000;
/** From here on every call says when the ceiling stops it. */
export const TOOL_HARD_HINT_MS = 50 * 60_000;

export interface ToolPulseState {
  elapsedMs: number;
  /** Only when a progress frame was received; never inferred. */
  lastOutputAgoMs?: number;
  quietMs: number;
  /** The silence countdown is showing: quiet long enough and not kept. */
  nearStop: boolean;
  /** The person told Polyth to keep this call running through silence. */
  kept: boolean;
  /** Close to the hard ceiling (from 50 minutes after the start). */
  nearCeiling: boolean;
}

/** Pure reading of one running call. `lastOutputAt` is this client's receipt
 *  time of the newest `tool/progress` frame. */
export function toolPulseState(now: number, startedAt: number, lastOutputAt?: number, kept = false): ToolPulseState {
  const elapsedMs = Math.max(0, now - startedAt);
  const lastOutputAgoMs = lastOutputAt === undefined ? undefined : Math.max(0, now - lastOutputAt);
  const quietMs = lastOutputAgoMs ?? elapsedMs;
  return {
    elapsedMs,
    ...(lastOutputAgoMs === undefined ? {} : { lastOutputAgoMs }),
    quietMs,
    nearStop: !kept && quietMs >= TOOL_SILENCE_HINT_MS,
    kept,
    nearCeiling: elapsedMs >= TOOL_HARD_HINT_MS,
  };
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Live state of a running call, ticking once a second while `running`. */
export function useToolPulse(sessionId: string | null | undefined, callId: string, startedAt: number, running: boolean, kept = false): ToolPulseState | null {
  const lastOutputAt = useToolLastOutputAt(sessionId, callId);
  const now = useNow(running);
  return running ? toolPulseState(now, startedAt, lastOutputAt, kept) : null;
}

const lastOutputText = (ms: number) => tr("execution.pulseLastOutput", { ago: fmtDuration(ms) });
const lastOutputLine = (ms: number) => tr("execution.pulseLastOutputLine", { ago: fmtDuration(ms) });
/** Whole seconds left before the watchdog stops the call. */
const stopsIn = (pulse: ToolPulseState) => fmtDuration(Math.max(0, TOOL_SILENCE_STOP_MS - pulse.quietMs));

/** Whole seconds left before the hard ceiling stops the call. */
const ceilingIn = (pulse: ToolPulseState) => fmtDuration(Math.max(0, TOOL_HARD_STOP_MS - pulse.elapsedMs));

/** Under an expanded running tool row, one line: when output was last seen,
 *  and in the last two minutes before the watchdog, when the call stops. It
 *  claims silence only after a progress frame proved the harness reports
 *  output; elapsed time is in the row's status mark already. */
export function ToolPulseLine({ sessionId, callId, startedAt, kept = false }: { sessionId: string | null | undefined; callId: string; startedAt: number; kept?: boolean }) {
  const pulse = useToolPulse(sessionId, callId, startedAt, true, kept);
  const lineRef = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // The button vanishes once the event arrives: focus moves to the line that
  // replaces it instead of dropping to the page.
  useEffect(() => {
    if (kept && pressed.current) {
      pressed.current = false;
      lineRef.current?.focus();
    }
  }, [kept]);
  if (!pulse || (pulse.lastOutputAgoMs === undefined && !pulse.nearStop && !pulse.kept && !pulse.nearCeiling)) return null;
  if (pulse.nearCeiling) {
    return (
      <div className="tool-pulse tool-pulse--stopping" ref={lineRef} tabIndex={-1}>
        <span className="tool-pulse-text"><span className="tool-pulse-stop">{tr("execution.pulseCeiling", { duration: ceilingIn(pulse) })}</span></span>
      </div>
    );
  }
  if (pulse.kept) {
    return (
      <div className="tool-pulse" ref={lineRef} tabIndex={-1}>
        <span className="tool-pulse-text" role="status">{tr("execution.pulseKept", { duration: fmtDuration(pulse.quietMs) })}</span>
      </div>
    );
  }
  if (!pulse.nearStop) {
    return <div className="tool-pulse"><span className="tool-pulse-text">{lastOutputLine(pulse.lastOutputAgoMs!)}</span></div>;
  }
  // The line says who stops it and why, in place: a bare "stops in 1m" read
  // as "finishes in 1m", and the policy was only in a hover tooltip.
  const stop = pulse.lastOutputAgoMs === undefined
    ? tr("execution.pulseStopsInLine", { duration: stopsIn(pulse) })
    : tr("execution.pulseStopsInQuiet", { duration: stopsIn(pulse) });
  const keep = () => {
    if (!sessionId || busy) return;
    setBusy(true);
    setFailed(false);
    pressed.current = true;
    api.keepToolRunning(sessionId, callId)
      .catch(() => { pressed.current = false; setFailed(true); })
      .finally(() => setBusy(false));
  };
  return (
    <div className="tool-pulse tool-pulse--stopping" ref={lineRef} tabIndex={-1} title={tr("execution.pulseStopHint")}>
      <span className="tool-pulse-text">
        {pulse.lastOutputAgoMs !== undefined
          ? <>{tr("execution.pulseNoOutput", { duration: fmtDuration(pulse.lastOutputAgoMs) })}<span aria-hidden="true"> · </span></>
          : null}
        <span className="tool-pulse-stop">{stop}</span>
        {sessionId ? (
          <Button
            className="tool-pulse-keep"
            variant="ghost"
            size="sm"
            busy={busy}
            aria-label={tr("execution.keepRunningHint")}
            onClick={keep}
          >
            {tr("execution.keepRunning")}
          </Button>
        ) : null}
        {failed ? <span className="tool-pulse-error" role="alert"> {tr("execution.keepRunningFailed")}</span> : null}
      </span>
    </div>
  );
}

/** The same facts, compact, after the step a collapsed activity block names:
 *  "· 3m 12s · last output 6s ago", or near the watchdog "· 8m 50s · stops in 1m 10s". */
export function ToolPulseInline({ sessionId, callId, startedAt, kept = false }: { sessionId: string | null | undefined; callId: string; startedAt: number; kept?: boolean }) {
  const pulse = useToolPulse(sessionId, callId, startedAt, true, kept);
  if (!pulse) return null;
  return (
    <span
      className={`tool-pulse-inline${pulse.nearStop || pulse.nearCeiling ? " tool-pulse--stopping" : ""}`}
      title={pulse.nearStop ? tr("execution.pulseStopHint") : undefined}
    >
      <span className="tool-pulse-part">{fmtDuration(pulse.elapsedMs)}</span>
      {pulse.nearCeiling
        ? <span className="tool-pulse-part tool-pulse-stop">{tr("execution.pulseStopsIn", { duration: ceilingIn(pulse) })}</span>
        : pulse.kept
        ? <span className="tool-pulse-part">{tr("execution.pulseKeptInline")}</span>
        : pulse.nearStop
        ? <span className="tool-pulse-part tool-pulse-stop">{tr("execution.pulseStopsIn", { duration: stopsIn(pulse) })}</span>
        : pulse.lastOutputAgoMs !== undefined
          ? <span className="tool-pulse-part">{lastOutputText(pulse.lastOutputAgoMs)}</span>
          : null}
    </span>
  );
}

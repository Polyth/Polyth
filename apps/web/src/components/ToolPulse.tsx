import { useEffect, useState } from "react";
import { fmtDuration } from "../format.ts";
import { tr } from "../i18n/index.ts";
import { useToolLastOutputAt } from "../toolProgress.ts";
import "./ToolPulse.css";

/** The server's silence watchdog stops a tool call after this long without
 *  activity (packages/server/src/sessions.ts); on harnesses without progress
 *  signals that is counted from the call's start. */
export const TOOL_SILENCE_STOP_MS = 10 * 60_000;
/** From here on (the last two minutes), a call says when Polyth will stop it. */
export const TOOL_SILENCE_HINT_MS = 8 * 60_000;

export interface ToolPulseState {
  elapsedMs: number;
  /** Only when a progress frame was received; never inferred. */
  lastOutputAgoMs?: number;
  quietMs: number;
  nearStop: boolean;
}

/** Pure reading of one running call. `lastOutputAt` is this client's receipt
 *  time of the newest `tool/progress` frame. */
export function toolPulseState(now: number, startedAt: number, lastOutputAt?: number): ToolPulseState {
  const elapsedMs = Math.max(0, now - startedAt);
  const lastOutputAgoMs = lastOutputAt === undefined ? undefined : Math.max(0, now - lastOutputAt);
  const quietMs = lastOutputAgoMs ?? elapsedMs;
  return {
    elapsedMs,
    ...(lastOutputAgoMs === undefined ? {} : { lastOutputAgoMs }),
    quietMs,
    nearStop: quietMs >= TOOL_SILENCE_HINT_MS,
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
export function useToolPulse(sessionId: string | null | undefined, callId: string, startedAt: number, running: boolean): ToolPulseState | null {
  const lastOutputAt = useToolLastOutputAt(sessionId, callId);
  const now = useNow(running);
  return running ? toolPulseState(now, startedAt, lastOutputAt) : null;
}

const lastOutputText = (ms: number) => tr("execution.pulseLastOutput", { ago: fmtDuration(ms) });
const lastOutputLine = (ms: number) => tr("execution.pulseLastOutputLine", { ago: fmtDuration(ms) });
/** Whole seconds left before the watchdog stops the call. */
const stopsIn = (pulse: ToolPulseState) => fmtDuration(Math.max(0, TOOL_SILENCE_STOP_MS - pulse.quietMs));

/** Under an expanded running tool row, one line: when output was last seen,
 *  and in the last two minutes before the watchdog, when the call stops. It
 *  claims silence only after a progress frame proved the harness reports
 *  output; elapsed time is in the row's status mark already. */
export function ToolPulseLine({ sessionId, callId, startedAt }: { sessionId: string | null | undefined; callId: string; startedAt: number }) {
  const pulse = useToolPulse(sessionId, callId, startedAt, true);
  if (!pulse || (pulse.lastOutputAgoMs === undefined && !pulse.nearStop)) return null;
  if (!pulse.nearStop) {
    return <div className="tool-pulse"><span className="tool-pulse-text">{lastOutputLine(pulse.lastOutputAgoMs!)}</span></div>;
  }
  const stop = pulse.lastOutputAgoMs === undefined
    ? tr("execution.pulseStopsInLine", { duration: stopsIn(pulse) })
    : tr("execution.pulseStopsIn", { duration: stopsIn(pulse) });
  return (
    <div className="tool-pulse tool-pulse--stopping" title={tr("execution.pulseStopHint")}>
      <span className="tool-pulse-text">
        {pulse.lastOutputAgoMs !== undefined
          ? <>{tr("execution.pulseNoOutput", { duration: fmtDuration(pulse.lastOutputAgoMs) })}<span aria-hidden="true"> · </span></>
          : null}
        <span className="tool-pulse-stop">{stop}</span>
      </span>
    </div>
  );
}

/** The same facts, compact, after the step a collapsed activity block names:
 *  "· 3m 12s · last output 6s ago", or near the watchdog "· 8m 50s · stops in 1m 10s". */
export function ToolPulseInline({ sessionId, callId, startedAt }: { sessionId: string | null | undefined; callId: string; startedAt: number }) {
  const pulse = useToolPulse(sessionId, callId, startedAt, true);
  if (!pulse) return null;
  return (
    <span
      className={`tool-pulse-inline${pulse.nearStop ? " tool-pulse--stopping" : ""}`}
      title={pulse.nearStop ? tr("execution.pulseStopHint") : undefined}
    >
      <span className="tool-pulse-part">{fmtDuration(pulse.elapsedMs)}</span>
      {pulse.nearStop
        ? <span className="tool-pulse-part tool-pulse-stop">{tr("execution.pulseStopsIn", { duration: stopsIn(pulse) })}</span>
        : pulse.lastOutputAgoMs !== undefined
          ? <span className="tool-pulse-part">{lastOutputText(pulse.lastOutputAgoMs)}</span>
          : null}
    </span>
  );
}

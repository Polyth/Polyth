import { useEffect, useState } from "react";
import { fmtDuration } from "../format.ts";
import { tr } from "../i18n/index.ts";
import { useToolLastOutputAt } from "../toolProgress.ts";
import "./ToolPulse.css";

/** The server's silence watchdog stops a tool call after this long without
 *  activity (packages/server/src/sessions.ts); on harnesses without progress
 *  signals that is counted from the call's start. */
export const TOOL_SILENCE_STOP_MS = 10 * 60_000;
/** From here on, a quiet call says when Polyth will stop it. */
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

/** Under an expanded running tool row: when output was last seen and, after a
 *  long quiet, when Polyth will stop the call. Elapsed time is in the row's
 *  status mark already. */
export function ToolPulseLine({ sessionId, callId, startedAt }: { sessionId: string | null | undefined; callId: string; startedAt: number }) {
  const pulse = useToolPulse(sessionId, callId, startedAt, true);
  if (!pulse || (pulse.lastOutputAgoMs === undefined && !pulse.nearStop)) return null;
  return (
    <div className={`tool-pulse${pulse.nearStop ? " tool-pulse--quiet" : ""}`}>
      {pulse.nearStop
        ? <>
          <span className="tool-pulse-dot" aria-hidden="true" />
          <span className="tool-pulse-text">{tr("execution.pulseQuietFor", { duration: fmtDuration(pulse.quietMs) })}</span>
          <span className="tool-pulse-hint">{tr("execution.pulseStopHint")}</span>
        </>
        : <>
          <span className="tool-pulse-dot tool-pulse-dot--live" aria-hidden="true" />
          <span className="tool-pulse-text">{lastOutputLine(pulse.lastOutputAgoMs!)}</span>
        </>}
    </div>
  );
}

/** The same facts, compact, after the step a collapsed activity block names:
 *  "· 3m 12s · last output 6s ago". */
export function ToolPulseInline({ sessionId, callId, startedAt }: { sessionId: string | null | undefined; callId: string; startedAt: number }) {
  const pulse = useToolPulse(sessionId, callId, startedAt, true);
  if (!pulse) return null;
  const parts = [fmtDuration(pulse.elapsedMs)];
  if (pulse.nearStop) parts.push(tr("execution.pulseQuietShort", { duration: fmtDuration(pulse.quietMs) }));
  else if (pulse.lastOutputAgoMs !== undefined) parts.push(lastOutputText(pulse.lastOutputAgoMs));
  return (
    <span
      className={`tool-pulse-inline${pulse.nearStop ? " tool-pulse--quiet" : ""}`}
      title={pulse.nearStop ? tr("execution.pulseStopHint") : undefined}
    >
      {parts.map((part, index) => <span key={index} className="tool-pulse-part">{part}</span>)}
    </span>
  );
}

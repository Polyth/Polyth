import { useCallback, useEffect, useState } from "react";
import { api, type AgentContextDto, type ScheduleTaskDto } from "@polyth/session/web-api";
import type { WebPackageHost } from "@polyth/web-sdk";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, ChatIcon, Notice, Skeleton } from "../../../apps/web/src/components/ui/index.ts";
import { formatWake } from "./agentTime.ts";

const percent = (value: number): string => `${Math.round(value * 100)}%`;

function warmSentence(context: AgentContextDto): string {
  const warm = context.warm;
  const minutes = Math.round((warm.ttlMs ?? 0) / 60_000);
  if (warm.reason === "off") return tr("agents.warmOff");
  if (warm.reason === "not-rolling") return tr("agents.warmNotRolling");
  if (warm.reason === "no-telemetry") return tr("agents.warmNoTelemetry");
  if (warm.reason === "unknown-ttl") return tr("agents.warmUnknownTtl");
  if (warm.reason === "no-schedule") return tr("agents.warmNoSchedule");
  if (warm.reason === "within-ttl") return tr("agents.warmWithinTtlValue", { minutes });
  const costs = {
    pings: warm.pings ?? 0,
    ping: (warm.pingCost ?? 0).toFixed(2),
    cold: (warm.coldCost ?? 0).toFixed(2),
  };
  if (warm.reason === "too-far") return tr("agents.warmTooFarValue", costs);
  return tr("agents.warmPlannedValue", { ...costs, when: warm.nextPingAt ? formatWake(warm.nextPingAt) : "—" });
}

/** The agent's live context and prompt cache, with the levers that act on them. */
export default function AgentContextPanel({ task, host }: { task: ScheduleTaskDto; host?: WebPackageHost }) {
  const [context, setContext] = useState<AgentContextDto | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const load = useCallback(() => {
    void api.scheduleContext(task.id)
      .then((value) => { setContext(value); setError(""); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [task.id]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (action: "new-session" | "compact") => {
    setBusy(true);
    setNote("");
    try {
      await api.scheduleContextAction(task.id, action);
      setNote(action === "new-session" ? tr("agents.newSessionNext") : tr("agents.compactRequested"));
      load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!context) {
    return error ? <Notice tone="error">{error}</Notice> : <div className="agent-context" role="status" aria-label={tr("agents.loading")}><Skeleton shape="block" /></div>;
  }
  const session = context.session;
  const layers = context.layers;
  const layerTotal = Math.max(1, layers.charter + layers.journal + layers.wake);
  const runs = context.cache.runs;
  const measuredRuns = runs.filter((run) => run.ratio !== null);
  const average = measuredRuns.length ? measuredRuns.reduce((sum, run) => sum + run.ratio!, 0) / measuredRuns.length : null;
  const cacheAge = context.cache.lastActivityAt !== null ? Date.now() - context.cache.lastActivityAt : null;
  const cacheState = context.cache.ttlMs === null || cacheAge === null
    ? null
    : cacheAge < context.cache.ttlMs ? "warm" : "cold";
  const number = (value: number) => value.toLocaleString(getLocale());

  return (
    <div className="agent-context">
      {error && <Notice tone="error">{error}</Notice>}
      {note && <p className="agent-context-note" role="status">{note}</p>}

      <section className="agent-context-block" aria-labelledby={`ctx-session-${task.id}`}>
        <h3 id={`ctx-session-${task.id}`}>{tr("agents.contextSessionTitle")}</h3>
        {context.mode === "fresh" ? (
          <p className="agent-prose">{tr("agents.contextFreshNow")}</p>
        ) : !session ? (
          <p className="agent-prose">{tr("agents.contextNoSession")}</p>
        ) : (
          <>
            <div className="agent-meter" role="img" aria-label={session.fraction !== undefined
              ? tr("agents.contextUsedValue", { used: percent(session.fraction) })
              : tr("agents.contextUnknown")}>
              <span className="agent-meter-fill" style={{ inlineSize: percent(Math.min(1, session.fraction ?? 0)) }} />
              {context.mode === "rolling" && (
                <span className="agent-meter-mark" style={{ insetInlineStart: percent(context.rotateAt) }} aria-hidden="true" />
              )}
            </div>
            <p className="agent-context-line">
              {session.fraction !== undefined
                ? tr("agents.contextUsedValue", { used: percent(session.fraction) })
                : tr("agents.contextUnknown")}
              {session.usedTokens !== undefined && session.limitTokens !== undefined
                ? ` · ${number(Math.round(session.usedTokens))} / ${number(session.limitTokens)}` : ""}
              {context.mode === "rolling"
                ? ` · ${context.whenFull === "compact"
                  ? tr("agents.compactAtValue", { percent: Math.round(context.rotateAt * 100) })
                  : tr("agents.rotateAtValue", { percent: Math.round(context.rotateAt * 100) })}`
                : ""}
              {session.compactedAt ? ` · ${tr("agents.compactedAtValue", { when: formatWake(session.compactedAt) })}` : ""}
            </p>
            <div className="agent-context-actions">
              {host && (
                <Button size="sm" variant="ghost" iconStart={ChatIcon} onClick={() => void host.conversation.openSession(session.id)}>
                  {tr("agents.openSession")}
                </Button>
              )}
              {context.mode === "rolling" && (
                <Button size="sm" disabled={busy} onClick={() => void act("new-session")}>{tr("agents.startNewSession")}</Button>
              )}
              <Button size="sm" disabled={busy || session.status !== "idle"} onClick={() => void act("compact")}>{tr("agents.compactNow")}</Button>
            </div>
          </>
        )}
      </section>

      <section className="agent-context-block" aria-labelledby={`ctx-layers-${task.id}`}>
        <h3 id={`ctx-layers-${task.id}`}>{tr("agents.layersTitle")}</h3>
        <div className="agent-layers" role="img" aria-label={tr("agents.layersAriaValue", {
          charter: number(layers.charter), journal: number(layers.journal), wake: number(layers.wake),
        })}>
          <span data-layer="charter" style={{ flexGrow: layers.charter / layerTotal }} />
          <span data-layer="journal" style={{ flexGrow: layers.journal / layerTotal }} />
          <span data-layer="wake" style={{ flexGrow: layers.wake / layerTotal }} />
        </div>
        <ul className="agent-legend">
          <li data-layer="charter">{tr("agents.layerCharter")} <b>≈{number(layers.charter)}</b></li>
          <li data-layer="journal">{tr("agents.layerJournal")} <b>≈{number(layers.journal)}</b></li>
          <li data-layer="wake">{tr("agents.layerWake")} <b>≈{number(layers.wake)}</b></li>
        </ul>
        <p className="agent-field-hint">{tr("agents.layersHint")}</p>
      </section>

      <section className="agent-context-block" aria-labelledby={`ctx-cache-${task.id}`}>
        <h3 id={`ctx-cache-${task.id}`}>
          {tr("agents.cacheTitle")}
          {average !== null && <span>{tr("agents.cacheAverageValue", { share: percent(average) })}</span>}
        </h3>
        {context.cache.telemetry === "unknown" ? (
          <p className="agent-prose">{tr("agents.cacheNoRuns")}</p>
        ) : context.cache.telemetry === "none" ? (
          <p className="agent-prose">{tr("agents.cacheNotReported")}</p>
        ) : (
          <ol className="agent-cache-runs">
            {runs.map((run) => {
              const total = Math.max(1, run.input + run.read + run.write);
              return (
                <li key={run.runId}>
                  <time dateTime={new Date(run.at).toISOString()}>{formatWake(run.at)}</time>
                  <span className="agent-cache-bar" role="img" aria-label={tr("agents.cacheRunAriaValue", {
                    read: number(run.read), write: number(run.write), input: number(run.input),
                  })}>
                    <span data-part="read" style={{ flexGrow: run.read / total }} />
                    <span data-part="write" style={{ flexGrow: run.write / total }} />
                    <span data-part="input" style={{ flexGrow: run.input / total }} />
                  </span>
                  <b>{run.ratio === null ? "—" : percent(run.ratio)}</b>
                </li>
              );
            })}
          </ol>
        )}
        <ul className="agent-legend">
          <li data-part="read">{tr("agents.cacheRead")}</li>
          <li data-part="write">{tr("agents.cacheWrite")}</li>
          <li data-part="input">{tr("agents.cacheUncached")}</li>
        </ul>
        <p className="agent-field-hint">
          {context.cache.ttlMs === null
            ? tr("agents.cacheTtlUnknown")
            : tr("agents.cacheTtlValue", { minutes: Math.round(context.cache.ttlMs / 60_000) })}
          {cacheState === "warm" ? ` · ${tr("agents.cacheWarmNow")}` : cacheState === "cold" ? ` · ${tr("agents.cacheColdNow")}` : ""}
        </p>
      </section>

      <section className="agent-context-block" aria-labelledby={`ctx-warm-${task.id}`}>
        <h3 id={`ctx-warm-${task.id}`}>
          {tr("agents.keepWarm")}
          {context.warm.pings24h > 0 && <span>{tr("agents.keepAlivesValue", { count: context.warm.pings24h })}</span>}
        </h3>
        <p className="agent-prose">{warmSentence(context)}</p>
      </section>
    </div>
  );
}

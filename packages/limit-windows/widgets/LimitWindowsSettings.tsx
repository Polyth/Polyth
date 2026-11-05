// Settings → Limit windows: one row per account that has a time window. Open, it
// shows what will happen next and the plan behind it. Every control saves at once;
// the server answers with the plan's new forecast.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, CloseIcon, IconButton, Notice, PlusIcon, Select, TextInput } from "@polyth/web/ui";
import {
  DisclosureRow,
  EmptyState,
  ErrorState,
  ItemList,
  PageHead,
  Row,
  Section,
  Seg,
  Toggle,
} from "../../../apps/web/src/components/settings/parts.tsx";
import { MAX_LEAD, MAX_TIMES, type PlanMode, type WindowPlan } from "../src/plan.ts";
import type { LimitWindowsState, MeterView, PingRecord, SourceView } from "../src/types.ts";
import { deviceTimeZone, readState, savePlan, startWindow } from "./client.ts";
import { createCopy, fill, type LimitWindowsCopy } from "./copy.ts";
import { formatClock, formatMoment } from "./format.ts";
import { useDocumentLocale } from "./locale.ts";
import WindowStrip from "./WindowStrip.tsx";

/** Often enough to catch a window a person's turn just started. */
const REFRESH_MS = 30_000;
/** A typed time settles before it is saved. */
const SAVE_DELAY_MS = 500;
/** The server reads a start back after this, so the page asks again then. */
const AFTER_START_MS = [4_000, 155_000];
const HISTORY_ROWS = 5;

interface Moments {
  now: number;
  locale: string;
  timeZone: string;
}

const momentOf = ({ now, locale, timeZone }: Moments, at: number): string => formatMoment(at, now, locale, timeZone);

/** What happens next on one meter, as one sentence. */
export function nextSentence(meter: MeterView, copy: LimitWindowsCopy, moments: Moments): string {
  const until = meter.holdUntil !== undefined ? momentOf(moments, meter.holdUntil) : "";
  if (meter.problem === "no-route") return copy.noRoute;
  if (meter.problem === "no-model") return copy.noModel;
  if (meter.checking) return copy.checking;
  switch (meter.hold) {
    case "exhausted": return fill(copy.holdExhausted, { until });
    case "no-reading": return copy.holdNoReading;
    case "unknown-reset": return copy.holdUnknownReset;
    case "failing": return fill(copy.holdFailing, { until });
    case "no-effect": return fill(copy.holdNoEffect, { until });
    case "budget": return fill(copy.holdBudget, { until });
    default: break;
  }
  const next = meter.next;
  if (!next) return copy.noNext;
  const at = momentOf(moments, next.at);
  const target = next.targetAt !== undefined ? formatClock(next.targetAt, moments.locale, moments.timeZone) : "";
  if (next.reason === "lead") return fill(copy.nextLead, { at, target });
  if (next.reason === "hour") return fill(copy.nextHour, { at, target });
  return fill(next.reason === "rolling" ? copy.nextRolling : copy.nextReset, { at });
}

const outcomeText = (record: PingRecord, copy: LimitWindowsCopy, moments: Moments): string => {
  switch (record.outcome) {
    case "started": return record.resetAt !== undefined
      ? fill(copy.outcomeStarted, { at: momentOf(moments, record.resetAt) })
      : copy.outcomeUnconfirmed;
    case "no-effect": return copy.outcomeNoEffect;
    case "failed": return record.error ? `${copy.outcomeFailed}: ${record.error}` : copy.outcomeFailed;
    case "unconfirmed": return copy.outcomeUnconfirmed;
    default: return copy.outcomeSending;
  }
};

const summaryOf = (source: SourceView, copy: LimitWindowsCopy, moments: Moments): string => {
  const plan = source.plan;
  if (plan.mode === "off") return copy.off;
  const head = plan.mode === "hour" ? fill(copy.summaryHour, { times: plan.times.join(", ") }) : copy.summaryReset;
  const nexts = source.meters.flatMap((meter) => meter.hold ? [] : meter.next ? [meter.next.at] : []);
  if (nexts.length === 0) return head;
  const next = momentOf(moments, Math.min(...nexts));
  // "At 09:00 · next 09:00" says the same thing twice.
  return plan.mode === "hour" && plan.times.includes(next) ? head : `${head} · ${fill(copy.summaryNext, { at: next })}`;
};

const startProblem = (error: unknown, copy: LimitWindowsCopy): string => {
  const code = (error as { body?: { error?: unknown }; code?: unknown } | null)?.body?.error ?? (error as { code?: unknown } | null)?.code;
  if (code === "running") return copy.startRunning;
  if (code === "exhausted") return copy.startExhausted;
  if (code === "no-model" || code === "no-route") return copy.startNoModel;
  return copy.startFailed;
};

function MeterSection({ source, meter, copy, moments, multiple, onStarted }: {
  source: SourceView;
  meter: MeterView;
  copy: LimitWindowsCopy;
  moments: Moments;
  multiple: boolean;
  onStarted: () => void;
}): ReactNode {
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<string>();
  const primary = meter.windows.find((window) => window.id === meter.primaryId);
  const running = primary?.phase === "running";
  const start = async () => {
    setStarting(true);
    setFailure(undefined);
    try {
      await startWindow(source.id, meter.id);
    } catch (error) {
      setFailure(startProblem(error, copy));
    } finally {
      setStarting(false);
      onStarted();
    }
  };
  const history = meter.history.slice(0, HISTORY_ROWS);
  return (
    <div className="limit-windows-meter">
      <div className="limit-windows-meter-head">
        {multiple && meter.label && <span className="limit-windows-meter-name">{copy.meterNames[meter.id] ?? meter.label}</span>}
        <span className="limit-windows-meter-state">
          {meter.running
            ? fill(copy.runningUntil, { at: momentOf(moments, meter.running.to) })
            : copy.notStarted}
          {meter.model ? ` · ${meter.model.name}` : ""}
        </span>
      </div>
      <WindowStrip meter={meter} now={moments.now} locale={moments.locale} timeZone={moments.timeZone} copy={copy} />
      <p className="limit-windows-next" data-attention={meter.hold || meter.problem ? "true" : undefined}>
        {source.plan.mode === "off" && !meter.problem && !meter.checking ? copy.noNext : nextSentence(meter, copy, moments)}
      </p>
      {source.access === "edit" && (
        <div className="limit-windows-actions">
          <Button
            size="sm"
            disabled={starting || meter.busy || meter.checking || running || meter.hold === "exhausted" || Boolean(meter.problem)}
            onClick={() => { void start(); }}
          >
            {starting || meter.busy ? copy.starting : copy.startNow}
          </Button>
          {failure && <span className="limit-windows-failure" role="status">{failure}</span>}
        </div>
      )}
      {history.length > 0 && (
        <details className="limit-windows-history">
          <summary>{copy.history}</summary>
          <ul>
            {history.map((record) => (
              <li key={record.id} data-outcome={record.outcome}>
                <span className="limit-windows-history-at">{momentOf(moments, record.at)}</span>
                <span>{record.modelID}</span>
                <span className="limit-windows-history-outcome">{outcomeText(record, copy, moments)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function TimeList({ times, disabled, copy, onChange }: {
  times: readonly string[];
  disabled: boolean;
  copy: LimitWindowsCopy;
  onChange: (times: string[]) => void;
}): ReactNode {
  // Keeps a half-typed value out of the plan: only a whole HH:MM reaches it.
  const replace = (index: number, value: string) => {
    if (!/^\d\d:\d\d$/.test(value)) return;
    onChange(times.map((time, at) => (at === index ? value : time)));
  };
  return (
    <div className="limit-windows-times">
      {times.map((time, index) => (
        // The position is the identity: editing a time must not remount its input.
        <span className="limit-windows-time" key={index}>
          <TextInput
            type="time"
            aria-label={copy.hourLabel}
            value={time}
            disabled={disabled}
            onChange={(event) => replace(index, event.target.value)}
          />
          {times.length > 1 && (
            <IconButton
              label={fill(copy.removeHour, { time })}
              variant="ghost"
              size="sm"
              disabled={disabled}
              icon={CloseIcon}
              onClick={() => onChange(times.filter((_, at) => at !== index))}
            />
          )}
        </span>
      ))}
      {times.length < MAX_TIMES && (
        <IconButton
          label={copy.addHour}
          variant="ghost"
          size="sm"
          disabled={disabled}
          icon={PlusIcon}
          onClick={() => onChange([...times, times.at(-1) === "09:00" ? "14:00" : "09:00"])}
        />
      )}
    </div>
  );
}

function PlanControls({ source, plan, copy, onChange }: {
  source: SourceView;
  plan: WindowPlan;
  copy: LimitWindowsCopy;
  onChange: (patch: Partial<WindowPlan>) => void;
}): ReactNode {
  const disabled = source.access !== "edit";
  const modes: Array<[PlanMode, string]> = [["off", copy.modeOff], ["hour", copy.modeHour], ["reset", copy.modeReset]];
  const leads: Array<[number, string]> = Array.from({ length: MAX_LEAD + 1 }, (_, count) => [count, count === 0 ? copy.leadNone : String(count)]);
  const toggleDay = (day: number) => onChange({
    days: plan.days.includes(day) ? plan.days.filter((row) => row !== day) : [...plan.days, day].sort(),
  });
  // Monday first where the week reads that way; the values stay 0 = Sunday.
  const week = [1, 2, 3, 4, 5, 6, 0];
  const firstMeter = source.meters[0];
  const options = source.meters.length === 1 && firstMeter ? firstMeter.options : [];
  const cheapest = options[0];
  const modelValue = plan.model ? `${plan.model.providerID}/${plan.model.modelID}` : "";
  return (
    <>
      <Row label={copy.when} hint={copy.whenHint} itemId={`limit-windows.${source.id}.mode`}>
        <Seg label={copy.when} value={plan.mode} options={modes} disabled={disabled} onChange={(mode) => onChange({ mode })} />
      </Row>
      {plan.mode === "hour" && (
        <>
          <Row label={copy.hours} hint={fill(copy.hoursHint, { zone: plan.timeZone })}>
            <TimeList times={plan.times.length ? plan.times : ["09:00"]} disabled={disabled} copy={copy} onChange={(times) => onChange({ times })} />
          </Row>
          <Row label={copy.days} hint={copy.daysHint}>
            <div className="seg limit-windows-days" role="group" aria-label={copy.days}>
              {week.map((day) => (
                <Button
                  key={day}
                  variant="ghost"
                  size="sm"
                  className={plan.days.includes(day) ? "on" : ""}
                  aria-pressed={plan.days.includes(day)}
                  disabled={disabled}
                  onClick={() => toggleDay(day)}
                >
                  {copy.dayNames[day]}
                </Button>
              ))}
            </div>
          </Row>
          <Row label={copy.lead} hint={copy.leadHint}>
            <Seg label={copy.lead} value={plan.lead} options={leads} disabled={disabled} onChange={(lead) => onChange({ lead })} />
          </Row>
          <Row label={copy.rolling} hint={copy.rollingHint}>
            <Toggle on={plan.rolling} label={copy.rolling} disabled={disabled} onChange={(rolling) => onChange({ rolling })} />
          </Row>
        </>
      )}
      {plan.mode === "reset" && (
        <>
          <Row label={copy.activeHours} hint={copy.activeHoursHint}>
            <Toggle
              on={plan.activeFrom !== undefined}
              label={copy.activeHours}
              disabled={disabled}
              onChange={(on) => {
                const { activeFrom: _from, activeUntil: _until, ...rest } = plan;
                onChange(on ? { activeFrom: "08:00", activeUntil: "23:00" } : { ...rest, activeFrom: undefined, activeUntil: undefined });
              }}
            />
          </Row>
          {plan.activeFrom !== undefined && plan.activeUntil !== undefined && (
            <div className="limit-windows-range">
              <label>
                <span>{copy.activeFrom}</span>
                <TextInput type="time" value={plan.activeFrom} disabled={disabled} onChange={(event) => {
                  if (/^\d\d:\d\d$/.test(event.target.value)) onChange({ activeFrom: event.target.value });
                }} />
              </label>
              <label>
                <span>{copy.activeUntil}</span>
                <TextInput type="time" value={plan.activeUntil} disabled={disabled} onChange={(event) => {
                  if (/^\d\d:\d\d$/.test(event.target.value)) onChange({ activeUntil: event.target.value });
                }} />
              </label>
            </div>
          )}
        </>
      )}
      {plan.mode !== "off" && source.meters.length > 1 && (
        <Row label={copy.meters} hint={copy.metersHint} layout="stacked">
          <div className="limit-windows-meter-toggles">
            {source.meters.map((meter) => (
              <label key={meter.id}>
                <Toggle
                  on={!plan.skipMeters?.includes(meter.id)}
                  label={copy.meterNames[meter.id] ?? meter.label ?? meter.id}
                  disabled={disabled}
                  onChange={(on) => {
                    const skip = new Set(plan.skipMeters);
                    if (on) skip.delete(meter.id);
                    else skip.add(meter.id);
                    onChange({ skipMeters: [...skip] });
                  }}
                />
                <span>{copy.meterNames[meter.id] ?? meter.label ?? meter.id}</span>
              </label>
            ))}
          </div>
        </Row>
      )}
      {plan.mode !== "off" && options.length > 0 && cheapest && (
        <Row label={copy.model} hint={firstMeter?.modelReplaced ? copy.modelReplaced : copy.modelHint} itemId={`limit-windows.${source.id}.model`}>
          <Select
            label={copy.model}
            value={modelValue}
            disabled={disabled}
            searchable={options.length > 8}
            align="end"
            options={[
              { value: "", label: fill(copy.modelAuto, { model: cheapest.name }) },
              ...options.map((option) => ({ value: `${option.providerID}/${option.modelID}`, label: option.name })),
            ]}
            onChange={(value) => {
              const option = options.find((row) => `${row.providerID}/${row.modelID}` === value);
              onChange({ model: option ? { providerID: option.providerID, modelID: option.modelID } : undefined });
            }}
          />
        </Row>
      )}
    </>
  );
}

export default function LimitWindowsSettings(): ReactNode {
  const locale = useDocumentLocale();
  const copy = useMemo(() => createCopy(locale), [locale]);
  const [state, setState] = useState<LimitWindowsState>();
  const [loadError, setLoadError] = useState<unknown>();
  const [openId, setOpenId] = useState<string>();
  const [saveFailed, setSaveFailed] = useState<string>();
  const live = useRef(true);
  const pending = useRef(new Map<string, { plan: WindowPlan; timer: ReturnType<typeof setTimeout> }>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await readState(signal);
      if (!live.current) return;
      // An edit on its way must not be painted over by the older answer.
      setState((current) => ({
        ...next,
        sources: next.sources.map((source) => {
          const queued = pending.current.get(source.id);
          return queued ? { ...source, plan: queued.plan } : source;
        }),
      }));
      setLoadError(undefined);
    } catch (error) {
      if (!live.current || (error as { name?: unknown })?.name === "AbortError") return;
      setLoadError(error);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, REFRESH_MS);
    return () => {
      live.current = false;
      controller.abort();
      clearInterval(timer);
      for (const held of timers.current) clearTimeout(held);
      for (const queued of pending.current.values()) clearTimeout(queued.timer);
    };
  }, [refresh]);

  const flush = useCallback(async (sourceId: string) => {
    const queued = pending.current.get(sourceId);
    if (!queued) return;
    pending.current.delete(sourceId);
    try {
      const saved = await savePlan(sourceId, queued.plan);
      if (!live.current) return;
      setSaveFailed(undefined);
      setState((current) => current && {
        ...current,
        now: Date.now(),
        sources: current.sources.map((source) => {
          if (source.id !== sourceId) return source;
          // Only the newest edit may land; a newer one is already queued.
          return pending.current.has(sourceId) ? { ...saved, plan: source.plan } : saved;
        }),
      });
    } catch {
      if (!live.current) return;
      setSaveFailed(sourceId);
      void refresh();
    }
  }, [refresh]);

  const change = useCallback((source: SourceView, patch: Partial<WindowPlan>) => {
    const merged = { ...source.plan, timeZone: deviceTimeZone(), ...patch };
    // `undefined` removes an optional field; JSON would drop it anyway.
    const plan = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as unknown as WindowPlan;
    setState((current) => current && {
      ...current,
      sources: current.sources.map((row) => (row.id === source.id ? { ...row, plan } : row)),
    });
    const queued = pending.current.get(source.id);
    if (queued) clearTimeout(queued.timer);
    pending.current.set(source.id, { plan, timer: setTimeout(() => { void flush(source.id); }, SAVE_DELAY_MS) });
  }, [flush]);

  const afterStart = useCallback(() => {
    void refresh();
    for (const delay of AFTER_START_MS) {
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        void refresh();
      }, delay);
      timers.current.add(timer);
    }
  }, [refresh]);

  const body = (() => {
    if (!state) {
      // A login this account or device may not manage: not an error to retry.
      if ((loadError as { status?: unknown } | undefined)?.status === 403) {
        return <EmptyState title={copy.unavailableTitle} body={copy.unavailableBody} />;
      }
      return loadError
        ? <ErrorState title={copy.loadFailed} error={loadError} onRetry={() => { void refresh(); }} />
        : <EmptyState busy title={copy.page} />;
    }
    if (!state.available) return <EmptyState title={copy.unavailableTitle} body={copy.unavailableBody} />;
    if (state.sources.length === 0) return <EmptyState title={copy.emptyTitle} body={copy.emptyBody} icon="schedule" />;
    // Every time of an account reads in the zone its hours are set in.
    const momentsOf = (source: SourceView): Moments => ({ now: state.now, locale, timeZone: source.plan.timeZone });
    return (
      <Section title={copy.accounts} hint={copy.accountsHint} itemId="limit-windows.plan">
        <ItemList>
          {state.sources.map((source) => (
            <DisclosureRow
              key={source.id}
              rowId={source.id}
              label={source.title}
              value={summaryOf(source, copy, momentsOf(source))}
              open={openId === source.id}
              onToggle={() => setOpenId((current) => (current === source.id ? undefined : source.id))}
            >
              <div className="limit-windows-account">
                {source.access !== "edit" && <p className="limit-windows-note">{copy.viewOnly}</p>}
                {source.private && <p className="limit-windows-note">{copy.private}</p>}
                {source.stale && <p className="limit-windows-note">{copy.staleReading}</p>}
                {saveFailed === source.id && <Notice tone="error">{copy.saveFailed}</Notice>}
                {source.meters.map((meter) => (
                  <MeterSection
                    key={meter.id}
                    source={source}
                    meter={meter}
                    copy={copy}
                    moments={momentsOf(source)}
                    multiple={source.meters.length > 1}
                    onStarted={afterStart}
                  />
                ))}
                <PlanControls source={source} plan={source.plan} copy={copy} onChange={(patch) => change(source, patch)} />
              </div>
            </DisclosureRow>
          ))}
        </ItemList>
      </Section>
    );
  })();

  return (
    <div className="limit-windows-settings">
      <PageHead title={copy.page} blurb={copy.blurb} />
      {body}
    </div>
  );
}

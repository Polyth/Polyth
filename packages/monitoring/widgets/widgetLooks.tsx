// How each Monitoring look draws itself. Data loading and sizing live in MonitoringWidget.tsx.
import { useId, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { WebPackageHost, WidgetRenderContext } from "@polyth/web-sdk";
import { diskPercent, HISTORY_RANGES, worstDisk, type MetricHistory, type MonitoringIncident, type MonitoringPolicy, type MonitoringSnapshot } from "../src/contracts.ts";
import { agoText, bytes, clockText, fixed, unitText, whole } from "./format.ts";
import { bottleneckOf, fill, type Machine, type Vital } from "./model.ts";
import type { Words } from "./strings.ts";
import {
  chartsAreWide, gaugeCountOf, historyValues, rhythmOf, scaleOf, vitalKey, widgetVitalsOf,
  type DiskForecast, type FleetRow, type MonitoringWidgetConfig, type RhythmModel, type WidgetSize, type WidgetTone,
} from "./widgetModel.ts";
import { fleetOf } from "./widgetModel.ts";

type UpdateConfig = WidgetRenderContext["updateConfig"];

export interface CommonLookProps {
  host: WebPackageHost;
  rawConfig: WidgetRenderContext["config"];
  config: MonitoringWidgetConfig;
  updateConfig: UpdateConfig;
  locale: string;
  t: Words;
  now: number;
}

export interface MachineLookProps extends CommonLookProps {
  snapshot: MonitoringSnapshot;
  policy?: MonitoringPolicy;
  tone: WidgetTone;
  forecast?: DiskForecast;
  size: WidgetSize;
  width: number;
  height: number;
  stale?: string;
  history?: MetricHistory;
  history7d?: MetricHistory;
  incident?: MonitoringIncident | null;
  editing: boolean;
  asking: boolean;
  askError: string;
  onAsk: () => void;
}

const styleVars = (vars: Record<string, string | number>): CSSProperties => vars as CSSProperties;

/** Templates use **strong** for the numbers the eye needs first. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return <>{parts.map((part, index) => index % 2 ? <b key={index}>{part}</b> : part)}</>;
}
const rich = (text: string): ReactNode => <Rich text={text} />;
const plain = (text: string): string => text.replace(/\*\*/g, "");

const MIN_CHART_READINGS = 3;
const daysText = (days: number, locale: string): string => `≈\u00a0${unitText(Math.max(1, Math.round(days)), "day", locale, "long")}`;
const signed = (value: number, locale: string): string => `${value >= 0 ? "+" : ""}${fixed(value, locale, 1)}`;

const limitOf = (vital: Vital): number => vital.limit ?? (vital.kind === "disk" ? 90 : vital.kind === "memory" ? 85 : 1);
const loadLimitText = (limit: number, locale: string): string => fixed(limit, locale, limit % 1 ? 1 : 0);

function vitalLabel(vital: Vital, t: Words): string {
  if (vital.kind === "disk") return fill(t("Disk {mount}", "Диск {mount}"), { mount: vital.disk?.mount ?? "/" });
  if (vital.kind === "memory") return t("Memory", "Пам’ять");
  return t("Load", "Навантаження");
}

function vitalNumber(vital: Vital, locale: string): string {
  return vital.kind === "load" ? `${fixed(vital.value, locale)}×` : `${whole(vital.value, locale)}%`;
}

function VitalValue({ vital, locale }: { vital: Vital; locale: string }) {
  if (vital.kind === "load") return <>{fixed(vital.value, locale)}<small className="u">×</small></>;
  return <>{whole(vital.value, locale)}<small className="u">%</small></>;
}

function Meter({ vital, label, locale }: { vital: Vital; label: string; locale: string }) {
  const position = Math.max(0, Math.min(100, vital.fill));
  const tick = vital.tick === undefined ? undefined : Math.max(0, Math.min(100, vital.tick));
  return <span className="pkg-monw-meter" role="meter" aria-label={`${label}: ${vitalNumber(vital, locale)}`}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(position)}>
    <i style={{ inlineSize: `${position}%` }} />
    {tick !== undefined && <b style={{ insetInlineStart: `${tick}%` }} />}
  </span>;
}

/** dot, name, SSH tag, and a right slot that only speaks when the reading is old or a cursor is set. */
export function Head({ name, ssh, tone, right }: { name: string; ssh?: string; tone: WidgetTone; right?: ReactNode }) {
  return <div className="pkg-monw-head">
    <i className="pkg-monw-dot" data-tone={tone === "warn" ? "warn" : tone === "lost" ? "off" : "ok"} aria-hidden="true" />
    <strong>{name}</strong>
    {ssh && <span className="pkg-monw-where">{ssh}</span>}
    {right && <span className="pkg-monw-age">{right}</span>}
  </div>;
}

export function QuietSwitch({ label, items, value, onChange }: {
  label: string; items: ReadonlyArray<{ id: string; label: string }>; value: string; onChange: (id: string) => void;
}) {
  return <span className="pkg-monw-switch" role="tablist" aria-label={label}>
    {items.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === value}
      onClick={() => onChange(item.id)}>{item.label}</button>)}
  </span>;
}

export interface PlotProps {
  values: ReadonlyArray<[at: number, value: number]>;
  limit: number;
  floor: number;
  top: number;
  forecast?: { to: number; tone: "warn" | "watch" };
  cursor?: number | null;
  band?: "one" | "pair";
  limitLabel?: string;
  forecastLabel?: string;
  label: string;
  onCursor?: (fraction: number | null) => void;
}

const PLOT_W = 600;
const PLOT_H = 60;

/** A line chart: area only from zero, amber above the dashed limit, a separate forecast zone. */
export function Plot({ values, limit, floor, top, forecast, cursor, band, limitLabel, forecastLabel, label, onCursor }: PlotProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  if (!values.length) return null;
  const span = top - floor || 1;
  const y = (value: number) => (1 - (Math.min(value, top) - floor) / span) * PLOT_H;
  const histW = forecast ? PLOT_W * 0.76 : PLOT_W;
  const points = values.map(([, value], index) => [index / Math.max(1, values.length - 1) * histW, y(value)] as const);
  const line = points.map(([x, py], index) => `${index ? "L" : "M"}${x.toFixed(1)},${py.toFixed(1)}`).join("");
  const endX = points.at(-1)![0];
  const area = `${line}L${endX.toFixed(1)},${PLOT_H}L0,${PLOT_H}Z`;
  const limitY = y(limit);
  const overY = Math.max(0, limitY - PLOT_H * 0.02);
  const cursorPoint = cursor === null || cursor === undefined ? undefined : points[Math.round(Math.max(0, Math.min(1, cursor)) * (points.length - 1))];
  const forecastY = forecast ? y(forecast.to) : 0;
  const hasBand = !!band && floor > 0;
  const pointer = onCursor ? {
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      onCursor(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
    },
    onPointerLeave: () => onCursor(null),
  } : {};
  return <div className="pkg-monw-plot" {...(hasBand ? { "data-band": band } : {})} {...(onCursor ? {} : { role: "img", "aria-label": label })} {...pointer}>
    <svg viewBox={`0 0 ${PLOT_W} ${PLOT_H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        {/* The warning colour starts a hair above the limit, so a stroke resting on it stays calm. */}
        <clipPath id={`${uid}o`}><rect x="0" y="-10" width={PLOT_W} height={overY + 10} /></clipPath>
        <clipPath id={`${uid}u`}><rect x="0" y={overY} width={PLOT_W} height={PLOT_H - overY + 10} /></clipPath>
      </defs>
      {forecast && <>
        <rect className="zone" x={PLOT_W * 0.8} y="0" width={PLOT_W * 0.2} height={PLOT_H} />
        <line className="split" x1={PLOT_W * 0.78} x2={PLOT_W * 0.78} y1="0" y2={PLOT_H} vectorEffect="non-scaling-stroke" />
        <path className="forecast" data-tone={forecast.tone} d={`M${PLOT_W * 0.8},${points.at(-1)![1]}L${PLOT_W - 4},${forecastY.toFixed(1)}`} vectorEffect="non-scaling-stroke" />
      </>}
      <line className="base" x1="0" x2={PLOT_W} y1={PLOT_H} y2={PLOT_H} vectorEffect="non-scaling-stroke" />
      {/* Only load is filled under its limit: a percentage near full would paint a slab. */}
      {floor === 0 && top !== 100 && <path className="area" d={area} clipPath={`url(#${uid}u)`} />}
      <path className="area" data-over="" d={area} clipPath={`url(#${uid}o)`} />
      <line className="limit" x1="0" x2={PLOT_W} y1={limitY} y2={limitY} vectorEffect="non-scaling-stroke" />
      <path className="line" d={line} clipPath={`url(#${uid}u)`} vectorEffect="non-scaling-stroke" />
      <path className="line" data-over="" d={line} clipPath={`url(#${uid}o)`} vectorEffect="non-scaling-stroke" />
      {cursorPoint && <>
        <line className="cursor" x1={cursorPoint[0]} x2={cursorPoint[0]} y1="-6" y2={PLOT_H} vectorEffect="non-scaling-stroke" />
        <circle className="cursor-dot" cx={cursorPoint[0]} cy={cursorPoint[1]} r="3.5" vectorEffect="non-scaling-stroke" />
      </>}
    </svg>
    {limitLabel && <span className="pkg-monw-plot-label" style={{ top: `calc(${limitY / PLOT_H * 100}% + 4px)` }}>{limitLabel}</span>}
    {hasBand && band === "one" && <span className="pkg-monw-scale" style={{ top: "50%", transform: "translateY(-50%)" }}>{`${floor}–100%`}</span>}
    {hasBand && band === "pair" && <>
      <span className="pkg-monw-scale" style={{ top: 0 }}>100%</span>
      <span className="pkg-monw-scale" style={{ bottom: 0 }}>{`${floor}%`}</span>
    </>}
    {forecast && <>
      <i className="pkg-monw-fdot" data-tone={forecast.tone} style={{ right: 0, top: `${forecastY / PLOT_H * 100}%` }} aria-hidden="true" />
      {forecastLabel && <span className="pkg-monw-zone-label" style={{ left: "80%" }}>{forecastLabel}</span>}
    </>}
  </div>;
}

export function Gauge({ label, value, scale, text, unit, sub, over, tick, ariaLabel }: {
  label: string; value: number; scale: number; text: string; unit: string; sub?: string; over: boolean; tick?: number; ariaLabel: string;
}) {
  const stroke = 6;
  const radius = 50 - stroke / 2 - 1;
  const at = (fraction: number): [number, number] => {
    const angle = (135 + 270 * fraction) * Math.PI / 180;
    return [50 + radius * Math.cos(angle), 50 + radius * Math.sin(angle)];
  };
  const arc = (from: number, to: number): string => {
    const [x0, y0] = at(from); const [x1, y1] = at(to);
    return `M${x0.toFixed(2)},${y0.toFixed(2)}A${radius},${radius} 0 ${(to - from) * 270 > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
  };
  const fraction = Math.max(0.005, Math.min(1, value / scale));
  return <div className="pkg-monw-gauge" {...(over ? { "data-over": "" } : {})} role="img" aria-label={ariaLabel}>
    <div className="pkg-monw-gauge-dial">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <path className="track" d={arc(0, 1)} strokeWidth={stroke} />
        <path className="arc" d={arc(0, fraction)} strokeWidth={stroke} />
        {tick !== undefined && <Tick fraction={tick} radius={radius} stroke={stroke} />}
      </svg>
      <div className="pkg-monw-gauge-read">
        <strong>{text}<small className="u">{unit}</small></strong>
        {sub && <small>{sub}</small>}
      </div>
    </div>
    <span className="pkg-monw-gauge-label">{label}</span>
  </div>;
}

function Tick({ fraction, radius, stroke }: { fraction: number; radius: number; stroke: number }) {
  const angle = (135 + 270 * fraction) * Math.PI / 180;
  const inner = radius - stroke * 0.95;
  const outer = radius + stroke * 0.95;
  return <line className="tick" x1={50 + inner * Math.cos(angle)} y1={50 + inner * Math.sin(angle)}
    x2={50 + outer * Math.cos(angle)} y2={50 + outer * Math.sin(angle)} />;
}

export function Bars({ bars }: { bars?: FleetRow["bars"] }) {
  return <span className="pkg-monw-bars" aria-hidden="true">
    {[0, 1, 2].map((index) => {
      const bar = bars?.[index];
      return <i key={index} style={styleVars({ "--v": `${bar?.fill ?? 0}%` })} {...(bar?.over ? { "data-over": "" } : {})} />;
    })}
  </span>;
}

function VitalsRow({ vitals, locale, t }: { vitals: Vital[]; locale: string; t: Words }) {
  const shown = vitals.slice(0, 3);
  if (!shown.length) return null;
  return <div className="pkg-monw-vitals" style={styleVars({ "--n": shown.length })}>
    {shown.map((vital) => {
      const label = vitalLabel(vital, t);
      return <div className="pkg-monw-vital" key={vitalKey(vital)} {...(vital.over ? { "data-over": "" } : {})}>
        <span>{label}</span>
        <strong><VitalValue vital={vital} locale={locale} /></strong>
        <Meter vital={vital} label={label} locale={locale} />
      </div>;
    })}
  </div>;
}

function overDisk(snapshot: MonitoringSnapshot, policy?: MonitoringPolicy) {
  const limit = policy?.diskWarningPercent;
  return (snapshot.metrics.disks ?? []).find((disk) => limit === undefined ? snapshot.warnings.includes("disk") : Math.ceil((disk.used / (disk.used + disk.available || 1)) * 100) >= limit)
    ?? (snapshot.warnings.includes("disk") ? worstDisk(snapshot.metrics) : undefined);
}

function bottleneckPhrase(snapshot: MonitoringSnapshot, t: Words): string {
  const pressure = snapshot.metrics.pressure;
  const bottleneck = pressure ? bottleneckOf(pressure) : null;
  if (bottleneck === "cpu") return t("The CPU is the bottleneck.", "Вузьке місце — CPU.");
  if (bottleneck === "io") return t("The disk is the bottleneck.", "Вузьке місце — диск.");
  if (bottleneck === "memory") return t("Memory is the bottleneck.", "Вузьке місце — пам’ять.");
  return t("No bottlenecks.", "Вузьких місць немає.");
}

function summaryHeadline(props: MachineLookProps, name: string): string {
  const { snapshot, policy, tone, t } = props;
  if (tone === "lost") return fill(t("Can't reach {name}", "Немає зв’язку з {name}"), { name });
  if (tone === "watch") return t("All good for now", "Поки гаразд");
  if (tone === "ok") return t("All good", "Усе гаразд");
  const warnings = snapshot.warnings;
  if (warnings.length > 1) return fill(t("{count} things need a look", "Потрібно перевірити: {count}"), { count: warnings.length });
  if (warnings[0] === "disk") {
    const disk = overDisk(snapshot, policy);
    return fill(t("Disk «{mount}» is over its limit", "Диск «{mount}» понад межу"), { mount: disk?.mount ?? "/" });
  }
  if (warnings[0] === "load") return t("Load is over its limit", "Навантаження понад межу");
  if (warnings[0] === "memory") return t("Memory is high", "Мало вільної пам’яті");
  if (warnings[0] === "service") return t("A service is down", "Служба не працює");
  return t("All good", "Усе гаразд");
}

function summarySentences(props: MachineLookProps): string[] {
  const { snapshot, policy, tone, forecast, locale, t } = props;
  if (tone === "ok") return [t("Nothing is over its limit.", "Ніщо не перевищує межу.")];
  if (tone === "watch") {
    const disk = forecast ? worstDisk(snapshot.metrics) : undefined;
    if (!forecast || !disk) return [t("Nothing is over its limit.", "Ніщо не перевищує межу.")];
    return [fill(t("Disk «{mount}» — **{percent}%**, the limit is {limit}%. At this pace it reaches it in **{days}**.",
      "Диск «{mount}» — **{percent}%**, межа {limit}%. За такого темпу дійде до неї через **{days}**."), {
      mount: disk.mount, percent: whole(diskPercent(disk), locale),
      limit: whole(policy?.diskWarningPercent ?? 90, locale), days: daysText(forecast.days, locale),
    })];
  }
  const out: string[] = [];
  const warnings = snapshot.warnings;
  if (warnings.includes("disk")) {
    const disk = overDisk(snapshot, policy);
    const values = disk && { percent: whole(diskPercent(disk), locale), limit: whole(policy?.diskWarningPercent ?? 90, locale), left: bytes(disk.available, locale) };
    if (values) out.push(forecast
      ? fill(t("**{percent}%** — the limit is {limit}%. {left} free; at this pace it fills up in **{days}**.",
        "**{percent}%** — межа {limit}%. Вільно {left}; за такого темпу заповниться через **{days}**."), { ...values, days: daysText(forecast.days, locale) })
      : fill(t("**{percent}%** — the limit is {limit}%. {left} free.", "**{percent}%** — межа {limit}%. Вільно {left}."), values));
  }
  if (warnings.includes("load")) {
    const load = widgetVitalsOf(snapshot, policy, []).find((vital) => vital.kind === "load");
    const limit = policy?.loadWarningRatio;
    out.push(load && limit !== undefined
      ? fill(t("Load is {value}× over 5 min on {cpus} CPUs, the limit is {limit}×.", "Навантаження {value}× за 5 хв на {cpus} CPU, межа {limit}×."), {
        value: fixed(load.value, locale), cpus: snapshot.metrics.cpuCount, limit: loadLimitText(limit, locale),
      })
      : t("Load is over its limit.", "Навантаження понад межу."));
  }
  if (warnings.includes("memory")) {
    const percent = whole((1 - snapshot.metrics.memoryAvailable / snapshot.metrics.memoryTotal) * 100, locale);
    out.push(fill(t("{percent}% used, the limit is {limit}%.", "Використано {percent}%, межа {limit}%."), {
      percent, limit: whole(policy?.memoryWarningPercent ?? 85, locale),
    }));
  }
  if (warnings.includes("service")) {
    const down = snapshot.services.filter((service) => service.state !== "active").map((service) => service.unit);
    out.push(fill(t("Not running: {units}.", "Не працює: {units}."), { units: down.join(", ") }));
  }
  return out.length ? out : [t("Nothing is over its limit.", "Ніщо не перевищує межу.")];
}

function summaryShort(props: MachineLookProps, sentences: string[]): string {
  const { snapshot, tone, forecast, policy, locale, t } = props;
  if (tone === "watch" && forecast) {
    const disk = worstDisk(snapshot.metrics);
    if (disk) return fill(t("Disk «{mount}» will reach its limit in {days}", "Диск «{mount}» дійде до межі через {days}"), {
      mount: disk.mount, days: daysText(forecast.days, locale),
    });
  }
  if (tone === "warn" && snapshot.warnings.length === 1 && snapshot.warnings[0] === "disk" && forecast) {
    const disk = overDisk(snapshot, policy);
    if (disk) return fill(t("{percent}% — the limit is {limit}%. It fills up in {days}.", "{percent}% — межа {limit}%. Заповниться через {days}."), {
      percent: whole(Math.ceil(disk.used / (disk.used + disk.available || 1) * 100), locale),
      limit: whole(policy?.diskWarningPercent ?? 90, locale), days: daysText(forecast.days, locale),
    });
  }
  return plain(sentences.join(" "));
}

function rangeStartLabel(range: MetricHistory["range"], now: number, locale: string, t: Words): string {
  if (range === "1h") return unitText(1, "hour", locale);
  if (range === "7d") return unitText(7, "day", locale, "long");
  return fill(t("yesterday {time}", "учора {time}"), { time: clockText(now - HISTORY_RANGES[range].spanMs, locale) });
}

function SummaryChart({ props, subject }: { props: MachineLookProps; subject: Vital }) {
  const { forecast, history, locale, t, now } = props;
  if (!history) return null;
  // History keeps only the fullest disk; a chart for another disk would draw someone else's line.
  if (subject.kind === "disk" && subject.disk?.mount !== worstDisk(props.snapshot.metrics)?.mount) return null;
  const values = historyValues(history.points, subject.kind);
  // A line needs a few readings; an empty frame with only the limit would read as a flat line.
  if (values.length < MIN_CHART_READINGS) return <figure className="pkg-monw-chart">
    <div className="pkg-monw-chart-head"><strong>{vitalLabel(subject, t)}</strong></div>
    <p className="pkg-monw-note">{t("Not enough readings yet.", "Поки замало показань.")}</p>
  </figure>;
  const limit = limitOf(subject);
  const scale = scaleOf(values.map(([, value]) => value), subject.kind, limit, true);
  const forecastZone = forecast
    ? { to: forecast.target === "full" ? 100 : limit, tone: (forecast.target === "limit" ? "watch" : "warn") as "warn" | "watch" }
    : undefined;
  const note = subject.kind === "disk"
    ? forecast
      ? fill(t("{rate}% a day · dashed is the limit {limit}%", "{rate}% за добу · пунктир — межа {limit}%"), { rate: signed(forecast.perDay, locale), limit: whole(limit, locale) })
      : fill(t("dashed is the limit {limit}%", "пунктир — межа {limit}%"), { limit: whole(limit, locale) })
    : fill(t("dashed is the limit {limit}", "пунктир — межа {limit}"), { limit: subject.kind === "load" ? `${loadLimitText(limit, locale)}×` : `${whole(limit, locale)}%` });
  const right = forecast && fill(t("+{days} · {target}", "+{days} · {target}"), {
    days: unitText(Math.max(1, Math.round(forecast.days)), "day", locale, "long"),
    target: forecast.target === "limit" ? t("limit", "межа") : "100%",
  });
  return <figure className="pkg-monw-chart">
    <div className="pkg-monw-chart-head"><strong>{vitalLabel(subject, t)}</strong><span>{note}</span></div>
    <Plot values={values} limit={limit} floor={scale.floor} top={scale.top} forecast={forecastZone} band="pair"
      label={`${vitalLabel(subject, t)}: ${note}`} forecastLabel={t("forecast", "прогноз")} />
    <div className="pkg-monw-axis" data-forecast={right ? "" : undefined}>
      <span>{rangeStartLabel(history.range, now, locale, t)}</span>
      <span>{t("now", "зараз")}</span>
      {right && <span>{right}</span>}
    </div>
  </figure>;
}

export function SummaryLook(props: MachineLookProps) {
  const { snapshot, policy, config, tone, size, forecast, locale, t, stale, incident, editing, asking, askError, onAsk, host, history } = props;
  const vitals = widgetVitalsOf(snapshot, policy, config.metrics);
  const subject = vitals[0];
  const others = vitals.slice(1, 4);
  const sentences = summarySentences(props);
  const headline = summaryHeadline(props, snapshot.host.name);
  const short = summaryShort(props, sentences);
  const { Button } = host.ui.components;
  const showChart = size === "l" && !!subject;
  return <>
    <Head name={snapshot.host.name} ssh={snapshot.host.kind === "ssh" ? t("SSH", "SSH") : undefined} tone={tone} right={stale} />
    <div className="pkg-monw-verdict" {...(tone === "warn" ? { "data-tone": "warn" } : {})}>
      <h3>{headline}</h3>
      <p>{size === "s" ? short : rich(sentences.join(" "))}</p>
      {tone === "warn" && size !== "s" && !editing && <div className="pkg-monw-actions">
        {incident
          ? <Button variant="primary" onClick={() => void host.conversation.openSession(incident.sessionId)}>{t("Open the agent's chat", "Відкрити чат агента")}</Button>
          : policy?.agentAccess.metrics
            ? <Button variant="primary" busy={asking} onClick={onAsk}>{t("Ask an agent to look", "Розібратися з агентом")}</Button>
            : null}
        <Button variant="quiet" onClick={() => host.navigation.openWorkspacePane("monitoring")}>{t("Open Monitoring", "Відкрити моніторинг")}</Button>
      </div>}
      {askError && <p className="pkg-monw-error" role="alert">{askError}</p>}
    </div>
    {showChart && subject && history && <SummaryChart props={props} subject={subject} />}
    {size !== "s" && <VitalsRow vitals={others} locale={locale} t={t} />}
  </>;
}

function gaugeSub(vital: Vital, locale: string, t: Words): string | undefined {
  // A dial is small: its limit says more than sizes that would not fit.
  if (vital.kind !== "load") return vital.limit === undefined ? undefined : fill(t("limit {limit}%", "межа {limit}%"), { limit: whole(vital.limit, locale) });
  return t("per core", "на ядро");
}

function gaugeScale(vital: Vital): number {
  return vital.kind === "load" ? Math.max((vital.limit ?? 1) * 2.5, vital.value * 1.1, 0.1) : 100;
}

export function ScalesLook(props: MachineLookProps) {
  const { snapshot, policy, config, tone, forecast, size, width, locale, t } = props;
  const vitals = widgetVitalsOf(snapshot, policy, config.metrics);
  const count = gaugeCountOf(width, size);
  const shown = vitals.slice(0, count);
  const footer = tone === "warn"
    ? forecast
      ? rich(fill(t("Disk «{mount}» fills up in {days}", "Диск «{mount}» заповниться через {days}"), {
        mount: worstDisk(snapshot.metrics)?.mount ?? "/", days: daysText(forecast.days, locale),
      }))
      : t("Something is over its limit.", "Щось понад межу.")
    : tone === "watch"
      ? rich(summarySentences(props).join(" ") + " " + bottleneckPhrase(snapshot, t))
      : bottleneckPhrase(snapshot, t);
  return <>
    <Head name={snapshot.host.name} ssh={snapshot.host.kind === "ssh" ? t("SSH", "SSH") : undefined} tone={tone} right={props.stale} />
    <div className="pkg-monw-gauges" style={styleVars({ "--n": Math.max(1, shown.length) })}>
      {shown.map((vital) => {
        const label = vitalLabel(vital, t);
        const scale = gaugeScale(vital);
        const text = vital.kind === "load" ? fixed(vital.value, locale) : whole(vital.value, locale);
        const unit = vital.kind === "load" ? "×" : "%";
        const sub = gaugeSub(vital, locale, t);
        const tick = vital.limit === undefined ? undefined : Math.max(0, Math.min(1, vital.limit / scale));
        return <Gauge key={vitalKey(vital)} label={label} text={text} unit={unit} sub={sub} value={vital.value} scale={scale}
          tick={tick} over={vital.over} ariaLabel={`${label}: ${text}${unit}${sub ? ` (${sub})` : ""}`} />;
      })}
    </div>
    {size !== "s" && <div className="pkg-monw-foot" {...(tone === "warn" ? { "data-warn": "" } : {})}>{footer}</div>}
  </>;
}

function chartMeta(vital: Vital, props: MachineLookProps, values: ReadonlyArray<[number, number]>): { text: string; warn: boolean } {
  const { snapshot, forecast, tone, locale, t } = props;
  const limit = limitOf(vital);
  if (vital.kind === "disk") {
    const disk = vital.disk;
    if (!disk) return { text: "", warn: false };
    if (tone === "warn" && forecast) return { text: fill(t("fills up in {days}", "заповниться через {days}"), { days: daysText(forecast.days, locale) }), warn: true };
    return { text: fill(t("free {left} · limit {limit}%", "вільно {left} · межа {limit}%"), { left: bytes(disk.available, locale), limit: whole(limit, locale) }), warn: false };
  }
  if (vital.kind === "memory") {
    return { text: fill(t("{used} of {total} · limit {limit}%", "{used} із {total} · межа {limit}%"), {
      used: bytes(snapshot.metrics.memoryTotal - snapshot.metrics.memoryAvailable, locale),
      total: bytes(snapshot.metrics.memoryTotal, locale), limit: whole(limit, locale),
    }), warn: false };
  }
  const peak = values.reduce<[number, number] | undefined>((high, item) => !high || item[1] > high[1] ? item : high, undefined);
  if (!peak) {
    return { text: fill(t("{load} over 5 min on {cpus} CPUs", "{load} за 5 хв на {cpus} CPU"), {
      load: fixed(snapshot.metrics.load[1], locale), cpus: snapshot.metrics.cpuCount,
    }), warn: false };
  }
  return { text: fill(t("peak {value}× at {time} · limit {limit}×", "пік {value}× о {time} · межа {limit}×"), {
    value: fixed(peak[1], locale), time: clockText(peak[0], locale), limit: loadLimitText(limit, locale),
  }), warn: false };
}

function rowValue(vital: Vital, values: ReadonlyArray<[number, number]>, cursor: number | null, locale: string): { text: string; unit: string; over: boolean } {
  const shown = cursor === null ? vital.value : values[Math.round(cursor * (values.length - 1))]?.[1] ?? vital.value;
  const limit = limitOf(vital);
  return vital.kind === "load"
    ? { text: fixed(shown, locale), unit: "×", over: shown >= limit }
    : { text: whole(shown, locale), unit: "%", over: shown >= limit };
}

export function ChartsLook(props: MachineLookProps) {
  const { snapshot, policy, config, tone, width, height, size, history, locale, t, stale, rawConfig, updateConfig } = props;
  const [cursor, setCursor] = useState<{ fraction: number; at: number } | null>(null);
  const wideRows = chartsAreWide(width);
  // Only the rows that fit: a squeezed row would draw its title over the one above.
  // A small tile keeps the one row that matters most; a content-height host (height 0) takes them all.
  const fit = size === "s" ? 1 : height ? Math.max(1, Math.floor((height - 96) / (wideRows ? 54 : 96))) : 4;
  const vitals = widgetVitalsOf(snapshot, policy, config.metrics).slice(0, Math.min(4, fit));
  const points = history?.points ?? [];
  const rows = vitals.map((vital) => ({ vital, values: historyValues(points, vital.kind) }));
  const wide = wideRows;
  const reference = rows[0]?.values ?? [];
  const setAt = (fraction: number | null) => {
    if (fraction === null) { setCursor(null); return; }
    const at = reference.length ? reference[Math.round(fraction * (reference.length - 1))]?.[0] ?? Date.now() : Date.now();
    setCursor({ fraction, at });
  };
  return <>
    <Head name={snapshot.host.name} ssh={snapshot.host.kind === "ssh" ? t("SSH", "SSH") : undefined} tone={tone}
      right={cursor ? clockText(cursor.at, locale) : stale} />
    <div className="pkg-monw-lines" data-wide={wide ? "" : undefined}>
      {rows.map(({ vital, values }) => {
        const limit = limitOf(vital);
        const scale = scaleOf(values.map(([, value]) => value), vital.kind, limit, true);
        // History keeps only the fullest disk, so another disk shows where it stands now, not someone else's line.
        const ownHistory = vital.kind !== "disk" || vital.disk?.mount === worstDisk(snapshot.metrics)?.mount;
        const meta = chartMeta(vital, props, values);
        const shown = rowValue(vital, values, cursor?.fraction ?? null, locale);
        return <div className="pkg-monw-line" key={vitalKey(vital)} {...(shown.over ? { "data-over": "" } : {})} {...(cursor ? { "data-cursor": "" } : {})}>
          <span>{vitalLabel(vital, t)}</span>
          <strong>{shown.text}<small className="u">{shown.unit}</small></strong>
          <small {...(meta.warn ? { "data-warn": "" } : {})}>{meta.text}</small>
          {!ownHistory ? <div className="pkg-monw-row-meter"><Meter vital={vital} label={vitalLabel(vital, t)} locale={locale} /></div>
            : values.length >= MIN_CHART_READINGS
            ? <Plot values={values} limit={limit} floor={scale.floor} top={scale.top} band="one"
              cursor={cursor?.fraction ?? null} onCursor={setAt} label={`${vitalLabel(vital, t)}: ${meta.text}`} />
            : <div className="pkg-monw-plot-empty">{t("Not enough readings yet.", "Поки замало показань.")}</div>}
        </div>;
      })}
    </div>
    {size !== "s" && <div className="pkg-monw-footbar">
      {config.metrics.length === 0 && <span className="pkg-monw-foot">{t("Problems first", "Проблемні першими")}</span>}
      <QuietSwitch label={t("Period", "Період")} value={config.range}
        items={[
          { id: "1h", label: unitText(1, "hour", locale, "narrow") },
          { id: "24h", label: unitText(24, "hour", locale, "narrow") },
          { id: "7d", label: unitText(7, "day", locale, "narrow") },
        ]}
        onChange={(value) => updateConfig({ ...rawConfig, range: value })} />
    </div>}
  </>;
}

function weekday(at: number, locale: string): string {
  try { return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(at)); }
  catch { return new Date(at).toLocaleDateString(); }
}

const hourText = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

function rhythmValue(value: number, metric: MonitoringWidgetConfig["rhythmMetric"], locale: string): string {
  return metric === "load" ? `${fixed(value, locale)}×` : `${whole(value, locale)}%`;
}

function rhythmText(model: RhythmModel, metric: MonitoringWidgetConfig["rhythmMetric"], limit: number, locale: string, t: Words): string {
  const insight = model.insight;
  if (!insight) return t("Not enough readings yet.", "Поки замало показань.");
  const limitValue = metric === "load" ? `${loadLimitText(limit, locale)}×` : `${whole(limit, locale)}%`;
  if (insight.kind === "over") {
    return fill(t("**{day} {from}–{to}** — over the limit {limit}, up to {peak}. The rest of the week is calm.",
      "**{day} {from}–{to}** — понад межу {limit}, до {peak}. Решту тижня спокійно."), {
      day: weekday(insight.day, locale), from: hourText(insight.fromHour), to: hourText(insight.toHour),
      limit: limitValue, peak: rhythmValue(insight.peak, metric, locale),
    });
  }
  if (insight.kind === "daily") {
    return fill(t("**{hour}** is usually the high — up to {peak}; the rest of the day up to {rest}.",
      "Зазвичай о **{hour}** — до {peak}; решту дня — до {rest}."), {
      hour: hourText(insight.hour), peak: rhythmValue(insight.peak, metric, locale), rest: rhythmValue(insight.rest, metric, locale),
    });
  }
  return fill(t("The week's high is **{day} at {hour}** — {peak}.", "Найвища точка тижня — **{day} о {hour}**, {peak}."), {
    day: weekday(insight.day, locale), hour: hourText(insight.hour), peak: rhythmValue(insight.peak, metric, locale),
  });
}

export function RhythmLook(props: MachineLookProps) {
  const { policy, config, history7d, tone, locale, t, now, rawConfig, updateConfig, height, size } = props;
  const metric = config.rhythmMetric;
  // A short card keeps the grid whole and lets the sentence, then the legend, go first; a small tile is the grid alone.
  const showInsight = size !== "s" && (!height || height >= 210);
  const showFoot = size !== "s" && (!height || height >= 270);
  const limit = metric === "load" ? policy?.loadWarningRatio ?? 1 : policy?.memoryWarningPercent ?? 85;
  const model = rhythmOf(history7d?.points ?? [], metric, limit, now);
  const insight = rhythmText(model, metric, limit, locale, t);
  const currentHour = new Date(now).getHours();
  return <>
    <Head name={props.snapshot.host.name} ssh={props.snapshot.host.kind === "ssh" ? t("SSH", "SSH") : undefined} tone={tone} right={props.stale} />
    {history7d
      ? <div className="pkg-monw-rhythm" role="img" aria-label={plain(insight)}>
        <div className="pkg-monw-days" aria-hidden="true">
          {model.days.map((day, index) => <span key={day.start}>{index === model.days.length - 1 ? t("Today", "Сьогодні") : weekday(day.start, locale)}</span>)}
        </div>
        <div className="pkg-monw-cells" aria-hidden="true">
          {model.days.map((day, dayIndex) => day.cells.map((value, hour) => {
            const toCome = dayIndex === model.days.length - 1 && hour > currentHour;
            const alpha = value === null ? (toCome ? 0 : 3) : Math.round(5 + 33 * Math.min(1, value / limit));
            const over = value !== null && value >= limit;
            const current = dayIndex === model.days.length - 1 && hour === currentHour;
            return <i key={`${day.start}:${hour}`} style={styleVars({ "--a": `${alpha}%` })}
              {...(over ? { "data-over": "" } : {})} {...(current ? { "data-now": "" } : {})} />;
          }))}
        </div>
        <div className="pkg-monw-hours" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span></div>
      </div>
      : <p className="pkg-monw-loading" role="status">{t("Loading readings…", "Завантаження показників…")}</p>}
    {showInsight && <p className="pkg-monw-insight">{rich(insight)}</p>}
    {showFoot && <div className="pkg-monw-footbar">
      <span className="pkg-monw-legend">
        <span>{t("less", "менше")}</span>
        <i style={styleVars({ "--a": "8%" })} /><i style={styleVars({ "--a": "20%" })} /><i style={styleVars({ "--a": "38%" })} />
        <span>{t("more", "більше")}</span>
        <i data-over="" /><span>{t("over the limit", "понад межу")}</span>
      </span>
      <QuietSwitch label={t("Metric", "Показник")} value={metric}
        items={[{ id: "load", label: t("Load", "Навантаження") }, { id: "memory", label: t("Memory", "Пам’ять") }]}
        onChange={(value) => updateConfig({ ...rawConfig, rhythmMetric: value })} />
    </div>}
  </>;
}

function fleetStatus(row: FleetRow, locale: string, t: Words, now: number): string {
  if (row.tone === "lost") return row.sampledAt
    ? fill(t("Not responding {ago}", "Не відповідає {ago}"), { ago: agoText(row.sampledAt, now, locale) })
    : t("Not responding", "Не відповідає");
  if (row.tone !== "warn" || !row.worst) return t("All good", "Усе гаразд");
  const vital = row.worst;
  const limit = limitOf(vital);
  if (vital.kind === "disk") return fill(t("Disk «{mount}» — {value}, the limit is {limit}%", "Диск «{mount}» — {value}, межа {limit}%"), {
    mount: vital.disk?.mount ?? "/", value: vitalNumber(vital, locale), limit: whole(limit, locale),
  });
  if (vital.kind === "memory") return fill(t("Memory {value}, the limit is {limit}%", "Пам’ять {value}, межа {limit}%"), {
    value: vitalNumber(vital, locale), limit: whole(limit, locale),
  });
  return fill(t("Load {value} over the limit", "Навантаження {value} понад межу"), { value: vitalNumber(vital, locale) });
}

export function FleetLook({ host, locale, t, now, machines, readings, extra }: {
  host: WebPackageHost; locale: string; t: Words; now: number; machines: readonly Machine[];
  readings: ReadonlyMap<string, { value?: MonitoringSnapshot; error?: string }>; extra: number;
}) {
  const rows = fleetOf(machines, readings);
  const need = rows.filter((row) => row.tone === "warn").length;
  return <>
    <div className="pkg-monw-fleet-head">
      <strong>{t("All machines", "Усі машини")}</strong>
      <span>{rows.length}{need > 0 && <> · <em>{fill(t("{count} need a look", "{count} потребують уваги"), { count: need })}</em></>}</span>
    </div>
    <div className="pkg-monw-fleet">
      {rows.map((row) => <button key={row.machine.id} type="button" className="pkg-monw-host"
        {...(row.tone === "lost" ? { "data-off": "" } : {})}
        onClick={() => host.navigation.openWorkspacePane("monitoring")}>
        <i className="pkg-monw-dot" data-tone={row.tone === "lost" ? "off" : row.tone === "warn" ? "warn" : "ok"} aria-hidden="true" />
        <span className="pkg-monw-host-text">
          <strong>{row.machine.name}</strong>
          <span {...(row.tone === "warn" ? { "data-warn": "" } : {})}>{fleetStatus(row, locale, t, now)}</span>
        </span>
        <Bars bars={row.bars} />
        <span className="pkg-monw-chev" aria-hidden="true">{host.ui.icons.chevronRight?.()}</span>
      </button>)}
    </div>
    {extra > 0 && <p className="pkg-monw-foot">{fill(t("+{count} more", "+{count} ще"), { count: extra })}</p>}
    <div className="pkg-monw-foot">{t("Bars: load · memory · disk", "Стовпчики: навантаження · пам’ять · диск")}</div>
  </>;
}


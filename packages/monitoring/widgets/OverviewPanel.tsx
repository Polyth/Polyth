import { useCallback, useState } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { diskPercent, HISTORY_RANGES, type HistoryRange, type MetricHistory, type MonitoringHost, type MonitoringIncident, type MonitoringPolicy, type MonitoringSnapshot, type ProcessSnapshot, type ServiceHealth } from "../src/contracts.ts";
import { agoText, api, bytes, clockText, endpoint, fixed, unitText, whole } from "./format.ts";
import { bottleneckOf, chartOf, fill, loadTrendOf, minutesOverLimit, vitalsOf, type ChartMetric, type Vital } from "./model.ts";
import { monitoringWords, type Words } from "./strings.ts";
import { usePolling } from "./usePolling.ts";

const SparkleGlyph = () => <svg className="ui-icon ui-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M12 3l1.9 5.1a2 2 0 0 0 1.2 1.2L20 11l-4.9 1.7a2 2 0 0 0-1.2 1.2L12 19l-1.9-5.1a2 2 0 0 0-1.2-1.2L4 11l4.9-1.7a2 2 0 0 0 1.2-1.2z" />
</svg>;

interface Reading { value?: MonitoringSnapshot; error?: string; busy: boolean; refresh: () => void }

function VitalRow({ row, reading, stale, locale, t }: { row: Vital; reading: MonitoringSnapshot; stale: boolean; locale: string; t: Words }) {
  const { metrics } = reading;
  const parts: string[] = stale ? [fill(t("at {time}", "о {time}"), { time: clockText(reading.sampledAt, locale) })] : [];
  let label: string; let value: string; let hint: string;
  if (row.kind === "disk") {
    const disk = row.disk!;
    label = (metrics.disks?.length ?? 0) > 1 ? fill(t("Disk {mount}", "Диск {mount}"), { mount: disk.mount }) : t("Disk", "Диск");
    value = `${whole(row.value, locale)}%`;
    parts.push(fill(t("{left} left of {total}", "вільно {left} із {total}"), { left: bytes(disk.available, locale), total: bytes(disk.size, locale) }));
    if (row.limit !== undefined) parts.push(fill(t("limit {limit}%", "межа {limit}%"), { limit: whole(row.limit, locale) }));
    hint = `${label}: ${value}`;
  } else if (row.kind === "load") {
    label = t("Load", "Навантаження");
    value = `${fixed(row.value, locale)}×`;
    parts.push(fill(t("{load} over 5 min on {cpus} CPUs", "{load} за 5 хв на {cpus} CPU"), { load: fixed(metrics.load[1], locale), cpus: metrics.cpuCount }));
    if (row.limit !== undefined) parts.push(fill(t("limit {limit}×", "межа {limit}×"), { limit: fixed(row.limit, locale, row.limit % 1 ? 1 : 0) }));
    const trend = loadTrendOf(metrics);
    if (!stale && row.over && trend !== "steady") parts.push(trend === "rising" ? t("rising", "зростає") : t("easing", "спадає"));
    hint = `${label}: ${value}`;
  } else {
    label = t("Memory", "Пам’ять");
    value = `${whole(row.value, locale)}%`;
    parts.push(fill(t("{used} of {total}", "{used} із {total}"), { used: bytes(metrics.memoryTotal - metrics.memoryAvailable, locale), total: bytes(metrics.memoryTotal, locale) }));
    if (row.limit !== undefined) parts.push(fill(t("limit {limit}%", "межа {limit}%"), { limit: whole(row.limit, locale) }));
    hint = `${label}: ${value}`;
  }
  return <div className="pkg-monitoring-vital" {...(row.over && !stale ? { "data-over": "" } : {})}>
    <span className="pkg-monitoring-vital-label">{label}</span>
    <strong>{value}</strong>
    <span className="pkg-monitoring-vital-detail">{parts.join(" · ")}</span>
    <span className="pkg-monitoring-meter" role="meter" aria-label={hint} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(row.fill)}>
      <i style={{ inlineSize: `${Math.min(100, row.fill)}%` }} />
      {row.tick !== undefined && <b style={{ insetInlineStart: `${Math.min(100, row.tick)}%` }} />}
    </span>
  </div>;
}

function HistoryChart({ host, projectId, limits, active, t, locale, metric, setMetric, range, setRange, history }: {
  host: WebPackageHost; projectId: string; limits: Record<ChartMetric, number | undefined>; active: boolean; t: Words; locale: string;
  metric: ChartMetric; setMetric: (metric: ChartMetric) => void; range: HistoryRange; setRange: (range: HistoryRange) => void; history: MetricHistory | undefined;
}) {
  const { Tabs } = host.ui.components;
  const { stepMs, spanMs } = HISTORY_RANGES[range];
  const now = Date.now();
  const limit = limits[metric];
  const model = chartOf(history?.points ?? [], metric, limit ?? 1, stepMs, spanMs, now);
  const shown = (value: number) => metric === "load" ? `${fixed(value, locale)}×` : `${whole(value, locale)}%`;
  const W = 600; const H = 112;
  const pathOf = (segment: Array<[number, number]>) => segment.map(([x, y], i) => `${i ? "L" : "M"}${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join("");
  const line = model.segments.filter((segment) => segment.length > 0).map(pathOf).join("");
  const area = model.segments.filter((segment) => segment.length > 1).map((segment) => `${pathOf(segment)}L${(segment.at(-1)![0] * W).toFixed(1)},${H}L${(segment[0]![0] * W).toFixed(1)},${H}Z`).join("");
  const limitAt = model.limitY * H;
  const clip = `pkg-monitoring-${metric}-${range}`;
  const title = metric === "load" ? t("Load", "Навантаження") : metric === "memory" ? t("Memory", "Пам’ять") : t("Disk", "Диск");
  const caption = [
    ...(metric === "load" ? [t("Per CPU", "На CPU")] : []),
    ...(model.now ? [fill(t("now {value}", "зараз {value}"), { value: shown(model.now.value) })] : []),
    ...(model.peak ? [fill(t("peak {value} {ago}", "пік {value} {ago}"), { value: shown(model.peak.value), ago: agoText(model.peak.at, now, locale) })] : []),
  ].join(" · ");
  const axis = range === "1h" ? [unitText(60, "minute", locale), unitText(30, "minute", locale)]
    : range === "24h" ? [unitText(24, "hour", locale), unitText(12, "hour", locale)]
      : [unitText(7, "day", locale, "long"), unitText(3.5, "day", locale, "long")];
  const has = model.segments.flat().length > 1;
  return <figure className="pkg-monitoring-chart">
    <figcaption className="pkg-monitoring-chart-head">
      <Tabs size="sm" className="pkg-monitoring-quiet-tabs" label={t("Chart", "Графік")} value={metric} onChange={(value: string) => setMetric(value as ChartMetric)}
        tabs={[{ id: "load", label: t("Load", "Навантаження") }, { id: "memory", label: t("Memory", "Пам’ять") }, { id: "disk", label: t("Disk", "Диск") }]} />
      <Tabs size="sm" className="pkg-monitoring-quiet-tabs" label={t("Time range", "Період")} value={range} onChange={(value: string) => setRange(value as HistoryRange)}
        tabs={[{ id: "1h", label: unitText(1, "hour", locale, "narrow") }, { id: "24h", label: unitText(24, "hour", locale, "narrow") }, { id: "7d", label: unitText(7, "day", locale, "narrow") }]} />
    </figcaption>
    {caption && <p className="pkg-monitoring-note">{caption}</p>}
    {has ? <>
      <div className="pkg-monitoring-plot" dir="ltr">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${title}${caption ? `: ${caption}` : ""}`}>
          <defs>
            <clipPath id={`${clip}-over`}><rect x="0" y="0" width={W} height={limitAt} /></clipPath>
            <clipPath id={`${clip}-under`}><rect x="0" y={limitAt} width={W} height={H - limitAt} /></clipPath>
          </defs>
          <line className="pkg-monitoring-plot-base" x1="0" x2={W} y1={H} y2={H} vectorEffect="non-scaling-stroke" />
          <path className="pkg-monitoring-plot-area" data-over="" d={area} clipPath={`url(#${clip}-over)`} />
          <path className="pkg-monitoring-plot-area" d={area} clipPath={`url(#${clip}-under)`} />
          <path className="pkg-monitoring-plot-line" d={line} vectorEffect="non-scaling-stroke" clipPath={`url(#${clip}-under)`} />
          <path className="pkg-monitoring-plot-line" data-over="" d={line} vectorEffect="non-scaling-stroke" clipPath={`url(#${clip}-over)`} />
          {limit !== undefined && <line className="pkg-monitoring-plot-limit" x1="0" x2={W} y1={limitAt} y2={limitAt} vectorEffect="non-scaling-stroke" />}
        </svg>
        {limit !== undefined && <span className="pkg-monitoring-plot-label" style={{ top: `${model.limitY * 100}%` }}>
          {metric === "load" ? fill(t("limit {limit}×", "межа {limit}×"), { limit: fixed(limit, locale, limit % 1 ? 1 : 0) }) : fill(t("limit {limit}%", "межа {limit}%"), { limit: whole(limit, locale) })}
        </span>}
        {model.now?.atNow && <i className="pkg-monitoring-plot-now" {...(limit !== undefined && model.now.value >= limit ? { "data-over": "" } : {})} style={{ top: `${model.now.y * 100}%` }} />}
      </div>
      <div className="pkg-monitoring-axis" dir="ltr"><span>{axis[0]}</span><span>{axis[1]}</span><span>{t("now", "зараз")}</span></div>
    </> : <p className="pkg-monitoring-note">{active && !history ? t("Loading readings…", "Завантаження показників…") : t("Not enough readings yet. The chart fills in as they arrive.", "Показників поки замало. Графік заповниться, щойно вони надійдуть.")}</p>}
  </figure>;
}

function ProcessSection({ snapshot, project, active, locale, t }: { snapshot: MonitoringSnapshot; project: MonitoringHost; active: boolean; locale: string; t: Words }) {
  const load = useCallback((signal: AbortSignal) => api.get<ProcessSnapshot>(endpoint("processes", project.projectId),
    { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }), [project.projectId]);
  const processes = usePolling(`processes:${project.projectId}`, load, active && project.processesAvailable, true, 20_000);
  const pressure = snapshot.metrics.pressure;
  const sentence = (() => {
    if (!pressure) return "";
    const values = { cpu: whole(pressure.cpu, locale), io: whole(pressure.io, locale), memory: whole(pressure.memory, locale) };
    const bottleneck = bottleneckOf(pressure);
    if (bottleneck === "cpu") return fill(t("CPU is the bottleneck: work waited for a CPU {cpu}% of the last minute. Disk {io}%, memory {memory}%.", "Вузьке місце — CPU: робота чекала на процесор {cpu}% останньої хвилини. Диск {io}%, пам’ять {memory}%."), values);
    if (bottleneck === "io") return fill(t("The disk is the bottleneck: work waited for it {io}% of the last minute. CPU {cpu}%, memory {memory}%.", "Вузьке місце — диск: робота чекала на нього {io}% останньої хвилини. CPU {cpu}%, пам’ять {memory}%."), values);
    if (bottleneck === "memory") return fill(t("Memory is the bottleneck: work waited for it {memory}% of the last minute. CPU {cpu}%, disk {io}%.", "Вузьке місце — пам’ять: робота чекала на неї {memory}% останньої хвилини. CPU {cpu}%, диск {io}%."), values);
    return fill(t("Nothing is waiting long: CPU {cpu}%, disk {io}%, memory {memory}% of the last minute.", "Ніщо не чекає довго: CPU {cpu}%, диск {io}%, пам’ять {memory}% останньої хвилини."), values);
  })();
  const groups = processes.value?.groups ?? [];
  if (!sentence && !project.processesAvailable) return null;
  return <section className="pkg-monitoring-section">
    <h3>{t("What's using it", "Що це використовує")}</h3>
    {sentence && <p>{sentence}</p>}
    {project.processesAvailable && (groups.length > 0 ? <>
      <div className="pkg-monitoring-table">
        <span data-head="">{t("Processes", "Процеси")}</span><span data-head="" data-number="">{t("CPUs", "CPU")}</span><span data-head="" data-number="">{t("Memory", "Пам’ять")}</span>
        {groups.slice(0, 6).map((group) => <div className="pkg-monitoring-table-row" key={group.name}>
          <span>{group.name}<small>{group.count}</small></span>
          <span data-number="">{fixed(group.cpus, locale, 1)}</span>
          <span data-number="">{bytes(group.memory, locale)}</span>
        </div>)}
      </div>
      <p className="pkg-monitoring-note">{t("Memory counts shared pages in each process, so it can add up to more than is in use.", "Пам’ять враховує спільні сторінки в кожному процесі, тому сума може перевищувати використаний обсяг.")}</p>
    </> : <p className="pkg-monitoring-note">{processes.error ? t("Process names aren't available on this host.", "Назви процесів недоступні на цьому хості.") : t("Measuring…", "Вимірювання…")}</p>)}
  </section>;
}

const STATE_WORDS = (t: Words): Record<ServiceHealth["state"], string> => ({
  active: t("Running", "Працює"), inactive: t("Stopped", "Зупинено"), failed: t("Failed", "Збій"),
  activating: t("Starting", "Запускається"), deactivating: t("Stopping", "Зупиняється"), unknown: t("Unknown", "Невідомо"),
});

export function OverviewPanel({ host, project, name, policy, snapshot, active, onOpenRules }: {
  host: WebPackageHost; project: MonitoringHost; name: string; policy: MonitoringPolicy | undefined; snapshot: Reading; active: boolean; onOpenRules: () => void;
}) {
  const { Button } = host.ui.components;
  const locale = host.ui.locale.get();
  const t: Words = monitoringWords(locale);
  const reading = snapshot.value;
  const lost = !!snapshot.error;
  const [metric, setMetric] = useState<ChartMetric>("load");
  const [range, setRange] = useState<HistoryRange>("1h");
  const loadHistory = useCallback((signal: AbortSignal) => api.get<MetricHistory>(endpoint("history", project.projectId, { range }), { signal }), [project.projectId, range]);
  const history = usePolling(`history:${project.projectId}:${range}`, loadHistory, active, true, 60_000);
  const loadIncident = useCallback((signal: AbortSignal) => api.get<{ incident: MonitoringIncident | null }>(endpoint("incident", project.projectId), { signal }), [project.projectId]);
  const incident = usePolling(`incident:${project.projectId}`, loadIncident, active, true, 60_000);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState("");
  const open = incident.value?.incident ?? null;
  const ask = async () => {
    setAsking(true); setAskError("");
    try {
      const { sessionId } = await api.post<MonitoringIncident>(endpoint("ask", project.projectId), {}, { signal: AbortSignal.timeout(30_000) });
      incident.refresh();
      await host.conversation.openSession(sessionId);
    } catch (cause) { setAskError(host.errors.friendly(t("Could not start the chat", "Не вдалося почати чат"), cause)); }
    finally { setAsking(false); }
  };
  if (!reading && !lost) return <p className="pkg-monitoring-note" role="status">{t("Collecting host metrics…", "Збір показників хоста…")}</p>;
  const reach = fill(t("Can't reach {name}", "Немає зв’язку з {name}"), { name });
  if (!reading) return <div className="pkg-monitoring-status" role="alert">
    <h2><i className="pkg-monitoring-dot" data-tone="bad" />{reach}</h2>
    <p>{snapshot.error}</p>
    <Button busy={snapshot.busy} onClick={snapshot.refresh}>{t("Try again", "Спробувати ще раз")}</Button>
  </div>;
  const { metrics, warnings, services } = reading;
  const down = services.filter((service) => service.state !== "active");
  const now = Date.now();
  const sentences: string[] = [];
  const disk = (metrics.disks ?? []).find((item) => policy ? diskPercent(item) >= policy.diskWarningPercent : false) ?? metrics.disks?.[0];
  if (warnings.includes("disk") && disk) {
    const values = { mount: disk.mount, percent: whole(diskPercent(disk), locale), left: bytes(disk.available, locale) };
    sentences.push(disk.mount === "/"
      ? fill(t("Disk is {percent}% full, {left} left.", "Диск заповнено на {percent}%, вільно {left}."), values)
      : fill(t("Disk {mount} is {percent}% full, {left} left.", "Диск {mount} заповнено на {percent}%, вільно {left}."), values));
  }
  if (warnings.includes("load")) {
    const minutes = policy && history.value && range === "1h" ? minutesOverLimit(history.value.points, policy.loadWarningRatio, history.value.stepMs, now) : undefined;
    sentences.push(minutes !== undefined ? fill(t("Load has been over its limit for {minutes} min.", "Навантаження вище межі вже {minutes} хв."), { minutes }) : t("Load is over its limit.", "Навантаження вище межі."));
    const trend = loadTrendOf(metrics);
    if (trend === "easing") sentences.push(t("It is easing.", "Воно спадає."));
    if (trend === "rising") sentences.push(t("It is still rising.", "Воно ще зростає."));
  }
  if (warnings.includes("memory")) sentences.push(fill(t("Memory is {percent}% used.", "Використано {percent}% пам’яті."), { percent: whole((1 - metrics.memoryAvailable / metrics.memoryTotal) * 100, locale) }));
  if (warnings.includes("service")) sentences.push(fill(t("Not running: {units}.", "Не працює: {units}."), { units: down.map((service) => service.unit).join(", ") }));
  const headline = lost ? reach
    : warnings.length > 1 ? fill(t("{count} things need a look", "Потрібно перевірити: {count}"), { count: warnings.length })
      : warnings[0] === "disk" ? t("Disk is almost full", "Диск майже заповнений")
        : warnings[0] === "load" ? t("Load is high", "Високе навантаження")
          : warnings[0] === "memory" ? t("Memory is high", "Мало вільної пам’яті")
            : warnings[0] === "service" ? t("A service is down", "Служба не працює")
              : t("All good", "Усе добре");
  const agents = policy?.agentAccess;
  const canAsk = !lost && warnings.length > 0;
  const readable = agents ? [agents.metrics && t("Metrics", "Показники"), agents.processes && t("Process names", "Назви процесів"), agents.services && t("Services", "Служби"), agents.logs && t("Logs", "Логи")].filter(Boolean).join(", ") : "";
  const limits = { load: policy?.loadWarningRatio, memory: policy?.memoryWarningPercent, disk: policy?.diskWarningPercent };
  const words = STATE_WORDS(t);
  return <div className="pkg-monitoring-grid" {...(lost ? { "data-stale": "" } : {})}>
    <div className="pkg-monitoring-block">
      <div className="pkg-monitoring-status" {...(lost ? { role: "alert" } : {})}>
        <h2><i className="pkg-monitoring-dot" data-tone={lost ? "bad" : warnings.length ? "warn" : "ok"} />{headline}</h2>
        {lost ? <p>{fill(t("Last reading was {ago}, so the numbers below may be out of date.", "Останній показник отримано {ago}, тому числа нижче можуть бути застарілими."), { ago: agoText(reading.sampledAt, now, locale) })} {snapshot.error}</p>
          : <p>{warnings.length ? sentences.join(" ") : t("Nothing is over its limit.", "Ніщо не перевищує межу.")}</p>}
        {lost && <Button busy={snapshot.busy} onClick={snapshot.refresh}>{t("Try again", "Спробувати ще раз")}</Button>}
        {open && !lost && <>
          <p>{fill(t("An agent has been on this since {time}.", "Агент займається цим від {time}."), { time: clockText(open.openedAt, locale) })}</p>
          <Button variant={canAsk ? "primary" : "quiet"} onClick={() => void host.conversation.openSession(open.sessionId)}>{t("Open the agent's chat", "Відкрити чат агента")}</Button>
        </>}
        {!open && canAsk && (agents?.metrics
          ? <Button variant="primary" busy={asking} iconStart={SparkleGlyph} onClick={() => void ask()}>{t("Ask an agent to look", "Попросити агента перевірити")}</Button>
          : agents && project.canEditPolicy && <Button onClick={onOpenRules}>{t("Let agents read this host", "Дозволити агентам читати цей хост")}</Button>)}
        {askError && <p className="pkg-monitoring-error" role="alert">{askError}</p>}
      </div>
      <div className="pkg-monitoring-vitals">
        {vitalsOf(reading, policy).map((row) => <VitalRow key={`${row.kind}:${row.disk?.mount ?? ""}`} row={row} reading={reading} stale={lost} locale={locale} t={t} />)}
      </div>
    </div>
    <div className="pkg-monitoring-block">
      <HistoryChart host={host} projectId={project.projectId} limits={limits} active={active} t={t} locale={locale} metric={metric} setMetric={setMetric} range={range} setRange={setRange} history={history.value} />
    </div>
    <div className="pkg-monitoring-block">
      <ProcessSection snapshot={reading} project={project} active={active && !lost} locale={locale} t={t} />
    </div>
    <div className="pkg-monitoring-block">
      <section className="pkg-monitoring-section">
        <div className="pkg-monitoring-heading"><h3>{t("Services", "Служби")}</h3>{services.length > 0 && <span>{fill(t("{count} running", "працює: {count}"), { count: services.length - down.length })}</span>}</div>
        {!reading.servicesAvailable ? <p className="pkg-monitoring-note">{t("Service probes and journals need a Linux host with systemd.", "Стан служб і журнали потребують Linux-хоста із systemd.")}</p>
          : !services.length ? <div className="pkg-monitoring-list"><div className="pkg-monitoring-item"><span className="pkg-monitoring-grow" data-dim="">{t("None watched yet", "Поки жодної не відстежуємо")}</span>
            {project.canEditPolicy && <Button size="sm" onClick={onOpenRules}>{t("Choose", "Вибрати")}</Button>}</div></div>
            : <div className="pkg-monitoring-list">{services.map((service) => <div className="pkg-monitoring-item" key={service.unit}>
              <i className="pkg-monitoring-dot" data-tone={service.state === "active" ? "ok" : service.state === "failed" ? "bad" : "warn"} />
              <span className="pkg-monitoring-grow">{service.unit}</span><span className="pkg-monitoring-value">{words[service.state]}</span>
            </div>)}</div>}
      </section>
      <section className="pkg-monitoring-section">
        <div className="pkg-monitoring-list">
          <button type="button" className="pkg-monitoring-item" onClick={onOpenRules}>
            <span className="pkg-monitoring-grow pkg-monitoring-two-lines">
              <span>{t("What agents can read", "Що можуть читати агенти")}</span>
              {agents && <span className="pkg-monitoring-value">{readable || t("Nothing yet", "Поки нічого")}</span>}
            </span>
            <span className="pkg-monitoring-chevron" aria-hidden="true">{host.ui.icons.chevronRight?.()}</span>
          </button>
        </div>
        <p className="pkg-monitoring-note">{t("Totals for the whole machine, shared by every project on it.", "Підсумки для всього комп’ютера, спільні для всіх його проєктів.")}</p>
      </section>
    </div>
  </div>;
}

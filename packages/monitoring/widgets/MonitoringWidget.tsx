// The Monitoring widget: data loading, sizing and the empty/lost states.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { WebPackageHost, WidgetRenderContext } from "@polyth/web-sdk";
import { diskPercent, worstDisk, type MetricHistory, type MonitoringHost, type MonitoringIncident, type MonitoringPolicy, type MonitoringSnapshot } from "../src/contracts.ts";
import { agoText, api, endpoint } from "./format.ts";
import { fill, machinesOf, type Machine } from "./model.ts";
import { monitoringWords } from "./strings.ts";
import { usePolling } from "./usePolling.ts";
import { ChartsLook, FleetLook, Head, RhythmLook, ScalesLook, SummaryLook, type MachineLookProps } from "./widgetLooks.tsx";
import {
  diskForecastOf, isQuiet, machineOf, WIDGET_HISTORY_POLL_MS, WIDGET_POLL_MS, widgetConfigOf, widgetSizeOf, widgetToneOf,
  type DiskForecast, type WidgetTone,
} from "./widgetModel.ts";

export type MonitoringWidgetProps = WidgetRenderContext & { host: WebPackageHost };

interface HostsState { hosts?: MonitoringHost[]; error?: string }
const HOSTS_TTL_MS = 60_000;
let hostsCache: { at: number; promise: Promise<MonitoringHost[]> } | null = null;

/** One hosts request shared by every widget instance and the settings sheet. */
export function loadHosts(): Promise<MonitoringHost[]> {
  if (hostsCache && Date.now() - hostsCache.at < HOSTS_TTL_MS) return hostsCache.promise;
  const promise = api.get<{ items: MonitoringHost[] }>("/api/monitoring/hosts", { signal: AbortSignal.timeout(20_000) })
    .then(({ items }) => Array.isArray(items) ? items : []);
  hostsCache = { at: Date.now(), promise };
  promise.catch(() => { if (hostsCache?.promise === promise) hostsCache = null; });
  return promise;
}

export function useMonitoredHosts(active: boolean): HostsState {
  const [state, setState] = useState<HostsState>({});
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    loadHosts()
      .then((hosts) => { if (!disposed) setState({ hosts }); })
      .catch((cause) => { if (!disposed) setState({ error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { disposed = true; };
  }, [active]);
  return state;
}

/** A fleet reads each machine directly: one snapshot per machine, at the calmest useful pace. */
function useFleetReadings(machines: readonly Machine[], active: boolean) {
  const [readings, setReadings] = useState<Map<string, { value?: MonitoringSnapshot; error?: string }>>(new Map());
  const ids = machines.map((machine) => machine.id).join("|");
  useEffect(() => {
    if (!active || !machines.length) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let boundary: AbortController | undefined;
    const delay = Math.max(...machines.map((machine) => WIDGET_POLL_MS[machine.kind]));
    const run = async () => {
      if (document.visibilityState === "hidden") { timer = setTimeout(() => void run(), delay); return; }
      const controller = new AbortController();
      boundary = controller;
      const next = new Map<string, { value?: MonitoringSnapshot; error?: string }>();
      await Promise.all(machines.map(async (machine) => {
        try {
          const value = await api.get<MonitoringSnapshot>(endpoint("snapshot", machine.projectId),
            { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]) });
          next.set(machine.id, { value });
        } catch (cause) {
          if (!controller.signal.aborted) next.set(machine.id, { error: cause instanceof Error ? cause.message : String(cause) });
        }
      }));
      if (disposed) return;
      setReadings(next);
      timer = setTimeout(() => void run(), delay);
    };
    void run();
    return () => { disposed = true; boundary?.abort(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the machine set is identified by its ids
  }, [ids, active]);
  return readings;
}

export function MonitoringWidget({ host, ...context }: MonitoringWidgetProps) {
  const { projectId, editing } = context;
  const config = widgetConfigOf(context.config);
  const rawConfig = context.config;
  const updateConfig = context.updateConfig;
  const locale = host.ui.locale.get();
  const t = monitoringWords(locale);
  const now = Date.now();

  const root = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setBox({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    setBox({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);
  // The phone panel gives a widget its content height, so the box height there means nothing.
  const panel = !!context.panelSize;
  const size = widgetSizeOf(box.width, box.height, context.panelSize);

  const hostsState = useMonitoredHosts(true);
  const hosts = hostsState.hosts;
  const supported = (hosts ?? []).filter((item) => item.supported);
  const machine = hosts ? machineOf(config, hosts, projectId) : undefined;
  const machineProject = machine && machine !== "all" ? machine.projectId : "";
  const machineKind = machine && machine !== "all" ? machine.kind : "local";
  const machines = hosts ? machinesOf(supported, projectId ?? "") : [];

  const loadSnapshot = useCallback((signal: AbortSignal) => api.get<MonitoringSnapshot>(endpoint("snapshot", machineProject),
    { signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) }), [machineProject]);
  const snapshot = usePolling(`widget:snapshot:${machineProject}`, loadSnapshot, !!machineProject, true, WIDGET_POLL_MS[machineKind]);

  const loadPolicy = useCallback((signal: AbortSignal) => api.get<MonitoringPolicy>(endpoint("policy", machineProject), { signal }), [machineProject]);
  const policy = usePolling(`widget:policy:${machineProject}`, loadPolicy, !!machineProject, false);

  const look = config.look;
  const wantsChartHistory = look === "charts" || (look === "summary" && size === "l");
  const wants7d = (config.forecast && (look === "summary" || look === "scales" || look === "charts")) || look === "rhythm";
  const chartIs7d = config.range === "7d";

  const loadChartHistory = useCallback((signal: AbortSignal) => api.get<MetricHistory>(endpoint("history", machineProject, { range: config.range }), { signal }),
    [machineProject, config.range]);
  const chartHistory = usePolling(`widget:history:${machineProject}:${config.range}`, loadChartHistory,
    !!machineProject && (wantsChartHistory || (wants7d && chartIs7d)) && machine !== "all", true, WIDGET_HISTORY_POLL_MS);

  const load7d = useCallback((signal: AbortSignal) => api.get<MetricHistory>(endpoint("history", machineProject, { range: "7d" }), { signal }), [machineProject]);
  const history7dOnly = usePolling(`widget:history:${machineProject}:7d`, load7d,
    !!machineProject && wants7d && !chartIs7d && machine !== "all", true, WIDGET_HISTORY_POLL_MS);
  const history7d = chartIs7d ? chartHistory.value : history7dOnly.value;

  const worst = snapshot.value ? worstDisk(snapshot.value.metrics) : undefined;
  const forecast: DiskForecast | undefined = snapshot.value && worst && history7d && config.forecast && machine !== "all"
    ? diskForecastOf(history7d.points, diskPercent(worst), policy.value?.diskWarningPercent ?? 90, now)
    : undefined;
  const tone: WidgetTone = machine === "all" ? "ok" : widgetToneOf(snapshot.value, !!snapshot.error, forecast);
  const stale = snapshot.value && snapshot.error ? agoText(snapshot.value.sampledAt, now, locale) : undefined;

  const loadIncident = useCallback((signal: AbortSignal) => api.get<{ incident: MonitoringIncident | null }>(endpoint("incident", machineProject), { signal }), [machineProject]);
  const incidents = usePolling(`widget:incident:${machineProject}`, loadIncident,
    machine !== "all" && look === "summary" && tone === "warn" && size !== "s", true, 60_000);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState("");
  const ask = async () => {
    setAsking(true); setAskError("");
    try {
      const created = await api.post<MonitoringIncident>(endpoint("ask", machineProject), {}, { signal: AbortSignal.timeout(30_000) });
      incidents.refresh();
      await host.conversation.openSession(created.sessionId);
    } catch (cause) {
      setAskError(host.errors.friendly(t("Could not start the chat", "Не вдалося почати чат"), cause));
    } finally { setAsking(false); }
  };

  const fleetMachines = machines.slice(0, 12);
  const fleetReadings = useFleetReadings(fleetMachines, machine === "all");
  const ssh = machine && machine !== "all" && machine.kind === "ssh" ? t("SSH", "SSH") : undefined;

  let body: ReactNode;
  if (!hosts) {
    body = hostsState.error
      ? <p className="pkg-monw-note">{t("Monitoring is not available here", "Моніторинг тут недоступний")}</p>
      : <p className="pkg-monw-loading" role="status">{t("Collecting host metrics…", "Збір показників хоста…")}</p>;
  } else if (!machine) {
    body = <p className="pkg-monw-note">{supported.length
      ? t("This machine is no longer available", "Ця машина більше недоступна")
      : t("Monitoring is not available here", "Моніторинг тут недоступний")}</p>;
  } else if (machine === "all") {
    body = <FleetLook host={host} locale={locale} t={t} now={now} machines={fleetMachines} readings={fleetReadings}
      extra={Math.max(0, machines.length - fleetMachines.length)} />;
  } else if (!snapshot.value && !snapshot.error) {
    body = <p className="pkg-monw-loading" role="status">{t("Collecting host metrics…", "Збір показників хоста…")}</p>;
  } else if (!snapshot.value) {
    body = <>
      <Head name={machine.name} ssh={ssh} tone="lost" />
      <p className="pkg-monw-note" role="alert">{fill(t("Can't reach {name}", "Немає зв’язку з {name}"), { name: machine.name })}</p>
    </>;
  } else if (isQuiet(config, tone)) {
    body = <Head name={machine.name} ssh={ssh} tone={tone} right={stale} />;
  } else {
    const common: MachineLookProps = {
      host, rawConfig, config, updateConfig, locale, t, now,
      snapshot: snapshot.value, policy: policy.value, tone, forecast, size, width: box.width, height: panel ? 0 : box.height, stale,
      history: chartHistory.value, history7d, incident: incidents.value?.incident ?? null,
      editing, asking, askError, onAsk: () => void ask(),
    };
    body = look === "summary" ? <SummaryLook {...common} />
      : look === "scales" ? <ScalesLook {...common} />
        : look === "charts" ? <ChartsLook {...common} />
          : <RhythmLook {...common} />;
  }

  return <div className="pkg-monw" data-size={size} data-panel={panel ? "" : undefined} ref={root}>{body}</div>;
}

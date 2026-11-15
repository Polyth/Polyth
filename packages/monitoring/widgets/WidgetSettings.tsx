// The Monitoring widget's settings sheet: a live preview and only the rows that apply.
import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { WebPackageHost, WebSettingsRowProps, WebSwitchProps, WidgetSettingsContext } from "@polyth/web-sdk";
import type { MonitoringSnapshot } from "../src/contracts.ts";
import { fill, machinesOf } from "./model.ts";
import { monitoringWords, type Words } from "./strings.ts";
import { usePolling } from "./usePolling.ts";
import { MonitoringWidget, useMonitoredHosts } from "./MonitoringWidget.tsx";
import { machineOf, WIDGET_LOOKS, WIDGET_POLL_MS, vitalKey, widgetConfigOf, widgetVitalsOf, type MonitoringWidgetConfig, type WidgetLook, type WidgetMetric } from "./widgetModel.ts";
import { endpoint, api } from "./format.ts";

export type MonitoringSettingsProps = WidgetSettingsContext & { host: WebPackageHost };

function lookLabel(look: WidgetLook, t: Words): string {
  switch (look) {
    case "scales": return t("Scales", "Шкали");
    case "charts": return t("Charts", "Графіки");
    case "rhythm": return t("Rhythm", "Ритм");
    default: return t("Summary", "Підсумок");
  }
}

function LookThumb({ look }: { look: WidgetLook }) {
  if (look === "summary") return <svg viewBox="0 0 40 30" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <path d="M3 6h20" strokeWidth="2.6" /><path d="M3 13h30M3 18h22" opacity=".6" />
    <path d="M3 26h9M16 26h9M29 26h8" strokeWidth="2.2" opacity=".8" />
  </svg>;
  if (look === "scales") return <svg viewBox="0 0 40 30" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 21a7 7 0 1 1 8 0" /><path d="M17 21a7 7 0 1 1 8 0" opacity=".55" /><path d="M28 21a7 7 0 1 1 8 0" opacity=".55" />
  </svg>;
  if (look === "charts") return <svg viewBox="0 0 40 30" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8l6-3 5 2 6-4 6 3 6-1 5 2" /><path d="M3 17l7 0 6-2 6 1 6-1 9 1" opacity=".6" /><path d="M3 26l9-1 9-1 9-1 8-1" opacity=".6" />
  </svg>;
  return <svg viewBox="0 0 40 30" fill="currentColor" aria-hidden="true">
    <g opacity=".25">{Array.from({ length: 28 }, (_, index) => <rect key={index} x={3 + (index % 7) * 5} y={4 + Math.floor(index / 7) * 6} width="4" height="5" rx="1" />)}</g>
    <rect x="13" y="10" width="4" height="5" rx="1" /><rect x="18" y="10" width="4" height="5" rx="1" /><rect x="3" y="22" width="4" height="5" rx="1" />
  </svg>;
}

function LocalRow({ label, hint, children, layout }: WebSettingsRowProps) {
  return <div className={`pkg-monw-row${layout === "stacked" ? " is-stacked" : ""}`}>
    <div className="pkg-monw-row-text">
      {label !== undefined && <div className="pkg-monw-row-label">{label}</div>}
      {hint !== undefined && <div className="pkg-monw-row-hint">{hint}</div>}
    </div>
    <div className="pkg-monw-row-control">{children}</div>
  </div>;
}

function LocalToggle({ checked, onChange, label, disabled }: WebSwitchProps) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
    className="pkg-monw-local-switch" onClick={() => onChange(!checked)}>
    <span aria-hidden="true" />
  </button>;
}

export function MonitoringWidgetSettings({ host, ...context }: MonitoringSettingsProps) {
  const rawConfig = context.config;
  const config = widgetConfigOf(rawConfig);
  const update = (patch: Partial<MonitoringWidgetConfig>) => context.updateConfig({ ...rawConfig, ...patch });
  const locale = host.ui.locale.get();
  const t = monitoringWords(locale);
  const { Button, Tabs, Checkbox, Select } = host.ui.components;
  const Row = host.ui.components.SettingsRow ?? LocalRow;
  const Toggle = host.ui.components.Switch ?? LocalToggle;
  const group = useRef<HTMLDivElement | null>(null);

  const hostsState = useMonitoredHosts(true);
  const hosts = hostsState.hosts;
  const supported = (hosts ?? []).filter((item) => item.supported);
  const machine = hosts ? machineOf(config, hosts, context.projectId) : undefined;
  const machines = hosts ? machinesOf(supported, context.projectId ?? "") : [];
  const machineProject = machine && machine !== "all" ? machine.projectId : "";
  const machineKind = machine && machine !== "all" ? machine.kind : "local";

  const loadSnapshot = useCallback((signal: AbortSignal) => api.get<MonitoringSnapshot>(endpoint("snapshot", machineProject),
    { signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) }), [machineProject]);
  const snapshot = usePolling(`widget:snapshot:${machineProject}`, loadSnapshot, !!machineProject, true, WIDGET_POLL_MS[machineKind]);

  const picking = config.metrics.length > 0;
  const allMetrics = (): WidgetMetric[] => {
    if (!snapshot.value) return ["load", "memory"];
    const keys = widgetVitalsOf(snapshot.value, undefined, []).map(vitalKey);
    return keys.length ? keys : ["load", "memory"];
  };
  const metricOptions: Array<{ id: WidgetMetric; label: string }> = [
    ...(snapshot.value?.metrics.disks ?? []).map((disk) => ({ id: `disk:${disk.mount}` as WidgetMetric, label: fill(t("Disk {mount}", "Диск {mount}"), { mount: disk.mount }) })),
    { id: "memory", label: t("Memory", "Пам’ять") },
    { id: "load", label: t("Load", "Навантаження") },
  ];
  const toggleMetric = (metric: WidgetMetric, checked: boolean) => {
    const next = checked ? [...config.metrics, metric] : config.metrics.filter((item) => item !== metric);
    if (!next.length) return;
    update({ metrics: next });
  };
  const machineOptions = [
    { value: "current", label: t("This computer", "Цей комп’ютер") },
    ...machines.map((item) => ({ value: item.id, label: item.name })),
    { value: "all", label: t("All machines", "Усі машини") },
  ];
  const machineValue = machineOptions.some((option) => option.value === config.machine) ? config.machine : "current";
  const moveLook = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = WIDGET_LOOKS[(index + step + WIDGET_LOOKS.length) % WIDGET_LOOKS.length];
    if (!next) return;
    update({ look: next });
    const buttons = group.current?.querySelectorAll<HTMLButtonElement>("button");
    buttons?.item(WIDGET_LOOKS.indexOf(next)).focus();
  };

  return <div className="pkg-monw-settings">
    <div className="pkg-monw-settings-preview">
      <MonitoringWidget host={host} {...context} editing={false} />
    </div>
    <div className="pkg-monw-settings-body">
      <div className="pkg-monw-settings-looks" role="radiogroup" aria-label={t("Look", "Вигляд")} ref={group}>
        {WIDGET_LOOKS.map((look, index) => <button key={look} type="button" role="radio" aria-checked={config.look === look}
          className="pkg-monw-settings-look" onClick={() => update({ look })} onKeyDown={(event) => moveLook(event, index)}>
          <span className="pkg-monw-settings-thumb"><LookThumb look={look} /></span>
          {lookLabel(look, t)}
        </button>)}
      </div>
      <Row label={t("Machine", "Машина")}>
        <Select label={t("Machine", "Машина")} ariaLabel={t("Machine", "Машина")} value={machineValue}
          options={machineOptions} onChange={(value) => update({ machine: value })} />
      </Row>
      {config.look !== "rhythm" && machine !== "all" && <Row label={t("Metrics", "Показники")} layout="stacked"
        hint={picking ? undefined : t("What is closest to its limit comes first", "Те, що найближче до межі, — першим")}>
        <Tabs size="sm" label={t("Metrics", "Показники")} value={picking ? "pick" : "problems"}
          tabs={[
            { id: "problems", label: t("Problems first", "Проблемні першими") },
            { id: "pick", label: t("Pick myself", "Вибрати самому") },
          ]}
          onChange={(value) => update({ metrics: value === "pick" ? (picking ? config.metrics : allMetrics()) : [] })} />
        {picking && <div className="pkg-monw-settings-metrics">
          {metricOptions.map((option) => <Checkbox key={option.id} checked={config.metrics.includes(option.id)}
            label={option.label} onChange={(checked) => toggleMetric(option.id, checked)} />)}
        </div>}
      </Row>}
      {config.look === "charts" && <Row label={t("Period", "Період")} layout="stacked">
        <Tabs size="sm" label={t("Period", "Період")} value={config.range}
          tabs={[
            { id: "1h", label: t("1 hour", "1 год") },
            { id: "24h", label: t("24 hours", "24 год") },
            { id: "7d", label: t("7 days", "7 дн") },
          ]}
          onChange={(value) => update({ range: value as MonitoringWidgetConfig["range"] })} />
      </Row>}
      {config.look !== "rhythm" && machine !== "all" && <Row label={t("Forecast for disks", "Прогноз для дисків")}
        hint={t("When a disk reaches its limit or fills up", "Коли диск дійде до межі або заповниться")}>
        <Toggle checked={config.forecast} label={t("Forecast for disks", "Прогноз для дисків")} onChange={(checked) => update({ forecast: checked })} />
      </Row>}
      <Row label={t("Quiet while all is well", "Тихо, поки все гаразд")}
        hint={t("Only the dot and the machine's name. A forecast or a warning unfolds the widget",
          "Лише крапка й назва машини. Прогноз чи попередження розгортають віджет")}>
        <Toggle checked={config.quiet} label={t("Quiet while all is well", "Тихо, поки все гаразд")} onChange={(checked) => update({ quiet: checked })} />
      </Row>
      <div className="pkg-monw-settings-note">
        {t("Limits are shared by all of Monitoring.", "Межі спільні для всього моніторингу.")}
        <Button variant="quiet" size="sm" onClick={() => host.navigation.openSettingsPage("monitoring")}>{t("Change limits", "Змінити межі")}</Button>
      </div>
    </div>
  </div>;
}

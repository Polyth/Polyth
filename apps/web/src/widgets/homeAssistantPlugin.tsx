import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  HomeAssistantConfigDto,
  HomeAssistantConnectionDto,
  HomeAssistantEntityDto,
  JsonValue,
} from "@polyth/contracts";
import { api } from "../api.ts";
import { defineWidgetPlugin, registerWidgetPlugin } from "./catalog.ts";

const WORKSPACE_SLOTS = [
  "workspace.header",
  "workspace.left",
  "workspace.main",
  "workspace.right",
] as const;

const ACTION_SLOTS = [
  "app.header.actions",
  "session.header.actions",
  "app.nav",
] as const;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "Home Assistant request failed";

const attribute = (entity: HomeAssistantEntityDto, key: string): JsonValue | undefined =>
  entity.attributes[key];

const entityName = (entity: HomeAssistantEntityDto): string => {
  const friendly = attribute(entity, "friendly_name");
  return typeof friendly === "string" && friendly ? friendly : entity.entityId;
};

const displayState = (entity: HomeAssistantEntityDto): string => {
  const unit = attribute(entity, "unit_of_measurement");
  return `${entity.state}${typeof unit === "string" ? ` ${unit}` : ""}`;
};

function useConfig(): {
  config: HomeAssistantConfigDto | null;
  error: string;
  reload(): Promise<void>;
} {
  const [config, setConfig] = useState<HomeAssistantConfigDto | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      setConfig(await api.homeAssistantConfig());
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { config, error, reload };
}

function useEntities(entityIds: readonly string[]): {
  entities: HomeAssistantEntityDto[];
  error: string;
  loading: boolean;
  reload(): Promise<void>;
} {
  const key = entityIds.filter(Boolean).join("|");
  const stableIds = useMemo(() => key.split("|").filter(Boolean), [key]);
  const [entities, setEntities] = useState<HomeAssistantEntityDto[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (stableIds.length === 0) {
      setEntities([]);
      return;
    }
    setLoading(true);
    try {
      setEntities(await api.homeAssistantEntities(stableIds));
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [stableIds]);
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 30_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  return { entities, error, loading, reload };
}

function useConnection(): {
  status: HomeAssistantConnectionDto | null;
  error: string;
  reload(): Promise<void>;
} {
  const [status, setStatus] = useState<HomeAssistantConnectionDto | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      setStatus(await api.homeAssistantStatus());
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 30_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  return { status, error, reload };
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="ha-empty">{children}</div>;
}

function ConnectionWidget() {
  const { status, error, reload } = useConnection();
  const state = status?.status ?? "unconfigured";
  return (
    <div className="ha-connection">
      <div className={`ha-status ha-status-${state}`}>
        <i aria-hidden="true" />
        <div>
          <strong>{state === "connected" ? "Connected" : state === "unavailable" ? "Unavailable" : "Not configured"}</strong>
          <span>{status?.version ? `Home Assistant ${status.version}` : status?.message || error || "Checking connection…"}</span>
        </div>
      </div>
      {status?.baseUrl && <code>{status.baseUrl}</code>}
      <button type="button" onClick={() => void reload()}>Refresh</button>
    </div>
  );
}

function EntityStateWidget() {
  const { config, error: configError } = useConfig();
  const entityId = config?.entities.stateEntityId ?? "";
  const { entities, error, loading, reload } = useEntities(entityId ? [entityId] : []);
  const entity = entities[0];
  if (!entityId) return <Empty>Choose a state entity in this widget’s settings.</Empty>;
  if (!entity) return <Empty>{error || configError || (loading ? "Loading entity…" : "Entity unavailable.")}</Empty>;
  const useful = Object.entries(entity.attributes)
    .filter(([key, value]) => key !== "friendly_name" && typeof value !== "object")
    .slice(0, 4);
  return (
    <div className="ha-entity">
      <div className="ha-entity-primary">
        <span>{entityName(entity)}</span>
        <strong>{displayState(entity)}</strong>
        <code>{entity.entityId}</code>
      </div>
      {useful.length > 0 && (
        <dl>
          {useful.map(([key, value]) => (
            <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{String(value)}</dd></div>
          ))}
        </dl>
      )}
      <button type="button" onClick={() => void reload()}>Refresh state</button>
    </div>
  );
}

function LightWidget() {
  const { config, error: configError } = useConfig();
  const entityId = config?.entities.lightEntityId ?? "";
  const { entities, error, loading, reload } = useEntities(entityId ? [entityId] : []);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState("");
  const entity = entities[0];
  const on = entity?.state === "on";
  const toggle = async () => {
    if (!entityId) return;
    setActing(true);
    try {
      await api.homeAssistantToggle(entityId);
      await reload();
      setActionError("");
    } catch (cause) {
      setActionError(errorText(cause));
    } finally {
      setActing(false);
    }
  };
  if (!entityId) return <Empty>Choose a light entity in this widget’s settings.</Empty>;
  return (
    <div className={`ha-light${on ? " is-on" : ""}`}>
      <button type="button" onClick={() => void toggle()} disabled={acting || loading}>
        <span aria-hidden="true">◉</span>
        <strong>{entity ? entityName(entity) : "Light"}</strong>
        <small>{acting ? "Switching…" : actionError || error || configError || (on ? "On" : "Off")}</small>
      </button>
    </div>
  );
}

function ClimateSensorsWidget() {
  const { config, error: configError } = useConfig();
  const climateId = config?.entities.climateEntityId ?? "";
  const sensorIds = config?.entities.sensorEntityIds ?? [];
  const ids = useMemo(() => [climateId, ...sensorIds].filter(Boolean), [climateId, sensorIds.join("|")]);
  const { entities, error, loading, reload } = useEntities(ids);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState("");
  const climate = entities.find((item) => item.entityId === climateId);
  const sensors = entities.filter((item) => item.entityId !== climateId);
  const targetRaw = climate ? attribute(climate, "temperature") : undefined;
  const currentRaw = climate ? attribute(climate, "current_temperature") : undefined;
  const target = typeof targetRaw === "number" ? targetRaw : Number.parseFloat(String(targetRaw ?? ""));
  const setTemperature = async (value: number) => {
    if (!climateId || !Number.isFinite(value)) return;
    setActing(true);
    try {
      await api.homeAssistantSetTemperature(climateId, value);
      await reload();
      setActionError("");
    } catch (cause) {
      setActionError(errorText(cause));
    } finally {
      setActing(false);
    }
  };
  if (ids.length === 0) return <Empty>Choose climate and sensor entities in this widget’s settings.</Empty>;
  return (
    <div className="ha-climate">
      {climate && (
        <section>
          <div>
            <span>{entityName(climate)}</span>
            <strong>{typeof currentRaw === "number" ? `${currentRaw}°` : climate.state}</strong>
          </div>
          <div className="ha-temperature">
            <button type="button" disabled={acting || !Number.isFinite(target)} onClick={() => void setTemperature(target - 0.5)}>−</button>
            <span><small>Target</small><b>{Number.isFinite(target) ? `${target}°` : "—"}</b></span>
            <button type="button" disabled={acting || !Number.isFinite(target)} onClick={() => void setTemperature(target + 0.5)}>+</button>
          </div>
        </section>
      )}
      <div className="ha-sensors">
        {sensors.map((sensor) => (
          <div key={sensor.entityId}>
            <span>{entityName(sensor)}</span>
            <strong>{displayState(sensor)}</strong>
          </div>
        ))}
      </div>
      {(actionError || error || configError) && <p className="ha-error">{actionError || error || configError}</p>}
      {loading && <small className="ha-loading">Refreshing…</small>}
    </div>
  );
}

export function HomeAssistantSettings() {
  const { config, error, reload } = useConfig();
  const [baseUrl, setBaseUrl] = useState("");
  const [tokenEnv, setTokenEnv] = useState("HOME_ASSISTANT_TOKEN");
  const [token, setToken] = useState("");
  const [stateEntityId, setStateEntityId] = useState("");
  const [lightEntityId, setLightEntityId] = useState("");
  const [climateEntityId, setClimateEntityId] = useState("");
  const [sensorEntityIds, setSensorEntityIds] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!config) return;
    setBaseUrl(config.baseUrl);
    setTokenEnv(config.tokenEnv || "HOME_ASSISTANT_TOKEN");
    setStateEntityId(config.entities.stateEntityId);
    setLightEntityId(config.entities.lightEntityId);
    setClimateEntityId(config.entities.climateEntityId);
    setSensorEntityIds(config.entities.sensorEntityIds.join(", "));
  }, [config]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const next = await api.homeAssistantConfigure({
        baseUrl,
        tokenEnv,
        ...(token ? { token } : {}),
        entities: {
          stateEntityId,
          lightEntityId,
          climateEntityId,
          sensorEntityIds: sensorEntityIds.split(",").map((value) => value.trim()).filter(Boolean),
        },
      });
      setToken("");
      setMessage(next.tokenConfigured ? "Saved and token configured." : "Saved. Add the long-lived token.");
      await reload();
    } catch (cause) {
      setMessage(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="ha-settings" onSubmit={(event) => void save(event)}>
      <label>Home Assistant URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://homeassistant.local:8123" /></label>
      <label>Token environment name<input value={tokenEnv} onChange={(event) => setTokenEnv(event.target.value)} placeholder="HOME_ASSISTANT_TOKEN" /></label>
      <label>Long-lived token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={config?.tokenConfigured ? "Configured — leave blank to keep" : "Write-only token"} autoComplete="new-password" /></label>
      <label>State entity<input value={stateEntityId} onChange={(event) => setStateEntityId(event.target.value)} placeholder="binary_sensor.front_door" /></label>
      <label>Light entity<input value={lightEntityId} onChange={(event) => setLightEntityId(event.target.value)} placeholder="light.kitchen" /></label>
      <label>Climate entity<input value={climateEntityId} onChange={(event) => setClimateEntityId(event.target.value)} placeholder="climate.downstairs" /></label>
      <label>Sensor entities<input value={sensorEntityIds} onChange={(event) => setSensorEntityIds(event.target.value)} placeholder="sensor.temperature, sensor.humidity" /></label>
      <small>The token value is write-only. Polyth returns only its environment-variable name and configured state.</small>
      {(message || error) && <p className="ha-settings-message">{message || error}</p>}
      <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save Home Assistant"}</button>
    </form>
  );
}

function StatusAction() {
  const { status, error, reload } = useConnection();
  const state = status?.status ?? "unconfigured";
  return (
    <button
      type="button"
      className={`header-action ha-mini ha-status-${state}`}
      onClick={() => void reload()}
      title={status?.message || error || "Refresh Home Assistant status"}
    >
      <i aria-hidden="true" /><span>Home</span>
    </button>
  );
}

function LightAction() {
  const { config } = useConfig();
  const entityId = config?.entities.lightEntityId ?? "";
  const { entities, reload } = useEntities(entityId ? [entityId] : []);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const on = entities[0]?.state === "on";
  const toggle = async () => {
    if (!entityId) return;
    setActing(true);
    try {
      await api.homeAssistantToggle(entityId);
      await reload();
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setActing(false);
    }
  };
  return (
    <button
      type="button"
      className={`header-action ha-mini-light${on ? " is-on" : ""}`}
      disabled={!entityId || acting}
      onClick={() => void toggle()}
      title={error || (entityId ? `Turn ${entityId} ${on ? "off" : "on"}` : "Configure a Home Assistant light")}
    >
      <span aria-hidden="true">◉</span><span>{acting ? "Switching…" : "Light"}</span>
    </button>
  );
}

export const HOME_ASSISTANT_WIDGET_PLUGIN = defineWidgetPlugin({
  id: "home-assistant",
  name: "Home Assistant",
  widgets: [
    {
      id: "home-assistant.connection",
      title: "Home Assistant",
      description: "Connection health and Home Assistant server details.",
      kind: "widget",
      defaultSlot: "workspace.right",
      supportedSlots: WORKSPACE_SLOTS,
      defaultSize: { w: 4, h: 3 },
      minSize: { w: 3, h: 2 },
      maxSize: { w: 8, h: 6 },
      category: "Home",
      capabilities: ["polyth.homeAssistant"],
      audience: "simple",
      recommended: true,
      render: () => <ConnectionWidget />,
      settingsRender: () => <HomeAssistantSettings />,
    },
    {
      id: "home-assistant.entity-state",
      title: "Entity state",
      description: "Live state and attributes for a selected Home Assistant entity.",
      kind: "widget",
      defaultSlot: "workspace.right",
      supportedSlots: ["workspace.left", "workspace.main", "workspace.right"],
      defaultSize: { w: 4, h: 3 },
      minSize: { w: 3, h: 2 },
      maxSize: { w: 8, h: 7 },
      category: "Home",
      capabilities: ["polyth.homeAssistant"],
      audience: "standard",
      render: () => <EntityStateWidget />,
      settingsRender: () => <HomeAssistantSettings />,
    },
    {
      id: "home-assistant.light",
      title: "Light control",
      description: "See and toggle a configured Home Assistant light.",
      kind: "widget",
      defaultSlot: "workspace.header",
      supportedSlots: WORKSPACE_SLOTS,
      defaultSize: { w: 3, h: 2 },
      minSize: { w: 2, h: 2 },
      maxSize: { w: 6, h: 5 },
      category: "Home",
      capabilities: ["polyth.homeAssistant"],
      audience: "simple",
      recommended: true,
      render: () => <LightWidget />,
      settingsRender: () => <HomeAssistantSettings />,
    },
    {
      id: "home-assistant.climate-sensors",
      title: "Climate & sensors",
      description: "Temperature controls and sensor readings from Home Assistant.",
      kind: "widget",
      defaultSlot: "workspace.right",
      supportedSlots: ["workspace.left", "workspace.main", "workspace.right", "workspace.bottom"],
      defaultSize: { w: 5, h: 5 },
      minSize: { w: 4, h: 3 },
      maxSize: { w: 10, h: 8 },
      category: "Home",
      capabilities: ["polyth.homeAssistant"],
      audience: "standard",
      recommended: true,
      render: () => <ClimateSensorsWidget />,
      settingsRender: () => <HomeAssistantSettings />,
    },
    {
      id: "home-assistant.status-action",
      title: "Home status",
      description: "Compact Home Assistant connection indicator.",
      kind: "mini-widget",
      defaultSlot: "app.header.actions",
      supportedSlots: ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      category: "Home",
      capabilities: ["polyth.homeAssistant"],
      audience: "simple",
      resizable: false,
      order: 35,
      render: () => <StatusAction />,
    },
    {
      id: "home-assistant.light-action",
      title: "Quick light",
      description: "Toggle the configured Home Assistant light from a toolbar or panel.",
      kind: "mini-widget",
      defaultSlot: "session.header.actions",
      supportedSlots: ACTION_SLOTS,
      defaultSize: { w: 1, h: 1 },
      category: "Home",
      capabilities: ["polyth.homeAssistant"],
      audience: "simple",
      resizable: false,
      order: 36,
      render: () => <LightAction />,
    },
  ],
});

let uninstall: (() => void) | null = null;

export function installHomeAssistantPlugin(): () => void {
  if (uninstall) return uninstall;
  const unregister = registerWidgetPlugin(HOME_ASSISTANT_WIDGET_PLUGIN);
  const current = () => {
    unregister();
    if (uninstall === current) uninstall = null;
  };
  uninstall = current;
  return current;
}

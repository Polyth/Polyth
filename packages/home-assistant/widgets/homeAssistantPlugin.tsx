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
import { api } from "@polyth/session/web-api";
import { defineWidgetPlugin, registerWidgetPlugin } from "../../../apps/web/src/widgets/catalog.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Button,
  HomeIcon,
  IconButton,
  MinusIcon,
  PlusIcon,
  RefreshIcon,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";

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
  error instanceof Error ? error.message : tr("widgets.homeassistantplugin.requestFailed");

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
  return <div className="ha-empty empty-state--compact">{children}</div>;
}

function ConnectionWidget() {
  const { status, error, reload } = useConnection();
  const state = status?.status ?? "unconfigured";
  return (
    <div className="ha-connection">
      <div className={`ha-status ha-status-${state}`}>
        <i aria-hidden="true" />
        <div>
          <strong>{state === "connected" ? tr("widgets.homeassistantplugin.connected") : state === "unavailable" ? tr("common.unavailable") : tr("widgets.homeassistantplugin.notConfigured")}</strong>
          <span>{status?.version
            ? tr("widgets.homeassistantplugin.homeAssistantValue", { version: status.version })
            : status?.message || error || tr("widgets.homeassistantplugin.checkingConnection")}</span>
        </div>
      </div>
      {status?.baseUrl && <code>{status.baseUrl}</code>}
      <Button size="sm" iconStart={RefreshIcon} onClick={() => void reload()}>{tr("common.refresh")}</Button>
    </div>
  );
}

function EntityStateWidget() {
  const { config, error: configError } = useConfig();
  const entityId = config?.entities.stateEntityId ?? "";
  const { entities, error, loading, reload } = useEntities(entityId ? [entityId] : []);
  const entity = entities[0];
  if (!entityId) return <Empty>{tr("widgets.homeassistantplugin.chooseAStateEntityInThisWidget")}</Empty>;
  if (!entity) {
    return (
      <Empty>
        {error || configError || (loading
          ? tr("widgets.homeassistantplugin.loadingEntity")
          : tr("widgets.homeassistantplugin.entityUnavailable"))}
      </Empty>
    );
  }
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
      <Button size="sm" iconStart={RefreshIcon} onClick={() => void reload()}>{tr("widgets.homeassistantplugin.refreshState")}</Button>
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
  if (!entityId) return <Empty>{tr("widgets.homeassistantplugin.chooseALightEntityInThisWidget")}</Empty>;
  return (
    <div className={`ha-light${on ? " is-on" : ""}`}>
      <button type="button" onClick={() => void toggle()} disabled={acting || loading}>
        <span aria-hidden="true">◉</span>
        <strong>{entity ? entityName(entity) : tr("widgets.homeassistantplugin.light")}</strong>
        <small>{acting
          ? tr("widgets.homeassistantplugin.switching")
          : actionError || error || configError || (on
            ? tr("widgets.homeassistantplugin.on")
            : tr("widgets.homeassistantplugin.off"))}</small>
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
  if (ids.length === 0) return <Empty>{tr("widgets.homeassistantplugin.chooseClimateAndSensorEntitiesInThis")}</Empty>;
  return (
    <div className="ha-climate">
      {climate && (
        <section>
          <div>
            <span>{entityName(climate)}</span>
            <strong>{typeof currentRaw === "number" ? `${currentRaw}°` : climate.state}</strong>
          </div>
          <div className="ha-temperature">
            <IconButton
              icon={MinusIcon}
              size="sm"
              label={`− ${tr("widgets.homeassistantplugin.target")}`}
              disabled={acting || !Number.isFinite(target)}
              onClick={() => void setTemperature(target - 0.5)}
            />
            <span><small>{tr("widgets.homeassistantplugin.target")}</small><b>{Number.isFinite(target) ? `${target}°` : "—"}</b></span>
            <IconButton
              icon={PlusIcon}
              size="sm"
              label={`+ ${tr("widgets.homeassistantplugin.target")}`}
              disabled={acting || !Number.isFinite(target)}
              onClick={() => void setTemperature(target + 0.5)}
            />
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
      {loading && <small className="ha-loading">{tr("widgets.homeassistantplugin.refreshing")}</small>}
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
      setMessage(next.tokenConfigured ? tr("widgets.homeassistantplugin.savedAndTokenConfigured") : tr("widgets.homeassistantplugin.savedAddTheLongLivedToken"));
      await reload();
    } catch (cause) {
      setMessage(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="ha-settings" onSubmit={(event) => void save(event)}>
      <label>{tr("widgets.homeassistantplugin.homeAssistantUrl")}<TextInput value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={tr("widgets.homeassistantplugin.httpHomeassistantLocal8123")} /></label>
      <label>{tr("widgets.homeassistantplugin.tokenEnvironmentName")}<TextInput value={tokenEnv} onChange={(event) => setTokenEnv(event.target.value)} placeholder={tr("widgets.homeassistantplugin.homeAssistantToken")} /></label>
      <label>{tr("widgets.homeassistantplugin.longLivedToken")}<TextInput type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={config?.tokenConfigured ? tr("widgets.homeassistantplugin.configuredLeaveBlankToKeep") : tr("widgets.homeassistantplugin.writeOnlyToken")} autoComplete="new-password" /></label>
      <label>{tr("widgets.homeassistantplugin.stateEntity")}<TextInput value={stateEntityId} onChange={(event) => setStateEntityId(event.target.value)} placeholder={tr("widgets.homeassistantplugin.binarySensorFrontDoor")} /></label>
      <label>{tr("widgets.homeassistantplugin.lightEntity")}<TextInput value={lightEntityId} onChange={(event) => setLightEntityId(event.target.value)} placeholder={tr("widgets.homeassistantplugin.lightKitchen")} /></label>
      <label>{tr("widgets.homeassistantplugin.climateEntity")}<TextInput value={climateEntityId} onChange={(event) => setClimateEntityId(event.target.value)} placeholder={tr("widgets.homeassistantplugin.climateDownstairs")} /></label>
      <label>{tr("widgets.homeassistantplugin.sensorEntities")}<TextInput value={sensorEntityIds} onChange={(event) => setSensorEntityIds(event.target.value)} placeholder={tr("widgets.homeassistantplugin.sensorTemperatureSensorHumidity")} /></label>
      <small>{tr("widgets.homeassistantplugin.theTokenValueIsWriteOnlyPolyth")}</small>
      {(message || error) && <p className="ha-settings-message">{message || error}</p>}
      <Button type="submit" variant="primary" busy={saving}>{tr("widgets.homeassistantplugin.saveHomeAssistant")}</Button>
    </form>
  );
}

function StatusAction() {
  const { status, error, reload } = useConnection();
  const state = status?.status ?? "unconfigured";
  return (
    <span className={`header-action ha-mini ha-status-${state}`}>
      <IconButton
        icon={HomeIcon}
        size="md"
        variant="ghost"
        label={tr("widgets.homeassistantplugin.refreshHomeAssistantStatus")}
        title={status?.message || error || tr("widgets.homeassistantplugin.refreshHomeAssistantStatus")}
        onClick={() => void reload()}
      />
      <i aria-hidden="true" />
    </span>
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
      title={error || (entityId
        ? tr("widgets.homeassistantplugin.turnValueValue", {
            entityId,
            state: on ? tr("widgets.homeassistantplugin.off") : tr("widgets.homeassistantplugin.on"),
          })
        : tr("widgets.homeassistantplugin.configureAHomeAssistantLight"))}
    >
      <span aria-hidden="true">◉</span><span>{acting ? tr("widgets.homeassistantplugin.switching") : tr("widgets.homeassistantplugin.light")}</span>
    </button>
  );
}

export const HOME_ASSISTANT_WIDGET_PLUGIN = defineWidgetPlugin({
  id: "home-assistant",
  name: "Home Assistant",
  widgets: [
    {
      id: "home-assistant.connection",
      title: tr("widgets.homeassistantplugin.homeAssistant"),
      description: tr("widgets.homeassistantplugin.connectionHealthAndHomeAssistantServerDetails"),
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
      title: tr("widgets.homeassistantplugin.entityState"),
      description: tr("widgets.homeassistantplugin.liveStateAndAttributesForASelected"),
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
      title: tr("widgets.homeassistantplugin.lightControl"),
      description: tr("widgets.homeassistantplugin.seeAndToggleAConfiguredHomeAssistant"),
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
      title: tr("widgets.homeassistantplugin.climateSensors"),
      description: tr("widgets.homeassistantplugin.temperatureControlsAndSensorReadingsFromHome"),
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
      title: tr("widgets.homeassistantplugin.homeStatus"),
      description: tr("widgets.homeassistantplugin.compactHomeAssistantConnectionIndicator"),
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
      title: tr("widgets.homeassistantplugin.quickLight"),
      description: tr("widgets.homeassistantplugin.toggleTheConfiguredHomeAssistantLightFrom"),
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

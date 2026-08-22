import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  cap,
  type HomeAssistantConfigDto,
  type HomeAssistantConfigInput,
  type HomeAssistantConnectionDto,
  type HomeAssistantEntityDto,
  type HomeAssistantEntitySelection,
  type JsonValue,
  type Plugin,
  type RouteHandler,
  type RouteRequest,
  type WidgetContributionDescriptor,
} from "@polyth/contracts";

export { default as createHomeAssistantServerPlugin } from "./serverEntry.ts";

interface StoredHomeAssistantConfig {
  baseUrl: string;
  tokenEnv: string;
  entities: HomeAssistantEntitySelection;
}

interface HomeAssistantStateResponse {
  entity_id?: unknown;
  state?: unknown;
  attributes?: unknown;
  last_changed?: unknown;
  last_updated?: unknown;
}

export interface HomeAssistantService {
  config(): HomeAssistantConfigDto;
  configure(input: HomeAssistantConfigInput): HomeAssistantConfigDto;
  status(): Promise<HomeAssistantConnectionDto>;
  state(entityId: string): Promise<HomeAssistantEntityDto>;
  states(entityIds?: readonly string[]): Promise<HomeAssistantEntityDto[]>;
  callService(
    domain: string,
    service: string,
    data?: Record<string, JsonValue>,
  ): Promise<HomeAssistantEntityDto[]>;
  toggle(entityId: string): Promise<HomeAssistantEntityDto>;
  setTemperature(entityId: string, temperature: number): Promise<HomeAssistantEntityDto>;
}

export interface HomeAssistantServiceOptions {
  file: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const routeFailure = (
  request: RouteRequest,
  error: unknown,
  fallback = "Home Assistant request failed",
): true => {
  const code = (error as { code?: unknown }).code;
  const invalidInput = code === "invalid-input";
  request.json(invalidInput ? 400 : 502, {
    error: invalidInput ? "invalid-input" : "upstream",
    message: error instanceof Error ? error.message : fallback,
  });
  return true;
};

const entityPayload = (body: Record<string, unknown>): string =>
  typeof body.entityId === "string" ? body.entityId : "";

export function homeAssistantRoutes(homeAssistant: HomeAssistantService): RouteHandler {
  return async (request) => {
    const { path, method, json, url } = request;
    if (path === "/api/home-assistant/config" && method === "GET") {
      json(200, homeAssistant.config());
      return true;
    }
    if (path === "/api/home-assistant/config" && method === "PUT") {
      try {
        json(200, homeAssistant.configure(await request.body() as HomeAssistantConfigInput));
      } catch (error) {
        return routeFailure(request, error, "Home Assistant settings could not be saved");
      }
      return true;
    }
    if (path === "/api/home-assistant/status" && method === "GET") {
      json(200, await homeAssistant.status());
      return true;
    }
    if (path === "/api/home-assistant/entities" && method === "GET") {
      try {
        const requested = url.searchParams.getAll("entityId");
        json(200, await homeAssistant.states(requested.length > 0 ? requested : undefined));
      } catch (error) {
        return routeFailure(request, error);
      }
      return true;
    }
    if (path === "/api/home-assistant/toggle" && method === "POST") {
      try {
        json(200, await homeAssistant.toggle(entityPayload(await request.body())));
      } catch (error) {
        return routeFailure(request, error);
      }
      return true;
    }
    if (path === "/api/home-assistant/climate/temperature" && method === "POST") {
      try {
        const body = await request.body();
        json(200, await homeAssistant.setTemperature(
          entityPayload(body),
          typeof body.temperature === "number" ? body.temperature : Number.NaN,
        ));
      } catch (error) {
        return routeFailure(request, error);
      }
      return true;
    }
    return false;
  };
}

export const HOME_ASSISTANT_CAP = cap<HomeAssistantService>("polyth.homeAssistant");

export const HOME_ASSISTANT_WIDGETS: readonly WidgetContributionDescriptor[] = [
  {
    id: "home-assistant.connection",
    module: "home-assistant.connection",
    title: "Home Assistant",
    description: "Connection health and Home Assistant server details.",
    kind: "widget",
    defaultSlot: "workspace.right",
    supportedSlots: ["workspace.header", "workspace.left", "workspace.main", "workspace.right"],
    category: "Home",
    capabilities: ["polyth.homeAssistant"],
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 12, h: 50 },
    audience: "simple",
    recommended: true,
    defaultVisible: false,
  },
  {
    id: "home-assistant.entity-state",
    module: "home-assistant.entity-state",
    title: "Entity state",
    description: "Live state and attributes for a selected Home Assistant entity.",
    kind: "widget",
    defaultSlot: "workspace.right",
    supportedSlots: ["workspace.left", "workspace.main", "workspace.right"],
    category: "Home",
    capabilities: ["polyth.homeAssistant"],
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 12, h: 50 },
    audience: "standard",
    duplicatable: true,
    defaultVisible: false,
  },
  {
    id: "home-assistant.light",
    module: "home-assistant.light",
    title: "Light control",
    description: "See and toggle a configured Home Assistant light.",
    kind: "widget",
    defaultSlot: "workspace.header",
    supportedSlots: ["workspace.header", "workspace.left", "workspace.main", "workspace.right"],
    category: "Home",
    capabilities: ["polyth.homeAssistant"],
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
    maxSize: { w: 12, h: 50 },
    audience: "simple",
    recommended: true,
    defaultVisible: false,
  },
  {
    id: "home-assistant.climate-sensors",
    module: "home-assistant.climate-sensors",
    title: "Climate & sensors",
    description: "Temperature controls and sensor readings from Home Assistant.",
    kind: "widget",
    defaultSlot: "workspace.right",
    supportedSlots: ["workspace.left", "workspace.main", "workspace.right", "workspace.bottom"],
    category: "Home",
    capabilities: ["polyth.homeAssistant"],
    defaultSize: { w: 5, h: 5 },
    minSize: { w: 4, h: 3 },
    maxSize: { w: 12, h: 50 },
    audience: "standard",
    recommended: true,
    defaultVisible: false,
  },
  {
    id: "home-assistant.status-action",
    module: "home-assistant.status-action",
    title: "Home status",
    description: "Compact Home Assistant connection indicator.",
    kind: "mini-widget",
    defaultSlot: "app.header.actions",
    supportedSlots: ["app.header.actions", "session.header.actions", "app.nav"],
    category: "Home",
    capabilities: ["polyth.homeAssistant"],
    defaultSize: { w: 1, h: 1 },
    audience: "simple",
    resizable: false,
    order: 35,
    defaultVisible: true,
  },
  {
    id: "home-assistant.light-action",
    module: "home-assistant.light-action",
    title: "Quick light",
    description: "Toggle the configured Home Assistant light from a toolbar or panel.",
    kind: "mini-widget",
    defaultSlot: "session.header.actions",
    supportedSlots: ["app.header.actions", "session.header.actions", "app.nav"],
    category: "Home",
    capabilities: ["polyth.homeAssistant"],
    defaultSize: { w: 1, h: 1 },
    audience: "simple",
    resizable: false,
    order: 36,
    defaultVisible: false,
  },
];

/** Built-in feature plugin: the server owns the credentialed service while the
 * manifest declares every full and mini widget through the shared widget API. */
export function createHomeAssistantPlugin(service: HomeAssistantService): Plugin {
  return {
    manifest: {
      id: "home-assistant",
      version: "1.0.0",
      trust: "credentialed",
      provides: [HOME_ASSISTANT_CAP.id],
      widgets: [...HOME_ASSISTANT_WIDGETS],
    },
    setup(ctx) {
      ctx.provide(HOME_ASSISTANT_CAP, service);
    },
  };
}

const DEFAULT_ENTITIES: HomeAssistantEntitySelection = {
  stateEntityId: "",
  lightEntityId: "",
  climateEntityId: "",
  sensorEntityIds: [],
};

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

const unavailable = (message: string): Error =>
  Object.assign(new Error(message), { code: "unavailable" });

const shortString = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const checkEntityId = (entityId: string): string => {
  const value = shortString(entityId, 255).toLowerCase();
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(value)) {
    throw invalid(`invalid Home Assistant entity id: ${entityId || "(empty)"}`);
  }
  return value;
};

const checkServicePart = (value: string, label: string): string => {
  const part = shortString(value, 64).toLowerCase();
  if (!/^[a-z0-9_]+$/.test(part)) throw invalid(`invalid Home Assistant ${label}`);
  return part;
};

const normalizeUrl = (value: unknown): string => {
  const raw = shortString(value, 2048);
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("Home Assistant URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid("Home Assistant URL must use http or https");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
};

const normalizeTokenEnv = (value: unknown): string => {
  const ref = shortString(value, 128);
  if (!ref) return "";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(ref)) {
    throw invalid("Home Assistant token reference must be an environment variable name");
  }
  return ref;
};

const normalizeEntities = (
  input: Partial<HomeAssistantEntitySelection> | undefined,
  previous: HomeAssistantEntitySelection,
): HomeAssistantEntitySelection => {
  const optionalEntity = (value: unknown, fallback: string): string => {
    if (value === undefined) return fallback;
    const entityId = shortString(value, 255);
    return entityId ? checkEntityId(entityId) : "";
  };
  let sensorEntityIds = previous.sensorEntityIds;
  if (input?.sensorEntityIds !== undefined) {
    if (!Array.isArray(input.sensorEntityIds)) throw invalid("sensor entity ids must be an array");
    sensorEntityIds = [...new Set(input.sensorEntityIds.map((value) => checkEntityId(String(value))))]
      .slice(0, 16);
  }
  return {
    stateEntityId: optionalEntity(input?.stateEntityId, previous.stateEntityId),
    lightEntityId: optionalEntity(input?.lightEntityId, previous.lightEntityId),
    climateEntityId: optionalEntity(input?.climateEntityId, previous.climateEntityId),
    sensorEntityIds,
  };
};

function atomicWrite(path: string, data: string, mode?: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { encoding: "utf8", ...(mode ? { mode } : {}) });
  try {
    renameSync(tmp, path);
    if (mode) chmodSync(path, mode);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // already renamed or removed
    }
    throw error;
  }
}

const jsonRecord = (value: unknown): Record<string, JsonValue> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
  } catch {
    return {};
  }
};

const toEntity = (raw: unknown): HomeAssistantEntityDto => {
  if (!raw || typeof raw !== "object") throw unavailable("Home Assistant returned an invalid entity");
  const state = raw as HomeAssistantStateResponse;
  const entityId = checkEntityId(String(state.entity_id ?? ""));
  return {
    entityId,
    state: String(state.state ?? "unknown"),
    attributes: jsonRecord(state.attributes),
    lastChanged: String(state.last_changed ?? ""),
    lastUpdated: String(state.last_updated ?? ""),
  };
};

export function createHomeAssistantService(
  options: HomeAssistantServiceOptions,
): HomeAssistantService {
  mkdirSync(dirname(options.file), { recursive: true });
  const secretsFile = options.file.endsWith(".json")
    ? options.file.replace(/\.json$/, "-secrets.json")
    : `${options.file}-secrets.json`;
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 8_000;

  const load = <T>(path: string, fallback: T): T => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return fallback;
    }
  };

  const rawConfig = load<Partial<StoredHomeAssistantConfig>>(options.file, {});
  let settings: StoredHomeAssistantConfig;
  try {
    settings = {
      baseUrl: normalizeUrl(rawConfig.baseUrl),
      tokenEnv: normalizeTokenEnv(rawConfig.tokenEnv),
      entities: normalizeEntities(rawConfig.entities, DEFAULT_ENTITIES),
    };
  } catch {
    settings = { baseUrl: "", tokenEnv: "", entities: structuredClone(DEFAULT_ENTITIES) };
  }
  let secrets = load<Record<string, string>>(secretsFile, {});

  const resolveToken = (): string | undefined => {
    if (!settings.tokenEnv) return undefined;
    return env[settings.tokenEnv] || secrets[settings.tokenEnv] || undefined;
  };

  const dto = (): HomeAssistantConfigDto => ({
    baseUrl: settings.baseUrl,
    tokenEnv: settings.tokenEnv,
    tokenConfigured: !!resolveToken(),
    entities: structuredClone(settings.entities),
  });

  const persist = (): void => {
    atomicWrite(options.file, JSON.stringify(settings, null, 2));
    atomicWrite(secretsFile, JSON.stringify(secrets), 0o600);
  };

  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    if (!settings.baseUrl) throw unavailable("Home Assistant URL is not configured");
    const token = resolveToken();
    if (!token) {
      throw unavailable(
        settings.tokenEnv
          ? `Home Assistant token is not available from ${settings.tokenEnv}`
          : "Home Assistant token reference is not configured",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        `${settings.baseUrl}/${path.replace(/^\/+/, "")}`,
        {
          ...init,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(init.headers ?? {}),
          },
        },
      );
      if (!response.ok) {
        throw unavailable(`Home Assistant request failed with HTTP ${response.status}`);
      }
      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      if ((error as { code?: unknown }).code === "unavailable") throw error;
      const reason = error instanceof Error && error.name === "AbortError"
        ? "request timed out"
        : "connection failed";
      throw unavailable(`Home Assistant ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  };

  const state = async (entityId: string): Promise<HomeAssistantEntityDto> =>
    toEntity(await request(`api/states/${encodeURIComponent(checkEntityId(entityId))}`));

  const callService = async (
    domain: string,
    service: string,
    data: Record<string, JsonValue> = {},
  ): Promise<HomeAssistantEntityDto[]> => {
    const result = await request(
      `api/services/${checkServicePart(domain, "domain")}/${checkServicePart(service, "service")}`,
      { method: "POST", body: JSON.stringify(data) },
    );
    return Array.isArray(result) ? result.map(toEntity) : [];
  };

  return {
    config: dto,

    configure(input) {
      if (!input || typeof input !== "object") throw invalid("Home Assistant settings are required");
      const previousEnv = settings.tokenEnv;
      const nextEnv = input.tokenEnv === undefined
        ? previousEnv
        : normalizeTokenEnv(input.tokenEnv);
      const next: StoredHomeAssistantConfig = {
        baseUrl: input.baseUrl === undefined ? settings.baseUrl : normalizeUrl(input.baseUrl),
        tokenEnv: nextEnv,
        entities: normalizeEntities(input.entities, settings.entities),
      };

      if (input.token !== undefined) {
        if (!nextEnv) throw invalid("set a token environment variable name before saving a token");
        const value = typeof input.token === "string" ? input.token.trim() : "";
        if (value) secrets[nextEnv] = value;
        else delete secrets[nextEnv];
      } else if (previousEnv && nextEnv && previousEnv !== nextEnv && secrets[previousEnv]) {
        secrets[nextEnv] = secrets[previousEnv]!;
        delete secrets[previousEnv];
      }
      settings = next;
      persist();
      return dto();
    },

    async status() {
      const checkedAt = now();
      if (!settings.baseUrl || !resolveToken()) {
        return {
          status: "unconfigured",
          baseUrl: settings.baseUrl,
          checkedAt,
          message: !settings.baseUrl
            ? "Home Assistant URL is not configured"
            : "Home Assistant token is not configured",
        };
      }
      try {
        const config = await request("api/config") as { version?: unknown };
        return {
          status: "connected",
          baseUrl: settings.baseUrl,
          checkedAt,
          ...(typeof config?.version === "string" ? { version: config.version } : {}),
        };
      } catch (error) {
        return {
          status: "unavailable",
          baseUrl: settings.baseUrl,
          checkedAt,
          message: error instanceof Error ? error.message : "Home Assistant is unavailable",
        };
      }
    },

    state,

    async states(entityIds) {
      const configured = [
        settings.entities.stateEntityId,
        settings.entities.lightEntityId,
        settings.entities.climateEntityId,
        ...settings.entities.sensorEntityIds,
      ].filter(Boolean);
      const ids = [...new Set((entityIds ?? configured).map(checkEntityId))].slice(0, 32);
      return Promise.all(ids.map(state));
    },

    callService,

    async toggle(entityId) {
      const id = checkEntityId(entityId);
      const domain = id.startsWith("light.") ? "light" : "homeassistant";
      const changed = await callService(domain, "toggle", { entity_id: id });
      return changed.find((entity) => entity.entityId === id) ?? state(id);
    },

    async setTemperature(entityId, temperature) {
      const id = checkEntityId(entityId);
      if (!id.startsWith("climate.")) throw invalid("temperature controls require a climate entity");
      if (!Number.isFinite(temperature) || temperature < 5 || temperature > 40) {
        throw invalid("temperature must be between 5 and 40");
      }
      const changed = await callService("climate", "set_temperature", {
        entity_id: id,
        temperature,
      });
      return changed.find((entity) => entity.entityId === id) ?? state(id);
    },
  };
}

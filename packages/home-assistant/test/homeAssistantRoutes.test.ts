import test from "node:test";
import assert from "node:assert/strict";
import type {
  HomeAssistantConfigDto,
  HomeAssistantEntityDto,
} from "@polyth/contracts";
import type { HomeAssistantService } from "@polyth/home-assistant";
import type { RouteRequest } from "../../server/src/http.ts";
import { homeAssistantRoutes } from "@polyth/home-assistant";

const CONFIG: HomeAssistantConfigDto = {
  baseUrl: "https://ha.example.test",
  tokenEnv: "HA_TOKEN",
  tokenConfigured: true,
  entities: {
    stateEntityId: "binary_sensor.door",
    lightEntityId: "light.kitchen",
    climateEntityId: "climate.downstairs",
    sensorEntityIds: ["sensor.temperature"],
  },
};

const entity = (entityId: string, state: string): HomeAssistantEntityDto => ({
  entityId,
  state,
  attributes: {},
  lastChanged: "",
  lastUpdated: "",
});

function harness() {
  let config = structuredClone(CONFIG);
  const calls: Array<{ action: string; value?: unknown }> = [];
  const service: HomeAssistantService = {
    config: () => structuredClone(config),
    configure: (input) => {
      calls.push({ action: "configure", value: input });
      config = { ...config, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}) };
      return structuredClone(config);
    },
    status: async () => ({
      status: "connected",
      baseUrl: config.baseUrl,
      checkedAt: 42,
      version: "2026.8.1",
    }),
    state: async (id) => entity(id, "on"),
    states: async (ids) => {
      calls.push({ action: "states", value: ids });
      return (ids ?? [config.entities.stateEntityId]).map((id) => entity(id, "on"));
    },
    callService: async () => [],
    toggle: async (id) => {
      calls.push({ action: "toggle", value: id });
      return entity(id, "on");
    },
    setTemperature: async (id, temperature) => {
      calls.push({ action: "temperature", value: { id, temperature } });
      return entity(id, "heat");
    },
  };
  const routes = homeAssistantRoutes(service);

  const call = async (
    method: string,
    path: string,
    body: Record<string, unknown> = {},
  ) => {
    let status = 0;
    let payload: unknown;
    const url = new URL(`http://polyth.test${path}`);
    const handled = await routes({
      req: {},
      res: {},
      url,
      path: url.pathname,
      method,
      body: async () => body,
      json: (code, value) => {
        status = code;
        payload = value;
      },
    } as unknown as RouteRequest);
    return { handled, status, payload };
  };
  return { call, calls, service };
}

test("Home Assistant routes expose safe configuration and connection status", async () => {
  const { call, calls } = harness();
  const config = await call("GET", "/api/home-assistant/config");
  assert.equal(config.handled, true);
  assert.equal(config.status, 200);
  assert.doesNotMatch(JSON.stringify(config.payload), /secret-value/);
  assert.equal((config.payload as HomeAssistantConfigDto).tokenEnv, "HA_TOKEN");

  const saved = await call("PUT", "/api/home-assistant/config", {
    baseUrl: "https://new-ha.example.test",
    token: "secret-value",
  });
  assert.equal(saved.status, 200);
  assert.equal(calls[0]?.action, "configure");
  assert.doesNotMatch(JSON.stringify(saved.payload), /secret-value/);

  const status = await call("GET", "/api/home-assistant/status");
  assert.deepEqual(status.payload, {
    status: "connected",
    baseUrl: "https://new-ha.example.test",
    checkedAt: 42,
    version: "2026.8.1",
  });
});

test("Home Assistant routes read selected entities and invoke controls", async () => {
  const { call, calls } = harness();
  const states = await call(
    "GET",
    "/api/home-assistant/entities?entityId=sensor.temperature&entityId=light.kitchen",
  );
  assert.equal(states.status, 200);
  assert.deepEqual(
    (states.payload as HomeAssistantEntityDto[]).map((item) => item.entityId),
    ["sensor.temperature", "light.kitchen"],
  );
  assert.deepEqual(calls[0], {
    action: "states",
    value: ["sensor.temperature", "light.kitchen"],
  });

  const toggled = await call("POST", "/api/home-assistant/toggle", {
    entityId: "light.kitchen",
  });
  assert.equal(toggled.status, 200);
  assert.equal((toggled.payload as HomeAssistantEntityDto).state, "on");

  const climate = await call("POST", "/api/home-assistant/climate/temperature", {
    entityId: "climate.downstairs",
    temperature: 22,
  });
  assert.equal(climate.status, 200);
  assert.deepEqual(calls.at(-1), {
    action: "temperature",
    value: { id: "climate.downstairs", temperature: 22 },
  });
});

test("Home Assistant routes contain upstream errors and ignore unrelated paths", async () => {
  const { call, service } = harness();
  service.toggle = async () => {
    throw Object.assign(new Error("Home Assistant request failed with HTTP 401"), {
      code: "unavailable",
    });
  };
  const denied = await call("POST", "/api/home-assistant/toggle", {
    entityId: "light.kitchen",
  });
  assert.equal(denied.status, 502);
  assert.deepEqual(denied.payload, {
    error: "upstream",
    message: "Home Assistant request failed with HTTP 401",
  });

  assert.equal((await call("GET", "/api/not-home-assistant")).handled, false);
});

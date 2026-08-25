import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createContext, loadPlugin } from "@polyth/kernel";
import {
  registerHomeAssistantPackage,
  createHomeAssistantService,
} from "@polyth/home-assistant";

const tempFile = (): string =>
  join(mkdtempSync(join(tmpdir(), "polyth-home-assistant-")), "home-assistant.json");

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("server package exposes routes and mounts its kernel plugin per enable", async () => {
  const storageDir = mkdtempSync(join(tmpdir(), "polyth-home-assistant-plugin-"));
  const root = createContext("test-root");
  let mounted = 0;
  let disposedClean = 0;
  const host = {
    pluginId: "home-assistant",
    storageDir,
    routes: { add: () => ({ dispose() {} }) },
    root,
    loadPlugin: async (plugin: Plugin) => {
      mounted += 1;
      const loaded = await loadPlugin(root, plugin, {});
      return {
        dispose: async () => {
          disposedClean += 1;
          await loaded.dispose();
        },
      };
    },
  } as unknown as ServerPackageHost;

  const pkg = registerHomeAssistantPackage(host);
  assert.equal(typeof pkg.routes, "function");

  await pkg.onEnable?.();
  assert.equal(mounted, 1);

  // The route is live independent of the kernel plugin scope; the lifecycle
  // wrapper (packages/server) adds/removes it around enable/disable.
  let status = 0;
  await pkg.routes!({
    path: "/api/home-assistant/config",
    method: "GET",
    url: new URL("http://polyth.test/api/home-assistant/config"),
    json: (code: number) => { status = code; },
  } as never);
  assert.equal(status, 200);

  await pkg.onDisable?.();
  assert.equal(disposedClean, 1);
  await root.dispose();
});

test("configuration keeps token values write-only in a separate secrets file", async () => {
  const file = tempFile();
  const service = createHomeAssistantService({
    file,
    env: {},
    fetchImpl: (async () => response({ version: "2026.8.1" })) as typeof fetch,
  });

  const config = service.configure({
    baseUrl: "https://ha.example.test/",
    tokenEnv: "HOME_ASSISTANT_TOKEN",
    token: "a-long-lived-access-token",
    entities: {
      stateEntityId: "binary_sensor.front_door",
      lightEntityId: "light.kitchen",
      climateEntityId: "climate.downstairs",
      sensorEntityIds: ["sensor.temperature", "sensor.humidity"],
    },
  });

  assert.equal(config.baseUrl, "https://ha.example.test");
  assert.equal(config.tokenEnv, "HOME_ASSISTANT_TOKEN");
  assert.equal(config.tokenConfigured, true);
  assert.doesNotMatch(JSON.stringify(config), /long-lived-access-token/);
  assert.doesNotMatch(readFileSync(file, "utf8"), /long-lived-access-token/);
  const secretsFile = file.replace(/\.json$/, "-secrets.json");
  assert.match(readFileSync(secretsFile, "utf8"), /long-lived-access-token/);
  assert.equal(statSync(secretsFile).mode & 0o777, 0o600);

  const reloaded = createHomeAssistantService({
    file,
    env: {},
    fetchImpl: (async () => response({ version: "2026.8.1" })) as typeof fetch,
    now: () => 123,
  });
  assert.equal(reloaded.config().tokenConfigured, true);
  assert.deepEqual(await reloaded.status(), {
    status: "connected",
    baseUrl: "https://ha.example.test",
    checkedAt: 123,
    version: "2026.8.1",
  });
});

test("entity reads and controls use authenticated Home Assistant REST calls", async () => {
  const calls: Array<{ url: string; method: string; auth: string; body: unknown }> = [];
  const entity = (entityId: string, state: string, attributes: Record<string, unknown> = {}) => ({
    entity_id: entityId,
    state,
    attributes,
    last_changed: "2026-08-21T10:00:00Z",
    last_updated: "2026-08-21T10:00:00Z",
  });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: String((init?.headers as Record<string, string>)?.authorization ?? ""),
      body,
    });
    if (String(url).endsWith("/api/services/light/toggle")) {
      return response([entity("light.kitchen", "on", { brightness: 180 })]);
    }
    if (String(url).endsWith("/api/services/climate/set_temperature")) {
      return response([entity("climate.downstairs", "heat", { temperature: 21 })]);
    }
    const id = decodeURIComponent(String(url).split("/").at(-1) ?? "");
    return response(entity(id, id.startsWith("sensor.") ? "19.5" : "off", {
      friendly_name: "Test entity",
      unit_of_measurement: id.startsWith("sensor.") ? "°C" : undefined,
    }));
  }) as typeof fetch;
  const service = createHomeAssistantService({ file: tempFile(), env: {}, fetchImpl });
  service.configure({
    baseUrl: "http://homeassistant.local:8123",
    tokenEnv: "HA_TOKEN",
    token: "secret-token",
    entities: {
      stateEntityId: "binary_sensor.front_door",
      lightEntityId: "light.kitchen",
      climateEntityId: "climate.downstairs",
      sensorEntityIds: ["sensor.temperature"],
    },
  });

  const states = await service.states();
  assert.deepEqual(states.map((item) => item.entityId), [
    "binary_sensor.front_door",
    "light.kitchen",
    "climate.downstairs",
    "sensor.temperature",
  ]);
  assert.equal(states[3]?.attributes.friendly_name, "Test entity");

  assert.equal((await service.toggle("light.kitchen")).state, "on");
  assert.equal((await service.setTemperature("climate.downstairs", 21)).attributes.temperature, 21);
  assert.ok(calls.every((call) => call.auth === "Bearer secret-token"));
  assert.deepEqual(calls.at(-2)?.body, { entity_id: "light.kitchen" });
  assert.deepEqual(calls.at(-1)?.body, {
    entity_id: "climate.downstairs",
    temperature: 21,
  });
});

test("configuration and controls reject unsafe or malformed input", async () => {
  const service = createHomeAssistantService({ file: tempFile(), env: {} });
  assert.throws(
    () => service.configure({ baseUrl: "file:///etc/passwd" }),
    /must use http or https/,
  );
  assert.throws(
    () => service.configure({ tokenEnv: "pasted-token!value" }),
    /environment variable name/,
  );
  assert.throws(
    () => service.configure({ entities: { lightEntityId: "../light" } }),
    /invalid Home Assistant entity id/,
  );
  await assert.rejects(
    () => service.setTemperature("sensor.temperature", 22),
    /require a climate entity/,
  );
  assert.equal((await service.status()).status, "unconfigured");
});

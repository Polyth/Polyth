import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderManager, type VisibilityPort } from "../src/providerManager.ts";
import type { CustomProviderApply, ModelDescriptor, ProviderConfigPort, ProviderInspect } from "@polyth/contracts";

const models: ModelDescriptor[] = [
  { providerID: "openai", modelID: "gpt", name: "GPT", connected: true },
];

function fakePorts(opts: {
  failConfig?: boolean;
  failAuth?: boolean;
  failAuthRemove?: boolean;
  failVisibility?: boolean;
  discover?: (input: { baseURL: string; apiKey?: string }) => Promise<
    | { ok: true; models: Array<{ id: string; name?: string }> }
    | { ok: false; code: "unsupported" | "unreachable" | "auth-rejected"; message: string }
  >;
} = {}) {
  const fail = {
    config: opts.failConfig === true,
    auth: opts.failAuth === true,
    authRemove: opts.failAuthRemove === true,
    visibility: opts.failVisibility === true,
  };
  const discoverCalls: Array<{ baseURL: string; apiKey?: string }> = [];
  const providers: Record<string, ProviderInspect & { models?: Record<string, unknown> }> = {};
  const visibilityState = {
    disabledProviders: [] as string[],
    disabledModels: [] as string[],
    addedProviders: [] as Array<{
      id: string;
      name?: string;
      origin?: "builtin" | "custom" | "externally-configured";
      authMode?: "api-key" | "none";
      hasStoredCredential?: boolean;
    }>,
  };
  const visibility: VisibilityPort = {
    state: () => visibilityState,
    catalog: () => [],
    async addProvider(id, name, origin, meta) {
      if (fail.visibility) throw Object.assign(new Error("visibility write failed"), { code: "unavailable" });
      visibilityState.addedProviders = [
        ...visibilityState.addedProviders.filter((p) => p.id !== id),
        {
          id,
          ...(name ? { name } : {}),
          ...(origin ? { origin } : {}),
          ...(meta?.authMode ? { authMode: meta.authMode } : {}),
          ...(meta?.hasStoredCredential ? { hasStoredCredential: true } : {}),
        },
      ];
      return visibilityState;
    },
    async removeProvider(id) {
      if (fail.visibility) throw Object.assign(new Error("visibility write failed"), { code: "unavailable" });
      visibilityState.addedProviders = visibilityState.addedProviders.filter((p) => p.id !== id);
      visibilityState.disabledModels = visibilityState.disabledModels.filter((key) => !key.startsWith(`${id}/`));
      return visibilityState;
    },
    async setModelEnabled(key, enabled) {
      const set = new Set(visibilityState.disabledModels);
      if (enabled) set.delete(key); else set.add(key);
      visibilityState.disabledModels = [...set];
      return visibilityState;
    },
  };
  const config: ProviderConfigPort = {
    async readConfig() {
      return { provider: Object.fromEntries(Object.entries(providers).map(([id, p]) => [id, { name: p.name }])) };
    },
    async applyCustomProvider(input: CustomProviderApply) {
      if (opts.failConfig || fail.config) throw Object.assign(new Error("config write failed"), { code: "unavailable" });
      const previous = providers[input.id];
      providers[input.id] = {
        id: input.id,
        name: input.name,
        owned: true,
        protocol: input.protocol,
        authMode: input.authMode,
        baseURL: input.baseURL,
        headers: input.headerPatch?.set ?? previous?.headers,
        headerNames: Object.keys(input.headerPatch?.set ?? previous?.headers ?? {}),
        modelIDs: [
          ...new Set([
            ...(previous?.modelIDs ?? []),
            ...Object.keys(input.models ?? {}),
          ]),
        ],
      };
    },
    async removeCustomProvider(id) {
      if (fail.config) throw Object.assign(new Error("config write failed"), { code: "unavailable" });
      delete providers[id];
    },
    async inspectProvider(id) { return providers[id]; },
    async mergeDiscoveredModels(id, discovered) {
      const current = providers[id];
      if (!current) throw Object.assign(new Error("not-found"), { code: "not-found" });
      current.modelIDs = [...new Set([...(current.modelIDs ?? []), ...discovered.map((m) => m.id)])];
    },
    async addManualModel(id, model) {
      const current = providers[id];
      if (!current) throw Object.assign(new Error("not-found"), { code: "not-found" });
      current.modelIDs = [...new Set([...(current.modelIDs ?? []), model.id])];
    },
    async removeConfiguredModel(id, modelId) {
      const current = providers[id];
      if (!current) throw Object.assign(new Error("not-found"), { code: "not-found" });
      current.modelIDs = (current.modelIDs ?? []).filter((item) => item !== modelId);
    },
  };
  const keys: string[] = [];
  const manager = createProviderManager({
    visibility,
    config,
    runtime: async () => ({
      setProviderApiKey: async (id: string, key: string) => {
        if (opts.failAuth || fail.auth) throw Object.assign(new Error(`auth failed for ${key}`), { code: "unavailable" });
        keys.push(`${id}:${key}`);
        return true;
      },
      removeProviderAuth: async (id: string) => {
        if (fail.authRemove) throw Object.assign(new Error("auth delete unknown"), { code: "unavailable" });
        keys.push(`removed:${id}`);
        return true;
      },
    } as never),
    discoverModels: async (input) => {
      discoverCalls.push({ baseURL: input.baseURL, ...(input.apiKey ? { apiKey: input.apiKey } : {}) });
      if (opts.discover) return opts.discover(input);
      return { ok: true, models: [] };
    },
    invalidateCatalog: () => {},
  });
  return { manager, visibilityState, providers, keys, fail, discoverCalls };
}

test("create OpenAI-compatible provider stores no secret on the config port", async () => {
  const { manager, providers, keys, visibilityState, discoverCalls } = fakePorts();
  const created = await manager.createCustom({
    name: "Company gateway",
    baseURL: "https://ai.example/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-live-secret",
  }, models);
  assert.equal(created.id, "company-gateway");
  assert.equal(providers["company-gateway"]?.baseURL, "https://ai.example/v1");
  assert.deepEqual(JSON.stringify(providers["company-gateway"] ?? {}).includes("sk-live-secret"), false);
  assert.deepEqual(keys, ["company-gateway:sk-live-secret"]);
  assert.equal(visibilityState.addedProviders[0]?.origin, "custom");
  assert.equal(visibilityState.addedProviders[0]?.hasStoredCredential, true);
  assert.deepEqual(discoverCalls, [{ baseURL: "https://ai.example/v1", apiKey: "sk-live-secret" }]);
});

test("two custom instances can share the openai-compatible protocol", async () => {
  const { manager, providers } = fakePorts();
  await manager.createCustom({
    name: "LM Studio",
    baseURL: "http://127.0.0.1:1234/v1",
    protocol: "openai-compatible",
    authMode: "none",
  }, models);
  await manager.createCustom({
    name: "vLLM lab",
    baseURL: "http://10.0.0.8:8000/v1",
    protocol: "openai-compatible",
    authMode: "none",
  }, models);
  assert.deepEqual(Object.keys(providers).sort(), ["lm-studio", "vllm-lab"]);
});

test("duplicate id is rejected", async () => {
  const { manager } = fakePorts();
  await manager.createCustom({
    id: "staging-ai",
    name: "Staging",
    baseURL: "https://staging.example/v1",
    protocol: "openai-compatible",
    authMode: "none",
  }, models);
  await assert.rejects(
    () => manager.createCustom({
      id: "staging-ai",
      name: "Staging 2",
      baseURL: "https://staging.example/v1",
      protocol: "openai-compatible",
      authMode: "none",
    }, models),
    (e: Error & { code?: string }) => e.code === "conflict",
  );
});

test("update, disable-via-visibility, and remove of a Polyth-owned instance", async () => {
  const { manager, providers, keys } = fakePorts();
  await manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "none",
  }, models);
  await manager.updateCustom("lab", {
    name: "Lab 2",
    baseURL: "http://127.0.0.1:10/v1",
    protocol: "openai-compatible",
    authMode: "none",
  });
  assert.equal(providers.lab?.name, "Lab 2");
  await manager.addManualModel("lab", { id: "local-model", name: "Local" });
  assert.ok(providers.lab?.modelIDs.includes("local-model"));
  await manager.removeManaged("lab", { deleteCredentials: true });
  assert.equal(providers.lab, undefined);
  assert.ok(keys.includes("removed:lab"));
});

test("failed auth write does not leave a created provider", async () => {
  const { manager, providers, visibilityState } = fakePorts({ failAuth: true });
  await assert.rejects(
    () => manager.createCustom({
      name: "Broken",
      baseURL: "https://ai.example/v1",
      protocol: "openai-compatible",
      authMode: "api-key",
      apiKey: "sk-live-secret",
    }, models),
    (e: Error) => !e.message.includes("sk-live-secret"),
  );
  assert.equal(providers.broken, undefined);
  assert.equal(visibilityState.addedProviders.length, 0);
});

test("failed config write after credential performs compensating auth cleanup", async () => {
  const { manager, providers, keys, visibilityState } = fakePorts({ failConfig: true });
  await assert.rejects(() => manager.createCustom({
    name: "Broken",
    baseURL: "https://ai.example/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-live-secret",
  }, models));
  assert.equal(providers.broken, undefined);
  assert.ok(keys.includes("broken:sk-live-secret"));
  assert.ok(keys.includes("removed:broken"));
  assert.equal(visibilityState.addedProviders.length, 0);
});

test("api-key to none deletes the stored credential; empty key on edit preserves it", async () => {
  const { manager, keys, visibilityState } = fakePorts();
  await manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-one",
  }, models);
  await manager.updateCustom("lab", {
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
  });
  assert.deepEqual(keys.filter((k) => k.startsWith("lab:")), ["lab:sk-one"]);
  await manager.updateCustom("lab", {
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "none",
  });
  assert.ok(keys.includes("removed:lab"));
  assert.equal(visibilityState.addedProviders[0]?.hasStoredCredential, undefined);
});

test("none to api-key requires a key", async () => {
  const { manager } = fakePorts();
  await manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "none",
  }, models);
  await assert.rejects(
    () => manager.updateCustom("lab", {
      name: "Lab",
      baseURL: "http://127.0.0.1:9/v1",
      protocol: "openai-compatible",
      authMode: "api-key",
    }),
    (e: Error & { code?: string }) => e.code === "invalid-input",
  );
});

test("none to api-key stores the credential before reporting ready", async () => {
  const { manager, keys, visibilityState } = fakePorts();
  await manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "none",
  }, models);
  await manager.updateCustom("lab", {
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-two",
  });
  assert.ok(keys.includes("lab:sk-two"));
  assert.equal(visibilityState.addedProviders[0]?.authMode, "api-key");
  assert.equal(visibilityState.addedProviders[0]?.hasStoredCredential, true);
});

test("failed none-to-api-key credential write does not mark the provider ready", async () => {
  const { manager, visibilityState } = fakePorts({ failAuth: true });
  await manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "none",
  }, models);
  await assert.rejects(() => manager.updateCustom("lab", {
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-live-secret",
  }), (e: Error) => !e.message.includes("sk-live-secret"));
  assert.equal(visibilityState.addedProviders[0]?.authMode, "none");
  assert.equal(visibilityState.addedProviders[0]?.hasStoredCredential, undefined);
});

test("removing a built-in from the managed list does not delete credentials or config", async () => {
  const { manager, providers, keys, visibilityState } = fakePorts();
  visibilityState.addedProviders = [{ id: "openai", origin: "builtin" }];
  providers.openai = {
    id: "openai",
    name: "OpenAI",
    owned: false,
    headerNames: [],
    modelIDs: [],
  };
  await manager.removeManaged("openai", { deleteCredentials: true });
  assert.ok(providers.openai, "built-in config stanza remains");
  assert.equal(keys.includes("removed:openai"), false);
  assert.equal(visibilityState.addedProviders.length, 0);
});

test("externally-configured providers cannot be edited", async () => {
  const { manager, visibilityState, providers } = fakePorts();
  visibilityState.addedProviders = [{ id: "company-gateway", origin: "externally-configured" }];
  providers["company-gateway"] = {
    id: "company-gateway",
    name: "Gateway",
    owned: false,
    baseURL: "https://ai.example/v1",
    headerNames: [],
    modelIDs: [],
  };
  await assert.rejects(
    () => manager.updateCustom("company-gateway", {
      name: "Gateway",
      baseURL: "https://ai.example/v1",
      protocol: "openai-compatible",
      authMode: "none",
    }),
    (e: Error & { code?: string }) => e.code === "conflict",
  );
});

test("create discovers models with the in-memory API key and still succeeds if discovery fails", async () => {
  const imported = fakePorts({
    discover: async () => ({ ok: true, models: [{ id: "gpt-lab", name: "GPT Lab" }] }),
  });
  const created = await imported.manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-live-secret",
  }, models);
  assert.equal(created.discovered, 1);
  assert.ok(imported.providers.lab?.modelIDs.includes("gpt-lab"));
  assert.deepEqual(imported.discoverCalls, [{ baseURL: "http://127.0.0.1:9/v1", apiKey: "sk-live-secret" }]);

  const rejected = fakePorts({
    discover: async () => ({ ok: false, code: "auth-rejected", message: "401" }),
  });
  const stillCreated = await rejected.manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-live-secret",
  }, models);
  assert.equal(stillCreated.id, "lab");
  assert.equal(stillCreated.discovered, undefined);
  assert.deepEqual(rejected.providers.lab?.modelIDs, []);
  assert.equal(rejected.visibilityState.addedProviders[0]?.origin, "custom");
});

test("rediscovery of an API-key provider without a re-entered key does not probe", async () => {
  const { manager, discoverCalls } = fakePorts();
  await manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-one",
  }, models);
  const afterCreate = discoverCalls.length;
  await assert.rejects(
    () => manager.discover("lab"),
    (e: Error & { code?: string }) => e.code === "invalid-input" && /re-enter the API key/i.test(e.message),
  );
  assert.equal(discoverCalls.length, afterCreate);
  const result = await manager.discover("lab", { apiKey: "sk-one" });
  assert.deepEqual(result.models, []);
  assert.equal(discoverCalls.at(-1)?.apiKey, "sk-one");
});

test("failed config or visibility on update does not mutate the stored credential", async () => {
  const configFail = fakePorts();
  await configFail.manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-one",
  }, models);
  configFail.fail.config = true;
  await assert.rejects(() => configFail.manager.updateCustom("lab", {
    name: "Lab 2",
    baseURL: "http://127.0.0.1:10/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-two",
  }));
  assert.equal(configFail.providers.lab?.name, "Lab");
  assert.equal(configFail.providers.lab?.baseURL, "http://127.0.0.1:9/v1");
  assert.deepEqual(configFail.keys.filter((k) => k.startsWith("lab:")), ["lab:sk-one"]);

  const visibilityFail = fakePorts();
  await visibilityFail.manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-one",
  }, models);
  visibilityFail.fail.visibility = true;
  await assert.rejects(() => visibilityFail.manager.updateCustom("lab", {
    name: "Lab 2",
    baseURL: "http://127.0.0.1:10/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-two",
  }));
  assert.equal(visibilityFail.providers.lab?.name, "Lab");
  assert.equal(visibilityFail.visibilityState.addedProviders[0]?.name, "Lab");
  assert.deepEqual(visibilityFail.keys.filter((k) => k.startsWith("lab:")), ["lab:sk-one"]);
});

test("failed auth on update rolls back staged config and Polyth metadata", async () => {
  const { manager, providers, keys, visibilityState, fail } = fakePorts();
  await manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "none",
  }, models);
  fail.auth = true;
  await assert.rejects(() => manager.updateCustom("lab", {
    name: "Lab 2",
    baseURL: "http://127.0.0.1:10/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-live-secret",
  }), (e: Error) => !e.message.includes("sk-live-secret"));
  assert.equal(providers.lab?.name, "Lab");
  assert.equal(providers.lab?.baseURL, "http://127.0.0.1:9/v1");
  assert.equal(providers.lab?.authMode, "none");
  assert.equal(visibilityState.addedProviders[0]?.authMode, "none");
  assert.equal(visibilityState.addedProviders[0]?.hasStoredCredential, undefined);
  assert.equal(keys.includes("lab:sk-live-secret"), false);
});

test("slug colliding with a built-in catalogue id allocates a unique custom id", async () => {
  const { manager, providers } = fakePorts();
  const created = await manager.createCustom({
    name: "Cursor",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "none",
  }, models, ["cursor"]);
  assert.equal(created.id, "cursor-2");
  assert.ok(providers["cursor-2"]);
});

test("explicit custom id that collides with a built-in catalogue id is rejected", async () => {
  const { manager } = fakePorts();
  await assert.rejects(
    () => manager.createCustom({
      id: "cursor",
      name: "Cursor",
      baseURL: "http://127.0.0.1:9/v1",
      protocol: "openai-compatible",
      authMode: "none",
    }, models, ["cursor"]),
    (e: Error & { code?: string }) => e.code === "conflict",
  );
});

test("credential delete failure rolls back custom provider removal", async () => {
  const { manager, providers, visibilityState, fail } = fakePorts();
  await manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "api-key",
    apiKey: "sk-one",
  }, models);
  fail.authRemove = true;
  await assert.rejects(
    () => manager.removeManaged("lab", { deleteCredentials: true }),
    (e: Error & { code?: string }) => e.code === "unavailable",
  );
  assert.ok(providers.lab, "config stanza restored");
  assert.equal(visibilityState.addedProviders[0]?.id, "lab");
  fail.authRemove = false;
  await manager.removeManaged("lab", { deleteCredentials: true });
  assert.equal(providers.lab, undefined);
  assert.equal(visibilityState.addedProviders.length, 0);
});

test("config staging failure leaves a custom provider in place", async () => {
  const { manager, providers, visibilityState, fail } = fakePorts();
  await manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "none",
  }, models);
  fail.config = true;
  await assert.rejects(() => manager.removeManaged("lab", { deleteCredentials: true }));
  assert.ok(providers.lab);
  assert.equal(visibilityState.addedProviders[0]?.id, "lab");
});

test("visibility persist failure during remove restores config", async () => {
  const { manager, providers, visibilityState, fail } = fakePorts();
  await manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "none",
  }, models);
  fail.visibility = true;
  await assert.rejects(() => manager.removeManaged("lab", { deleteCredentials: true }));
  assert.ok(providers.lab);
  assert.equal(visibilityState.addedProviders[0]?.id, "lab");
});

test("removing an owned custom model drops only that model", async () => {
  const { manager, providers, visibilityState } = fakePorts();
  await manager.createCustom({
    name: "Lab",
    baseURL: "http://127.0.0.1:9/v1",
    protocol: "openai-compatible",
    authMode: "none",
  }, models);
  await manager.addManualModel("lab", { id: "keep-me" });
  await manager.addManualModel("lab", { id: "wrong-model" });
  visibilityState.disabledModels = ["lab/wrong-model", "lab/keep-me"];
  await manager.removeConfiguredModel("lab", "wrong-model");
  assert.deepEqual(providers.lab?.modelIDs, ["keep-me"]);
  assert.deepEqual(visibilityState.disabledModels, ["lab/keep-me"]);
});

test("externally-configured providers cannot drop models or config", async () => {
  const { manager, providers, visibilityState, keys } = fakePorts();
  visibilityState.addedProviders = [{ id: "company-gateway", origin: "externally-configured" }];
  providers["company-gateway"] = {
    id: "company-gateway",
    name: "Gateway",
    owned: false,
    headerNames: [],
    modelIDs: ["kept"],
  };
  await assert.rejects(
    () => manager.removeConfiguredModel("company-gateway", "kept"),
    (e: Error & { code?: string }) => e.code === "conflict",
  );
  await manager.removeManaged("company-gateway", { deleteCredentials: true });
  assert.ok(providers["company-gateway"]);
  assert.equal(keys.includes("removed:company-gateway"), false);
});

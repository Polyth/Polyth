// P1 config preservation (Agent H), server side: boot-time discovery of
// existing OpenCode configuration is READ-ONLY (an empty Polyth MCP store
// never calls applyMcp and never rewrites opencode.json), managed MCP edits
// patch only owned names/fields through the OpenCode provisioner, and a
// read-only RuntimeConfigAuthority makes the projector fail without rolling
// canonical MCP state back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigApplier, createOpenCodeProvisioner, peekOpenCodeLaunchOverlay } from "@polyth/backend-opencode";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { createMcpConfigService, mcpEntriesFromBackendConfig } from "../src/mcp.ts";
import { createBehaviorService } from "../src/behavior.ts";
import { createModelVisibilityService } from "../src/modelVisibility.ts";
import { createCapabilityProvisioningController } from "../src/capabilityProvisioning.ts";
import type { AgentRuntime, HarnessProvider, SpaceContext } from "@polyth/contracts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-cfg-srv-"));

const PROVIDER_FIXTURE = {
  custom: {
    npm: "future-provider",
    futureTopLevelField: { doNotTouch: true },
    models: {
      "model-x": {
        name: "Model X",
        reasoning: true,
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        limit: { context: 1050000, input: 922000, output: 128000 },
        variants: { low: { reasoningEffort: "low" }, max: { reasoningEffort: "max" } },
        unknownFutureField: { keep: "me" },
      },
    },
  },
} as const;

const backendDocument = (): Record<string, unknown> => structuredClone({
  $schema: "https://opencode.ai/config.json",
  theme: "dark",
  disabled_providers: ["azure"],
  provider: PROVIDER_FIXTURE,
  mcp: {
    ctx: {
      type: "local",
      command: ["ctx", "--stdio"],
      enabled: true,
      environment: { KEY: "secret-env-value" },
      timeout: 30,
      futureMcpField: { keep: "me" },
    },
    web: {
      type: "remote",
      url: "https://x.example/mcp",
      enabled: false,
      headers: { Authorization: "Bearer secret-token" },
      notes: "disabled but present",
    },
    "sse-thing": { type: "sse", url: "https://sse.example", futureShape: { v: 2 } },
  },
  plugin: ["keep-plugin"],
});

const contextOf = (space: SpaceContext, cwd: string) => ({
  spaceId: space.spaceId,
  projectId: "p",
  cwd,
  space,
});

interface Harness {
  configFile: string;
  projectConfig: string;
  originalBytes: string;
  applier: ReturnType<typeof createConfigApplier>;
  applyMcpCalls: number;
  mcp: ReturnType<typeof createMcpConfigService>;
  space: SpaceContext;
  project: () => Promise<void>;
}

const bootSeed = async (authority?: { kind: "read-only" } | { kind: "writable"; targetId: string }): Promise<Harness> => {
  const configDir = tmp();
  const dataDir = tmp();
  const projectDir = tmp();
  const space: SpaceContext = {
    spaceId: "space",
    spaceSlug: "space",
    userId: "usr",
    role: "owner",
    deployment: "local-trusted",
    storageDir: dataDir,
  };
  const configFile = join(configDir, "opencode.json");
  writeFileSync(configFile, `${JSON.stringify(backendDocument(), null, 2)}\n`);
  const originalBytes = readFileSync(configFile, "utf8");

  const applier = createConfigApplier({ configDir, ...(authority ? { authority } : {}) });
  const harness: Harness = {
    configFile,
    projectConfig: join(projectDir, ".opencode", "opencode.json"),
    originalBytes,
    applier,
    applyMcpCalls: 0,
    mcp: undefined as never,
    space,
    project: async () => {},
  };
  const counting = {
    ...applier,
    applyMcp: (entries: Parameters<typeof applier.applyMcp>[0]) => {
      harness.applyMcpCalls += 1;
      return applier.applyMcp(entries);
    },
  };

  const visibility = createModelVisibilityService({
    file: join(dataDir, "model-visibility.json"),
    applier: { readConfig: () => counting.readConfig(), applyProviderVisibility: (v) => applier.applyProviderVisibility(v) },
  });
  await visibility.seed();

  const mcp = createMcpConfigService({ dataDir, deployment: "local-trusted", defaultSpaceId: space.spaceId });
  assert.equal(mcp.list(space).length, 0, "store starts empty");
  for (const entry of mcpEntriesFromBackendConfig(await counting.readConfig())) {
    await mcp.create(space, entry);
  }
  const behavior = createBehaviorService({ file: join(dataDir, "behavior.md") });
  const provider: HarnessProvider = {
    descriptor: { id: "opencode", name: "OpenCode", priority: 0, integration: "test" },
    probe: async () => ({ harnessId: "opencode", installed: true, authenticated: true, healthy: true }),
    createRuntime: async () => ({ dispose: async () => {} }) as AgentRuntime,
    provisioner: createOpenCodeProvisioner(counting),
  };
  const controller = createCapabilityProvisioningController({
    contributions: createCapabilityContributionRegistry(),
    harnesses: {
      register: () => ({ dispose() {} }),
      providers: () => [provider],
      probe: async () => [],
      resolve: async () => provider,
    },
    behavior,
    mcp,
    file: join(dataDir, "capability-status.json"),
  });
  harness.mcp = mcp;
  harness.project = async () => {
    await controller.reconcile(provider, contextOf(space, projectDir));
  };
  return harness;
};

test("empty-store discovery performs zero backend writes and zero applyMcp calls", async () => {
  const h = await bootSeed();
  assert.equal(h.applyMcpCalls, 0, "discovery never calls applyMcp");
  assert.equal(readFileSync(h.configFile, "utf8"), h.originalBytes, "opencode.json bytes preserved");
  assert.deepEqual(
    h.mcp.list(h.space).map((s) => `${s.name}:${s.enabled}`).sort(),
    ["ctx:true", "web:false"],
    "supported entries adopted, unsupported ones left alone",
  );
  const serialized = JSON.stringify(h.mcp.list(h.space));
  assert.doesNotMatch(serialized, /secret-env-value|secret-token/);
});

test("managed MCP edits preserve unsupported entries and unknown fields", async () => {
  const h = await bootSeed();
  const ctx = h.mcp.list(h.space).find((s) => s.name === "ctx")!;
  await h.mcp.update(h.space, ctx.id, {
    transport: { kind: "stdio", command: "ctx", args: ["--stdio", "--v2"], envKeys: ["KEY"] },
  }, ctx.revision);
  await h.project();
  assert.equal(h.applyMcpCalls, 0, "Space MCP is not written through the persistent applier");

  const global = JSON.parse(readFileSync(h.configFile, "utf8")) as Record<string, unknown>;
  const globalMcp = global.mcp as Record<string, Record<string, unknown>>;
  assert.equal("ctx" in globalMcp, true, "user global MCP is left in place");
  assert.deepEqual(globalMcp["sse-thing"], { type: "sse", url: "https://sse.example", futureShape: { v: 2 } });
  assert.deepEqual(global.provider, structuredClone(PROVIDER_FIXTURE));
  assert.deepEqual(global.disabled_providers, ["azure"]);
  assert.deepEqual(global.plugin, ["keep-plugin"]);
  assert.equal(global.theme, "dark");
  assert.equal(existsSync(h.projectConfig), false, "project OpenCode config is never created");

  const overlay = peekOpenCodeLaunchOverlay({
    cwd: h.projectConfig.replace(/\/\.opencode\/opencode\.json$/, ""),
    spaceId: h.space.spaceId,
    projectId: "p",
  });
  assert.ok(overlay);
  assert.match(overlay.configContent, /"ctx"/);
  assert.doesNotMatch(overlay.configContent, /secret-env-value|secret-token/);

  const web = h.mcp.list(h.space).find((s) => s.name === "web")!;
  await h.mcp.update(h.space, web.id, { enabled: true }, web.revision);
  await h.project();
  const after = peekOpenCodeLaunchOverlay({
    cwd: h.projectConfig.replace(/\/\.opencode\/opencode\.json$/, ""),
    spaceId: h.space.spaceId,
    projectId: "p",
  });
  assert.match(after!.configContent, /"web"/);
});

test("removing a managed entry does not delete user OpenCode config by name", async () => {
  const h = await bootSeed();
  const ctx = h.mcp.list(h.space).find((s) => s.name === "ctx")!;
  assert.equal(await h.mcp.remove(h.space, ctx.id), true);
  await h.project();

  const globalMcp = (JSON.parse(readFileSync(h.configFile, "utf8")) as Record<string, unknown>)
    .mcp as Record<string, Record<string, unknown>>;
  assert.equal("ctx" in globalMcp, true, "user global MCP remains; tombstones omit shadow entries from the private overlay");
  assert.deepEqual(globalMcp["sse-thing"], { type: "sse", url: "https://sse.example", futureShape: { v: 2 } });
  assert.equal(existsSync(h.projectConfig), false);
  const overlay = peekOpenCodeLaunchOverlay({
    cwd: h.projectConfig.replace(/\/\.opencode\/opencode\.json$/, ""),
    spaceId: h.space.spaceId,
    projectId: "p",
  });
  assert.ok(overlay, "empty overlay still admits the current desired bundle");
  assert.deepEqual(overlay.capabilityIds, []);
  assert.equal(overlay.configContent, "");
});

test("model-visibility seed is read-only and toggles preserve provider metadata", async () => {
  const configDir = tmp();
  const dataDir = tmp();
  const configFile = join(configDir, "opencode.json");
  writeFileSync(configFile, `${JSON.stringify(backendDocument(), null, 2)}\n`);
  const originalBytes = readFileSync(configFile, "utf8");
  const applier = createConfigApplier({ configDir });

  const visibility = createModelVisibilityService({
    file: join(dataDir, "model-visibility.json"),
    applier: { readConfig: () => applier.readConfig(), applyProviderVisibility: (v) => applier.applyProviderVisibility(v) },
  });
  await visibility.seed();
  assert.equal(readFileSync(configFile, "utf8"), originalBytes, "seed never writes the backend config");
  assert.deepEqual(visibility.state().disabledProviders, ["azure"], "seed adopted existing curation");

  await visibility.setModelEnabled("custom/model-x", false);
  const cfg = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  const custom = (cfg.provider as Record<string, Record<string, unknown>>).custom!;
  assert.deepEqual(custom.blacklist, ["model-x"]);
  const unowned = { ...custom };
  delete unowned.blacklist;
  assert.deepEqual(unowned, structuredClone(PROVIDER_FIXTURE.custom), "fixture metadata untouched by the toggle");
});

test("read-only config authority refuses writes; canonical MCP is kept", async () => {
  const h = await bootSeed({ kind: "read-only" });
  assert.equal(h.mcp.list(h.space).length, 2, "read-only discovery still adopts entries");
  assert.equal(readFileSync(h.configFile, "utf8"), h.originalBytes);

  const ctx = h.mcp.list(h.space).find((s) => s.name === "ctx")!;
  await h.mcp.update(h.space, ctx.id, { enabled: false }, ctx.revision);
  assert.equal(h.mcp.list(h.space).find((s) => s.name === "ctx")!.enabled, false, "canonical desired state is kept");
  await h.project();
  assert.equal(readFileSync(h.configFile, "utf8"), h.originalBytes, "backend config untouched");
});

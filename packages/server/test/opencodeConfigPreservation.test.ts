// P1 config preservation (Agent H), server side: boot-time discovery of
// existing OpenCode configuration is READ-ONLY (an empty Polyth MCP store
// never calls applyMcp and never rewrites opencode.json), managed MCP edits
// patch only owned names/fields, and a read-only RuntimeConfigAuthority makes
// every store mutation fail closed with a clean rollback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigApplier } from "@polyth/backend-opencode";
import { createMcpConfigService, mcpEntriesFromBackendConfig, type McpApplier } from "../src/mcp.ts";
import { createModelVisibilityService } from "../src/modelVisibility.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-cfg-srv-"));

// Unknown-fields regression fixture (required): unrelated provider metadata
// that must survive every MCP/visibility operation the server performs.
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

interface Harness {
  configFile: string;
  originalBytes: string;
  applier: ReturnType<typeof createConfigApplier>;
  applyMcpCalls: number;
  mcp: ReturnType<typeof createMcpConfigService>;
}

/** Mirrors the boot flow in packages/server/src/index.ts: build the applier,
 * seed visibility, then adopt existing backend MCP entries into an empty
 * Polyth store via mcp.create. */
const bootSeed = async (): Promise<Harness> => {
  const configDir = tmp();
  const dataDir = tmp();
  const configFile = join(configDir, "opencode.json");
  writeFileSync(configFile, `${JSON.stringify(backendDocument(), null, 2)}\n`);
  const originalBytes = readFileSync(configFile, "utf8");

  const applier = createConfigApplier({ configDir });
  const harness: Harness = { configFile, originalBytes, applier, applyMcpCalls: 0, mcp: undefined as never };
  const countingApplier: McpApplier & { readConfig(): Promise<Record<string, unknown>> } = {
    applyMcp: (entries) => {
      harness.applyMcpCalls += 1;
      return applier.applyMcp(entries);
    },
    readConfig: () => applier.readConfig(),
  };

  const visibility = createModelVisibilityService({
    file: join(dataDir, "model-visibility.json"),
    applier: { readConfig: countingApplier.readConfig, applyProviderVisibility: (v) => applier.applyProviderVisibility(v) },
  });
  await visibility.seed();

  const mcp = createMcpConfigService({ file: join(dataDir, "mcp.json"), applier: countingApplier });
  assert.equal(mcp.list().length, 0, "store starts empty");
  for (const entry of mcpEntriesFromBackendConfig(await countingApplier.readConfig())) {
    await mcp.create(entry);
  }
  harness.mcp = mcp;
  return harness;
};

test("empty-store discovery performs zero backend writes and zero applyMcp calls", async () => {
  const h = await bootSeed();
  assert.equal(h.applyMcpCalls, 0, "discovery never calls applyMcp");
  assert.equal(readFileSync(h.configFile, "utf8"), h.originalBytes, "opencode.json bytes preserved");
  assert.deepEqual(
    h.mcp.list().map((s) => `${s.name}:${s.enabled}`).sort(),
    ["ctx:true", "web:false"],
    "supported entries adopted, unsupported ones left alone",
  );
  // Secrets from the imported config are stored write-only, never in a DTO
  // and never in the structure file.
  const serialized = JSON.stringify(h.mcp.list());
  assert.doesNotMatch(serialized, /secret-env-value|secret-token/);
});

test("managed MCP edits preserve unsupported entries and unknown fields", async () => {
  const h = await bootSeed();
  const ctx = h.mcp.list().find((s) => s.name === "ctx")!;
  await h.mcp.update(ctx.id, {
    transport: { kind: "stdio", command: "ctx", args: ["--stdio", "--v2"], envKeys: ["KEY"] },
  }, ctx.revision);
  assert.equal(h.applyMcpCalls, 1, "the user edit is the first backend apply");

  const cfg = JSON.parse(readFileSync(h.configFile, "utf8")) as Record<string, unknown>;
  const mcpBlock = cfg.mcp as Record<string, Record<string, unknown>>;
  // Edited entry: owned fields updated, unknown fields intact, secret restored
  // from the write-only store.
  const ctxApplied = mcpBlock.ctx!;
  assert.deepEqual(ctxApplied.command, ["ctx", "--stdio", "--v2"]);
  assert.equal(ctxApplied.timeout, 30);
  assert.deepEqual(ctxApplied.futureMcpField, { keep: "me" });
  assert.deepEqual(ctxApplied.environment, { KEY: "secret-env-value" });
  // Unsupported entry untouched.
  assert.deepEqual(mcpBlock["sse-thing"], { type: "sse", url: "https://sse.example", futureShape: { v: 2 } });
  // Disabled managed entry is absent from the applied config (F10)…
  assert.equal("web" in mcpBlock, false);
  // …and everything unowned elsewhere in the document survives verbatim.
  assert.deepEqual(cfg.provider, structuredClone(PROVIDER_FIXTURE));
  assert.deepEqual(cfg.disabled_providers, ["azure"]);
  assert.deepEqual(cfg.plugin, ["keep-plugin"]);
  assert.equal(cfg.theme, "dark");

  // Re-enabling restores the entry including its retained unknown fields.
  const web = h.mcp.list().find((s) => s.name === "web")!;
  await h.mcp.update(web.id, { enabled: true }, web.revision);
  const after = (JSON.parse(readFileSync(h.configFile, "utf8")) as Record<string, unknown>)
    .mcp as Record<string, Record<string, unknown>>;
  assert.deepEqual(after.web, {
    notes: "disabled but present",
    type: "remote",
    url: "https://x.example/mcp",
    enabled: true,
    headers: { Authorization: "Bearer secret-token" },
  });
});

test("removing a managed entry deletes only that entry from the backend config", async () => {
  const h = await bootSeed();
  const ctx = h.mcp.list().find((s) => s.name === "ctx")!;
  assert.equal(await h.mcp.remove(ctx.id), true);

  const mcpBlock = (JSON.parse(readFileSync(h.configFile, "utf8")) as Record<string, unknown>)
    .mcp as Record<string, Record<string, unknown>>;
  assert.equal("ctx" in mcpBlock, false, "removed managed entry gone");
  assert.deepEqual(mcpBlock["sse-thing"], { type: "sse", url: "https://sse.example", futureShape: { v: 2 } });
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

test("read-only config authority refuses writes; store mutations roll back cleanly", async () => {
  const configDir = tmp();
  const dataDir = tmp();
  const configFile = join(configDir, "opencode.json");
  writeFileSync(configFile, `${JSON.stringify(backendDocument(), null, 2)}\n`);
  const originalBytes = readFileSync(configFile, "utf8");

  // Seed with a read-only-authority applier: discovery must still succeed
  // because it never writes.
  const readOnly = createConfigApplier({ configDir, authority: { kind: "read-only" } });
  const mcp = createMcpConfigService({ file: join(dataDir, "mcp.json"), applier: readOnly });
  for (const entry of mcpEntriesFromBackendConfig(await readOnly.readConfig())) {
    await mcp.create(entry);
  }
  assert.equal(mcp.list().length, 2, "read-only discovery still adopts entries");
  assert.equal(readFileSync(configFile, "utf8"), originalBytes);

  // A user mutation must fail closed and roll the store back.
  const ctx = mcp.list().find((s) => s.name === "ctx")!;
  await assert.rejects(
    () => mcp.update(ctx.id, { enabled: false }, ctx.revision),
    /rolled back/,
  );
  assert.equal(mcp.list().find((s) => s.name === "ctx")!.enabled, true, "store state rolled back");
  assert.equal(readFileSync(configFile, "utf8"), originalBytes, "backend config untouched");

  // Visibility toggles fail closed the same way.
  const visibility = createModelVisibilityService({
    file: join(dataDir, "model-visibility.json"),
    applier: { readConfig: () => readOnly.readConfig(), applyProviderVisibility: (v) => readOnly.applyProviderVisibility(v) },
  });
  await visibility.seed();
  await assert.rejects(() => visibility.setProviderEnabled("custom", false), /rolled back/);
  assert.deepEqual(visibility.state().disabledProviders, ["azure"], "visibility state rolled back");
  assert.equal(readFileSync(configFile, "utf8"), originalBytes);
});

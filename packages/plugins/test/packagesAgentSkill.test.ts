import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ToolExecutionContext } from "@polyth/contracts";
import { createContext } from "@polyth/kernel";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import {
  bindPackageServices,
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackageHost,
} from "../src/serverPackage.ts";
import registerPlugins from "../src/serverEntry.ts";
import type { PluginRegistry } from "../src/managedRegistry.ts";
import { testSpaceStorage } from "./helpers.ts";

const SKILL_ID = "plugins.skill.polyth-packages";
const TOOL_ID = "plugins.packages";

const call = (spaceId = "spc_a"): ToolExecutionContext => ({
  sessionId: "ses_a",
  projectId: "project-a",
  cwd: "/tmp/project-a",
  spaceId,
});

function writePackage(dir: string, id: string, files: Record<string, string>): void {
  const root = join(dir, id);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}

const sandboxed = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  manifestVersion: 2,
  id,
  version: "1.0.0",
  engines: { polyth: ">=0.1.0" },
  display: { name: "Notes", description: "Test package." },
  runtime: { kind: "sandboxed", ui: { entry: "src/index.ts" } },
  contributes: { surfaces: [{ id: "main", title: "Notes" }] },
  capabilities: ["ui.render"],
  ...extra,
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "polyth-packages-skill-"));
  const trustedDir = join(dir, "trusted-plugins");
  mkdirSync(trustedDir, { recursive: true });
  const previous = process.env.POLYTH_TRUSTED_PLUGIN_DIR;
  delete process.env.POLYTH_TRUSTED_PLUGIN_DIR;
  const root = createContext("packages-skill-test");
  const raw = createServerServiceRegistry();
  const capabilities = createCapabilityContributionRegistry();
  raw.provide(serverServiceKey("plugins.config"), {});
  raw.provide(serverServiceKey("harness.capabilities"), capabilities);
  const storage = testSpaceStorage(join(dir, "space"));
  const host = {
    pluginId: "plugins", storageDir: dir, root,
    services: bindPackageServices(raw, "plugins"),
    managedPackageServices: (packageId: string) => bindPackageServices(raw, packageId),
    routes: { add: () => ({ dispose() {} }) }, broadcast: {},
    packageSpaces: () => [{ spaceId: "spc_a", storage }],
  } as unknown as ServerPackageHost;
  const manager = registerPlugins(host);
  await manager.onEnable?.();
  const registry = raw.require(serverServiceKey<PluginRegistry>("plugins.managed"));
  const tool = async (input: Record<string, unknown>) =>
    JSON.parse((await capabilities.executor(TOOL_ID)!(input as never, call())).output) as Record<string, unknown>;
  return {
    dir, trustedDir, capabilities, registry, storage, manager, tool,
    async dispose() {
      await manager.onDisable?.();
      await root.dispose();
      if (previous === undefined) delete process.env.POLYTH_TRUSTED_PLUGIN_DIR;
      else process.env.POLYTH_TRUSTED_PLUGIN_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("the package manager gives every installation the packages skill and tool, and removes them on disable", async () => {
  const f = await fixture();
  try {
    const skill = f.capabilities.contribution(SKILL_ID)?.descriptor;
    assert.ok(skill && skill.kind === "skill");
    assert.equal(skill.name, "polyth-packages");
    assert.equal(skill.owner, "plugins");
    assert.equal(skill.scope, "deployment");
    for (const needle of ["polyth_packages", "polyth-package.json", "polyth-plugin.json", "/?settings=packages&install=file:<id>", "context.effect"]) {
      assert.ok(skill.instructions.includes(needle), `skill mentions ${needle}`);
    }
    assert.doesNotMatch(skill.instructions, /\.agents\/skills\/polyth-packages\/package-structure|docs\/dev\//,
      "the product skill must not depend on repository files an installation lacks");

    const tool = f.capabilities.contribution(TOOL_ID)?.descriptor;
    assert.ok(tool && tool.kind === "tool");
    assert.equal(tool.name, "polyth_packages");
    assert.equal(tool.mutating, false);

    await f.manager.onDisable?.();
    assert.equal(f.capabilities.contribution(SKILL_ID), undefined);
    assert.equal(f.capabilities.contribution(TOOL_ID), undefined);
  } finally { await f.dispose(); }
});

test("info reports this installation's package folder, engine and install link", async () => {
  const f = await fixture();
  try {
    const info = await f.tool({ action: "info" });
    assert.equal(info.packageDir, f.trustedDir);
    assert.equal(info.packageDirExists, true);
    assert.equal(info.installLink, "/?settings=packages&install=file:<id>");
    assert.equal(info.engineVersion, "0.1.0");
    assert.equal(info.installsAvailable, true);
    assert.ok((info.uiSlots as string[]).includes("workspace.right.tabs"));
  } finally { await f.dispose(); }
});

test("check validates and builds a package folder exactly as install does, without installing it", async () => {
  const f = await fixture();
  try {
    writePackage(f.trustedDir, "notes", {
      "polyth-package.json": sandboxed("notes"),
      "src/index.ts": "import { connectPolyth } from \"@polyth/package-sdk\";\nconst polyth = await connectPolyth();\nawait polyth.ui.render({ type: \"text\", text: \"hi\" });\n",
    });
    const ok = await f.tool({ action: "check", id: "notes" });
    assert.equal(ok.ok, true, JSON.stringify(ok.problems));
    assert.equal(ok.installed, false);
    assert.equal(f.registry.has("notes"), false, "check never installs");

    writePackage(f.trustedDir, "broken", {
      "polyth-package.json": sandboxed("broken"),
      "src/index.ts": "import { nope } from \"./missing.ts\";\nnope(\n",
    });
    const broken = await f.tool({ action: "check", id: "broken" });
    assert.equal(broken.ok, false);
    assert.match((broken.problems as string[]).join("\n"), /sandbox build/);

    writePackage(f.trustedDir, "renamed", { "polyth-package.json": sandboxed("other"), "src/index.ts": "" });
    const renamed = await f.tool({ action: "check", id: "renamed" });
    assert.match((renamed.problems as string[]).join("\n"), /must equal the folder name/);

    const missing = await f.tool({ action: "check", id: "absent" });
    assert.equal(missing.ok, false);

    await assert.rejects(() => f.tool({ action: "check", id: "../escape" }), /package id/);
  } finally { await f.dispose(); }
});

test("a trusted server package written as the skill describes installs, registers its agent tool, and shows in list and logs", async () => {
  const f = await fixture();
  try {
    writePackage(f.trustedDir, "standup", {
      "polyth-plugin.json": JSON.stringify({
        id: "standup", name: "Standup", version: "1.0.0", trust: "privileged",
        entries: { server: "./server.mjs" },
      }),
      "server.mjs": `
        export default (host) => ({
          manifest: { id: host.pluginId, version: "1.0.0", trust: "privileged" },
          setup(context) {
            const capabilities = host.services.require({ id: "polyth.service.harness.capabilities", version: "1" });
            const tool = capabilities.register(host.pluginId, {
              descriptor: {
                id: host.pluginId + ".today", owner: host.pluginId, kind: "tool", scope: "deployment", revision: "1",
                name: "standup_today", description: "Return today's standup note.",
                inputSchema: { type: "object", additionalProperties: false, properties: {} },
                trust: "pure", mutating: false,
              },
              execute: async () => ({ output: "note" }),
            });
            context.effect(() => tool.dispose());
          },
        });
      `,
    });
    const checked = await f.tool({ action: "check", id: "standup" });
    assert.equal(checked.ok, true, JSON.stringify(checked.problems));

    await f.registry.install("file:standup");
    await f.registry.enable("standup", f.storage);
    assert.equal((await f.capabilities.executor("standup.today")!({}, call())).output, "note");

    const listed = await f.tool({ action: "list" });
    const row = (listed.packages as Array<Record<string, unknown>>).find((item) => item.id === "standup");
    assert.equal(row?.enabled, true);
    assert.equal(row?.status, "ready");

    f.registry.log("standup", "hello from standup");
    const logs = await f.tool({ action: "logs", id: "standup", limit: 5 });
    assert.ok((logs.lines as Array<{ line: string }>).some((entry) => entry.line.includes("hello from standup")));
    await assert.rejects(() => f.tool({ action: "logs", id: "absent" }), /not installed/);
  } finally { await f.dispose(); }
});

test("a server entry declared in polyth-package.json installs and runs like a polyth-plugin.json one", async () => {
  const f = await fixture();
  try {
    writePackage(f.trustedDir, "v2server", {
      "polyth-package.json": sandboxed("v2server", {
        runtime: { kind: "trusted-local", server: "server.mjs" },
        contributes: {},
        capabilities: [],
      }),
      "server.mjs": `
        export default (host) => ({
          manifest: { id: host.pluginId, version: "1.0.0", trust: "privileged" },
          setup(context) {
            const capabilities = host.services.require({ id: "polyth.service.harness.capabilities", version: "1" });
            const tool = capabilities.register(host.pluginId, {
              descriptor: {
                id: host.pluginId + ".ping", owner: host.pluginId, kind: "tool", scope: "deployment", revision: "1",
                name: "v2_ping", description: "Ping.", inputSchema: { type: "object", properties: {} },
                trust: "pure", mutating: false,
              },
              execute: async () => ({ output: "pong" }),
            });
            context.effect(() => tool.dispose());
          },
        });
      `,
    });
    const checked = await f.tool({ action: "check", id: "v2server" });
    assert.equal(checked.ok, true, JSON.stringify(checked.problems));
    assert.equal(checked.runtimeKind, "trusted-local");

    await f.registry.install("file:v2server");
    const enabled = await f.registry.enable("v2server", f.storage);
    assert.equal(enabled.status, "ready", enabled.lastError);
    assert.equal((await f.capabilities.executor("v2server.ping")!({}, call())).output, "pong");
    await f.registry.disable("v2server", f.storage);
    assert.equal(f.capabilities.executor("v2server.ping"), undefined, "disable disposes the entry");
  } finally { await f.dispose(); }
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type {
  CapabilitySecretResolver,
  HarnessContext,
  HarnessProvisioningPlan,
  JsonObject,
} from "@polyth/contracts";
import {
  setCapabilityLaunchSink,
  setCapabilityReceiptSink,
  type CapabilityLaunchCapture,
} from "@polyth/harness-runtime";
import {
  ANTIGRAVITY_CAPABILITIES,
  antigravityOverlays,
  createAntigravityProvisioner,
  isBrowserTool,
} from "../src/index.ts";
import {
  classifyAgyPermission,
  createAntigravityPermissionBridge,
  parseAgyHookRequest,
} from "../src/permissions.ts";
import { createAntigravityRuntime } from "../src/runtime.ts";
import { materializeAntigravityHome } from "../src/home.ts";
import registerPackage from "../src/serverEntry.ts";

const contextOf = (spaceId = "space-a", sessionId = "session-a"): HarnessContext => ({
  spaceId,
  projectId: "project-a",
  cwd: "/work",
  sessionId,
  space: {
    spaceId,
    spaceSlug: "test",
    userId: "usr_test",
    role: "owner",
    deployment: "local-trusted",
    storageDir: "/tmp/space-storage",
  },
});

test("antigravity capability support declares config mcp-server and mcp tools", () => {
  const provisioner = createAntigravityProvisioner();
  const support = provisioner.support(contextOf());
  assert.equal(support.harnessId, "antigravity");
  assert.equal(support.targetLifetime, "session");
  assert.deepEqual(support.kinds["mcp-server"], {
    modes: ["config"],
    mutability: "session-create",
    remote: false,
    configScope: "session",
  });
  assert.deepEqual(support.kinds["tool"], {
    modes: ["mcp"],
    mutability: "session-create",
    remote: false,
    configScope: "session",
  });
  assert.deepEqual(support.kinds["instruction"], {
    modes: ["prompt"],
    mutability: "immediate",
    configScope: "session",
  });
  assert.deepEqual(support.kinds["context"], {
    modes: ["prompt"],
    mutability: "immediate",
    remote: false,
    configScope: "session",
  });
  assert.deepEqual(support.kinds["skill"], {
    modes: ["unsupported"],
    mutability: "immutable",
  });
  assert.deepEqual(support.kinds["extension"], {
    modes: ["unsupported"],
    mutability: "immutable",
  });
  assert.equal(ANTIGRAVITY_CAPABILITIES.mcp, true);
});

test("provisioner rejects remote execution", async () => {
  const provisioner = createAntigravityProvisioner();
  const context = { ...contextOf(), remote: true };
  const plan: HarnessProvisioningPlan = {
    desiredRevision: "rev-1",
    items: [
      {
        capability: {
          id: "polyth.agent-tools",
          kind: "mcp-server",
          owner: "polyth",
          scope: "session",
          revision: "1",
          name: "polyth-agent-tools",
          enabled: true,
          transport: { kind: "stdio", command: "node", args: ["tools.mjs"], envKeys: [] },
        },
        mode: "config",
        mutability: "session-create",
      },
    ],
  };
  const secrets: CapabilitySecretResolver = { mcpSecrets: () => ({}) };
  const outcome = await provisioner.apply(context, plan, secrets);
  assert.equal(outcome.records.length, 1);
  assert.equal(outcome.records[0]!.status, "unsupported");
});

test("provisioner stages stdio polyth-agent-tools and tools into launch overlay", async () => {
  const provisioner = createAntigravityProvisioner();
  const context = contextOf();
  const plan: HarnessProvisioningPlan = {
    desiredRevision: "rev-10",
    items: [
      {
        capability: {
          id: "browser.polyth-browser",
          kind: "tool",
          owner: "browser",
          scope: "project",
          revision: "2",
          name: "polyth_browser",
          description: "Open and inspect pages",
          inputSchema: { type: "object", properties: { action: { type: "string" } } },
          trust: "device",
          mutating: true,
        },
        mode: "mcp",
        mutability: "session-create",
      },
      {
        capability: {
          id: "polyth.agent-tools",
          kind: "mcp-server",
          owner: "polyth",
          scope: "session",
          revision: "rev-bundle",
          name: "polyth-agent-tools",
          enabled: true,
          transport: {
            kind: "stdio",
            command: "/usr/bin/node",
            args: ["/opt/polyth/agentToolsMcp.mjs"],
            envKeys: ["POLYTH_AGENT_TOOLS_URL", "POLYTH_AGENT_TOOLS_TOKEN"],
          },
        },
        mode: "config",
        mutability: "session-create",
      },
    ],
  };
  const secrets: CapabilitySecretResolver = {
    mcpSecrets: (id) => id === "polyth.agent-tools"
      ? {
        POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:4400/internal/agent-tools",
        POLYTH_AGENT_TOOLS_TOKEN: "tok_secret_123",
      }
      : {},
  };
  const result = await provisioner.apply(context, plan, secrets);
  assert.equal(result.desiredRevision, "rev-10");
  assert.equal(result.records.length, 2);
  assert.ok(result.records.every((r) => r.status === "pending"));

  const staged = antigravityOverlays.peek(context, "antigravity");
  assert.ok(staged);
  assert.equal(staged.desiredRevision, "rev-10");
  assert.deepEqual(staged.value.mcpServers, {
    "polyth-agent-tools": {
      command: "/usr/bin/node",
      args: ["/opt/polyth/agentToolsMcp.mjs"],
      env: {
        POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:4400/internal/agent-tools",
        POLYTH_AGENT_TOOLS_TOKEN: "tok_secret_123",
      },
      disabled: false,
    },
  });

  provisioner.release(context);
  assert.equal(antigravityOverlays.peek(context, "antigravity"), undefined);
});

test("provisioner handles http mcp servers and retired mcp servers", async () => {
  const provisioner = createAntigravityProvisioner();
  const context = contextOf();
  const plan: HarnessProvisioningPlan = {
    desiredRevision: "rev-20",
    items: [
      {
        capability: {
          id: "polyth.mcp.remote",
          kind: "mcp-server",
          owner: "custom",
          scope: "project",
          revision: "1",
          name: "remote-docs",
          enabled: true,
          transport: {
            kind: "http",
            url: "https://docs.example.com/mcp",
            headersSecretRefs: ["AUTH_HEADER"],
          },
        },
        mode: "config",
        mutability: "session-create",
      },
      {
        capability: {
          id: "polyth.mcp.disabled",
          kind: "mcp-server",
          owner: "custom",
          scope: "project",
          revision: "1",
          name: "old-server",
          enabled: false,
          transport: {
            kind: "stdio",
            command: "echo",
            args: [],
            envKeys: [],
          },
        },
        mode: "config",
        mutability: "session-create",
      },
    ],
  };
  const secrets: CapabilitySecretResolver = {
    mcpSecrets: (id) => id === "polyth.mcp.remote" ? { AUTH_HEADER: "Bearer token" } : {},
  };
  const result = await provisioner.apply(context, plan, secrets);
  const retired = result.records.find((r) => r.capabilityId === "polyth.mcp.disabled");
  assert.equal(retired?.status, "applied");

  const remote = result.records.find((r) => r.capabilityId === "polyth.mcp.remote");
  assert.equal(remote?.status, "pending");

  const staged = antigravityOverlays.peek(context, "antigravity");
  assert.ok(staged);
  assert.deepEqual(staged.value.mcpServers, {
    "remote-docs": {
      serverUrl: "https://docs.example.com/mcp",
      headers: { AUTH_HEADER: "Bearer token" },
      disabled: false,
    },
  });
  provisioner.release(context);
});

test("provisioner detects mcp name collisions", async () => {
  const provisioner = createAntigravityProvisioner();
  const context = contextOf();
  const plan: HarnessProvisioningPlan = {
    desiredRevision: "rev-dup",
    items: [
      {
        capability: {
          id: "polyth.mcp.first",
          kind: "mcp-server",
          owner: "a",
          scope: "project",
          revision: "1",
          name: "duplicate-name",
          enabled: true,
          transport: { kind: "stdio", command: "cat", args: [], envKeys: [] },
        },
        mode: "config",
        mutability: "session-create",
      },
      {
        capability: {
          id: "polyth.mcp.second",
          kind: "mcp-server",
          owner: "b",
          scope: "project",
          revision: "1",
          name: "duplicate-name",
          enabled: true,
          transport: { kind: "stdio", command: "dog", args: [], envKeys: [] },
        },
        mode: "config",
        mutability: "session-create",
      },
    ],
  };
  const result = await provisioner.apply(context, plan, { mcpSecrets: () => ({}) });
  assert.ok(result.records.every((r) => r.status === "failed"));
  provisioner.release(context);
});

test("permission bridge materializes the private Antigravity home and MCP config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-agy-bridge-"));
  const realHome = await mkdtemp(join(tmpdir(), "polyth-agy-realhome-"));
  const homeRoot = join(root, "agy-home");
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(realHome, { recursive: true, force: true }),
  ]));

  // A real home with app data, a config entry, a user MCP server and a dotfile.
  await mkdir(join(realHome, ".gemini", "antigravity-cli"), { recursive: true });
  await mkdir(join(realHome, ".gemini", "config"), { recursive: true });
  await writeFile(join(realHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "token");
  await writeFile(join(realHome, ".gemini", "config", "config.json"), "{}\n");
  await writeFile(
    join(realHome, ".gemini", "config", "mcp_config.json"),
    JSON.stringify({ mcpServers: { "user-server": { command: "echo" } } }),
  );
  await writeFile(join(realHome, ".gitconfig"), "[user]\n");

  const bridge = await createAntigravityPermissionBridge({
    root,
    homeRoot,
    realHome,
    handle: async () => ({ decision: "allow" }),
  });

  const mcpServers: Record<string, JsonObject> = {
    "polyth-agent-tools": {
      command: "node",
      args: ["agentToolsMcp.mjs"],
      env: {
        POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:4400/tools",
        POLYTH_AGENT_TOOLS_TOKEN: "tok_abc",
      },
    },
  };

  await bridge.prepare(mcpServers);

  // The Polyth projection wins, the user's own servers are preserved.
  const config = JSON.parse(await readFile(join(homeRoot, ".gemini", "config", "mcp_config.json"), "utf8"));
  assert.deepEqual(config.mcpServers["polyth-agent-tools"], mcpServers["polyth-agent-tools"]);
  assert.deepEqual(config.mcpServers["user-server"], { command: "echo" });

  // The approval hook still lives in the add-dir permission workspace.
  await readFile(join(root, ".agents", "hooks.json"), "utf8");
  await readFile(join(root, "polyth-hook-client.mjs"), "utf8");
  await assert.rejects(stat(join(root, ".agents", "plugins")), { code: "ENOENT" });

  // The real home is linked, not copied, and app data/config entries resolve.
  assert.equal(await readlink(join(homeRoot, ".gitconfig")), join(realHome, ".gitconfig"));
  assert.equal(await readlink(join(homeRoot, ".gemini", "antigravity-cli")), join(realHome, ".gemini", "antigravity-cli"));
  assert.equal(
    await readlink(join(homeRoot, ".gemini", "config", "config.json")),
    join(realHome, ".gemini", "config", "config.json"),
  );

  await bridge.close();
});

test("private home ignores a malformed user MCP config and never links itself", async (t) => {
  const realHome = await mkdtemp(join(tmpdir(), "polyth-agy-malformed-"));
  // Nested under the real home so the ancestor must not be linked into itself.
  const homeRoot = join(realHome, ".polyth", "agy-home");
  t.after(() => rm(realHome, { recursive: true, force: true }));
  await mkdir(join(realHome, ".gemini", "config"), { recursive: true });
  await writeFile(join(realHome, ".gemini", "config", "mcp_config.json"), "{ not json ");

  await materializeAntigravityHome({
    homeRoot,
    realHome,
    mcpServers: { bridge: { command: "node", args: ["bridge.mjs"] } },
  });

  const config = JSON.parse(await readFile(join(homeRoot, ".gemini", "config", "mcp_config.json"), "utf8"));
  assert.deepEqual(config, { mcpServers: { bridge: { command: "node", args: ["bridge.mjs"] } } });
  await assert.rejects(stat(join(homeRoot, ".polyth")), { code: "ENOENT" });
});

test("browser tool permission classification recognizes actions and URLs", async () => {
  assert.equal(isBrowserTool("polyth_browser"), true);
  assert.equal(isBrowserTool("polyth-agent-tools_polyth_browser"), true);
  assert.equal(isBrowserTool("polyth_agent_tools_polyth_browser"), true);
  assert.equal(isBrowserTool("mcp__polyth-agent-tools__polyth_browser"), true);
  assert.equal(isBrowserTool("write_to_file"), false);
  assert.equal(isBrowserTool("run_command"), false);

  const openReq = parseAgyHookRequest({
    conversationId: "conv-1",
    stepIdx: 1,
    toolCall: {
      name: "polyth_browser",
      args: {
        action: "browser.open",
        parameters: { url: "https://polyth.dev" },
      },
    },
  })!;
  const openClassification = await classifyAgyPermission(openReq, "/work");
  assert.deepEqual(openClassification, {
    kind: "request",
    permission: "browser",
    patterns: ["browser.open: https://polyth.dev"],
    tool: "polyth_browser",
    stepIdx: 1,
  });

  const snapshotReq = parseAgyHookRequest({
    conversationId: "conv-1",
    stepIdx: 2,
    toolCall: {
      name: "polyth-agent-tools_polyth_browser",
      args: {
        action: "browser.snapshot",
      },
    },
  })!;
  const snapshotClassification = await classifyAgyPermission(snapshotReq, "/work");
  assert.deepEqual(snapshotClassification, {
    kind: "request",
    permission: "browser",
    patterns: ["browser.snapshot"],
    tool: "polyth-agent-tools_polyth_browser",
    stepIdx: 2,
  });
});

test("runtime lifecycle captures launch overlay and acknowledges application on init", async (t) => {
  const context = contextOf("space-test", "session-init");
  const plan: HarnessProvisioningPlan = {
    desiredRevision: "rev-init-1",
    items: [
      {
        capability: {
          id: "browser.polyth-browser",
          kind: "tool",
          owner: "browser",
          scope: "project",
          revision: "1",
          name: "polyth_browser",
          description: "Browse",
          inputSchema: { type: "object" },
          trust: "device",
          mutating: true,
        },
        mode: "mcp",
        mutability: "session-create",
      },
      {
        capability: {
          id: "polyth.agent-tools",
          kind: "mcp-server",
          owner: "polyth",
          scope: "session",
          revision: "1",
          name: "polyth-agent-tools",
          enabled: true,
          transport: { kind: "stdio", command: "node", args: ["server.mjs"], envKeys: [] },
        },
        mode: "config",
        mutability: "session-create",
      },
    ],
  };
  const provisioner = createAntigravityProvisioner();
  await provisioner.apply(context, plan, { mcpSecrets: () => ({}) });

  const captures: CapabilityLaunchCapture[] = [];
  const receipts: unknown[] = [];
  const dropCapture = setCapabilityLaunchSink((c) => captures.push(c));
  const dropReceipt = setCapabilityReceiptSink((r) => receipts.push(r));
  t.after(() => {
    dropCapture();
    dropReceipt();
    provisioner.release(context);
  });

  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let stdinData = "";
  proc.stdin.on("data", (chunk: Buffer) => {
    stdinData += chunk.toString();
    for (const line of chunk.toString().trim().split("\n")) {
      if (!line) continue;
      try {
        const control = JSON.parse(line) as Record<string, unknown>;
        if (control.event === "polyth_launch") {
          queueMicrotask(() => {
            proc.stdout.write(JSON.stringify({
              event: "init",
              conversation_id: "native-a",
              init: {
                cwd: context.cwd,
                model: "gemini-2.5-pro",
                permission_mode: "always-proceed",
              },
            }) + "\n");
          });
        }
      } catch {}
    }
  });

  const mockAuthority = {
    authorityId: "auth-1",
    generation: 1,
    receipts: {} as Record<string, string>,
    receipt: async (key: string, val: string) => { mockAuthority.receipts[key] = val; },
    spawn: () => proc as unknown as import("node:child_process").ChildProcess,
    close: async () => {},
    releasedAuthorities: [],
  };

  const bridgeRoot = await mkdtemp(join(tmpdir(), "polyth-agy-rt-bridge-"));
  const bridgeRealHome = await mkdtemp(join(tmpdir(), "polyth-agy-rt-home-"));
  t.after(() => rm(bridgeRoot, { recursive: true, force: true }));
  t.after(() => rm(bridgeRealHome, { recursive: true, force: true }));

  const bridge = await createAntigravityPermissionBridge({
    root: bridgeRoot,
    homeRoot: join(bridgeRoot, "agy-home"),
    realHome: bridgeRealHome,
    handle: async () => ({ decision: "allow" }),
  });
  t.after(() => bridge.close());

  const runtime = createAntigravityRuntime({
    context,
    authority: mockAuthority as unknown as import("@polyth/harness-runtime/process-authority").HarnessProcessAuthority,
    command: "agy",
    workerPath: "/worker.mjs",
    models: async () => [{
      harnessId: "antigravity",
      providerID: "antigravity",
      modelID: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      providerName: "Google Antigravity",
      capabilities: ["input:text", "output:text", "toolcall"],
      variants: ["low", "medium", "high"],
    }],
    autoApprove: async () => true,
    permissionBridge: async () => bridge,
  });
  t.after(() => runtime.dispose());

  // Capture happened when initialize was entered
  assert.equal(captures.length, 0);

  // Trigger create session
  const createResult = await runtime.createSessionOperation!({
    sessionId: context.sessionId!,
    projectId: context.projectId,
    cwd: context.cwd,
    model: { providerID: "antigravity", modelID: "gemini-2.5-pro" },
  }, "op-create-1");

  assert.equal(createResult.kind, "confirmed");
  assert.equal(captures.length, 1);
  assert.equal(captures[0]!.desiredRevision, "rev-init-1");
  assert.equal(captures[0]!.outcome, "captured");

  // Verify worker received launch command
  assert.ok(stdinData.includes("polyth_launch"));

  // Check that bridge prepared the per-runtime MCP config in the private home
  const homeConfigPath = join(bridgeRoot, "agy-home", ".gemini", "config", "mcp_config.json");
  const writtenConfig = JSON.parse(await readFile(homeConfigPath, "utf8"));
  assert.ok(writtenConfig.mcpServers["polyth-agent-tools"]);

  // Verify application receipt was acknowledged and overlay consumed
  assert.equal(receipts.length, 1);
  const receipt = receipts[0] as import("@polyth/contracts").HarnessCapabilityApplicationReceipt;
  assert.equal(receipt.desiredRevision, "rev-init-1");
  assert.equal(receipt.outcome, "unverifiable");
  assert.deepEqual(receipt.capabilityIds, ["browser.polyth-browser", "polyth.agent-tools"]);
  assert.equal(antigravityOverlays.peek(context, "antigravity"), undefined);
});

test("provider descriptor exposes provisioner and registers cleanly", () => {
  let registeredProvider: import("@polyth/contracts").HarnessProvider | undefined;
  const host = {
    pluginId: "backend-antigravity",
    services: {
      require: () => ({
        register: (p: import("@polyth/contracts").HarnessProvider) => {
          registeredProvider = p;
          return { dispose: () => { registeredProvider = undefined; } };
        },
      }),
    },
    spaceStorage: () => ({
      packageDir: () => "/tmp/pkg",
      path: () => "/tmp/state.json",
    }),
  } as unknown as import("@polyth/plugins").ServerPackageHost;

  const pkg = registerPackage(host);
  pkg.onEnable();
  assert.ok(registeredProvider);
  assert.ok(registeredProvider.provisioner);
  assert.equal(typeof registeredProvider.provisioner.support, "function");
  assert.equal(typeof registeredProvider.provisioner.apply, "function");
  assert.equal(typeof registeredProvider.provisioner.release, "function");
  assert.equal(registeredProvider.staticFeatures?.mcp, true);
  pkg.onDisable();
});

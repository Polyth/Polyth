import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { HarnessContext, HarnessProvisioningPlan } from "@polyth/contracts";
import { claudeOverlays, createClaudeProvisioner } from "../src/provisioner.ts";

const enabled = process.env.POLYTH_NATIVE_CAPABILITY_TESTS === "1";
const here = dirname(fileURLToPath(import.meta.url));
const secrets = { mcpSecrets: () => ({}) };
const silentPrompt = async function* () { await new Promise<void>(() => {}); };
const contextFor = (storageDir: string, spaceId: string): HarnessContext => {
  const cwd = join(storageDir, "workspace");
  mkdirSync(cwd);
  return {
    spaceId,
    projectId: "native-project",
    cwd,
    sessionId: `native-${spaceId}`,
    space: {
      spaceId, spaceSlug: spaceId, userId: "native-test", role: "owner",
      deployment: "local-trusted", storageDir,
    },
  };
};
const planFor = (revision: string): HarnessProvisioningPlan => ({
  harnessId: "claude",
  desiredRevision: revision,
  keepRevisions: [revision],
  items: [
    {
      capability: {
        id: "fixture.review", owner: "fixture", scope: "session", revision,
        kind: "skill", name: "review", title: "Review", description: "Review a change.",
        instructions: "Inspect the requested change.",
      },
      mode: "filesystem", mutability: "session-create",
    },
    {
      capability: {
        id: "fixture.mcp", owner: "fixture", scope: "session", revision,
        kind: "mcp-server", name: "native-fixture", enabled: true,
        transport: { kind: "stdio", command: process.execPath, args: [join(here, "fixtureMcp.mjs")], envKeys: [] },
      },
      mode: "native", mutability: "session-create",
    },
  ],
});
const rootFor = (context: HarnessContext) => join(context.space!.storageDir, "packages", "backend-claude");

test("native Claude adds/removes Space-isolated skills and reports deterministic MCP discovery", { skip: !enabled, timeout: 20_000 }, async (t) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const storageA = mkdtempSync(join(tmpdir(), "polyth-claude-native-a-"));
  const storageB = mkdtempSync(join(tmpdir(), "polyth-claude-native-b-"));
  t.after(() => { rmSync(storageA, { recursive: true, force: true }); rmSync(storageB, { recursive: true, force: true }); });
  const provisioner = createClaudeProvisioner({ storageRoot: rootFor });
  const contextA = contextFor(storageA, "space-a");
  const contextB = contextFor(storageB, "space-b");
  await provisioner.apply(contextA, planFor("native-a"), secrets);
  await provisioner.apply(contextB, planFor("native-b"), secrets);
  const overlayA = claudeOverlays.peek(contextA, "claude")!.value;
  const overlayB = claudeOverlays.peek(contextB, "claude")!.value;
  assert.notEqual(overlayA.skills![0], overlayB.skills![0]);

  const initialize = async (
    plugins: NonNullable<typeof overlayA.plugins>,
    skills: string[],
    withMcp: boolean,
    cwd = contextA.cwd,
  ) => {
    const abortController = new AbortController();
    const configDir = join(cwd, "claude-config");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const env = Object.fromEntries(Object.entries({
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const session = query({
      prompt: silentPrompt() as never,
      options: {
        cwd,
        abortController,
        env,
        settingSources: [],
        plugins,
        pluginDelivery: "initialize",
        skills,
        ...(withMcp ? { mcpServers: overlayA.mcpServers } : {}),
      },
    });
    const timer = setTimeout(() => abortController.abort(), 10_000);
    try {
      const initialization = await session.initializationResult();
      return { session, initialization };
    } catch (error) {
      session.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const initializedA = await initialize(overlayA.plugins!, overlayA.skills!, true);
  const sessionA = initializedA.session;
  try {
    assert.equal(initializedA.initialization.plugins_applied, true);
    const commands = await sessionA.supportedCommands();
    assert.ok(commands.some((command) => command.name === overlayA.skills![0]));
    assert.ok(!commands.some((command) => command.name === overlayB.skills![0]));
    const deadline = Date.now() + 5_000;
    let nativeMcp = (await sessionA.mcpServerStatus()).find((server) => server.name === "native-fixture");
    while (nativeMcp?.status === "pending" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      nativeMcp = (await sessionA.mcpServerStatus()).find((server) => server.name === "native-fixture");
    }
    assert.equal(nativeMcp?.status, "connected");
    assert.ok(nativeMcp?.tools?.some((tool) => tool.name === "fixture_read"));
  } finally {
    sessionA.close();
  }

  const initializedB = await initialize(overlayB.plugins!, overlayB.skills!, false, contextB.cwd);
  try {
    assert.equal(initializedB.initialization.plugins_applied, true);
    const commands = await initializedB.session.supportedCommands();
    assert.ok(commands.some((command) => command.name === overlayB.skills![0]));
    assert.ok(!commands.some((command) => command.name === overlayA.skills![0]));
  } finally {
    initializedB.session.close();
  }

  const removed = (await initialize([], [], false)).session;
  try {
    assert.ok(!(await removed.supportedCommands()).some((command) => command.name === overlayA.skills![0]));
    assert.ok(!(await removed.mcpServerStatus()).some((server) => server.name === "native-fixture"));
  } finally {
    removed.close();
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HarnessContext, HarnessProvisioningPlan, SpaceContext } from "@polyth/contracts";
import { COMMANDCODE_BRIDGE_SOURCE } from "../src/bridgeSource.ts";
import { commandCodeOverlays, createCommandCodeProvisioner } from "../src/provisioner.ts";
import { COMMANDCODE_WORKER_SOURCE } from "../src/workerSource.ts";

const syntaxCheck = (root: string, name: string, source: string): void => {
  const file = join(root, name);
  writeFileSync(file, source, { mode: 0o600 });
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
};

const contextAt = (storageDir: string): HarnessContext => {
  mkdirSync(storageDir, { recursive: true });
  const space: SpaceContext = {
    spaceId: "space",
    spaceSlug: "space",
    userId: "user",
    role: "owner",
    deployment: "local-trusted",
    storageDir,
  };
  return {
    spaceId: "space",
    projectId: "project",
    sessionId: "session",
    cwd: mkdtempSync(join(tmpdir(), "polyth-commandcode-source-cwd-")),
    space,
  };
};

test("generated Command Code worker and admission bridge are valid JavaScript", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-commandcode-source-check-"));
  syntaxCheck(root, "worker.mjs", COMMANDCODE_WORKER_SOURCE);
  syntaxCheck(root, "bridge.mjs", COMMANDCODE_BRIDGE_SOURCE);
});

test("generated read-only Polyth tool Mod is valid JavaScript and contains no bridge secret", async () => {
  const storage = mkdtempSync(join(tmpdir(), "polyth-commandcode-tool-source-"));
  const context = contextAt(storage);
  const plan: HarnessProvisioningPlan = {
    harnessId: "commandcode",
    desiredRevision: "syntax-tool-r1",
    items: [{
      capability: {
        id: "example.inspect",
        kind: "tool",
        owner: "example",
        scope: "session",
        revision: "inspect-r1",
        name: "inspect_project",
        description: "Inspect project state",
        inputSchema: { type: "object", properties: {} },
        trust: "pure",
        mutating: false,
      },
      mode: "mcp",
      mutability: "immediate",
    }],
  };
  const provisioner = createCommandCodeProvisioner();
  await provisioner.apply(context, plan, {
    mcpSecrets: () => ({
      POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:7777/internal/agent-tools",
      POLYTH_AGENT_TOOLS_TOKEN: "never-write-this-token",
    }),
  });
  const overlay = commandCodeOverlays.peek(context, "commandcode")?.value;
  assert.ok(overlay?.toolModFile);
  assert.ok(existsSync(overlay.toolModFile));
  const source = readFileSync(overlay.toolModFile, "utf8");
  assert.doesNotMatch(source, /never-write-this-token|127\.0\.0\.1:7777/);
  syntaxCheck(storage, "generated-tool.mjs", source);
  provisioner.release?.(context);
});

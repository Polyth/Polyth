import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HarnessContext, HarnessProvisioningPlan, SpaceContext } from "@polyth/contracts";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/harness-runtime/executable-discovery";
import { PI_BOOTSTRAP_SOURCE } from "../src/bootstrapSource.ts";
import { createPiProvisioner, piOverlays } from "../src/provisioner.ts";
import { PI_WORKER_SOURCE } from "../src/workerSource.ts";

const enabled = process.env.POLYTH_NATIVE_CAPABILITY_TESTS === "1";

test("installed Pi discovers the private Polyth tool extension without exposing its bearer", { skip: !enabled, timeout: 30_000 }, async (t) => {
  const report = await discoverHarnessExecutable(process.env.POLYTH_PI_BIN?.trim() || "pi");
  if (!report.hit) return t.skip("Pi CLI is not installed");

  const root = mkdtempSync(join(tmpdir(), "polyth-pi-native-tools-"));
  const cwd = join(root, "workspace");
  const storageDir = join(root, "space");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(storageDir, { recursive: true });
  const space: SpaceContext = {
    spaceId: "space",
    spaceSlug: "space",
    userId: "user",
    role: "owner",
    deployment: "local-trusted",
    storageDir,
  };
  const context: HarnessContext = { spaceId: "space", projectId: "project", sessionId: "session", cwd, space };
  const plan: HarnessProvisioningPlan = {
    harnessId: "pi",
    desiredRevision: "native-tools-r1",
    items: [{
      capability: {
        id: "browser.polyth-browser",
        kind: "tool",
        owner: "browser",
        scope: "session",
        revision: "browser-r1",
        name: "polyth_browser",
        description: "Control the Polyth browser",
        inputSchema: { type: "object", properties: {} },
        trust: "workspace",
        mutating: true,
      },
      mode: "mcp",
      mutability: "session-create",
    }, {
      capability: {
        id: "polyth.agent-tools",
        kind: "mcp-server",
        owner: "polyth",
        scope: "session",
        revision: "bridge-r1",
        name: "polyth-agent-tools",
        enabled: true,
        transport: { kind: "stdio", command: "node", args: [], envKeys: [] },
      },
      mode: "unsupported",
      mutability: "immutable",
    }],
  };
  const provisioner = createPiProvisioner();
  await provisioner.apply(context, plan, {
    mcpSecrets: (): Record<string, string> => ({
      POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:9/internal/agent-tools",
      POLYTH_AGENT_TOOLS_TOKEN: "native-secret-sentinel",
    }),
  });
  const overlay = piOverlays.peek(context, "pi")?.value;
  assert.ok(overlay);
  const worker = join(root, "pi-worker.mjs");
  const bootstrap = join(root, "pi-bootstrap.mjs");
  writeFileSync(worker, PI_WORKER_SOURCE, { mode: 0o600 });
  writeFileSync(bootstrap, PI_BOOTSTRAP_SOURCE, { mode: 0o600 });
  const baseEnv = await harnessExecutableChildEnv(report.hit.executablePath);
  const child = spawn(process.execPath, [worker], {
    cwd,
    env: {
      ...baseEnv,
      PI_OFFLINE: "1",
      POLYTH_PI_BIN: report.hit.executablePath,
      POLYTH_PI_ARGS: JSON.stringify(["--no-session", "--approve"]),
      POLYTH_PI_BOOTSTRAP: bootstrap,
      POLYTH_PI_EXTENSION: overlay.extensionFile,
      POLYTH_PI_TOOL_BRIDGE: JSON.stringify(overlay.toolBridge),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let marker = false;
  let state = false;
  const completed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Pi extension discovery timed out: ${stderr.slice(-1000)}`)), 20_000);
    const inspect = () => {
      for (const line of stdout.split("\n").filter(Boolean)) {
        let value: Record<string, unknown>;
        try { value = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (value.type === "extension_ui_request" && value.method === "setStatus"
          && value.statusKey === "polyth-tools" && value.statusText === "ready") marker = true;
        if (value.type === "response" && value.id === "native-state" && value.success === true) state = true;
      }
      if (marker && state) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); inspect(); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (!marker || !state) reject(new Error(`Pi exited before extension discovery (${code}): ${stderr.slice(-1000)}`));
    });
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => setTimeout(resolve, 250));
    child.once("error", reject);
  });
  child.stdin.write(`${JSON.stringify({ id: "native-state", type: "get_state" })}\n`);
  try {
    await completed;
    assert.doesNotMatch(stdout + stderr, /native-secret-sentinel/);
  } finally {
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3_000)),
    ]);
    provisioner.release?.(context);
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  HarnessCapabilityApplicationReceipt,
  HarnessContext,
  HarnessProvisioningPlan,
  SpaceContext,
} from "@polyth/contracts";
import { setCapabilityReceiptSink } from "@polyth/harness-runtime";
import { createPiCapabilitySync } from "../src/capabilitySync.ts";
import { PI_BOOTSTRAP_SOURCE } from "../src/bootstrapSource.ts";
import { createPiProvisioner, piOverlays } from "../src/provisioner.ts";
import type { PiRpc, PiRpcEvent } from "../src/rpc.ts";
import { PI_WORKER_SOURCE } from "../src/workerSource.ts";

const temporaryDirectory = (): string => mkdtempSync(join(tmpdir(), "polyth-pi-tools-"));

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
    cwd: temporaryDirectory(),
    space,
  };
};

const plan: HarnessProvisioningPlan = {
  harnessId: "pi",
  desiredRevision: "pi-tools-r1",
  items: [
    {
      capability: {
        id: "browser.polyth-browser",
        kind: "tool",
        owner: "browser",
        scope: "session",
        revision: "browser-r1",
        name: "polyth_browser",
        description: "Control the Polyth browser",
        inputSchema: {
          type: "object",
          properties: { action: { type: "string" } },
          required: ["action"],
        },
        trust: "workspace",
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
        revision: "bridge-r1",
        name: "polyth-agent-tools",
        enabled: true,
        transport: { kind: "stdio", command: "node", args: [], envKeys: [] },
      },
      mode: "unsupported",
      mutability: "immutable",
    },
  ],
};

test("Pi stages browser and other package tools as a private extension without writing its scoped token", async () => {
  const storage = temporaryDirectory();
  const context = contextAt(storage);
  const provisioner = createPiProvisioner();
  const support = await provisioner.support(context);
  assert.deepEqual(support.kinds.tool?.modes, ["mcp"]);
  assert.equal(support.kinds.tool?.configScope, "session");

  const result = await provisioner.apply(context, plan, {
    mcpSecrets(id): Record<string, string> {
      return id === "polyth.agent-tools" ? {
          POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:7777/internal/agent-tools",
          POLYTH_AGENT_TOOLS_TOKEN: "opaque-pi-token",
        }
        : {};
    },
  });
  assert.equal(result.records.find((row) => row.capabilityId === "browser.polyth-browser")?.status, "pending");
  assert.equal(result.records.some((row) => row.capabilityId === "polyth.agent-tools"), false);

  const overlay = piOverlays.peek(context, "pi")?.value;
  assert.ok(overlay);
  assert.deepEqual(overlay.toolCapabilityIds, ["browser.polyth-browser"]);
  assert.equal(overlay.toolNames.polyth_browser, "browser.polyth-browser");
  assert.equal(overlay.toolBridge.token, "opaque-pi-token");
  const extension = readFileSync(overlay.extensionFile, "utf8");
  assert.match(extension, /pi\.registerTool/);
  assert.match(extension, /polyth_browser/);
  assert.match(extension, /Type\.Unsafe/);
  assert.doesNotMatch(extension, /opaque-pi-token|127\.0\.0\.1:7777/);
  const checked = spawnSync(process.execPath, ["--check", overlay.extensionFile], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);

  const extensionPath = overlay.extensionFile;
  provisioner.release?.(context);
  assert.equal(piOverlays.peek(context, "pi"), undefined);
  assert.equal(existsSync(extensionPath), false);
});

test("Pi records extension discovery separately from individual tool invocation", async () => {
  const context = contextAt(temporaryDirectory());
  await createPiProvisioner().apply(context, plan, {
    mcpSecrets: (): Record<string, string> => ({
      POLYTH_AGENT_TOOLS_URL: "http://127.0.0.1:7777/internal/agent-tools",
      POLYTH_AGENT_TOOLS_TOKEN: "opaque-pi-token",
    }),
  });
  const listeners = new Set<(event: PiRpcEvent) => void>();
  const rpc: PiRpc = {
    authorityId: "pi-authority",
    generation: 4,
    receipts: {},
    releasedAuthorities: [],
    request: async () => undefined as never,
    receipt: async () => undefined,
    onEvent(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    onClose: () => ({ dispose() {} }),
    close: async () => undefined,
  };
  const receipts: HarnessCapabilityApplicationReceipt[] = [];
  const release = setCapabilityReceiptSink((receipt) => receipts.push(receipt));
  const synced = createPiCapabilitySync(context, rpc);
  const subscription = synced.onEvent(() => undefined);
  for (const listener of listeners) listener({
    type: "extension_ui_request",
    method: "setStatus",
    statusKey: "polyth-tools",
    statusText: "ready",
  });
  for (const listener of listeners) listener({ type: "tool_execution_start", toolName: "polyth_browser" });

  assert.deepEqual(receipts.map((receipt) => receipt.evidence?.stage), ["discovered", "invocable"]);
  assert.deepEqual(receipts[1]?.capabilityIds, ["browser.polyth-browser"]);
  subscription.dispose();
  release();
  createPiProvisioner().release?.(context);
});

test("Pi fails tool projection closed when the scoped bridge is unavailable", async () => {
  const context = contextAt(temporaryDirectory());
  const result = await createPiProvisioner().apply(context, plan, { mcpSecrets: () => ({}) });
  const browser = result.records.find((row) => row.capabilityId === "browser.polyth-browser");
  assert.equal(browser?.status, "failed");
  assert.match(browser?.reason ?? "", /bridge is unavailable/i);
  assert.equal(piOverlays.peek(context, "pi"), undefined);
});

test("Pi's generated relay is valid JavaScript and strips bridge credentials from the model process", () => {
  const worker = join(temporaryDirectory(), "pi-worker.mjs");
  writeFileSync(worker, PI_WORKER_SOURCE, { mode: 0o600 });
  const checked = spawnSync(process.execPath, ["--check", worker], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(PI_WORKER_SOURCE, /delete childEnv\.POLYTH_PI_TOOL_BRIDGE/);
  assert.match(PI_WORKER_SOURCE, /POLYTH_PI_NATIVE_ARGS/);
  assert.match(PI_WORKER_SOURCE, /stdio: \['pipe', 'pipe', 'pipe', 'pipe', 'pipe'\]/);
  assert.doesNotMatch(PI_WORKER_SOURCE, /opaque-pi-token/);
  const bootstrap = join(temporaryDirectory(), "pi-bootstrap.mjs");
  writeFileSync(bootstrap, PI_BOOTSTRAP_SOURCE, { mode: 0o600 });
  const bootstrapChecked = spawnSync(process.execPath, ["--check", bootstrap], { encoding: "utf8" });
  assert.equal(bootstrapChecked.status, 0, bootstrapChecked.stderr);
  assert.match(PI_BOOTSTRAP_SOURCE, /setInterval\(\(\) => \{\}, 1_000\)/);
});

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

const promptPlan = (desiredRevision: string, harnessText: string): HarnessProvisioningPlan => ({
  harnessId: "pi",
  desiredRevision,
  items: [
    {
      capability: {
        id: "polyth.behavior",
        kind: "instruction",
        owner: "polyth",
        scope: "deployment",
        revision: `global-${desiredRevision}`,
        text: "Global behavior.",
      },
      mode: "prompt",
      mutability: "immediate",
    },
    {
      capability: {
        id: "harness-runtime.system-prompt.pi",
        kind: "instruction",
        owner: "harness-runtime",
        scope: "space",
        revision: `pi-${desiredRevision}`,
        spaceId: "space",
        text: harnessText,
      },
      mode: "prompt",
      mutability: "immediate",
    },
  ],
});

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
  assert.deepEqual(support.kinds.instruction, {
    modes: ["prompt"],
    mutability: "immediate",
    remote: false,
    configScope: "session",
  });
  assert.deepEqual(support.kinds.context, {
    modes: ["prompt"],
    mutability: "immediate",
    remote: false,
    configScope: "session",
  });
  assert.deepEqual(support.kinds.skill, {
    modes: ["prompt"],
    mutability: "immediate",
    remote: false,
    configScope: "session",
  });

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
  assert.ok(overlay.extensionFile);
  assert.ok(overlay.toolBridge);
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

test("Pi appends global and harness system prompts and picks up live revisions", async () => {
  const context = contextAt(temporaryDirectory());
  const provisioner = createPiProvisioner();
  const calls: Array<Record<string, unknown>> = [];
  const rpc: PiRpc = {
    authorityId: "pi-prompt-authority",
    generation: 7,
    receipts: {},
    releasedAuthorities: [],
    request: async <T>(command: Record<string, unknown> & { type: string }) => {
      calls.push(command);
      return { accepted: true } as T;
    },
    receipt: async () => undefined,
    onEvent: () => ({ dispose() {} }),
    onClose: () => ({ dispose() {} }),
    close: async () => undefined,
  };
  const receipts: HarnessCapabilityApplicationReceipt[] = [];
  const release = setCapabilityReceiptSink((receipt) => receipts.push(receipt));
  try {
    const first = await provisioner.apply(context, promptPlan("pi-prompt-r1", "Pi-only R1."), { mcpSecrets: () => ({}) });
    assert.ok(first.records.every((row) => row.status === "pending"));
    assert.equal(
      piOverlays.peek(context, "pi")?.value.prompt?.text,
      "Global behavior.\n\nPi-only R1.",
    );

    const synced = createPiCapabilitySync(context, rpc);
    await synced.request({ type: "prompt", message: "Question" });
    assert.equal(calls[0]?.message, "Question\n\nGlobal behavior.\n\nPi-only R1.");

    await provisioner.apply(context, promptPlan("pi-prompt-r2", "Pi-only R2."), { mcpSecrets: () => ({}) });
    await synced.request({ type: "prompt", message: "Next" });
    assert.equal(calls[1]?.message, "Next\n\nGlobal behavior.\n\nPi-only R2.");
    assert.doesNotMatch(String(calls[1]?.message), /R1/);

    assert.deepEqual(receipts.map((receipt) => receipt.desiredRevision), ["pi-prompt-r1", "pi-prompt-r2"]);
    assert.deepEqual(receipts[1]?.capabilityIds, [
      "polyth.behavior",
      "harness-runtime.system-prompt.pi",
    ]);
    assert.equal(receipts[1]?.outcome, "unverifiable");
    assert.equal(receipts[1]?.evidence?.stage, "staged");
  } finally {
    release();
    provisioner.release?.(context);
  }
});

test("Pi delivers a Secure Safe skill through its prompt overlay", async () => {
  const context = contextAt(temporaryDirectory());
  const provisioner = createPiProvisioner();
  const result = await provisioner.apply(context, {
    harnessId: "pi",
    desiredRevision: "secure-safe-r1",
    items: [{
      capability: {
        id: "secure-safe.skill.polyth-secure-safe",
        kind: "skill",
        owner: "secure-safe",
        scope: "deployment",
        revision: "1",
        name: "polyth-secure-safe",
        title: "Polyth Credential Vault",
        description: "Store credentials behind reusable handles.",
        instructions: "Use Credential Vault and never ask for a secret in chat.",
      },
      mode: "prompt",
      mutability: "immediate",
    }],
  }, { mcpSecrets: () => ({}) });
  assert.equal(result.records[0]?.status, "pending");
  const overlay = piOverlays.peek(context, "pi")?.value;
  assert.deepEqual(overlay?.prompt?.capabilityIds, ["secure-safe.skill.polyth-secure-safe"]);
  assert.match(overlay?.prompt?.text ?? "", /never ask for a secret in chat/);
  provisioner.release?.(context);
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

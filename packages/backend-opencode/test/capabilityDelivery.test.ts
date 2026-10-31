import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentRuntime,
  HarnessCapabilityApplicationReceipt,
  RuntimeEndpoint,
} from "@polyth/contracts";
import { configureOpenCodeCapabilityDelivery, verifyOpenCodeCapabilities } from "../src/capabilityDelivery.ts";

const endpoint = (generation = 7): RuntimeEndpoint => ({
  authorityId: "authority-a",
  generation,
  continuity: "generation-only",
  url: "http://127.0.0.1:4556",
  location: { directory: "/workspace" },
  control: { kind: "borrowed", source: "shared" },
  config: { kind: "read-only" },
  authentication: { kind: "none" },
});

test("disabled MCP readback requires native absence or disabled state", async () => {
  const target = { spaceId: "s", projectId: "p", cwd: "/workspace", harnessId: "opencode", authorityId: "a", generation: 7 };
  const overlay = { configContent: '{"mcp":{"gone":{"enabled":false}}}', env: {}, desiredRevision: "disabled", capabilityIds: ["polyth.mcp.retired.gone"], mcpNames: { "polyth.mcp.retired.gone": "gone" }, disabledMcpNames: ["gone"] };
  for (const [state, expected] of [[{}, "applied"], [{ gone: { status: "disabled" } }, "applied"], [{ gone: { status: "connected" } }, "failed"]] as const) {
    const receipts: HarnessCapabilityApplicationReceipt[] = [];
    await verifyOpenCodeCapabilities(overlay, target, async () => state, (r) => receipts.push(r));
    assert.equal(receipts[0]!.outcome, expected);
    assert.equal(receipts[0]!.target.generation, 7);
    assert.notEqual(receipts[0]!.evidence?.stage, "connected");
  }
});

const overlay = {
  configContent: JSON.stringify({ mcp: { helper: { type: "local" } } }),
  env: {},
  desiredRevision: "bundle-a",
  capabilityIds: ["fixture.mcp"],
  prompt: {
    text: "Global behavior\n\nOpenCode-only behavior\n\nProject instruction\n\n## Context: Facts\n\nProject context",
    capabilityIds: [
      "polyth.behavior",
      "harness-runtime.system-prompt.opencode",
      "fixture.instruction",
      "fixture.context",
    ],
  },
};

const context = {
  spaceId: "space-a",
  projectId: "project-a",
  cwd: "/workspace",
};

test("OpenCode appends canonical text after user text and acknowledges only prompt capabilities", async () => {
  let submitted: { sessionId: string; text: string } | undefined;
  const receipts: HarnessCapabilityApplicationReceipt[] = [];
  const current = endpoint();
  const runtime = {
    async startTurn() {},
    async startTurnOperation(request: { sessionId: string; text: string }) {
      submitted = request;
      return { kind: "confirmed", value: { admissionId: "admission-a" } } as const;
    },
    async endpoint() { return current; },
  } as unknown as AgentRuntime;

  configureOpenCodeCapabilityDelivery(runtime, context, {
    peek: () => overlay,
    acknowledge: (receipt) => receipts.push(receipt),
  });

  const outcome = await runtime.startTurnOperation!({ sessionId: "session-a", text: "User request" }, "op-a");
  assert.equal(outcome.kind, "confirmed");
  assert.equal(
    submitted?.text,
    "User request\n\nGlobal behavior\n\nOpenCode-only behavior\n\nProject instruction\n\n## Context: Facts\n\nProject context",
  );
  assert.deepEqual(receipts, [{
    target: {
      spaceId: "space-a",
      projectId: "project-a",
      cwd: "/workspace",
      harnessId: "opencode",
      authorityId: "authority-a",
      generation: 7,
    },
    desiredRevision: "bundle-a",
    capabilityIds: [
      "polyth.behavior",
      "harness-runtime.system-prompt.opencode",
      "fixture.instruction",
      "fixture.context",
    ],
    outcome: "unverifiable",
    reason: "OpenCode accepted the prompt text projection; native model consumption is not observable",
  }]);
});

test("OpenCode keeps utility turns free of session capability text", async () => {
  const submitted: string[] = [];
  const receipts: HarnessCapabilityApplicationReceipt[] = [];
  const runtime = {
    async startTurn(request: { text: string }) { submitted.push(request.text); },
    async startTurnOperation(request: { text: string }) {
      submitted.push(request.text);
      return { kind: "confirmed", value: { admissionId: "admission-a" } } as const;
    },
    async endpoint() { return endpoint(); },
  } as unknown as AgentRuntime;
  configureOpenCodeCapabilityDelivery(runtime, context, {
    peek: () => overlay,
    acknowledge: (receipt) => receipts.push(receipt),
  });

  await runtime.startTurnOperation!({ sessionId: "oneshot-a", text: "Title this", utility: { purpose: "custom-title" } }, "op-a");
  await runtime.startTurn({ sessionId: "oneshot-b", text: "Title that", utility: {} });
  assert.deepEqual(submitted, ["Title this", "Title that"]);
  assert.deepEqual(receipts, []);
});

test("OpenCode does not acknowledge rejected prompt admission", async () => {
  const receipts: HarnessCapabilityApplicationReceipt[] = [];
  const runtime = {
    async startTurn() {},
    async startTurnOperation(request: { sessionId: string; text: string }) {
      assert.match(request.text, /Project instruction/);
      return { kind: "rejected", code: "busy", message: "busy" } as const;
    },
    async endpoint() { return endpoint(); },
  } as unknown as AgentRuntime;

  configureOpenCodeCapabilityDelivery(runtime, context, {
    peek: () => overlay,
    acknowledge: (receipt) => receipts.push(receipt),
  });

  const outcome = await runtime.startTurnOperation!({ sessionId: "session-a", text: "User request" }, "op-a");
  assert.equal(outcome.kind, "rejected");
  assert.deepEqual(receipts, []);
});

test("OpenCode refuses a prompt receipt when the runtime generation changes during admission", async () => {
  const receipts: HarnessCapabilityApplicationReceipt[] = [];
  let generation = 7;
  const runtime = {
    async startTurn(request: { sessionId: string; text: string }) {
      assert.match(request.text, /Project context/);
      generation = 8;
    },
    async endpoint() { return endpoint(generation); },
  } as unknown as AgentRuntime;

  configureOpenCodeCapabilityDelivery(runtime, context, {
    peek: () => overlay,
    acknowledge: (receipt) => receipts.push(receipt),
  });

  await runtime.startTurn({ sessionId: "session-a", text: "User request" });
  assert.deepEqual(receipts, []);
});

test("only a title utility turn selects OpenCode's tool-less title agent", async () => {
  const { turnAgent } = await import("../src/index.ts");
  assert.equal(turnAgent({ utility: { purpose: "custom-title" } }), "title");
  assert.equal(turnAgent({ utility: { purpose: "commit-message" } }), undefined);
  assert.equal(turnAgent({}), undefined);
  assert.equal(turnAgent({ agent: "plan", utility: { purpose: "custom-title" } }), "plan");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentRuntime,
  HarnessCapabilityApplicationReceipt,
  RuntimeEndpoint,
} from "@polyth/contracts";
import { configureOpenCodeCapabilityDelivery } from "../src/capabilityDelivery.ts";

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

const overlay = {
  configContent: JSON.stringify({ mcp: { helper: { type: "local" } } }),
  env: {},
  desiredRevision: "bundle-a",
  capabilityIds: ["fixture.mcp"],
  prompt: {
    text: "Project instruction\n\n## Context: Facts\n\nProject context",
    capabilityIds: ["fixture.instruction", "fixture.context"],
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
    "User request\n\nProject instruction\n\n## Context: Facts\n\nProject context",
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
    capabilityIds: ["fixture.instruction", "fixture.context"],
    outcome: "unverifiable",
    reason: "OpenCode accepted the prompt text projection; native model consumption is not observable",
  }]);
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

import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessContext } from "@polyth/contracts";
import type { RpcPeer } from "@polyth/harness-runtime";
import {
  configureAcpCapabilityDelivery,
  isCapabilityDerivedAcpTitle,
} from "../src/capabilityDelivery.ts";

const capabilityText = `
## Secure Safe
Route credential requests through Secure Safe routing and never expose raw values.
## Agent control
Use Polyth session tools for delegated work.
`;

test("ACP title provenance rejects capability-derived titles but keeps user-grounded titles", () => {
  assert.equal(
    isCapabilityDerivedAcpTitle("Secure Safe routing", capabilityText, "Fix the mobile composer"),
    true,
  );
  assert.equal(
    isCapabilityDerivedAcpTitle("Secure Safe routing", capabilityText, "Improve Secure Safe routing"),
    false,
    "the same title is legitimate when the user actually asked about it",
  );
  assert.equal(
    isCapabilityDerivedAcpTitle("Mobile composer cleanup", capabilityText, "Fix the mobile composer"),
    false,
  );
});

test("ACP delivery strips only a capability-derived session title update", async () => {
  const context: HarnessContext = {
    spaceId: "space-a",
    projectId: "project-a",
    cwd: "/project/a",
    sessionId: "canonical-a",
  };
  let nativeNotification: ((method: string, params: any) => void) | undefined;
  let delivered: any;
  const rpc = {
    async request<T>(method: string): Promise<T> {
      return (method === "session/new" ? { sessionId: "native-a" } : { stopReason: "end_turn" }) as T;
    },
    notify() {},
    onNotification(handler: (method: string, params: any) => void) { nativeNotification = handler; },
    onRequest() {},
    onClose() {},
    async close() {},
    authorityId: "authority-a",
    generation: 1,
    releasedAuthorities: [],
    receipts: {},
    async receipt() {},
  } as unknown as RpcPeer;

  configureAcpCapabilityDelivery(rpc, context, "cursor", undefined, {
    peek: () => ({
      value: {
        mcpServers: [],
        mcpHttp: false,
        prompt: { text: capabilityText, capabilityIds: ["secure-safe.behavior"] },
      },
      desiredRevision: "r1",
    }),
    acknowledge() {},
  });

  rpc.onNotification((_method, params) => { delivered = params; });
  await rpc.request("session/new", { cwd: context.cwd, mcpServers: [] });
  await rpc.request("session/prompt", {
    sessionId: "native-a",
    prompt: [{ type: "text", text: "Fix the mobile composer" }],
  });

  nativeNotification?.("session/update", {
    sessionId: "native-a",
    update: { sessionUpdate: "session_info_update", title: "Secure Safe routing", updatedAt: 1 },
  });
  assert.equal(delivered.update.title, undefined);
  assert.equal(delivered.update.updatedAt, 1, "non-title metadata remains intact");

  nativeNotification?.("session/update", {
    sessionId: "native-a",
    update: { sessionUpdate: "session_info_update", title: "Mobile composer cleanup" },
  });
  assert.equal(delivered.update.title, "Mobile composer cleanup");
});

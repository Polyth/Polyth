import assert from "node:assert/strict";
import { test } from "node:test";

import { api } from "../src/webApiAccountScoped.ts";

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("selected account preset resolves to model and agent without sending its private id", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ path, ...(body ? { body } : {}) });
      if (path === "/api/agent-profiles") {
        return jsonResponse([{
          id: "preset-alice",
          name: "Alice reviewer",
          providerID: "openai",
          modelID: "gpt-review",
          agent: "reviewer",
          thinking: "high",
          features: {},
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        }]);
      }
      if (path === "/api/sessions/s1/message") return jsonResponse({ ok: true });
      throw new Error(`unexpected fetch ${path}`);
    };

    await api.sendMessage("s1", { text: "review", agentProfileId: "preset-alice" });
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.path, "/api/agent-profiles");
    const sent = requests[1]?.body ?? {};
    assert.equal("agentProfileId" in sent, false);
    assert.deepEqual(sent.model, {
      providerID: "openai",
      modelID: "gpt-review",
      variant: "high",
    });
    assert.equal(sent.agent, "reviewer");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("explicit model and agent override an account preset and clear never leaks an id", async () => {
  const previousFetch = globalThis.fetch;
  const sent: Record<string, unknown>[] = [];
  try {
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path === "/api/agent-profiles") {
        return jsonResponse([{
          id: "preset",
          name: "Preset",
          providerID: "preset-provider",
          modelID: "preset-model",
          agent: "preset-agent",
          features: {},
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        }]);
      }
      if (path.startsWith("/api/sessions/")) {
        sent.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch ${path}`);
    };

    await api.sendMessage("s1", {
      text: "go",
      agentProfileId: "preset",
      model: { providerID: "explicit", modelID: "model" },
      agent: "explicit-agent",
    });
    await api.sendMessage("s1", { text: "plain", agentProfileId: null });

    assert.deepEqual(sent[0]?.model, { providerID: "explicit", modelID: "model" });
    assert.equal(sent[0]?.agent, "explicit-agent");
    assert.equal("agentProfileId" in (sent[0] ?? {}), false);
    assert.equal("agentProfileId" in (sent[1] ?? {}), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("an unavailable profile list is not converted into an empty account", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => jsonResponse({
      error: "unavailable",
      message: "server shutting down",
    }, 503);

    await assert.rejects(api.listProfiles(), {
      code: "unavailable",
      status: 503,
      message: "server shutting down",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

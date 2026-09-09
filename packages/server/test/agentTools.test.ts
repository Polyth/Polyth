import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentToolBridge, AGENT_TOOLS_PATH } from "../src/agentTools.ts";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("agent tool bridge lists granted tools and refuses a disposed executor", async () => {
  const registry = createCapabilityContributionRegistry();
  const contribution = registry.register("example-feature", {
    descriptor: {
      id: "example-feature.ping",
      kind: "tool",
      owner: "example-feature",
      scope: "space",
      revision: "1",
      name: "ping",
      description: "ping",
      inputSchema: { type: "object", properties: {} },
      trust: "pure",
      mutating: false,
    },
    execute: async (_input, ctx) => ({ output: `pong:${ctx.spaceId}` }),
  });
  const bridge = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
  });
  const descriptor = registry.list()[0]!.descriptor as Extract<import("@polyth/contracts").AgentCapabilityDescriptor, { kind: "tool" }>;
  const grant = bridge.mint({
    spaceId: "space-a",
    projectId: "p",
    cwd: "/tmp/p",
    tools: [descriptor],
  });
  const json = (code: number, body: unknown) => {
    captured = { code, body };
  };
  let captured: { code: number; body: unknown } | undefined;
  const rc = {
    path: AGENT_TOOLS_PATH,
    method: "POST",
    ingress: { kind: "public-http" as const, listenerId: "public", loopback: true, secure: false },
    req: { headers: { authorization: `Bearer ${grant.token}` } },
    body: async () => ({ id: "example-feature.ping", arguments: {} }),
    json,
  };
  assert.equal(await bridge.route(rc as never), true);
  assert.equal(captured?.code, 200);
  assert.deepEqual(captured?.body, { output: "pong:space-a" });

  contribution.dispose();
  captured = undefined;
  assert.equal(await bridge.route(rc as never), true);
  assert.equal(captured?.code, 404);

  captured = undefined;
  assert.equal(await bridge.route({ ...rc, ingress: { kind: "public-http", listenerId: "public", loopback: false, secure: false } } as never), true);
  assert.equal(captured?.code, 403);
});

test("agent tool bridge authorizes the exact scoped grant before invoking", async () => {
  const registry = createCapabilityContributionRegistry();
  let executed = false;
  let executionContext: Record<string, string | undefined> | undefined;
  registry.register("example-feature", {
    descriptor: {
      id: "example-feature.mutate",
      kind: "tool",
      owner: "example-feature",
      scope: "session",
      revision: "1",
      name: "mutate",
      description: "mutate",
      inputSchema: { type: "object", properties: {} },
      trust: "trusted",
      mutating: true,
    },
    execute: async (_input, ctx) => {
      executed = true;
      executionContext = {
        spaceId: ctx.spaceId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
      };
      return { output: "mutated" };
    },
  });
  let decision: "allow" | "deny" = "deny";
  let authorizedGrant: { spaceId: string; projectId: string; sessionId?: string; cwd: string } | undefined;
  const bridge = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
    authorize: (_tool, grant) => {
      authorizedGrant = {
        spaceId: grant.spaceId,
        projectId: grant.projectId,
        sessionId: grant.sessionId,
        cwd: grant.cwd,
      };
      return decision;
    },
  });
  const descriptor = registry.list()[0]!.descriptor as Extract<import("@polyth/contracts").AgentCapabilityDescriptor, { kind: "tool" }>;
  const grant = bridge.mint({
    spaceId: "space-a",
    projectId: "project-a",
    sessionId: "session-a",
    cwd: "/workspace/a",
    tools: [descriptor],
  });
  let captured: { code: number; body: unknown } | undefined;
  const rc = {
    path: AGENT_TOOLS_PATH,
    method: "POST",
    ingress: { kind: "public-http" as const, listenerId: "public", loopback: true, secure: false },
    req: { headers: { authorization: `Bearer ${grant.token}` } },
    body: async () => ({ id: "example-feature.mutate", arguments: {} }),
    json: (code: number, body: unknown) => { captured = { code, body }; },
  };

  assert.equal(await bridge.route(rc as never), true);
  assert.equal(captured?.code, 403);
  assert.equal(executed, false);
  assert.deepEqual(authorizedGrant, {
    spaceId: "space-a",
    projectId: "project-a",
    sessionId: "session-a",
    cwd: "/workspace/a",
  });

  decision = "allow";
  captured = undefined;
  assert.equal(await bridge.route(rc as never), true);
  assert.equal(captured?.code, 200);
  assert.equal(executed, true);
  assert.deepEqual(executionContext, {
    spaceId: "space-a",
    projectId: "project-a",
    sessionId: "session-a",
    cwd: "/workspace/a",
  });
});

test("agent-tools MCP stdio uses newline-delimited JSON-RPC", async () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "agentToolsMcp.mjs");
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  const reply = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for MCP initialize"));
    }, 5_000);
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const line = out.split("\n").find((item) => item.startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      resolve(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (chunk.trim()) reject(new Error(chunk));
    });
    child.on("error", reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  });
  child.kill();
  assert.doesNotMatch(reply, /Content-Length/i);
  const message = JSON.parse(reply) as { result?: { serverInfo?: { name?: string } } };
  assert.equal(message.result?.serverInfo?.name, "polyth-agent-tools");
});

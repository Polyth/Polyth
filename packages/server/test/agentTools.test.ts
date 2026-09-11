import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentToolBridge, AGENT_TOOLS_PATH, redactToolInput } from "../src/agentTools.ts";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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
  assert.equal(await bridge.route({ ...rc, method: "GET" } as never), true);
  assert.deepEqual(captured, {
    code: 200,
    body: { tools: [{
      id: "example-feature.ping",
      name: "ping",
      description: "ping",
      inputSchema: { type: "object", properties: {} },
    }] },
  });
  captured = undefined;
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

test("agent tool bridge waits for asynchronous Polyth authorization", async () => {
  const registry = createCapabilityContributionRegistry();
  let executed = false;
  registry.register("example-feature", {
    descriptor: {
      id: "example-feature.write",
      kind: "tool",
      owner: "example-feature",
      scope: "project",
      revision: "1",
      name: "write",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      trust: "workspace",
      mutating: true,
    },
    execute: async () => {
      executed = true;
      return { output: "done" };
    },
  });
  let decide!: (decision: "allow" | "deny") => void;
  const authorization = new Promise<"allow" | "deny">((resolve) => { decide = resolve; });
  const bridge = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
    authorize: async () => authorization,
  });
  const descriptor = registry.list()[0]!.descriptor as Extract<import("@polyth/contracts").AgentCapabilityDescriptor, { kind: "tool" }>;
  const grant = bridge.mint({
    spaceId: "space-a",
    projectId: "project-a",
    cwd: "/workspace/a",
    tools: [descriptor],
  });
  let captured: { code: number; body: unknown } | undefined;
  const route = bridge.route({
    path: AGENT_TOOLS_PATH,
    method: "POST",
    ingress: { kind: "public-http", listenerId: "public", loopback: true, secure: false },
    req: { headers: { authorization: `Bearer ${grant.token}` } },
    body: async () => ({ id: descriptor.id, arguments: {} }),
    json: (code: number, body: unknown) => { captured = { code, body }; },
  } as never);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(executed, false);
  assert.equal(captured, undefined);
  decide("allow");
  assert.equal(await route, true);
  assert.equal(captured?.code, 200);
  assert.equal(executed, true);
});

test("agent tool bridge revalidates a contribution after asynchronous authorization", async () => {
  const registry = createCapabilityContributionRegistry();
  let executed = false;
  const registration = registry.register("example-feature", {
    descriptor: {
      id: "example-feature.write",
      kind: "tool",
      owner: "example-feature",
      scope: "project",
      revision: "1",
      name: "write",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      trust: "workspace",
      mutating: true,
    },
    execute: async () => {
      executed = true;
      return { output: "stale" };
    },
  });
  let decide!: (decision: "allow" | "deny") => void;
  const authorization = new Promise<"allow" | "deny">((resolve) => { decide = resolve; });
  const bridge = createAgentToolBridge({
    executor: (id) => registry.executor(id),
    contribution: (id) => registry.contribution(id),
    authorize: async () => authorization,
  });
  const descriptor = registry.list()[0]!.descriptor as Extract<import("@polyth/contracts").AgentCapabilityDescriptor, { kind: "tool" }>;
  const grant = bridge.mint({ spaceId: "space-a", projectId: "project-a", cwd: "/workspace/a", tools: [descriptor] });
  let captured: { code: number; body: unknown } | undefined;
  const route = bridge.route({
    path: AGENT_TOOLS_PATH,
    method: "POST",
    ingress: { kind: "public-http", listenerId: "public", loopback: true, secure: false },
    req: { headers: { authorization: `Bearer ${grant.token}` } },
    body: async () => ({ id: descriptor.id, arguments: {} }),
    json: (code: number, body: unknown) => { captured = { code, body }; },
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  registration.dispose();
  decide("allow");
  await route;

  assert.equal(executed, false);
  assert.equal(captured?.code, 404);
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

test("agent-tools MCP publishes native tool names and maps calls back to capability ids", async () => {
  let invokedId = "";
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") {
        res.end(JSON.stringify({ tools: [{
          id: "browser.polyth-browser",
          name: "polyth_browser",
          description: "Drive the controlled browser",
          inputSchema: { type: "object" },
        }] }));
        return;
      }
      invokedId = String(JSON.parse(Buffer.concat(chunks).toString("utf8")).id ?? "");
      res.end(JSON.stringify({ output: "opened" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "agentToolsMcp.mjs");
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      POLYTH_AGENT_TOOLS_URL: `http://127.0.0.1:${address.port}/internal/agent-tools`,
      POLYTH_AGENT_TOOLS_TOKEN: "test-token",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  const request = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const line = output.split("\n").find((candidate) => {
        try { return JSON.parse(candidate).id === id; } catch { return false; }
      });
      if (line) return JSON.parse(line) as { result: Record<string, unknown> };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for MCP response ${id}`);
  };
  try {
    const listed = await request(1, "tools/list") as { result: { tools?: Array<{ name?: string }> } };
    assert.equal(listed.result.tools?.[0]?.name, "polyth_browser");
    const called = await request(2, "tools/call", { name: "polyth_browser", arguments: { action: "browser.open" } });
    assert.equal(invokedId, "browser.polyth-browser");
    assert.deepEqual(called.result.content, [{ type: "text", text: "opened" }]);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("tool intent precedes authorization and execution uses the resolved canonical session", async () => {
  const registry = createCapabilityContributionRegistry();
  const order: string[] = [];
  const descriptor = { id: "browser.polyth-browser", owner: "browser", kind: "tool", name: "polyth_browser", scope: "project", revision: "1", description: "Browser", inputSchema: {}, trust: "device", mutating: true } as const;
  registry.register("browser", { descriptor, execute: async (_input, ctx) => { order.push(`execute:${ctx.sessionId}`); return { output: "ok" }; } });
  let decision: "allow" | "deny" = "deny";
  const bridge = createAgentToolBridge({
    executor: (id) => registry.executor(id), contribution: (id) => registry.contribution(id),
    resolveSession: async () => "canonical",
    requested: async (_tool, grant) => { order.push(`requested:${grant.sessionId}`); },
    authorize: async () => { order.push("permission"); return decision; },
  });
  const grant = bridge.mint({ spaceId: "a", projectId: "p", cwd: "/tmp", tools: [registry.contribution(descriptor.id)!.descriptor as typeof descriptor] });
  const rc = { path: AGENT_TOOLS_PATH, method: "POST", ingress: { kind: "public-http", loopback: true }, req: { headers: { authorization: `Bearer ${grant.token}` } }, body: async () => ({ id: descriptor.id }), json: () => {} };
  await bridge.route(rc as never);
  assert.deepEqual(order, ["requested:canonical", "permission"]);
  order.length = 0;
  decision = "allow";
  await bridge.route(rc as never);
  assert.deepEqual(order, ["requested:canonical", "permission", "execute:canonical"]);
});

test("disconnect or same-revision package reload during permission cannot execute a stale tool", async () => {
  const { EventEmitter } = await import("node:events");
  for (const reason of ["disconnect", "reload", "session-ended"] as const) {
    const registry = createCapabilityContributionRegistry();
    let executed = false;
    const descriptor = { id: "browser.polyth-browser", owner: "browser", kind: "tool", name: "polyth_browser", scope: "project", revision: "1", description: "Browser", inputSchema: {}, trust: "device", mutating: true } as const;
    const contribution = { descriptor, execute: async () => { executed = true; return { output: "bad" }; } };
    const registration = registry.register("browser", contribution);
    let approve!: (value: "allow") => void;
    let active = true;
    const bridge = createAgentToolBridge({
      executor: (id) => registry.executor(id), contribution: (id) => registry.contribution(id),
      resolveSession: async () => active ? "canonical" : undefined,
      authorize: () => new Promise((resolve) => { approve = resolve; }),
    });
    const grant = bridge.mint({ spaceId: "a", projectId: "p", cwd: "/tmp", tools: [registry.contribution(descriptor.id)!.descriptor as typeof descriptor] });
    const res = new EventEmitter();
    const pending = bridge.route({ path: AGENT_TOOLS_PATH, method: "POST", ingress: { kind: "public-http", loopback: true }, req: { headers: { authorization: `Bearer ${grant.token}` } }, res, body: async () => ({ id: descriptor.id }), json: () => {} } as never);
    for (let i = 0; i < 100 && !approve; i++) await new Promise((r) => setTimeout(r, 1));
    assert.ok(approve, "authorization was reached");
    if (reason === "disconnect") res.emit("close");
    if (reason === "reload") { registration.dispose(); registry.register("browser", { ...contribution }); }
    if (reason === "session-ended") active = false;
    approve("allow");
    await pending;
    assert.equal(executed, false, reason);
    assert.equal(res.listenerCount("close"), 0);
  }
});


test("write-only tool inputs are redacted without changing the execution input", () => {
  const input = { parameters: { selector: "#password", value: "private-password" }, action: "browser.type" };
  const output = redactToolInput(input, { properties: { parameters: { properties: { value: { writeOnly: true } } } } });
  assert.deepEqual(output, { parameters: { selector: "#password", value: "[redacted]" }, action: "browser.type" });
  assert.equal(input.parameters.value, "private-password");
});

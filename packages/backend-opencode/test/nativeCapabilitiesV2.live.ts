import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HarnessCapabilityApplicationReceipt, HarnessContext, HarnessProvisioningPlan } from "@polyth/contracts";
import { createOpenCodeProvisioner, peekOpenCodeLaunchOverlay } from "../src/provisioner.ts";
import { verifyOpenCodeCapabilities } from "../src/capabilityDelivery.ts";
import { createOwnedLocalEndpointLease } from "../src/endpoint.ts";

// No provider credentials or model inference: real binary, private configuration,
// deterministic local/remote MCP fixtures and the actual scoped Polyth bridge.
test("released V2 discovers private skills and MCP catalogs with private secret interpolation", {
  skip: !process.env.OPENCODE_COMPAT_BIN,
  timeout: 90_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-oc-v2-live-"));
  const storageDir = join(root, "space");
  mkdirSync(storageDir, { recursive: true });
  const originalEnv = { ...process.env };
  for (const [key, dir] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "xdg-config", XDG_DATA_HOME: "xdg-data", XDG_CACHE_HOME: "xdg-cache", XDG_STATE_HOME: "xdg-state" })) {
    process.env[key] = join(root, dir);
    mkdirSync(process.env[key]!, { recursive: true });
  }
  for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR"]) delete process.env[key];
  process.env.OPENCODE_DISABLE_MODELS_FETCH = "true";
  process.env.OPENCODE_CONFIG_PROJECT_DISABLE = "true";
  const secret = 'probe-secret-"quoted"';
  const bridgeToken = "isolated-bridge-token";
  const observed = { remoteAuthenticated: false, remoteCatalog: false, bridgeCatalog: false, bridgeCall: false };
  const bridgeScript = join(import.meta.dirname, "../../server/src/agentToolsMcp.mjs");
  const server = createServer(async (request, response) => {
    const bridge = request.url === "/bridge";
    if (request.headers.authorization !== `Bearer ${bridge ? bridgeToken : secret}`) {
      response.writeHead(401).end(); return;
    }
    if (!bridge) observed.remoteAuthenticated = true;
    if (request.method === "GET" && !bridge) { response.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    response.setHeader("content-type", "application/json");
    if (bridge) {
      if (request.method === "GET") {
        observed.bridgeCatalog = true;
        response.end(JSON.stringify({ tools: [{ id: "fixture.polyth", name: "polyth_probe", description: "Deterministic probe", inputSchema: { type: "object", properties: {} } }] }));
      } else {
        observed.bridgeCall = payload.id === "fixture.polyth";
        response.end(JSON.stringify({ output: "polyth-bridge-probe-ok" }));
      }
      return;
    }
    if (payload.id === undefined) { response.writeHead(202).end(); return; }
    if (payload.method === "tools/list") observed.remoteCatalog = true;
    const result = payload.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "remote-probe", version: "1" } }
      : payload.method === "tools/list"
        ? { tools: [{ name: "probe", description: "Probe", inputSchema: { type: "object", properties: {} } }] }
        : {};
    response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
  });
  let lease: Awaited<ReturnType<typeof createOwnedLocalEndpointLease>> | undefined;
  const context: HarnessContext = { spaceId: "space", projectId: "project", cwd: root, space: {
    spaceId: "space", spaceSlug: "space", storageDir, userId: "user", role: "owner", deployment: "local-trusted",
  } };
  const provisioner = createOpenCodeProvisioner({} as never);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const fixtureUrl = `http://127.0.0.1:${address.port}`;
    const auditPath = join(root, "local-mcp-audit.json");
    const fixture = join(import.meta.dirname, "fixtures", "capabilityMcp.mjs");
    const plan: HarnessProvisioningPlan = { harnessId: "opencode", desiredRevision: "v2", items: [
      { capability: { id: "fixture.skill", owner: "fixture", kind: "skill", scope: "project", revision: "v2", name: "probe", title: "Probe", description: "Probe", instructions: "Probe." }, mode: "filesystem", mutability: "requires-restart" },
      { capability: { id: "fixture.local", owner: "fixture", kind: "mcp-server", scope: "project", revision: "v2", name: "local-probe", enabled: true, transport: { kind: "stdio", command: process.execPath, args: [fixture], envKeys: ["POLYTH_PROBE_SECRET", "POLYTH_PROBE_AUDIT"] } }, mode: "config", mutability: "requires-restart" },
      { capability: { id: "fixture.remote", owner: "fixture", kind: "mcp-server", scope: "project", revision: "v2", name: "remote-probe", enabled: true, transport: { kind: "http", url: `${fixtureUrl}/mcp`, headersSecretRefs: ["Authorization"] } }, mode: "config", mutability: "requires-restart" },
      { capability: { id: "polyth.agent-tools", owner: "polyth", kind: "mcp-server", scope: "project", revision: "v2", name: "polyth-agent-tools", enabled: true, transport: { kind: "stdio", command: process.execPath, args: [bridgeScript], envKeys: ["POLYTH_AGENT_TOOLS_URL", "POLYTH_AGENT_TOOLS_TOKEN"] } }, mode: "config", mutability: "requires-restart" },
    ] };
    await provisioner.apply(context, plan, { mcpSecrets: (id): Record<string, string> => id === "fixture.local"
      ? { POLYTH_PROBE_SECRET: secret, POLYTH_PROBE_AUDIT: auditPath }
      : id === "fixture.remote" ? { Authorization: `Bearer ${secret}` }
        : { POLYTH_AGENT_TOOLS_URL: `${fixtureUrl}/bridge`, POLYTH_AGENT_TOOLS_TOKEN: bridgeToken } });
    const overlay = peekOpenCodeLaunchOverlay(context)!;
    assert.ok(overlay.configPath);
    assert.ok(!overlay.configContent.includes(secret) && !overlay.configContent.includes(bridgeToken));
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    const userConfig = JSON.stringify({
      provider: { fixture: { blacklist: ["hidden"], name: "Fixture", npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:1/v1" }, models: { hidden: { name: "Hidden" }, visible: { name: "Visible" } } } },
      providers: { fixture: { name: "Fixture", package: "@ai-sdk/openai-compatible", settings: { baseURL: "http://127.0.0.1:1/v1" }, models: { hidden: { name: "Hidden", limit: { context: 1000 } }, visible: { name: "Visible" } } } },
    });
    writeFileSync(join(configDir, "opencode.json"), userConfig);
    lease = await createOwnedLocalEndpointLease({ projectId: "project", spaceId: "space", cwd: root,
      runtimeDir: join(root, "runtime"), configDir: join(root, "config"), pidFile: join(root, "pid.json"), stateFile: join(root, "state.json"),
      bin: originalEnv.OPENCODE_COMPAT_BIN, listenTimeoutMs: 25_000 });
    const endpoint = await lease.endpoint();
    const authentication = endpoint.authentication;
    const headers = authentication.kind === "endpoint-headers" ? await authentication.resolve() : {};
    const urlFor = (path: string) => { const url = new URL(path, endpoint.url); url.searchParams.set("location[directory]", root); return url; };
    const get = async (path: string) => {
      const response = await fetch(urlFor(path), { headers, signal: AbortSignal.timeout(15_000) });
      assert.equal(response.ok, true, `${path}: ${response.status}`);
      return response.json();
    };
    const documents = await get("/api/config") as Array<{ info?: { skills?: string[]; mcp?: { servers?: Record<string, { environment?: Record<string, string>; headers?: Record<string, string> }> } } }>;
    const visibility = documents as Array<{ info?: { providers?: Record<string, { models?: Record<string, { disabled?: boolean; limit?: { context?: number } }> }> } }>;
    assert.ok(visibility.some((entry) => entry.info?.providers?.fixture?.models?.hidden?.disabled === true));
    assert.ok(visibility.some((entry) => entry.info?.providers?.fixture?.models?.hidden?.limit?.context === 1000));
    assert.equal(readFileSync(join(configDir, "opencode.json"), "utf8"), userConfig);
    assert.ok(documents.some((entry) => entry.info?.skills?.some((path) => overlay.skills![0]!.path.startsWith(`${path}/`))));
    const configMcp = documents.flatMap((entry) => entry.info?.mcp?.servers ? [entry.info.mcp.servers] : []);
    // Assert effective substitution without printing credentials from readback.
    assert.ok(configMcp.some((servers) => servers["local-probe"]?.environment?.POLYTH_PROBE_SECRET === secret));
    assert.ok(configMcp.some((servers) => servers["remote-probe"]?.headers?.Authorization === `Bearer ${secret}`));
    const ready = await fetch(urlFor("/api/plugin/await-activation"), { method: "POST", headers, signal: AbortSignal.timeout(20_000) });
    assert.equal(ready.status, 204);
    let models = await get("/api/model") as { data: Array<{ providerID: string; id: string }> };
    const catalogDeadline = Date.now() + 5000;
    while (!models.data.some((model) => model.providerID === "fixture") && Date.now() < catalogDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      models = await get("/api/model") as typeof models;
    }
    assert.ok(models.data.some((model) => model.providerID === "fixture" && model.id === "visible"), "visible fixture model must remain in the native catalog");
    assert.ok(!models.data.some((model) => model.providerID === "fixture" && model.id === "hidden"));
    const receipts: HarnessCapabilityApplicationReceipt[] = [];
    await verifyOpenCodeCapabilities(overlay, { spaceId: "space", projectId: "project", cwd: root, harnessId: "opencode", authorityId: endpoint.authorityId, generation: endpoint.generation }, get, (receipt) => receipts.push(receipt), "v2");
    assert.equal(receipts.length, 4);
    assert.ok(receipts.every((receipt) => receipt.outcome === "applied"), JSON.stringify(receipts));
    assert.deepEqual(JSON.parse(readFileSync(auditPath, "utf8")), { catalog: true, secretMatched: true });
    assert.ok(observed.remoteAuthenticated && observed.remoteCatalog && observed.bridgeCatalog);
    // Exercise the actual bridge call separately: native catalog discovery above
    // does not establish a native model-triggered invocation.
    const called = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [bridgeScript], { env: { ...process.env, POLYTH_AGENT_TOOLS_URL: `${fixtureUrl}/bridge`, POLYTH_AGENT_TOOLS_TOKEN: bridgeToken }, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      const timeout = setTimeout(() => { child.kill(); reject(new Error("bridge probe timed out")); }, 10_000);
      child.on("error", reject);
      child.stdout.on("data", (data) => { output += data; if (output.includes("\n")) child.stdin.end(); });
      child.once("exit", (code) => { clearTimeout(timeout); code === 0 ? resolve(output) : reject(new Error(`bridge exited ${code}`)); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "polyth_probe", arguments: {} } }) + "\n");
    });
    assert.equal(JSON.parse(called).result.content[0].text, "polyth-bridge-probe-ok");
    assert.equal(observed.bridgeCall, true);
  } finally {
    try { await lease?.dispose(); } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      provisioner.release?.(context);
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

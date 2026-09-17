/**
 * Opt-in V2 execution evidence with a deterministic loopback OpenAI-compatible
 * provider. It never uses a provider credential or an Internet endpoint.
 *
 * OPENCODE_COMPAT_BIN=/tmp/polyth-opencode-v2-arm/bin/opencode \
 *   node --experimental-strip-types --test packages/backend-opencode/test/releasedInference.live.ts
 */
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject, ModelRef, RuntimeEndpoint, RuntimeSessionBinding } from "@polyth/contracts";
import {
  createConfigApplier,
  createOpenCodeRuntime,
  type ManagedOpenCodeRuntime,
  type OwnedRuntimeLifecycle,
} from "../src/index.ts";

type OwnedInferenceRuntime = ManagedOpenCodeRuntime & {
  lifecycle: OwnedRuntimeLifecycle;
  protocol: NonNullable<ManagedOpenCodeRuntime["protocol"]>;
};

const binary = process.env.OPENCODE_COMPAT_BIN;
const LIVE = {
  skip: binary ? false : "set OPENCODE_COMPAT_BIN to run against a released OpenCode V2 binary",
  timeout: 120_000,
  concurrency: false,
};

const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 20_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
};

const waitForAsync = async (
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
};

const nativeGet = async (runtime: OwnedInferenceRuntime, path: string): Promise<unknown> => {
  const endpoint = await runtime.endpoint!();
  const url = new URL(path, endpoint.url);
  url.searchParams.set("directory", endpoint.location.directory);
  const headers = endpoint.authentication.kind === "endpoint-headers"
    ? await endpoint.authentication.resolve()
    : {};
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.text() };
};

const nativePost = async (
  runtime: OwnedInferenceRuntime,
  path: string,
  body: JsonObject,
): Promise<unknown> => {
  const endpoint = await runtime.endpoint!();
  const url = new URL(path, endpoint.url);
  url.searchParams.set("directory", endpoint.location.directory);
  const headers = new Headers(endpoint.authentication.kind === "endpoint-headers"
    ? await endpoint.authentication.resolve()
    : {});
  headers.set("content-type", "application/json");
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  return raw ? JSON.parse(raw) : undefined;
};

const reconciliationBinding = (
  endpoint: RuntimeEndpoint,
  canonicalSessionId: string,
  backendSessionId: string,
): RuntimeSessionBinding & { reconciliationOrdinal: number } => ({
  canonicalSessionId,
  backendSessionId,
  authorityId: endpoint.authorityId,
  generation: endpoint.generation,
  continuity: endpoint.continuity,
  location: endpoint.location,
  reconciliationOrdinal: 1,
});

const textOfMessages = (value: unknown): string => {
  if (!Array.isArray(value)) return "";
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const content = (entry as { content?: unknown }).content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    );
  }).join("\n");
};

interface CompletionRequest {
  body: Record<string, unknown>;
  response: ServerResponse;
  closed: boolean;
  held: boolean;
  toolNames: string[];
}

const toolNamesOf = (value: unknown): string[] => Array.isArray(value)
  ? value.flatMap((entry) => {
    const tool = entry && typeof entry === "object" ? entry as { function?: { name?: unknown } } : undefined;
    return typeof tool?.function?.name === "string" ? [tool.function.name] : [];
  })
  : [];

const createFixtureProvider = async (): Promise<{
  baseUrl: string;
  bridgeUrl: string;
  requests: CompletionRequest[];
  bridgeCalls(): number;
  destroyHeld(): void;
  dispose(): Promise<void>;
}> => {
  const requests: CompletionRequest[] = [];
  let bridgeCallCount = 0;
  const server = createServer(async (req, response) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: "list", data: [{ id: "fixture", object: "model" }] }));
      return;
    }
    if (path === "/bridge") {
      if (req.headers.authorization !== "Bearer isolated-bridge-token") {
        response.writeHead(401).end();
        return;
      }
      if (req.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          tools: [{
            id: "fixture.polyth",
            name: "polyth_probe",
            description: "Return the deterministic native bridge receipt",
            inputSchema: { type: "object", properties: {} },
          }],
        }));
        return;
      }
      if (req.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: unknown };
      bridgeCallCount += body.id === "fixture.polyth" ? 1 : 0;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ output: "polyth-bridge-probe-ok" }));
      return;
    }
    if (req.method !== "POST" || path !== "/v1/chat/completions") {
      response.statusCode = 404;
      response.end("fixture route not found");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      body = value as Record<string, unknown>;
    } catch {
      response.statusCode = 400;
      response.end("invalid fixture request");
      return;
    }
    const item: CompletionRequest = {
      body,
      response,
      closed: false,
      held: /first held request/.test(textOfMessages(body.messages))
        && !/You are a title generator/.test(textOfMessages(body.messages)),
      toolNames: toolNamesOf(body.tools),
    };
    requests.push(item);
    req.once("close", () => { item.closed = true; });
    // Keep the requested provider turn open so the real OpenCode session is busy
    // while the facade sends both steering and queued work, then interrupts it.
    if (item.held) return;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta: Record<string, unknown>, finish_reason: string | null) => JSON.stringify({
      id: "chatcmpl_fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    });
    const requestJson = JSON.stringify(body.messages);
    const asksForTool = /use native polyth probe/.test(textOfMessages(body.messages));
    const hasToolResult = requestJson.includes("call_fixture") || requestJson.includes("polyth-bridge-probe-ok");
    const nativeBridgeTool = item.toolNames.find((name) => name.includes("polyth"));
    if (asksForTool && !hasToolResult && nativeBridgeTool) {
      response.write(`data: ${chunk({
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: "call_fixture",
          type: "function",
          function: { name: nativeBridgeTool, arguments: "{}" },
        }],
      }, null)}\n\n`);
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      response.write(`data: ${chunk({}, "tool_calls")}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.write(`data: ${chunk({ role: "assistant", content: hasToolResult ? "fixture tool answer" : "fixture answer" }, null)}\n\n`);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    response.write(`data: ${chunk({}, "stop")}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    bridgeUrl: `http://127.0.0.1:${address.port}/bridge`,
    requests,
    bridgeCalls: () => bridgeCallCount,
    destroyHeld() {
      const held = requests.find((request) => request.held);
      if (held && !held.response.destroyed) held.response.destroy();
    },
    async dispose() {
      for (const request of requests) {
        if (!request.response.destroyed) request.response.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

test("live: released V2 runs local prompt, queue, interrupt, SSE, and MCP permission delivery", LIVE, async () => {
  assert.ok(binary);
  assert.ok(existsSync(binary), `OPENCODE_COMPAT_BIN does not exist: ${binary}`);
  const provider = await createFixtureProvider();
  const root = await mkdtemp(join(tmpdir(), "polyth-opencode-inference-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const configDir = join(root, "config");
  const runtimeDir = join(root, "runtime");
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(configDir), mkdir(runtimeDir)]);
  const bridgeScript = join(import.meta.dirname, "../../server/src/agentToolsMcp.mjs");
  await writeFile(join(configDir, "opencode.json"), JSON.stringify({
    permissions: [{
      // The released provider request exposes its direct MCP function as
      // `server-name_tool`, retaining the server hyphen.
      action: "polyth-agent-tools_polyth_probe",
      resource: "*",
      effect: "ask",
    }],
    mcp: {
      servers: {
        "polyth-agent-tools": {
          type: "local",
          command: [process.execPath, bridgeScript],
          // The V2 default Code Mode hides MCP tools behind execute/search.
          // This fixture intentionally verifies a direct model function call.
          codemode: false,
          environment: {
            POLYTH_AGENT_TOOLS_URL: provider.bridgeUrl,
            POLYTH_AGENT_TOOLS_TOKEN: "isolated-bridge-token",
          },
        },
      },
    },
  }));
  const config = createConfigApplier({ configDir });
  await config.applyCustomProvider({
    id: "fixture",
    name: "Loopback fixture",
    protocol: "openai-compatible",
    baseURL: provider.baseUrl,
  });
  await config.addManualModel("fixture", { id: "fixture", name: "Fixture model" });

  const savedEnvironment = new Map<string, string | undefined>();
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
    savedEnvironment.set(key, process.env[key]);
  }
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, "config");
  process.env.XDG_DATA_HOME = join(home, "data");
  process.env.XDG_CACHE_HOME = join(home, "cache");

  let runtime: OwnedInferenceRuntime | undefined;
  try {
    runtime = await createOpenCodeRuntime({
      projectId: "released-inference",
      cwd: workspace,
      bin: binary,
      binarySource: "configured",
      configDir,
      runtimeDir,
      stateFile: join(root, "state.json"),
      startupDeadlineMs: 25_000,
      probeDeadlineMs: 2_000,
    }) as OwnedInferenceRuntime;
    assert.equal(await runtime.protocol(), "v2", "this test is V2 execution evidence");

    const model: ModelRef = { providerID: "fixture", modelID: "fixture" };
    // The fixture model is selected explicitly below. The released server's
    // catalog deliberately reports no connected providers before a credential
    // is configured, even when a local configured model is runnable.
    const canonicalSessionId = "inference-session";
    const backendSessionId = await runtime.ensureSession({
      projectId: "released-inference",
      sessionId: canonicalSessionId,
      title: "Loopback inference",
      cwd: workspace,
    });

    const events: Array<{ type: string; text?: string; reason?: string }> = [];
    const subscription = runtime.onEvent((sessionId, event) => {
      if (sessionId !== canonicalSessionId) return;
      if (event.type === "assistant/message") events.push({ type: event.type, text: event.text });
      if (event.type === "turn/stopped") events.push({ type: event.type, reason: event.reason });
    });
    try {
      const first = await runtime.startTurnOperation!({
        sessionId: canonicalSessionId,
        text: "first held request",
        model,
      }, "inference-first");
      assert.equal(first.kind, "confirmed");
      try {
        await waitFor(
          () => provider.requests.some((request) => request.held) || events.some((event) => event.type === "turn/stopped"),
          "OpenCode neither contacted the loopback provider nor reported a terminal error",
        );
      } catch {
        const endpoint = await runtime.endpoint!();
        throw new Error(`OpenCode did not reach the loopback provider: ${JSON.stringify({
          events,
          provider: await nativeGet(runtime, "/api/provider"),
          models: await nativeGet(runtime, "/api/model"),
          active: await nativeGet(runtime, "/api/session/active"),
          inbox: await nativeGet(runtime, `/api/session/${backendSessionId}/inbox`),
          messages: await nativeGet(runtime, `/api/session/${backendSessionId}/message?limit=20&order=asc`),
          endpoint: endpoint.url,
        })}`);
      }
      const held = provider.requests.find((request) => request.held);
      assert.ok(held, `OpenCode did not reach the loopback provider: ${JSON.stringify(events)}`);
      assert.equal(held.body.model, "fixture");
      assert.match(textOfMessages(held.body.messages), /first held request/);

      const steer = await runtime.steerOperation!(canonicalSessionId, "steered input", "inference-steer", model);
      assert.equal(steer.kind, "confirmed");
      const queued = await nativePost(runtime, `/api/session/${encodeURIComponent(backendSessionId)}/prompt`, {
        text: "native queued input",
        delivery: "queue",
      });
      assert.equal(typeof (queued as { data?: { id?: unknown } })?.data?.id, "string");
      const interrupted = await runtime.abortOperation!(canonicalSessionId, "inference-interrupt");
      assert.equal(interrupted.kind, "confirmed");
      // OpenCode confirms the session interrupt independently of the provider
      // socket. Close our intentionally held test response to release this
      // fixture; the durable interrupt receipt is the assertion here.
      provider.destroyHeld();
      await waitFor(() => held.response.destroyed === true, "fixture did not release held response");

      // The interrupted native leg is not replayed. Start a fresh backend leg
      // and require a completed provider stream plus durable history instead.
      const completedBackendSessionId = await runtime.resetSession!({
        projectId: "released-inference",
        sessionId: canonicalSessionId,
        title: "Loopback completion",
        cwd: workspace,
      });
      let streamReconnected = false;
      const lifecycleSubscription = runtime.onLifecycle?.((event) => {
        if (event.type === "stream-connected") streamReconnected = true;
      });
      try {
        await runtime.lifecycle.restart("manual");
        await waitFor(() => streamReconnected, "SSE did not reconnect before completed provider evidence");
      } finally {
        lifecycleSubscription?.dispose();
      }
      const completed = await runtime.startTurnOperation!({
        sessionId: canonicalSessionId,
        text: "completed request",
        model,
      }, "inference-completed");
      assert.equal(completed.kind, "confirmed");
      const completedRuntime = runtime;
      assert.ok(completedRuntime);
      await waitForAsync(async () => (await completedRuntime.history(canonicalSessionId)).some((entry) =>
        entry.role === "assistant" && entry.text === "fixture answer"), "completed loopback provider output was not durable");
      await waitFor(
        () => events.some((event) => event.type === "assistant/message" && event.text === "fixture answer"),
        "released V2 SSE did not emit the streamed assistant text before pull reconciliation",
      );
      const history = await runtime.history(canonicalSessionId);
      assert.deepEqual(history, [
        { role: "user", text: "completed request" },
        { role: "assistant", text: "fixture answer" },
      ]);
      const endpoint = await runtime.endpoint!();
      const nativeMessages = await nativeGet(
        runtime,
        `/api/session/${encodeURIComponent(completedBackendSessionId)}/message?limit=20&order=asc`,
      );
      const snapshot = await runtime.reconcile!(
        reconciliationBinding(endpoint, canonicalSessionId, completedBackendSessionId),
      );
      assert.equal(
        snapshot.events.some((entry) => entry.events.some((event) => event.type === "assistant/message")),
        true,
        JSON.stringify({
          events: snapshot.events.map((entry) => ({
            entityKey: entry.entityKey,
            events: entry.events,
          })),
          nativeMessages,
        }),
      );
      assert.equal(provider.requests.some((request) => /completed request/.test(textOfMessages(request.body.messages))), true);

      // The provider returns a native function call. OpenCode resolves it to
      // the launched Polyth stdio bridge, raises the configured ask rule, and
      // resumes only after the facade's native permission reply.
      const toolBackendSessionId = await runtime.resetSession!({
        projectId: "released-inference",
        sessionId: canonicalSessionId,
        title: "Loopback MCP permission",
        cwd: workspace,
      });
      const toolTurn = await runtime.startTurnOperation!({
        sessionId: canonicalSessionId,
        text: "use native polyth probe",
        model,
      }, "inference-tool");
      assert.equal(toolTurn.kind, "confirmed");
      const toolEndpoint = await runtime.endpoint!();
      const toolBinding = reconciliationBinding(toolEndpoint, canonicalSessionId, toolBackendSessionId);
      let permissionId: string | undefined;
      let lastPending: Awaited<ReturnType<NonNullable<typeof runtime.reconcile>>> | undefined;
      try {
        await waitForAsync(async () => {
          const pending = await runtime!.reconcile!(toolBinding);
          lastPending = pending;
          permissionId = pending.permissions.find((permission) =>
          permission.permission === "polyth-agent-tools_polyth_probe")?.requestId;
          return Boolean(permissionId);
        }, "native MCP tool call did not produce the configured permission request");
      } catch {
        throw new Error(JSON.stringify({
          pending: lastPending,
          mcp: await nativeGet(runtime, "/api/mcp"),
          tools: await nativeGet(runtime, "/api/tool"),
          messages: await nativeGet(runtime, `/api/session/${encodeURIComponent(toolBackendSessionId)}/message?limit=20&order=asc`),
          providerRequests: provider.requests.map((request) => ({
            text: textOfMessages(request.body.messages),
            toolNames: request.toolNames,
          })),
        }));
      }
      assert.ok(permissionId);
      const permissionReply = await runtime.replyPermissionOperation!(
        canonicalSessionId,
        permissionId,
        "once",
        "inference-tool-permission",
      );
      assert.equal(permissionReply.kind, "confirmed");
      await waitFor(() => provider.bridgeCalls() === 1, "released OpenCode did not invoke the Polyth stdio MCP bridge");
      await waitForAsync(async () => (await runtime!.history(canonicalSessionId)).some((entry) =>
        entry.role === "assistant" && entry.text === "fixture tool answer"), "tool result did not resume the provider turn");
      assert.equal(provider.requests.some((request) => {
        const tools = request.body.tools;
        return Array.isArray(tools) && tools.some((tool) => JSON.stringify(tool).includes("polyth-agent-tools_polyth_probe"));
      }), true, "OpenCode did not expose the launched bridge tool to the local provider");
    } finally {
      subscription.dispose();
    }
  } finally {
    await runtime?.dispose().catch(() => undefined);
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await provider.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

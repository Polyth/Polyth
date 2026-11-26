#!/usr/bin/env node
// Stdio MCP adapter for Polyth package tools. Speaks newline-delimited MCP
// JSON-RPC (the same framing as packages/polyth-mcp). Secret values never
// appear here; the bearer token is an opaque handle.
//
// With `--cli` first it is `polyth-tools` instead: the same tools from the
// agent's own shell, under the chat's grant read from the file
// POLYTH_TOOLS_GRANT_FILE names (rewritten by the server when the grant
// changes). See docs/dev/cli.md.
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const cliMode = process.argv[2] === "--cli";
const cliGrant = () => {
  const file = process.env.POLYTH_TOOLS_GRANT_FILE ?? "";
  try {
    const grant = JSON.parse(readFileSync(file, "utf8"));
    if (typeof grant?.url === "string" && typeof grant?.token === "string") return grant;
  } catch {}
  return undefined;
};
const grant = cliMode ? cliGrant() : undefined;
const url = grant ? grant.url : process.env.POLYTH_AGENT_TOOLS_URL ?? "";
const token = grant ? grant.token : process.env.POLYTH_AGENT_TOOLS_TOKEN ?? "";
const capabilityIds = new Map();
const pending = new Map();

const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function call(method, body, signal) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = (target.protocol === "https:" ? httpsRequest : httpRequest)({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8") || "{}";
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { parsed = { error: { message: body } }; }
        if ((res.statusCode ?? 500) >= 400) {
          const err = parsed.error ?? {};
          resolve({ error: { code: err.code ?? "tool-failed", message: err.message ?? `agent tools HTTP ${res.statusCode}` } });
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function handle(message, signal) {
  if (!message || message.jsonrpc !== "2.0" || !message.method) return null;
  if (message.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "polyth-agent-tools", version: "0.1.0" },
    };
  }
  if (message.method === "notifications/initialized" || message.method === "initialized") return undefined;
  if (message.method === "ping") return {};
  if (message.method === "tools/list") {
    const listed = await call("GET", undefined, signal);
    const tools = Array.isArray(listed.tools) ? listed.tools : [];
    capabilityIds.clear();
    for (const tool of tools) capabilityIds.set(tool.name, tool.id);
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      })),
    };
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (!capabilityIds.has(name)) await handle({ jsonrpc: "2.0", method: "tools/list" }, signal);
    // OpenCode puts the native session correlation in _meta, outside model arguments.
    const meta = message.params?._meta;
    const runtimeSessionId = typeof meta?.sessionID === "string"
      ? meta.sessionID
      : typeof meta?.sessionId === "string" ? meta.sessionId : undefined;
    const result = await call("POST", {
      id: capabilityIds.get(name) ?? name,
      arguments: message.params?.arguments ?? {},
      ...(runtimeSessionId ? { runtimeSessionId } : {}),
    }, signal);
    if (result.error) {
      return { content: [{ type: "text", text: result.error.message ?? "tool failed" }], isError: true };
    }
    return { content: [{ type: "text", text: String(result.output ?? "") }] };
  }
  throw new Error(`unsupported method: ${message.method}`);
}

function serveMcp() {
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message?.method) return;
  if (message.method === "notifications/cancelled") {
    pending.get(message.params?.requestId)?.abort();
    return;
  }
  const controller = new AbortController();
  if (message.id !== undefined) {
    pending.get(message.id)?.abort();
    pending.set(message.id, controller);
  }
  try {
    const result = await handle(message, controller.signal);
    if (result === undefined || message.id === undefined) return;
    output({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    if (message.id === undefined) return;
    output({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: error instanceof Error ? error.message : "tool bridge failed" },
    });
  } finally {
    if (pending.get(message.id) === controller) pending.delete(message.id);
  }
});
const abortPending = () => { for (const request of pending.values()) request.abort(); };
rl.on("close", abortPending);
process.stdout.on("error", abortPending);
}

const CLI_USAGE = `polyth-tools — Polyth's agent tools from the shell (the same tools and grant as this chat's MCP tools)

  polyth-tools list                    every tool, one line each
  polyth-tools describe <tool>         a tool's description and input schema
  polyth-tools call <tool> [json|-]    run a tool; arguments as a JSON object, or - to read them from stdin

Example: polyth-tools call polyth '{"action":"session.messages","parameters":{"sessionId":"<id>"}}'
`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const firstLine = (text) => String(text ?? "").split("\n")[0].slice(0, 160);

async function runCli(argv) {
  const [command, name, raw] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(CLI_USAGE);
    return command ? 0 : 2;
  }
  if (!grant) {
    process.stderr.write("polyth-tools: Polyth tools are not available in this shell (no grant for this chat).\n");
    return 3;
  }
  const listed = await call("GET");
  if (listed.error) {
    process.stderr.write(`polyth-tools: ${listed.error.message ?? "tools unavailable"}\n`);
    return 1;
  }
  const tools = Array.isArray(listed.tools) ? listed.tools : [];
  if (command === "list") {
    for (const tool of tools) process.stdout.write(`${tool.name}\t${firstLine(tool.description)}\n`);
    return 0;
  }
  const tool = tools.find((item) => item.name === name);
  if (command !== "describe" && command !== "call") {
    process.stderr.write(`polyth-tools: unknown command "${command}"\n${CLI_USAGE}`);
    return 2;
  }
  if (!tool) {
    process.stderr.write(`polyth-tools: no tool "${name ?? ""}" here; run polyth-tools list\n`);
    return 2;
  }
  if (command === "describe") {
    process.stdout.write(`${tool.name}\n\n${tool.description ?? ""}\n\nInput schema:\n${JSON.stringify(tool.inputSchema ?? {}, null, 2)}\n`);
    return 0;
  }
  let args = {};
  const text = raw === "-" ? await readStdin() : raw;
  if (text !== undefined && text.trim()) {
    try { args = JSON.parse(text); } catch {
      process.stderr.write("polyth-tools: arguments must be one JSON object\n");
      return 2;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      process.stderr.write("polyth-tools: arguments must be one JSON object\n");
      return 2;
    }
  }
  const result = await call("POST", { id: tool.id ?? tool.name, arguments: args });
  if (result.error) {
    process.stderr.write(`${result.error.message ?? "tool failed"}\n`);
    return 1;
  }
  const output = String(result.output ?? "");
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
  return 0;
}

// Last, after every declaration above has initialized.
if (cliMode) {
  process.exitCode = await runCli(process.argv.slice(3)).catch((error) => {
    process.stderr.write(`polyth-tools: Polyth did not answer (${error instanceof Error ? error.message : "request failed"})\n`);
    return 1;
  });
}
else serveMcp();

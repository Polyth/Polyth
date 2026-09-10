#!/usr/bin/env node
// Stdio MCP adapter for Polyth package tools. Speaks newline-delimited MCP
// JSON-RPC (the same framing as packages/polyth-mcp). Secret values never
// appear here; the bearer token is an opaque handle.
import { createInterface } from "node:readline";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const url = process.env.POLYTH_AGENT_TOOLS_URL ?? "";
const token = process.env.POLYTH_AGENT_TOOLS_TOKEN ?? "";
const capabilityIds = new Map();

const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function call(method, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = (target.protocol === "https:" ? httpsRequest : httpRequest)({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
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

async function handle(message) {
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
    const listed = await call("GET");
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
    if (!capabilityIds.has(name)) await handle({ jsonrpc: "2.0", method: "tools/list" });
    const result = await call("POST", { id: capabilityIds.get(name) ?? name, arguments: message.params?.arguments ?? {} });
    if (result.error) {
      return { content: [{ type: "text", text: result.error.message ?? "tool failed" }], isError: true };
    }
    return { content: [{ type: "text", text: String(result.output ?? "") }] };
  }
  throw new Error(`unsupported method: ${message.method}`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message?.method) return;
  try {
    const result = await handle(message);
    if (result === undefined || message.id === undefined) return;
    output({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    if (message.id === undefined) return;
    output({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: error instanceof Error ? error.message : "tool bridge failed" },
    });
  }
});

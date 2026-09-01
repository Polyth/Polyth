#!/usr/bin/env node
import { createInterface } from "node:readline";

const baseUrl = (process.env.POLYTH_URL ?? "http://127.0.0.1:4400").replace(/\/$/, "");

type Json = Record<string, unknown>;

const tools = [
  {
    name: "polyth_list_sessions",
    description: "List sessions from a Polyth server, optionally filtered by project, status, or archive state.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        status: { type: "string", description: "Comma-separated statuses." },
        archived: { type: "string", enum: ["include", "exclude", "only"] },
        limit: { type: "number", minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: "polyth_get_session",
    description: "Read one Polyth session with its recent events, derived messages, and runtime state.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: { type: "string" }, eventLimit: { type: "number", minimum: 1, maximum: 500 } },
    },
  },
  {
    name: "polyth_send_message",
    description: "Send a message to an existing Polyth session. The message is persisted before it reaches the agent runtime.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "text"],
      properties: {
        sessionId: { type: "string" },
        text: { type: "string" },
        delivery: { type: "string", enum: ["normal", "steer", "queue", "interrupt"] },
        agent: { type: "string" },
        autoTitle: { type: "boolean" },
      },
    },
  },
  {
    name: "polyth_create_session",
    description: "Create a Polyth session; optionally send its first message.",
    inputSchema: {
      type: "object",
      required: ["projectId"],
      properties: {
        projectId: { type: "string" }, title: { type: "string" }, agent: { type: "string" },
        worktreePath: { type: "string" }, message: { type: "string" },
      },
    },
  },
  {
    name: "polyth_session_action",
    description: "Cancel, archive, or unarchive a Polyth session.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "action"],
      properties: { sessionId: { type: "string" }, action: { type: "string", enum: ["cancel", "archive", "unarchive"] } },
    },
  },
];

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.text();
  let value: unknown = body;
  try { value = JSON.parse(body); } catch { /* non-JSON server error */ }
  if (!response.ok) throw new Error(typeof value === "string" ? value : JSON.stringify(value));
  return value;
}

function content(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function call(name: string, args: Json): Promise<unknown> {
  const id = encodeURIComponent(String(args.sessionId ?? ""));
  if (name === "polyth_list_sessions") {
    const query = new URLSearchParams();
    for (const key of ["projectId", "status", "archived", "limit"]) if (args[key] !== undefined) query.set(key, String(args[key]));
    return api(`/api/agent/sessions${query.size ? `?${query}` : ""}`);
  }
  if (name === "polyth_get_session") {
    const query = args.eventLimit === undefined ? "" : `?eventLimit=${encodeURIComponent(String(args.eventLimit))}`;
    return api(`/api/agent/sessions/${id}${query}`);
  }
  if (name === "polyth_send_message") {
    const { sessionId: _, ...body } = args;
    return api(`/api/agent/sessions/${id}/messages`, { method: "POST", body: JSON.stringify(body) });
  }
  if (name === "polyth_create_session") return api("/api/agent/sessions", { method: "POST", body: JSON.stringify(args) });
  if (name === "polyth_session_action") return api(`/api/agent/sessions/${id}/${encodeURIComponent(String(args.action))}`, { method: "POST", body: "{}" });
  throw new Error(`unknown tool: ${name}`);
}

const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let request: { id?: string | number | null; method?: string; params?: Json };
  try { request = JSON.parse(line) as typeof request; } catch { return; }
  if (!request.method) return;
  try {
    let result: unknown;
    if (request.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "polyth", version: "0.1.0" } };
    else if (request.method === "tools/list") result = { tools };
    else if (request.method === "tools/call") {
      const params = request.params ?? {};
      result = content(await call(String(params.name), (params.arguments ?? {}) as Json));
    } else throw new Error(`unsupported method: ${request.method}`);
    if (request.id !== undefined) output({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    if (request.id !== undefined) output({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
});

#!/usr/bin/env node
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface ControlRequest { method: Method; path: string; body?: Json; spaceId?: string }

interface Action {
  group: string;
  description: string;
  request(input: Json): ControlRequest;
}

const required = (input: Json, key: string): string => {
  const value = input[key];
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) throw new Error(`${key} is required`);
  return encodeURIComponent(String(value));
};
const query = (input: Json, keys: string[]): string => {
  const out = new URLSearchParams();
  for (const key of keys) if (input[key] !== undefined) out.set(key, String(input[key]));
  return out.size ? `?${out}` : "";
};
const body = (input: Json, omit: string[] = []): Json =>
  Object.fromEntries(Object.entries(input).filter(([key]) => key !== "spaceId" && !omit.includes(key)));
const action = (
  group: string,
  description: string,
  method: Method,
  path: (input: Json) => string,
  omit: string[] = [],
): Action => ({
  group,
  description,
  request: (input) => ({
    method,
    path: path(input),
    ...(method === "GET" ? {} : { body: body(input, omit) }),
    ...(typeof input.spaceId === "string" ? { spaceId: input.spaceId } : {}),
  }),
});

export const ACTIONS: Record<string, Action> = {
  "system.discover": action("system", "Show server version, capabilities, and agent API links.", "GET", () => "/api/agent"),
  "system.health": action("system", "Check server health.", "GET", () => "/api/health"),
  "system.runtime": action("system", "Inspect OpenCode runtime discovery and failures.", "GET", () => "/api/runtime/diagnostics"),
  "project.list": action("projects", "List projects and session counts.", "GET", () => "/api/agent/projects"),
  "project.add": action("projects", "Add an existing directory as a project.", "POST", () => "/api/projects"),
  "project.create": action("projects", "Create a directory and project.", "POST", () => "/api/projects/create"),
  "project.remove": action("projects", "Remove a project from Polyth without deleting its files.", "DELETE", (i) => `/api/projects/${required(i, "projectId")}`, ["projectId"]),
  "backend.list": action("sessions", "List backend sessions available to import.", "GET", (i) => `/api/agent/backend-sessions${query(i, ["projectId"])}`),
  "backend.import": action("sessions", "Import selected backend sessions.", "POST", () => "/api/agent/backend-sessions/import"),
  "session.list": action("sessions", "List sessions across projects with filters and recent events.", "GET", (i) => `/api/agent/sessions${query(i, ["projectId", "status", "archived", "limit", "offset", "recentEvents", "updatedAfter"])}`),
  "session.create": action("sessions", "Create a session and optionally send its first message.", "POST", () => "/api/agent/sessions"),
  "session.get": action("sessions", "Read a session, messages, events, queue, and runtime state.", "GET", (i) => `/api/agent/sessions/${required(i, "sessionId")}${query(i, ["eventLimit"])}`),
  "session.events": action("sessions", "Page a session event log.", "GET", (i) => `/api/agent/sessions/${required(i, "sessionId")}/events${query(i, ["afterSeq", "limit"])}`),
  "session.messages": action("sessions", "Read derived conversation messages.", "GET", (i) => `/api/agent/sessions/${required(i, "sessionId")}/messages`),
  "session.debug": action("sessions", "Inspect status, pending requests, queue, errors, and runtime state.", "GET", (i) => `/api/agent/sessions/${required(i, "sessionId")}/debug`),
  "session.send": action("sessions", "Send, steer, queue, or interrupt with a model-aware message.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/messages`, ["sessionId"]),
  "session.update": action("sessions", "Rename, pin, folder, or label a session.", "PATCH", (i) => `/api/agent/sessions/${required(i, "sessionId")}`, ["sessionId"]),
  "session.delete": action("sessions", "Permanently delete a session.", "DELETE", (i) => `/api/agent/sessions/${required(i, "sessionId")}`, ["sessionId"]),
  "session.cancel": action("sessions", "Cancel the active turn.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/cancel`, ["sessionId"]),
  "session.archive": action("sessions", "Archive a session.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/archive`, ["sessionId"]),
  "session.restore": action("sessions", "Restore an archived session.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/unarchive`, ["sessionId"]),
  "session.fork": action("sessions", "Fork a session, optionally at an event sequence.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/fork`, ["sessionId"]),
  "session.rewind": action("sessions", "Rewind a session to an event sequence.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/rewind`, ["sessionId"]),
  "session.rewind.clear": action("sessions", "Clear a session rewind.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/rewind/clear`, ["sessionId"]),
  "session.runtime.confirm": action("sessions", "Confirm reuse of a borrowed runtime epoch.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/runtime-epoch`, ["sessionId"]),
  "queue.list": action("queue", "List queued messages.", "GET", (i) => `/api/agent/sessions/${required(i, "sessionId")}/queue`),
  "queue.reorder": action("queue", "Reorder queued messages by id.", "PATCH", (i) => `/api/agent/sessions/${required(i, "sessionId")}/queue`, ["sessionId"]),
  "queue.edit": action("queue", "Edit a queued message.", "PATCH", (i) => `/api/agent/sessions/${required(i, "sessionId")}/queue/${required(i, "queueId")}`, ["sessionId", "queueId"]),
  "queue.remove": action("queue", "Remove a queued message.", "DELETE", (i) => `/api/agent/sessions/${required(i, "sessionId")}/queue/${required(i, "queueId")}`, ["sessionId", "queueId"]),
  "context.pin": action("context", "Pin a message into model context.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/context/pins/${required(i, "seq")}`, ["sessionId", "seq"]),
  "context.unpin": action("context", "Unpin a message from model context.", "DELETE", (i) => `/api/agent/sessions/${required(i, "sessionId")}/context/pins/${required(i, "seq")}`, ["sessionId", "seq"]),
  "permission.auto.get": action("requests", "Read session auto-accept policy.", "GET", (i) => `/api/agent/sessions/${required(i, "sessionId")}/permissions/auto-accept`),
  "permission.auto.set": action("requests", "Set auto-accept to on, off, or inherit.", "PATCH", (i) => `/api/agent/sessions/${required(i, "sessionId")}/permissions/auto-accept`, ["sessionId"]),
  "permission.reply": action("requests", "Approve once, always, or reject a permission request.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/permissions/${required(i, "requestId")}`, ["sessionId", "requestId"]),
  "question.reply": action("requests", "Answer a pending agent question.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/questions/${required(i, "requestId")}`, ["sessionId", "requestId"]),
  "question.reject": action("requests", "Reject a pending agent question.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/questions/${required(i, "requestId")}`, ["sessionId", "requestId"]),
  "secret.dismiss": action("requests", "Dismiss a secret request without exposing a value through MCP.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/secrets/${required(i, "requestId")}`, ["sessionId", "requestId"]),
  "goal.get": action("goals", "Read the autonomous goal attached to a session.", "GET", (i) => `/api/agent/sessions/${required(i, "sessionId")}/goal`),
  "goal.start": action("goals", "Attach and start an autonomous goal.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/goal`, ["sessionId"]),
  "goal.pause": action("goals", "Pause an autonomous goal.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/goal/pause`, ["sessionId"]),
  "goal.resume": action("goals", "Resume an autonomous goal.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/goal/resume`, ["sessionId"]),
  "goal.stop": action("goals", "Stop an autonomous goal.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/goal/stop`, ["sessionId"]),
  "shell.run": action("sessions", "Run a shell command in a session worktree.", "POST", (i) => `/api/agent/sessions/${required(i, "sessionId")}/shell`, ["sessionId"]),
  "catalog.models": action("catalog", "List enabled models.", "GET", () => "/api/models"),
  "catalog.providers": action("catalog", "List providers and visibility.", "GET", () => "/api/providers"),
  "catalog.agents": action("catalog", "List available agents.", "GET", () => "/api/agents"),
  "package.list": action("packages", "List installed feature packages and enabled state.", "GET", () => "/api/packages"),
  "package.set": action("packages", "Enable or disable a feature package.", "PATCH", (i) => `/api/packages/${required(i, "packageId")}`, ["packageId"]),
  "notification.list": action("notifications", "List notifications.", "GET", () => "/api/notifications"),
  "notification.read": action("notifications", "Mark notifications read.", "POST", () => "/api/notifications/read"),
  "notification.readAll": action("notifications", "Mark every notification read.", "POST", () => "/api/notifications/read-all"),
  "notification.clear": action("notifications", "Clear notifications.", "POST", () => "/api/notifications/clear"),
  "space.list": action("spaces", "List spaces and the active space.", "GET", () => "/api/spaces"),
  "space.create": action("spaces", "Create a space.", "POST", () => "/api/spaces"),
  "space.update": action("spaces", "Rename or restyle a space.", "PATCH", (i) => `/api/spaces/${required(i, "targetSpaceId")}`, ["targetSpaceId"]),
  "space.delete": action("spaces", "Delete a non-active space.", "DELETE", (i) => `/api/spaces/${required(i, "targetSpaceId")}`, ["targetSpaceId"]),
  "space.members": action("spaces", "List space members.", "GET", (i) => `/api/spaces/${required(i, "targetSpaceId")}/members`),
  "space.member.add": action("spaces", "Add a space member.", "POST", (i) => `/api/spaces/${required(i, "targetSpaceId")}/members`, ["targetSpaceId"]),
  "space.member.remove": action("spaces", "Remove a space member.", "DELETE", (i) => `/api/spaces/${required(i, "targetSpaceId")}/members/${required(i, "userId")}`, ["targetSpaceId", "userId"]),
  "api.request": {
    group: "advanced",
    description: "Call any current or future Polyth /api route; auth and secret routes stay blocked.",
    request(input) {
      const path = String(input.path ?? "");
      const method = String(input.method ?? "GET").toUpperCase();
      if (!path.startsWith("/api/") || path.startsWith("/api/auth") || /\/(?:secrets?|secure-safe)(?:\/|$)/.test(path)) {
        throw new Error("path must be a non-auth, non-secret /api route");
      }
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("unsupported method");
      if (input.body !== undefined && (!input.body || typeof input.body !== "object" || Array.isArray(input.body))) {
        throw new Error("body must be an object");
      }
      return { method: method as Method, path, ...(input.body ? { body: input.body as Json } : {}), ...(typeof input.spaceId === "string" ? { spaceId: input.spaceId } : {}) };
    },
  },
};

// Secret requests are intentionally dismiss-only. Values must enter through Secure Safe UI.
const fixedBody: Record<string, Json> = {
  "question.reject": { reject: true },
  "secret.dismiss": { action: "dismiss" },
  "session.runtime.confirm": { confirm: true },
};

export function buildControlRequest(name: string, input: Json = {}): ControlRequest {
  const definition = ACTIONS[name];
  if (!definition) throw new Error(`unknown action: ${name}`);
  const request = definition.request(input);
  return fixedBody[name] ? { ...request, body: fixedBody[name] } : request;
}

const baseUrl = (process.env.POLYTH_URL ?? "http://127.0.0.1:4400").replace(/\/$/, "");
const socketPath = process.env.POLYTH_CONTROL_SOCKET
  ?? (process.platform === "win32" ? undefined : resolve(process.env.POLYTH_DATA_DIR ?? "data", "control.sock"));

async function viaSocket(request: ControlRequest): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
    const req = httpRequest({
      socketPath,
      path: request.path,
      method: request.method,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        ...(request.spaceId ? { "x-polyth-space": request.spaceId } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let value: unknown = text;
        try { value = JSON.parse(text); } catch { /* preserve non-JSON diagnostics */ }
        if ((response.statusCode ?? 500) >= 400) reject(new Error(`Polyth ${response.statusCode}: ${typeof value === "string" ? value : JSON.stringify(value)}`));
        else resolvePromise(value);
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function viaHttp(request: ControlRequest): Promise<unknown> {
  const response = await fetch(`${baseUrl}${request.path}`, {
    method: request.method,
    headers: { "content-type": "application/json", ...(request.spaceId ? { "x-polyth-space": request.spaceId } : {}) },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  const text = await response.text();
  let value: unknown = text;
  try { value = JSON.parse(text); } catch { /* preserve non-JSON diagnostics */ }
  if (!response.ok) throw new Error(`Polyth ${response.status}: ${typeof value === "string" ? value : JSON.stringify(value)}${response.status === 401 ? ". Start the current Polyth build so its internal control socket is available." : ""}`);
  return value;
}

async function send(request: ControlRequest): Promise<unknown> {
  if (socketPath) {
    try { return await viaSocket(request); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
    }
  }
  return viaHttp(request);
}

const disabled = new Set((process.env.POLYTH_CONTROL_DISABLED ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const catalog = () => Object.entries(ACTIONS).map(([name, value]) => ({
  name, group: value.group, description: value.description, enabled: !disabled.has(name),
}));
const content = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export const tools = [
  {
    name: "capabilities",
    description: "Show every Polyth agent-control action and whether it is enabled.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "configure",
    description: "Enable, disable, or reset individual Polyth control actions for this MCP process.",
    inputSchema: {
      type: "object",
      properties: {
        enable: { type: "array", items: { type: "string", enum: Object.keys(ACTIONS) } },
        disable: { type: "array", items: { type: "string", enum: Object.keys(ACTIONS) } },
        reset: { type: "boolean" },
      },
    },
  },
  {
    name: "control",
    description: "Fully control Polyth projects, sessions, agents, requests, queues, goals, spaces, packages, and any /api feature. Call capabilities to discover actions.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: Object.keys(ACTIONS) },
        input: { type: "object", description: "Action fields; use spaceId to select a Space." },
      },
    },
  },
];

async function callTool(name: string, args: Json): Promise<ReturnType<typeof content>> {
  if (name === "capabilities") return content({ actions: catalog(), disabled: [...disabled] });
  if (name === "configure") {
    if (args.reset === true) disabled.clear();
    for (const value of Array.isArray(args.enable) ? args.enable : []) disabled.delete(String(value));
    for (const value of Array.isArray(args.disable) ? args.disable : []) {
      if (!ACTIONS[String(value)]) throw new Error(`unknown action: ${value}`);
      disabled.add(String(value));
    }
    return content({ actions: catalog() });
  }
  if (name !== "control") throw new Error(`unknown tool: ${name}`);
  const actionName = String(args.action ?? "");
  if (disabled.has(actionName)) throw new Error(`${actionName} is disabled; enable it with configure`);
  return content(await send(buildControlRequest(actionName, (args.input ?? {}) as Json)));
}

function main(): void {
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    let request: { id?: string | number | null; method?: string; params?: Json };
    try { request = JSON.parse(line) as typeof request; } catch { return; }
    if (!request.method) return;
    try {
      let result: unknown;
      if (request.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "polyth-control", version: "0.2.0" } };
      else if (request.method === "notifications/initialized") return;
      else if (request.method === "ping") result = {};
      else if (request.method === "tools/list") result = { tools };
      else if (request.method === "tools/call") {
        const params = request.params ?? {};
        try { result = await callTool(String(params.name), (params.arguments ?? {}) as Json); }
        catch (error) { result = content(error instanceof Error ? error.message : String(error), true); }
      } else throw new Error(`unsupported method: ${request.method}`);
      if (request.id !== undefined) output({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      if (request.id !== undefined) output({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: error instanceof Error ? error.message : String(error) } });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();

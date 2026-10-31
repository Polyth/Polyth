// Bounded MCP client owned by Polyth. Inspection never calls tools. Calls have
// a separate entry point, execute once, and never replay an uncertain outcome.
import { readFileSync } from "node:fs";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { JsonObject, JsonValue, McpTransport } from "@polyth/contracts";
import type { McpInspectionDto, McpToolDto, McpToolCallResult } from "@polyth/contracts/capability-installations";
import { createHarnessProcessAuthority, type HarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import { inspectOutboundHttpUrl, pinnedHttpRequest } from "@polyth/outbound";

const MODERN_VERSION = "2026-07-28";
const PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"]);
const OUTBOUND_METHODS = new Set(["server/discover", "initialize", "notifications/initialized", "notifications/cancelled", "tools/list", "tools/call"]);
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_FRAME_BYTES = 65_536;
const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_TOOLS = 128;
const MAX_PAGES = 8;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_DESCRIPTION = 4_000;
const MAX_CURSOR = 512;
const MAX_DEPTH = 8;
const MAX_SCHEMA_NODES = 64;
const REDACTED = "[redacted]";
const DESCRIPTION_TRUNCATED = " …[truncated]";
const SCHEMA_OMITTED = "[Input schema omitted: it is nested deeper or wider than Polyth accepts.]";
const RESERVED_HEADERS = new Set([
  "host", "content-length", "content-type", "transfer-encoding", "connection",
  "accept", "mcp-session-id", "mcp-protocol-version", "upgrade", "te", "trailer", "keep-alive",
  "mcp-method", "mcp-name",
]);
// A configured MCP receives platform essentials and its own explicit values,
// rather than inheriting unrelated service/provider credentials by default.
const PLATFORM_ENV = /^(?:PATH|HOME|USER|LOGNAME|USERPROFILE|HOMEDRIVE|HOMEPATH|SYSTEMROOT|WINDIR|APPDATA|LOCALAPPDATA|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_[A-Z_]+|TERM|SHELL|XDG_(?:CONFIG_HOME|DATA_HOME|CACHE_HOME|STATE_HOME|RUNTIME_DIR)|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|NPM_CONFIG_CACHE|npm_config_cache)$/i;

export interface McpProbeInput {
  transport: McpTransport;
  secrets: Record<string, string>;
  cwd?: string;
  authorityFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  networkPolicy?: "public-only" | "user-origin";
}

export interface McpCallInput extends McpProbeInput {
  toolName: string;
  arguments: JsonObject;
}

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface Inventory {
  tools: McpToolDto[];
  serverInfo?: { name: string; version: string };
}

interface McpRpc {
  request(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  setProtocol(version: string): void;
  setTool(tool: McpToolDto, args: JsonObject): void;
  close(): Promise<void>;
}

const aborted = (): Error => Object.assign(new Error("MCP request cancelled"), { code: "cancelled" });
const unknownOutcome = (): Error => Object.assign(new Error("MCP tool outcome is unknown; the call was not retried"), { code: "outcome-unknown" });
const metadata = (version: string, params: Record<string, unknown>): Record<string, unknown> => version === MODERN_VERSION
  ? { ...params, _meta: {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": { name: "polyth", version: "0.1.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  } } : params;
const objectResult = (result: unknown): Record<string, unknown> => {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid MCP result");
  const record = result as Record<string, unknown>;
  if (record.resultType !== undefined && record.resultType !== "complete") {
    throw new Error("MCP server requires an unsupported interactive continuation");
  }
  return record;
};

const secretValues = (secrets: Record<string, string> | undefined): string[] => {
  const values = new Set<string>();
  for (const value of Object.values(secrets ?? {})) {
    if (typeof value !== "string" || !value) continue;
    values.add(value);
    const token = /^(?:Bearer|Basic|Token)\s+(\S+)$/i.exec(value);
    if (token?.[1] && token[1].length >= 8) values.add(token[1]);
  }
  return [...values].sort((left, right) => right.length - left.length);
};

const redact = (text: string, secrets: readonly string[]): string => {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join(REDACTED);
  }
  return out;
};

const failure = (secrets: readonly string[], error: unknown): McpInspectionDto => {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const raw = code === "outcome-unknown"
    ? "MCP process release was not confirmed"
    : error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "MCP inventory failed";
  const message = redact(raw, secrets).replace(/\s+/g, " ").trim().slice(0, 400) || "MCP inventory failed";
  return { ok: false, message, checkedAt: Date.now(), tools: [] };
};

const success = (inventory: Inventory): McpInspectionDto => ({
  ok: true,
  message: `Checked ${inventory.tools.length} tools`,
  checkedAt: Date.now(),
  tools: inventory.tools,
  ...(inventory.serverInfo ? { serverInfo: inventory.serverInfo } : {}),
});

const resolveTimeout = (value: number | undefined, defaultMs = DEFAULT_TIMEOUT_MS, maxMs = 20_000): number => {
  if (value === undefined) return defaultMs;
  if (!Number.isFinite(value) || value < 200 || value > maxMs) throw new Error("MCP timeout is out of bounds");
  return value;
};

const requireAuthorityFile = (file: string): void => {
  if (typeof file !== "string" || !file || file.includes("\0")) throw new Error("invalid MCP process authority");
};

const scrubbedEnv = (secrets: Record<string, string>, envKeys: readonly string[]): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (!PLATFORM_ENV.test(key)) continue;
    if (value.includes("\0") || /[\r\n]/.test(value)) continue;
    env[key] = value;
  }
  for (const key of envKeys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("invalid MCP environment name");
    if (!Object.prototype.hasOwnProperty.call(secrets, key)) continue;
    const value = secrets[key] ?? "";
    if (value.includes("\0") || /[\r\n]/.test(value)) throw new Error("invalid MCP environment value");
    env[key] = value;
  }
  return env;
};

const headerSecrets = (
  names: readonly string[],
  secrets: Record<string, string>,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error("invalid MCP header secret");
    }
    const lower = name.toLowerCase();
    if (seen.has(lower) || RESERVED_HEADERS.has(lower) || lower.startsWith("mcp-param-")) throw new Error("invalid MCP header secret");
    seen.add(lower);
    if (!Object.prototype.hasOwnProperty.call(secrets, name)) continue;
    const value = secrets[name] ?? "";
    if (/[\r\n\0]/.test(value)) throw new Error("invalid MCP header secret");
    headers[name] = value;
  }
  return headers;
};

// Too deep or too wide, as opposed to too large or malformed. Only this kind
// of overflow may degrade a single tool schema instead of failing the server.
const shapeOverflow = (): Error => Object.assign(new Error("tool inputSchema exceeds bounds"), { shapeOverflow: true });
const isShapeOverflow = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { shapeOverflow?: boolean }).shapeOverflow === true;

const redactJson = (value: unknown, secrets: readonly string[], depth: number, maxString = MAX_SCHEMA_BYTES): unknown => {
  if (depth > MAX_DEPTH) throw shapeOverflow();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("tool inputSchema exceeds bounds");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > maxString) throw new Error("MCP data exceeds bounds");
    return redact(value, secrets);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SCHEMA_NODES) throw shapeOverflow();
    return value.map((entry) => redactJson(entry, secrets, depth + 1, maxString));
  }
  if (!value || typeof value !== "object") throw new Error("tool inputSchema exceeds bounds");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SCHEMA_NODES) throw shapeOverflow();
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (key.length > 128) throw new Error("tool inputSchema exceeds bounds");
    const safeKey = redact(key, secrets);
    if (Object.prototype.hasOwnProperty.call(out, safeKey)) throw new Error("tool inputSchema exceeds bounds");
    Object.defineProperty(out, safeKey, { value: redactJson(entry, secrets, depth + 1, maxString), enumerable: true, configurable: true, writable: true });
  }
  return out;
};

const normalizeTool = (value: unknown, secrets: readonly string[]): McpToolDto => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid MCP tool");
  const tool = value as Record<string, unknown>;
  if (typeof tool.name !== "string" || !tool.name || tool.name.length > 128 || /[\u0000-\u001f]/.test(tool.name)) {
    throw new Error("invalid MCP tool name");
  }
  const normalized: McpToolDto = {
    name: redact(tool.name, secrets),
    inputSchema: {},
  };
  if (tool.description !== undefined) {
    if (typeof tool.description !== "string") throw new Error("tool description exceeds bounds");
    // An oversized description is bounded rather than fatal: one long field must
    // not discard an otherwise valid server inventory.
    const description = tool.description.length > MAX_DESCRIPTION
      ? tool.description.slice(0, MAX_DESCRIPTION - DESCRIPTION_TRUNCATED.length) + DESCRIPTION_TRUNCATED
      : tool.description;
    normalized.description = redact(description, secrets);
  }
  if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
    throw new Error("tool inputSchema must be an object");
  }
  let schema: unknown;
  try {
    schema = redactJson(tool.inputSchema, secrets, 0);
  } catch (error) {
    if (!isShapeOverflow(error)) throw error;
    // A schema nested deeper (or wider) than the bounds loses its shape rather
    // than taking the whole server inventory down with it. Nothing from it is
    // kept, so the bound still holds; the tool stays callable with free-form
    // object arguments that its server validates.
    normalized.inputSchema = { type: "object" };
    const kept = normalized.description?.slice(0, MAX_DESCRIPTION - SCHEMA_OMITTED.length - 2);
    normalized.description = kept ? `${kept}\n\n${SCHEMA_OMITTED}` : SCHEMA_OMITTED;
    return normalized;
  }
  if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) throw new Error("tool inputSchema exceeds bounds");
  normalized.inputSchema = schema as JsonObject;
  return normalized;
};

const readServerInfo = (info: unknown, secrets: readonly string[]): { name: string; version: string } => {
  if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error("invalid MCP server info");
  const name = (info as Record<string, unknown>).name;
  const version = (info as Record<string, unknown>).version;
  if (typeof name !== "string" || typeof version !== "string" || !name || !version || name.length > 200 || version.length > 200) {
    throw new Error("invalid MCP server info");
  }
  if (/[\u0000-\u001f]/.test(name) || /[\u0000-\u001f]/.test(version)) throw new Error("invalid MCP server info");
  return { name: redact(name, secrets), version: redact(version, secrets) };
};

const readToolsPage = (result: unknown, secrets: readonly string[]): { tools: McpToolDto[]; nextCursor?: string } => {
  const record = objectResult(result);
  if (!Array.isArray(record.tools)) throw new Error("invalid MCP tools result");
  if (record.tools.length > MAX_TOOLS) throw new Error("MCP tools list exceeds bounds");
  const tools = record.tools.map((tool) => normalizeTool(tool, secrets));
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error("duplicate MCP tool name");
    names.add(tool.name);
  }
  const next = record.nextCursor;
  if (next === undefined || next === null || next === "") return { tools };
  if (typeof next !== "string" || !next || next.length > MAX_CURSOR || /[\u0000-\u001f]/.test(next)) {
    throw new Error("invalid MCP tools cursor");
  }
  return { tools, nextCursor: next };
};

const rpcError = (error: unknown): Error => {
  const message = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  const text = typeof message === "string" && message.trim() ? message.trim().slice(0, 240) : "MCP server returned an error";
  return Object.assign(new Error(text), { rpcCode: (error as { code?: unknown })?.code, rpcData: (error as { data?: unknown })?.data, definitive: true });
};

const asRpc = (value: unknown): RpcMessage => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed MCP response");
  const message = value as RpcMessage;
  if (message.jsonrpc !== "2.0") throw new Error("malformed MCP response");
  return message;
};

const parseRpcText = (text: string): RpcMessage => {
  try {
    return asRpc(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("malformed MCP response");
    throw error;
  }
};

const assertOutbound = (method: string): void => {
  if (!OUTBOUND_METHODS.has(method)) throw new Error("unsupported MCP method");
};

async function negotiate(rpc: McpRpc, secrets: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<Inventory["serverInfo"]> {
  try {
    const discovered = objectResult(await rpc.request("server/discover", {}, { timeoutMs: Math.min(800, timeoutMs / 4), signal }));
    if (!Array.isArray(discovered.supportedVersions) || !discovered.supportedVersions.includes(MODERN_VERSION)) {
      throw new Error("unsupported modern MCP protocol version");
    }
    const info = discovered._meta && typeof discovered._meta === "object"
      ? (discovered._meta as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"] : undefined;
    return info === undefined ? undefined : readServerInfo(info, secrets);
  } catch (error) {
    const e = error as { rpcCode?: number; code?: string; message?: string };
    if ([-32020, -32021, -32022].includes(e.rpcCode!) || e.code === "cancelled") throw error;
    if (e.rpcCode === undefined && !/timed out|HTTP (400|404|405)$/.test(e.message ?? "")) throw error;
  }
  rpc.setProtocol(PROTOCOL_VERSION);
  const initialized = objectResult(await rpc.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "polyth", version: "0.1.0" },
  }, { signal }));
  if (typeof initialized.protocolVersion !== "string" || !SUPPORTED_VERSIONS.has(initialized.protocolVersion)) {
    throw new Error("unsupported MCP protocol version");
  }
  rpc.setProtocol(initialized.protocolVersion);
  const serverInfo = readServerInfo(initialized.serverInfo, secrets);
  await rpc.notify("notifications/initialized", {});
  return serverInfo;
}

async function collectInventory(rpc: McpRpc, secrets: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<Inventory> {
  const serverInfo = await negotiate(rpc, secrets, timeoutMs, signal);
  const tools: McpToolDto[] = [];
  const seenNames = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await rpc.request("tools/list", cursor ? { cursor } : {}, { signal });
    const parsed = readToolsPage(result, secrets);
    for (const tool of parsed.tools) {
      if (seenNames.has(tool.name)) throw new Error("duplicate MCP tool name");
      seenNames.add(tool.name);
      try { rpc.setTool(tool, {}); } catch (error) {
        if ((error as { code?: string }).code === "invalid-tool-header") continue;
        throw error;
      }
      tools.push(tool);
      if (tools.length > MAX_TOOLS) throw new Error("MCP tools list exceeds bounds");
    }
    if (!parsed.nextCursor) return { tools, serverInfo };
    if (seenCursors.has(parsed.nextCursor)) throw new Error("repeated MCP tools cursor");
    seenCursors.add(parsed.nextCursor);
    cursor = parsed.nextCursor;
  }
  throw new Error("MCP tools list exceeded page bounds");
}

const releaseConfirmed = (file: string, authorityId: string, generation: number): boolean => {
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as {
      released?: unknown;
      authorityId?: unknown;
      generation?: unknown;
    };
    return state.released === true && state.authorityId === authorityId && state.generation === generation;
  } catch {
    return false;
  }
};

const createStdioRpc = (child: ChildProcess, deadline: number): McpRpc & { stop(): void } => {
  let buffer = Buffer.alloc(0);
  let received = 0;
  let nextId = 0;
  let failed: Error | undefined;
  let protocolVersion = MODERN_VERSION;
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();

  const fail = (error: Error): void => {
    if (failed) return;
    failed = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  const write = (value: unknown): void => {
    if (failed) throw failed;
    const method = value && typeof value === "object" ? (value as { method?: unknown }).method : undefined;
    if (typeof method === "string") assertOutbound(method);
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("MCP frame exceeds bounds");
    child.stdin?.write(line);
  };

  const onMessage = (message: RpcMessage): void => {
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) {
        if (protocolVersion === MODERN_VERSION) {
          fail(new Error("Modern MCP server sent an unsupported client request"));
          return;
        }
        write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client request" } });
      }
      return;
    }
    if (typeof message.id !== "number") {
      fail(new Error("malformed MCP response"));
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error !== undefined) entry.reject(rpcError(message.error));
    else entry.resolve(message.result);
  };

  const onData = (chunk: Buffer): void => {
    if (failed) return;
    received += chunk.length;
    if (received > MAX_OUTPUT_BYTES) {
      fail(new Error("MCP output exceeds bounds"));
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_OUTPUT_BYTES) {
      fail(new Error("MCP output exceeds bounds"));
      return;
    }
    while (!failed) {
      const end = buffer.indexOf(10);
      if (end < 0) {
        if (buffer.length > MAX_FRAME_BYTES) fail(new Error("MCP frame exceeds bounds"));
        return;
      }
      let line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      if (line.length && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
      if (!line.length) continue;
      if (line.length > MAX_FRAME_BYTES) {
        fail(new Error("MCP frame exceeds bounds"));
        return;
      }
      try {
        onMessage(parseRpcText(line.toString("utf8")));
      } catch (error) {
        fail(error instanceof Error ? error : new Error("malformed MCP response"));
        return;
      }
    }
  };

  child.stdout?.on("data", onData);
  child.stdout?.on("end", () => fail(new Error("MCP server closed the connection")));
  child.stdout?.on("error", () => fail(new Error("MCP server connection failed")));
  child.stdin?.on("error", () => fail(new Error("MCP server connection failed")));
  child.on("error", () => fail(new Error("MCP command failed to start")));
  child.stderr?.resume();

  const remaining = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("MCP server timed out");
    return left;
  };

  return {
    setProtocol(version) { protocolVersion = version; },
    setTool() {},
    async close() { try { child.stdin?.end(); } catch { /* containment owns release */ } },
    stop() {
      child.stdout?.off("data", onData);
    },
    request(method, params, options) {
      assertOutbound(method);
      if (failed) return Promise.reject(failed);
      if (options?.signal?.aborted) return Promise.reject(aborted());
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pending.delete(id);
          options?.signal?.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = () => {
          try { write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Cancelled" } }); } catch { /* release below */ }
          finish(() => reject(method === "tools/call" ? unknownOutcome() : aborted()));
        };
        const timer = setTimeout(() => {
          finish(() => {
            const error = new Error("MCP server timed out");
            if (method !== "server/discover") fail(error);
            reject(method === "tools/call" ? unknownOutcome() : error);
          });
        }, Math.max(1, Math.min(deadline - Date.now(), options?.timeoutMs ?? Infinity)));
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(id, {
          resolve: (value) => finish(() => resolve(value)),
          reject: (error) => finish(() => reject(method === "tools/call" && !(error as { definitive?: boolean }).definitive ? unknownOutcome() : error)),
        });
        try {
          remaining();
          write({ jsonrpc: "2.0", id, method, params: metadata(protocolVersion, params) });
        } catch (error) {
          const wrapped = error instanceof Error ? error : new Error("MCP request failed");
          finish(() => reject(wrapped));
          fail(wrapped);
        }
      });
    },
    async notify(method, params) {
      assertOutbound(method);
      remaining();
      write({ jsonrpc: "2.0", method, params });
    },
  };
};

const parseSse = (body: string): RpcMessage[] => {
  const messages: RpcMessage[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    if (messages.length > 32) throw new Error("MCP response exceeds bounds");
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) continue;
    const text = data.join("\n");
    if (text === "[DONE]") continue;
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error("MCP frame exceeds bounds");
    messages.push(parseRpcText(text));
  }
  return messages;
};

const parseHttpBody = (contentType: string, body: Buffer): RpcMessage[] => {
  if (body.length > MAX_OUTPUT_BYTES) throw new Error("MCP response exceeds bounds");
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const text = body.toString("utf8");
  if (type === "text/event-stream") return parseSse(text);
  if (type && type !== "application/json") throw new Error("unsupported MCP response type");
  if (!text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("malformed MCP response");
    throw error;
  }
  if (Array.isArray(parsed)) throw new Error("MCP batch responses are not supported");
  return [asRpc(parsed)];
};

const encodeHeader = (value: string): string => !/^[\x20-\x7e]*$/.test(value)
  || value.trim() !== value || (value.startsWith("=?base64?") && value.endsWith("?="))
  ? `=?base64?${Buffer.from(value).toString("base64")}?=` : value;

function toolHeaders(tool: McpToolDto, args: JsonObject): Record<string, string> {
  const headers: Record<string, string> = {};
  const names = new Set<string>();
  const invalid = () => Object.assign(new Error("Invalid MCP tool header annotation"), { code: "invalid-tool-header" });
  const walk = (value: unknown, path: string[], reachable: boolean) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const schema = value as Record<string, unknown>;
    const name = schema["x-mcp-header"];
    if (name !== undefined) {
      if (!reachable || !path.length || typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
        || names.has(name.toLowerCase()) || !["integer", "boolean", "string"].includes(schema.type as string)) throw invalid();
      names.add(name.toLowerCase());
      let param: unknown = args;
      for (const key of path) param = param && typeof param === "object" && Object.hasOwn(param, key)
        ? (param as Record<string, unknown>)[key] : undefined;
      if (param !== undefined && param !== null) {
        if ((schema.type === "integer" && (typeof param !== "number" || !Number.isSafeInteger(param)))
          || (schema.type !== "integer" && typeof param !== schema.type)) throw invalid();
        headers[`mcp-param-${name}`] = encodeHeader(String(param));
      }
    }
    for (const [key, child] of Object.entries(schema)) {
      if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
        for (const [property, definition] of Object.entries(child)) walk(definition, [...path, property], reachable);
      } else if (Array.isArray(child)) child.forEach((item) => walk(item, path, false));
      else if (child && typeof child === "object") walk(child, path, false);
    }
  };
  walk(tool.inputSchema, [], true);
  return headers;
}

const createHttpRpc = (options: {
  url: URL;
  addresses: readonly string[];
  headers: Record<string, string>;
  deadline: number;
}): McpRpc => {
  let sessionId: string | undefined;
  let protocolVersion = MODERN_VERSION;
  let callHeaders: Record<string, string> = {};
  let nextId = 0;
  const remaining = (): number => {
    const left = options.deadline - Date.now();
    if (left <= 0) throw new Error("MCP server timed out");
    return left;
  };
  const send = async (payload: unknown, replyToRequests: boolean, requestOptions?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RpcMessage[]> => {
    const method = payload && typeof payload === "object" ? (payload as { method?: unknown }).method : undefined;
    if (typeof method === "string") assertOutbound(method);
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
      ...options.headers,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (protocolVersion === MODERN_VERSION && typeof method === "string") {
      headers["mcp-method"] = method;
      if (method === "tools/call") {
        headers["mcp-name"] = encodeHeader((payload as { params: { name: string } }).params.name);
        Object.assign(headers, callHeaders);
      }
    }
    let response: { status: number; headers: Headers; body: Buffer };
    try {
      response = await pinnedHttpRequest(options.url, options.addresses, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        timeoutMs: Math.min(remaining(), requestOptions?.timeoutMs ?? Infinity),
        signal: requestOptions?.signal,
        maxBytes: MAX_OUTPUT_BYTES,
        completeWhen: ({ status, headers: responseHeaders, body }) => {
          if (status !== 200 || !(responseHeaders.get("content-type") ?? "").startsWith("text/event-stream")) return false;
          const text = body.toString("utf8");
          const lf = text.lastIndexOf("\n\n"), crlf = text.lastIndexOf("\r\n\r\n");
          const end = Math.max(lf < 0 ? -1 : lf + 2, crlf < 0 ? -1 : crlf + 4);
          if (end < 0) return false;
          return parseSse(text.slice(0, end)).some((message) => message.id === (payload as RpcMessage).id && typeof message.method !== "string");
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (requestOptions?.signal?.aborted) throw aborted();
      if (/timed out|AbortError|NETWORK_TIMEOUT/i.test(message)) throw new Error("MCP server timed out");
      if (/exceeds limit/i.test(message)) throw new Error("MCP response exceeds bounds");
      throw new Error("MCP server connection failed");
    }
    const status = response.status;
    if (status >= 300 && status < 400) throw new Error("MCP server redirect was rejected");
    if (status === 401) throw new Error("HTTP 401");
    if (status !== 200 && status !== 202 && status !== 204) {
      try {
        const error = parseHttpBody(response.headers.get("content-type") ?? "", response.body).find((message) => message.error !== undefined)?.error;
        if (error !== undefined) throw rpcError(error);
      } catch (error) {
        if ((error as { definitive?: boolean }).definitive) throw error;
      }
      throw Object.assign(new Error(`HTTP ${status}`), { definitive: true });
    }
    const session = method === "initialize" ? response.headers.get("mcp-session-id") : null;
    if (session && !sessionId) {
      if (!/^[\x21-\x7E]{1,128}$/.test(session)) throw new Error("invalid MCP session");
      sessionId = session;
    }
    if (status === 202 || status === 204 || response.body.length === 0) return [];
    const messages = parseHttpBody(response.headers.get("content-type") ?? "", response.body);
    if (replyToRequests) {
      for (const message of messages) {
        if (typeof message.method !== "string" || message.id === undefined || message.id === null) continue;
        if (protocolVersion === MODERN_VERSION) throw new Error("Modern MCP server sent an unsupported client request");
        await send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unsupported client request" },
        }, false);
      }
    }
    return messages;
  };
  return {
    setProtocol(version) { protocolVersion = version; },
    setTool(tool, args) { callHeaders = protocolVersion === MODERN_VERSION ? toolHeaders(tool, args) : {}; },
    async close() {
      if (!sessionId || protocolVersion === MODERN_VERSION) return;
      try {
        await pinnedHttpRequest(options.url, options.addresses, {
          method: "DELETE", headers: { ...options.headers, "mcp-session-id": sessionId, "mcp-protocol-version": protocolVersion },
          signal: AbortSignal.timeout(500), timeoutMs: 500, maxBytes: 1024,
        });
      } catch { /* best-effort legacy session termination; never replay requests */ }
    },
    async request(method, params, requestOptions) {
      assertOutbound(method);
      if (requestOptions?.signal?.aborted) throw aborted();
      const id = ++nextId;
      let messages: RpcMessage[];
      try {
        const timeout = Math.max(1, Math.ceil(Math.min(remaining(), requestOptions?.timeoutMs ?? Infinity)));
        messages = await send({ jsonrpc: "2.0", id, method, params: metadata(protocolVersion, params) }, true, {
          ...requestOptions, signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(requestOptions?.signal ? [requestOptions.signal] : [])]),
        });
      } catch (error) {
        if (method === "tools/call" && !(error as { definitive?: boolean }).definitive) throw unknownOutcome();
        if ((error as { code?: string }).code === "cancelled" && !requestOptions?.signal?.aborted) throw new Error("MCP server timed out");
        throw error;
      }
      const match = messages.find((message) => message.id === id && typeof message.method !== "string");
      if (!match) throw method === "tools/call" ? unknownOutcome() : new Error("MCP response missing");
      if (match.error !== undefined) throw rpcError(match.error);
      if (method === "initialize" && match.result && typeof match.result === "object" && !Array.isArray(match.result)) {
        const version = (match.result as { protocolVersion?: unknown }).protocolVersion;
        if (typeof version === "string" && SUPPORTED_VERSIONS.has(version)) protocolVersion = version;
      }
      return match.result;
    },
    async notify(method, params) {
      assertOutbound(method);
      const messages = await send({ jsonrpc: "2.0", method, params }, true, { signal: AbortSignal.timeout(Math.max(1, remaining())) });
      for (const message of messages) {
        if (message.error !== undefined && typeof message.method !== "string") throw rpcError(message.error);
      }
    },
  };
};

const awaitSpawn = (child: ChildProcess, timeoutMs: number): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("MCP command failed to start")), timeoutMs);
  child.once("spawn", () => {
    clearTimeout(timer);
    resolve();
  });
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error instanceof Error ? error : new Error("MCP command failed to start"));
  });
});

async function withStdio<T>(
  input: McpProbeInput,
  timeoutMs: number,
  operation: (rpc: McpRpc) => Promise<T>,
): Promise<T> {
  if (input.transport.kind !== "stdio") throw new Error("unknown MCP transport");
  requireAuthorityFile(input.authorityFile);
  if (!input.transport.command || /[\r\n\0]/.test(input.transport.command)) {
    throw new Error("invalid MCP stdio transport");
  }
  let authority: HarnessProcessAuthority | undefined;
  const deadline = Date.now() + timeoutMs;
  try {
    const env = scrubbedEnv(input.secrets ?? {}, input.transport.envKeys);
    authority = await createHarnessProcessAuthority(input.authorityFile);
    const spawnOptions: SpawnOptions = { env };
    if (input.cwd !== undefined) {
      if (typeof input.cwd !== "string" || !input.cwd || input.cwd.includes("\0")) {
        throw new Error("invalid MCP working directory");
      }
      spawnOptions.cwd = input.cwd;
    }
    const child = authority.spawn(input.transport.command, [...input.transport.args], spawnOptions);
    await awaitSpawn(child, Math.max(1, deadline - Date.now()));
    const rpc = createStdioRpc(child, deadline);
    try {
      return await operation(rpc);
    } finally {
      await rpc.close();
      rpc.stop();
    }
  } finally {
    if (authority) {
      const authorityId = authority.authorityId;
      const generation = authority.generation;
      try {
        await authority.close();
        if (!releaseConfirmed(input.authorityFile, authorityId, generation)) throw new Error("release not confirmed");
      } catch {
        throw Object.assign(new Error("MCP process release was not confirmed"), { code: "outcome-unknown" });
      }
    }
  }
}

async function withHttp<T>(
  input: McpProbeInput,
  timeoutMs: number,
  operation: (rpc: McpRpc) => Promise<T>,
): Promise<T> {
  if (input.transport.kind !== "http") throw new Error("unknown MCP transport");
  const deadline = Date.now() + timeoutMs;
  const decision = await inspectOutboundHttpUrl(input.transport.url, { policy: input.networkPolicy ?? "user-origin" });
  if (!decision.ok) throw new Error(decision.reason);
  if (decision.url.username || decision.url.password || decision.url.hash) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  const headers = headerSecrets(input.transport.headersSecretRefs, input.secrets ?? {});
  const rpc = createHttpRpc({
    url: decision.url,
    addresses: decision.addresses,
    headers,
    deadline,
  });
  try { return await operation(rpc); } finally { await rpc.close(); }
}

async function withConnection<T>(input: McpProbeInput, timeoutMs: number, operation: (rpc: McpRpc) => Promise<T>): Promise<T> {
  if (input.signal?.aborted) throw aborted();
  if (input.transport.kind === "stdio") return withStdio(input, timeoutMs, operation);
  if (input.transport.kind === "http") return withHttp(input, timeoutMs, operation);
  throw new Error("unknown MCP transport");
}

/** Inventory one configured MCP server. Failures return ok:false and never claim a connection. */
export async function inspectMcpServer(input: McpProbeInput): Promise<McpInspectionDto> {
  const secrets = secretValues(input?.secrets);
  try {
    const timeoutMs = resolveTimeout(input?.timeoutMs);
    return await withConnection(input, timeoutMs, async (rpc) => success(await collectInventory(rpc, secrets, timeoutMs, input.signal)));
  } catch (error) {
    return failure(secrets, error);
  }
}

/** Call a discovered tool once. Cancellation/transport loss after sending never authorizes replay. */
export async function callMcpTool(input: McpCallInput): Promise<McpToolCallResult> {
  const secrets = secretValues(input?.secrets);
  try {
    const timeoutMs = resolveTimeout(input?.timeoutMs, 60_000, 120_000);
    if (typeof input.toolName !== "string" || !input.toolName || input.toolName.length > 128 || /[\u0000-\u001f]/.test(input.toolName)) {
      throw new Error("invalid MCP tool name");
    }
    if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)
      || Buffer.byteLength(JSON.stringify(input.arguments)) > 32 * 1024) throw new Error("invalid MCP tool arguments");
    return await withConnection(input, timeoutMs, async (rpc) => {
      const inventory = await collectInventory(rpc, secrets, timeoutMs, input.signal);
      const tool = inventory.tools.find((candidate) => candidate.name === input.toolName);
      if (!tool) throw new Error("MCP tool is unavailable");
      rpc.setTool(tool, input.arguments);
      const response = await rpc.request("tools/call", { name: input.toolName, arguments: input.arguments }, { signal: input.signal });
      try {
        const result = objectResult(response);
        if (!Array.isArray(result.content) || result.content.length > 64
          || (result.isError !== undefined && typeof result.isError !== "boolean")) throw new Error("invalid MCP tool result");
        // Keep non-text content and structured responses, while applying the same
        // secret boundary to every returned field. Do not surface server _meta.
        const content = result.content.map((entry) => redactJson(entry, secrets, 0, MAX_OUTPUT_BYTES)) as JsonValue[];
        if (result.structuredContent !== undefined) content.push({ type: "text", text: JSON.stringify(redactJson(result.structuredContent, secrets, 0, MAX_OUTPUT_BYTES)) });
        if (Buffer.byteLength(JSON.stringify(content)) > MAX_OUTPUT_BYTES) throw new Error("MCP tool result exceeds bounds");
        return { content, ...(result.isError !== undefined ? { isError: result.isError } : {}) };
      } catch {
        // A returned but unusable response does not prove the mutation outcome.
        throw unknownOutcome();
      }
    });
  } catch (error) {
    const e = error as { code?: unknown };
    const message = redact(error instanceof Error ? error.message : "MCP tool call failed", secrets).replace(/\s+/g, " ").slice(0, 400);
    throw Object.assign(new Error(message), typeof e?.code === "string" ? { code: e.code } : {});
  }
}

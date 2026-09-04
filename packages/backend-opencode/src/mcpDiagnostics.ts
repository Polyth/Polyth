// OpenCode MCP tool listing. OpenCode HTTP stays here — server packages only
// receive an injected lister. Prefer `/mcp` status tools; fall back to exact
// `server_tool` ids from `/experimental/tool/ids`. No schema fetch, no fuzzy match.
import type {
  McpToolDto,
  McpToolsResponseDto,
  OpenCodeTransport,
  RuntimeEndpoint,
} from "@polyth/contracts";
import { createOpenCodeTransport } from "./transport.ts";
import { resolveRuntimeEndpointHeaders } from "./runtime.ts";

const DEADLINE_MS = 8_000;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const unwrap = (result: unknown): unknown => {
  const response = asRecord(result);
  if (typeof response?.status !== "number") return result;
  if (response.status < 200 || response.status >= 300) {
    throw Object.assign(new Error(`OpenCode returned HTTP ${response.status}`), {
      code: `http-${response.status}`,
      status: response.status,
    });
  }
  return response.body;
};

const queryJson = async (
  transport: Pick<OpenCodeTransport, "query">,
  path: string,
): Promise<unknown> =>
  unwrap(await transport.query<unknown>({ method: "GET", path, deadlineMs: DEADLINE_MS }));

/** OpenCode catalog sanitize — only used for exact id prefix matching. */
const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, "_");

function toolsFromMcpEntry(entry: unknown, serverName: string): McpToolDto[] {
  const record = asRecord(entry);
  if (!record) return [];
  const available = record.status === "connected";
  const raw = record.tools;
  if (!Array.isArray(raw)) return [];
  const out: McpToolDto[] = [];
  for (const item of raw) {
    const name = typeof item === "string"
      ? item
      : typeof asRecord(item)?.name === "string"
        ? String(asRecord(item)!.name)
        : typeof asRecord(item)?.id === "string"
          ? String(asRecord(item)!.id)
          : "";
    if (!name) continue;
    const display = name.startsWith(`${sanitize(serverName)}_`)
      ? name.slice(sanitize(serverName).length + 1)
      : name;
    out.push({ name: display || name, server: serverName, available });
  }
  return out;
}

function toolsFromIds(serverName: string, ids: string[], available: boolean): McpToolDto[] {
  const prefix = `${sanitize(serverName)}_`;
  return ids
    .filter((id) => id.startsWith(prefix) && id.length > prefix.length)
    .map((id) => ({ name: id.slice(prefix.length), server: serverName, available }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listMcpServerTools(opts: {
  transport: Pick<OpenCodeTransport, "query">;
  serverName: string;
}): Promise<McpToolsResponseDto> {
  const { transport, serverName } = opts;
  try {
    const mcpRaw = await queryJson(transport, "/mcp").catch(() => undefined);
    const mcpStatus = asRecord(mcpRaw);
    const entry = mcpStatus?.[serverName];
    const fromStatus = toolsFromMcpEntry(entry, serverName);
    if (fromStatus.length > 0) {
      return { tools: fromStatus.sort((a, b) => a.name.localeCompare(b.name)), source: "runtime" };
    }

    const idsRaw = await queryJson(transport, "/experimental/tool/ids");
    const ids = Array.isArray(idsRaw)
      ? idsRaw.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    const available = asRecord(entry)?.status === "connected" || entry === undefined;
    return {
      tools: toolsFromIds(serverName, ids, Boolean(available)),
      source: "runtime",
    };
  } catch (error) {
    return {
      tools: [],
      source: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listMcpServerToolsFromEndpoint(opts: {
  endpoint: RuntimeEndpoint;
  serverName: string;
}): Promise<McpToolsResponseDto> {
  try {
    const headers = await resolveRuntimeEndpointHeaders(opts.endpoint);
    const transport = createOpenCodeTransport({
      baseUrl: opts.endpoint.url,
      headers,
      directory: opts.endpoint.location.directory,
      queryAttempts: 1,
    });
    return await listMcpServerTools({ transport, serverName: opts.serverName });
  } catch (error) {
    return {
      tools: [],
      source: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

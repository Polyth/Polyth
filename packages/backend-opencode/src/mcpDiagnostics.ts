// OpenCode MCP tool inspection (WS21). The ONLY place that may HTTP-call
// OpenCode's /mcp and /experimental/tool* endpoints for diagnostics. Server
// packages receive an injected lister; they never fetch OpenCode themselves.
//
// Tool IDs follow OpenCode's McpCatalog.toolName convention:
//   sanitize(serverName) + "_" + sanitize(toolName)
// where sanitize replaces [^a-zA-Z0-9_-] with "_".
import type {
  McpToolDto,
  McpToolsResponseDto,
  OpenCodeTransport,
  RuntimeEndpoint,
} from "@polyth/contracts";
import { createOpenCodeTransport } from "./transport.ts";
import { resolveRuntimeEndpointHeaders } from "./runtime.ts";

const DIAGNOSTICS_DEADLINE_MS = 8_000;

/** Mirror of OpenCode `McpCatalog.sanitize`. */
export const sanitizeMcpSegment = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");

/** Mirror of OpenCode `McpCatalog.toolName(server, tool)`. */
export const mcpToolId = (serverName: string, toolName: string): string =>
  `${sanitizeMcpSegment(serverName)}_${sanitizeMcpSegment(toolName)}`;

export type OpenCodeMcpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error?: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error?: string }
  | { status: string; error?: string; tools?: unknown };

export interface OpenCodeToolDetail {
  id: string;
  description?: string;
  parameters?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const unwrapQueryBody = (result: unknown): unknown => {
  const response = asRecord(result);
  if (typeof response?.status !== "number") return result;
  if (response.status < 200 || response.status >= 300) {
    throw Object.assign(
      new Error(`OpenCode returned HTTP ${response.status}`),
      { code: `http-${response.status}`, status: response.status },
    );
  }
  return response.body;
};

const queryJson = async (
  transport: Pick<OpenCodeTransport, "query">,
  path: string,
): Promise<unknown> =>
  unwrapQueryBody(await transport.query<unknown>({
    method: "GET",
    path,
    deadlineMs: DIAGNOSTICS_DEADLINE_MS,
  }));

/** True when a tool id belongs to `serverName` (OpenCode prefix or segment). */
export const toolIdBelongsToServer = (serverName: string, toolId: string): boolean => {
  const prefix = `${sanitizeMcpSegment(serverName)}_`;
  if (toolId.startsWith(prefix)) return true;
  const needle = sanitizeMcpSegment(serverName).toLowerCase();
  if (!needle) return false;
  return toolId.split(/[_:/-]/).some((part) => part.toLowerCase() === needle);
};

/** Strip the OpenCode server prefix from a tool id for display. */
export const displayToolName = (serverName: string, toolId: string): string => {
  const prefix = `${sanitizeMcpSegment(serverName)}_`;
  if (toolId.startsWith(prefix) && toolId.length > prefix.length) {
    return toolId.slice(prefix.length);
  }
  return toolId;
};

/** Collect extra tool ids listed under a server entry in `/mcp` (if present). */
export const toolIdsFromMcpStatusEntry = (entry: unknown): string[] => {
  const record = asRecord(entry);
  if (!record) return [];
  const raw = record.tools;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item) out.push(item);
    else {
      const row = asRecord(item);
      const name = typeof row?.name === "string" ? row.name
        : typeof row?.id === "string" ? row.id
        : undefined;
      if (name) out.push(name);
    }
  }
  return out;
};

export const mapToolsForServer = (opts: {
  serverName: string;
  toolIds: string[];
  mcpStatus?: Record<string, OpenCodeMcpStatus>;
  details?: ReadonlyMap<string, OpenCodeToolDetail>;
}): McpToolDto[] => {
  const { serverName, toolIds, mcpStatus, details } = opts;
  const status = mcpStatus?.[serverName];
  const fromStatus = toolIdsFromMcpStatusEntry(status);
  const matched = new Set<string>();
  for (const id of toolIds) {
    if (toolIdBelongsToServer(serverName, id)) matched.add(id);
  }
  for (const id of fromStatus) {
    // Status may list bare tool names; promote to OpenCode ids when needed.
    if (id.includes("_") || toolIdBelongsToServer(serverName, id)) matched.add(id);
    else matched.add(mcpToolId(serverName, id));
  }

  const available = status?.status === "connected"
    || (status === undefined && matched.size > 0);

  return [...matched]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => {
      const detail = details?.get(id);
      const name = displayToolName(serverName, id);
      return {
        name,
        server: serverName,
        ...(detail?.description ? { description: detail.description } : {}),
        available,
      };
    });
};

export async function listMcpServerTools(opts: {
  transport: Pick<OpenCodeTransport, "query">;
  serverName: string;
  provider?: string;
  model?: string;
}): Promise<McpToolsResponseDto> {
  const { transport, serverName, provider, model } = opts;
  try {
    const [mcpRaw, idsRaw] = await Promise.all([
      queryJson(transport, "/mcp").catch(() => undefined),
      queryJson(transport, "/experimental/tool/ids"),
    ]);

    const mcpStatus = asRecord(mcpRaw) as Record<string, OpenCodeMcpStatus> | undefined;
    const toolIds = Array.isArray(idsRaw)
      ? idsRaw.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];

    let details: Map<string, OpenCodeToolDetail> | undefined;
    if (provider && model) {
      try {
        const listed = await queryJson(
          transport,
          `/experimental/tool?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
        );
        if (Array.isArray(listed)) {
          details = new Map();
          for (const item of listed) {
            const row = asRecord(item);
            const id = typeof row?.id === "string" ? row.id : undefined;
            if (!id) continue;
            details.set(id, {
              id,
              ...(typeof row?.description === "string" ? { description: row.description } : {}),
              ...(row?.parameters !== undefined ? { parameters: row.parameters } : {}),
            });
          }
        }
      } catch {
        // Schemas are optional enrichment; ids alone are enough.
      }
    }

    return {
      tools: mapToolsForServer({ serverName, toolIds, mcpStatus, details }),
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

/** Convenience: open a short-lived transport against a live runtime endpoint. */
export async function listMcpServerToolsFromEndpoint(opts: {
  endpoint: RuntimeEndpoint;
  serverName: string;
  provider?: string;
  model?: string;
}): Promise<McpToolsResponseDto> {
  try {
    const headers = await resolveRuntimeEndpointHeaders(opts.endpoint);
    const transport = createOpenCodeTransport({
      baseUrl: opts.endpoint.url,
      headers,
      directory: opts.endpoint.location.directory,
      queryAttempts: 1,
    });
    return await listMcpServerTools({
      transport,
      serverName: opts.serverName,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    });
  } catch (error) {
    return {
      tools: [],
      source: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

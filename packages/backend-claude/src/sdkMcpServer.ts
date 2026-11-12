// A minimal in-process MCP server for the Agent SDK's `type: "sdk"` transport.
//
// The SDK's own helper (`createSdkMcpServer` + `tool`) wants zod schemas and
// builds an `McpServer` from the MCP SDK. All the SDK does with the instance is
// `instance.connect(transport)`, then JSON-RPC over that transport, so the few
// methods a tool server needs are answered here from plain JSON Schemas. That
// keeps zod and the MCP SDK out of this package's own dependencies.
export interface SdkToolResult {
  text: string;
  isError?: boolean;
}

export interface SdkToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, extra: { signal: AbortSignal }): Promise<SdkToolResult>;
}

/** The part of an MCP transport the SDK hands to `connect`. */
export interface SdkMcpTransport {
  start?(): Promise<void>;
  send(message: unknown): Promise<void>;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

export interface SdkMcpServerInstance {
  connect(transport: SdkMcpTransport): Promise<void>;
  /** Cancels every tool call still running. */
  close(): void;
}

const PROTOCOL_VERSION = "2025-06-18";

type RpcId = string | number;
interface RpcMessage { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown> }

export function createSdkMcpServerInstance(input: {
  name: string;
  version?: string;
  tools: readonly SdkToolDefinition[];
}): SdkMcpServerInstance {
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  const running = new Map<RpcId, AbortController>();
  let closed = false;

  const handle = async (transport: SdkMcpTransport, message: RpcMessage): Promise<void> => {
    const { id, method, params } = message;
    const reply = (result: unknown) => transport.send({ jsonrpc: "2.0", id, result }).catch(() => {});
    const refuse = (code: number, text: string) => transport.send({ jsonrpc: "2.0", id, error: { code, message: text } }).catch(() => {});
    if (typeof method !== "string") return;
    if (id === undefined) {
      // A notification: only a cancellation matters here.
      if (method === "notifications/cancelled") {
        const requestId = params?.requestId;
        if (typeof requestId === "string" || typeof requestId === "number") running.get(requestId)?.abort();
      }
      return;
    }
    if (method === "initialize") {
      const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
      await reply({
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: input.name, version: input.version ?? "1.0.0" },
      });
    } else if (method === "ping") {
      await reply({});
    } else if (method === "tools/list") {
      await reply({
        tools: [...tools.values()].map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          // Six tools the model needs on every turn: never deferred behind a search.
          _meta: { "anthropic/alwaysLoad": true },
        })),
      });
    } else if (method === "tools/call") {
      const tool = typeof params?.name === "string" ? tools.get(params.name) : undefined;
      if (!tool) return void await refuse(-32602, `Unknown tool: ${String(params?.name)}`);
      const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {};
      const controller = new AbortController();
      running.set(id, controller);
      if (closed) controller.abort();
      let result: SdkToolResult;
      try {
        result = await tool.handler(args, { signal: controller.signal });
      } catch (error) {
        result = { text: `Tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      } finally {
        running.delete(id);
      }
      await reply({ content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) });
    } else {
      await refuse(-32601, `Method not found: ${method}`);
    }
  };

  return {
    async connect(transport) {
      transport.onmessage = (message) => {
        if (message && typeof message === "object") void handle(transport, message as RpcMessage);
      };
      await transport.start?.();
    },
    close() {
      closed = true;
      for (const controller of running.values()) controller.abort();
    },
  };
}

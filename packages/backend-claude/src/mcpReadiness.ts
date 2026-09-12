export const CLAUDE_AGENT_TOOLS_MCP_NAME = "polyth-agent-tools";

type ClaudeMcpStatus = {
  name?: string;
  status?: string;
};

type ClaudeMcpSurface = {
  initializationResult(): Promise<unknown>;
  mcpServerStatus?: () => Promise<ClaudeMcpStatus[]>;
};

export interface ClaudeAgentToolsReadinessOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const TERMINAL_FAILURES = new Set([
  "failed",
  "disabled",
  "error",
  "disconnected",
  "needs-auth",
]);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function hasPolythAgentToolsMcp(mcpServers: unknown): boolean {
  return Boolean(
    mcpServers
    && typeof mcpServers === "object"
    && !Array.isArray(mcpServers)
    && Object.prototype.hasOwnProperty.call(mcpServers, CLAUDE_AGENT_TOOLS_MCP_NAME),
  );
}

export async function waitForClaudeAgentTools(
  query: Pick<ClaudeMcpSurface, "mcpServerStatus">,
  options: ClaudeAgentToolsReadinessOptions = {},
): Promise<void> {
  if (typeof query.mcpServerStatus !== "function") {
    throw Object.assign(
      new Error("Claude Agent SDK cannot verify the Polyth agent-tools bridge"),
      { code: "native-failure" },
    );
  }

  const timeoutMs = Math.max(0, options.timeoutMs ?? 5_000);
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 25);
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "missing";
  let lastError = "";

  while (true) {
    try {
      const rows = await query.mcpServerStatus();
      const row = rows.find((candidate) => candidate.name === CLAUDE_AGENT_TOOLS_MCP_NAME);
      lastStatus = row?.status ?? "missing";
      lastError = "";
      if (row?.status === "connected") return;
      if (row?.status && TERMINAL_FAILURES.has(row.status)) {
        throw Object.assign(
          new Error(`Polyth agent-tools bridge failed to connect (Claude status: ${row.status})`),
          { code: "native-failure" },
        );
      }
    } catch (error) {
      if ((error as { code?: string }).code === "native-failure") throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (Date.now() >= deadline) break;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  throw Object.assign(
    new Error(
      `Polyth agent-tools bridge did not become ready before Claude session admission (last status: ${lastStatus}${lastError ? `; ${lastError}` : ""})`,
    ),
    { code: "native-failure" },
  );
}

/**
 * Claude's streaming-input mode may admit the first turn while MCP servers are
 * still pending. When the private Polyth tool bridge is configured, make the
 * SDK initialization barrier include bridge readiness so package tools such as
 * polyth_browser are present before the model can receive any user turn.
 */
export function gateClaudeAgentTools<T extends ClaudeMcpSurface>(
  query: T,
  required: boolean,
  options: ClaudeAgentToolsReadinessOptions = {},
): T {
  if (!required) return query;

  const initialize = query.initializationResult.bind(query);
  let readiness: Promise<unknown> | undefined;
  const initializationResult = () => readiness ??= (async () => {
    const result = await initialize();
    await waitForClaudeAgentTools(query, options);
    return result;
  })();

  return new Proxy(query, {
    get(target, property) {
      if (property === "initializationResult") return initializationResult;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

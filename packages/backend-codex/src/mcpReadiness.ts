import type { RpcPeer } from "@polyth/harness-runtime";
import type { CodexNativeMcp } from "./provisioner.ts";

export const CODEX_AGENT_TOOLS_MCP_NAME = "polyth-agent-tools";

const AGENT_TOOLS_CAPABILITY_ID = "polyth.agent-tools";

export const CODEX_MCP_STARTUP_TIMEOUT_SEC = 15;

type CodexMcpStatusRow = {
  name?: string;
  runtimeStatus?: "notStarted" | "starting" | "connected" | "authenticationRequired" | "failed" | "cancelled" | "disabled" | null;
  tools?: Record<string, { name?: string }>;
};

export interface CodexAgentToolsReadinessOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
}

const TERMINAL_FAILURES = new Set([
  "failed",
  "authenticationRequired",
  "cancelled",
  "disabled",
]);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isPolythAgentToolsBridge = (server: CodexNativeMcp): boolean =>
  server.capabilityId === AGENT_TOOLS_CAPABILITY_ID
  || server.name === CODEX_AGENT_TOOLS_MCP_NAME;

export function hasPolythAgentToolsMcp(mcpServers: unknown): boolean {
  return Boolean(
    mcpServers
    && typeof mcpServers === "object"
    && !Array.isArray(mcpServers)
    && Object.prototype.hasOwnProperty.call(mcpServers, CODEX_AGENT_TOOLS_MCP_NAME),
  );
}

export async function listCodexMcpStatusRows(
  rpc: RpcPeer,
  threadId: string,
): Promise<CodexMcpStatusRow[]> {
  const rows: CodexMcpStatusRow[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await rpc.request<{ data?: CodexMcpStatusRow[]; nextCursor?: string | null }>(
      "mcpServerStatus/list",
      { threadId, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) },
    );
    if (!Array.isArray(response.data)) throw new Error("Malformed MCP status response");
    rows.push(...response.data);
    const next = typeof response.nextCursor === "string" && response.nextCursor
      ? response.nextCursor
      : undefined;
    if (!next) break;
    if (cursors.has(next) || page === 99) throw new Error("Invalid MCP status pagination");
    cursors.add(next);
    cursor = next;
  }
  return rows;
}

const serverReady = (
  row: CodexMcpStatusRow | undefined,
  expectedTools: readonly { name: string }[],
): { ready: boolean; lastStatus: string; missingTools: string[] } => {
  const lastStatus = row?.runtimeStatus ?? "missing";
  if (lastStatus !== "connected") {
    return { ready: false, lastStatus, missingTools: expectedTools.map((tool) => tool.name) };
  }
  const missingTools = expectedTools.flatMap((tool) =>
    Object.values(row?.tools ?? {}).some((candidate) => candidate.name === tool.name)
      ? []
      : [tool.name]);
  return { ready: missingTools.length === 0, lastStatus, missingTools };
};

export async function waitForCodexNativeMcp(
  rpc: RpcPeer,
  threadId: string,
  expected: readonly CodexNativeMcp[],
  options: CodexAgentToolsReadinessOptions = {},
): Promise<void> {
  if (!expected.length) return;

  const timeoutMs = Math.max(0, options.timeoutMs ?? (CODEX_MCP_STARTUP_TIMEOUT_SEC + 5) * 1_000);
  const initialPollIntervalMs = Math.max(0, options.pollIntervalMs ?? 50);
  const maxPollIntervalMs = Math.max(
    initialPollIntervalMs,
    options.maxPollIntervalMs ?? 150,
  );
  const bridgeExpected = expected.find(isPolythAgentToolsBridge);
  // Only Polyth's own bridge gates admission. User MCP servers are verified
  // separately and must not delay or deny Codex session admission.
  if (!bridgeExpected) return;

  const deadline = Date.now() + timeoutMs;
  let nextPollIntervalMs = initialPollIntervalMs;
  let lastStatus = "missing";
  let lastMissingTools: string[] = [];
  let lastError = "";

  while (true) {
    try {
      const rows = await listCodexMcpStatusRows(rpc, threadId);
      const row = rows.find((candidate) => candidate.name === bridgeExpected.name);
      const readiness = serverReady(row, bridgeExpected.tools);
      lastStatus = readiness.lastStatus;
      lastMissingTools = readiness.missingTools;
      if (TERMINAL_FAILURES.has(readiness.lastStatus)) {
        throw Object.assign(
          new Error(`Polyth agent-tools bridge failed to connect (Codex status: ${readiness.lastStatus})`),
          { code: "native-failure" },
        );
      }
      if (readiness.ready) return;
      lastError = "";
    } catch (error) {
      if ((error as { code?: string }).code === "native-failure") throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }

    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) break;

    await delay(Math.min(nextPollIntervalMs, remainingMs));
    if (nextPollIntervalMs > 0) {
      nextPollIntervalMs = Math.min(maxPollIntervalMs, nextPollIntervalMs * 2);
    }
  }

  const missingSuffix = lastMissingTools.length
    ? `; missing tools: ${lastMissingTools.join(", ")}`
    : "";
  throw Object.assign(
    new Error(
      `Polyth agent-tools bridge did not become ready before Codex session admission (last status: ${lastStatus}${missingSuffix}${lastError ? `; ${lastError}` : ""})`,
    ),
    { code: "native-failure" },
  );
}

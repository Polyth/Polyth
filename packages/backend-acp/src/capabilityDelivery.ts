import type { HarnessCapabilityApplicationReceipt, HarnessContext } from "@polyth/contracts";
import type { RpcPeer } from "@polyth/harness-runtime";
import type { AcpLaunchOverlay } from "./provisioner.ts";

interface StagedCapabilities {
  value: AcpLaunchOverlay;
  desiredRevision: string;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

/** ACP v1 guarantees text blocks, not native skills or system instructions.
 * Keep the user's blocks intact, including slash commands and attachments.
 * Bind text to the accepted native session, never to a newer staged overlay. */
export function configureAcpCapabilityDelivery(
  rpc: RpcPeer,
  context: HarnessContext,
  harnessId: string,
  agentCapabilities: unknown,
  capabilities: {
    peek(context: HarnessContext, harnessId: string): StagedCapabilities | undefined;
    acknowledge(receipt: HarnessCapabilityApplicationReceipt): void;
  },
): void {
  const nativeMcp = object(object(agentCapabilities)?.mcpCapabilities);
  const validateTransport = (servers: unknown, code: string): void => {
    for (const value of Array.isArray(servers) ? servers : []) {
      const server = object(value);
      if (server?.type === "http" && nativeMcp?.http !== true) {
        throw Object.assign(new Error("ACP agent did not advertise HTTP MCP support"), { code });
      }
    }
  };
  // Reject before constructing the runtime: no native session was created and
  // no configured server was silently omitted. Recheck at every later launch.
  validateTransport(capabilities.peek(context, harnessId)?.value.mcpServers, "unsupported");
  const request = rpc.request.bind(rpc);
  let bound: { sessionId: string; staged: StagedCapabilities | undefined } | undefined;
  rpc.request = async <T = Record<string, unknown>>(method: string, params: unknown, timeoutMs?: number): Promise<T> => {
    const input = object(params);
    if (method === "session/new" || method === "session/load" || method === "session/resume") {
      validateTransport(input?.mcpServers, "runtime-rejected");
      const staged = capabilities.peek(context, harnessId);
      const result = await request<T>(method, params, timeoutMs);
      const sessionId = method === "session/new" ? object(result)?.sessionId : input?.sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        bound = { sessionId, staged };
      }
      return result;
    }
    const current = bound;
    const staged = current?.staged;
    const projection = staged?.value.prompt;
    if (method !== "session/prompt" || !current || !staged || !projection || !input || input.sessionId !== current.sessionId
      || !Array.isArray(input.prompt)) {
      return request<T>(method, params, timeoutMs);
    }
    const result = await request<T>(method, {
      ...input,
      // The first user block remains first so native slash-command detection
      // is not replaced by the capability preamble.
      prompt: [...input.prompt, { type: "text", text: projection.text }],
    }, timeoutMs);
    if (bound === current) {
      capabilities.acknowledge({
        target: {
          spaceId: context.spaceId,
          projectId: context.projectId,
          cwd: context.cwd,
          harnessId,
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        },
        desiredRevision: staged.desiredRevision,
        capabilityIds: projection.capabilityIds,
        outcome: "unverifiable",
        reason: "ACP accepted the prompt text projection; native model consumption is not observable",
      });
    }
    return result;
  };
}

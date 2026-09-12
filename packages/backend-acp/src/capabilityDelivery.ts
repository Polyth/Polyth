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

const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "with", "from",
  "this", "that", "use", "using", "agent", "session", "project", "polyth",
]);

const titleTokens = (value: string): string[] =>
  value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)
    ?.map((token) => token.replace(/^[-_]+|[-_]+$/g, ""))
    .filter((token) => token.length >= 3 && !TITLE_STOPWORDS.has(token)) ?? [];

/**
 * ACP session_info_update is provider-authored metadata, but some agents build
 * its title from every text block in the prompt. Polyth appends capability text
 * as a separate block, so a provider can otherwise turn an internal heading
 * such as "Secure Safe routing" into the user's session title.
 *
 * Reject only titles strongly grounded in the injected capability projection
 * and not in the user's own prompt. This is provenance filtering, not a list of
 * product-specific banned phrases, so it applies honestly to every ACP profile.
 */
export function isCapabilityDerivedAcpTitle(
  title: string,
  capabilityText: string | undefined,
  userText: string | undefined,
): boolean {
  if (!capabilityText?.trim() || !title.trim()) return false;
  const candidate = titleTokens(title);
  if (candidate.length < 2) return false;
  const capability = new Set(titleTokens(capabilityText));
  const user = new Set(titleTokens(userText ?? ""));
  const capabilityHits = candidate.filter((token) => capability.has(token)).length;
  const userHits = candidate.filter((token) => user.has(token)).length;
  return capabilityHits / candidate.length >= 2 / 3
    && userHits / candidate.length < 1 / 2;
}

const promptText = (blocks: unknown): string =>
  (Array.isArray(blocks) ? blocks : []).flatMap((value) => {
    const block = object(value);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");

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
  const onNotification = rpc.onNotification.bind(rpc);
  let bound: {
    sessionId: string;
    staged: StagedCapabilities | undefined;
    userPromptText?: string;
  } | undefined;

  // The runtime registers its notification handler after this delivery layer.
  // Filter only the untrusted title field; every other ACP update remains intact.
  rpc.onNotification = (handler) => onNotification((method, params) => {
    const payload = object(params);
    const update = object(payload?.update);
    const current = bound;
    if (
      method === "session/update"
      && current
      && payload?.sessionId === current.sessionId
      && update?.sessionUpdate === "session_info_update"
      && typeof update.title === "string"
      && isCapabilityDerivedAcpTitle(
        update.title,
        current.staged?.value.prompt?.text,
        current.userPromptText,
      )
    ) {
      handler(method, {
        ...payload,
        update: { ...update, title: undefined },
      });
      return;
    }
    handler(method, params);
  });

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
    current.userPromptText = promptText(input.prompt);
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
        evidence: {
          stage: "staged",
          source: "ACP prompt text projection was appended; native model consumption is not observable",
        },
      });
    }
    return result;
  };
}

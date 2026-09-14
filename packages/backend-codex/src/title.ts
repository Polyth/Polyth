import type { AgentRuntime, CanonicalTurnRequest, HarnessContext } from "@polyth/contracts";
import type { RpcPeer } from "@polyth/harness-runtime";

const TITLE_MAX_CHARS = 36;
const TITLE_PROMPT_MAX_BYTES = 960;
const TITLE_MODEL = "gpt-5.6-luna";
const TITLE_TIMEOUT_MS = 30_000;
const TITLE_RESPONSE_MAX_BYTES = 8 * 1024;

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const titleInstructions = () =>
  `Generate a concise, single-line task title of at most ${TITLE_MAX_CHARS} characters and under five words where possible. `
  + "Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. "
  + "Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.";

const truncateUtf8 = (value: string, maxBytes: number): string => {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
};

/** Mirrors the current Codex TUI title prompt so Polyth and Codex name the same task similarly. */
export const codexThreadTitlePrompt = (userMessage: string): string => {
  const prefix = `${titleInstructions()}\n\nUser prompt:\n`;
  const remaining = Math.max(0, TITLE_PROMPT_MAX_BYTES - Buffer.byteLength(prefix, "utf8"));
  return `${prefix}${truncateUtf8(userMessage.trim(), remaining)}`;
};

export const parseCodexThreadTitle = (response: string): string | undefined => {
  if (!response.trimStart().startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(response);
  } catch {
    return undefined;
  }
  const raw = object(value)?.title;
  if (typeof raw !== "string") return undefined;
  const normalized = raw
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.?!]+$/g, "")
    .trim();
  if (!normalized) return undefined;
  return [...normalized].slice(0, TITLE_MAX_CHARS).join("");
};

const outputSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: TITLE_MAX_CHARS },
  },
  required: ["title"],
  additionalProperties: false,
};

const isolatedConfig = (mcpNames: readonly string[]) => ({
  "features.apps": false,
  "features.code_mode": false,
  "features.code_mode_only": false,
  "features.context_management": false,
  "features.current_time_reminder": false,
  "features.deferred_executor": false,
  "features.enable_fanout": false,
  "features.goals": false,
  "features.hooks": false,
  "features.image_generation": false,
  "features.memories": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.plugins": false,
  "features.request_permissions_tool": false,
  "features.shell_snapshot": false,
  "features.shell_tool": false,
  "features.standalone_web_search": false,
  "features.token_budget": false,
  "features.tool_suggest": false,
  "features.unified_exec": false,
  "features.view_image": false,
  "orchestrator.skills.enabled": false,
  "skills.include_instructions": false,
  "token_budget.use_history_notes_extension": false,
  "tools.experimental_request_user_input.enabled": false,
  "tools.update_plan.enabled": false,
  web_search: "disabled",
  mcp_servers: Object.fromEntries(mcpNames.map((name) => [name, { enabled: false }])),
});

const effectiveMcpNames = async (rpc: RpcPeer, cwd: string): Promise<string[]> => {
  // Match Codex's temporary-structured-request isolation without opting the
  // whole Polyth connection into experimental API fields.
  const response = await rpc.request<Record<string, unknown>>(
    "config/read",
    { includeLayers: false, cwd },
    5_000,
  );
  const config = object(response.config);
  const additional = object(config?.additional);
  const servers = object(additional?.mcp_servers) ?? object(config?.mcp_servers);
  return servers ? Object.keys(servers) : [];
};

const collectStructuredResponse = (
  rpc: RpcPeer,
  threadId: string,
  start: () => Promise<Record<string, unknown>>,
): Promise<string> => new Promise((resolve, reject) => {
  let settled = false;
  let turnId: string | undefined;
  let response: string | undefined;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else if (response) resolve(response);
    else reject(new Error("Codex title turn completed without a response"));
  };
  const timer = setTimeout(() => finish(new Error("Codex title turn timed out")), TITLE_TIMEOUT_MS);
  timer.unref();

  rpc.onNotification((method, params) => {
    if (settled || object(params)?.threadId !== threadId) return;
    const data = object(params);
    if (method === "item/completed") {
      if (turnId && data?.turnId !== turnId) return;
      const item = object(data?.item);
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        if (Buffer.byteLength(item.text, "utf8") > TITLE_RESPONSE_MAX_BYTES) {
          finish(new Error("Codex title response is too large"));
          return;
        }
        response = item.text;
      }
      return;
    }
    if (method === "turn/completed") {
      const turn = object(data?.turn);
      if (turnId && turn?.id !== turnId) return;
      if (turn?.status !== "completed") {
        finish(new Error(`Codex title turn ended with status ${String(turn?.status ?? "unknown")}`));
        return;
      }
      finish();
    }
  });

  void start().then((result) => {
    const turn = object(result.turn);
    if (typeof turn?.id !== "string") {
      finish(new Error("Codex title turn did not return an id"));
      return;
    }
    turnId = turn.id;
  }, (error) => finish(error instanceof Error ? error : new Error(String(error))));
});

const generateTitle = async (
  context: HarnessContext,
  rpc: RpcPeer,
  runtime: AgentRuntime,
  request: CanonicalTurnRequest,
): Promise<string | undefined> => {
  const mcpNames = await effectiveMcpNames(rpc, context.cwd);
  const models = await runtime.models().catch(() => []);
  const luna = models.find((model) => model.providerID === "openai" && model.modelID === TITLE_MODEL);
  const model = luna
    ? { providerID: luna.providerID, modelID: luna.modelID }
    : request.model;

  const started = await rpc.request<Record<string, unknown>>(
    "thread/start",
    {
      ...(model?.modelID ? { model: model.modelID } : {}),
      ...(model?.providerID ? { modelProvider: model.providerID } : {}),
      cwd: context.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      threadSource: "system",
      config: isolatedConfig(mcpNames),
    },
    TITLE_TIMEOUT_MS,
  );
  const threadId = object(started.thread)?.id;
  if (typeof threadId !== "string" || !threadId) return undefined;

  try {
    const response = await collectStructuredResponse(rpc, threadId, () =>
      rpc.request<Record<string, unknown>>(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: codexThreadTitlePrompt(request.text) }],
          outputSchema,
          ...(luna ? { effort: "low" } : {}),
        },
        TITLE_TIMEOUT_MS,
      ));
    return parseCodexThreadTitle(response);
  } finally {
    await rpc.request("thread/unsubscribe", { threadId }, 5_000).catch(() => undefined);
  }
};

const placeholder = (title: string | undefined): boolean => {
  const value = title?.trim() ?? "";
  return !value
    || /^new session(?:\s*-\s*\d{4}-\d{2}-\d{2}t.*)?$/i.test(value)
    || /^untitled(?: session)?$/i.test(value)
    || /^codex session$/i.test(value);
};

/** Add the hidden semantic-title flow used by current Codex clients. */
export const withCodexTitleGeneration = (
  context: HarnessContext,
  rpc: RpcPeer,
  runtime: AgentRuntime,
): AgentRuntime => {
  let eligible = true;
  let started = false;
  let nativeTitleSeen = false;
  let primaryThreadId: string | undefined;

  const rememberPrimaryThread = (title: string | undefined, threadId: string): void => {
    eligible = placeholder(title);
    if (primaryThreadId === threadId) return;
    primaryThreadId = threadId;
    started = false;
    nativeTitleSeen = false;
  };

  runtime.onEvent((_sessionId, event) => {
    if (event.type === "session/title-generated") nativeTitleSeen = true;
  });

  const schedule = (request: CanonicalTurnRequest) => {
    if (!eligible || started || nativeTitleSeen || !primaryThreadId || !request.text.trim()) return;
    started = true;
    void generateTitle(context, rpc, runtime, request).then(async (title) => {
      if (!title || nativeTitleSeen || !primaryThreadId) return;
      await rpc.request("thread/name/set", { threadId: primaryThreadId, name: title }, 10_000);
    }).catch(() => {
      // Metadata generation is best-effort. Canonical Polyth fallback remains
      // responsible for naming if this Codex version cannot run the flow.
    });
  };

  const ensure = runtime.ensureSession.bind(runtime);
  const create = runtime.createSessionOperation?.bind(runtime);
  const reset = runtime.resetSessionOperation?.bind(runtime);
  const startOperation = runtime.startTurnOperation?.bind(runtime);
  const startTurn = runtime.startTurn.bind(runtime);
  const capabilities = runtime.capabilities.bind(runtime);

  return {
    ...runtime,
    capabilities: async () => ({ ...(await capabilities()), title: "native" as const }),
    ensureSession: async (...args: Parameters<AgentRuntime["ensureSession"]>) => {
      const [input] = args;
      const threadId = await ensure(...args);
      rememberPrimaryThread(input.title, threadId);
      return threadId;
    },
    ...(create
      ? {
          createSessionOperation: async (...args: Parameters<NonNullable<AgentRuntime["createSessionOperation"]>>) => {
            const [input] = args;
            eligible = placeholder(input.title);
            const outcome = await create(...args);
            if (outcome.kind === "confirmed") rememberPrimaryThread(input.title, outcome.value.backendSessionId);
            return outcome;
          },
        }
      : {}),
    ...(reset
      ? {
          resetSessionOperation: async (...args: Parameters<NonNullable<AgentRuntime["resetSessionOperation"]>>) => {
            const [input] = args;
            const outcome = await reset(...args);
            if (outcome.kind === "confirmed") rememberPrimaryThread(input.title, outcome.value.backendSessionId);
            return outcome;
          },
        }
      : {}),
    ...(startOperation
      ? {
          startTurnOperation: async (...args: Parameters<NonNullable<AgentRuntime["startTurnOperation"]>>) => {
            const [request] = args;
            const outcome = await startOperation(...args);
            if (outcome.kind === "confirmed") schedule(request);
            return outcome;
          },
        }
      : {}),
    async startTurn(request: CanonicalTurnRequest) {
      await startTurn(request);
      schedule(request);
    },
  };
};

// "Harness here, tools on the host": Claude Code runs on this machine on the
// person's own sign-in, while the project it works on lives on an SSH host.
// Its native shell and file tools would act on this machine, so they are
// switched off and replaced by six tools Polyth runs on the host over SSH.
// The host needs no Claude Code, no Node and no login.
//
// Two layers make that a product rather than a tunnel:
//   - Polyth's command policy (`@polyth/permissions/workspace-policy`) decides
//     each call before it runs, because Claude Code's own rules, plan mode and
//     edit modes do not reach tools it did not ship;
//   - the delivery bridge (`remoteBridge.ts`) brings the project's CLAUDE.md,
//     skills and hooks from the host, because Claude Code looks for them in a
//     local folder that is empty here.
import type { HookCallbackMatcher, HookEvent, HookJSONOutput, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { JsonObject } from "@polyth/contracts";
import { REMOTE_WORKSPACE_TOOLS, type RemoteWorkspace, type RemoteWorkspaceToolName } from "@polyth/harness-runtime/remote-workspace";
import {
  WORKSPACE_TOOL_PERMISSION,
  decideWorkspaceToolCall,
  type WorkspacePolicyContext,
  type WorkspacePolicyRules,
  type WorkspaceToolCall,
} from "@polyth/permissions/workspace-policy";
import { loadRemoteProjectBridge, type RemoteProjectBridge } from "./remoteBridge.ts";
import { createSdkMcpServerInstance, type SdkMcpServerInstance, type SdkToolDefinition } from "./sdkMcpServer.ts";

export const REMOTE_HANDS_SERVER = "workspace";
export const REMOTE_HANDS_PREFIX = `mcp__${REMOTE_HANDS_SERVER}__`;

/** Native tools that act on this machine's files or shell, or that depend on
 * them (plan mode writes its plan with the native file tools). */
export const REMOTE_HANDS_DISALLOWED_TOOLS = [
  "Bash", "BashOutput", "KillBash", "KillShell", "Monitor",
  "Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "NotebookRead", "Glob", "Grep", "LS",
  "EnterWorktree", "ExitWorktree", "EnterPlanMode", "ExitPlanMode", "Workflow",
];

const string = { type: "string" } as const;
const number = { type: "number" } as const;
const boolean = { type: "boolean" } as const;
const schema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> =>
  ({ type: "object", properties, required, additionalProperties: false });

/** Parameter names match Claude Code's own tools, so the model's habits carry over. */
const TOOL_SPECS: Record<RemoteWorkspaceToolName, { description: string; inputSchema: Record<string, unknown> }> = {
  bash: {
    description: "Run a bash command on the remote host. Each call starts a fresh shell in the project root, so `cd` does not carry over to the next call; chain with && instead. Output is stdout and stderr combined. `timeout` is in milliseconds (default 120000, max 600000).",
    inputSchema: schema({
      command: { ...string, description: "The command to run" },
      timeout: { ...number, description: "Timeout in milliseconds" },
    }, ["command"]),
  },
  read: {
    description: "Read a text file on the remote host. Returns up to 2000 lines with line numbers (`cat -n` format). Use `offset` (1-based line) and `limit` for long files. Relative paths resolve against the project root.",
    inputSchema: schema({
      file_path: { ...string, description: "Path of the file" },
      offset: { ...number, description: "First line to read, 1-based" },
      limit: { ...number, description: "Number of lines to read" },
    }, ["file_path"]),
  },
  write: {
    description: "Create or overwrite a file on the remote host with the given content. Parent directories are created. Prefer `edit` for changing an existing file.",
    inputSchema: schema({
      file_path: { ...string, description: "Path of the file" },
      content: { ...string, description: "Full new content of the file" },
    }, ["file_path", "content"]),
  },
  edit: {
    description: "Replace an exact string in a file on the remote host. `old_string` must match the file exactly (indentation included, without the line-number prefix that `read` shows) and must be unique unless `replace_all` is true. Line endings of the file are preserved.",
    inputSchema: schema({
      file_path: { ...string, description: "Path of the file" },
      old_string: { ...string, description: "Exact text to replace" },
      new_string: { ...string, description: "Replacement text" },
      replace_all: { ...boolean, description: "Replace every occurrence" },
    }, ["file_path", "old_string", "new_string"]),
  },
  grep: {
    description: "Search file contents on the remote host with a regular expression. `output_mode`: files_with_matches (default), content (matching lines with line numbers) or count. `glob` filters files, e.g. \"*.py\". `path` defaults to the project root.",
    inputSchema: schema({
      pattern: { ...string, description: "Regular expression" },
      path: { ...string, description: "File or directory to search" },
      glob: { ...string, description: "File name filter, e.g. *.py" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
      case_insensitive: boolean,
      head_limit: { ...number, description: "Maximum lines of output (default 250)" },
    }, ["pattern"]),
  },
  glob: {
    description: "List files on the remote host that match a glob pattern such as \"**/*.py\" or \"tests/test_*.py\". `path` is the directory to search (default: project root).",
    inputSchema: schema({
      pattern: { ...string, description: "Glob pattern" },
      path: { ...string, description: "Directory to search" },
    }, ["pattern"]),
  },
};

export type RemoteHandsPermission =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "ask"; permission: string; patterns: string[]; metadata: JsonObject };

export interface RemoteHandsSession {
  /** Text for the system prompt: where the project is, and its instructions. */
  append: string;
  mcpServers: Record<string, McpServerConfig>;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  disallowedTools: string[];
  /** Polyth's answer for a tool the SDK asks about; undefined for a tool that
   * is not one of the remote workspace tools. */
  permissionFor(tool: string, input: Record<string, unknown>, toolUseId?: string): RemoteHandsPermission | undefined;
  /** Other host roots the session may read without asking. */
  setExtraRoots(roots: readonly string[]): void;
  /** Stops running host commands and refuses new ones. */
  close(): void;
}

const shortName = (tool: string): RemoteWorkspaceToolName | undefined => {
  if (!tool.startsWith(REMOTE_HANDS_PREFIX)) return undefined;
  const short = tool.slice(REMOTE_HANDS_PREFIX.length);
  return (REMOTE_WORKSPACE_TOOLS as readonly string[]).includes(short) ? short as RemoteWorkspaceToolName : undefined;
};

const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/** The text of an MCP tool result, as a project hook should see it. */
const responseText = (value: unknown): string => {
  if (typeof value === "string") return value;
  const content = Array.isArray(value) ? value : (value as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    return content.map((block) => typeof (block as { text?: unknown })?.text === "string" ? (block as { text: string }).text : "").join("");
  }
  return value === undefined || value === null ? "" : JSON.stringify(value).slice(0, 20_000);
};

/**
 * Opens a session on a remote workspace: reads the project's own Claude Code
 * files on the host, runs its SessionStart hooks there, and builds the tools,
 * the policy and the hooks for the SDK. Claude Code starts its session before
 * an SDK hook can be registered, so a SessionStart hook is run here and its
 * output joins the system prompt instead.
 */
export async function openRemoteHandsSession(input: {
  workspace: RemoteWorkspace;
  nativeSessionId: string;
  resume: boolean;
  localRules?: WorkspacePolicyRules;
}): Promise<RemoteHandsSession> {
  const bridge = await loadRemoteProjectBridge(input.workspace, input.nativeSessionId);
  if (bridge.skipped.length) {
    console.warn(`[polyth] remote project on ${input.workspace.label}: not delivered to Claude Code: ${bridge.skipped.join(", ")}`);
  }
  const started = await bridge.runHooks("SessionStart", { payload: { source: input.resume ? "resume" : "startup" } })
    .catch(() => ({ context: [] as string[] }));
  return createRemoteHandsSession({
    workspace: input.workspace,
    bridge,
    ...(input.localRules ? { localRules: input.localRules } : {}),
    ...(started.context.length ? { sessionStartContext: started.context.join("\n\n") } : {}),
  });
}

export function createRemoteHandsSession(input: {
  workspace: RemoteWorkspace;
  bridge: RemoteProjectBridge;
  /** The person's own restricting rules on this machine (their Claude Code settings). */
  localRules?: WorkspacePolicyRules;
  /** What the project's SessionStart hooks printed on the host. */
  sessionStartContext?: string;
}): RemoteHandsSession {
  const { workspace, bridge } = input;
  const { root, label } = workspace;
  let extraRoots: string[] = [];
  let planMode = false;
  /** Calls a project hook handed to a person even though the policy allows them. */
  const hookAsks = new Set<string>();
  const rules: WorkspacePolicyRules = {
    deny: [...(input.localRules?.deny ?? []), ...bridge.rules.deny],
    ask: [...(input.localRules?.ask ?? []), ...bridge.rules.ask],
  };
  const policy = (): WorkspacePolicyContext => ({
    root,
    ...(extraRoots.length ? { extraRoots } : {}),
    ...(bridge.home ? { home: bridge.home } : {}),
    rules,
    planMode,
  });

  const pathOf = (short: RemoteWorkspaceToolName, args: Record<string, unknown>): string =>
    workspace.resolvePath(text(short === "grep" || short === "glob" ? args.path : args.file_path));
  const callOf = (short: RemoteWorkspaceToolName, args: Record<string, unknown>): WorkspaceToolCall =>
    short === "bash" ? { tool: "bash", command: text(args.command) ?? "" } : { tool: short, path: pathOf(short, args) };
  /** The call as Claude Code's own tool would report it to a hook. */
  const nativeInput = (short: RemoteWorkspaceToolName, args: Record<string, unknown>): Record<string, unknown> => {
    if (short === "bash") return { ...args };
    const key = short === "grep" || short === "glob" ? "path" : "file_path";
    return { ...args, [key]: pathOf(short, args) };
  };

  const tools: SdkToolDefinition[] = REMOTE_WORKSPACE_TOOLS.map((short) => ({
    name: short,
    ...TOOL_SPECS[short],
    async handler(args, { signal }) {
      const result = await workspace.call(short, args, { signal });
      if (result.isError || short === "bash") return result;
      const extra = await bridge.nestedInstructions(pathOf(short, args), short === "grep" || short === "glob" ? "directory" : "file")
        .catch(() => "");
      return extra ? { text: result.text + extra } : result;
    },
  }));
  const instance: SdkMcpServerInstance = createSdkMcpServerInstance({ name: REMOTE_HANDS_SERVER, tools });

  const preToolUse = async (hook: Record<string, unknown>, toolUseId: string | undefined, signal: AbortSignal): Promise<HookJSONOutput> => {
    const short = shortName(text(hook.tool_name) ?? "");
    if (!short) return { continue: true };
    planMode = hook.permission_mode === "plan";
    const args = hook.tool_input && typeof hook.tool_input === "object" ? hook.tool_input as Record<string, unknown> : {};
    const call = callOf(short, args);
    const answer = (permissionDecision: "allow" | "deny" | "ask", reason?: string, context?: string): HookJSONOutput => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        ...(reason ? { permissionDecisionReason: reason } : {}),
        ...(context ? { additionalContext: context } : {}),
      },
    });
    // Polyth's own refusal comes first: a refused call runs no project hook.
    const decision = decideWorkspaceToolCall(call, policy());
    if (decision.action === "deny") return answer("deny", decision.message);
    const hooked = await bridge.runHooks("PreToolUse", {
      toolName: WORKSPACE_TOOL_PERMISSION[short],
      call,
      payload: { tool_name: WORKSPACE_TOOL_PERMISSION[short], tool_input: nativeInput(short, args), ...(text(hook.permission_mode) ? { permission_mode: hook.permission_mode } : {}) },
      signal,
    });
    const context = hooked.context.join("\n\n") || undefined;
    if (hooked.block) return answer("deny", hooked.block, context);
    if (decision.action === "allow" && !hooked.ask) return answer("allow", undefined, context);
    if (hooked.ask && toolUseId) hookAsks.add(toolUseId);
    // "ask" hands the call to `canUseTool`, and so to the session's own
    // permission flow.
    return answer("ask", hooked.ask, context);
  };

  const postToolUse = async (hook: Record<string, unknown>, signal: AbortSignal): Promise<HookJSONOutput> => {
    const short = shortName(text(hook.tool_name) ?? "");
    if (!short) return { continue: true };
    const args = hook.tool_input && typeof hook.tool_input === "object" ? hook.tool_input as Record<string, unknown> : {};
    const hooked = await bridge.runHooks("PostToolUse", {
      toolName: WORKSPACE_TOOL_PERMISSION[short],
      call: callOf(short, args),
      payload: {
        tool_name: WORKSPACE_TOOL_PERMISSION[short],
        tool_input: nativeInput(short, args),
        tool_response: responseText(hook.tool_response),
        ...(text(hook.permission_mode) ? { permission_mode: hook.permission_mode } : {}),
      },
      signal,
    });
    const context = hooked.context.join("\n\n") || undefined;
    if (hooked.block) return { decision: "block", reason: hooked.block };
    return context ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } } : { continue: true };
  };

  const userPromptSubmit = async (hook: Record<string, unknown>, signal: AbortSignal): Promise<HookJSONOutput> => {
    const hooked = await bridge.runHooks("UserPromptSubmit", {
      payload: { prompt: text(hook.prompt) ?? "", ...(text(hook.permission_mode) ? { permission_mode: hook.permission_mode } : {}) },
      signal,
    });
    // A Polyth turn is already admitted when this runs, so a project hook
    // cannot take the prompt back; its objection reaches the model instead.
    const context = [
      ...(hooked.block ? [`A hook of this project objected to the request: ${hooked.block}`] : []),
      ...hooked.context,
    ].join("\n\n");
    return context ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } } : { continue: true };
  };

  /** A failing bridge must not take the tool call down with it. */
  const guarded = (run: () => Promise<HookJSONOutput>, fallback: HookJSONOutput): Promise<HookJSONOutput> =>
    run().catch((error) => {
      console.warn(`[polyth] remote workspace hook failed on ${label}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    });
  const has = (event: string): boolean => bridge.hooks.some((hook) => hook.event === event);
  const matcher = `${REMOTE_HANDS_PREFIX}.*`;
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
    // Always present: this is where the policy answers before a call runs. If
    // it cannot answer, the call is asked about rather than waved through.
    PreToolUse: [{
      matcher,
      hooks: [(hook, toolUseId, options) => guarded(
        () => preToolUse(hook as unknown as Record<string, unknown>, toolUseId, options.signal),
        { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } },
      )],
    }],
    ...(has("PostToolUse") ? { PostToolUse: [{
      matcher,
      hooks: [(hook, _id, options) => guarded(() => postToolUse(hook as unknown as Record<string, unknown>, options.signal), { continue: true })],
    }] } : {}),
    ...(has("UserPromptSubmit") ? { UserPromptSubmit: [{
      hooks: [(hook, _id, options) => guarded(() => userPromptSubmit(hook as unknown as Record<string, unknown>, options.signal), { continue: true })],
    }] } : {}),
  };

  const append = [
    [
      "# Remote workspace",
      `The project you work on is not on this machine. It is on ${label}, in ${root}, reached over SSH.`,
      "Your local working directory is an empty placeholder: never look for project files in it.",
      `Do all project work with the ${REMOTE_HANDS_PREFIX} tools: bash, read, write, edit, grep, glob. They run on ${label}; relative paths start at ${root}, and each bash call starts a fresh shell there.`,
      "Reading inside the project needs no approval; changes and anything outside it may be asked about first.",
    ].join("\n"),
    bridge.instructions,
    input.sessionStartContext?.trim()
      ? `# Output of the project's SessionStart hook on ${label}\n${input.sessionStartContext.trim()}`
      : "",
  ].filter(Boolean).join("\n\n");

  return {
    append,
    mcpServers: { [REMOTE_HANDS_SERVER]: { type: "sdk", name: REMOTE_HANDS_SERVER, instance } as unknown as McpServerConfig },
    hooks,
    disallowedTools: [...REMOTE_HANDS_DISALLOWED_TOOLS],
    permissionFor(tool, args, toolUseId) {
      const short = shortName(tool);
      if (!short) return undefined;
      const call = callOf(short, args);
      const decision = decideWorkspaceToolCall(call, policy());
      if (decision.action === "deny") return { kind: "deny", message: decision.message };
      const hookAsked = toolUseId !== undefined && hookAsks.delete(toolUseId);
      if (decision.action === "allow" && !hookAsked) return { kind: "allow" };
      return {
        kind: "ask",
        permission: WORKSPACE_TOOL_PERMISSION[short],
        patterns: [short === "bash" ? call.command ?? "" : call.path ?? root],
        // Shown on the card, so the person sees where the call would run.
        metadata: { host: label },
      };
    },
    setExtraRoots(roots) {
      extraRoots = roots.filter((candidate) => candidate.startsWith("/"));
    },
    close() {
      instance.close();
      workspace.close();
    },
  };
}

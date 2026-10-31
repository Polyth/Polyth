import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "@polyth/contracts";
import type { AgyInjectedStep } from "./attachments.ts";
import { materializeAntigravityHome } from "./home.ts";

/** Native hook events the runtime-private bridge serves. PreToolUse gates a
 * tool and fails closed; PreInvocation (steps injected before a model call)
 * and Stop (re-enter the loop) are additive and fail open. */
export type AgyHookEvent = "PreToolUse" | "PreInvocation" | "Stop";
export const AGY_HOOK_EVENTS: readonly AgyHookEvent[] = ["PreToolUse", "PreInvocation", "Stop"];

export type AgyHookDecision = {
  decision: "allow" | "deny";
  reason?: string;
};
export type AgyInvocationResult = { injectSteps?: AgyInjectedStep[] };
export type AgyStopResult = { decision?: "continue"; reason?: string };
export type AgyHookResponse = AgyHookDecision | AgyInvocationResult | AgyStopResult;
export type AgyHookHandler = (payload: unknown, event: AgyHookEvent) => Promise<AgyHookResponse>;

export interface AntigravityPermissionBridge {
  readonly root: string;
  /** Re-materialize the exact hook and optional MCP plugin before every native launch. */
  prepare(mcpServers?: Record<string, JsonObject>, disabledMcpNames?: string[]): Promise<void>;
  close(): Promise<void>;
}

export type AgyHookRequest = {
  conversationId: string;
  stepIdx: number;
  tool: string;
  args: Record<string, unknown>;
};

export type AgyPermissionClassification =
  | { kind: "allow"; permission: "edit" | "read" }
  | { kind: "request"; permission: string; patterns: string[]; tool: string; stepIdx: number }
  | { kind: "deny"; reason: string };

const EDIT_PATHS = new Map([
  ["write_to_file", ["TargetFile", "file_path", "path"]],
  ["replace_file_content", ["TargetFile", "file_path", "path"]],
  ["multi_replace_file_content", ["TargetFile", "file_path", "path"]],
  ["sed_file", ["TargetFile", "AbsolutePath", "file_path", "path"]],
  ["notebook_edit", ["NotebookPath", "notebook_path", "TargetFile", "file_path", "path"]],
]);
const READ_PATHS = new Map([
  ["view_file", "AbsolutePath"],
  ["list_dir", "DirectoryPath"],
  ["find_by_name", "SearchDirectory"],
  ["grep_search", "SearchPath"],
]);
const SAFE_CONTROL_TOOLS = new Set(["finish", "wait", "wait_5_seconds", "command_status", "list_permissions"]);

/** Known native surfaces that create or manage non-canonical workers.
 *
 * Polyth owns delegation: a delegated worker must be a canonical child Session
 * created through the Polyth `agent.spawn` capability, so a harness-native
 * spawn surface is denied before Auto-Approve is even considered. The CLI's
 * `init` frame advertises more than one such surface — `invoke_subagent`,
 * `define_subagent`, `manage_subagents`, `manage_task` and `browser_subagent`
 * were all listed by CLI 1.2.11 — so denying a single name would leave the
 * others open while the harness still advertises `subagents: false`. Only the
 * names are verified live; `manage_task`'s exact semantics are not, so it is
 * denied as a conservative boundary rather than as a claim about what it does.
 * A deny is a boundary, not a re-route: the reason names the Polyth path and
 * claims nothing about an unverified Polyth feature. */
const NATIVE_DELEGATION_TOOLS = new Set([
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "manage_task",
  "browser_subagent",
]);
/** Also deny names ending in `<verb>_agent(s)` / `<verb>_subagent(s)`.
 * Other naming conventions require a new protocol review; this pattern alone
 * does not prove that all future native delegation tools will be blocked. */
const NATIVE_DELEGATION_PATTERN = /(?:^|[_:.-])(?:subagents?|agents?)$/i;

export const NATIVE_DELEGATION_DENY_REASON =
  "Native Antigravity delegation is disabled in Polyth; use agent.spawn";

export const isNativeDelegationTool = (tool: string): boolean => {
  const normalized = tool.trim().toLowerCase();
  return NATIVE_DELEGATION_TOOLS.has(normalized) || NATIVE_DELEGATION_PATTERN.test(normalized);
};

/** Tool arguments can carry a whole file (`write_to_file`), so the request
 * ceiling is generous; an oversized request still fails closed. */
const MAX_HOOK_BYTES = 8 * 1024 * 1024;
const MAX_PATTERN_LENGTH = 4096;

const row = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const boundedText = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, MAX_PATTERN_LENGTH);
};

const inside = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
};

const candidatePath = (value: string, cwd: string): string | undefined => {
  try {
    const path = value.startsWith("file:") ? fileURLToPath(value) : value;
    return resolve(cwd, path);
  } catch {
    return undefined;
  }
};

/** Lexical traversal and existing symlink ancestors must both stay in cwd. */
async function isWorkspacePath(value: unknown, cwd: string): Promise<boolean> {
  const input = boundedText(value);
  if (!input) return false;
  const target = candidatePath(input, cwd);
  if (!target) return false;
  let workspace: string;
  try { workspace = await realpath(cwd); } catch { return false; }
  if (!inside(resolve(cwd), target)) return false;

  let ancestor = target;
  while (true) {
    try {
      return inside(workspace, await realpath(ancestor));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
  }
}

export function parseAgyHookRequest(value: unknown): AgyHookRequest | undefined {
  const payload = row(value);
  const call = row(payload?.toolCall);
  const tool = boundedText(call?.name);
  const args = row(call?.args);
  const conversationId = boundedText(payload?.conversationId);
  const stepIdx = payload?.stepIdx;
  if (!tool || tool.length > 128 || !args || !conversationId
    || typeof stepIdx !== "number" || !Number.isSafeInteger(stepIdx) || stepIdx < 0) return undefined;
  return { conversationId, stepIdx, tool, args };
}

export const isBrowserTool = (tool: string): boolean =>
  tool === "polyth_browser" || /(?:^|[_:/-])polyth_browser$/.test(tool);

/** Antigravity routes MCP tools through one native `call_mcp_tool` step whose
 * arguments name the server and tool. Ask Polyth about the tool the model
 * actually called, named `mcp__<server>__<tool>` like Claude's MCP tools, so
 * permission rules, the session-plan exemption and the risk assessment see the
 * real tool rather than one opaque wrapper. */
export function unwrapAgyMcpCall(request: AgyHookRequest): AgyHookRequest | undefined {
  if (request.tool !== "call_mcp_tool") return undefined;
  const server = boundedText(request.args.ServerName ?? request.args.serverName ?? request.args.server_name);
  const tool = boundedText(request.args.ToolName ?? request.args.toolName ?? request.args.tool_name);
  if (!server || !tool || server.length > 128 || tool.length > 128) return undefined;
  const raw = request.args.Arguments ?? request.args.arguments;
  let args = row(raw);
  if (!args && typeof raw === "string") {
    try { args = row(JSON.parse(raw)); } catch { args = undefined; }
  }
  return { ...request, tool: `mcp__${server}__${tool}`, args: args ?? {} };
}

export async function classifyAgyPermission(
  request: AgyHookRequest,
  cwd: string,
  options: {
    /** The CLI's own MCP tool-schema cache; the model reads a schema before
     *  calling the tool, so reading inside it is not an outside-workspace read. */
    mcpSchemaRoot?: string;
  } = {},
): Promise<AgyPermissionClassification> {
  const mcpCall = unwrapAgyMcpCall(request);
  if (mcpCall) return classifyAgyPermission(mcpCall, cwd, options);
  const editPaths = EDIT_PATHS.get(request.tool);
  if (editPaths) {
    const editPath = editPaths.map((key) => request.args[key]).find((value) => typeof value === "string");
    if (await isWorkspacePath(editPath, cwd)) return { kind: "allow", permission: "edit" };
    return {
      kind: "request",
      permission: "edit",
      patterns: [boundedText(editPath) ?? "Workspace file change"],
      tool: request.tool,
      stepIdx: request.stepIdx,
    };
  }

  const readPath = READ_PATHS.get(request.tool);
  if (readPath) {
    if (await isWorkspacePath(request.args[readPath], cwd)
      || (options.mcpSchemaRoot && await isWorkspacePath(request.args[readPath], options.mcpSchemaRoot))) {
      return { kind: "allow", permission: "read" };
    }
    return {
      kind: "request",
      permission: "read",
      patterns: [boundedText(request.args[readPath]) ?? "File read outside the workspace"],
      tool: request.tool,
      stepIdx: request.stepIdx,
    };
  }

  if (SAFE_CONTROL_TOOLS.has(request.tool)) return { kind: "allow", permission: "read" };
  // The runtime answers ask_question through Polyth before classification;
  // reaching this point means no Polyth turn can carry the question.
  if (request.tool === "ask_question") {
    return { kind: "deny", reason: "Antigravity questions need an active Polyth turn" };
  }
  if (isBrowserTool(request.tool)) {
    const action = boundedText(request.args.action);
    const params = row(request.args.parameters);
    const url = boundedText(params?.url);
    const pattern = url ? `${action ?? "browser"}: ${url}` : action ?? request.tool;
    return {
      kind: "request",
      permission: "browser",
      patterns: [pattern],
      tool: request.tool,
      stepIdx: request.stepIdx,
    };
  }
  const pattern = request.tool === "run_command"
    ? boundedText(request.args.CommandLine)
    : request.tool === "read_url_content"
      ? boundedText(request.args.Url)
      : request.tool === "search_web"
        ? boundedText(request.args.query)
        : request.tool === "ask_permission"
          ? boundedText(request.args.Target) ?? boundedText(request.args.Action)
          : undefined;
  return {
    kind: "request",
    permission: request.tool === "run_command" ? "bash" : request.tool,
    patterns: [pattern ?? request.tool],
    tool: request.tool,
    stepIdx: request.stepIdx,
  };
}

const quoteCommandArgument = (value: string): string => process.platform === "win32"
  ? `"${value.replaceAll('"', '""')}"`
  : `'${value.replaceAll("'", "'\\''")}'`;

const writeGenerated = async (file: string, content: string): Promise<void> => {
  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error("Antigravity approval bridge file was replaced by an unsafe filesystem entry");
  const current = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current !== content) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, file);
  }
  await chmod(file, 0o600);
};

const ensurePrivateDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Antigravity approval bridge directory is not a private directory");
  await chmod(directory, 0o700);
};

/** Generated hook command. The event name is its only argument; the output is
 * rebuilt per event so an unexpected field can never reach the native parser. */
const clientSource = (endpoint: string, token: string): string => `import { createConnection } from "node:net";
const ENDPOINT = ${JSON.stringify(endpoint)};
const TOKEN = ${JSON.stringify(token)};
const MAX_BYTES = ${MAX_HOOK_BYTES};
const EVENTS = ${JSON.stringify(AGY_HOOK_EVENTS)};
const EVENT = EVENTS.includes(process.argv[2]) ? process.argv[2] : "PreToolUse";
let input = "";
let finished = false;
const finish = (body) => {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(body));
};
// Only a tool gate fails closed. Missing injected steps or a normal stop are
// the native default, so the other events fail open.
const fallback = () => finish(EVENT === "PreToolUse" ? { decision: "deny", reason: "Polyth approval bridge is unavailable" } : {});
const sanitize = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reason = typeof value.reason === "string" && value.reason ? { reason: value.reason } : {};
  if (EVENT === "PreToolUse") {
    return value.decision === "allow" || value.decision === "deny" ? { decision: value.decision, ...reason } : undefined;
  }
  if (EVENT === "PreInvocation") {
    if (!Array.isArray(value.injectSteps)) return {};
    const valid = value.injectSteps.filter((s) => s && typeof s === "object" && (typeof s.userMessage === "string" || typeof s.ephemeralMessage === "string"));
    return valid.length ? { injectSteps: valid } : {};
  }
  return value.decision === "continue" ? { decision: "continue", ...reason } : {};
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input, "utf8") > MAX_BYTES) fallback();
});
process.stdin.on("error", fallback);
process.stdin.on("end", () => {
  if (finished) return;
  let payload;
  try { payload = JSON.parse(input); } catch { fallback(); return; }
  // The model's final text is never needed by Polyth; keep it off the socket.
  if (payload && typeof payload === "object") {
    delete payload.finalModelOutput;
    delete payload.modelOutput;
    delete payload.modelThinking;
  }
  const socket = createConnection(ENDPOINT);
  let response = "";
  socket.setEncoding("utf8");
  socket.setTimeout(24 * 60 * 60 * 1000, () => { socket.destroy(); fallback(); });
  socket.on("connect", () => socket.write(JSON.stringify({ token: TOKEN, event: EVENT, payload }) + "\\n"));
  socket.on("data", (chunk) => {
    response += chunk;
    if (Buffer.byteLength(response, "utf8") > MAX_BYTES) { socket.destroy(); fallback(); return; }
    const newline = response.indexOf("\\n");
    if (newline < 0) return;
    let value;
    try { value = sanitize(JSON.parse(response.slice(0, newline))); } catch { value = undefined; }
    if (value) finish(value); else fallback();
    socket.end();
  });
  socket.on("error", fallback);
  socket.on("close", () => { if (!finished) fallback(); });
});
`;

/** Fail-closed tool gate, fail-open additive events. */
const hookFallback = (event: AgyHookEvent, reason: string): AgyHookResponse =>
  event === "PreToolUse" ? { decision: "deny", reason } : {};

export async function createAntigravityPermissionBridge(options: {
  root: string;
  handle: AgyHookHandler;
  mcpServers?: Record<string, JsonObject>;
  /** Private HOME the native CLI is launched with; its Gemini config is per runtime. */
  homeRoot?: string;
  /** Real user home the CLI is authenticated against. */
  realHome?: string;
  /** Home whose `.gemini` holds the account's login; defaults to `realHome`. */
  geminiHome?: string;
}): Promise<AntigravityPermissionBridge> {
  const token = randomBytes(32).toString("hex");
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\polyth-agy-${randomBytes(16).toString("hex")}`
    : join(tmpdir(), `polyth-agy-${randomBytes(16).toString("hex")}.sock`);
  const sockets = new Set<Socket>();
  let closed = false;
  let failed = false;
  let stagedMcpServers = options.mcpServers;
  let stagedDisabledMcpNames: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(10_000);
    let input = "";
    let replied = false;
    // Until the envelope names its event, a reply is the fail-closed tool
    // decision; the generated client rebuilds every response per event.
    let event: AgyHookEvent = "PreToolUse";
    const reply = (response: AgyHookResponse) => {
      if (replied || socket.destroyed) return;
      replied = true;
      socket.end(JSON.stringify(response) + "\n");
    };
    socket.on("data", (chunk) => {
      if (replied) return;
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_HOOK_BYTES) {
        reply(hookFallback(event, "Antigravity hook request is too large"));
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      let envelope: Record<string, unknown> | undefined;
      try { envelope = row(JSON.parse(input.slice(0, newline))); } catch { /* denied below */ }
      const supplied = typeof envelope?.token === "string" ? Buffer.from(envelope.token) : Buffer.alloc(0);
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        reply({ decision: "deny", reason: "Invalid Polyth approval bridge credential" });
        return;
      }
      if (envelope?.event !== undefined) {
        if (!AGY_HOOK_EVENTS.includes(envelope.event as AgyHookEvent)) {
          reply({ decision: "deny", reason: "Unsupported Antigravity hook event" });
          return;
        }
        event = envelope.event as AgyHookEvent;
      }
      socket.setTimeout(0);
      void options.handle(envelope?.payload, event).then(reply, () =>
        reply(hookFallback(event, "Polyth could not resolve this tool approval")));
    });
    socket.on("timeout", () => reply(hookFallback(event, "Polyth approval bridge authentication timed out")));
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (closed || failed) reply(hookFallback(event, "Polyth approval bridge is closed"));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(endpoint, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  server.on("error", () => {
    failed = true;
    for (const socket of sockets) socket.end(JSON.stringify({
      decision: "deny",
      reason: "Polyth approval bridge failed",
    }) + "\n");
  });
  const client = join(options.root, "polyth-hook-client.mjs");
  const hooks = join(options.root, ".agents", "hooks.json");
  const hookCommand = (event: AgyHookEvent) =>
    `${quoteCommandArgument(process.execPath)} ${quoteCommandArgument(client)} ${event}`;
  const prepare = async (mcpServers?: Record<string, JsonObject>, disabledMcpNames?: string[]) => {
    if (mcpServers !== undefined) stagedMcpServers = mcpServers;
    if (disabledMcpNames !== undefined) stagedDisabledMcpNames = disabledMcpNames;
    await ensurePrivateDirectory(options.root);
    await ensurePrivateDirectory(join(options.root, ".agents"));
    await writeGenerated(client, clientSource(endpoint, token));
    // PreToolUse waits as long as a Polyth approval or question can take;
    // the loop events only read in-memory runtime state.
    await writeGenerated(hooks, JSON.stringify({
      "polyth-permission-gate": {
        PreToolUse: [{
          matcher: "*",
          hooks: [{ type: "command", command: hookCommand("PreToolUse"), timeout: 86_400 }],
        }],
        PreInvocation: [{ type: "command", command: hookCommand("PreInvocation"), timeout: 60 }],
        Stop: [{ type: "command", command: hookCommand("Stop"), timeout: 60 }],
      },
    }, null, 2) + "\n");
    if (options.homeRoot && options.realHome) {
      // The native CLI only reads MCP servers from its global Gemini config; a
      // private HOME keeps one session's bridge out of every other process and
      // out of the user's own config file.
      await materializeAntigravityHome({
        homeRoot: options.homeRoot,
        realHome: options.realHome,
        ...(options.geminiHome ? { geminiHome: options.geminiHome } : {}),
        mcpServers: stagedMcpServers,
        disabledMcpNames: stagedDisabledMcpNames,
      });
    }
  };
  try {
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
    await prepare();
  } catch (error) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    if (process.platform !== "win32") await unlink(endpoint).catch(() => undefined);
    throw error;
  }
  return {
    root: options.root,
    prepare,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.end(JSON.stringify({
        decision: "deny",
        reason: "Polyth approval bridge was closed",
      }) + "\n");
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (process.platform !== "win32") await unlink(endpoint).catch(() => undefined);
    },
  };
}

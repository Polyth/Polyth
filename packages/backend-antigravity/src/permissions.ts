import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AgyHookDecision = {
  decision: "allow" | "deny";
  reason?: string;
};

export interface AntigravityPermissionBridge {
  readonly root: string;
  /** Re-materialize the exact hook before every native launch. */
  prepare(): Promise<void>;
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

const EDIT_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content"]);
const READ_PATHS = new Map([
  ["view_file", "AbsolutePath"],
  ["list_dir", "DirectoryPath"],
  ["find_by_name", "SearchDirectory"],
  ["grep_search", "SearchPath"],
]);
const MAX_HOOK_BYTES = 1024 * 1024;
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

export async function classifyAgyPermission(
  request: AgyHookRequest,
  cwd: string,
): Promise<AgyPermissionClassification> {
  if (EDIT_TOOLS.has(request.tool)) {
    if (await isWorkspacePath(request.args.TargetFile, cwd)) return { kind: "allow", permission: "edit" };
    return {
      kind: "request",
      permission: "edit",
      patterns: [boundedText(request.args.TargetFile) ?? "Workspace file change"],
      tool: request.tool,
      stepIdx: request.stepIdx,
    };
  }

  const readPath = READ_PATHS.get(request.tool);
  if (readPath) {
    if (await isWorkspacePath(request.args[readPath], cwd)) return { kind: "allow", permission: "read" };
    return {
      kind: "request",
      permission: "read",
      patterns: [boundedText(request.args[readPath]) ?? "File read outside the workspace"],
      tool: request.tool,
      stepIdx: request.stepIdx,
    };
  }

  if (request.tool === "list_permissions") return { kind: "allow", permission: "read" };
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
  const current = await readFile(file, "utf8").catch(() => undefined);
  if (current !== content) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, file);
  }
  await chmod(file, 0o600);
};

const clientSource = (port: number, token: string): string => `import { createConnection } from "node:net";
const PORT = ${port};
const TOKEN = ${JSON.stringify(token)};
const MAX_BYTES = ${MAX_HOOK_BYTES};
let input = "";
let finished = false;
const finish = (body) => {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(body));
};
const deny = () => finish({ decision: "deny", reason: "Polyth approval bridge is unavailable" });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input, "utf8") > MAX_BYTES) deny();
});
process.stdin.on("error", deny);
process.stdin.on("end", () => {
  if (finished) return;
  let payload;
  try { payload = JSON.parse(input); } catch { deny(); return; }
  const socket = createConnection({ host: "127.0.0.1", port: PORT });
  let response = "";
  socket.setEncoding("utf8");
  socket.setTimeout(24 * 60 * 60 * 1000, () => { socket.destroy(); deny(); });
  socket.on("connect", () => socket.write(JSON.stringify({ token: TOKEN, payload }) + "\\n"));
  socket.on("data", (chunk) => {
    response += chunk;
    if (Buffer.byteLength(response, "utf8") > MAX_BYTES) { socket.destroy(); deny(); return; }
    const newline = response.indexOf("\\n");
    if (newline < 0) return;
    try {
      const value = JSON.parse(response.slice(0, newline));
      if (!value || (value.decision !== "allow" && value.decision !== "deny")) throw new Error("invalid decision");
      finish(value);
    } catch { deny(); }
    socket.end();
  });
  socket.on("error", deny);
  socket.on("close", () => { if (!finished) deny(); });
});
`;

export async function createAntigravityPermissionBridge(options: {
  root: string;
  handle(payload: unknown): Promise<AgyHookDecision>;
}): Promise<AntigravityPermissionBridge> {
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  let closed = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let input = "";
    let replied = false;
    const reply = (decision: AgyHookDecision) => {
      if (replied || socket.destroyed) return;
      replied = true;
      socket.end(JSON.stringify(decision) + "\n");
    };
    socket.on("data", (chunk) => {
      if (replied) return;
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_HOOK_BYTES) {
        reply({ decision: "deny", reason: "Antigravity hook request is too large" });
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
      void options.handle(envelope?.payload).then(reply, () => reply({
        decision: "deny",
        reason: "Polyth could not resolve this tool approval",
      }));
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (closed) reply({ decision: "deny", reason: "Polyth approval bridge is closed" });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Polyth could not allocate the Antigravity approval bridge");
  }
  const client = join(options.root, "polyth-hook-client.mjs");
  const hooks = join(options.root, ".agents", "hooks.json");
  const prepare = async () => {
    await mkdir(join(options.root, ".agents"), { recursive: true, mode: 0o700 });
    await writeGenerated(client, clientSource(address.port, token));
    await writeGenerated(hooks, JSON.stringify({
      "polyth-permission-gate": {
        PreToolUse: [{
          matcher: "*",
          hooks: [{
            type: "command",
            command: `${quoteCommandArgument(process.execPath)} ${quoteCommandArgument(client)}`,
            timeout: 86_400,
          }],
        }],
      },
    }, null, 2) + "\n");
  };
  await prepare();
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
    },
  };
}

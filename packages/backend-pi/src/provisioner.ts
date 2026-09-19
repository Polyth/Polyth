import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessProvisioner,
  HarnessProvisioningPlan,
} from "@polyth/contracts";
import { createLaunchOverlayStore, type LaunchOverlayStore } from "@polyth/harness-runtime";
import { atomicWriteSync } from "@polyth/plugins";

const AGENT_TOOLS_CAPABILITY_ID = "polyth.agent-tools";
const MAX_TOOLS = 256;

export interface PiToolBridge {
  url: string;
  token: string;
  capabilityIds: string[];
}

export interface PiLaunchOverlay {
  extensionFile: string;
  toolCapabilityIds: string[];
  toolNames: Record<string, string>;
  toolBridge: PiToolBridge;
}

export const piOverlays: LaunchOverlayStore<PiLaunchOverlay> = createLaunchOverlayStore<PiLaunchOverlay>();

const support = (): HarnessCapabilitySupport => ({
  harnessId: "pi",
  targetLifetime: "session",
  kinds: {
    "mcp-server": { modes: ["unsupported"], mutability: "immutable", remote: false, configScope: "session" },
    tool: { modes: ["mcp"], mutability: "session-create", remote: false, configScope: "session" },
    instruction: { modes: ["unsupported"], mutability: "immutable" },
    context: { modes: ["unsupported"], mutability: "immutable" },
    skill: { modes: ["unsupported"], mutability: "immutable" },
    extension: { modes: ["unsupported"], mutability: "immutable" },
  },
});

const record = (
  item: HarnessProvisioningPlan["items"][number],
  status: HarnessCapabilityRecord["status"],
  reason?: string,
): HarnessCapabilityRecord => ({
  capabilityId: item.capability.id,
  kind: item.capability.kind,
  owner: item.capability.owner,
  desiredRevision: item.capability.revision,
  mode: item.mode,
  status,
  mutability: item.mutability,
  ...(reason ? { reason } : {}),
});

const token = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);

const privateDirectory = (spaceRoot: string, ...parts: string[]): string => {
  let current = resolve(spaceRoot);
  const root = lstatSync(current);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("Space storage root is not a private directory");
  for (const part of parts) {
    current = join(current, part);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Pi capability storage is not private");
    } else mkdirSync(current, { mode: 0o700 });
  }
  return current;
};

const existingDirectory = (spaceRoot: string, ...parts: string[]): string | undefined => {
  let current = resolve(spaceRoot);
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) return undefined;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Pi capability storage is not private");
  }
  return current;
};

const extensionDocument = (
  tools: Array<Extract<HarnessProvisioningPlan["items"][number]["capability"], { kind: "tool" }>>,
): string => {
  const definitions = tools.map((tool) => ({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return [
    'import { randomUUID } from "node:crypto";',
    'import { createReadStream, createWriteStream } from "node:fs";',
    'import { createInterface } from "node:readline";',
    'import { Type } from "typebox";',
    "",
    `const tools = ${JSON.stringify(definitions)};`,
    'const requests = createWriteStream(null, { fd: 3, autoClose: false });',
    'const responses = createReadStream(null, { fd: 4, autoClose: false });',
    'const lines = createInterface({ input: responses, crlfDelay: Infinity });',
    'const pending = new Map();',
    'let closed = false;',
    'const safeError = (value) => String(value ?? "Polyth tool failed").replace(/[\\u0000-\\u001f\\u007f]+/g, " ").replace(/\\s+/g, " ").trim().slice(0, 1000);',
    'const failAll = (message) => { if (closed) return; closed = true; for (const entry of pending.values()) entry.finish({ content: [{ type: "text", text: message }], isError: true }); };',
    'requests.on("error", () => failAll("Polyth tool bridge disconnected"));',
    'responses.on("error", () => failAll("Polyth tool bridge disconnected"));',
    'responses.on("close", () => failAll("Polyth tool bridge disconnected"));',
    'lines.on("line", (line) => {',
    '  let message;',
    '  try { message = JSON.parse(line); } catch { failAll("Polyth tool bridge returned malformed response"); return; }',
    '  const entry = pending.get(typeof message?.id === "string" ? message.id : "");',
    '  if (!entry) return;',
    '  entry.finish(message?.result ?? { content: [{ type: "text", text: "Polyth tool returned no result" }], isError: true });',
    '});',
    'const invoke = (tool, input, signal) => new Promise((resolve) => {',
    '  if (closed) { resolve({ content: [{ type: "text", text: "Polyth tool bridge disconnected" }], isError: true }); return; }',
    '  const id = randomUUID(); let settled = false;',
    '  const finish = (result) => { if (settled) return; settled = true; pending.delete(id); signal?.removeEventListener?.("abort", onAbort); resolve(result); };',
    '  const onAbort = () => { try { requests.write(JSON.stringify({ type: "cancel", requestId: id }) + "\\n"); } catch {} finish({ content: [{ type: "text", text: "Polyth tool call aborted" }], isError: true }); };',
    '  pending.set(id, { finish });',
    '  if (signal?.aborted) { onAbort(); return; }',
    '  signal?.addEventListener?.("abort", onAbort, { once: true });',
    '  try { requests.write(JSON.stringify({ type: "call", id, capabilityId: tool.id, name: tool.name, input: input ?? {} }) + "\\n"); }',
    '  catch { finish({ content: [{ type: "text", text: "Polyth tool bridge is unavailable" }], isError: true }); }',
    '});',
    'export default function polythTools(pi) {',
    '  for (const tool of tools) pi.registerTool({',
    '    name: tool.name, label: tool.name, description: tool.description, promptSnippet: tool.description,',
    '    parameters: Type.Unsafe(tool.inputSchema),',
    '    async execute(_callId, input, signal) { return invoke(tool, input, signal); },',
    '  });',
    '  const ready = (_event, ctx) => { ctx.ui.setStatus("polyth-tools", "ready"); };',
    '  pi.on("session_start", ready);',
    '  pi.on("before_agent_start", ready);',
    '}',
    "",
  ].join("\n");
};

export function createPiProvisioner(): HarnessProvisioner {
  return {
    support,
    async apply(context, plan, secrets: CapabilitySecretResolver) {
      if (context.remote || !context.space || context.space.spaceId !== context.spaceId) {
        return {
          harnessId: "pi",
          desiredRevision: plan.desiredRevision,
          records: plan.items.filter((item) => item.capability.id !== AGENT_TOOLS_CAPABILITY_ID)
            .map((item) => record(item, "unsupported", "Pi tool projection requires a local Space session")),
        };
      }
      const records: HarnessCapabilityRecord[] = [];
      const toolItems = plan.items.filter((item) => item.capability.kind === "tool" && item.mode === "mcp");
      if (toolItems.length > MAX_TOOLS) {
        for (const item of toolItems) records.push(record(item, "failed", `Pi supports at most ${MAX_TOOLS} projected tools`));
      } else if (toolItems.length) {
        const bridge = secrets.mcpSecrets(AGENT_TOOLS_CAPABILITY_ID);
        if (!bridge.POLYTH_AGENT_TOOLS_URL || !bridge.POLYTH_AGENT_TOOLS_TOKEN) {
          for (const item of toolItems) records.push(record(item, "failed", "Scoped Polyth agent-tool bridge is unavailable"));
        } else {
          const root = privateDirectory(
            context.space.storageDir,
            "runtime", "pi", "capabilities",
            token(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? ""])),
            "revisions", token(plan.desiredRevision),
          );
          const tools = toolItems.map((item) => item.capability)
            .filter((item): item is Extract<typeof item, { kind: "tool" }> => item.kind === "tool");
          const extensionFile = join(root, "polyth-tools.ts");
          const document = extensionDocument(tools);
          if (existsSync(extensionFile) && readFileSync(extensionFile, "utf8") !== document) {
            for (const item of toolItems) records.push(record(item, "failed", "Pi capability revision is immutable"));
          } else {
            if (!existsSync(extensionFile)) atomicWriteSync(extensionFile, document, 0o600);
            const overlay: PiLaunchOverlay = {
              extensionFile,
              toolCapabilityIds: tools.map((tool) => tool.id),
              toolNames: Object.fromEntries(tools.map((tool) => [tool.name, tool.id])),
              toolBridge: {
                url: bridge.POLYTH_AGENT_TOOLS_URL,
                token: bridge.POLYTH_AGENT_TOOLS_TOKEN,
                capabilityIds: tools.map((tool) => tool.id),
              },
            };
            piOverlays.set(context, overlay, "pi", {
              desiredRevision: plan.desiredRevision,
              capabilityIds: overlay.toolCapabilityIds,
            });
            for (const item of toolItems) records.push(record(item, "pending", "Staged as a private Pi extension backed by the scoped Polyth permission bridge"));
          }
        }
      }
      const seen = new Set(records.map((item) => item.capabilityId));
      for (const item of plan.items) {
        if (item.capability.id === AGENT_TOOLS_CAPABILITY_ID || seen.has(item.capability.id)) continue;
        records.push(record(item, "unsupported", "Pi has no verified projection for this capability"));
      }
      const revisions = existingDirectory(
        context.space.storageDir, "runtime", "pi", "capabilities",
        token(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? ""])), "revisions",
      );
      if (revisions) {
        const keep = new Set([...(plan.keepRevisions ?? []), plan.desiredRevision].map(token));
        for (const entry of readdirSync(revisions, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.isSymbolicLink() && !keep.has(entry.name)) rmSync(join(revisions, entry.name), { recursive: true, force: true });
        }
      }
      if (!records.some((item) => item.status === "pending")) piOverlays.delete(context, "pi");
      return { harnessId: "pi", desiredRevision: plan.desiredRevision, records };
    },
    release(context, options) {
      piOverlays.release(context);
      if (!context.space || context.space.spaceId !== context.spaceId || (options?.keepRevisions?.length ?? 0) > 0) return;
      const root = existingDirectory(
        context.space.storageDir,
        "runtime", "pi", "capabilities",
        token(JSON.stringify([context.projectId, context.cwd, context.sessionId ?? ""])),
      );
      if (root) rmSync(root, { recursive: true, force: true });
    },
  };
}

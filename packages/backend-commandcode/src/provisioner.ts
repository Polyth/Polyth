import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  CapabilitySecretResolver,
  HarnessCapabilityRecord,
  HarnessCapabilitySupport,
  HarnessContext,
  HarnessProvisioner,
  HarnessProvisioningPlan,
} from "@polyth/contracts";
import { createLaunchOverlayStore, type LaunchOverlayStore } from "@polyth/harness-runtime";
import { renderCapabilityText } from "@polyth/harness-runtime/capability-text";
import { atomicWriteSync } from "@polyth/plugins";

const AGENT_TOOLS_CAPABILITY_ID = "polyth.agent-tools";
const MAX_TOOL_CAPABILITIES = 256;
const MAX_TOOL_CAPABILITY_ID = 512;

export interface CommandCodeToolBridge {
  url: string;
  token: string;
  capabilityIds: string[];
}

export interface CommandCodeLaunchOverlay {
  promptModFile?: string;
  promptCapabilityIds: string[];
  skillRoot?: string;
  skillCapabilityIds: string[];
  toolModFile?: string;
  toolCapabilityIds: string[];
  toolBridge?: CommandCodeToolBridge;
}

export const commandCodeOverlays: LaunchOverlayStore<CommandCodeLaunchOverlay> =
  createLaunchOverlayStore<CommandCodeLaunchOverlay>();

const support = (_context: HarnessContext): HarnessCapabilitySupport => ({
  harnessId: "commandcode",
  targetLifetime: "session",
  kinds: {
    instruction: { modes: ["prompt"], mutability: "immediate", configScope: "session" },
    context: { modes: ["prompt"], mutability: "immediate", remote: false, configScope: "session" },
    skill: { modes: ["native"], mutability: "immediate", remote: false, configScope: "session" },
    // Ambient native MCP remains Command Code-owned. Session scope is retained
    // so the shared controller can mint its reserved scoped AgentTool grant.
    "mcp-server": { modes: ["unsupported"], mutability: "immutable", remote: false, configScope: "session" },
    // The shared controller's MCP-mode grant seam supplies canonical authz and
    // tenancy. Command Code sees transient addTool registrations over a private
    // FD relay. The native registrations are read-only carriers so Command
    // Code's dont-ask mode reaches Polyth's authoritative per-call permission
    // gate even when the underlying package tool is mutating.
    tool: { modes: ["mcp"], mutability: "immediate", remote: false, configScope: "session" },
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

const revisionToken = (revision: string): string =>
  createHash("sha256").update(revision).digest("hex").slice(0, 24);

const targetKey = (context: HarnessContext): string =>
  createHash("sha256").update(JSON.stringify([
    context.projectId,
    resolve(context.cwd),
    context.sessionId ?? "",
  ])).digest("hex").slice(0, 24);

const privateDirectory = (spaceRoot: string, ...parts: string[]): string => {
  let current = resolve(spaceRoot);
  const rootStat = lstatSync(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Space storage root is not a private directory");
  }
  for (const part of parts) {
    current = join(current, part);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Command Code capability storage contains a non-directory component");
      }
    } else {
      mkdirSync(current, { mode: 0o700 });
    }
  }
  return current;
};

const existingPrivateDirectory = (spaceRoot: string, ...parts: string[]): string | undefined => {
  let current = resolve(spaceRoot);
  const rootStat = lstatSync(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Space storage root is not a private directory");
  }
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) return undefined;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Command Code capability storage contains a non-directory component");
    }
  }
  return current;
};

const writeRevisionFile = (path: string, body: string): void => {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Command Code capability file is not private");
    }
    if (readFileSync(path, "utf8") !== body) {
      throw new Error("Command Code capability revision is immutable");
    }
    return;
  }
  atomicWriteSync(path, body, 0o600);
};

const promptModDocument = (promptFile: string): string => [
  'import { readFile } from "node:fs/promises";',
  "",
  "export default async function polythCapabilityPrompt(cmd) {",
  `  const prompt = await readFile(${JSON.stringify(promptFile)}, "utf8");`,
  "  if (!prompt.trim()) return;",
  "  cmd.hooks({ appendSystemPrompt: () => prompt });",
  "}",
  "",
].join("\n");

const skillDocument = (
  skill: Extract<HarnessProvisioningPlan["items"][number]["capability"], { kind: "skill" }>,
): string => `---
name: ${JSON.stringify(skill.name)}
description: ${JSON.stringify(skill.description.replace(/[\r\n]+/g, " "))}
---
${skill.instructions}
`;

const toolModDocument = (
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
    "",
    `const tools = ${JSON.stringify(definitions)};`,
    'const requests = createWriteStream(null, { fd: 3, autoClose: false });',
    'const responses = createReadStream(null, { fd: 4, autoClose: false });',
    'const lines = createInterface({ input: responses, crlfDelay: Infinity });',
    'const pending = new Map();',
    'let bridgeClosed = false;',
    "",
    'const safeError = (value) => String(value ?? "Polyth tool failed").replace(/[\\u0000-\\u001f\\u007f]+/g, " ").replace(/\\s+/g, " ").trim().slice(0, 1000);',
    'const failAll = (message) => {',
    '  if (bridgeClosed) return;',
    '  bridgeClosed = true;',
    '  for (const entry of pending.values()) entry.finish({ ok: false, error: message });',
    '};',
    'requests.on("error", () => failAll("Polyth tool bridge disconnected"));',
    'requests.on("close", () => failAll("Polyth tool bridge disconnected"));',
    'responses.on("error", () => failAll("Polyth tool bridge disconnected"));',
    'responses.on("close", () => failAll("Polyth tool bridge disconnected"));',
    'lines.on("line", (line) => {',
    '  let message;',
    '  try { message = JSON.parse(line); } catch { failAll("Polyth tool bridge returned malformed response"); return; }',
    '  const id = typeof message?.id === "string" ? message.id : String(message?.id ?? "");',
    '  const entry = pending.get(id);',
    '  if (!entry) return;',
    '  if (message?.error) { entry.finish({ ok: false, error: safeError(message.error?.message) }); return; }',
    '  const result = message?.result;',
    '  const content = Array.isArray(result?.content)',
    '    ? result.content.filter((part) => part && part.type === "text" && typeof part.text === "string")',
    '    : [];',
    '  if (result?.isError === true) {',
    '    entry.finish({ ok: false, error: safeError(content.map((part) => part.text).join("\\n") || "Polyth tool failed") });',
    '    return;',
    '  }',
    '  entry.finish({ ok: true, content: content.length ? content : [{ type: "text", text: "" }] });',
    '});',
    "",
    'const invoke = (capabilityId, name, input, signal) => new Promise((resolve) => {',
    '  if (bridgeClosed) { resolve({ ok: false, error: "Polyth tool bridge disconnected" }); return; }',
    '  const id = randomUUID();',
    '  let settled = false;',
    '  const onAbort = () => {',
    '    try { requests.write(JSON.stringify({ type: "cancel", requestId: id }) + "\\n"); } catch {}',
    '    finish({ ok: false, error: "Polyth tool call aborted" });',
    '  };',
    '  const finish = (result) => {',
    '    if (settled) return;',
    '    settled = true;',
    '    pending.delete(id);',
    '    signal?.removeEventListener?.("abort", onAbort);',
    '    resolve(result);',
    '  };',
    '  pending.set(id, { finish });',
    '  if (signal?.aborted) { onAbort(); return; }',
    '  signal?.addEventListener?.("abort", onAbort, { once: true });',
    '  try {',
    '    requests.write(JSON.stringify({ type: "call", id, capabilityId, name, input: input ?? {} }) + "\\n");',
    '  } catch {',
    '    finish({ ok: false, error: "Polyth tool bridge is unavailable" });',
    '  }',
    '});',
    "",
    'export default function polythTools(cmd) {',
    '  for (const tool of tools) {',
    '    cmd.addTool({',
    '      schema: { name: tool.name, description: tool.description, input_schema: tool.inputSchema },',
    '      readOnly: true,',
    '      run: ({ input, signal }) => invoke(tool.id, tool.name, input, signal),',
    '    });',
    '  }',
    '}',
    "",
  ].join("\n");
};

const pruneRetiredRevisions = (context: HarnessContext, keep: readonly string[]): void => {
  if (!context.space || context.space.spaceId !== context.spaceId) return;
  const revisions = existingPrivateDirectory(
    context.space.storageDir,
    "runtime",
    "commandcode",
    "capabilities",
    targetKey(context),
    "revisions",
  );
  if (!revisions) return;
  const live = new Set(keep.map(revisionToken));
  for (const entry of readdirSync(revisions, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || live.has(entry.name)) continue;
    rmSync(join(revisions, entry.name), { recursive: true, force: true });
  }
};

export function createCommandCodeProvisioner(): HarnessProvisioner {
  return {
    support: (context) => support(context),
    async apply(context, plan, secrets: CapabilitySecretResolver) {
      if (context.remote) {
        return {
          harnessId: "commandcode",
          desiredRevision: plan.desiredRevision,
          records: plan.items
            .filter((item) => item.capability.id !== AGENT_TOOLS_CAPABILITY_ID)
            .map((item) => record(item, "unsupported", "Command Code adapter is local-only")),
        };
      }
      if (!context.space || context.space.spaceId !== context.spaceId) {
        return {
          harnessId: "commandcode",
          desiredRevision: plan.desiredRevision,
          records: plan.items
            .filter((item) => item.capability.id !== AGENT_TOOLS_CAPABILITY_ID)
            .map((item) => record(item, "failed", "Local Space storage is required")),
        };
      }

      const revisionRoot = privateDirectory(
        context.space.storageDir,
        "runtime",
        "commandcode",
        "capabilities",
        targetKey(context),
        "revisions",
        revisionToken(plan.desiredRevision),
      );
      const overlay: CommandCodeLaunchOverlay = {
        promptCapabilityIds: [],
        skillCapabilityIds: [],
        toolCapabilityIds: [],
      };
      const records: HarnessCapabilityRecord[] = [];

      const promptItems = plan.items.filter((item) =>
        item.mode !== "unsupported"
        && (item.capability.kind === "instruction" || item.capability.kind === "context"));
      if (promptItems.length) {
        try {
          const prompt = renderCapabilityText(plan);
          if (!prompt?.trim()) throw new Error("Command Code prompt projection is empty");
          const promptFile = join(revisionRoot, "system-prompt.txt");
          writeRevisionFile(promptFile, prompt);
          const promptModFile = join(revisionRoot, "polyth-capabilities.ts");
          writeRevisionFile(promptModFile, promptModDocument(promptFile));
          overlay.promptModFile = promptModFile;
          overlay.promptCapabilityIds = promptItems.map((item) => item.capability.id);
          for (const item of promptItems) records.push(record(item, "pending", "Staged for transient Command Code appendSystemPrompt projection"));
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Could not stage Command Code prompt projection";
          for (const item of promptItems) records.push(record(item, "failed", reason));
        }
      }

      const skillItems = plan.items.filter((item) => item.capability.kind === "skill");
      const duplicateSkillNames = new Set(skillItems.flatMap((item, index) => {
        if (item.capability.kind !== "skill") return [];
        const name = item.capability.name;
        return skillItems.some((candidate, candidateIndex) =>
          candidateIndex !== index && candidate.capability.kind === "skill" && candidate.capability.name === name)
          ? [name]
          : [];
      }));
      let skillRoot: string | undefined;
      for (const item of skillItems) {
        if (item.capability.kind !== "skill") continue;
        if (item.mode === "unsupported") {
          records.push(record(item, "unsupported", "Command Code does not support this skill scope"));
          continue;
        }
        if (duplicateSkillNames.has(item.capability.name)) {
          records.push(record(item, "failed", `Native Command Code skill name collision: ${item.capability.name}`));
          continue;
        }
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.capability.name) || item.capability.name.length > 64) {
          records.push(record(item, "failed", "Native Command Code skill name is invalid"));
          continue;
        }
        if (item.capability.description.length > 1024) {
          records.push(record(item, "failed", "Native Command Code skill description exceeds 1024 characters"));
          continue;
        }
        try {
          skillRoot ??= privateDirectory(revisionRoot, "skills");
          const directory = privateDirectory(skillRoot, item.capability.name);
          writeRevisionFile(join(directory, "SKILL.md"), skillDocument(item.capability));
          overlay.skillCapabilityIds.push(item.capability.id);
          records.push(record(item, "pending", "Staged for documented Command Code --skill projection"));
        } catch {
          records.push(record(item, "failed", "Could not stage the private native Command Code skill"));
        }
      }
      if (skillRoot && overlay.skillCapabilityIds.length) overlay.skillRoot = skillRoot;

      const toolItems = plan.items.filter((item) => item.capability.kind === "tool");
      const bridgeTools = toolItems.filter((item) =>
        item.capability.kind === "tool" && item.mode === "mcp");
      const validIdTools = bridgeTools.filter((item) => {
        if (item.capability.id.length <= MAX_TOOL_CAPABILITY_ID) return true;
        records.push(record(item, "failed", `Command Code tool capability id exceeds ${MAX_TOOL_CAPABILITY_ID} characters`));
        return false;
      });
      const projectedTools = validIdTools.length <= MAX_TOOL_CAPABILITIES ? validIdTools : [];
      if (validIdTools.length > MAX_TOOL_CAPABILITIES) {
        for (const item of validIdTools) {
          records.push(record(item, "failed", `Command Code tool bridge supports at most ${MAX_TOOL_CAPABILITIES} projected tools`));
        }
      }
      if (projectedTools.length) {
        const bridgeEnv = secrets.mcpSecrets(AGENT_TOOLS_CAPABILITY_ID);
        if (!bridgeEnv.POLYTH_AGENT_TOOLS_URL || !bridgeEnv.POLYTH_AGENT_TOOLS_TOKEN) {
          for (const item of projectedTools) records.push(record(item, "failed", "Scoped Polyth agent-tool bridge is unavailable"));
        } else {
          try {
            const tools = projectedTools.map((item) => item.capability)
              .filter((tool): tool is Extract<typeof tool, { kind: "tool" }> => tool.kind === "tool");
            const toolModFile = join(revisionRoot, "polyth-tools.ts");
            writeRevisionFile(toolModFile, toolModDocument(tools));
            overlay.toolModFile = toolModFile;
            overlay.toolCapabilityIds = tools.map((tool) => tool.id);
            overlay.toolBridge = {
              url: bridgeEnv.POLYTH_AGENT_TOOLS_URL,
              token: bridgeEnv.POLYTH_AGENT_TOOLS_TOKEN,
              capabilityIds: [...overlay.toolCapabilityIds],
            };
            for (const item of projectedTools) {
              records.push(record(item, "pending", "Staged for native Command Code addTool backed by the scoped Polyth permission bridge"));
            }
          } catch {
            for (const item of projectedTools) records.push(record(item, "failed", "Could not stage the transient Command Code tool Mod"));
          }
        }
      }
      for (const item of toolItems) {
        if (item.mode !== "unsupported" || records.some((row) => row.capabilityId === item.capability.id)) continue;
        records.push(record(item, "unsupported", "Command Code cannot project this Polyth tool scope"));
      }

      const preRecorded = new Set(records.map((item) => item.capabilityId));
      for (const item of plan.items) {
        if (item.capability.id === AGENT_TOOLS_CAPABILITY_ID || preRecorded.has(item.capability.id)) continue;
        if (item.mode === "unsupported" || item.capability.kind === "mcp-server") {
          const reason = item.capability.kind === "mcp-server"
            ? "Command Code has no verified non-persistent MCP projection; Polyth will not mutate vendor MCP files"
            : "Command Code has no verified transient projection for this capability";
          records.push(record(item, "unsupported", reason));
        } else {
          records.push(record(item, "unsupported", "Command Code has no verified transient projection for this capability"));
        }
      }

      const pendingIds = records.filter((item) => item.status === "pending").map((item) => item.capabilityId);
      if (pendingIds.length) {
        commandCodeOverlays.set(context, overlay, "commandcode", {
          desiredRevision: plan.desiredRevision,
          capabilityIds: pendingIds,
        });
      } else {
        commandCodeOverlays.delete(context, "commandcode");
      }
      pruneRetiredRevisions(context, [...(plan.keepRevisions ?? []), plan.desiredRevision]);
      return { harnessId: "commandcode", desiredRevision: plan.desiredRevision, records };
    },
    release(context, options) {
      commandCodeOverlays.release(context);
      pruneRetiredRevisions(context, options?.keepRevisions ?? []);
      if (!context.space || context.space.spaceId !== context.spaceId || (options?.keepRevisions?.length ?? 0) > 0) return;
      const root = existingPrivateDirectory(
        context.space.storageDir,
        "runtime",
        "commandcode",
        "capabilities",
        targetKey(context),
      );
      if (root) rmSync(root, { recursive: true, force: true });
    },
  };
}

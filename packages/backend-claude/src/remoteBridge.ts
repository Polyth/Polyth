// Delivery of a remote project's own Claude Code files to a harness that runs
// on this machine. With the CLI here and the project on an SSH host, Claude
// Code finds none of them: its working directory is an empty local placeholder.
// Copying them next to it is wrong too: a project's hooks would then run on
// THIS machine, and nested instructions and skill files still would not load.
//
// So Polyth reads them on the host and delivers each piece itself:
//   - CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md and their `@imports`
//     become part of the system prompt;
//   - a nested CLAUDE.md joins the first tool result that touches its folder;
//   - skills are listed with their host paths and read with the remote tools;
//   - command hooks of .claude/settings.json run ON THE HOST, in the project;
//   - the settings' `deny` and `ask` permission rules join Polyth's policy.
//
// Everything read here is the project's content, not authority: a hook can
// refuse a call or add context, never approve one, and `allow` rules are not
// read at all.
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { RemoteWorkspace, RemoteWorkspaceExecResult } from "@polyth/harness-runtime/remote-workspace";
import {
  restrictingRulesFromSettings,
  workspaceRuleCovers,
  type WorkspacePolicyContext,
  type WorkspacePolicyRules,
  type WorkspaceToolCall,
} from "@polyth/permissions/workspace-policy";

export const BRIDGED_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"] as const;
export type BridgedHookEvent = (typeof BRIDGED_HOOK_EVENTS)[number];

export interface BridgedHook {
  event: BridgedHookEvent;
  command: string;
  timeoutMs: number;
  /** Tool-name matcher of its group (tool events only). */
  matcher?: string;
  /** The hook's own `if` filter, in permission-rule syntax. */
  condition?: string;
}

export interface BridgedSkill {
  name: string;
  description: string;
  /** Absolute path of its SKILL.md on the host. */
  file: string;
}

export interface BridgedHookOutcome {
  /** A hook refused: the tool call or prompt must not go ahead. */
  block?: string;
  /** A hook wants a person to decide. */
  ask?: string;
  /** Text the hooks add for the model. */
  context: string[];
}

export interface RemoteProjectBridge {
  /** The SSH user's home on the host, when it answered. */
  home?: string;
  /** Project instructions and the skill list, for the system prompt. */
  instructions: string;
  rules: Required<WorkspacePolicyRules>;
  skills: BridgedSkill[];
  hooks: BridgedHook[];
  /** What exists on the host but is not delivered (shown in the prompt and logs). */
  skipped: string[];
  /** Instructions of nested folders this path is in, each delivered once. */
  nestedInstructions(path: string, kind: "file" | "directory"): Promise<string>;
  /** Runs the project's hooks for one event on the host. */
  runHooks(event: BridgedHookEvent, input: {
    /** Native tool name (`Bash`, `Edit`…) of a tool event. */
    toolName?: string;
    call?: WorkspaceToolCall;
    payload: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<BridgedHookOutcome>;
}

const MAX_FILE_BYTES = 65_536;
const MAX_SETTINGS_BYTES = 262_144;
const MAX_INSTRUCTION_CHARS = 150_000;
const MAX_IMPORT_FILES = 24;
const MAX_IMPORT_DEPTH = 3;
const MAX_NESTED = 200;
const MAX_SKILLS = 50;
const MAX_HOOKS = 64;
const MAX_CONTEXT_CHARS = 10_000;
const HOOK_DEFAULT_MS = 60_000;
const HOOK_MAX_MS = 600_000;
const INSTRUCTION_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];

// The separator is random per call and passed as a parameter, so a file's own
// text cannot forge a section boundary.
const GATHER_SCRIPT = [
  "sep=$1",
  'emit() { printf \'\\n%s %s\\n\' "$sep" "$1"; }',
  'emit home; printf %s "$HOME"',
  `for f in ${INSTRUCTION_FILES.join(" ")}; do if [ -f "$f" ]; then emit "instructions $f"; head -c ${MAX_FILE_BYTES} -- "$f"; fi; done`,
  "emit nested",
  "find . -mindepth 2 -maxdepth 8 \\( -name .git -o -name node_modules -o -name .venv -o -name venv -o -name vendor -o -name target -o -name dist -o -name build -o -name .claude \\) -prune -o -type f -name CLAUDE.md -print 2>/dev/null"
    + ` | head -n ${MAX_NESTED}`,
  `for f in .claude/settings.json .claude/settings.local.json; do if [ -f "$f" ]; then emit "settings $f"; head -c ${MAX_SETTINGS_BYTES} -- "$f"; fi; done`,
  `n=0; for f in .claude/skills/*/SKILL.md; do if [ -f "$f" ] && [ "$n" -lt ${MAX_SKILLS} ]; then n=$((n+1)); emit "skill $f"; head -c 4096 -- "$f"; fi; done`,
  "for d in .claude/commands .claude/agents .claude/rules; do if [ -d \"$d\" ]; then emit \"present $d\"; fi; done",
  'if [ -f .mcp.json ]; then emit "present .mcp.json"; fi',
  "emit end",
].join("\n");
const FILES_SCRIPT = [
  "sep=$1; shift",
  `for f in "$@"; do if [ -f "$f" ]; then printf '\\n%s file %s\\n' "$sep" "$f"; head -c ${MAX_FILE_BYTES} -- "$f"; fi; done`,
  "printf '\\n%s end\\n' \"$sep\"",
].join("\n");
const HOOK_SCRIPT = 'CLAUDE_PROJECT_DIR=$2; export CLAUDE_PROJECT_DIR; exec sh -c "$1"';

/** Sections of a gather answer: `[label, body]` in order. */
export function parseBridgeSections(output: string, separator: string): Array<[string, string]> {
  const sections: Array<[string, string]> = [];
  for (const chunk of output.split(`\n${separator} `).slice(1)) {
    const cut = chunk.indexOf("\n");
    sections.push(cut < 0 ? [chunk, ""] : [chunk.slice(0, cut), chunk.slice(cut + 1)]);
  }
  return sections;
}

/** `@path` imports of an instruction file, as paths relative to the project
 * root. Code blocks and code spans are text, not imports; anything that
 * leaves the project is dropped. */
export function claudeInstructionImports(text: string, file: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const found = new Set<string>();
  for (const match of prose.matchAll(/(?:^|\s)@((?:\.{1,2}\/)?[A-Za-z0-9_.\-/]+)/g)) {
    const target = match[1]!.replace(/[.,;:]+$/, "");
    // An absolute import names a file outside the project.
    if (!target || target.endsWith("/") || target.startsWith("/")) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file), target));
    if (resolved.startsWith("..") || resolved.startsWith("/")) continue;
    found.add(resolved);
    if (found.size >= MAX_IMPORT_FILES) break;
  }
  return [...found];
}

/** `name`, `description` and whether the model may pick the skill itself. */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string; modelInvocable: boolean } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const field = (key: string): string | undefined => {
    const value = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(block)?.[1]?.trim();
    if (!value) return undefined;
    return value.replace(/^(["'])(.*)\1$/, "$2").replace(/\p{Cc}/gu, " ").slice(0, 500);
  };
  return {
    ...(field("name") ? { name: field("name")! } : {}),
    ...(field("description") ? { description: field("description")! } : {}),
    modelInvocable: field("disable-model-invocation")?.toLowerCase() !== "true",
  };
}

/** The command hooks of a settings file for the bridged events. */
export function bridgedHooksFromSettings(settings: unknown): { hooks: BridgedHook[]; skipped: number } {
  const hooks: BridgedHook[] = [];
  let skipped = 0;
  const source = settings && typeof settings === "object" ? (settings as { hooks?: unknown }).hooks : undefined;
  if (!source || typeof source !== "object") return { hooks, skipped };
  for (const [event, groups] of Object.entries(source as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    const bridged = (BRIDGED_HOOK_EVENTS as readonly string[]).includes(event);
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const { matcher, hooks: entries } = group as { matcher?: unknown; hooks?: unknown };
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const hook = entry as { type?: unknown; command?: unknown; timeout?: unknown; if?: unknown };
        if (!bridged || hook.type !== "command" || typeof hook.command !== "string" || !hook.command.trim() || hooks.length >= MAX_HOOKS) {
          skipped += 1;
          continue;
        }
        const seconds = typeof hook.timeout === "number" && hook.timeout > 0 ? hook.timeout : HOOK_DEFAULT_MS / 1000;
        hooks.push({
          event: event as BridgedHookEvent,
          command: hook.command,
          timeoutMs: Math.min(Math.round(seconds * 1000), HOOK_MAX_MS),
          ...(typeof matcher === "string" && matcher && matcher !== "*" ? { matcher } : {}),
          ...(typeof hook.if === "string" && hook.if.trim() ? { condition: hook.if.trim() } : {}),
        });
      }
    }
  }
  return { hooks, skipped };
}

const matcherCovers = (matcher: string | undefined, toolName: string | undefined): boolean => {
  if (!matcher) return true;
  if (!toolName) return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
};

const clipContext = (text: string): string => text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}… [truncated]` : text;

/** What one finished hook means. Exit 2 and a JSON `deny`/`block` refuse;
 * `ask` hands the call to a person; `allow` is ignored on purpose. */
export function interpretHookResult(
  event: BridgedHookEvent,
  result: Pick<RemoteWorkspaceExecResult, "code" | "stderr" | "timedOut" | "aborted"> & { stdout: string },
): { block?: string; ask?: string; context?: string } {
  if (result.timedOut || result.aborted || result.code === 255) return {};
  const blocking = event !== "SessionStart";
  if (result.code === 2) return blocking ? { block: result.stderr.trim().slice(0, 2_000) || "Blocked by a project hook." } : {};
  if (result.code !== 0) return {};
  const stdout = result.stdout.trim();
  if (!stdout) return {};
  if (stdout.startsWith("{")) {
    let json: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(stdout) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch { /* plain text that happens to start with a brace */ }
    if (json) {
      const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, 2_000) : undefined;
      const specific = json.hookSpecificOutput && typeof json.hookSpecificOutput === "object"
        ? json.hookSpecificOutput as Record<string, unknown>
        : {};
      const context = text(specific.additionalContext);
      const withContext = context ? { context: clipContext(context) } : {};
      if (blocking && json.continue === false) return { block: text(json.stopReason) ?? "A project hook stopped this.", ...withContext };
      if (blocking && json.decision === "block") return { block: text(json.reason) ?? "Blocked by a project hook.", ...withContext };
      if (event === "PreToolUse" && specific.permissionDecision === "deny") {
        return { block: text(specific.permissionDecisionReason) ?? "Blocked by a project hook.", ...withContext };
      }
      if (event === "PreToolUse" && specific.permissionDecision === "ask") {
        return { ask: text(specific.permissionDecisionReason) ?? "A project hook asks for confirmation.", ...withContext };
      }
      return withContext;
    }
  }
  // Plain output is context only where Claude Code treats it so.
  return event === "SessionStart" || event === "UserPromptSubmit" ? { context: clipContext(stdout) } : {};
}

const unreachable = (workspace: RemoteWorkspace, result: RemoteWorkspaceExecResult): Error => Object.assign(
  new Error(`Could not reach ${workspace.label}: ${result.timedOut ? "no answer in time" : result.stderr.trim().slice(0, 200) || `exit ${result.code}`}`),
  { code: "runtime-unavailable" },
);

/** Reads the project's Claude Code files on the host: one round trip, plus
 * one per level of `@imports`. Throws `runtime-unavailable` when the host or
 * the project folder cannot be reached. */
export async function loadRemoteProjectBridge(workspace: RemoteWorkspace, sessionId: string): Promise<RemoteProjectBridge> {
  const { root } = workspace;
  const separator = `POLYTH-BRIDGE-${randomUUID()}`;
  const gathered = await workspace.exec(GATHER_SCRIPT, { args: [separator], timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 });
  const sections = parseBridgeSections(gathered.stdout.toString("utf8"), separator);
  if (gathered.code !== 0 || sections.at(-1)?.[0] !== "end") throw unreachable(workspace, gathered);

  let home: string | undefined;
  const files = new Map<string, string>();
  const nested: string[] = [];
  const skills: BridgedSkill[] = [];
  const hooks: BridgedHook[] = [];
  const skipped: string[] = [];
  const deny: string[] = [];
  const ask: string[] = [];
  let skippedHooks = 0;
  for (const [label, body] of sections) {
    const [kind, ...rest] = label.split(" ");
    const name = rest.join(" ");
    if (kind === "home") {
      if (body.startsWith("/")) home = body.trim();
    } else if (kind === "instructions") {
      if (body.trim()) files.set(name, body);
    } else if (kind === "nested") {
      for (const line of body.split("\n")) {
        const dir = posix.dirname(posix.normalize(line.trim()));
        if (line.trim() && dir !== "." && !dir.startsWith("..") && !dir.startsWith("/")) nested.push(dir);
      }
    } else if (kind === "settings") {
      let settings: unknown;
      try {
        settings = JSON.parse(body);
      } catch {
        skipped.push(`${name} (not valid JSON)`);
        continue;
      }
      const restricting = restrictingRulesFromSettings(settings);
      deny.push(...restricting.deny);
      ask.push(...restricting.ask);
      const found = bridgedHooksFromSettings(settings);
      hooks.push(...found.hooks.slice(0, MAX_HOOKS - hooks.length));
      skippedHooks += found.skipped;
    } else if (kind === "skill") {
      const meta = parseSkillFrontmatter(body);
      if (!meta.modelInvocable) continue;
      skills.push({
        name: meta.name ?? posix.basename(posix.dirname(name)),
        description: meta.description ?? "",
        file: posix.join(root, name),
      });
    } else if (kind === "present") {
      skipped.push(name);
    }
  }
  if (skippedHooks) skipped.push(`${skippedHooks} hook${skippedHooks === 1 ? "" : "s"} of an unsupported type or event`);

  // `@imports`, level by level; a file is read once however often it is named.
  const imported = new Map<string, { text: string; by: string }>();
  let frontier = [...files].map(([file, text]) => ({ file, text }));
  for (let depth = 0; depth < MAX_IMPORT_DEPTH && frontier.length; depth++) {
    const wanted = new Map<string, string>();
    for (const { file, text } of frontier) {
      for (const target of claudeInstructionImports(text, file)) {
        if (!files.has(target) && !imported.has(target) && !wanted.has(target) && imported.size + wanted.size < MAX_IMPORT_FILES) {
          wanted.set(target, file);
        }
      }
    }
    if (!wanted.size) break;
    const fetched = await workspace.exec(FILES_SCRIPT, { args: [separator, ...wanted.keys()], timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 });
    frontier = [];
    for (const [label, body] of parseBridgeSections(fetched.stdout.toString("utf8"), separator)) {
      const file = label.startsWith("file ") ? label.slice(5) : undefined;
      if (!file || !wanted.has(file) || !body.trim()) continue;
      imported.set(file, { text: body, by: wanted.get(file)! });
      frontier.push({ file, text: body });
    }
  }

  const parts: string[] = [];
  if (files.size) {
    parts.push([
      "# Project instructions",
      `These are the project's own instruction files on ${workspace.label}. Follow them the way you follow a CLAUDE.md of the project you work in.`,
      ...[...files].map(([file, text]) => `## ${posix.join(root, file)}\n${text.trim()}`),
      ...[...imported].map(([file, entry]) => `## ${posix.join(root, file)} (imported by ${entry.by})\n${entry.text.trim()}`),
    ].join("\n\n"));
  }
  if (skills.length) {
    parts.push([
      "# Project skills",
      `The project has skills on ${workspace.label}. To use one, read its SKILL.md with the remote read tool and follow it; its bundled files sit in the same folder, and its scripts run there with the remote bash tool. A line starting with an exclamation mark and a command in backticks means: run that command with the remote bash tool and use its output.`,
      ...skills.map((skill) => `- ${skill.name}: ${skill.description || "(no description)"} — ${skill.file}`),
    ].join("\n"));
  }
  let instructions = parts.join("\n\n");
  if (instructions.length > MAX_INSTRUCTION_CHARS) {
    instructions = `${instructions.slice(0, MAX_INSTRUCTION_CHARS)}\n… [project instructions truncated]`;
    skipped.push("instructions beyond the size limit");
  }

  const policy: WorkspacePolicyContext = { root, ...(home ? { home } : {}) };
  const delivered = new Set<string>();

  return {
    ...(home ? { home } : {}),
    instructions,
    rules: { deny, ask },
    skills,
    hooks,
    skipped,
    async nestedInstructions(path, kind) {
      if (!nested.length) return "";
      const relative = posix.relative(root, path);
      if (relative.startsWith("..") || posix.isAbsolute(relative)) return "";
      const dir = kind === "directory" ? relative || "." : posix.dirname(relative);
      const due = nested.filter((candidate) => !delivered.has(candidate) && (dir === candidate || dir.startsWith(`${candidate}/`)));
      if (!due.length) return "";
      for (const candidate of due) delivered.add(candidate);
      const fetched = await workspace.exec(FILES_SCRIPT, {
        args: [separator, ...due.map((candidate) => posix.join(candidate, "CLAUDE.md"))],
        timeoutMs: 20_000,
        maxBytes: 1024 * 1024,
      });
      let out = "";
      const got = new Set<string>();
      for (const [label, body] of parseBridgeSections(fetched.stdout.toString("utf8"), separator)) {
        const file = label.startsWith("file ") ? label.slice(5) : undefined;
        const candidate = file ? posix.dirname(file) : undefined;
        if (!candidate || !due.includes(candidate) || !body.trim()) continue;
        got.add(candidate);
        out += `\n\n<system-reminder>\nProject instructions for files under ${candidate}/ (from ${posix.join(root, file!)} on the host):\n${body.trim()}\n</system-reminder>`;
      }
      // An unreachable host is retried on the next call; a file that is gone is not.
      if (fetched.code !== 0) for (const candidate of due) if (!got.has(candidate)) delivered.delete(candidate);
      return out;
    },
    async runHooks(event, input) {
      const outcome: BridgedHookOutcome = { context: [] };
      const due = hooks.filter((hook) => hook.event === event
        && (event === "SessionStart" || event === "UserPromptSubmit" || matcherCovers(hook.matcher, input.toolName))
        && (!hook.condition || (input.call !== undefined && workspaceRuleCovers(hook.condition, input.call, policy))));
      if (!due.length) return outcome;
      const stdin = JSON.stringify({
        session_id: sessionId,
        transcript_path: "",
        cwd: root,
        hook_event_name: event,
        ...input.payload,
      });
      // Matching hooks run side by side, as Claude Code runs them.
      const results = await Promise.all(due.map(async (hook) => {
        const result = await workspace.exec(HOOK_SCRIPT, {
          args: [hook.command, root],
          stdin,
          timeoutMs: hook.timeoutMs,
          maxBytes: 256 * 1024,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return interpretHookResult(event, { ...result, stdout: result.stdout.toString("utf8") });
      }));
      for (const result of results) {
        if (result.block && !outcome.block) outcome.block = result.block;
        if (result.ask && !outcome.ask) outcome.ask = result.ask;
        if (result.context) outcome.context.push(result.context);
      }
      return outcome;
    },
  };
}

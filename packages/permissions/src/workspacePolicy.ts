// Polyth's own policy for shell and file tools that Polyth runs on a
// workspace itself (a project on an SSH host worked on by a harness on this
// machine). A harness's native permission rules do not reach such tools: it
// asks about every call, offers to remember only the whole tool, and applies
// neither its command rules nor its plan mode. This module decides, per call:
//
//   allow  a read that stays inside the workspace and touches no secret,
//   deny   what a rule forbids, and any change while a plan is being made,
//   ask    everything else, under the harness's native permission name, so
//          the session's rules, risk assessment and Auto-Approve treat a
//          remote `Bash` exactly like a local one.
//
// It reads commands with the same parser as the risk assessment and shares
// its limits: it sees what a command names, not what a script does. "allow"
// is therefore a short list of commands that only read, never a guess. Pure,
// no Node imports.
import { assessPermissionRisk, riskParsing } from "./risk.ts";

const { parseShell, commandOf, gitCommand, placeOf, isSecretPath, normalizeAbsolute, base } = riskParsing;

export const WORKSPACE_TOOLS = ["bash", "read", "write", "edit", "grep", "glob"] as const;
export type WorkspaceTool = (typeof WORKSPACE_TOOLS)[number];

/** Permission names of the request, as the harness's own tools use them. */
export const WORKSPACE_TOOL_PERMISSION: Record<WorkspaceTool, string> = {
  bash: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", glob: "Glob",
};

export interface WorkspaceToolCall {
  tool: WorkspaceTool;
  /** The shell command (`bash`). */
  command?: string;
  /** Absolute, normalized target path (file tools). */
  path?: string;
}

/** Rules in Claude Code's settings syntax: `Bash(rm:*)`, `Read(./.env)`,
 * `Edit(/src/**)`, `Write`. Only restricting lists exist here: a workspace's
 * own files may narrow what an agent does there, never widen it. */
export interface WorkspacePolicyRules {
  deny?: readonly string[];
  ask?: readonly string[];
}

export interface WorkspacePolicyContext {
  /** Absolute workspace root; relative paths and commands start here. */
  root: string;
  /** Other absolute roots the session may work in. */
  extraRoots?: readonly string[];
  /** Home directory on the workspace's machine, for `~/…` rules. */
  home?: string;
  rules?: WorkspacePolicyRules;
  /** The harness is planning: nothing may change until the plan is approved. */
  planMode?: boolean;
}

export type WorkspaceToolDecision =
  | { action: "allow"; reason: "read-only" }
  | { action: "deny"; reason: "rule" | "plan-mode"; message: string; rule?: string }
  | {
    action: "ask";
    permission: string;
    patterns: string[];
    /** The `ask` rule that sent an otherwise allowed call to a person. */
    rule?: string;
  };

const MAX_COMMAND = 8_192;
const MAX_SEGMENTS = 24;

// ---- read-only shell commands ------------------------------------------------

/** Commands that only read, whatever their arguments (within the path checks). */
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "stat", "file", "which", "type", "whoami",
  "uname", "id", "true", "false", "test", "[", "cd", "basename", "dirname", "realpath", "readlink", "cut", "tr",
  "nl", "tac", "rev", "column", "diff", "cmp", "comm", "du", "df", "free", "uptime", "nproc", "arch",
  "md5sum", "sha1sum", "sha256sum", "grep", "egrep", "fgrep", "jq", "seq", "expr",
]);
/** Read-only unless one of these options is present. */
const READ_ONLY_UNLESS: Record<string, RegExp> = {
  sort: /^(-o|--output)/,
  uniq: /^$/,
  tree: /^(-o|--output)/,
  date: /^(-s|--set)/,
  hostname: /^$/,
  rg: /^--pre(-glob)?(=|$)/,
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
};
/** `uniq in out` and `hostname name` write through a plain argument. */
const MAX_POSITIONALS: Record<string, number> = { uniq: 1, hostname: 0 };
/** Prefix words that run the command unchanged. Others (`npx`, `xargs`,
 * `watch`, `env`, assignments) can change what runs or where. */
const PLAIN_RUNNERS = new Set(["time", "command", "nice", "timeout", "stdbuf", "builtin"]);

/** Commands whose first plain argument is a search pattern or a filter. */
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "jq"]);
/** Commands whose arguments are text, not paths. */
const TEXT_ARGUMENTS = new Set(["echo", "printf", "test", "[", "expr", "seq"]);

const GIT_READ_ONLY = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog",
  "cat-file", "merge-base", "rev-list", "show-ref", "grep", "branch", "tag", "remote", "stash",
]);

const positional = (args: readonly string[]): string[] => args.filter((arg) => !arg.startsWith("-"));

function gitReadOnly(args: readonly string[]): boolean {
  // `-c name=value` and `--exec-path` can make git run any program.
  if (args.some((arg) => arg === "-c" || /^--(exec-path|config-env)(=|$)/.test(arg))) return false;
  const { sub, rest } = gitCommand(args);
  if (!GIT_READ_ONLY.has(sub)) return false;
  if (rest.some((arg) => /^--output(=|$)/.test(arg) || arg === "--ext-diff")) return false;
  if (sub === "branch") {
    return positional(rest).length === 0
      && rest.every((arg) => /^(-a|-r|-v|-vv|--all|--remotes|--verbose|--list|--show-current|--no-color|--color(=.*)?)$/.test(arg));
  }
  if (sub === "tag") return positional(rest).length === 0 && rest.every((arg) => /^(-l|--list|-n\d*)$/.test(arg));
  if (sub === "remote") return rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose"));
  if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
  return true;
}

/** A word that could be a path stays inside the workspace and names no secret. */
function readablePlace(word: string, root: string, roots: readonly string[]): boolean {
  if (isSecretPath(word)) return false;
  const place = placeOf(word, root, roots);
  return place === "inside" || place === "temp" || place === "null-device";
}

function readOnlySegment(words: readonly string[], root: string, roots: readonly string[]): boolean {
  const command = commandOf(words);
  if (!command || !command.name || command.privileged || command.fromInput) return false;
  const first = base(words[0] ?? "");
  if (first !== command.name && !PLAIN_RUNNERS.has(first)) return false;
  const { name } = command;
  // Redirections: output only to a null device, input from a readable file.
  const args: string[] = [];
  for (let index = 0; index < command.args.length; index++) {
    const word = command.args[index]!;
    if (word === ">" || word === ">>") {
      const target = command.args[++index];
      if (target === undefined || placeOf(target, root, roots) !== "null-device") return false;
    } else if (word === "<<" || word === "<<<") {
      return false;
    } else if (word !== "<") {
      args.push(word);
    }
  }
  if (name === "git") {
    if (!gitReadOnly(args)) return false;
  } else if (name in READ_ONLY_UNLESS) {
    const forbidden = READ_ONLY_UNLESS[name]!;
    if (forbidden.source !== "^$" && args.some((arg) => forbidden.test(arg))) return false;
    const limit = MAX_POSITIONALS[name];
    if (limit !== undefined && positional(args).length > limit) return false;
  } else if (!READ_ONLY_COMMANDS.has(name)) {
    return false;
  }
  if (name === "cd" && positional(args).length !== 1) return false;
  // The first plain word of a search is its pattern, not a path.
  const patternFirst = PATTERN_FIRST.has(name) && !args.some((arg) => /^(-e|-f|--regexp|--file)(=|$)/.test(arg));
  let skipped = false;
  for (const arg of args) {
    if (arg.startsWith("-")) {
      // `--file=/etc/passwd` and `-f/etc/passwd` name a path as much as a bare word does.
      const at = arg.includes("=") ? arg.indexOf("=") + 1 : arg.search(/[/~]/);
      if (at > 0 && !readablePlace(arg.slice(at), root, roots)) return false;
      continue;
    }
    if (patternFirst && !skipped) { skipped = true; continue; }
    // Words of `echo` and `test` are text unless they look like a path.
    if (TEXT_ARGUMENTS.has(name) && !/^[/~]|\.\.|\//.test(arg)) continue;
    if (!readablePlace(arg, root, roots)) return false;
  }
  return true;
}

/** Whether a shell command only reads inside the workspace. Conservative: a
 * substitution, a variable in a path, an unknown command or a write of any
 * kind makes it not read-only. */
export function isReadOnlyShellCommand(command: string, context: Pick<WorkspacePolicyContext, "root" | "extraRoots">): boolean {
  const text = command.trim();
  if (!text || text.length > MAX_COMMAND) return false;
  // Substitutions and expansions can supply a command or a path unseen.
  if (/`|\$\(|[<>]\(|\$\{|\\\r?\n/.test(text)) return false;
  const roots = workspaceRoots(context);
  if (assessPermissionRisk({ permission: "bash", patterns: [text] }, { workspaceRoots: roots }).risk === "high") return false;
  const hidden = { found: false };
  const segments = parseShell(text, hidden);
  if (hidden.found || segments.length === 0 || segments.length > MAX_SEGMENTS) return false;
  return segments.every((segment) => readOnlySegment(segment.words, roots[0]!, roots));
}

const workspaceRoots = (context: Pick<WorkspacePolicyContext, "root" | "extraRoots">): string[] =>
  [context.root, ...(context.extraRoots ?? [])].filter((root) => root.startsWith("/")).map(normalizeAbsolute);

// ---- rules ---------------------------------------------------------------------

interface ParsedRule { source: string; tool: string; spec?: string }

const RULE_TOOLS: Record<string, readonly WorkspaceTool[]> = {
  bash: ["bash"],
  read: ["read", "grep", "glob"],
  grep: ["grep"],
  glob: ["glob"],
  edit: ["edit", "write"],
  multiedit: ["edit"],
  write: ["write"],
};

function parseRule(source: string): ParsedRule | undefined {
  const match = /^\s*([A-Za-z_][\w-]*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(source);
  if (!match) return undefined;
  const spec = match[2]?.trim();
  return { source: source.trim(), tool: match[1]!.toLowerCase(), ...(spec ? { spec } : {}) };
}

const escapeRegExp = (value: string): string => value.replace(/[.+^${}()|[\]\\?]/g, "\\$&");

/** `rm:*` and `rm *` cover `rm` and `rm -rf x` but not `rmdir`; a `*`
 * elsewhere matches any text; anything else is the exact command. */
function commandRuleMatches(spec: string, command: string): boolean {
  const wordPrefix = spec.endsWith(":*") ? spec.slice(0, -2) : spec.endsWith(" *") ? spec.slice(0, -2) : undefined;
  if (wordPrefix !== undefined && !wordPrefix.includes("*")) {
    return command === wordPrefix || command.startsWith(`${wordPrefix} `);
  }
  if (!spec.includes("*")) return command === spec;
  const body = (wordPrefix ?? spec).split("*").map(escapeRegExp).join("[\\s\\S]*");
  return new RegExp(`^${body}${wordPrefix !== undefined ? "(?: [\\s\\S]*)?" : ""}$`).test(command);
}

/** Gitignore-style path rule: `//abs`, `~/home`, `/from-root`, `./relative`,
 * and a pattern without a slash at any depth. A match covers what is under it. */
function pathRuleMatches(spec: string, path: string, context: WorkspacePolicyContext): boolean {
  const root = normalizeAbsolute(context.root);
  let pattern: string;
  if (spec.startsWith("//")) pattern = spec.slice(1);
  else if (spec.startsWith("~/")) {
    if (!context.home) return false;
    pattern = `${normalizeAbsolute(context.home)}/${spec.slice(2)}`;
  } else if (spec.startsWith("/")) pattern = `${root}${spec}`;
  else if (spec.startsWith("./")) pattern = `${root}/${spec.slice(2)}`;
  else if (spec.replace(/\/+$/, "").includes("/")) pattern = `${root}/${spec}`;
  else pattern = `/**/${spec}`;
  pattern = pattern.replace(/\/+$/, "");
  let body = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    // `dir/**` is the directory and everything in it.
    if (char === "/" && pattern.slice(index) === "/**") break;
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") { body += "(?:[^/]+/)*"; index += 2; }
      else { body += ".*"; index += 1; }
    } else if (char === "*") body += "[^/]*";
    else if (char === "?") body += "[^/]";
    else body += escapeRegExp(char);
  }
  return new RegExp(`^${body}(?:/.*)?$`).test(path);
}

/** Every simple command of a shell line, as written and without its wrappers
 * (`sudo rm x` is also `rm x`), so a rule cannot be stepped around with `&&`. */
function ruleCandidates(command: string): string[] {
  const text = command.trim();
  const found = new Set<string>([text]);
  if (text.length > MAX_COMMAND) return [...found];
  for (const segment of parseShell(text, { found: false }).slice(0, MAX_SEGMENTS * 2)) {
    found.add(segment.words.join(" "));
    const parsed = commandOf(segment.words);
    if (parsed?.name) found.add([parsed.name, ...parsed.args].join(" "));
  }
  return [...found];
}

function matchingRule(rules: readonly string[] | undefined, call: WorkspaceToolCall, context: WorkspacePolicyContext): string | undefined {
  if (!rules?.length) return undefined;
  let candidates: string[] | undefined;
  for (const source of rules.slice(0, 512)) {
    if (typeof source !== "string") continue;
    const rule = parseRule(source);
    if (!rule || !RULE_TOOLS[rule.tool]?.includes(call.tool)) continue;
    if (rule.spec === undefined) return rule.source;
    if (call.tool === "bash") {
      candidates ??= ruleCandidates(call.command ?? "");
      if (candidates.some((candidate) => commandRuleMatches(rule.spec!, candidate))) return rule.source;
    } else if (call.path && pathRuleMatches(rule.spec, call.path, context)) {
      return rule.source;
    }
  }
  return undefined;
}

/** Whether one rule in settings syntax covers a call (a project hook's `if` filter). */
export function workspaceRuleCovers(rule: string, call: WorkspaceToolCall, context: WorkspacePolicyContext): boolean {
  return matchingRule([rule], call, context) !== undefined;
}

// ---- decision ------------------------------------------------------------------

/** Decide one workspace tool call. Pure and bounded. */
export function decideWorkspaceToolCall(call: WorkspaceToolCall, context: WorkspacePolicyContext): WorkspaceToolDecision {
  const roots = workspaceRoots(context);
  const root = roots[0] ?? "/";
  const command = call.command ?? "";
  const path = call.path ?? root;

  const denied = matchingRule(context.rules?.deny, call, context);
  if (denied) {
    return { action: "deny", reason: "rule", rule: denied, message: `Blocked by the permission rule ${denied}. Do not work around it.` };
  }

  let readOnly: boolean;
  if (call.tool === "bash") readOnly = isReadOnlyShellCommand(command, context);
  else if (call.tool === "write" || call.tool === "edit") readOnly = false;
  else readOnly = readablePlace(path, root, roots);
  const changes = call.tool === "write" || call.tool === "edit" || (call.tool === "bash" && !readOnly);

  if (context.planMode && changes) {
    return {
      action: "deny",
      reason: "plan-mode",
      message: "Plan mode is on: nothing on the host may change until the plan is approved. Keep exploring with read-only commands.",
    };
  }

  const asked = matchingRule(context.rules?.ask, call, context);
  if (readOnly && !asked) return { action: "allow", reason: "read-only" };

  return {
    action: "ask",
    permission: WORKSPACE_TOOL_PERMISSION[call.tool],
    patterns: [call.tool === "bash" ? command : path],
    ...(asked ? { rule: asked } : {}),
  };
}

/** The `deny` and `ask` lists of a Claude Code settings file's `permissions`;
 * anything else in it (`allow`, modes, directories) is deliberately ignored. */
export function restrictingRulesFromSettings(settings: unknown): Required<WorkspacePolicyRules> {
  const permissions = settings && typeof settings === "object" ? (settings as { permissions?: unknown }).permissions : undefined;
  const list = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length <= 1_024).slice(0, 256)
    : [];
  const source = permissions && typeof permissions === "object" ? permissions as { deny?: unknown; ask?: unknown } : {};
  return { deny: list(source.deny), ask: list(source.ask) };
}

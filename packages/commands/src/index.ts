// Slash commands + snippets, polyth-style discovery and expansion.
import { exec } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const FILE_INCLUDE_MAX = 64 * 1024;
const SHELL_TIMEOUT_MS = 10_000;

export type CommandScope = "user" | "project" | "builtin";

export interface SlashCommand {
  name: string;
  description: string;
  prompt: string;
  agent?: string;
  model?: string;
  scope: CommandScope;
}

export interface Snippet {
  alias: string;
  text: string;
  scope: CommandScope;
}

export interface CommandList {
  commands: SlashCommand[];
  snippets: Snippet[];
}

export interface ExpandContext {
  cwd?: string;
}

export interface ExpandResult {
  text: string;
  raw: string;
  usedCommand?: string;
  agent?: string;
  model?: string;
}

export interface CommandService {
  list(root: string): Promise<CommandList>;
  expand(root: string, text: string, ctx?: ExpandContext): Promise<ExpandResult>;
}

export interface CommandServiceOptions {
  /** Override user-scope home (default: $HOME). Tests inject a temp dir. */
  home?: string;
}

const BUILTINS: SlashCommand[] = [
  {
    name: "init",
    description: "Analyse the repo and write or refresh AGENTS.md",
    prompt:
      "Analyse this repository's layout, conventions, and tooling. Write or refresh AGENTS.md with concise rules an agent needs to work here.",
    scope: "builtin",
  },
  {
    name: "review",
    description: "Review current changes",
    prompt:
      "Review the current uncommitted changes. Call out bugs, risks, and missing tests, and suggest concrete fixes.",
    scope: "builtin",
  },
  {
    name: "compact",
    description: "Summarise conversation so far",
    prompt:
      "Summarise this conversation so far: goals, decisions, and remaining work, compact enough to continue in a new context window.",
    scope: "builtin",
  },
  {
    name: "summary",
    description: "Short recap of this session",
    prompt: "Give a short recap of this session: what changed, what was decided, and what is left to do.",
    scope: "builtin",
  },
];

export function createCommandService(opts: CommandServiceOptions = {}): CommandService {
  const homeOf = (): string => opts.home ?? process.env.HOME ?? "";

  return {
    async list(root) {
      const home = homeOf();
      const userCmds = await loadCommands(path.join(home, ".config", "polyth", "commands"), "user");
      const projCmds = await loadCommands(path.join(root, ".polyth", "commands"), "project");
      const byName = new Map<string, SlashCommand>();
      for (const c of BUILTINS) byName.set(c.name, c);
      for (const c of userCmds) byName.set(c.name, c);
      for (const c of projCmds) byName.set(c.name, c);

      const userSnips = await loadSnippets(path.join(home, ".config", "polyth", "snippets"), "user");
      const projSnips = await loadSnippets(path.join(root, ".polyth", "snippets"), "project");
      const snipBy = new Map<string, Snippet>();
      for (const s of userSnips) snipBy.set(s.alias, s);
      for (const s of projSnips) snipBy.set(s.alias, s);

      const commands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
      const snippets = [...snipBy.values()].sort((a, b) => a.alias.localeCompare(b.alias));
      return { commands, snippets };
    },

    async expand(root, text, _ctx = {}) {
      const raw = text;
      const { commands, snippets } = await this.list(root);
      const cmdBy = new Map(commands.map((c) => [c.name, c]));
      const snipBy = new Map(snippets.map((s) => [s.alias, s]));

      let usedCommand: string | undefined;
      let agent: string | undefined;
      let model: string | undefined;
      let out = text;

      const firstNl = out.indexOf("\n");
      const firstLine = firstNl === -1 ? out : out.slice(0, firstNl);
      const restLines = firstNl === -1 ? "" : out.slice(firstNl + 1);
      const cmdMatch = firstLine.match(/^\/([A-Za-z0-9_-]+)(?:[ \t]+(.*))?$/);
      if (cmdMatch) {
        const name = cmdMatch[1]!;
        const cmd = cmdBy.get(name);
        if (cmd) {
          const args = [cmdMatch[2] ?? "", restLines].filter((s) => s.length > 0).join("\n");
          usedCommand = name;
          agent = cmd.agent;
          model = cmd.model;
          if (cmd.prompt.includes("$ARGUMENTS")) {
            out = cmd.prompt.replaceAll("$ARGUMENTS", args);
          } else if (args) {
            out = `${cmd.prompt.trimEnd()}\n\n${args}`;
          } else {
            out = cmd.prompt;
          }
        }
      }

      out = await expandAtFiles(root, out);
      out = await expandShell(root, out);
      out = expandSnippets(out, snipBy);

      const result: ExpandResult = { text: out, raw };
      if (usedCommand) result.usedCommand = usedCommand;
      if (agent) result.agent = agent;
      if (model) result.model = model;
      return result;
    },
  };
}

async function loadCommands(dir: string, scope: CommandScope): Promise<SlashCommand[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const out: SlashCommand[] = [];
  for (const file of names) {
    let raw = "";
    try {
      raw = await readFile(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    const name = file.slice(0, -3);
    const cmd: SlashCommand = {
      name,
      description: parsed.description ?? "",
      prompt: parsed.body,
      scope,
    };
    if (parsed.agent) cmd.agent = parsed.agent;
    if (parsed.model) cmd.model = parsed.model;
    out.push(cmd);
  }
  return out;
}

async function loadSnippets(dir: string, scope: CommandScope): Promise<Snippet[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Snippet[] = [];
  for (const file of names) {
    let text = "";
    try {
      text = await readFile(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    out.push({ alias: file.replace(/\.[^.]+$/, ""), text, scope });
  }
  return out;
}

export function parseFrontmatter(raw: string): {
  description?: string;
  agent?: string;
  model?: string;
  body: string;
} {
  const src = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n") && src !== "---") return { body: src };
  const close = src.indexOf("\n---", 3);
  if (close === -1) return { body: src };
  const fm = src.slice(4, close);
  let body = src.slice(close + 4);
  if (body.startsWith("\n")) body = body.slice(1);
  const meta: { description?: string; agent?: string; model?: string } = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^(description|agent|model)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1]!.toLowerCase() as "description" | "agent" | "model";
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { ...meta, body };
}

async function expandAtFiles(root: string, text: string): Promise<string> {
  const re = /@([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+|[A-Za-z0-9_./\\-]+\/[A-Za-z0-9_./\\-]+)/g;
  const matches = [...text.matchAll(re)];
  if (!matches.length) return text;
  let out = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    const rel = m[1]!.replace(/\\/g, "/");
    const start = m.index ?? 0;
    try {
      const content = await readInside(root, rel, FILE_INCLUDE_MAX);
      const block = "```" + rel + "\n" + content + (content.endsWith("\n") ? "" : "\n") + "```";
      out = out.slice(0, start) + block + out.slice(start + m[0].length);
    } catch {
      // missing or escaped: leave as-is
    }
  }
  return out;
}

async function readInside(root: string, rel: string, max: number): Promise<string> {
  if (!rel || path.isAbsolute(rel) || rel.split("/").includes("..")) throw new Error("escape");
  const rootAbs = path.resolve(root);
  const rootReal = await realpath(rootAbs);
  const joined = path.resolve(rootAbs, rel);
  if (path.relative(rootAbs, joined).startsWith("..") || path.isAbsolute(path.relative(rootAbs, joined))) {
    throw new Error("escape");
  }
  const real = await realpath(joined);
  if (path.relative(rootReal, real).startsWith("..") || path.isAbsolute(path.relative(rootReal, real))) {
    throw new Error("escape");
  }
  const buf = await readFile(real);
  const slice = buf.subarray(0, max);
  return slice.toString("utf8");
}

async function expandShell(root: string, text: string): Promise<string> {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const otherBang = lines.slice(1).some((l) => l.startsWith("!"));
  if (first.startsWith("!") && !otherBang) {
    const cmd = first.slice(1) + (lines.length > 1 ? "\n" + lines.slice(1).join("\n") : "");
    if (first === "!" && lines.length === 1) return text;
    return runShell(root, cmd);
  }
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("!") && line.length > 1) {
      out.push(await runShell(root, line.slice(1)));
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

async function runShell(root: string, command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: root,
      timeout: SHELL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return fence(`${stdout ?? ""}${stderr ?? ""}`);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return fence(`${e.stdout ?? ""}${e.stderr ?? e.message ?? String(err)}`);
  }
}

function fence(body: string): string {
  const t = body.endsWith("\n") || body.length === 0 ? body : body + "\n";
  return "```\n" + t + "```";
}

function expandSnippets(text: string, snipBy: Map<string, Snippet>): string {
  return text.replace(/(^|[^A-Za-z0-9_])#([A-Za-z0-9_-]+)\b/g, (all, pre: string, alias: string) => {
    const snip = snipBy.get(alias);
    if (!snip) return all;
    return pre + snip.text;
  });
}

// Slash commands + snippets, polyth-style discovery and expansion.
import { exec } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { roleAtLeast, type SpaceContext } from "@polyth/contracts";
import type { CommandList, CommandScope, SlashCommand, Snippet } from "./catalog.ts";

// The catalog rules and types are browser-safe and live apart from this
// filesystem/shell code; they stay part of this package's public surface.
export {
  commandPrecedence,
  mergeCommandCatalog,
  type CommandList,
  type CommandScope,
  type SlashCommand,
  type Snippet,
} from "./catalog.ts";

const execAsync = promisify(exec);
const FILE_INCLUDE_MAX = 64 * 1024;
const SHELL_TIMEOUT_MS = 10_000;

export type SkillScope = "project-opencode" | "user-opencode" | "project-claude" | "user-claude" | "project-agents" | "user-agents";

export interface AgentSkill {
  name: string;
  description: string;
  instructions: string;
  disallowedTools?: string[];
  scope: SkillScope;
}

export interface ExpandContext {
  cwd?: string;
  /** Trusted request scope for package-owned portable skill invocation. */
  space?: SpaceContext;
  projectId?: string;
  /** The person the turn acts for (server state, never request input). Personal
   * commands expand only for a known person; system work sees Space commands only. */
  actorUserId?: string;
}

/** Who is asking, for the personal layer and the Space-write check. */
export interface CommandCallContext {
  space?: SpaceContext;
  actorUserId?: string;
}

export interface ExpandResult {
  text: string;
  raw: string;
  usedCommand?: string;
  agent?: string;
  model?: string;
}

export type WriteScope = "user" | "project";

export interface CommandInput {
  name: string;
  prompt: string;
  description?: string;
  agent?: string;
  model?: string;
}

export interface CommandService {
  list(root: string, ctx?: CommandCallContext): Promise<CommandList>;
  expand(root: string, text: string, ctx?: ExpandContext): Promise<ExpandResult>;
  saveCommand(root: string, scope: WriteScope, cmd: CommandInput, ctx?: CommandCallContext): Promise<void>;
  removeCommand(root: string, scope: WriteScope, name: string, ctx?: CommandCallContext): Promise<boolean>;
  saveSnippet(root: string, scope: WriteScope, snippet: { alias: string; text: string }, ctx?: CommandCallContext): Promise<void>;
  removeSnippet(root: string, scope: WriteScope, alias: string, ctx?: CommandCallContext): Promise<boolean>;
  listSkills(root: string, options?: { includeUser?: boolean }): Promise<AgentSkill[]>;
  saveSkill(root: string, scope: SkillScope, skill: { name: string; description: string; instructions: string; disallowedTools?: string[] }): Promise<void>;
  removeSkill(root: string, scope: SkillScope, name: string): Promise<boolean>;
}

export interface CommandServiceOptions {
  /** Override user-scope home (default: $HOME). Tests inject a temp dir. */
  home?: string;
  /**
   * Person-owned storage root (Spaces §14.6). When set, the `user` scope means
   * "mine": commands and snippets live under `<root>/{commands,snippets}` and
   * only that person sees them. Return undefined when the host cannot provide
   * it; personal reads then come back empty and personal writes are refused.
   * Without this option `user` is the legacy home-config directory.
   */
  personalDir?: (userId: string) => string | undefined;
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

const identifyCommand = (command: SlashCommand): SlashCommand => ({
  ...command,
  id: `polyth:${command.scope}:${command.name}`,
  owner: command.scope,
});

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_SCOPES: SkillScope[] = [
  "project-opencode", "user-opencode", "project-claude", "user-claude", "project-agents", "user-agents",
];

const failure = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** A signed-in person, or undefined for system work. */
function personOf(ctx: CommandCallContext | undefined): { userId: string; instanceOwner: boolean; role?: SpaceContext["role"] } | undefined {
  const space = ctx?.space;
  const spaceAuthoritySystem = (space as { authority?: { kind?: unknown } } | undefined)?.authority?.kind === "system";
  const userId = ctx?.actorUserId ?? (spaceAuthoritySystem ? undefined : space?.userId);
  if (!userId || userId.startsWith("system:")) return undefined;
  const own = space && space.userId === userId;
  // Canonical contexts carry an explicit instance-owner decision; a context
  // without one is the pre-canonical single-user install, whose only person
  // owns the home directory.
  const marker = (space as { instanceOwner?: boolean } | undefined)?.instanceOwner;
  const instanceOwner = Boolean(own && (marker === true || (marker === undefined && space.role === "owner")));
  return { userId, instanceOwner, ...(own ? { role: space.role } : {}) };
}

export function createCommandService(opts: CommandServiceOptions = {}): CommandService {
  const homeOf = (): string => opts.home ?? process.env.HOME ?? "";
  const legacyDir = (kind: "commands" | "snippets"): string => path.join(homeOf(), ".config", "polyth", kind);
  const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

  // Home-config files predate person ownership and belong to the installation
  // owner (the OS account Polyth runs as). They are copied once into the
  // instance owner's personal layer, never overwriting a same-named personal
  // file and never removed from home; other people never see them.
  const adoptLegacyHome = async (personal: string): Promise<void> => {
    if (!homeOf()) return;
    const marker = path.join(personal, ".legacy-home-adopted");
    if (await exists(marker)) return;
    for (const kind of ["commands", "snippets"] as const) {
      let names: string[];
      try {
        names = (await readdir(legacyDir(kind))).filter((name) => name.endsWith(".md"));
      } catch {
        continue;
      }
      for (const name of names) {
        const target = path.join(personal, kind, name);
        if (await exists(target)) continue;
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(legacyDir(kind), name), target);
      }
    }
    await mkdir(personal, { recursive: true });
    await writeFile(marker, "");
  };

  /** Where the `user` scope lives for this caller; undefined = no personal layer. */
  const personalRoot = async (ctx: CommandCallContext | undefined): Promise<string | undefined> => {
    if (!opts.personalDir) return undefined;
    const person = personOf(ctx);
    if (!person) return undefined;
    const root = opts.personalDir(person.userId);
    if (root && person.instanceOwner) await adoptLegacyHome(root);
    return root;
  };

  const dirFor = async (
    root: string,
    scope: WriteScope,
    kind: "commands" | "snippets",
    ctx: CommandCallContext | undefined,
    write: boolean,
  ): Promise<string> => {
    if (scope === "project") {
      // Project files are shared with everyone who can open the project.
      if (write && ctx?.space && !roleAtLeast(ctx.space.role, "admin")) {
        throw failure("forbidden", "Only Space admins can change shared commands; save it as a personal command instead");
      }
      return path.join(root, ".polyth", kind);
    }
    if (!opts.personalDir) return legacyDir(kind);
    if (!personOf(ctx)) throw failure("forbidden", "Personal commands belong to a signed-in person; system work cannot use them");
    const personal = await personalRoot(ctx);
    if (!personal) throw failure("unavailable", "Personal commands need person-owned storage, which this host does not provide");
    return path.join(personal, kind);
  };
  const skillDirFor = (root: string, scope: SkillScope): string => {
    const user = scope.startsWith("user-");
    const family = scope.slice(scope.indexOf("-") + 1);
    const base = user ? homeOf() : root;
    if (family === "opencode") return user ? path.join(base, ".config", "opencode", "skills") : path.join(base, ".opencode", "skills");
    return path.join(base, `.${family}`, "skills");
  };
  const assertName = (name: string): void => {
    if (!NAME_RE.test(name)) {
      throw Object.assign(new Error("name must be letters, digits, - or _"), { code: "invalid-input" });
    }
  };

  return {
    async list(root, ctx) {
      // The caller's own layer (`user`) wins over Space-shared ones. Without a
      // signed-in person it is empty, never someone else's.
      const personal = opts.personalDir ? await personalRoot(ctx) : undefined;
      const userDir = (kind: "commands" | "snippets"): string | undefined =>
        opts.personalDir ? (personal ? path.join(personal, kind) : undefined) : legacyDir(kind);
      const userCmds = userDir("commands") ? await loadCommands(userDir("commands")!, "user") : [];
      const projCmds = await loadCommands(path.join(root, ".polyth", "commands"), "project");
      const byName = new Map<string, SlashCommand>();
      for (const c of BUILTINS) byName.set(c.name, c);
      for (const c of projCmds) byName.set(c.name, c);
      for (const c of userCmds) byName.set(c.name, c);

      const userSnips = userDir("snippets") ? await loadSnippets(userDir("snippets")!, "user") : [];
      const projSnips = await loadSnippets(path.join(root, ".polyth", "snippets"), "project");
      const snipBy = new Map<string, Snippet>();
      for (const s of projSnips) snipBy.set(s.alias, s);
      for (const s of userSnips) snipBy.set(s.alias, s);

      const commands = [...byName.values()]
        .map(identifyCommand)
        .sort((a, b) => a.name.localeCompare(b.name));
      const snippets = [...snipBy.values()].sort((a, b) => a.alias.localeCompare(b.alias));
      return { commands, snippets };
    },

    async expand(root, text, ctx = {}) {
      const raw = text;
      const { commands, snippets } = await this.list(root, ctx);
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

    async saveCommand(root, scope, cmd, ctx) {
      assertName(cmd.name);
      if (!cmd.prompt?.trim()) {
        throw Object.assign(new Error("prompt is required"), { code: "invalid-input" });
      }
      const dir = await dirFor(root, scope, "commands", ctx, true);
      await mkdir(dir, { recursive: true });
      const fm: string[] = [];
      if (cmd.description) fm.push(`description: ${cmd.description}`);
      if (cmd.agent) fm.push(`agent: ${cmd.agent}`);
      if (cmd.model) fm.push(`model: ${cmd.model}`);
      const head = fm.length > 0 ? `---\n${fm.join("\n")}\n---\n` : "";
      await writeFile(path.join(dir, `${cmd.name}.md`), `${head}${cmd.prompt}\n`);
    },

    async removeCommand(root, scope, name, ctx) {
      assertName(name);
      const dir = await dirFor(root, scope, "commands", ctx, true);
      try {
        await unlink(path.join(dir, `${name}.md`));
        return true;
      } catch {
        return false;
      }
    },

    async saveSnippet(root, scope, snippet, ctx) {
      assertName(snippet.alias);
      if (!snippet.text?.trim()) {
        throw Object.assign(new Error("text is required"), { code: "invalid-input" });
      }
      const dir = await dirFor(root, scope, "snippets", ctx, true);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${snippet.alias}.md`), snippet.text);
    },

    async removeSnippet(root, scope, alias, ctx) {
      assertName(alias);
      const dir = await dirFor(root, scope, "snippets", ctx, true);
      try {
        await unlink(path.join(dir, `${alias}.md`));
        return true;
      } catch {
        return false;
      }
    },

    async listSkills(root, options = {}) {
      const scopes = SKILL_SCOPES.filter((scope) => options.includeUser !== false || !scope.startsWith("user-"));
      const skills = await Promise.all(scopes.map(async (scope) =>
        loadSkills(skillDirFor(root, scope), scope, scope.startsWith("user-") ? homeOf() : root)));
      return skills.flat().sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
    },

    async saveSkill(root, scope, skill) {
      if (!SKILL_SCOPES.includes(scope)) throw Object.assign(new Error("unknown skill location"), { code: "invalid-input" });
      if (!SKILL_NAME_RE.test(skill.name)) {
        throw Object.assign(new Error("name must be lowercase letters, digits, and single hyphens"), { code: "invalid-input" });
      }
      if (!skill.description.trim() || skill.description.trim().length > 1024) {
        throw Object.assign(new Error("description is required and must be at most 1024 characters"), { code: "invalid-input" });
      }
      if (!skill.instructions.trim()) throw Object.assign(new Error("instructions are required"), { code: "invalid-input" });
      const dir = path.join(skillDirFor(root, scope), skill.name);
      await mkdir(dir, { recursive: true });
      const description = skill.description.trim().replaceAll("\n", " ").replaceAll('"', '\\"');
      const disallowedTools = [...new Set((skill.disallowedTools ?? []).map((name) => name.trim()).filter(Boolean))];
      if (
        disallowedTools.length > 128
        || disallowedTools.some((name) => name.length > 256 || /[\r\n\u0000]/.test(name))
      ) {
        throw Object.assign(new Error("disallowed tools must be unique non-empty names (max 128, 256 chars each)"), { code: "invalid-input" });
      }
      await writeFile(path.join(dir, "SKILL.md"), [
        "---",
        `name: ${skill.name}`,
        `description: "${description}"`,
        ...(disallowedTools.length ? [`disallowed-tools: ${JSON.stringify(disallowedTools)}`] : []),
        "---",
        "",
        skill.instructions.trim(),
        "",
      ].join("\n"));
    },

    async removeSkill(root, scope, name) {
      if (!SKILL_SCOPES.includes(scope) || !SKILL_NAME_RE.test(name)) {
        throw Object.assign(new Error("invalid skill location or name"), { code: "invalid-input" });
      }
      try {
        await rm(path.join(skillDirFor(root, scope), name), { recursive: true, force: false });
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return false;
        throw error;
      }
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

async function loadSkills(dir: string, scope: SkillScope, base: string): Promise<AgentSkill[]> {
  let entries: string[] = [];
  try {
    const rel = path.relative(await realpath(base), await realpath(dir));
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return [];
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && SKILL_NAME_RE.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const skills: AgentSkill[] = [];
  for (const name of entries) {
    try {
      const parsed = parseSkill(await readInside(base, path.relative(base, path.join(dir, name, "SKILL.md")), 1024 * 1024));
      if (parsed.name === name && parsed.description) skills.push({ ...parsed, scope });
    } catch {
      // A partial, malformed or escaped skill must not hide the rest of the catalog.
    }
  }
  return skills;
}

function parseSkill(raw: string): {
  name: string;
  description: string;
  instructions: string;
  disallowedTools?: string[];
} {
  const source = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!source.startsWith("---\n")) throw new Error("missing frontmatter");
  const close = source.indexOf("\n---", 3);
  if (close === -1) throw new Error("missing frontmatter end");
  const meta = source.slice(4, close);
  const field = (key: string): string => {
    const lines = meta.split("\n");
    const index = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
    if (index === -1) return "";
    const value = lines[index]!.replace(new RegExp(`^${key}\\s*:\\s*`), "").trim();
    if (value !== ">" && value !== "|") return value.replace(/^['"]|['"]$/g, "");
    const nested: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (!/^\s/.test(line)) break;
      nested.push(line.trim());
    }
    return value === ">" ? nested.join(" ") : nested.join("\n");
  };
  const listField = (key: string): string[] => {
    const lines = meta.split("\n");
    const index = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
    if (index === -1) return [];
    const rawValue = lines[index]!.replace(new RegExp(`^${key}\\s*:\\s*`), "").trim();
    const clean = (value: string): string => value.trim().replace(/^['"]|['"]$/g, "");
    if (rawValue) {
      if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
        try {
          const parsed = JSON.parse(rawValue) as unknown;
          if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
            return [...new Set(parsed.map(clean).filter(Boolean))];
          }
        } catch {
          return [...new Set(rawValue.slice(1, -1).split(",").map(clean).filter(Boolean))];
        }
      }
      return [clean(rawValue)].filter(Boolean);
    }
    const values: string[] = [];
    for (const line of lines.slice(index + 1)) {
      const match = line.match(/^\s+-\s*(.+)$/);
      if (!match) break;
      const value = clean(match[1]!);
      if (value) values.push(value);
    }
    return [...new Set(values)];
  };
  const name = field("name");
  const description = field("description");
  const disallowedTools = listField("disallowed-tools");
  if (!SKILL_NAME_RE.test(name) || !description || description.length > 1024) throw new Error("invalid frontmatter");
  return {
    name,
    description,
    instructions: source.slice(close + 4).replace(/^\n+/, "").trim(),
    ...(disallowedTools.length ? { disallowedTools } : {}),
  };
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

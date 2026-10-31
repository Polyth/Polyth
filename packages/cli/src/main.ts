// `polyth` — command-line interface for a Polyth server or Polyth Desktop.
import { parseArgs, UsageError, type FlagSpec, type Parsed } from "./args.ts";
import { exitCodeFor, PolythError } from "./client.ts";
import { createContext, type Command } from "./context.ts";
import { createOutput, style, type Output } from "./output.ts";
import { login, logout, target, whoami } from "./commands/auth.ts";
import { api, models, open, projects, server, status } from "./commands/admin.ts";
import { events, on, requests } from "./commands/automation.ts";
import { chat } from "./commands/chat.ts";
import { archive, fork, log, newSession, queue, remove, restore, send, sessions, show, stop, wait } from "./commands/sessions.ts";

export const VERSION = "0.1.0";

export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "json", description: "Machine-readable JSON output" },
  { name: "url", value: true, description: "Server URL (overrides the saved target; also POLYTH_URL)" },
  { name: "target", value: true, description: "Saved target name, or `desktop` (also POLYTH_TARGET)" },
  { name: "data-dir", value: true, description: "Local Polyth data directory (control socket; also POLYTH_DATA_DIR)" },
  { name: "space", value: true, description: "Space id for this command" },
  { name: "no-color", description: "Disable colors (also NO_COLOR)" },
  { name: "help", short: "h", description: "Show help" },
  { name: "version", short: "V", description: "Print the CLI version" },
];

const GROUPS: Array<[string, Command[]]> = [
  ["Sessions", [sessions, show, log, newSession, send, chat, stop, wait, queue, fork, archive, restore, remove]],
  ["Automation", [events, on, requests]],
  ["Polyth", [status, projects, models, open, api]],
  ["Connection", [login, logout, whoami, target]],
  ["This machine", [server]],
];

const completion: Command = {
  name: "completion",
  summary: "Print a shell completion script (bash, zsh or fish)",
  usage: "polyth completion bash|zsh|fish   # e.g. polyth completion bash >> ~/.bashrc",
  async run(ctx, args) {
    const shell = args.positionals[0] ?? "bash";
    ctx.o.out(completionScript(shell));
  },
};

const help: Command = {
  name: "help",
  summary: "Show help for a command",
  usage: "polyth help [COMMAND]",
  async run(ctx, args) {
    const name = args.positionals[0];
    if (!name) { ctx.o.out(overview(ctx.o)); return; }
    const command = find(name);
    if (!command) throw new UsageError(`unknown command "${name}"`);
    ctx.o.out(commandHelp(ctx.o, command));
  },
};

GROUPS[GROUPS.length - 1]![1].push(completion);

export const COMMANDS: Command[] = [...GROUPS.flatMap(([, list]) => list), help];

function find(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

function overview(o: Output): string {
  const lines = [
    `${style.bold(o.color, "polyth")} — control Polyth from the terminal (server or desktop)`,
    "",
    `${style.bold(o.color, "Usage")}  polyth <command> [options]`,
  ];
  for (const [group, list] of GROUPS) {
    lines.push("", style.bold(o.color, group));
    for (const c of list.filter((x) => !x.hidden)) lines.push(`  ${c.name.padEnd(12)} ${c.summary}`);
  }
  lines.push("", style.bold(o.color, "Global options"));
  for (const f of GLOBAL_FLAGS) lines.push(`  ${`--${f.name}${f.value ? " VALUE" : ""}`.padEnd(18)} ${f.description ?? ""}`);
  lines.push(
    "",
    style.bold(o.color, "Where it connects"),
    "  --url/--target/--data-dir, else the saved default (`polyth target use`), else a",
    "  Polyth on this machine: ./data, this server checkout, then Polyth Desktop.",
    "  Remote servers: `polyth login https://…` (or POLYTH_URL + POLYTH_TOKEN for automation).",
    "",
    "Exit status: 0 ok · 1 failed · 2 usage · 3 not allowed · 4 not found · 5 unreachable",
    "             6 conflict · 7 timeout · 8 turn stopped",
    "",
    "`polyth help <command>` for details.",
  );
  return lines.join("\n");
}

function commandHelp(o: Output, c: Command): string {
  const lines = [`${style.bold(o.color, c.name)} — ${c.summary}`, "", `${style.bold(o.color, "Usage")}  ${c.usage}`];
  if (c.aliases?.length) lines.push(`Aliases: ${c.aliases.join(", ")}`);
  if (c.details) lines.push("", c.details);
  if (c.flags?.length) {
    lines.push("", style.bold(o.color, "Options"));
    for (const f of c.flags) {
      const name = `${f.short ? `-${f.short}, ` : "    "}--${f.name}${f.value ? " VALUE" : ""}`;
      lines.push(`  ${name.padEnd(26)} ${f.description ?? ""}`);
    }
  }
  return lines.join("\n");
}

export function completionScript(shell: string): string {
  const names = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]).join(" ");
  const flagsOf = (c: Command) => [...(c.flags ?? []), ...GLOBAL_FLAGS].map((f) => `--${f.name}`).join(" ");
  if (shell === "bash") {
    const cases = COMMANDS.map((c) => `    ${[c.name, ...(c.aliases ?? [])].join("|")}) opts="${flagsOf(c)}" ;;`).join("\n");
    return `# polyth bash completion
_polyth() {
  local cur cmd opts
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${names}" -- "$cur") ); return
  fi
  case "$cmd" in
${cases}
    *) opts="" ;;
  esac
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -o default -F _polyth polyth`;
  }
  if (shell === "zsh") {
    return `#compdef polyth
# polyth zsh completion
_polyth() {
  local -a commands
  commands=(${COMMANDS.map((c) => `'${c.name}:${c.summary.replace(/'/g, "")}'`).join(" ")})
  if (( CURRENT == 2 )); then _describe 'command' commands; return; fi
  _files
}
compdef _polyth polyth`;
  }
  if (shell === "fish") {
    return [
      "# polyth fish completion",
      "complete -c polyth -f",
      ...COMMANDS.map((c) => `complete -c polyth -n '__fish_use_subcommand' -a '${c.name}' -d '${c.summary.replace(/'/g, "")}'`),
      ...COMMANDS.flatMap((c) => (c.flags ?? []).map((f) => `complete -c polyth -n '__fish_seen_subcommand_from ${c.name}' -l ${f.name}${f.short ? ` -s ${f.short}` : ""}${f.value ? " -r" : ""}`)),
    ].join("\n");
  }
  throw new UsageError("shell must be bash, zsh or fish");
}

/** Split global options (anywhere before `--`) from the command's own. */
function splitGlobals(argv: string[]): { globals: Parsed["flags"]; rest: string[] } {
  const globals: Parsed["flags"] = {};
  const rest: string[] = [];
  const byName = new Map(GLOBAL_FLAGS.map((f) => [f.name, f]));
  const byShort = new Map(GLOBAL_FLAGS.filter((f) => f.short).map((f) => [f.short!, f]));
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { rest.push(...argv.slice(i)); break; }
    const long = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    const spec = long ? byName.get(long[1]!) ?? (long[1] === "no-color" ? byName.get("no-color") : undefined)
      : /^-[a-zA-Z]$/.test(arg) ? byShort.get(arg[1]!) : undefined;
    if (!spec) { rest.push(arg); continue; }
    if (spec.value) {
      const value = long?.[2] ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${spec.name} needs a value`);
      globals[spec.name] = value;
    } else globals[spec.name] = true;
  }
  return { globals, rest };
}

/** `polyth sessions | head` closes stdout early: that is success, not a crash. */
function quietBrokenPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
      throw error;
    });
  }
}

export async function main(argv: string[]): Promise<number> {
  quietBrokenPipe();
  let o = createOutput();
  try {
    const { globals, rest } = splitGlobals(argv);
    o = createOutput({ json: globals.json === true, ...(globals["no-color"] === true ? { color: false } : {}) });
    if (globals.version === true) { o.out(VERSION); return 0; }
    const [name, ...commandArgs] = rest;
    if (!name || name === "--") { o.out(overview(o)); return name ? 2 : 0; }
    const command = find(name);
    if (!command) throw new UsageError(`unknown command "${name}" — see \`polyth help\``);
    const ctx = createContext(o, globals);
    if (globals.help === true) { o.out(commandHelp(o, command)); return 0; }
    const parsed = parseArgs(commandArgs, command.flags ?? []);
    const code = await command.run(ctx, parsed);
    return typeof code === "number" ? code : 0;
  } catch (error) {
    return report(o, error);
  }
}

function report(o: Output, error: unknown): number {
  const code = exitCodeFor(error);
  if ((error as { code?: string })?.code === "interrupted") return 130;
  if (o.json) {
    const e = error as PolythError & { code?: string };
    process.stderr.write(`${JSON.stringify({ error: e.code ?? "error", status: (e as PolythError).status ?? null, message: e.message })}\n`);
    return code;
  }
  if (error instanceof UsageError) o.err(`${style.red(o.color, "usage:")} ${error.message}`);
  else if (error instanceof PolythError) {
    o.err(`${style.red(o.color, "error:")} ${error.message}${error.status ? style.dim(o.color, ` (${error.code}, ${error.status})`) : ""}`);
    if (error.hint) o.err(style.dim(o.color, error.hint));
  } else {
    o.err(`${style.red(o.color, "error:")} ${(error as Error)?.message ?? String(error)}`);
    if (process.env.POLYTH_DEBUG) o.err(String((error as Error)?.stack ?? ""));
  }
  return code;
}

const invokedDirectly = (() => {
  try {
    const self = new URL(import.meta.url).pathname;
    return process.argv[1] !== undefined && (process.argv[1] === self || process.argv[1].endsWith("/packages/cli/src/main.ts"));
  } catch {
    return false;
  }
})();
if (invokedDirectly) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

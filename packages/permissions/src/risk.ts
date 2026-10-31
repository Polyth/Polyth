// Provider-neutral risk assessment for one permission request. The server uses
// it twice: to label the redacted preview, and to decide whether Auto-Approve
// may answer the request. A card therefore shows exactly why Auto-Approve left
// it for a person.
//
// This is a conservative tripwire for well-known destructive, privileged,
// secret-reading, uploading and publishing actions. It reads only what a
// harness put in the request, cannot see through scripts, aliases or package
// scripts, and is not a sandbox: an unflagged action is "routine", never
// "proven safe". It has no Node imports so any runtime may use it.

export type PermissionRisk = "low" | "medium" | "high";

/** Stable reason codes persisted in previews; clients localize them and skip
 * codes they do not know. Append only: never rename, reorder or remove one. */
export const PERMISSION_RISK_REASONS = [
  "destructive-delete",
  "discards-work",
  "history-rewrite",
  "privilege-escalation",
  "system-change",
  "remote-code",
  "secret-access",
  "data-upload",
  "remote-change",
  "outside-workspace",
  "database-destruction",
  "destructive-tool",
  "unreviewable",
  // Added after the first release; older clients ignore it, and every command
  // it marks also carries an older code where one applies.
  "infrastructure-destruction",
  // Not an assessment result: the Judgment second opinion (scopeCheck.ts)
  // adds it to a routine request's preview when it leaves that request for a
  // person. assessPermissionRisk never returns it.
  "outside-task",
] as const;
export type PermissionRiskReason = (typeof PERMISSION_RISK_REASONS)[number];

export interface PermissionRiskInput {
  permission: string;
  patterns: readonly string[];
  tool?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface PermissionRiskContext {
  /** Absolute roots the session may change: its execution directory and any
   * other repository of its workspace. Without one, every absolute path is
   * treated as outside the workspace. */
  workspaceRoots?: readonly string[];
}

export interface PermissionRiskAssessment {
  risk: PermissionRisk;
  /** Ordered as PERMISSION_RISK_REASONS; non-empty exactly when risk is high. */
  reasons: PermissionRiskReason[];
}

// Anything larger or deeper than these bounds is held as "unreviewable", so
// padding a request can never push a harmful tail past the checks.
const MAX_SCAN = 64 * 1024;
const MAX_PATTERNS = 32;
const MAX_DEPTH = 4;

const permissionKey = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

const SHELL_PERMISSIONS = new Set([
  "bash", "sh", "zsh", "shell", "command", "commandexecution", "execute", "executecommand",
  "exec", "runcommand", "runterminalcmd", "terminal", "powershell", "pwsh", "cmd",
]);
const FILE_CHANGE_PERMISSIONS = new Set([
  "edit", "write", "multiedit", "notebookedit", "patch", "applypatch", "filechange", "editfile",
  "writefile", "writetofile", "create", "createfile", "delete", "deletefile", "remove", "removefile",
  "move", "movefile", "rename", "renamefile", "mkdir", "touch", "sedfile", "replacefilecontent",
  "multireplacefilecontent",
]);
const READ_ONLY_PERMISSIONS = new Set([
  "read", "readfile", "view", "viewfile", "list", "listdir", "ls", "glob", "grep", "grepsearch",
  "search", "find", "findbyname",
]);
/** Metadata keys whose values are commands or paths, never free text. */
const COMMAND_KEYS = /^(command|cmd|commandline|command_line|script)$/i;
const PATH_KEYS = /^(path|paths|file|filepath|file_path|filename|target|targetfile|target_file|absolutepath|directory|dir|uri|url)$/i;

// ---- paths -------------------------------------------------------------------

type Place = "inside" | "temp" | "null-device" | "block-device" | "outside";
/** A working directory: a known absolute path, "unknown" after a `cd` that
 * cannot be resolved, or undefined when the session has no recorded root. */
type Cwd = string | "unknown" | undefined;

const TEMP_ROOTS = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/folders", "/var/folders", "/dev/shm"];
const NULL_DEVICES = /^\/dev\/(null|zero|stdout|stderr|stdin|tty|fd\/\d+|full|random|urandom)$/;
const BLOCK_DEVICES = /^\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk|rdisk|loop|md|dm-|mapper\/)/;
/** Prefix marking a path that is relative to an unrecorded root. */
const RELATIVE = "\0";

const isWindowsPath = (value: string): boolean => /^[a-zA-Z]:[\\/]/.test(value);

/** Lexical normalization; `..` above the root stays at the root. */
function normalizeAbsolute(value: string): string {
  const windows = isWindowsPath(value);
  const text = value.replace(/\\/g, "/");
  const parts: string[] = [];
  for (const part of (windows ? text.slice(2) : text).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(windows ? part.toLowerCase() : part);
  }
  return `${windows ? text.slice(0, 2).toLowerCase() : ""}/${parts.join("/")}`;
}

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

/** Whether a relative path ever rises above its starting directory. */
function climbsOut(value: string): boolean {
  let level = 0;
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (part === "..") level -= 1;
    else if (part && part !== ".") level += 1;
    if (level < 0) return true;
  }
  return false;
}

/** Absolute form of a path word, or undefined when it cannot be known (home,
 * variables, substitutions, or relative to an unknown directory). */
function absolutePath(word: string, cwd: Cwd): string | undefined {
  let value = word.trim();
  if (value.startsWith("file://")) value = value.slice(7);
  if (!value || /[$%`]/.test(value) || value.startsWith("~")) return undefined;
  if (value.startsWith("/") || isWindowsPath(value)) return normalizeAbsolute(value);
  if (cwd === "unknown") return undefined;
  if (cwd === undefined) return climbsOut(value) ? undefined : RELATIVE + normalizeAbsolute(`/${value}`);
  return normalizeAbsolute(`${cwd}/${value}`);
}

function placeOf(word: string, cwd: Cwd, roots: readonly string[]): Place {
  const path = absolutePath(word, cwd);
  if (path === undefined) return "outside";
  if (path.startsWith(RELATIVE)) return "inside";
  if (NULL_DEVICES.test(path)) return "null-device";
  if (BLOCK_DEVICES.test(path)) return "block-device";
  if (roots.some((root) => within(path, root))) return "inside";
  if (TEMP_ROOTS.some((root) => within(path, root))) return "temp";
  return "outside";
}

/** The workspace root itself, everything directly in it, or its Git data. */
function wipesWorkspace(word: string, cwd: Cwd, roots: readonly string[]): boolean {
  if (/(^|[\\/])\.git([\\/]|$)/.test(word)) return true;
  const path = absolutePath(word, cwd);
  if (path === undefined) return true;
  const atTop = (candidate: string, root: string): boolean => {
    const prefix = root === "/" ? "" : root;
    return candidate === root || candidate === `${prefix}/*` || candidate === `${prefix}/.*`;
  };
  // Without a recorded root, a relative path is measured from where it began.
  if (path.startsWith(RELATIVE)) return atTop(path.slice(RELATIVE.length), "/");
  return roots.some((root) => atTop(path, root));
}

const SECRET_PATH = [
  /(^|[\\/])\.env(\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?$/i,
  /(^|[\\/])\.envrc$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.aws[\\/](credentials|config)$/i,
  /(^|[\\/])\.config[\\/](gcloud|gh)([\\/]|$)/i,
  /(^|[\\/])\.azure([\\/]|$)/i,
  /(^|[\\/])\.kube[\\/]config$/i,
  /(^|[\\/])\.docker[\\/]config\.json$/i,
  /(^|[\\/])(\.netrc|_netrc|\.git-credentials|\.npmrc|\.pypirc|\.pgpass|\.my\.cnf|\.vault-token|\.terraformrc|credentials\.tfrc\.json)$/i,
  /\.tfstate(\.backup)?$/i,
  /\.(pem|p12|pfx|jks|keystore|ppk)$/i,
  /(^|[\\/])[\w.-]*private[\w.-]*\.key$/i,
  /(^|[\\/])(secrets?|credentials?)\.(json|ya?ml|toml|env|txt|ini|csv)$/i,
  /^\/etc\/(shadow|gshadow|sudoers)(\.d)?([\\/]|$)/,
  /^\/etc\/ssl\/private([\\/]|$)/,
  /\/proc\/[^/\s]+\/environ$/,
];

const isSecretPath = (word: string): boolean => {
  const value = word.trim().replace(/^file:\/\//, "").replace(/[\\/]+$/, "");
  return value.length > 0 && SECRET_PATH.some((pattern) => pattern.test(value));
};

/** Environment variables whose names say they hold a credential. */
const SECRET_VARIABLE = /\$\{?[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|ACCESS_?KEY)[A-Z0-9_]*\}?/i;

// ---- shell parsing -----------------------------------------------------------

interface Segment {
  words: string[];
  /** The previous segment's output feeds this one. */
  piped: boolean;
}

/** Text of every `$(…)` / backtick substitution inside a string. */
function substitutions(text: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close < 0) break;
      found.push(text.slice(index + 1, close));
      index = close;
    } else if (text[index] === "$" && text[index + 1] === "(") {
      let depth = 0;
      let end = index + 1;
      for (; end < text.length; end++) {
        if (text[end] === "(") depth += 1;
        else if (text[end] === ")" && --depth === 0) break;
      }
      found.push(text.slice(index + 2, end));
      index = end;
    }
  }
  return found;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "pwsh", "powershell", "cmd", "cmd.exe"]);

const base = (word: string): string => {
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  return (slash >= 0 ? word.slice(slash + 1) : word).toLowerCase();
};

/** The script of `sh -c '…'`, `eval …`, `su -c '…'` or `ssh host …`. */
function wrappedScript(words: readonly string[]): string | undefined {
  for (let index = 0; index < words.length - 1; index++) {
    const name = base(words[index]!);
    const flag = words[index + 1]!;
    if (SHELLS.has(name) && /^(-[a-z]*c[a-z]*|-command|\/c)$/i.test(flag) && words[index + 2] !== undefined) {
      return words[index + 2];
    }
    if (name === "eval" && index === 0) return words.slice(1).join(" ");
    if (name === "su" && flag === "-c" && words[index + 2] !== undefined) return words[index + 2];
  }
  if (base(words[0] ?? "") === "ssh") {
    let index = 1;
    while (index < words.length && words[index]!.startsWith("-")) {
      index += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(words[index]!) ? 2 : 1;
    }
    const command = words.slice(index + 1);
    if (command.length) return command.join(" ");
  }
  return undefined;
}

/** Splits shell text into simple commands. Quotes group words, redirections
 * become `>`/`>>`/`<` words, and `$(…)`, backticks and process substitutions
 * start commands of their own; so do the scripts of `sh -c` and friends. An
 * approximation for risk detection, not a shell parser. It sets
 * `hidden.found` when nesting exceeds MAX_DEPTH or a substitution supplies the
 * command name itself, rather than skipping what it cannot see. */
function parseShell(text: string, hidden: { found: boolean }, depth = 0): Segment[] {
  const segments: Segment[] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let word = "";
  let quoted = false;
  let piped = false;
  let inBacktick = false;
  /** Nothing but assignments and wrappers precede this point of the command. */
  const commandPosition = () => !word && !quoted && words.every((candidate) =>
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate) || PRIVILEGE_WRAPPERS.has(base(candidate))
    || base(candidate) === "env" || base(candidate) in RUNNERS);
  const endWord = () => {
    if (word || quoted) words.push(word);
    word = "";
    quoted = false;
  };
  const endSegment = (nextPiped: boolean) => {
    endWord();
    if (words.length) segments.push({ words, piped });
    words = [];
    piped = nextPiped;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close < 0 ? text.length : close;
      word += text.slice(index + 1, end);
      quoted = true;
      index = end;
    } else if (char === "\"") {
      let end = index + 1;
      let body = "";
      for (; end < text.length && text[end] !== "\""; end++) {
        if (text[end] === "\\" && end + 1 < text.length) body += text[++end];
        else body += text[end];
      }
      // Double quotes still run their command substitutions.
      if (commandPosition() && /^\s*(\$\(|`)/.test(body)) hidden.found = true;
      nested.push(...substitutions(body));
      word += body;
      quoted = true;
      index = end;
    } else if (char === "\\" && next !== undefined && /[\s"'`$\\;&|()<>*?#~{}!]/.test(next)) {
      // Only shell metacharacters are escaped; `C:\Users` keeps its separators.
      word += next;
      index += 1;
    } else if (char === "$" && next === "{") {
      const close = text.indexOf("}", index);
      const end = close < 0 ? text.length - 1 : close;
      word += text.slice(index, end + 1);
      index = end;
    } else if ((char === "$" || char === "<" || char === ">") && next === "(") {
      if (char === "$" && commandPosition()) hidden.found = true;
      endSegment(false);
      index += 1;
    } else if (char === "`") {
      if (!inBacktick && commandPosition()) hidden.found = true;
      inBacktick = !inBacktick;
      endSegment(false);
    } else if (char === "|") {
      const or = next === "|";
      if (or || next === "&") index += 1;
      endSegment(!or);
    } else if (char === "&" && next === ">") {
      endWord();
      index += text[index + 2] === ">" ? 2 : 1;
      words.push(">");
    } else if (char === "&") {
      if (next === "&") index += 1;
      endSegment(false);
    } else if (char === ";" || char === "\n" || char === "\r" || char === "(" || char === ")") {
      endSegment(false);
    } else if (char === ">" || char === "<") {
      // A file-descriptor number belongs to the operator, not the command.
      if (/^\d+$/.test(word) && !quoted) word = "";
      else endWord();
      let operator = char;
      if (next === char) { operator += char; index += 1; }
      if (text[index + 1] === "|") index += 1;
      if (text[index + 1] === "&") {
        // `>&2` duplicates a descriptor; there is no file target.
        index += 1;
        while (/[\d-]/.test(text[index + 1] ?? "")) index += 1;
        continue;
      }
      words.push(operator);
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word += char;
    }
  }
  endSegment(false);
  const scripts = [...nested];
  for (const segment of [...segments]) {
    const script = wrappedScript(segment.words);
    if (script !== undefined) scripts.push(script);
  }
  if (scripts.length && depth >= MAX_DEPTH) hidden.found = true;
  else for (const script of scripts) segments.push(...parseShell(script, hidden, depth + 1));
  return segments;
}

const PRIVILEGE_WRAPPERS = new Set(["sudo", "doas", "pkexec", "gsudo", "runas"]);
/** Prefix commands that run the remaining words, how many plain arguments
 * (e.g. `timeout 10`) they take before the command, and which of their
 * options consume a value. */
const RUNNERS: Record<string, [number, RegExp?]> = {
  nohup: [0], time: [0], exec: [0], command: [0], builtin: [0], caffeinate: [0], unbuffer: [0], bunx: [0], pnpx: [0],
  stdbuf: [0, /^-[ioe]$/],
  nice: [0, /^(-n|--adjustment)$/],
  ionice: [0, /^-[cnpPu]$/],
  xargs: [0, /^(-[aEdILnPs]|--(arg-file|delimiter|eof|replace|max-lines|max-args|max-procs|max-chars|process-slot-var))$/],
  watch: [0, /^(-n|--interval)$/],
  strace: [0, /^-[oepsSuEP]$/],
  npx: [0, /^(-p|--package)$/],
  timeout: [1, /^(-[sk]|--(signal|kill-after))$/],
  chroot: [1],
  chrt: [1],
  taskset: [1],
};

interface Command {
  name: string;
  args: string[];
  privileged: boolean;
  /** Arguments arrive on the piped input (`xargs`) as well as in the words. */
  fromInput: boolean;
  /** Whether the segment this command came from reads a pipe. */
  piped?: boolean;
}

const segmentPiped = (command: Command): boolean => command.piped === true;

function commandOf(words: readonly string[]): Command | undefined {
  let index = 0;
  let privileged = false;
  let fromInput = false;
  while (index < words.length) {
    const word = words[index]!;
    const name = base(word);
    if (["{", "}", "!", "then", "do", "else", "elif", "if", "while", "until"].includes(word)
      || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
      continue;
    }
    if (PRIVILEGE_WRAPPERS.has(name)) {
      privileged = true;
      index += 1;
      while (index < words.length && words[index]!.startsWith("-")) {
        index += /^-[ugCDhpRrT]$/.test(words[index]!) ? 2 : 1;
      }
      continue;
    }
    if (name === "env") {
      index += 1;
      while (index < words.length && (words[index]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!))) {
        index += /^-[uCS]$/.test(words[index]!) ? 2 : 1;
      }
      if (index >= words.length) return { name: "env", args: [], privileged, fromInput };
      continue;
    }
    const runner = RUNNERS[name];
    if (runner) {
      const [plain, valued] = runner;
      if (name === "xargs") fromInput = true;
      index += 1;
      while (index < words.length && words[index]!.startsWith("-")) {
        index += valued?.test(words[index]!) ? 2 : 1;
      }
      index += plain;
      continue;
    }
    return { name, args: words.slice(index + 1), privileged, fromInput };
  }
  return privileged ? { name: "", args: [], privileged, fromInput } : undefined;
}

const flagsOf = (args: readonly string[]): string[] => {
  const out: string[] = [];
  for (const arg of args) {
    if (arg === "--") break;
    if (arg.startsWith("-") && arg.length > 1) out.push(arg);
  }
  return out;
};

/** Positional words, without options, redirection operators or their targets. */
const positionals = (args: readonly string[]): string[] => {
  const out: string[] = [];
  let ended = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === ">" || arg === ">>" || arg === "<" || arg === "<<" || arg === "<<<") { index += 1; continue; }
    if (!ended && arg === "--") { ended = true; continue; }
    if (!ended && arg.startsWith("-") && arg.length > 1) continue;
    out.push(arg);
  }
  return out;
};

/** Any short flag letter (case-sensitive, combined forms too) or long flag. */
const hasFlag = (args: readonly string[], short: string, long: readonly string[] = []): boolean =>
  flagsOf(args).some((flag) => flag.startsWith("--")
    ? long.includes(flag.toLowerCase().split("=")[0]!)
    : [...short].some((letter) => flag.slice(1).includes(letter)));

const leading = (args: readonly string[], count = 3): string[] =>
  positionals(args).slice(0, count).map((word) => word.toLowerCase());

// ---- shell rules -------------------------------------------------------------

/** Remote publishing, deployment and infrastructure verbs per CLI. */
const REMOTE_VERBS: Record<string, RegExp> = {
  npm: /^(publish|unpublish|deprecate)$/,
  pnpm: /^(publish|unpublish|deprecate)$/,
  bun: /^publish$/,
  yarn: /^(publish|unpublish)$/,
  cargo: /^(publish|yank|owner)$/,
  gem: /^(push|yank|owner)$/,
  twine: /^upload$/,
  poetry: /^publish$/,
  uv: /^publish$/,
  flit: /^publish$/,
  hatch: /^publish$/,
  pdm: /^publish$/,
  dotnet: /^(push|delete)$/,
  nuget: /^(push|delete)$/,
  mvn: /^(deploy|release:perform)$/,
  mvnw: /^(deploy|release:perform)$/,
  gradle: /^publish(?!tomavenlocal)/,
  gradlew: /^publish(?!tomavenlocal)/,
  docker: /^push$/,
  podman: /^push$/,
  buildah: /^push$/,
  nerdctl: /^push$/,
  helm: /^(install|upgrade|uninstall|delete|rollback|push)$/,
  kubectl: /^(delete|apply|replace|patch|scale|drain|cordon|uncordon|rollout|create|edit|set|taint)$/,
  oc: /^(delete|apply|replace|patch|scale|rollout|create|edit|set)$/,
  terraform: /^(apply|destroy|import|taint|untaint|force-unlock)$/,
  tofu: /^(apply|destroy|import|taint|untaint|force-unlock)$/,
  terragrunt: /^(apply|destroy|run-all)$/,
  pulumi: /^(up|update|destroy|import|cancel)$/,
  cdk: /^(deploy|destroy)$/,
  serverless: /^(deploy|remove)$/,
  sls: /^(deploy|remove)$/,
  sam: /^(deploy|delete)$/,
  wrangler: /^(deploy|publish|delete|rollback)$/,
  firebase: /^(deploy|[\w-]+:delete|hosting:disable)$/,
  fly: /^(deploy|destroy|scale)$/,
  flyctl: /^(deploy|destroy|scale)$/,
  heroku: /^(apps:destroy|destroy|releases:rollback|rollback|pg:reset|pg:push|config:set|config:unset|ps:scale|maintenance:on)$/,
  vercel: /^(deploy|rm|remove|promote|rollback|alias)$/,
  netlify: /^sites:delete$/,
  gcloud: /^(delete|deploy|create|update|add-iam-policy-binding|remove-iam-policy-binding|reset|stop|resize|patch|import)$/,
  az: /^(delete|create|update|deploy|stop|restart|purge|remove|reset|import)$/,
  doctl: /^(delete|create|update|deploy)$/,
  gsutil: /^(rm|rb)$/,
  rclone: /^(delete|purge|deletefile|rmdir|rmdirs)$/,
};
const AWS_MUTATION = /^(delete|terminate|remove|deregister|revoke|detach|disable|stop|reboot|put|update|create|deploy|modify|attach|associate|disassociate|reset|restore|replace|invoke|publish|send|run)[a-z0-9-]*$/;

/** Commands that destroy whole resources (stacks, clusters objects, VMs,
 * container volumes, storage pools) rather than files: [verb pattern, extra
 * reason]. Matched against the leading words. */
const DESTROY_VERBS: Record<string, [RegExp, PermissionRiskReason?]> = {
  terraform: [/^destroy$/], tofu: [/^destroy$/], terragrunt: [/^destroy$/],
  pulumi: [/^destroy$/], cdk: [/^destroy$/], serverless: [/^remove$/], sls: [/^remove$/], sam: [/^delete$/],
  fly: [/^destroy$/], flyctl: [/^destroy$/], heroku: [/^(apps:destroy|destroy)$/],
  kubectl: [/^delete$/], oc: [/^delete$/], helm: [/^(uninstall|delete)$/],
  gcloud: [/^delete$/], az: [/^(delete|purge)$/], doctl: [/^delete$/],
  vagrant: [/^destroy$/, "system-change"],
  virsh: [/^(destroy|undefine|vol-delete|pool-delete|pool-destroy)$/, "system-change"],
  multipass: [/^(delete|purge)$/, "system-change"],
  lxc: [/^delete$/, "system-change"], incus: [/^delete$/, "system-change"],
  zfs: [/^destroy$/, "destructive-delete"], zpool: [/^destroy$/, "destructive-delete"],
  lvremove: [/^/, "destructive-delete"], vgremove: [/^/, "destructive-delete"], pvremove: [/^/, "destructive-delete"],
};

interface InfrastructureDestruction {
  /** The command and its leading words, e.g. `kubectl delete ns prod`. */
  words: string[];
  /** Nothing narrows it: `terraform destroy` without `-target`, `--all`. */
  unbounded: boolean;
  extra?: PermissionRiskReason;
}

/** What a command destroys beyond the workspace, if anything. */
function infrastructureDestruction(name: string, args: readonly string[]): InfrastructureDestruction | undefined {
  const lower = args.map((arg) => arg.toLowerCase());
  const words = leading(args, 4);
  const all = lower.some((arg) => /^(--all|-a|--all-namespaces|--purge)$/.test(arg)) && !lower.includes("--dry-run");
  const result = (extra?: PermissionRiskReason, unbounded = all): InfrastructureDestruction =>
    ({ words: [name, ...words], unbounded, ...(extra ? { extra } : {}) });
  if (name === "terraform" || name === "tofu" || name === "terragrunt") {
    const destroy = words.includes("destroy") || (words[0] === "apply" && lower.includes("-destroy"));
    return destroy ? result(undefined, !lower.some((arg) => /^-+target(=|$)/.test(arg))) : undefined;
  }
  if (name === "pulumi" && words[0] === "destroy") return result(undefined, !lower.some((arg) => /^--target(=|$)/.test(arg)));
  if (name === "aws") {
    const [service, operation] = words;
    if (service === "s3" ? operation === "rb" || (operation === "rm" && lower.includes("--recursive"))
      : /^(delete|terminate|deregister)[a-z0-9-]*$/.test(operation ?? "")) return result();
    return undefined;
  }
  if (name === "docker" || name === "podman" || name === "nerdctl" || name === "docker-compose") {
    const [group, verb] = name === "docker-compose" ? ["compose", words[0]] : words;
    if (group === "volume" && (verb === "rm" || verb === "prune")) return result("destructive-delete", verb === "prune");
    // `docker compose -f stack.yml down -v`: an option value may come first.
    if (group === "compose" && (name === "docker-compose" ? words : words.slice(1)).includes("down")
      && hasFlag(args, "v", ["--volumes"])) return result("destructive-delete");
    if (group === "system" && verb === "reset") return result("destructive-delete", true);
    if (group === "system" && verb === "prune" && lower.includes("--volumes")) return result("destructive-delete", true);
    return undefined;
  }
  if (name === "btrfs" && words[0] === "subvolume" && words[1] === "delete") return result("destructive-delete");
  const rule = DESTROY_VERBS[name];
  if (!rule) return undefined;
  const [verbs, extra] = rule;
  // `gcloud compute instances delete`: the verb follows a resource path.
  const verbAt = name === "gcloud" || name === "az" || name === "doctl" ? words.findIndex((word) => verbs.test(word)) : 0;
  if (verbAt < 0 || !verbs.test(words[verbAt] ?? "")) return undefined;
  return result(extra);
}

/** Commands that write to their path arguments, and which arguments. */
const WRITERS: Record<string, "all" | "last" | "all-but-first"> = {
  tee: "all", touch: "all", mkdir: "all", truncate: "all", rmdir: "all", mv: "all",
  cp: "last", install: "last", ln: "last",
  chmod: "all-but-first", chown: "all-but-first", chgrp: "all-but-first", setfacl: "all-but-first", chattr: "all-but-first",
};

const DELETERS = new Set(["rm", "unlink", "del", "erase", "rd", "remove-item", "ri"]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "iwr", "irm", "invoke-webrequest", "invoke-restmethod"]);
const INTERPRETERS = new Set([...SHELLS, "python", "python3", "perl", "ruby", "node", "php", "iex", "invoke-expression", "source", "."]);
const SYSTEM_COMMANDS = new Set([
  "shutdown", "reboot", "halt", "poweroff", "fdisk", "sfdisk", "gdisk", "cfdisk", "parted", "wipefs",
  "mkswap", "swapoff", "cryptsetup", "losetup", "diskpart", "killall", "pkill", "iptables", "ip6tables", "nft",
  "ufw", "firewall-cmd", "setenforce", "csrutil", "spctl", "pfctl", "useradd", "userdel", "usermod", "adduser",
  "deluser", "groupadd", "groupdel", "passwd", "chpasswd", "modprobe", "insmod", "rmmod",
  "mount", "umount", "hostnamectl", "update-grub", "grub-install", "efibootmgr", "setcap",
]);
/** Commands that print stored credentials: [command, leading words]. */
const SECRET_COMMANDS: Array<[string, RegExp]> = [
  ["gh",/^auth token(\s|$)/],
  ["gcloud", /^auth print-(access|identity)-token(\s|$)/],
  ["az", /^account get-access-token(\s|$)/],
  ["aws", /^(configure (export-credentials|get)|sts get-session-token|secretsmanager get-secret-value|ssm get-parameters?)(\s|$)/],
  ["git", /^credential (fill|get)(\s|$)/],
  ["security", /^(find-generic-password|find-internet-password|dump-keychain)(\s|$)/],
  ["secret-tool", /^lookup(\s|$)/],
  ["op", /^(read|item get)(\s|$)/],
  ["bw", /^get(\s|$)/],
  ["pass", /^show(\s|$)/],
  ["vault", /^(read|kv get)(\s|$)/],
];
/** Database clients and migration tools whose text may hold destructive SQL. */
const DATABASE_TOOLS = new Set([
  "psql", "pg_restore", "mysql", "mariadb", "sqlite3", "sqlcmd", "sqlplus", "mongo", "mongosh", "redis-cli",
  "valkey-cli", "clickhouse", "clickhouse-client", "cqlsh", "duckdb", "cockroach", "influx", "snowsql", "bq",
  "usql", "pgcli", "mycli", "litecli", "supabase", "turso", "dropdb", "rails", "rake", "prisma", "manage.py",
  "sqlx", "diesel", "knex", "sequelize", "typeorm", "drizzle-kit", "flyway", "liquibase", "dbmate", "goose",
]);
const DATABASE_RULES = [
  /\bdrop\s+(?:table|database|schema|collection|index|view|user|role)\b/i,
  /\btruncate\s+(?:table\s+)?["'`]?[a-z_][\w."`]*\s*(?:;|$|["'`]|cascade)/im,
  /\bdelete\s+from\s+["'`]?[a-z_][\w."`]*["'`]?\s*(?:;|$|["'])/im,
  // A WHERE clause that matches every row is no filter at all.
  /\bdelete\s+from\s+["'`]?[a-z_][\w."`]*["'`]?\s+where\s+(?:1\s*=\s*1|true|1)\s*(?:;|$|["'])/im,
  // UPDATE … SET with no WHERE before the statement ends rewrites every row.
  /\bupdate\s+["'`]?[a-z_][\w."`]*["'`]?\s+set\b(?![^;]*\bwhere\b)[^;]*(?:;|$)/im,
  /\balter\s+table\b[^;]*\bdrop\s+(?:column|constraint|partition)\b/i,
  /\bflush(?:all|db)\b/i,
  /\.dropdatabase\s*\(/i,
  /(?:\bdb\.[\w$.]*)?\.(?:deletemany|remove)\s*\(\s*\{\s*\}\s*\)/i,
  /\bdb\.[\w$]+(?:\.[\w$]+)?\.drop\s*\(\s*\)/i,
  /(?:^|[\s;&|(])dropdb\b/i,
  /\bdb:(?:drop|reset|purge|schema:load|structure:load|truncate_all)\b/i,
  /\bprisma\s+(?:migrate\s+reset|db\s+push\b[^;&|]*--(?:force-reset|accept-data-loss))/i,
  /\bmanage\.py\s+flush\b/i,
  /\bflyway\b[^;&|]*\bclean\b/i,
  /\bliquibase\b[^;&|]*\bdrop-?all\b/i,
  /\b(?:sqlx|diesel)\s+database\s+(?:drop|reset)\b/i,
  /\bdbmate\b[^;&|]*\bdrop\b/i,
  /\bgoose\b[^;&|]*\breset\b/i,
];
const ALWAYS_RULES: Array<[RegExp, PermissionRiskReason]> = [
  [/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "system-change"],
  [/\/dev\/(tcp|udp)\//i, "remote-code"],
  [/(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh|source|\.)\s+<\(\s*(?:curl|wget)\b/i, "remote-code"],
  [/(?:sh|bash|zsh|python3?|perl|ruby|node)\s+-[a-z]*c\s+["']?\$\(\s*(?:curl|wget)\b/i, "remote-code"],
  [/\b(?:iex|invoke-expression)\b[\s\S]*\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile)\b/i, "remote-code"],
  [/\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring)\b[\s\S]*\|\s*(?:iex|invoke-expression)\b/i, "remote-code"],
];

interface ShellState {
  roots: readonly string[];
  cwd: Cwd;
  reasons: Set<PermissionRiskReason>;
}

function writeTarget(word: string, state: ShellState): void {
  const place = placeOf(word, state.cwd, state.roots);
  if (place === "block-device") state.reasons.add("system-change");
  else if (place === "outside") state.reasons.add("outside-workspace");
  if (/(^|[\\/])\.git[\\/](hooks|config)([\\/]|$)/.test(word)) state.reasons.add("system-change");
  if (isSecretPath(word)) state.reasons.add("secret-access");
}

function inspectDelete(command: Command, previous: Segment | undefined, state: ShellState): void {
  const { name, args } = command;
  const windowsCmd = name === "del" || name === "erase" || name === "rd";
  const options = windowsCmd ? args.filter((arg) => /^\/[a-z]$/i.test(arg)) : flagsOf(args);
  const recursive = options.some((flag) => /^-[a-z]*r/i.test(flag) || /^--recursive$/i.test(flag) || /^\/s$/i.test(flag));
  if (options.some((flag) => /^--no-preserve-root$/i.test(flag))) state.reasons.add("destructive-delete");
  const targets = (windowsCmd ? args.filter((arg) => !/^\/[a-z]$/i.test(arg)) : positionals(args))
    .filter((target) => target !== "{}");
  if (command.fromInput) {
    // `… | xargs rm`: the producer's paths are deleted too. Without a visible
    // producer (`xargs -a list rm`) the targets cannot be reviewed.
    if (!previous || !segmentPiped(command)) state.reasons.add("unreviewable");
    else {
      const produced = positionals(commandOf(previous.words)?.args ?? []);
      if (produced.some((word) => placeOf(word, state.cwd, state.roots) !== "inside")) state.reasons.add("destructive-delete");
    }
  }
  for (const target of targets) {
    // A stale Git lock is routinely removed; the rest of .git is history.
    const gitLock = !recursive && /(^|[\\/])\.git[\\/]([\w./-]+[\\/])?[\w.-]+\.lock$/.test(target);
    if (placeOf(target, state.cwd, state.roots) !== "inside") state.reasons.add("destructive-delete");
    else if (!gitLock && (/(^|[\\/])\.git([\\/]|$)/.test(target) || (recursive && wipesWorkspace(target, state.cwd, state.roots)))) {
      state.reasons.add("destructive-delete");
    }
  }
}

/** A test that narrows what `find` matches. `-type` alone does not: `find .
 * -type f -delete` still removes every file of the tree. */
const findFiltered = (tail: readonly string[]): boolean =>
  tail.some((arg) => /^-(name|iname|path|ipath|regex|iregex|newer|mtime|mmin|empty|size|user|wholename)$/.test(arg));

/** The search roots and expression of a `find` command, and whether it deletes. */
function findParts(args: readonly string[]): { roots: string[]; tail: string[]; deletes: boolean } {
  const expression = args.findIndex((arg) => arg.startsWith("-") || arg === "(" || arg === "!");
  const roots = expression < 0 ? [...args] : args.slice(0, expression);
  const tail = expression < 0 ? [] : args.slice(expression);
  const deletes = tail.includes("-delete")
    || tail.some((arg, index) => /^-(exec|execdir|ok|okdir)$/.test(arg) && DELETERS.has(base(tail[index + 1] ?? "")));
  return { roots, tail, deletes };
}

function inspectFind(args: readonly string[], state: ShellState): void {
  const { roots, tail, deletes } = findParts(args);
  if (!deletes) return;
  const filtered = findFiltered(tail);
  for (const root of roots.length ? roots : ["."]) {
    if (!filtered || placeOf(root, state.cwd, state.roots) !== "inside") state.reasons.add("destructive-delete");
  }
}

/** A `git` subcommand and its arguments, past global options. */
function gitCommand(args: readonly string[]): { sub: string; rest: string[] } {
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    index += /^-(C|c)$/.test(args[index]!) || /^--(git-dir|work-tree|namespace)$/.test(args[index]!) ? 2 : 1;
  }
  return { sub: (args[index] ?? "").toLowerCase(), rest: args.slice(index + 1) };
}

function inspectGit(args: readonly string[], state: ShellState): void {
  const { sub, rest } = gitCommand(args);
  const words = positionals(rest);
  const lower = rest.map((arg) => arg.toLowerCase());
  switch (sub) {
    case "push":
      if (hasFlag(rest, "fd", ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "--prune"])
        || words.slice(1).some((ref) => ref.startsWith("+") || ref.startsWith(":"))) {
        state.reasons.add("history-rewrite");
      }
      return;
    case "reset":
      if (lower.includes("--hard")) state.reasons.add("discards-work");
      return;
    case "clean":
      if (!hasFlag(rest, "n", ["--dry-run"]) && hasFlag(rest, "f", ["--force"])) state.reasons.add("discards-work");
      return;
    case "checkout":
      if (hasFlag(rest, "f", ["--force"]) || words.some((word) => word === "." || word === ":/")) state.reasons.add("discards-work");
      return;
    case "switch":
      if (hasFlag(rest, "f", ["--force", "--discard-changes"])) state.reasons.add("discards-work");
      return;
    case "gc":
      // Pruning now removes the unreachable commits a reflog could restore.
      if (lower.some((arg) => /^--prune=(now|all)$/.test(arg))) state.reasons.add("history-rewrite");
      return;
    case "restore":
      if ((!hasFlag(rest, "S", ["--staged"]) || hasFlag(rest, "W", ["--worktree"]))
        && words.some((word) => word === "." || word === ":/" || word === "*")) {
        state.reasons.add("discards-work");
      }
      return;
    case "stash":
      if (words[0] === "drop" || words[0] === "clear") state.reasons.add("discards-work");
      return;
    case "branch":
      if (rest.includes("-D") || (hasFlag(rest, "d", ["--delete"]) && hasFlag(rest, "f", ["--force"]))) state.reasons.add("discards-work");
      return;
    case "worktree":
      if (words[0] === "remove" && hasFlag(rest, "f", ["--force"])) state.reasons.add("discards-work");
      return;
    case "filter-branch":
    case "filter-repo":
      state.reasons.add("history-rewrite");
      return;
    case "reflog":
      if (words[0] === "expire" || words[0] === "delete") state.reasons.add("history-rewrite");
      return;
    case "update-ref":
      if (hasFlag(rest, "d")) state.reasons.add("history-rewrite");
      return;
    case "config":
      if (lower.includes("--global") || lower.includes("--system")
        || words.some((word) => /^core\.(hookspath|sshcommand|fsmonitor)$/i.test(word))) {
        state.reasons.add("system-change");
      }
      return;
  }
}

/** `gh` / `glab` actions that change a remote repository or account. */
function inspectHosting(args: readonly string[], state: ShellState): void {
  const [group, verb] = leading(args, 2);
  const lower = args.map((arg) => arg.toLowerCase());
  if (group === "gist" && verb === "create") {
    state.reasons.add("data-upload");
    return;
  }
  if (group === "api") {
    const at = lower.findIndex((arg) => arg === "-x" || arg === "--method");
    const method = at >= 0 ? lower[at + 1] : lower.find((arg) => arg.startsWith("--method="))?.slice(9);
    const fields = lower.some((arg) => /^(-f|-F|--field|--raw-field|--input)$/i.test(arg));
    const mutating = verb === "graphql" ? lower.some((arg) => /\bmutation\b/.test(arg)) : method ? method !== "get" : fields;
    if (mutating) state.reasons.add("remote-change");
    return;
  }
  const destructive: Record<string, RegExp> = {
    repo: /^(delete|archive|rename|transfer|edit)$/,
    release: /^(create|delete|upload|edit)$/,
    pr: /^merge$/,
    mr: /^merge$/,
    secret: /^(set|delete|remove)$/,
    variable: /^(set|delete|remove)$/,
    workflow: /^(run|enable|disable)$/,
  };
  if (group && verb && destructive[group]?.test(verb)) state.reasons.add("remote-change");
}

/** `host:path`, `user@host:path` or an rsync URL; not `C:\\path`. */
const isRemoteDestination = (word: string): boolean =>
  !isWindowsPath(word) && (/^([\w.-]+@)?[\w.-]+:/.test(word) || word.startsWith("rsync://"));

function inspectTransfer(command: Command, segment: Segment, state: ShellState): void {
  const { name, args } = command;
  if (name === "curl") {
    args.forEach((arg, index) => {
      const value = args[index + 1] ?? "";
      if ((/^(-d|--data|--data-binary|--data-raw|--data-urlencode|--json)$/.test(arg) && value.startsWith("@"))
        || (/^(-F|--form)$/.test(arg) && /=[@<]/.test(value))
        || /^(-T|--upload-file)$/.test(arg) || /^-T./.test(arg)
        || /^--(data|data-binary|data-urlencode|json)=@/.test(arg)) {
        state.reasons.add("data-upload");
      }
    });
  } else if (name === "wget") {
    if (args.some((arg) => /^--(post|body)-file/.test(arg))) state.reasons.add("data-upload");
  } else if (name === "scp" || name === "rsync" || name === "sftp") {
    const destination = positionals(args).at(-1) ?? "";
    if (name === "sftp" || isRemoteDestination(destination)) state.reasons.add("data-upload");
  } else if (["nc", "ncat", "netcat", "socat", "telnet"].includes(name)) {
    if (args.some((arg) => /^-(e|c)$|^--(exec|sh-exec)$/.test(arg))) state.reasons.add("remote-code");
    else if (segment.piped || segment.words.includes("<")) state.reasons.add("data-upload");
  } else if (["invoke-webrequest", "invoke-restmethod", "iwr", "irm"].includes(name)) {
    if (args.some((arg) => /^-infile$/i.test(arg))) state.reasons.add("data-upload");
  } else if (name === "aws" || name === "gsutil" || name === "rclone") {
    const words = positionals(args).map((word) => word.toLowerCase());
    const copy = name === "aws"
      ? words[0] === "s3" && ["cp", "sync", "mv"].includes(words[1] ?? "")
      : ["cp", "rsync", "mv", "copy", "sync", "move", "copyto", "moveto"].includes(words[0] ?? "");
    const destination = words.at(-1) ?? "";
    if (copy && (/^(s3|gs):\/\//.test(destination) || (name === "rclone" && /^[\w-]+:/.test(destination)))) {
      state.reasons.add("data-upload");
    }
  }
}

/** Inline interpreter code that deletes files or starts processes. */
const INLINE_CODE_FLAGS = /^(-c|-e|-p|-r|--eval|--print|-pe|-ne|-le)$/;
const INLINE_INTERPRETERS = new Set(["python", "python3", "node", "perl", "ruby", "php", "bun", "deno", "osascript"]);
const INLINE_EFFECTS = /\b(rmtree|rmsync|rmdirsync|unlinksync|rm_rf|rm_r|remove_dir_all|shutil\.move|subprocess|child_process|execsync|spawnsync|popen|fileutils\.rm|do shell script)\b|\b(os\.(remove|unlink|rmdir|removedirs|system|exec\w*|spawn\w*)|system|exec|unlink|rmdir)\s*\(|\.unlink\s*\(|\.rmdir\s*\(/i;

function inspectSegment(segment: Segment, previous: Segment | undefined, state: ShellState): void {
  const parsed = commandOf(segment.words);
  if (!parsed) return;
  const command: Command = { ...parsed, piped: segment.piped };
  const { name, args } = command;
  const lower = args.map((arg) => arg.toLowerCase());
  if (command.privileged || ["su", "visudo"].includes(name)) state.reasons.add("privilege-escalation");

  // What will run cannot be read from the request: a variable or substituted
  // command name, `eval` of expanded text, a shell fed a script on stdin, or
  // inline interpreter code that deletes files or starts processes.
  const commandWord = segment.words.find((word) => base(word) === name || word.toLowerCase() === name) ?? name;
  if (/[$`%]/.test(commandWord)) state.reasons.add("unreviewable");
  if (name === "eval" && args.some((arg) => /[$`]/.test(arg))) state.reasons.add("unreviewable");
  if (SHELLS.has(name) && !args.some((arg) => /^(-[a-z]*c[a-z]*|-command|\/c)$/i.test(arg))
    && (segment.piped || segment.words.includes("<<<"))) {
    const producer = previous && segment.piped ? commandOf(previous.words) : undefined;
    // A heredoc's body is parsed as commands of its own and judged directly.
    if (!(producer && (producer.name === "cat" || producer.name === "echo") && previous?.words.includes("<<"))) {
      state.reasons.add("unreviewable");
    }
  }
  if (INLINE_INTERPRETERS.has(name) || /^python3?(\.\d+)?$/.test(name)) {
    const at = args.findIndex((arg) => INLINE_CODE_FLAGS.test(arg));
    const code = at >= 0 ? args[at + 1] ?? "" : name === "deno" && args[0] === "eval" ? args.slice(1).join(" ") : "";
    // Perl, Ruby and PHP backticks run shell commands; JavaScript's are text.
    if (code && (INLINE_EFFECTS.test(code) || (/^(perl|ruby|php)$/.test(name) && /`[^`]+`/.test(code)))) {
      state.reasons.add("unreviewable");
    }
  }

  // Redirection targets are writes; any secret file named is an access.
  segment.words.forEach((word, index) => {
    const target = segment.words[index + 1];
    if ((word === ">" || word === ">>") && target !== undefined) writeTarget(target, state);
    if (isSecretPath(word)) state.reasons.add("secret-access");
    if (SECRET_VARIABLE.test(word)) state.reasons.add("secret-access");
  });

  if (name === "cd" || name === "pushd" || name === "set-location") {
    const target = positionals(args)[0];
    const path = target === undefined || target === "-" ? undefined : absolutePath(target, state.cwd);
    if (path === undefined) state.cwd = "unknown";
    else if (!path.startsWith(RELATIVE)) state.cwd = path;
    return;
  }
  if (name === "chmod") {
    const mode = positionals(args)[0] ?? "";
    if (/^[ugoa]*[+=][rwxXt]*s/.test(mode) || /^[2467][0-7]{3}$/.test(mode)) state.reasons.add("privilege-escalation");
    if (/^[0-7]{3,4}$/.test(mode) && /[2367]$/.test(mode)) state.reasons.add("system-change");
    if (/^[ugo]*[ao][ugo]*[+=][rwxXst]*w/.test(mode)) state.reasons.add("system-change");
  }
  if (DELETERS.has(name)) inspectDelete(command, previous, state);
  if (name === "shred" || name === "srm") state.reasons.add("destructive-delete");
  if (name === "find") inspectFind(args, state);
  if (name === "git") inspectGit(args, state);
  if (name === "gh" || name === "glab") inspectHosting(args, state);
  if (SYSTEM_COMMANDS.has(name) || /^mkfs(\.\w+)?$/.test(name)) state.reasons.add("system-change");
  if (name === "sysctl" && (args.includes("-w") || args.some((arg) => /^[\w.]+=/.test(arg)))) state.reasons.add("system-change");
  if (name === "init" && /^[06]$/.test(args[0] ?? "")) state.reasons.add("system-change");
  if (name === "kill" && args.includes("-1")) state.reasons.add("system-change");
  if (name === "systemctl" || name === "launchctl") {
    if (/^(poweroff|reboot|halt|suspend|hibernate|kexec|isolate|enable|disable|mask|stop|kill|restart|load|unload|bootstrap|bootout|remove|kickstart)$/
      .test(leading(args, 1)[0] ?? "")) {
      state.reasons.add("system-change");
    }
  }
  if (name === "crontab" && !args.includes("-l")) state.reasons.add("system-change");
  if (name === "diskutil" && /^(erase|partition|zero|secureerase|reformat)/i.test(leading(args, 1)[0] ?? "")) state.reasons.add("system-change");
  if (name === "format" && /^[a-z]:$/i.test(args[0] ?? "")) state.reasons.add("system-change");
  if (name === "dd") {
    const output = args.find((arg) => arg.startsWith("of="));
    if (output) writeTarget(output.slice(3), state);
  }
  if ((name === "docker" || name === "podman")) {
    const [group, verb] = leading(args, 2);
    if ((group === "volume" && (verb === "rm" || verb === "prune")) || (group === "system" && verb === "prune")) {
      state.reasons.add("destructive-delete");
    }
  }
  const destroyed = infrastructureDestruction(name, args);
  if (destroyed) {
    state.reasons.add("infrastructure-destruction");
    if (destroyed.extra) state.reasons.add(destroyed.extra);
  }
  // A recursive mode or owner change of the whole workspace or its Git data.
  if ((name === "chmod" || name === "chown" || name === "chgrp") && hasFlag(args, "R", ["--recursive"])
    && positionals(args).slice(1).some((target) => wipesWorkspace(target, state.cwd, state.roots))) {
    state.reasons.add("system-change");
  }
  // Local `rsync`: the destination is written, and `--delete` empties what the
  // source lacks, so mirroring into the workspace root or elsewhere deletes.
  if (name === "rsync") {
    const destination = positionals(args).at(-1);
    if (destination !== undefined && positionals(args).length > 1 && !isRemoteDestination(destination)) {
      writeTarget(destination, state);
      if (lower.some((arg) => /^--del(ete(-\w+)?)?$/.test(arg))
        && (placeOf(destination, state.cwd, state.roots) !== "inside" || wipesWorkspace(destination, state.cwd, state.roots))) {
        state.reasons.add("destructive-delete");
      }
    }
  }

  // Writes outside the workspace.
  const writes = WRITERS[name];
  if (writes) {
    const paths = positionals(args);
    for (const target of writes === "all" ? paths : writes === "last" ? paths.slice(-1) : paths.slice(1)) writeTarget(target, state);
  }
  if ((name === "sed" && hasFlag(args, "i", ["--in-place"])) || (name === "perl" && args.some((arg) => /^-[a-z]*i/.test(arg)))) {
    for (const target of positionals(args).slice(1)) writeTarget(target, state);
  }
  lower.forEach((arg, index) => {
    const value = args[index + 1];
    if (value === undefined) return;
    if ((name === "curl" && (arg === "-o" || arg === "--output"))
      || (name === "wget" && (arg === "-o" || arg === "-p"))
      || (name === "tar" && (args[index] === "-C" || arg === "--directory"))
      || (name === "unzip" && arg === "-d")) {
      writeTarget(value, state);
    }
  });

  inspectTransfer(command, segment, state);
  // An HTTP call to a permissions API (Polyth's own approval routes included)
  // could answer or widen the caller's own approvals.
  if ((DOWNLOADERS.has(name) || ["http", "https", "xh"].includes(name))
    && args.some((arg) => /\/permissions(\/|\?|$)|auto-accept/i.test(arg))) {
    state.reasons.add("privilege-escalation");
  }

  // Publishing, deployment and remote infrastructure.
  const verbs = REMOTE_VERBS[name];
  const words = leading(args, 3);
  if (verbs && words.some((word) => verbs.test(word)) && !(name === "gcloud" && words[0] === "config")) {
    state.reasons.add("remote-change");
  }
  if ((name === "terraform" || name === "tofu") && words[0] === "state" && /^(rm|mv|push|replace-provider)$/.test(words[1] ?? "")) {
    state.reasons.add("remote-change");
  }
  if (name === "aws") {
    const [service, operation] = words;
    if (service === "s3" ? operation === "rm" || operation === "rb" || lower.includes("--delete") : AWS_MUTATION.test(operation ?? "")) {
      state.reasons.add("remote-change");
    }
  }
  if (name === "gsutil" && words[0] === "rsync" && hasFlag(args, "d")) state.reasons.add("remote-change");
  if ((name === "vercel" && lower.includes("--prod")) || (name === "netlify" && words[0] === "deploy" && lower.includes("--prod"))) {
    state.reasons.add("remote-change");
  }

  // Credential helpers and environment dumps print secrets.
  const named = positionals(args);
  if ((name === "env" && args.length === 0) || (name === "set" && args.length === 0)
    || (name === "export" && args.includes("-p")) || (name === "declare" && named.length === 0 && hasFlag(args, "xp"))
    || (name === "printenv" && (named.length === 0 || named.some((variable) => SECRET_VARIABLE.test(`$${variable}`))))) {
    state.reasons.add("secret-access");
  }
  const joined = lower.join(" ");
  for (const [secretCommand, pattern] of SECRET_COMMANDS) {
    if (name === secretCommand && (pattern.test(words.join(" ")) || pattern.test(joined))) state.reasons.add("secret-access");
  }
  if (name === "gpg" && lower.some((arg) => arg.startsWith("--export-secret"))) state.reasons.add("secret-access");
  if (name.startsWith("docker-credential-")) state.reasons.add("secret-access");
  if (name === "kubectl" && words[0] === "config" && words[1] === "view" && lower.includes("--raw")) state.reasons.add("secret-access");
}

function shellReasons(text: string, roots: readonly string[], reasons: Set<PermissionRiskReason>): void {
  if (text.length > MAX_SCAN) {
    reasons.add("unreviewable");
    return;
  }
  const scanned = text;
  for (const [pattern, reason] of ALWAYS_RULES) if (pattern.test(scanned)) reasons.add(reason);
  const hidden = { found: false };
  const segments = parseShell(scanned, hidden);
  if (hidden.found) reasons.add("unreviewable");
  // SQL is judged only where a database tool can run it, so prose such as a
  // commit message mentioning "drop table" stays routine.
  if (segments.some((segment) => segment.words.some((word) => DATABASE_TOOLS.has(base(word))))
    && DATABASE_RULES.some((pattern) => pattern.test(scanned))) {
    reasons.add("database-destruction");
  }
  const state: ShellState = { roots, cwd: roots[0], reasons };
  let downloading = false;
  segments.forEach((segment, index) => {
    if (!segment.piped) downloading = false;
    const command = commandOf(segment.words);
    // A download piped (through any filters) into an interpreter runs it.
    if (command && downloading && INTERPRETERS.has(command.name)) reasons.add("remote-code");
    if (command && DOWNLOADERS.has(command.name)) downloading = true;
    inspectSegment(segment, index > 0 ? segments[index - 1] : undefined, state);
  });
}

// ---- tools and paths ---------------------------------------------------------

const DESTRUCTIVE_TOOL = /(?:^|[_.:/\-\s])(delete|destroy|drop|purge|wipe|erase|truncate|uninstall|terminate|revoke|unpublish|publish|deploy|force_?push)(?:[_.:/\-\s]|$)/;

const OUTBOUND_TOOL = /(?:^|[_.:/\-\s])(send|share)(?:[_.:/\-\s]|$)/;
const UPLOAD_TOOL = /(?:^|[_.:/\-\s])upload(?:[_.:/\-\s]|$)/;

const toolWords = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

const looksLikePath = (value: string, fileChange: boolean): boolean => {
  const text = value.trim();
  if (!text || text.length > 4096 || /[\r\n]/.test(text)) return false;
  if (/^(\/|~|\.{1,2}[\\/]|file:\/\/)/.test(text) || isWindowsPath(text)) return true;
  return !/\s/.test(text) && (fileChange || /[\\/.]/.test(text));
};

function pathReasons(value: string, fileChange: boolean, roots: readonly string[], reasons: Set<PermissionRiskReason>): void {
  if (!looksLikePath(value, fileChange)) return;
  if (isSecretPath(value)) reasons.add("secret-access");
  if (!fileChange) return;
  const place = placeOf(value, roots[0], roots);
  if (place === "outside") reasons.add("outside-workspace");
  if (place === "block-device") reasons.add("system-change");
  if (/(^|[\\/])\.git[\\/](hooks|config)([\\/]|$)/.test(value)) reasons.add("system-change");
}

/** Native todo/plan tools (mirrors `@polyth/todos`' replacement-list names) and
 * Claude's task-list tools. Matched only as a bare native name: an MCP-qualified
 * `todo` from some other server can do anything. */
const SESSION_PLAN_TOOLS = new Set([
  "todowrite", "todo_write", "todo", "todos", "write_todos", "update_todos", "updatetodos",
  "update_plan", "updateplan", "taskcreate", "taskupdate", "tasklist", "taskget",
]);
/** Polyth's own `polyth_todo`, bare or as published by the Polyth agent-tools
 * MCP server (Claude `mcp__polyth-agent-tools__…`, OpenCode `polyth-agent-tools_…`,
 * Antigravity `mcp_polyth-agent-tools_…`). */
const POLYTH_TODO_TOOL = /^(?:(?:mcp__?)?polyth-agent-tools(?:__|_))?polyth_todo$/;

/** True when a request only edits the calling session's own todo list. Such a
 * request never needs a person: it has no effect outside the session plan.
 * Only the permission name counts; patterns are free text (a shell command). */
export function isSessionPlanPermission(input: Pick<PermissionRiskInput, "permission">): boolean {
  const name = typeof input.permission === "string" ? input.permission.trim().toLowerCase() : "";
  return SESSION_PLAN_TOOLS.has(name) || POLYTH_TODO_TOOL.test(name);
}

/** Assess one permission request. Pure and bounded. */
export function assessPermissionRisk(
  input: PermissionRiskInput,
  context: PermissionRiskContext = {},
): PermissionRiskAssessment {
  const reasons = new Set<PermissionRiskReason>();
  const roots = (context.workspaceRoots ?? [])
    .filter((root) => typeof root === "string" && (root.startsWith("/") || isWindowsPath(root)))
    .map(normalizeAbsolute);
  const permission = permissionKey(input.permission);
  const tool = permissionKey(input.tool ?? "");
  const shell = SHELL_PERMISSIONS.has(permission) || SHELL_PERMISSIONS.has(tool);
  const fileChange = !shell && (FILE_CHANGE_PERMISSIONS.has(permission) || FILE_CHANGE_PERMISSIONS.has(tool));
  const patterns = input.patterns.filter((pattern) => typeof pattern === "string");

  const commands = shell ? [...patterns] : [];
  const paths = shell ? [] : [...patterns];
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== "string") continue;
      if (COMMAND_KEYS.test(key)) commands.push(item);
      else if (PATH_KEYS.test(key)) paths.push(item);
    }
  }
  if (commands.length + paths.length > MAX_PATTERNS) reasons.add("unreviewable");
  for (const command of commands.slice(0, MAX_PATTERNS)) shellReasons(command, roots, reasons);
  for (const path of paths.slice(0, MAX_PATTERNS)) {
    if (fileChange && path.length > MAX_SCAN) reasons.add("unreviewable");
    else pathReasons(path, fileChange, roots, reasons);
  }

  // A tool's own name can declare a destructive action (MCP, package tools).
  if (!shell && !fileChange) {
    const names = [input.permission, input.tool ?? "", ...(permission === "packagetool" ? patterns : [])];
    if (names.some((name) => name && DESTRUCTIVE_TOOL.test(toolWords(name)))) reasons.add("destructive-tool");
    // Polyth package tools name their outbound actions: a message sent, access
    // granted or a file uploaded on the user's behalf cannot be taken back.
    if (permission === "packagetool") {
      const words = [input.tool ?? "", ...patterns].map(toolWords);
      if (words.some((name) => OUTBOUND_TOOL.test(name))) reasons.add("remote-change");
      if (words.some((name) => UPLOAD_TOOL.test(name))) reasons.add("data-upload");
    }
  }

  if (reasons.size > 0) return { risk: "high", reasons: PERMISSION_RISK_REASONS.filter((reason) => reasons.has(reason)) };
  return { risk: READ_ONLY_PERMISSIONS.has(permission) ? "low" : "medium", reasons: [] };
}

/** Auto-Approve answers routine requests only. A high-risk request always waits
 * for a person, whatever the session policy says; explicit deny rules still win
 * before this is consulted. */
export const autoApproveMayAnswer = (assessment: PermissionRiskAssessment): boolean => assessment.risk !== "high";

/** The effective automatic-approval level of a session (`@polyth/permissions`
 * AutoAcceptLevel). */
export type AutomaticApprovalLevel = "off" | "routine" | "all";

/** Whether an automatic policy may answer a request, explicit allow/deny rules
 * aside. "routine" (Auto-Approve) never answers a high-risk request. Only
 * "all" (Full access) does, and only a person can choose it: per session after
 * a confirmation, or for a Space's chats through the owner's settings, which an
 * agent can turn off but never on. Any other value answers nothing. */
export function automaticApprovalMayAnswer(level: AutomaticApprovalLevel, assessment: PermissionRiskAssessment): boolean {
  if (level === "all") return true;
  if (level === "routine") return autoApproveMayAnswer(assessment);
  return false;
}

// ---- blast radius ------------------------------------------------------------
//
// What a request would affect, read from the same parsing as the assessment:
// which paths (inside or outside the workspace, the workspace root, Git data),
// which remote and branches a push rewrites, which tables, resources or hosts.
// It explains a high-risk card; it never decides anything. Targets are taken
// from the request text, stripped of URL credentials and query strings,
// token-like values and clipped, so it is safe to show next to the redacted
// preview. Like the assessment it sees only what the request names.

/** Effect kinds; clients localize them and skip kinds they do not know. */
export const BLAST_RADIUS_KINDS = [
  "delete",
  "discard-changes",
  "discard-untracked",
  "delete-branch",
  "drop-stash",
  "rewrite-history",
  "push",
  "write",
  "permissions",
  "database",
  "infrastructure",
  "upload",
] as const;
export type BlastRadiusKind = (typeof BLAST_RADIUS_KINDS)[number];

/** Where a path lies relative to the session's workspace. */
export type BlastRadiusScope = "workspace" | "workspace-root" | "git-data" | "outside" | "temp" | "device" | "unknown";

export interface BlastRadiusEffect {
  kind: BlastRadiusKind;
  /** The path, ref, statement, resource or host, as named in the request. */
  target?: string;
  scope?: BlastRadiusScope;
  /** A push or branch deletion: the remote it goes to. */
  remote?: string;
  recursive?: boolean;
  /** Overwrites what is there (force push, `-f`). */
  force?: boolean;
  /** Nothing narrows it: every row, resource, branch or file it can reach. */
  unbounded?: boolean;
  /** `git clean -x`: ignored files (build output, local config) go too. */
  ignored?: boolean;
}

export interface BlastRadius {
  effects: BlastRadiusEffect[];
  /** More effects existed, or the request was too large to read in full. */
  truncated: boolean;
}

const MAX_EFFECTS = 8;
const MAX_TARGET = 96;
const TOKEN_LIKE = /\b(?:gh[pousr]_|github_pat_|glpat-|sk-|xox[abp]-|AKIA)[A-Za-z0-9_-]{8,}/g;
const ASSIGNED_SECRET = /\b(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*\S+/gi;

/** A target that is safe to display: no URL credentials or query, no
 * token-like values, bounded. */
function displayTarget(value: string): string {
  let text = value.trim().replace(/\s+/g, " ");
  if (/^[a-z][\w+.-]*:\/\//i.test(text)) {
    text = text.replace(/^([a-z][\w+.-]*:\/\/)[^/@\s]*@/i, "$1").replace(/[?#].*$/, "");
  }
  text = text.replace(TOKEN_LIKE, "[redacted]").replace(ASSIGNED_SECRET, "$1=[redacted]");
  return text.length > MAX_TARGET ? `${text.slice(0, MAX_TARGET - 1)}…` : text;
}

/** The host of a URL, `user@host:path` or bucket destination. */
function hostOf(value: string): string {
  const url = /^[a-z][\w+.-]*:\/\/(?:[^/@\s]*@)?([^/:?#\s]+)/i.exec(value);
  if (url) return url[1]!;
  const scp = /^(?:[\w.-]+@)?([\w.-]+):/.exec(value);
  return scp ? scp[1]! : value;
}

function scopeOf(word: string, cwd: Cwd, roots: readonly string[]): BlastRadiusScope | undefined {
  if (/(^|[\\/])\.git([\\/]|$)/.test(word)) return "git-data";
  if (absolutePath(word, cwd) === undefined) return "unknown";
  const place = placeOf(word, cwd, roots);
  if (place === "null-device") return undefined;
  if (place === "block-device") return "device";
  if (place === "temp") return "temp";
  if (place === "outside") return "outside";
  return wipesWorkspace(word, cwd, roots) ? "workspace-root" : "workspace";
}

interface BlastState {
  roots: readonly string[];
  cwd: Cwd;
  effects: BlastRadiusEffect[];
}

function addEffect(state: BlastState, effect: BlastRadiusEffect): void {
  const clean: BlastRadiusEffect = { kind: effect.kind };
  if (effect.target !== undefined) clean.target = displayTarget(effect.target);
  if (effect.remote !== undefined) clean.remote = displayTarget(effect.remote);
  for (const key of ["scope", "recursive", "force", "unbounded", "ignored"] as const) {
    if (effect[key]) (clean as unknown as Record<string, unknown>)[key] = effect[key];
  }
  const key = JSON.stringify(clean);
  if (!state.effects.some((existing) => JSON.stringify(existing) === key)) state.effects.push(clean);
}

/** A write is worth naming only where it reaches past the workspace. */
function blastWrite(word: string, state: BlastState): void {
  const scope = scopeOf(word, state.cwd, state.roots);
  if (scope === "outside" || scope === "unknown" || scope === "device"
    || (scope === "git-data" && /(^|[\\/])\.git[\\/](hooks|config)([\\/]|$)/.test(word))) {
    addEffect(state, { kind: "write", target: shownPath(word, scope, state), scope });
  }
}

/** A relative path outside the workspace (after `cd /srv`) reads better resolved. */
function shownPath(word: string, scope: BlastRadiusScope | undefined, state: BlastState): string {
  if (scope !== "outside" && scope !== "temp") return word;
  const path = absolutePath(word, state.cwd);
  return path === undefined || path.startsWith(RELATIVE) ? word : path;
}

function blastDelete(word: string, recursive: boolean, state: BlastState, unbounded = false): void {
  const scope = scopeOf(word, state.cwd, state.roots);
  if (scope === undefined) return;
  addEffect(state, { kind: "delete", target: shownPath(word, scope, state), scope, ...(recursive ? { recursive } : {}), ...(unbounded ? { unbounded } : {}) });
}

function blastGit(args: readonly string[], state: BlastState): void {
  const { sub, rest } = gitCommand(args);
  const words = positionals(rest);
  const lower = rest.map((arg) => arg.toLowerCase());
  switch (sub) {
    case "push": {
      const [remote, ...refs] = words;
      const mirror = lower.includes("--mirror");
      const deleting = hasFlag(rest, "d", ["--delete"]);
      const forced = mirror || hasFlag(rest, "f", ["--force", "--force-with-lease", "--force-if-includes"]);
      const where = remote ? { remote } : {};
      for (const ref of refs) {
        if (deleting || ref.startsWith(":")) addEffect(state, { kind: "delete-branch", target: ref.replace(/^:/, ""), ...where });
        else if (forced || ref.startsWith("+")) addEffect(state, { kind: "push", target: ref.replace(/^\+/, ""), force: true, ...where });
      }
      if (forced && (refs.length === 0 || mirror)) addEffect(state, { kind: "push", force: true, ...where, ...(mirror ? { unbounded: true } : {}) });
      if (lower.includes("--prune")) addEffect(state, { kind: "delete-branch", unbounded: true, ...where });
      return;
    }
    case "reset":
      if (lower.includes("--hard")) addEffect(state, { kind: "discard-changes", target: words[0] ?? "HEAD", scope: "workspace" });
      return;
    case "clean":
      if (!hasFlag(rest, "n", ["--dry-run"]) && hasFlag(rest, "f", ["--force"])) {
        const ignored = hasFlag(rest, "xX");
        const paths = words.length ? words : ["."];
        for (const path of paths) {
          const scope = scopeOf(path, state.cwd, state.roots);
          addEffect(state, { kind: "discard-untracked", target: path, ...(scope ? { scope } : {}), ...(hasFlag(rest, "d") ? { recursive: true } : {}), ...(ignored ? { ignored } : {}) });
        }
      }
      return;
    case "checkout":
    case "restore":
    case "switch": {
      const pathspec = words.find((word) => word === "." || word === ":/" || word === "*");
      const forced = hasFlag(rest, "f", ["--force", "--discard-changes"]);
      if (pathspec || (forced && sub !== "restore")) {
        addEffect(state, { kind: "discard-changes", target: pathspec ?? words[0] ?? "HEAD", scope: "workspace" });
      }
      return;
    }
    case "stash":
      if (words[0] === "clear") addEffect(state, { kind: "drop-stash", unbounded: true });
      else if (words[0] === "drop") addEffect(state, { kind: "drop-stash", target: words[1] ?? "stash@{0}" });
      return;
    case "branch":
      if (rest.includes("-D") || (hasFlag(rest, "d", ["--delete"]) && hasFlag(rest, "f", ["--force"]))) {
        for (const branch of words) addEffect(state, { kind: "delete-branch", target: branch, force: true });
      }
      return;
    case "filter-branch":
    case "filter-repo":
      addEffect(state, { kind: "rewrite-history", target: `git ${sub}`, unbounded: true });
      return;
    case "reflog":
      if (words[0] === "expire" || words[0] === "delete") addEffect(state, { kind: "rewrite-history", target: `git reflog ${words[0]}` });
      return;
    case "gc":
      if (lower.some((arg) => /^--prune=(now|all)$/.test(arg))) addEffect(state, { kind: "rewrite-history", target: "git gc --prune" });
      return;
    case "update-ref":
      if (hasFlag(rest, "d") && words[0]) addEffect(state, { kind: "delete-branch", target: words[0] });
      return;
  }
}

function blastSegment(segment: Segment, previous: Segment | undefined, state: BlastState): void {
  const parsed = commandOf(segment.words);
  if (!parsed) return;
  const command: Command = { ...parsed, piped: segment.piped };
  const { name, args } = command;
  const lower = args.map((arg) => arg.toLowerCase());

  segment.words.forEach((word, index) => {
    const target = segment.words[index + 1];
    if ((word === ">" || word === ">>") && target !== undefined) blastWrite(target, state);
  });
  if (name === "cd" || name === "pushd" || name === "set-location") {
    const target = positionals(args)[0];
    const path = target === undefined || target === "-" ? undefined : absolutePath(target, state.cwd);
    if (path === undefined) state.cwd = "unknown";
    else if (!path.startsWith(RELATIVE)) state.cwd = path;
    return;
  }

  if (DELETERS.has(name)) {
    const windowsCmd = name === "del" || name === "erase" || name === "rd";
    const options = windowsCmd ? args.filter((arg) => /^\/[a-z]$/i.test(arg)) : flagsOf(args);
    const recursive = options.some((flag) => /^-[a-z]*r/i.test(flag) || /^--recursive$/i.test(flag) || /^\/s$/i.test(flag));
    let targets = (windowsCmd ? args.filter((arg) => !/^\/[a-z]$/i.test(arg)) : positionals(args)).filter((target) => target !== "{}");
    if (command.fromInput) {
      const producer = previous && segmentPiped(command) ? commandOf(previous.words) : undefined;
      // `find src -name x | xargs rm`: the search roots, not the test values.
      const produced = !producer ? [] : producer.name === "find" ? findParts(producer.args).roots : positionals(producer.args);
      if (!produced.length && !targets.length) addEffect(state, { kind: "delete", scope: "unknown", unbounded: true, ...(recursive ? { recursive } : {}) });
      targets = [...produced, ...targets];
    }
    for (const target of targets) blastDelete(target, recursive, state);
  }
  if (name === "shred" || name === "srm") for (const target of positionals(args)) blastDelete(target, false, state);
  if (name === "find") {
    const { roots, tail, deletes } = findParts(args);
    if (deletes) for (const root of roots.length ? roots : ["."]) blastDelete(root, true, state, !findFiltered(tail));
  }
  if (name === "git") blastGit(args, state);
  if (name === "rsync") {
    const paths = positionals(args);
    const destination = paths.at(-1);
    if (destination !== undefined && paths.length > 1 && !isRemoteDestination(destination)) {
      blastWrite(destination, state);
      if (lower.some((arg) => /^--del(ete(-\w+)?)?$/.test(arg))) blastDelete(destination, true, state);
    }
  }

  // Writes and permission changes beyond the workspace.
  const writes = WRITERS[name];
  if (writes) {
    const paths = positionals(args);
    const targets = writes === "all" ? paths : writes === "last" ? paths.slice(-1) : paths.slice(1);
    const permissions = name === "chmod" || name === "chown" || name === "chgrp";
    const recursive = permissions && hasFlag(args, "R", ["--recursive"]);
    for (const target of targets) {
      const scope = scopeOf(target, state.cwd, state.roots);
      if (!permissions) blastWrite(target, state);
      else if (scope && (recursive || scope !== "workspace")) {
        addEffect(state, { kind: "permissions", target, scope, ...(recursive ? { recursive } : {}) });
      }
    }
  }
  if ((name === "sed" && hasFlag(args, "i", ["--in-place"])) || (name === "perl" && args.some((arg) => /^-[a-z]*i/.test(arg)))) {
    for (const target of positionals(args).slice(1)) blastWrite(target, state);
  }
  if (name === "dd") {
    const output = args.find((arg) => arg.startsWith("of="));
    if (output) blastWrite(output.slice(3), state);
  }
  lower.forEach((arg, index) => {
    const value = args[index + 1];
    if (value === undefined) return;
    if ((name === "curl" && (arg === "-o" || arg === "--output"))
      || (name === "wget" && (arg === "-o" || arg === "-p"))
      || (name === "tar" && (args[index] === "-C" || arg === "--directory"))
      || (name === "unzip" && arg === "-d")) {
      blastWrite(value, state);
    }
  });

  const destroyed = infrastructureDestruction(name, args);
  if (destroyed) {
    addEffect(state, { kind: "infrastructure", target: destroyed.words.join(" "), ...(destroyed.unbounded ? { unbounded: true } : {}) });
  }

  // Uploads: the host that receives the data.
  const probe: ShellState = { roots: state.roots, cwd: state.cwd, reasons: new Set() };
  inspectTransfer(command, segment, probe);
  if (probe.reasons.has("data-upload")) {
    const url = args.find((arg) => /^https?:\/\//i.test(arg));
    const destination = url ?? positionals(args).at(-1);
    if (destination) addEffect(state, { kind: "upload", target: hostOf(destination) });
  }
}

const MAX_STATEMENT = 160;

/** The statement starting at `start`, up to its end: `;`, a line break, or the
 * quote that opened the shell argument holding it. Quotes inside the statement
 * (`SET role = 'admin'`) stay, so the text names what it changes. */
function sqlStatement(text: string, start: number): string {
  const opener = /(["'`])\s*$/.exec(text.slice(0, start))?.[1];
  let end = text.length;
  for (const stop of [";", "\n", ...(opener ? [opener] : [])]) {
    const at = text.indexOf(stop, start);
    if (at !== -1 && at < end) end = at;
  }
  const statement = text.slice(start, end).replace(/\s+/g, " ").trim();
  return statement.length > MAX_STATEMENT ? `${statement.slice(0, MAX_STATEMENT - 1)}…` : statement;
}

function blastShell(text: string, state: BlastState): boolean {
  if (text.length > MAX_SCAN) return true;
  const segments = parseShell(text, { found: false });
  if (segments.some((segment) => segment.words.some((word) => DATABASE_TOOLS.has(base(word))))) {
    for (const rule of DATABASE_RULES) {
      const match = rule.exec(text);
      // The statement up to its end, so the table or collection is named.
      if (match) addEffect(state, { kind: "database", target: sqlStatement(text, match.index) });
    }
  }
  segments.forEach((segment, index) => blastSegment(segment, index > 0 ? segments[index - 1] : undefined, state));
  return false;
}

const DELETE_PERMISSIONS = new Set(["delete", "deletefile", "remove", "removefile"]);

/** Describe what one permission request would affect. Pure and bounded; an
 * empty list means nothing beyond the request text was recognized, not that
 * nothing is affected. */
export function describeBlastRadius(
  input: PermissionRiskInput,
  context: PermissionRiskContext = {},
): BlastRadius {
  const roots = (context.workspaceRoots ?? [])
    .filter((root) => typeof root === "string" && (root.startsWith("/") || isWindowsPath(root)))
    .map(normalizeAbsolute);
  const state: BlastState = { roots, cwd: roots[0], effects: [] };
  const permission = permissionKey(input.permission);
  const tool = permissionKey(input.tool ?? "");
  const shell = SHELL_PERMISSIONS.has(permission) || SHELL_PERMISSIONS.has(tool);
  const fileChange = !shell && (FILE_CHANGE_PERMISSIONS.has(permission) || FILE_CHANGE_PERMISSIONS.has(tool));
  const patterns = input.patterns.filter((pattern) => typeof pattern === "string");
  const commands = shell ? [...patterns] : [];
  const paths = fileChange ? [...patterns] : [];
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== "string") continue;
      if (COMMAND_KEYS.test(key)) commands.push(item);
      else if (fileChange && PATH_KEYS.test(key)) paths.push(item);
    }
  }
  let truncated = commands.length + paths.length > MAX_PATTERNS;
  for (const command of commands.slice(0, MAX_PATTERNS)) {
    state.cwd = roots[0];
    if (blastShell(command, state)) truncated = true;
  }
  const deleting = DELETE_PERMISSIONS.has(permission) || DELETE_PERMISSIONS.has(tool);
  for (const path of paths.slice(0, MAX_PATTERNS)) {
    if (path.length > MAX_SCAN || !looksLikePath(path, true)) continue;
    if (deleting) blastDelete(path, false, state);
    else blastWrite(path, state);
  }
  return {
    effects: state.effects.slice(0, MAX_EFFECTS),
    truncated: truncated || state.effects.length > MAX_EFFECTS,
  };
}

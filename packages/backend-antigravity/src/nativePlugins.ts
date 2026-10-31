// Antigravity's own plugins (`agy plugin list|install|uninstall|enable|disable`),
// managed in the harness home's `.gemini` (an extra account's private home for
// account harnesses). Each runtime's private HOME links that `.gemini` back
// (home.ts), so a change reaches the next session.
//
// Evidence (agy 1.3.1, read-only): `plugin list` prints `No imported plugins.`
// when empty and has no machine-readable mode. The real non-empty output has
// NOT been observed, so it is parsed conservatively: only a line shaped like a
// plugin row (an optional bullet, one plugin name, an optional enabled/disabled
// state) becomes a plugin, and if any other line appears every row is
// read-only. `plugin uninstall <name>` reports success for a name that is not
// installed and rewrites `.gemini/config/import_manifest.json`, so Polyth only
// runs it for a name in a freshly read, fully recognized list. `plugin import`
// (from Claude/Gemini) is out of scope.
import type { HarnessContext, MutationOutcome } from "@polyth/contracts";
import type {
  HarnessNativePluginManager,
  NativePluginAction,
  NativePluginDto,
  NativePluginListDto,
  NativePluginSupportDto,
} from "@polyth/contracts/capability-installations";
import { nativePluginRefError, readNativePluginCli, runNativePluginCli } from "@polyth/harness-runtime/native-plugins";

export interface AntigravityNativePluginsOptions {
  harnessId: string;
  /** The executable and its environment, including an account's private `HOME`. */
  resolveBinary(): Promise<{ command: string; env: NodeJS.ProcessEnv }>;
}

const ACTIONS: NativePluginAction[] = ["install", "uninstall", "enable", "disable"];
const LIST_SOURCE = "agy plugin list";
const EMPTY = /^No imported plugins\.?$/i;
const MAX_PLUGINS = 200;
const PARSE_WARNING = "Antigravity has no machine-readable plugin list; names and states are read from its text output.";
const UNRECOGNIZED_WARNING = "Some lines of agy's plugin list were not recognized, so its plugins are shown read-only.";
const UNRECOGNIZED_NOTE = "agy's plugin list could not be fully read; manage this plugin with `agy plugin` in a terminal.";

const support = (context: HarnessContext): NativePluginSupportDto => ({
  actions: context.remote ? [] : [...ACTIONS],
  installScopes: context.remote ? [] : ["user"],
  installHint: "plugin@marketplace or /path/to/plugin-directory",
  applies: "next-session",
  marketplaces: false,
});

const stripAnsi = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

export interface AntigravityListedPlugin {
  name: string;
  enabled: boolean | "unknown";
}

/** Optional bullet, one name (`name` or `name@marketplace`), optional state. */
const ROW = /^(?:(?:[-*\u2022]|\d+[.)])\s+)?([A-Za-z0-9][\w.-]*(?:@[A-Za-z0-9][\w.-]*)?)(?:\s*(?:[-:]\s*)?[([]?(enabled|disabled)[)\]]?)?$/i;
/** A section header such as `Imported plugins:`. */
const HEADER = /^[A-Za-z][A-Za-z ]*:$/;

/** `empty` only for agy's own empty marker (or no output). `unrecognized`
 * counts lines that are neither a header nor a plugin row. */
export function parseAgyPluginList(stdout: string): { empty: boolean; plugins: AntigravityListedPlugin[]; unrecognized: number } {
  const lines = stripAnsi(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every((line) => EMPTY.test(line))) return { empty: true, plugins: [], unrecognized: 0 };
  const plugins: AntigravityListedPlugin[] = [];
  let unrecognized = 0;
  for (const line of lines) {
    if (HEADER.test(line) || EMPTY.test(line)) continue;
    const match = ROW.exec(line);
    const name = match?.[1];
    if (!name || nativePluginRefError(name)) {
      unrecognized += 1;
      continue;
    }
    const state = match[2]?.toLowerCase();
    const enabled = state === "disabled" ? false : state === "enabled" ? true : "unknown";
    if (plugins.length < MAX_PLUGINS && !plugins.some((plugin) => plugin.name === name)) plugins.push({ name, enabled });
  }
  return { empty: false, plugins, unrecognized };
}

const pluginDto = (harnessId: string, plugin: AntigravityListedPlugin, readOnly: boolean): NativePluginDto => {
  const at = plugin.name.indexOf("@", 1);
  return {
    harnessId,
    id: plugin.name,
    name: at > 0 ? plugin.name.slice(0, at) : plugin.name,
    source: at > 0 ? { kind: "marketplace", ref: plugin.name.slice(at + 1) } : { kind: "unknown" },
    scope: "user",
    enabled: plugin.enabled,
    evidence: { stage: "discovered", source: LIST_SOURCE },
    ...(readOnly ? { readOnly: true, note: UNRECOGNIZED_NOTE }
      : { note: "New Antigravity sessions load it through the linked Gemini home; its contents are not inspected." }),
  };
};

const refused = (code: string, message: string): MutationOutcome<{ pendingRestart: boolean; message?: string }> =>
  ({ kind: "rejected", code, message });
/** A failure before the mutating command started (binary lookup, pre-read). */
const notStarted = (error: { code?: unknown; message?: unknown }) =>
  refused(typeof error?.code === "string" && error.code ? error.code : "native-command-failed",
    typeof error?.message === "string" && error.message ? error.message : "Antigravity is not available.");

export function createAntigravityNativePlugins(options: AntigravityNativePluginsOptions): HarnessNativePluginManager {
  const { harnessId } = options;
  const read = async (context: HarnessContext, signal?: AbortSignal) => {
    const { command, env } = await options.resolveBinary();
    const { stdout } = await readNativePluginCli({
      command,
      args: ["plugin", "list"],
      env: { ...env, NO_COLOR: "1" },
      cwd: context.cwd,
      ...(signal ? { signal } : {}),
    });
    return parseAgyPluginList(stdout);
  };
  return {
    support,
    async list(context, listOptions): Promise<NativePluginListDto> {
      if (context.remote) {
        return { harnessId, support: support(context), plugins: [], warnings: ["Antigravity plugins are only read on this host."], checkedAt: Date.now() };
      }
      const listed = await read(context, listOptions?.signal);
      const partial = listed.unrecognized > 0;
      const warnings = listed.empty ? [] : [PARSE_WARNING, ...(partial ? [UNRECOGNIZED_WARNING] : [])];
      return {
        harnessId,
        support: support(context),
        plugins: listed.plugins.map((plugin) => pluginDto(harnessId, plugin, partial)),
        ...(warnings.length ? { warnings } : {}),
        checkedAt: Date.now(),
      };
    },
    async mutate(context, input, mutation) {
      if (context.remote) return refused("unsupported", "Antigravity plugins are only managed on this host.");
      if (!ACTIONS.includes(input.action)) return refused("unsupported", `Antigravity plugins cannot be ${input.action}d.`);
      if (input.scope !== undefined && input.scope !== "user") {
        return refused("invalid-input", "Antigravity plugins live in the harness home only.");
      }
      const ref = typeof input.plugin === "string" ? input.plugin : "";
      const invalid = nativePluginRefError(ref);
      if (invalid) return refused("invalid-input", invalid);
      if (input.action === "uninstall") {
        // agy would report success and rewrite its manifest for a missing name,
        // so only a name in a fresh, fully recognized list is uninstalled. A
        // failed pre-read has started nothing, so it is a refusal too.
        const listed = await read(context, mutation.signal).catch(notStarted);
        if ("kind" in listed) return listed;
        if (listed.unrecognized > 0) {
          return refused("unsupported", "agy's plugin list could not be fully read, so Polyth does not remove plugins from it; use `agy plugin uninstall` in a terminal.");
        }
        if (!listed.plugins.some((plugin) => plugin.name === ref)) return refused("not-found", `${ref} is not installed in Antigravity.`);
      }
      const binary = await options.resolveBinary().catch(notStarted);
      if ("kind" in binary) return binary;
      const { command, env } = binary;
      const outcome = await runNativePluginCli({
        command,
        args: ["plugin", input.action, ref],
        env: { ...env, NO_COLOR: "1" },
        cwd: context.cwd,
        operationId: mutation.operationId,
        ...(mutation.signal ? { signal: mutation.signal } : {}),
      });
      if (outcome.kind !== "confirmed") return outcome;
      const last = stripAnsi(outcome.value.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
      return { kind: "confirmed", value: { pendingRestart: false, ...(last ? { message: last.slice(0, 500) } : {}) } };
    },
  };
}

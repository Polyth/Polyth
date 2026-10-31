// OpenCode's own plugins: the `plugin` array of the user's global OpenCode
// config. This reuses the exact applier behind the legacy
// `/api/plugins/opencode` route, so a change is staged behind the same
// pending-restart queue and reaches OpenCode only with the next runtime
// generation. Polyth never installs the npm package itself; OpenCode resolves
// each spec when it starts.
import { isDeepStrictEqual } from "node:util";
import type { HarnessContext, JsonObject, MutationOutcome, OpenCodePluginConfigEntry } from "@polyth/contracts";
import type {
  HarnessNativePluginManager,
  NativePluginDto,
  NativePluginListDto,
  NativePluginSourceKind,
  NativePluginSupportDto,
} from "@polyth/contracts/capability-installations";
import { nativePluginRefError } from "@polyth/harness-runtime/native-plugins";
import type { BackendConfigApplier } from "./config.ts";

export type OpenCodePluginConfig = Pick<BackendConfigApplier, "listPlugins" | "applyPlugins" | "removePlugin">;

const LIST_SOURCE = "opencode config plugin";
const MAX_OPTIONS_BYTES = 16 * 1024;
const MAX_OPTIONS_DEPTH = 32;

const support = (context: HarnessContext): NativePluginSupportDto => ({
  actions: context.remote ? [] : ["install", "uninstall"],
  installScopes: context.remote ? [] : ["user"],
  installHint: "npm-package[@version] or file:///absolute/path",
  applies: "runtime-restart",
  marketplaces: false,
  ...(context.remote ? {} : { installOptions: true }),
});

const specOf = (entry: OpenCodePluginConfigEntry): string => typeof entry === "string" ? entry : entry[0];

const sourceKind = (spec: string): NativePluginSourceKind => {
  if (spec.startsWith("file:")) return "local";
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:)/i.test(spec)) return "git";
  if (/^https?:\/\//i.test(spec)) return "url";
  return "npm";
};

/** `@scope/name@1.2.3` → name `@scope/name`, version `1.2.3`. */
const npmNameVersion = (spec: string): { name: string; version?: string } => {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  if (at <= 0) return { name: spec };
  const version = spec.slice(at + 1);
  return version ? { name: spec.slice(0, at), version } : { name: spec.slice(0, at) };
};

const displayName = (spec: string, kind: NativePluginSourceKind): string => {
  if (kind === "npm") return npmNameVersion(spec).name;
  const tail = spec.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
  return tail || spec;
};

export const openCodePluginDto = (harnessId: string, entry: OpenCodePluginConfigEntry): NativePluginDto => {
  const spec = specOf(entry);
  const kind = sourceKind(spec);
  const version = kind === "npm" ? npmNameVersion(spec).version : undefined;
  return {
    harnessId,
    id: spec,
    name: displayName(spec, kind),
    ...(version ? { version } : {}),
    source: { kind, ref: spec },
    scope: "user",
    // OpenCode has no per-plugin switch: an entry in the array is loaded.
    enabled: true,
    components: [{
      kind: "native-code",
      count: 1,
      effect: "active",
      reason: "OpenCode loads the plugin module in every runtime it starts",
    }],
    evidence: { stage: "discovered", source: LIST_SOURCE },
    // Options can hold credentials, so only their presence is reported.
    ...(typeof entry === "string" ? {} : { note: "Has plugin options in the OpenCode config (not shown)." }),
  };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isJson = (value: unknown, depth: number): boolean => {
  if (depth > MAX_OPTIONS_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  return isPlainObject(value) && Object.values(value).every((item) => isJson(item, depth + 1));
};

/** Plugin options as a bounded plain JSON object. Messages never quote them:
 * options may hold credentials. */
const pluginOptions = (value: unknown): JsonObject | string => {
  if (!isPlainObject(value) || !isJson(value, 0)) return "Plugin options must be a JSON object.";
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_OPTIONS_BYTES) return "Plugin options must be at most 16 KB of JSON.";
  return value as JsonObject;
};

const refused = (code: string, message: string): MutationOutcome<{ pendingRestart: boolean; message?: string }> =>
  ({ kind: "rejected", code, message });

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code ? code : undefined;
};
const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "OpenCode config could not be changed.";

export function createOpenCodeNativePlugins(options: {
  harnessId: string;
  config: OpenCodePluginConfig;
}): HarnessNativePluginManager {
  const { harnessId, config } = options;
  return {
    support,
    async list(context): Promise<NativePluginListDto> {
      if (context.remote) {
        return {
          harnessId,
          support: support(context),
          plugins: [],
          warnings: ["Plugins of a remote OpenCode host are not read here; only this server's OpenCode config is managed."],
          checkedAt: Date.now(),
        };
      }
      const entries = await config.listPlugins();
      return {
        harnessId,
        support: support(context),
        plugins: entries.map((entry) => openCodePluginDto(harnessId, entry)),
        checkedAt: Date.now(),
      };
    },
    async mutate(context, input) {
      if (context.remote) return refused("unsupported", "Only this server's OpenCode config is managed.");
      if (input.action !== "install" && input.action !== "uninstall") {
        return refused("unsupported", `OpenCode plugins cannot be ${input.action}d; add or remove the entry instead.`);
      }
      if (input.scope !== undefined && input.scope !== "user") {
        return refused("invalid-input", "OpenCode plugins are only managed in the user's global config.");
      }
      const spec = typeof input.plugin === "string" ? input.plugin.trim() : "";
      const invalid = nativePluginRefError(spec);
      if (invalid) return refused("invalid-input", invalid);
      let options: JsonObject | undefined;
      if (input.options !== undefined) {
        if (input.action !== "install") return refused("invalid-input", "Plugin options are only accepted when installing.");
        const checked = pluginOptions(input.options);
        if (typeof checked === "string") return refused("invalid-input", checked);
        options = checked;
      }
      try {
        if (input.action === "install") {
          const existing = (await config.listPlugins()).find((entry) => specOf(entry) === spec);
          // Without options, an existing entry (and any options it has) stays as
          // it is; the same options would only re-stage the same list.
          if (existing !== undefined && (options === undefined || isDeepStrictEqual(typeof existing === "string" ? undefined : existing[1], options))) {
            return { kind: "confirmed", value: { pendingRestart: false, message: `${spec} is already in the OpenCode config; nothing changed.` } };
          }
          // The applier replaces an entry with the same spec, so new options take effect.
          await config.applyPlugins([options === undefined ? spec : [spec, options]]);
          return {
            kind: "confirmed",
            value: {
              pendingRestart: true,
              message: existing === undefined
                ? `${spec} is staged for the next OpenCode runtime.`
                : `New options for ${spec} are staged for the next OpenCode runtime.`,
            },
          };
        }
        const result = await config.removePlugin(spec);
        if (!result.removed) return refused("not-found", `${spec} is not in the OpenCode config.`);
        return { kind: "confirmed", value: { pendingRestart: true, message: `${spec} is staged for removal with the next OpenCode runtime.` } };
      } catch (error) {
        // The applier stages in memory or writes through an atomic rename, so a
        // thrown error means the plugin list did not change.
        return refused(errorCode(error) ?? "config-write-failed", errorMessage(error));
      }
    },
  };
}

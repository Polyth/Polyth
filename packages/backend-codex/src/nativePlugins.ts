// Codex's own plugin system, through the App Server plugin RPC (codex 0.160:
// `plugin/installed`, `plugin/read`, `plugin/list`, `plugin/install`,
// `plugin/uninstall`). The App Server has no enable/disable or update method,
// so those actions are not offered. Each call uses one short-lived App Server
// bound to the account's `CODEX_HOME`; it is always closed.
import type { HarnessContext, MutationOutcome } from "@polyth/contracts";
import type {
    HarnessNativePluginManager,
    NativePluginAction,
    NativePluginComponentDto,
    NativePluginDto,
    NativePluginListDto,
    NativePluginMarketplaceDto,
    NativePluginSupportDto,
} from "@polyth/contracts/capability-installations";
import type { RpcPeer } from "@polyth/harness-runtime";
import { nativePluginRefError } from "@polyth/harness-runtime/native-plugins";

export type CodexPluginRpc = Pick<RpcPeer, "request"> & { close(): Promise<void> };

export interface CodexNativePluginsOptions {
    harnessId: string;
    /** An initialized App Server for this account; the caller closes it. */
    connect(context: HarnessContext): Promise<CodexPluginRpc>;
}

type PluginSource =
    | { type: "local"; path?: string }
    | { type: "git"; url?: string }
    | { type: "npm"; package?: string; version?: string | null }
    | { type: "remote" };

interface PluginSummary {
    id?: string;
    name?: string;
    version?: string | null;
    localVersion?: string | null;
    source?: PluginSource;
    installed?: boolean;
    enabled?: boolean;
    installPolicy?: string;
    installPolicySource?: string | null;
    availability?: string;
    interface?: { displayName?: string | null } | null;
}

interface MarketplaceEntry {
    name?: string;
    path?: string | null;
    plugins?: PluginSummary[];
}

interface PluginDetail {
    skills?: Array<{ name?: string }>;
    hooks?: Array<{ eventName?: string }>;
    apps?: Array<{ name?: string }>;
    mcpServers?: string[];
}

const ACTIONS: NativePluginAction[] = ["install", "uninstall"];
const LIST_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 180_000;
const UNINSTALL_TIMEOUT_MS = 60_000;
const MAX_PLUGINS = 200;
const MAX_DETAIL_READS = 40;
const MAX_NAMES = 50;
const MESSAGE_LIMIT = 500;
const LIST_SOURCE = "codex app-server plugin/installed";

const support = (context: HarnessContext): NativePluginSupportDto => ({
    actions: context.remote ? [] : [...ACTIONS],
    installScopes: context.remote ? [] : ["user"],
    installHint: "plugin@marketplace",
    applies: "next-session",
    marketplaces: true,
});

const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
const clip = (message: string) => message.length > MESSAGE_LIMIT ? `${message.slice(0, MESSAGE_LIMIT - 1)}…` : message;
const errorCode = (error: unknown) => (error as { code?: unknown } | undefined)?.code;
const names = (list: Array<string | undefined>) => list.filter((name): name is string => Boolean(name)).slice(0, MAX_NAMES);

/** Splits `plugin@marketplace` on its last `@`. */
const splitRef = (ref: string): { name: string; marketplace: string } | undefined => {
    const at = ref.lastIndexOf("@");
    if (at <= 0 || at === ref.length - 1) return undefined;
    return { name: ref.slice(0, at), marketplace: ref.slice(at + 1) };
};

const sourceFor = (summary: PluginSummary, marketplace: string | undefined): NativePluginDto["source"] => {
    const source = summary.source;
    if (source?.type === "git") return { kind: "git", ...(text(source.url) ? { ref: text(source.url) } : {}) };
    if (source?.type === "npm") {
        const pkg = text(source.package);
        return { kind: "npm", ...(pkg ? { ref: source.version ? `${pkg}@${source.version}` : pkg } : {}) };
    }
    if (source?.type === "local" || source?.type === "remote") return { kind: "marketplace", ...(marketplace ? { ref: marketplace } : {}) };
    return { kind: "unknown" };
};

export function codexPluginComponents(detail: PluginDetail): NativePluginComponentDto[] {
    const components: NativePluginComponentDto[] = [];
    const skills = Array.isArray(detail.skills) ? detail.skills : [];
    if (skills.length) components.push({
        kind: "skill",
        count: skills.length,
        names: names(skills.map((skill) => text(skill?.name))),
        effect: "active",
        reason: "Polyth starts Codex threads without a plugin skill filter",
    });
    const mcpServers = Array.isArray(detail.mcpServers) ? detail.mcpServers : [];
    if (mcpServers.length) components.push({
        kind: "mcp-server",
        count: mcpServers.length,
        names: names(mcpServers.map(text)),
        effect: "active",
        reason: "Polyth adds its own MCP servers without replacing the account's plugin servers",
    });
    const hooks = Array.isArray(detail.hooks) ? detail.hooks : [];
    if (hooks.length) components.push({
        kind: "hook",
        count: hooks.length,
        names: names([...new Set(hooks.map((hook) => text(hook?.eventName)))]),
        effect: "unknown",
        reason: "Not verified whether Codex runs plugin hooks in App Server threads",
    });
    const apps = Array.isArray(detail.apps) ? detail.apps : [];
    if (apps.length) components.push({
        kind: "tool",
        count: apps.length,
        names: names(apps.map((app) => text(app?.name))),
        effect: "unknown",
        reason: "Connector apps depend on the Codex account's own authorization",
    });
    return components;
}

export function codexPluginFromSummary(
    harnessId: string,
    summary: PluginSummary,
    marketplace: string | undefined,
    components?: NativePluginComponentDto[],
): NativePluginDto | undefined {
    const id = text(summary.id);
    if (!id) return undefined;
    const name = text(summary.interface?.displayName) ?? text(summary.name) ?? id;
    const version = text(summary.localVersion) ?? text(summary.version);
    // Only a workspace setting is an administrator's choice; Codex also
    // installs some canonical apps by default (`IMPLICIT_CANONICAL_APP`).
    const managed = summary.installPolicySource === "WORKSPACE_SETTING";
    const byDefault = summary.installPolicy === "INSTALLED_BY_DEFAULT";
    const blocked = summary.availability === "DISABLED_BY_ADMIN";
    return {
        harnessId,
        id,
        name,
        ...(version ? { version } : {}),
        source: sourceFor(summary, marketplace),
        scope: managed ? "managed" : "user",
        enabled: typeof summary.enabled === "boolean" ? summary.enabled : "unknown",
        ...(components ? { components } : {}),
        evidence: { stage: "discovered", source: LIST_SOURCE },
        ...(managed ? { readOnly: true } : {}),
        ...(blocked ? { note: "Disabled by the workspace administrator" }
            : managed ? { note: "Installed by workspace policy" }
            : byDefault ? { note: "Installed by default by Codex" }
            : {}),
    };
}

export function createCodexNativePlugins(options: CodexNativePluginsOptions): HarnessNativePluginManager {
    const { harnessId } = options;
    return {
        support,
        async list(context): Promise<NativePluginListDto> {
            if (context.remote) {
                return { harnessId, support: support(context), plugins: [], warnings: ["Codex plugins are only read on this host"], checkedAt: Date.now() };
            }
            const rpc = await options.connect(context);
            try {
                const installed = await rpc.request<{ marketplaces?: MarketplaceEntry[]; marketplaceLoadErrors?: Array<{ message?: string }> }>(
                    "plugin/installed", { cwds: [context.cwd] }, LIST_TIMEOUT_MS);
                const warnings: string[] = [];
                const marketplaces: NativePluginMarketplaceDto[] = [];
                const rows: Array<{ summary: PluginSummary; marketplace?: string; marketplacePath?: string }> = [];
                for (const entry of Array.isArray(installed.marketplaces) ? installed.marketplaces : []) {
                    const marketplace = text(entry?.name);
                    if (!marketplace) continue;
                    marketplaces.push({ name: marketplace, source: entry.path ? "local" : "remote" });
                    for (const summary of Array.isArray(entry.plugins) ? entry.plugins : []) {
                        if (summary?.installed === false) continue;
                        rows.push({ summary, marketplace, ...(text(entry.path) ? { marketplacePath: text(entry.path) } : {}) });
                    }
                }
                for (const failure of (installed.marketplaceLoadErrors ?? []).slice(0, 5)) {
                    const message = text(failure?.message);
                    if (message) warnings.push(clip(`A Codex marketplace could not be loaded: ${message}`));
                }
                if (rows.length > MAX_PLUGINS) warnings.push(`Showing the first ${MAX_PLUGINS} of ${rows.length} plugins`);
                const plugins: NativePluginDto[] = [];
                let detailReads = 0;
                for (const row of rows.slice(0, MAX_PLUGINS)) {
                    let components: NativePluginComponentDto[] | undefined;
                    // Only plugins from a local marketplace file are read: a
                    // remote catalog read may reach the network per plugin.
                    const pluginName = text(row.summary.name);
                    if (row.marketplacePath && pluginName && detailReads < MAX_DETAIL_READS) {
                        detailReads += 1;
                        components = await rpc.request<{ plugin?: PluginDetail }>("plugin/read", { marketplacePath: row.marketplacePath, pluginName }, READ_TIMEOUT_MS)
                            .then((result) => result.plugin ? codexPluginComponents(result.plugin) : undefined, () => undefined);
                    }
                    const plugin = codexPluginFromSummary(harnessId, row.summary, row.marketplace, components);
                    if (plugin) plugins.push(plugin);
                }
                return {
                    harnessId,
                    support: support(context),
                    plugins,
                    marketplaces,
                    ...(warnings.length ? { warnings } : {}),
                    checkedAt: Date.now(),
                };
            }
            finally {
                await rpc.close().catch(() => {});
            }
        },
        async mutate(context, input, mutationOptions): Promise<MutationOutcome<{ pendingRestart: boolean; message?: string }>> {
            if (context.remote) return { kind: "rejected", code: "unsupported", message: "Codex plugins are only managed on this host" };
            if (!ACTIONS.includes(input.action)) return { kind: "rejected", code: "unsupported", message: `Codex cannot ${String(input.action)} plugins through its App Server` };
            const refError = nativePluginRefError(input.plugin);
            if (refError) return { kind: "rejected", code: "invalid-input", message: refError };
            if (input.scope && input.scope !== "user") return { kind: "rejected", code: "invalid-input", message: "Codex installs plugins only for the account" };
            const ref = splitRef(input.plugin);
            if (!ref) return { kind: "rejected", code: "invalid-input", message: "Use plugin@marketplace" };
            if (mutationOptions.signal?.aborted) return { kind: "rejected", code: "cancelled", message: "Cancelled before the change started" };
            let rpc: CodexPluginRpc;
            try {
                rpc = await options.connect(context);
            }
            catch (error) {
                // Nothing was sent: the App Server never accepted a request.
                const code = errorCode(error) === "not-installed" ? "not-installed" : "native-command-failed";
                return { kind: "rejected", code, message: clip((error as Error).message || "Codex App Server did not start") };
            }
            try {
                let params: Record<string, unknown>;
                let method: string;
                let timeoutMs: number;
                if (input.action === "install") {
                    // A read that resolves where the marketplace lives; a failure
                    // here happens before any change is requested.
                    let catalog: { marketplaces?: MarketplaceEntry[] };
                    try {
                        catalog = await rpc.request<{ marketplaces?: MarketplaceEntry[] }>("plugin/list", { cwds: [context.cwd] }, LIST_TIMEOUT_MS);
                    }
                    catch (error) {
                        return { kind: "rejected", code: "native-command-failed", message: clip(`Codex marketplaces could not be read: ${(error as Error).message}`) };
                    }
                    const marketplace = (catalog.marketplaces ?? []).find((entry) => entry?.name === ref.marketplace);
                    if (!marketplace) return { kind: "rejected", code: "not-found", message: `Codex has no marketplace named ${ref.marketplace}` };
                    method = "plugin/install";
                    params = {
                        ...(text(marketplace.path) ? { marketplacePath: text(marketplace.path) } : { remoteMarketplaceName: ref.marketplace }),
                        pluginName: ref.name,
                        installAttemptId: mutationOptions.operationId,
                    };
                    timeoutMs = INSTALL_TIMEOUT_MS;
                }
                else {
                    method = "plugin/uninstall";
                    params = { pluginId: input.plugin };
                    timeoutMs = UNINSTALL_TIMEOUT_MS;
                }
                let result: { appsNeedingAuth?: Array<{ name?: string }> } | undefined;
                try {
                    result = await rpc.request(method, params, timeoutMs);
                }
                catch (error) {
                    const message = clip((error as Error).message || "Codex did not answer");
                    // A JSON-RPC error is the App Server's refusal; a lost or late
                    // response leaves the change unconfirmed.
                    if (errorCode(error) === "runtime-rejected") return { kind: "rejected", code: "native-command-failed", message };
                    return { kind: "unknown", operationId: mutationOptions.operationId, message };
                }
                const needingAuth = names((result?.appsNeedingAuth ?? []).map((app) => text(app?.name)));
                return {
                    kind: "confirmed",
                    value: {
                        pendingRestart: false,
                        message: needingAuth.length
                            ? `Applies to new Codex sessions. Authorize these apps in Codex: ${needingAuth.join(", ")}`
                            : "Applies to new Codex sessions",
                    },
                };
            }
            finally {
                await rpc.close().catch(() => {});
            }
        },
    };
}

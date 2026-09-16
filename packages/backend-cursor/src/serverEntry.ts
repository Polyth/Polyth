import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerAcpProfile } from "@polyth/backend-acp";
import { discoverHarnessExecutable, harnessExecutableChildEnv } from "@polyth/backend-acp/executable-discovery";
import type { RegisteredAcpProfile } from "@polyth/backend-acp/profile";
import type { ServerPackageHost } from "@polyth/plugins";
import { createCursorClientTranslator } from "./todos.ts";
import { cursorModelDiscoverySupport } from "./version.ts";
const exec = promisify(execFile);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const cursorModels = (result: unknown) => {
    const rows = asRecord(result)?.models;
    if (!Array.isArray(rows)) return undefined;
    return rows.flatMap((value) => {
        const row = asRecord(value);
        const modelID = typeof row?.value === "string" && row.value.trim() ? row.value : undefined;
        if (!row || !modelID) return [];
        const configs = Array.isArray(row.configOptions) ? row.configOptions : [];
        const thought = configs.map(asRecord).find((option) => option?.category === "thought_level");
        const variants = (Array.isArray(thought?.options) ? thought.options : []).flatMap((value) => {
            const option = asRecord(value);
            return typeof option?.value === "string" && option.value !== "auto" && option.value !== "default"
                ? [option.value]
                : [];
        });
        return [{
            providerID: "cursor",
            modelID,
            name: typeof row.name === "string" && row.name.trim() ? row.name : modelID,
            connected: true,
            ...(variants.length ? { variants } : {}),
        }];
    });
};

const methodMissing = (error: unknown) =>
    (error as { rpcCode?: number }).rpcCode === -32601
    || /method not found/i.test((error as { message?: string }).message ?? "");

const windowsShim = (command: string) => process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
const resolveCursorBinary = async () => {
    const configured = process.env.POLYTH_CURSOR_BIN?.trim();
    for (const binary of configured ? [configured] : ["agent", "cursor-agent"]) {
        const report = await discoverHarnessExecutable(binary);
        if (!report.hit) continue;
        const command = report.hit.executablePath;
        const env = await harnessExecutableChildEnv(command);
        try {
            const version = (await exec(command, ["--version"], { timeout: 5000, maxBuffer: 4096, env, shell: windowsShim(command) })).stdout.trim();
            if (!configured && binary === "agent"
                && !/cursor-agent/i.test(command)
                && !/^\d{4}\.\d{2}\.\d{2}(?:-|$)/.test(version)) continue;
            process.env.PATH = env.PATH;
            return { command, version };
        } catch { /* try the next candidate */ }
    }
    throw Object.assign(new Error("Cursor Agent CLI was not found"), { code: "not-installed" });
};

// Cursor blocks session/prompt until these extension requests receive valid
// nested outcomes. Decline unsupported UI explicitly instead of stranding the turn.
export const cursorClientRequest = (method: string) => {
    if (method === "cursor/ask_question") {
        return {
            handled: true,
            result: {
                outcome: {
                    outcome: "skipped",
                    reason: "Interactive Cursor questions are not exposed by Polyth",
                },
            },
        } as const;
    }
    if (method === "cursor/create_plan") {
        return {
            handled: true,
            result: { outcome: { outcome: "cancelled" } },
        } as const;
    }
    return { handled: false } as const;
};

export default function registerPackage(host: ServerPackageHost) {
    const profile: RegisteredAcpProfile = {
        descriptor: {
            id: "cursor",
            name: "Cursor",
            integration: "ACP v1",
            autoSelect: false,
            priority: 30,
            setupUrl: "https://cursor.com/docs/cli/acp",
            // The agent publishes `cursor_login` as its ACP auth method; the
            // CLI runs that flow.
            signInCommand: "agent login",
        },
        // `agent acp` has no --model flag (verified: it is accepted and
        // ignored). Model selection goes through the ACP session API only.
        command: process.env.POLYTH_CURSOR_BIN?.trim() || "agent", args: ["acp"],
        initializeClientMeta: { parameterizedModelPicker: true },
        clientRequest: cursorClientRequest,
        createClientTranslator: createCursorClientTranslator,
        async discoverModels(connection) {
            try {
                return cursorModels(await connection.rpc.request("cursor/list_available_models", {}, 10_000));
            } catch (error) {
                if (methodMissing(error)) return undefined;
                throw error;
            }
        },
        // Older Cursor builds that lack the direct catalog extension fall back
        // to session metadata. Do not mutate every model row during discovery.
        probeModelControls: false,
        supportsModelDiscovery: cursorModelDiscoverySupport,
        async probe(context) {
            if (context.remote)
                return { harnessId: "cursor", installed: false, authenticated: "unknown", healthy: false, message: "Local execution only" };
            try {
                const { command, version } = await resolveCursorBinary();
                profile.command = command;
                // Installation alone is not proof of authentication. The profile is
                // offered for explicit selection but excluded from automatic routing
                // until a native auth/status contract is verified.
                return { harnessId: "cursor", installed: true, authenticated: "unknown", healthy: true, version, message: "Native sign-in status is not available" };
            }
            catch {
                return { harnessId: "cursor", installed: false, authenticated: "unknown", healthy: false };
            }
        },
    };
    return registerAcpProfile(host, profile);
}
export { cursorModelDiscoverySupport };

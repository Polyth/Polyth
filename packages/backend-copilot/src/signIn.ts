// Whether a Copilot login can start a session.
//
// The CLI has no sign-in report command, and its token lives in the system
// keychain (or, without one, in a file Polyth must not read). What it does
// answer without running a model turn is ACP `session/new`: a signed-out CLI
// refuses it with `-32000 Authentication required` (verified against
// 1.0.109), and any login it accepts creates a session. The check runs in a
// directory of its own, so that session never appears among a project's.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessContext } from "@polyth/contracts";
import { connectAcp, type AcpProfile } from "@polyth/backend-acp";
import type { HarnessAccountStatus } from "@polyth/harness-runtime/accounts";

/** Tokens the CLI takes from its environment, in its order of precedence. */
export const COPILOT_TOKEN_ENV = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/**
 * Sign-in that is visible in the launch environment itself: a GitHub token,
 * or a model provider of the person's own, which needs no GitHub login.
 */
export function environmentSignIn(env: NodeJS.ProcessEnv): HarnessAccountStatus | undefined {
    if (env.COPILOT_PROVIDER_BASE_URL?.trim() || env.COPILOT_PROVIDERS_CONFIG?.trim()) return { loggedIn: true, plan: "Own model provider" };
    if (COPILOT_TOKEN_ENV.some((name) => env[name]?.trim())) return { loggedIn: true, plan: "Access token" };
    return undefined;
}

const SESSION_NEW_TIMEOUT_MS = 30_000;

/** What a `session/new` answer proves about the login. */
export function signInFromSessionNew(outcome: { ok: true } | { ok: false; rpcCode?: number; message?: string }): HarnessAccountStatus {
    if (outcome.ok) return { loggedIn: true };
    return outcome.rpcCode === -32000 && /authenticat|log ?in|sign ?in/i.test(outcome.message ?? "")
        ? { loggedIn: false }
        : { loggedIn: "unknown" };
}

export async function readCopilotSignIn(profile: Pick<AcpProfile, "command" | "args" | "env" | "descriptor" | "probe">): Promise<HarnessAccountStatus> {
    const fromEnvironment = environmentSignIn(profile.env ?? process.env);
    if (fromEnvironment) return fromEnvironment;
    const cwd = join(tmpdir(), "polyth-copilot-sign-in-check");
    await mkdir(cwd, { recursive: true });
    let connection: Awaited<ReturnType<typeof connectAcp>>;
    try {
        connection = await connectAcp(profile as AcpProfile, { spaceId: "", projectId: "", cwd } as HarnessContext);
    } catch {
        return { loggedIn: "unknown" };
    }
    try {
        const created = await connection.rpc.request<{ sessionId?: string }>("session/new", { cwd, mcpServers: [] }, SESSION_NEW_TIMEOUT_MS);
        if (typeof created?.sessionId === "string" && created.sessionId) {
            await connection.rpc.request("session/close", { sessionId: created.sessionId }, 5_000).catch(() => {});
        }
        return signInFromSessionNew({ ok: true });
    } catch (error) {
        const failure = error as { rpcCode?: number; remoteMessage?: string };
        return signInFromSessionNew({
            ok: false,
            ...(typeof failure.rpcCode === "number" ? { rpcCode: failure.rpcCode } : {}),
            ...(failure.remoteMessage ? { message: failure.remoteMessage } : {}),
        });
    } finally {
        await connection.rpc.close().catch(() => {});
    }
}

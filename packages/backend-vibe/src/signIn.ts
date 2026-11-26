// Whether a Vibe login has an API key.
//
// Vibe keeps the key in `$VIBE_HOME/.env` (written by `vibe --setup` or its
// Mistral AI Studio browser sign-in), possibly in the system keyring, or
// takes it from the launch environment. Polyth reads none of those stores.
// What answers without a model request is ACP `session/new`: with no key for
// the active model's provider Vibe refuses it with `-32000 Missing API key for
// <provider> provider.`, and with one it opens a session without contacting
// the provider (verified against 3.1.5; such a session writes nothing to
// disk). Whether the key is valid is proven by the first turn.
import { mkdir } from "node:fs/promises";
import type { HarnessContext } from "@polyth/contracts";
import { connectAcp, type AcpProfile } from "@polyth/backend-acp";
import type { HarnessAccountStatus } from "@polyth/harness-runtime/accounts";
import { vibeCheckDir } from "./nativeSessions.ts";

const SESSION_NEW_TIMEOUT_MS = 30_000;

/** What a `session/new` answer proves about the login. */
export function signInFromSessionNew(outcome: { ok: true } | { ok: false; rpcCode?: number; message?: string }): HarnessAccountStatus {
    if (outcome.ok) return { loggedIn: true, plan: "API key" };
    return outcome.rpcCode === -32000 && /api key|authenticat|sign ?in|log ?in/i.test(outcome.message ?? "")
        ? { loggedIn: false }
        : { loggedIn: "unknown" };
}

export async function readVibeSignIn(profile: Pick<AcpProfile, "command" | "args" | "env" | "descriptor" | "probe">): Promise<HarnessAccountStatus> {
    const cwd = vibeCheckDir();
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

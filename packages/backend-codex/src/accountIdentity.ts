// Who a Codex login is signed in as. `codex login status` only says "Logged
// in using ChatGPT", which reads the same for every account, so the accounts
// list takes the email and ChatGPT plan from the ID token Codex keeps in
// `CODEX_HOME/auth.json`, as the ChatGPT apps show them. Display only: the
// token is decoded, never verified or sent anywhere, and nothing but these
// two claims leaves this module.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface CodexAccountIdentity {
    email?: string;
    /** ChatGPT plan type, for example `plus`, `pro` or `team`. */
    plan?: string;
}

/** `auth.json` is a few kilobytes; anything far larger is not Codex's file. */
const MAX_AUTH_BYTES = 256 * 1024;
const AUTH_CLAIMS = "https://api.openai.com/auth";
const PROFILE_CLAIMS = "https://api.openai.com/profile";
const EMAIL = /^[^\s@\u0000-\u001f\u007f]{1,64}@[^\s@\u0000-\u001f\u007f]{1,253}$/;
const PLAN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The claims of a JWT, or undefined when it is not one. */
const jwtClaims = (token: unknown): Record<string, unknown> | undefined => {
    if (typeof token !== "string") return undefined;
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    try {
        return record(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
    } catch {
        return undefined;
    }
};

/** The email and plan in the text of one `auth.json`; empty when it holds
 *  no ChatGPT sign-in (an API key, a malformed file). */
export function codexIdentityFromAuth(text: string): CodexAccountIdentity {
    let file: Record<string, unknown> | undefined;
    try {
        file = record(JSON.parse(text));
    } catch {
        return {};
    }
    const claims = jwtClaims(record(file?.tokens)?.id_token);
    if (!claims) return {};
    const email = [claims.email, record(claims[PROFILE_CLAIMS])?.email].find((value): value is string => typeof value === "string" && EMAIL.test(value));
    const plan = record(claims[AUTH_CLAIMS])?.chatgpt_plan_type;
    return {
        ...(email ? { email } : {}),
        ...(typeof plan === "string" && PLAN.test(plan) ? { plan } : {}),
    };
}

/** The identity of the login in `codexHome`; empty when there is none to read
 *  (no file, credentials kept in the OS keyring, an unreadable file). */
export async function readCodexAccountIdentity(codexHome: string): Promise<CodexAccountIdentity> {
    const file = join(codexHome, "auth.json");
    try {
        // A regular file only: opening a FIFO would hang the accounts list.
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_AUTH_BYTES) return {};
        return codexIdentityFromAuth(await readFile(file, "utf8"));
    } catch {
        return {};
    }
}

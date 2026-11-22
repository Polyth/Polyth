// Cursor's sign-in as Polyth reports it. `agent status --format json` is the
// CLI's own report, but it says `isAuthenticated: true` whenever tokens are
// on disk, also after Cursor's server stopped accepting them; it then omits
// `userInfo` ("Logged in (unable to fetch user details)"). The stored
// session's end (`exp` of the refresh token in `cursor/auth.json`) settles
// that case: a session past its end needs a new `agent login`. Only that one
// claim is decoded; no token leaves this module.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface CursorAuthReport {
    loggedIn: boolean | "unknown";
    email?: string;
    /** When the stored session ends (epoch ms); signed-in reports only. */
    expiresAt?: number;
    /** Why the report is "unknown" or signed out, for the probe message. */
    reason?: string;
}

const EARLIEST = Date.UTC(2020, 0, 1);
const LATEST_AHEAD_MS = 5 * 366 * 24 * 60 * 60 * 1000;

const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** `exp` of a JWT as epoch ms, or undefined when it is not a readable JWT. */
export const jwtExpiry = (token: unknown, now: number = Date.now()): number | undefined => {
    if (typeof token !== "string") return undefined;
    const payload = token.split(".")[1];
    if (!payload || token.split(".").length !== 3) return undefined;
    try {
        const exp = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))?.exp;
        const at = typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : Number.NaN;
        return Number.isFinite(at) && at >= EARLIEST && at <= now + LATEST_AHEAD_MS ? Math.round(at) : undefined;
    } catch {
        return undefined;
    }
};

/** When the session stored under `<configRoot>/cursor/auth.json` ends. A
 *  missing or unreadable file (another platform's keychain, an older CLI)
 *  says nothing. */
export async function readCursorSessionEnd(configRoot: string, now: number = Date.now()): Promise<number | undefined> {
    try {
        const stored = record(JSON.parse(await readFile(join(configRoot, "cursor", "auth.json"), "utf8")));
        return jwtExpiry(stored?.refreshToken, now);
    } catch {
        return undefined;
    }
}

/** One printed status report and the stored session's end. */
export const parseCursorAuthReport = (stdout: string, sessionEnd: number | undefined, now: number = Date.now()): CursorAuthReport => {
    let report: Record<string, unknown> | undefined;
    try {
        report = record(JSON.parse(stdout));
    } catch {
        return { loggedIn: "unknown", reason: "Cursor printed an unreadable sign-in report" };
    }
    if (typeof report?.isAuthenticated !== "boolean") return { loggedIn: "unknown", reason: "Cursor gave no sign-in report" };
    if (!report.isAuthenticated) return { loggedIn: false, reason: "Not signed in to Cursor" };
    if (sessionEnd !== undefined && sessionEnd <= now) return { loggedIn: false, reason: "The Cursor sign-in has ended; sign in again" };
    const email = record(report.userInfo)?.email;
    // Tokens on disk that Cursor would not confirm: not proof either way.
    if (!record(report.userInfo)) return { loggedIn: "unknown", reason: "Cursor could not confirm the sign-in" };
    return {
        loggedIn: true,
        ...(typeof email === "string" && email ? { email } : {}),
        ...(sessionEnd !== undefined ? { expiresAt: sessionEnd } : {}),
    };
};

/** Run the report once. A signed-out CLI may exit non-zero and still print
 *  its JSON report, which is used as is. */
export async function readCursorAuthReport(
    run: () => Promise<{ stdout: string }>,
    configRoot: string,
    now: () => number = Date.now,
): Promise<CursorAuthReport> {
    const [stdout, sessionEnd] = await Promise.all([
        run().then(({ stdout }) => stdout, (error: { stdout?: unknown }) => typeof error?.stdout === "string" ? error.stdout : ""),
        readCursorSessionEnd(configRoot, now()),
    ]);
    // The CLI did not answer, but a session past its end is still ended.
    if (!stdout.trim() && sessionEnd !== undefined && sessionEnd <= now())
        return { loggedIn: false, reason: "The Cursor sign-in has ended; sign in again" };
    return parseCursorAuthReport(stdout, sessionEnd, now());
}

// `claude auth status --json` is the CLI's own local sign-in report; it never
// runs a model turn. The probe, discovery and the account list all read it
// here, so they agree on what counts as signed in, signed out or unanswered.
// A report that never arrived (timeout, launch failure, unreadable output) is
// "unknown", not signed out: only the CLI saying `loggedIn: false` is.

export interface ClaudeAuthReport {
    loggedIn: boolean | "unknown";
    email?: string;
    plan?: string;
    /** When the stored claude.ai sign-in ends (epoch ms), from the report's
     *  `loginExpiresAt` (Claude Code 2.1.318 and later). Signed-in reports only. */
    expiresAt?: number;
    /** Why the report is "unknown", bounded, for logs and the probe message. */
    reason?: string;
}

/** Earliest and latest sign-in end worth showing; anything else is a malformed value. */
const EARLIEST_EXPIRY = Date.UTC(2020, 0, 1);
const LATEST_EXPIRY_AHEAD_MS = 5 * 366 * 24 * 60 * 60 * 1000;
const REASON_MAX = 160;

/** `loginExpiresAt` as epoch ms. The CLI prints an ISO-8601 string; an epoch
 *  in seconds or milliseconds is accepted too. */
export const parseLoginExpiresAt = (value: unknown, now: number = Date.now()): number | undefined => {
    const at = typeof value === "string" && value.trim()
        ? Date.parse(value)
        : typeof value === "number" && Number.isFinite(value)
            ? (value < 1e12 ? value * 1000 : value)
            : Number.NaN;
    return Number.isFinite(at) && at >= EARLIEST_EXPIRY && at <= now + LATEST_EXPIRY_AHEAD_MS ? Math.round(at) : undefined;
};

const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/** One printed report; `undefined` when it is not the CLI's JSON report. */
export const parseClaudeAuthReport = (stdout: string, now: number = Date.now()): ClaudeAuthReport | undefined => {
    let report: unknown;
    try {
        report = JSON.parse(stdout);
    } catch {
        return undefined;
    }
    if (!report || typeof report !== "object" || typeof (report as { loggedIn?: unknown }).loggedIn !== "boolean") return undefined;
    const { loggedIn, email, subscriptionType, loginExpiresAt } = report as Record<string, unknown>;
    if (loggedIn !== true) return { loggedIn: false };
    const expiresAt = parseLoginExpiresAt(loginExpiresAt, now);
    return {
        loggedIn: true,
        ...(text(email) ? { email: text(email) } : {}),
        ...(text(subscriptionType) ? { plan: text(subscriptionType) } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
};

const firstLine = (value: unknown): string => typeof value === "string" ? value.trim().split(/\r?\n/)[0] ?? "" : "";

/** Why a run produced no report, without the output itself. */
const failureReason = (error: unknown): string => {
    const failure = error as { killed?: unknown; signal?: unknown; code?: unknown; stderr?: unknown; message?: unknown } | undefined;
    if (failure?.killed === true || failure?.code === "ETIMEDOUT") return "the CLI did not answer in time";
    if (typeof failure?.code === "string") return `the CLI could not start (${failure.code})`;
    const detail = firstLine(failure?.stderr) || firstLine(failure?.message);
    return (detail || "the CLI gave no report").slice(0, REASON_MAX);
};

/** Run the report once. A signed-out CLI exits non-zero but still prints its
 *  JSON report, which is used as is. */
export async function readClaudeAuthReport(run: () => Promise<{ stdout: string }>, now: () => number = Date.now): Promise<ClaudeAuthReport> {
    try {
        const { stdout } = await run();
        return parseClaudeAuthReport(stdout, now()) ?? { loggedIn: "unknown", reason: "the CLI printed an unreadable report" };
    } catch (error) {
        const stdout = (error as { stdout?: unknown } | undefined)?.stdout;
        const printed = typeof stdout === "string" ? parseClaudeAuthReport(stdout, now()) : undefined;
        return printed ?? { loggedIn: "unknown", reason: failureReason(error) };
    }
}

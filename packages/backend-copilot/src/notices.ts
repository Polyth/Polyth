// Lines Copilot CLI writes into the answer stream itself.
//
// In ACP mode the CLI reports its own status and failures as ordinary
// `agent_message_chunk` updates and then ends the prompt with `end_turn`
// (verified against 1.0.109: a provider 401 arrives as
// `Error: Authentication failed with provider … (HTTP 401).`, a retry as
// `Info: Request failed due to a transient API error. Retrying...`, a
// cancellation as `Info: Operation cancelled by user`). Model text always
// carries a `messageId`; these lines never do. The structured error type is
// only in the CLI's session log, so the classification reads the text.
import type { AcpAgentNotice } from "@polyth/backend-acp";

const PROVIDER = "github-copilot";
const MAX_REASON = 400;

const AUTH = /authenticat|unauthori[sz]ed|not (?:logged|signed) in|log ?in|sign ?in|\b40[13]\b|forbidden|token (?:is )?(?:expired|invalid)|copilot (?:subscription|access)|policy/i;
const QUOTA = /quota|premium requests?|ai credits?|usage limit|monthly limit|allowance|\b402\b|billing/i;
const RATE = /rate[_\s-]?limit|too many requests|\b429\b/i;
const OVERLOADED = /overloaded|capacity|server is busy|\b(?:503|529)\b/i;
const MODEL = /model .{0,80}(?:not (?:available|supported|found|enabled)|unavailable|does not exist|is disabled)|unknown model|choose a concrete model/i;
const CONTEXT = /context (?:window|length)|prompt is too long|maximum context|too many tokens/i;

const clip = (text: string): string => text.length > MAX_REASON ? `${text.slice(0, MAX_REASON)}…` : text;

/** The failure a CLI `Error:` line reports, in Polyth's vocabulary. */
export function classifyCopilotFailure(reason: string): Extract<AcpAgentNotice, { kind: "error" }> {
    const text = clip(reason.replace(/\s+/g, " ").trim());
    // Quota before rate: Copilot words an exhausted allowance as a limit too.
    if (QUOTA.test(text)) {
        return { kind: "error", code: "quota-exhausted", message: `GitHub Copilot allowance is used up: ${text}`, retry: { scope: "quota", provider: PROVIDER, retryable: false } };
    }
    if (RATE.test(text)) {
        return { kind: "error", code: "rate-limited", message: `GitHub Copilot rate limit: ${text}`, retry: { scope: "rate", provider: PROVIDER, retryable: true } };
    }
    if (OVERLOADED.test(text)) {
        return { kind: "error", code: "overloaded", message: `GitHub Copilot is overloaded: ${text}`, retry: { scope: "overloaded", provider: PROVIDER, retryable: true } };
    }
    if (CONTEXT.test(text)) {
        return { kind: "error", code: "context-full", message: `GitHub Copilot: ${text}` };
    }
    if (MODEL.test(text)) {
        return { kind: "error", code: "model-unavailable", message: `GitHub Copilot cannot use this model: ${text}` };
    }
    if (AUTH.test(text)) {
        return { kind: "error", code: "auth-expired", message: `GitHub Copilot sign-in was refused: ${text}` };
    }
    return { kind: "error", message: `GitHub Copilot turn failed: ${text}` };
}

/** Classify one `agent_message_chunk`; `undefined` is model text. */
export function copilotAgentNotice(update: Record<string, unknown>): AcpAgentNotice | undefined {
    if (typeof update.messageId === "string" && update.messageId) return undefined;
    const content = update.content as { type?: unknown; text?: unknown } | undefined;
    if (content?.type !== "text" || typeof content.text !== "string") return undefined;
    const error = /^Error:\s*([\s\S]+)$/.exec(content.text);
    if (error) return classifyCopilotFailure(error[1]!);
    return /^Info:\s/.test(content.text) ? { kind: "drop" } : undefined;
}

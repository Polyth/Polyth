// What a failed `session/prompt` from `vibe-acp` proves.
//
// Vibe answers a failed prompt with a JSON-RPC error, never with a message
// chunk (verified against 3.1.5 with a local OpenAI-compatible server):
//
// - `-32000 Missing API key for <provider> provider.` before any request;
// - `-31002` for configuration and credential errors (`Invalid API key (from
//   env var …)`, and once a key was refused, `The <provider> credential was
//   rejected …` for every later prompt of that process);
// - `-31001 Rate limit exceeded for <provider> (model: …)` after Vibe's own
//   retries (about five minutes of `_session/retrying` notifications);
// - `-31004` context too long, `-31005` refusal, `-31006` compaction failure;
// - `-32603` with the HTTP client's text for anything else, e.g.
//   `Client error '404 Not Found' for url '…': <provider body>` or, after
//   retries, `Server error '500 Internal Server Error' …`.
import type { AcpPromptError, AcpPromptFailure } from "@polyth/backend-acp";

const PROVIDER = "mistral";
const MAX_REASON = 400;

const KEY = /api key|credential|unauthori[sz]ed|\b401\b|\b403\b|forbidden/i;
const MODEL = /\b404\b|invalid model|unknown model|model .*(?:not found|not available|does not exist)|not allowed to use|requires a .* plan/i;
const QUOTA = /\b402\b|payment required|insufficient (?:balance|funds|credit|quota)|quota (?:exceeded|exhausted)|out of credit|billing/i;
const RATE = /rate.?limit|too many requests|\b429\b/i;
const OVERLOADED = /overloaded|server error|\b5\d\d\b|service unavailable|capacity/i;

const clip = (text: string): string => text.length > MAX_REASON ? `${text.slice(0, MAX_REASON)}…` : text;
/** The HTTP client appends a link to a generic status page; it says nothing. */
const reasonOf = (message: string): string =>
    clip(message.replace(/\s*For more information check: \S+/i, "").replace(/\s+/g, " ").trim());

export function classifyVibePromptFailure(error: AcpPromptError): AcpPromptFailure | undefined {
    const reason = reasonOf(error.message);
    if (!reason) return undefined;
    switch (error.rpcCode) {
        case -32000:
            return {
                admitted: false,
                code: "auth-expired",
                message: `Mistral Vibe has no API key. Sign in to Mistral Vibe to save one, or set MISTRAL_API_KEY for the Polyth server. (${reason})`,
            };
        case -31001:
            return {
                admitted: true,
                code: "rate-limited",
                message: `Mistral rate limit: ${reason}`,
                retry: { scope: "rate", provider: PROVIDER, retryable: true },
            };
        case -31002:
            return KEY.test(reason)
                ? { admitted: false, code: "auth-expired", message: `Mistral Vibe cannot use its API key: ${reason}` }
                : { admitted: false, code: "unsupported", message: `Mistral Vibe configuration error: ${reason}` };
        case -31004:
            return { admitted: true, code: "context-full", message: `The conversation no longer fits the model's context: ${reason}` };
        case -31005:
            return { admitted: true, code: "unknown", message: `The model refused the request: ${reason}` };
        case -31006:
            return { admitted: true, code: "context-full", message: `Mistral Vibe could not compact the conversation: ${reason}` };
        case -32603:
            if (QUOTA.test(reason)) {
                return { admitted: true, code: "quota-exhausted", message: `Mistral quota or billing limit: ${reason}`, retry: { scope: "quota", provider: PROVIDER, retryable: false } };
            }
            if (RATE.test(reason)) {
                return { admitted: true, code: "rate-limited", message: `Mistral rate limit: ${reason}`, retry: { scope: "rate", provider: PROVIDER, retryable: true } };
            }
            if (MODEL.test(reason)) {
                return { admitted: true, code: "model-unavailable", message: `Mistral cannot use this model: ${reason}` };
            }
            if (KEY.test(reason)) {
                return { admitted: true, code: "auth-expired", message: `Mistral rejected the API key: ${reason}` };
            }
            if (OVERLOADED.test(reason)) {
                return { admitted: true, code: "overloaded", message: `Mistral is unavailable: ${reason}`, retry: { scope: "overloaded", provider: PROVIDER, retryable: true } };
            }
            return { admitted: true, code: "unknown", message: `Mistral Vibe turn failed: ${reason}` };
        default:
            return undefined;
    }
}

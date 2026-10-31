// What a failed `session/prompt` from `dsh --profile acp` proves.
//
// dsh answers every failed prompt with JSON-RPC `-32603` and a message of the
// form `Internal error: turn failed: <reason>` once the prompt was queued and
// its turn ran (verified against dsh 0.2.0-rc.2: missing key, HTTP 401, 402
// and 429 from the Messages endpoint). The reason is the provider's own text
// or the harness's credential error; the stable `LlmError` code is not on the
// wire, so the classification reads the text, conservatively.
import type { AcpMcpServer, AcpPromptError, AcpPromptFailure } from "@polyth/backend-acp";

const PROVIDER = "deepseek";
const MAX_REASON = 400;

const MISSING_KEY = /no api key|missing[_\s-]?credential|invalid[_\s-]?credential|DEEPSEEK_API_KEY/i;
const AUTH = /authentication fails|invalid api key|unauthori[sz]ed|\b40[13]\b|forbidden|account[_\s-]?sign[_\s-]?in[_\s-]?required|sign[\s-]?in required/i;
const MODEL = /model (?:not exist|does not exist|not found|is not available)|unknown model|unsupported[_\s-]?reasoning[_\s-]?effort/i;
const RATE = /rate[_\s-]?limit|too many requests|\b429\b/i;
const OVERLOADED = /server overloaded|overloaded|server is busy|\b(?:503|529)\b/i;
const QUOTA = /insufficient (?:balance|funds|quota)|\b402\b|quota[_\s-]?(?:exceeded|exhausted)|out of credit/i;

const clip = (text: string): string => text.length > MAX_REASON ? `${text.slice(0, MAX_REASON)}…` : text;

export function classifyDshPromptFailure(error: AcpPromptError): AcpPromptFailure | undefined {
    const raw = error.message.trim();
    if (!raw) return undefined;
    const withoutPrefix = raw.replace(/^internal error:\s*/i, "");
    const ran = /^turn failed:\s*/i.exec(withoutPrefix);
    const reason = clip((ran ? withoutPrefix.slice(ran[0].length) : withoutPrefix).trim() || withoutPrefix);
    const admitted = Boolean(ran);
    if (MISSING_KEY.test(reason)) {
        return {
            admitted,
            code: "auth-expired",
            message: `DeepSeek has no API key. Sign in to DeepSeek to save one, or set DEEPSEEK_API_KEY for the Polyth server. (${reason})`,
        };
    }
    if (AUTH.test(reason)) {
        return { admitted, code: "auth-expired", message: `DeepSeek rejected the API key: ${reason}` };
    }
    if (MODEL.test(reason)) {
        return { admitted, code: "model-unavailable", message: `DeepSeek cannot use this model: ${reason}` };
    }
    if (RATE.test(reason)) {
        return {
            admitted,
            code: "rate-limited",
            message: `DeepSeek rate limit: ${reason}`,
            retry: { scope: "rate", provider: PROVIDER, retryable: true },
        };
    }
    if (OVERLOADED.test(reason)) {
        return {
            admitted,
            code: "overloaded",
            message: `DeepSeek is overloaded: ${reason}`,
            retry: { scope: "overloaded", provider: PROVIDER, retryable: true },
        };
    }
    if (QUOTA.test(reason)) {
        return {
            admitted,
            code: "quota-exhausted",
            message: `DeepSeek account balance is exhausted: ${reason}`,
            retry: { scope: "quota", provider: PROVIDER, retryable: false },
        };
    }
    return { admitted, message: admitted ? `DeepSeek turn failed: ${reason}` : `DeepSeek Harness refused the prompt: ${reason}` };
}

/**
 * The MCP server a refused `session/new` / `session/resume` names. dsh
 * reports an invalid declaration by position (`Invalid params:
 * mcpServers[1].command must be an absolute path`) and a server it could not
 * connect to by name in the error data (`mcp-client(<name>): initial
 * connection or tool synchronization failed`), both verified on 0.2.0-rc.2.
 */
export function dshFailedMcpServer(error: AcpPromptError & { data?: unknown }, servers: readonly AcpMcpServer[]): number | undefined {
    let data = "";
    try {
        data = JSON.stringify(error.data ?? "");
    } catch { /* unserializable data names nothing */ }
    const text = `${error.message} ${data}`;
    const position = /mcpServers\[(\d+)\]/.exec(text);
    if (position) {
        const index = Number(position[1]);
        return index < servers.length ? index : undefined;
    }
    const name = /mcp-client\(([^)]+)\)/.exec(text)?.[1];
    if (!name) return undefined;
    const index = servers.findIndex((server) => server.name === name);
    return index >= 0 ? index : undefined;
}

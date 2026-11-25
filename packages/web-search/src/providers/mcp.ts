import type { Resolver } from "@polyth/outbound";
import { webSearchError } from "../errors.ts";
import { providerHttpRequest, type ProviderHttpTransport } from "../http.ts";

/**
 * One stateless `tools/call` against a hosted search MCP endpoint that accepts
 * requests without a key. Both services answer a single POST, as plain JSON or
 * as a one-message event stream, so no session is opened.
 */
export interface KeylessMcpToolCall {
  endpoint: string;
  /** Display name used in error messages. */
  provider: string;
  tool: string;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
}

export interface KeylessMcpOptions {
  resolve?: Resolver;
  transport?: ProviderHttpTransport;
}

const SNIPPET_LIMIT = 600;
const RATE_LIMIT_RE = /rate.?limit|too many requests|\b429\b|quota/i;

export const mcpObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Joins a provider's excerpt strings into one bounded snippet. */
export function mcpExcerpt(parts: unknown): string {
  const text = (Array.isArray(parts) ? parts : [parts])
    .filter((part): part is string => typeof part === "string")
    .join(" … ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= SNIPPET_LIMIT ? text : `${text.slice(0, SNIPPET_LIMIT - 1).trimEnd()}…`;
}

/** The `data:` payload of every event in a server-sent event stream. */
const eventStreamData = (body: string): string[] =>
  body.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    return data.length > 0 ? [data.join("\n")] : [];
  });

const rpcResponse = (body: string): Record<string, unknown> | null => {
  const candidates = body.trimStart().startsWith("{") ? [body] : eventStreamData(body);
  for (const candidate of candidates.toReversed()) {
    try {
      const message = mcpObject(JSON.parse(candidate));
      if (message && ("result" in message || "error" in message)) return message;
    } catch {
      // Not the response message; keep looking.
    }
  }
  return null;
};

const firstText = (content: unknown): string | null => {
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    const text = mcpObject(item)?.text;
    if (typeof text === "string") return text;
  }
  return null;
};

/** Returns the tool's JSON payload, or throws a web-search error the fallback chain understands. */
export async function callKeylessMcpTool(call: KeylessMcpToolCall, options: KeylessMcpOptions = {}): Promise<unknown> {
  const response = await providerHttpRequest(call.endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "user-agent": "Polyth/0.1 WebSearch",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: call.tool, arguments: call.arguments },
    }),
    signal: call.signal,
    timeoutMs: call.timeoutMs,
    maxBytes: call.maxBytes,
  }, options);
  if (response.status === 429) throw webSearchError("rate-limited", `${call.provider} free rate limit reached`);
  if (response.status < 200 || response.status >= 300) {
    throw webSearchError("provider-unavailable", `${call.provider} search failed (${response.status})`);
  }

  const message = rpcResponse(response.body.toString("utf8"));
  if (!message) throw webSearchError("provider-invalid-response", `${call.provider} returned an unreadable response`);
  const failure = mcpObject(message.error);
  if (failure) {
    throw RATE_LIMIT_RE.test(String(failure.message ?? ""))
      ? webSearchError("rate-limited", `${call.provider} free rate limit reached`)
      : webSearchError("provider-unavailable", `${call.provider} search failed`);
  }
  const result = mcpObject(message.result);
  if (!result) throw webSearchError("provider-invalid-response", `${call.provider} returned an unreadable response`);
  const text = firstText(result.content);
  if (result.isError === true) {
    throw RATE_LIMIT_RE.test(text ?? "")
      ? webSearchError("rate-limited", `${call.provider} free rate limit reached`)
      : webSearchError("provider-unavailable", `${call.provider} search failed`);
  }

  const structured = mcpObject(result.structuredContent);
  if (structured) return structured;
  try {
    return JSON.parse(text ?? "");
  } catch {
    throw webSearchError("provider-invalid-response", `${call.provider} returned an unreadable response`);
  }
}

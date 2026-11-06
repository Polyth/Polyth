// One provider HTTP request that transcribes a finished recording. Failures
// become dictation error codes so failover and the client treat them the same
// way as live-stream failures. Works in Node and browsers (fetch is global).
import { DictationError } from "./providers.ts";

const statusFailure = (provider: string, status: number, retryAfter: string | null): DictationError => {
  const message = `${provider} returned HTTP ${status}`;
  if (status === 401 || status === 403) return new DictationError("invalid_credentials", message);
  if (status === 429) {
    const seconds = Number(retryAfter);
    return new DictationError("rate_limited", message, Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: seconds * 1000 } : {});
  }
  if (status === 413 || status === 415) return new DictationError("audio_format_error", message);
  return new DictationError("provider_unavailable", message);
};

/** POST a recording and return the response body text. */
export async function postRecording(
  provider: string,
  fetchFn: typeof fetch,
  url: string,
  init: { headers?: Record<string, string>; body: BodyInit; signal?: AbortSignal },
): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(url, { method: "POST", ...init });
  } catch (error) {
    // A deadline or cancel carries its own reason; anything else is the network.
    if (init.signal?.aborted) throw init.signal.reason ?? error;
    throw new DictationError(
      "network_error",
      `${provider} request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const raw = await response.text();
  if (!response.ok) throw statusFailure(provider, response.status, response.headers.get("retry-after"));
  return raw;
}

/** A WAV file body for fetch/FormData. */
export const wavBlob = (wav: Uint8Array): Blob =>
  new Blob([wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer], { type: "audio/wav" });

/** Parse a JSON response or fail with a protocol error naming the provider. */
export function recordingJson<T>(provider: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new DictationError("protocol_error", `${provider} returned a response that is not JSON`, { cause: error });
  }
}

/** ISO-639-1 base of a BCP-47 tag, or undefined for "auto". */
export const recordingLanguage = (language?: string): string | undefined => {
  const base = language?.trim().toLowerCase().split(/[-_]/, 1)[0];
  return base && base !== "auto" && /^[a-z]{2,3}$/.test(base) ? base : undefined;
};

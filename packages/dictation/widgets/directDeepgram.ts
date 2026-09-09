import {
  DictationError,
  normalizeDictationContext,
  type DictationContext,
} from "@polyth/dictation";
import { startPcm16Capture, type Pcm16Capture, type Pcm16CaptureOptions } from "./audioCapture.ts";
import type { StreamingDictation } from "./dictationClient.ts";

const PROVIDER_URL = "wss://api.deepgram.com/v1/listen";
const SAMPLE_RATE = 16_000;
const MAX_REPLAY_BYTES = 5 * 1024 * 1024;
const MAX_SOCKET_BUFFER = 2 * 1024 * 1024;
const FINAL_TIMEOUT_MS = 10_000;
const OPEN = 1;

interface BrowserSocketLike {
  readyState: number;
  bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface DirectDeepgramOptions {
  model?: string;
  language?: string;
  context?: DictationContext;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
  fetchFn?: typeof fetch;
  socketFactory?: (url: string, protocols: string[]) => BrowserSocketLike;
  captureFactory?: (options: Pcm16CaptureOptions) => Promise<Pcm16Capture>;
}

interface DeepgramResult {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
  description?: string;
  message?: string;
}

const merge = (current: string, next: string): string => {
  const part = next.trim();
  if (!part) return current;
  return current ? `${current.replace(/\s+$/, "")} ${part}` : part;
};

const languageParam = (language?: string): string => {
  const value = language?.trim();
  if (!value || value.toLowerCase() === "auto") return "multi";
  if (/^uk(?:[-_]ua)?$/i.test(value)) return "uk";
  return value;
};

const keyterms = (input?: DictationContext): string[] => {
  const context = normalizeDictationContext(input ?? { language: "auto" });
  const source = [
    ...(context.keywords ?? []),
    ...(context.technicalVocabulary ?? []),
    ...Object.keys(context.glossary ?? {}),
    ...Object.values(context.glossary ?? {}),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of source) {
    const value = raw.trim().replace(/\s+/g, " ").slice(0, 80);
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 100) break;
  }
  return out;
};

async function mintToken(fetchFn: typeof fetch): Promise<string> {
  const response = await fetchFn("/api/dictation/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "deepgram" }),
  });
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("polyth:auth-required"));
    }
    const body = await response.json().catch(() => ({})) as { error?: unknown; message?: unknown };
    const code = typeof body.error === "string" ? body.error : "provider_unavailable";
    throw new DictationError(
      code === "invalid_credentials" ? "invalid_credentials"
        : code === "rate_limited" ? "rate_limited"
          : "provider_unavailable",
      typeof body.message === "string" ? body.message : `Could not mint Deepgram temporary token (HTTP ${response.status})`,
    );
  }
  const data = await response.json() as { token?: unknown };
  if (typeof data.token !== "string" || !data.token) {
    throw new DictationError("protocol_error", "Deepgram token response did not contain a token");
  }
  return data.token;
}

export async function startDirectDeepgramDictation(options: DirectDeepgramOptions): Promise<StreamingDictation> {
  const fetchFn = options.fetchFn ?? fetch;
  const socketFactory = options.socketFactory ?? ((url, protocols) => new WebSocket(url, protocols));
  const captureFactory = options.captureFactory ?? startPcm16Capture;
  const context = normalizeDictationContext(options.context ?? { language: options.language || "auto" });
  const url = new URL(PROVIDER_URL);
  url.searchParams.set("model", options.model?.trim() || "nova-3");
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", String(SAMPLE_RATE));
  url.searchParams.set("channels", "1");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("endpointing", "300");
  url.searchParams.set("language", languageParam(options.language || context.language));
  for (const term of keyterms(context)) url.searchParams.append("keyterm", term);

  let socket: BrowserSocketLike | null = null;
  let capture: Pcm16Capture | null = null;
  let active = true;
  let stopping = false;
  let failed: Error | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectFlight: Promise<void> | null = null;
  let generation = 0;
  let committed = "";
  let interim = "";
  let replayBytes = 0;
  let sendTail = Promise.resolve();
  const replay: Uint8Array[] = [];
  let finalResolve: ((text: string) => void) | null = null;
  let finalReject: ((error: Error) => void) | null = null;

  const currentText = (): string => merge(committed, interim);

  const fail = (error: unknown): void => {
    if (failed) return;
    failed = error instanceof Error ? error : new Error(String(error));
    options.onError?.(failed.message);
    void capture?.pause().catch(() => {});
    finalReject?.(failed);
    finalReject = null;
    finalResolve = null;
  };

  const waitForBackpressure = async (ws: BrowserSocketLike): Promise<void> => {
    while (active && ws.readyState === OPEN && ws.bufferedAmount > 512 * 1024) {
      if (ws.bufferedAmount > MAX_SOCKET_BUFFER) {
        throw new DictationError("backpressure_overflow", "Deepgram browser socket buffer overflowed");
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };

  const send = async (ws: BrowserSocketLike, data: string | Uint8Array): Promise<void> => {
    await waitForBackpressure(ws);
    if (!active || ws.readyState !== OPEN) {
      throw new DictationError("network_error", "Deepgram browser connection is not open");
    }
    ws.send(data);
  };

  const replayAll = async (ws: BrowserSocketLike): Promise<void> => {
    for (const pcm of replay) await send(ws, pcm);
  };

  async function connect(withReplay: boolean): Promise<void> {
    if (connectFlight) return connectFlight;
    const currentGeneration = ++generation;
    connectFlight = (async () => {
      const token = await mintToken(fetchFn);
      if (!active) return;
      // Deepgram documents temporary JWTs as Bearer auth. Browsers cannot set
      // Authorization on WebSocket handshakes, so the supported client-side
      // equivalent is Sec-WebSocket-Protocol: bearer, <JWT>.
      const ws = socketFactory(url.toString(), ["bearer", token]);
      socket = ws;
      committed = "";
      interim = "";
      options.onPartial?.("");

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (error?: Error): void => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve();
        };
        ws.onopen = () => settle();
        ws.onmessage = (event) => {
          let message: DeepgramResult;
          try { message = JSON.parse(String(event.data)) as DeepgramResult; } catch { return; }
          if (message.type === "Results") {
            const text = message.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
            if (message.is_final) {
              committed = merge(committed, text);
              interim = "";
              options.onPartial?.(committed);
              if (stopping && finalResolve) {
                const done = finalResolve;
                finalResolve = null;
                finalReject = null;
                done(committed);
              }
            } else {
              interim = text;
              options.onPartial?.(currentText());
            }
            return;
          }
          if (message.type === "Error") {
            const error = new DictationError("provider_unavailable", message.description || message.message || "Deepgram transcription failed");
            settle(error);
            fail(error);
          }
        };
        ws.onerror = () => settle(new DictationError("network_error", "Deepgram direct connection failed"));
        ws.onclose = (event) => {
          if (socket === ws) socket = null;
          if (!settled) {
            settle(new DictationError(
              event.code === 1008 ? "invalid_credentials" : "network_error",
              event.reason || `Deepgram direct connection closed (${event.code})`,
            ));
          }
          if (currentGeneration === generation && active && !stopping && !failed && !reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              if (!active || stopping || failed) return;
              void capture?.pause().catch(() => {});
              void connect(true).then(() => capture?.resume()).catch(fail);
            }, 400);
          }
        };
      });

      if (socket !== ws || ws.readyState !== OPEN) {
        throw new DictationError("network_error", "Deepgram direct session did not stay open");
      }
      if (withReplay) await replayAll(ws);
    })().finally(() => {
      connectFlight = null;
    });
    return connectFlight;
  }

  const initialConnect = connect(false);

  const enqueue = (pcm: Uint8Array): void => {
    const copy = pcm.slice();
    replay.push(copy);
    replayBytes += copy.byteLength;
    if (replayBytes > MAX_REPLAY_BYTES) {
      fail(new DictationError("backpressure_overflow", "Direct Deepgram dictation exceeded the reconnect replay budget"));
      return;
    }
    sendTail = sendTail.then(async () => {
      await initialConnect;
      const ws = socket;
      if (!ws || ws.readyState !== OPEN) return;
      await send(ws, copy);
    }).catch((error) => {
      if (!(error instanceof DictationError) || error.code !== "network_error") fail(error);
    });
  };

  try {
    capture = await captureFactory({
      targetSampleRate: SAMPLE_RATE,
      chunkMs: 40,
      onChunk(pcm) {
        if (!active || stopping || failed) return;
        enqueue(pcm);
      },
      onEnded() {
        fail(new DictationError("mic_denied", "Microphone became unavailable during dictation"));
      },
    });
    await initialConnect;
  } catch (error) {
    active = false;
    capture?.stop();
    capture = null;
    socket?.close(1000, "dictation setup failed");
    throw error;
  }

  const onVisibility = (): void => {
    if (!active || !capture) return;
    if (document.visibilityState === "hidden") void capture.pause().catch(() => {});
    else void capture.resume().catch(fail);
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  const teardown = (): void => {
    if (!active) return;
    active = false;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    capture?.stop();
    capture = null;
    socket?.close(1000, "dictation complete");
    socket = null;
    replay.length = 0;
    replayBytes = 0;
  };

  return {
    async stop() {
      if (failed) {
        const error = failed;
        teardown();
        throw error;
      }
      stopping = true;
      capture?.stop();
      capture = null;
      await initialConnect;
      await sendTail;
      if (failed) {
        const error = failed;
        teardown();
        throw error;
      }
      if (replay.length === 0) {
        teardown();
        return "";
      }
      if (!socket || socket.readyState !== OPEN) await connect(true);
      const ws = socket;
      if (!ws) throw new DictationError("network_error", "Deepgram direct connection is unavailable");
      const final = new Promise<string>((resolve, reject) => {
        finalResolve = resolve;
        finalReject = reject;
      });
      await send(ws, JSON.stringify({ type: "Finalize" }));
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new DictationError("network_error", "Timed out waiting for Deepgram final transcript")),
          FINAL_TIMEOUT_MS,
        );
      });
      try {
        return await Promise.race([final, timeout]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (ws.readyState === OPEN) {
          try { ws.send(JSON.stringify({ type: "CloseStream" })); } catch { /* best effort */ }
        }
        teardown();
      }
    },
    cancel() {
      stopping = true;
      teardown();
    },
  };
}

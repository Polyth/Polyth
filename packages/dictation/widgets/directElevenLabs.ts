import { DictationError, type DictationContext } from "@polyth/dictation";
import { startPcm16Capture, type Pcm16Capture, type Pcm16CaptureOptions } from "./audioCapture.ts";
import type { StreamingDictation } from "./dictationClient.ts";

const PROVIDER_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const MAX_REPLAY_BYTES = 5 * 1024 * 1024;
const MAX_SOCKET_BUFFER = 2 * 1024 * 1024;
const FINAL_TIMEOUT_MS = 12_000;
const OPEN = 1;

interface BrowserSocketLike {
  readyState: number;
  bufferedAmount: number;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface DirectElevenLabsOptions {
  model?: string;
  language?: string;
  context?: DictationContext;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
  /** Deterministic test seams; production callers never set these. */
  fetchFn?: typeof fetch;
  socketFactory?: (url: string) => BrowserSocketLike;
  captureFactory?: (options: Pcm16CaptureOptions) => Promise<Pcm16Capture>;
}

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
};

const merge = (current: string, next: string): string => {
  const text = next.trim();
  if (!text) return current;
  return current ? `${current.replace(/\s+$/, "")} ${text}` : text;
};

const keyterms = (context?: DictationContext): string[] => {
  if (!context) return [];
  const values = [
    ...(context.keywords ?? []),
    ...Object.keys(context.glossary ?? {}),
    ...Object.values(context.glossary ?? {}),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    // Scribe Realtime accepts at most 50 keyterms, each at most 20 chars.
    const value = raw.replace(/[<>{}\[\]\\]/g, "").trim().replace(/\s+/g, " ").slice(0, 20);
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 50) break;
  }
  return out;
};

async function mintToken(fetchFn: typeof fetch): Promise<string> {
  const response = await fetchFn("/api/dictation/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "elevenlabs" }),
  });
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("polyth:auth-required"));
    }
    const body = await response.json().catch(() => ({})) as { error?: unknown; message?: unknown };
    const code = typeof body.error === "string"
      ? body.error
      : response.status === 429 ? "rate_limited"
        : response.status === 401 || response.status === 403 ? "invalid_credentials"
          : "provider_unavailable";
    throw Object.assign(
      new DictationError(
        code === "rate_limited" ? "rate_limited"
          : code === "invalid_credentials" ? "invalid_credentials"
            : "provider_unavailable",
        typeof body.message === "string" ? body.message : `Could not mint ElevenLabs dictation token (HTTP ${response.status})`,
      ),
      { status: response.status },
    );
  }
  const data = await response.json() as { token?: unknown };
  if (typeof data.token !== "string" || !data.token) {
    throw new DictationError("protocol_error", "ElevenLabs token response did not contain a token");
  }
  return data.token;
}

export async function startDirectElevenLabsDictation(options: DirectElevenLabsOptions): Promise<StreamingDictation> {
  const fetchFn = options.fetchFn ?? fetch;
  const socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
  const captureFactory = options.captureFactory ?? startPcm16Capture;
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
  let finalResolve: ((text: string) => void) | null = null;
  let finalReject: ((error: Error) => void) | null = null;
  const chunks: Uint8Array[] = [];
  let replayBytes = 0;
  let sendTail = Promise.resolve();

  const fail = (error: unknown): void => {
    if (failed) return;
    failed = error instanceof Error ? error : new Error(String(error));
    options.onError?.(failed.message);
    void capture?.pause().catch(() => {});
    finalReject?.(failed);
    finalReject = null;
    finalResolve = null;
  };

  const sendJson = async (ws: BrowserSocketLike, value: unknown): Promise<void> => {
    while (active && ws.readyState === OPEN && ws.bufferedAmount > 512 * 1024) {
      if (ws.bufferedAmount > MAX_SOCKET_BUFFER) {
        throw new DictationError("backpressure_overflow", "ElevenLabs browser socket buffer overflowed");
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    if (!active || ws.readyState !== OPEN) {
      throw new DictationError("network_error", "ElevenLabs browser connection is not open");
    }
    ws.send(JSON.stringify(value));
  };

  const replay = async (ws: BrowserSocketLike): Promise<void> => {
    for (const chunk of chunks) {
      await sendJson(ws, {
        message_type: "input_audio_chunk",
        audio_base_64: base64(chunk),
      });
    }
  };

  async function connect(withReplay: boolean): Promise<void> {
    if (connectFlight) return connectFlight;
    const currentGeneration = ++generation;
    connectFlight = (async () => {
      const token = await mintToken(fetchFn);
      if (!active) return;
      const url = new URL(PROVIDER_URL);
      url.searchParams.set("model_id", options.model?.trim() || "scribe_v2_realtime");
      url.searchParams.set("token", token);
      url.searchParams.set("audio_format", "pcm_16000");
      url.searchParams.set("commit_strategy", "manual");
      const language = options.language?.trim();
      if (language && language !== "auto") url.searchParams.set("language_code", language.split("-")[0]!.toLowerCase());
      for (const term of keyterms(options.context)) url.searchParams.append("keyterms", term);

      const ws = socketFactory(url.toString());
      socket = ws;
      committed = "";
      interim = "";
      options.onPartial?.("");

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve();
        };
        ws.onmessage = (event) => {
          let message: { message_type?: string; text?: string; error?: string };
          try { message = JSON.parse(String(event.data)) as typeof message; } catch { return; }
          if (message.message_type === "session_started") {
            settle();
            return;
          }
          if (message.message_type === "partial_transcript") {
            interim = message.text?.trim() ?? "";
            options.onPartial?.(merge(committed, interim));
            return;
          }
          if (message.message_type === "committed_transcript") {
            committed = merge(committed, message.text ?? "");
            interim = "";
            options.onPartial?.(committed);
            if (stopping && finalResolve) {
              const done = finalResolve;
              finalResolve = null;
              finalReject = null;
              done(committed);
            }
            return;
          }
          if (message.error || message.message_type === "rate_limited") {
            const error = new DictationError(
              message.message_type === "rate_limited" ? "rate_limited" : "provider_unavailable",
              message.error ?? "ElevenLabs direct transcription failed",
            );
            settle(error);
            fail(error);
          }
        };
        ws.onerror = () => settle(new DictationError("network_error", "ElevenLabs direct connection failed"));
        ws.onclose = (event) => {
          if (socket === ws) socket = null;
          if (!settled) {
            settle(new DictationError(
              event.code === 1008 ? "invalid_credentials" : "network_error",
              event.reason || `ElevenLabs direct connection closed (${event.code})`,
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
        throw new DictationError("network_error", "ElevenLabs direct session did not stay open");
      }
      if (withReplay) await replay(ws);
    })().finally(() => {
      connectFlight = null;
    });
    return connectFlight;
  }

  const initialConnect = connect(false);
  try {
    capture = await captureFactory({
      targetSampleRate: 16_000,
      chunkMs: 40,
      onChunk(pcm) {
        if (!active || stopping || failed) return;
        const retained = pcm.slice();
        chunks.push(retained);
        replayBytes += retained.byteLength;
        if (replayBytes > MAX_REPLAY_BYTES) {
          fail(new DictationError(
            "backpressure_overflow",
            "Direct dictation exceeded the reconnect replay budget",
          ));
          return;
        }
        sendTail = sendTail.then(async () => {
          await initialConnect;
          const ws = socket;
          if (!ws || ws.readyState !== OPEN) return;
          await sendJson(ws, {
            message_type: "input_audio_chunk",
            audio_base_64: base64(retained),
          });
        }).catch(fail);
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
      await sendTail;
      if (failed) {
        const error = failed;
        teardown();
        throw error;
      }
      if (chunks.length === 0) {
        teardown();
        return "";
      }
      if (!socket || socket.readyState !== OPEN) await connect(true);
      const ws = socket;
      if (!ws) throw new DictationError("network_error", "ElevenLabs direct connection is unavailable");
      const final = new Promise<string>((resolve, reject) => {
        finalResolve = resolve;
        finalReject = reject;
      });
      await sendJson(ws, {
        message_type: "input_audio_chunk",
        audio_base_64: "",
        commit: true,
      });
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new DictationError("network_error", "Timed out waiting for ElevenLabs final transcript")),
          FINAL_TIMEOUT_MS,
        );
      });
      try {
        return await Promise.race([final, timeout]);
      } finally {
        teardown();
      }
    },
    cancel() {
      stopping = true;
      teardown();
    },
  };
}

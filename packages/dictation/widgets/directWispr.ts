import {
  DictationError,
  normalizeDictationContext,
  pcmToWav,
  type DictationContext,
} from "@polyth/dictation";
import { startPcm16Capture, type Pcm16Capture, type Pcm16CaptureOptions } from "./audioCapture.ts";
import type { StreamingDictation } from "./dictationClient.ts";

const PROVIDER_URL = "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws";
const SAMPLE_RATE = 16_000;
const PACKET_MS = 1_000;
const CAPTURE_CHUNK_MS = 100;
const PACKET_PCM_BYTES = SAMPLE_RATE * 2;
const MAX_REPLAY_BYTES = 5 * 1024 * 1024;
const MAX_SOCKET_BUFFER = 2 * 1024 * 1024;
const FINAL_TIMEOUT_MS = 15_000;
const OPEN = 1;

interface BrowserSocketLike {
  readyState: number;
  bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface WisprPacket {
  audio: string;
  bytes: number;
  volume: number;
}

export interface DirectWisprOptions {
  language?: string;
  context?: DictationContext;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
  /** Deterministic test seams; production callers never set these. */
  fetchFn?: typeof fetch;
  socketFactory?: (url: string) => BrowserSocketLike;
  captureFactory?: (options: Pcm16CaptureOptions) => Promise<Pcm16Capture>;
  clientId?: string;
}

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
};

const anonymousClientId = (): string => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* old WebView */ }
  return `polyth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const volumeOf = (pcm: Uint8Array): number => {
  if (pcm.byteLength < 2) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  let count = 0;
  for (let at = 0; at + 1 < pcm.byteLength; at += 2) {
    const sample = view.getInt16(at, true);
    sum += sample * sample;
    count++;
  }
  return count ? Math.sqrt(sum / count) : 0;
};

const dictionaryContext = (context: DictationContext): string[] => {
  const values = [
    ...(context.keywords ?? []),
    ...(context.technicalVocabulary ?? []),
    ...Object.keys(context.glossary ?? {}),
    ...Object.values(context.glossary ?? {}),
    context.project?.name ?? "",
    context.project?.repository ?? "",
    context.project?.branch ?? "",
    ...(context.project?.packages ?? []),
    ...(context.project?.files ?? []),
    ...(context.project?.harnesses ?? []),
    ...(context.project?.models ?? []),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim().replace(/\s+/g, " ").slice(0, 96);
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= 96) break;
  }
  return out;
};

const flowContext = (input?: DictationContext): Record<string, unknown> => {
  const context = normalizeDictationContext(input ?? { language: "auto" });
  const dictionary = dictionaryContext(context);
  const messages = context.conversation?.messages?.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  return {
    app: {
      name: context.app?.name || "Polyth",
      type: context.app?.type || "ai",
    },
    dictionary_context: dictionary,
    textbox_contents: {
      before_text: context.composer?.beforeCursor ?? "",
      selected_text: context.composer?.selection ?? "",
      after_text: context.composer?.afterCursor ?? "",
    },
    ...(context.lexicalContext ? { content_text: context.lexicalContext } : {}),
    ...(context.conversation?.id || messages?.length
      ? {
          conversation: {
            ...(context.conversation?.id ? { id: context.conversation.id } : {}),
            participants: ["User", "AI Assistant"],
            ...(messages?.length ? { messages } : {}),
          },
        }
      : {}),
  };
};

async function mintToken(fetchFn: typeof fetch, clientId: string): Promise<string> {
  const response = await fetchFn("/api/dictation/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "wispr", clientId }),
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
        typeof body.message === "string" ? body.message : `Could not mint Wispr Flow client token (HTTP ${response.status})`,
      ),
      { status: response.status },
    );
  }
  const data = await response.json() as { token?: unknown };
  if (typeof data.token !== "string" || !data.token) {
    throw new DictationError("protocol_error", "Wispr Flow token response did not contain a token");
  }
  return data.token;
}

export async function startDirectWisprDictation(options: DirectWisprOptions): Promise<StreamingDictation> {
  const fetchFn = options.fetchFn ?? fetch;
  const socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
  const captureFactory = options.captureFactory ?? startPcm16Capture;
  const clientId = options.clientId?.trim() || anonymousClientId();
  const normalizedContext = normalizeDictationContext(options.context ?? { language: options.language || "auto" });
  let socket: BrowserSocketLike | null = null;
  let capture: Pcm16Capture | null = null;
  let active = true;
  let stopping = false;
  let failed: Error | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectFlight: Promise<void> | null = null;
  let generation = 0;
  let latest = "";
  let finalResolve: ((text: string) => void) | null = null;
  let finalReject: ((error: Error) => void) | null = null;
  let replayBytes = 0;
  const packets: WisprPacket[] = [];
  const pendingPcm = new Uint8Array(PACKET_PCM_BYTES);
  let pendingAt = 0;
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
        throw new DictationError("backpressure_overflow", "Wispr Flow browser socket buffer overflowed");
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    if (!active || ws.readyState !== OPEN) {
      throw new DictationError("network_error", "Wispr Flow browser connection is not open");
    }
    ws.send(JSON.stringify(value));
  };

  const sendPacket = (ws: BrowserSocketLike, packet: WisprPacket, position: number): Promise<void> =>
    sendJson(ws, {
      type: "append",
      position,
      audio_packets: {
        packets: [packet.audio],
        volumes: [packet.volume],
        packet_duration: PACKET_MS / 1000,
        audio_encoding: "wav",
        byte_encoding: "base64",
      },
    });

  const replay = async (ws: BrowserSocketLike): Promise<void> => {
    for (let position = 0; position < packets.length; position++) {
      await sendPacket(ws, packets[position]!, position);
    }
  };

  async function connect(withReplay: boolean): Promise<void> {
    if (connectFlight) return connectFlight;
    const currentGeneration = ++generation;
    connectFlight = (async () => {
      const token = await mintToken(fetchFn, clientId);
      if (!active) return;
      const url = new URL(PROVIDER_URL);
      url.searchParams.set("client_key", `Bearer ${token}`);
      const ws = socketFactory(url.toString());
      socket = ws;
      latest = "";
      options.onPartial?.("");

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve();
        };
        ws.onopen = () => {
          const language = (options.language || normalizedContext.language || "auto").trim();
          try {
            ws.send(JSON.stringify({
              type: "auth",
              access_token: token,
              ...(language && language !== "auto" ? { language: [language.split("-")[0]!.toLowerCase()] } : {}),
              context: flowContext(normalizedContext),
            }));
          } catch (error) {
            settle(new DictationError("network_error", error instanceof Error ? error.message : String(error)));
          }
        };
        ws.onmessage = (event) => {
          let message: {
            status?: string;
            final?: boolean;
            detail?: string;
            message?: unknown;
            body?: { text?: unknown; detected_language?: unknown };
          };
          try { message = JSON.parse(String(event.data)) as typeof message; } catch { return; }
          if (message.status === "auth") {
            settle();
            return;
          }
          if (message.status === "text" && typeof message.body?.text === "string") {
            latest = message.body.text;
            options.onPartial?.(latest);
            if ((message.final || stopping) && finalResolve) {
              const done = finalResolve;
              finalResolve = null;
              finalReject = null;
              done(latest);
            }
            return;
          }
          if (message.status === "error") {
            const error = new DictationError(
              /auth|token|key/i.test(message.detail ?? "") ? "invalid_credentials" : "provider_unavailable",
              message.detail || "Wispr Flow transcription failed",
            );
            settle(error);
            fail(error);
          }
        };
        ws.onerror = () => settle(new DictationError("network_error", "Wispr Flow direct connection failed"));
        ws.onclose = (event) => {
          if (socket === ws) socket = null;
          if (!settled) {
            settle(new DictationError(
              event.code === 1008 ? "invalid_credentials" : "network_error",
              event.reason || `Wispr Flow direct connection closed (${event.code})`,
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
        throw new DictationError("network_error", "Wispr Flow direct session did not stay open");
      }
      if (withReplay) await replay(ws);
    })().finally(() => {
      connectFlight = null;
    });
    return connectFlight;
  }

  // Start token minting/socket setup before microphone capture, but make every
  // initial audio send depend on this exact connection. AudioWorklet can emit a
  // full second before auth completes on a slow network; without this barrier
  // that first packet lived only in the replay buffer and was not sent until a
  // later reconnect.
  const initialConnect = connect(false);

  const enqueuePacket = (pcm: Uint8Array): void => {
    const wav = pcmToWav(pcm, { encoding: "pcm_s16le", sampleRate: SAMPLE_RATE, channels: 1 });
    const packet: WisprPacket = { audio: base64(wav), bytes: wav.byteLength, volume: volumeOf(pcm) };
    const position = packets.length;
    packets.push(packet);
    replayBytes += packet.bytes;
    if (replayBytes > MAX_REPLAY_BYTES) {
      fail(new DictationError("backpressure_overflow", "Direct Wispr dictation exceeded the reconnect replay budget"));
      return;
    }
    sendTail = sendTail.then(async () => {
      await initialConnect;
      const ws = socket;
      if (!ws || ws.readyState !== OPEN) return;
      await sendPacket(ws, packet, position);
    }).catch((error) => {
      if (!(error instanceof DictationError) || error.code !== "network_error") fail(error);
    });
  };

  const appendPcm = (pcm: Uint8Array): void => {
    let at = 0;
    while (at < pcm.byteLength) {
      const take = Math.min(PACKET_PCM_BYTES - pendingAt, pcm.byteLength - at);
      pendingPcm.set(pcm.subarray(at, at + take), pendingAt);
      pendingAt += take;
      at += take;
      if (pendingAt === PACKET_PCM_BYTES) {
        enqueuePacket(pendingPcm.slice());
        pendingAt = 0;
      }
    }
  };

  const flushPending = (): void => {
    if (!pendingAt) return;
    const padded = new Uint8Array(PACKET_PCM_BYTES);
    padded.set(pendingPcm.subarray(0, pendingAt));
    pendingAt = 0;
    enqueuePacket(padded);
  };

  try {
    capture = await captureFactory({
      targetSampleRate: SAMPLE_RATE,
      chunkMs: CAPTURE_CHUNK_MS,
      onChunk(pcm) {
        if (!active || stopping || failed) return;
        appendPcm(pcm);
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
      flushPending();
      await initialConnect;
      await sendTail;
      if (failed) {
        const error = failed;
        teardown();
        throw error;
      }
      if (packets.length === 0) {
        teardown();
        return "";
      }
      if (!socket || socket.readyState !== OPEN) await connect(true);
      const ws = socket;
      if (!ws) throw new DictationError("network_error", "Wispr Flow direct connection is unavailable");
      const final = new Promise<string>((resolve, reject) => {
        finalResolve = resolve;
        finalReject = reject;
      });
      await sendJson(ws, { type: "commit", total_packets: packets.length });
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new DictationError("network_error", "Timed out waiting for Wispr Flow final transcript")),
          FINAL_TIMEOUT_MS,
        );
      });
      try {
        return await Promise.race([final, timeout]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        teardown();
      }
    },
    cancel() {
      stopping = true;
      teardown();
    },
  };
}

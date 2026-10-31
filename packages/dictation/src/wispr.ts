import WebSocket from "ws";
import { DictationError, normalizeDictationContext, type DictationContext } from "./providers.ts";
import { pcmToWav } from "./whisper.ts";
import type { DictationFormat, SttAdapter, SttStream } from "./streaming.ts";

const DEFAULT_URL = "wss://platform-api.wisprflow.ai/api/v1/dash/ws";
const SAMPLE_RATE = 16_000;
const PACKET_PCM_BYTES = SAMPLE_RATE * 2;
const MAX_PROVIDER_BUFFER = 2 * 1024 * 1024;
const FINAL_TIMEOUT_MS = 15_000;

interface SocketLike {
  readyState: number;
  bufferedAmount: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export interface WisprSttOptions {
  apiKey: string;
  baseUrl?: string;
  connect?: (url: string) => SocketLike;
  finalTimeoutMs?: number;
}

const volumeOf = (pcm: Uint8Array): number => {
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
  const messages = context.conversation?.messages?.map((message) => ({ role: message.role, content: message.content }));
  return {
    app: { name: context.app?.name || "Polyth", type: context.app?.type || "ai" },
    dictionary_context: dictionaryContext(context),
    textbox_contents: {
      before_text: context.composer?.beforeCursor ?? "",
      selected_text: context.composer?.selection ?? "",
      after_text: context.composer?.afterCursor ?? "",
    },
    ...(context.lexicalContext ? { content_text: context.lexicalContext } : {}),
    ...(context.conversation?.id || messages?.length
      ? { conversation: {
          ...(context.conversation?.id ? { id: context.conversation.id } : {}),
          participants: ["User", "AI Assistant"],
          ...(messages?.length ? { messages } : {}),
        } }
      : {}),
  };
};

export function createWisprSttAdapter(options: WisprSttOptions): SttAdapter {
  if (!options.apiKey.trim()) throw new DictationError("invalid_credentials", "Wispr Flow API key is missing");
  return {
    engine: "wispr",
    createStream({ format, language, context }): SttStream {
      if (format.encoding !== "pcm_s16le" || format.sampleRate !== SAMPLE_RATE || format.channels !== 1) {
        throw new DictationError("audio_format_error", "Wispr Flow requires mono PCM16 at 16 kHz");
      }
      return createStream(options, format, language, context);
    },
  };
}

function createStream(
  options: WisprSttOptions,
  format: DictationFormat,
  language?: string,
  context?: DictationContext,
): SttStream {
  const url = new URL(options.baseUrl ?? DEFAULT_URL);
  url.searchParams.set("api_key", `Bearer ${options.apiKey}`);
  const connect = options.connect ?? ((socketUrl) => new WebSocket(socketUrl) as unknown as SocketLike);
  const socket = connect(url.toString());
  const normalizedContext = normalizeDictationContext(context ?? { language: language || "auto" });
  const pending = new Uint8Array(PACKET_PCM_BYTES);
  let pendingAt = 0;
  let packetCount = 0;
  let latest = "";
  let closed = false;
  let failure: DictationError | null = null;
  let finalRequested = false;
  let finalResolve: ((text: string) => void) | null = null;
  let finalReject: ((error: Error) => void) | null = null;
  let sendTail = Promise.resolve();

  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const rejectAll = (error: DictationError): void => {
    failure = failure ?? error;
    readyReject(failure);
    finalReject?.(failure);
    finalReject = null;
    finalResolve = null;
  };

  const sendJson = async (value: unknown): Promise<void> => {
    await ready;
    if (failure) throw failure;
    if (closed || socket.readyState !== WebSocket.OPEN) {
      throw new DictationError("network_error", "Wispr Flow connection is not open");
    }
    if (socket.bufferedAmount > MAX_PROVIDER_BUFFER) {
      throw new DictationError("backpressure_overflow", "Wispr Flow provider socket buffer overflowed");
    }
    const payload = JSON.stringify(value);
    await new Promise<void>((resolve, reject) => {
      socket.send(payload, (error) => error
        ? reject(new DictationError("network_error", error.message, { cause: error }))
        : resolve());
    });
  };

  const enqueuePacket = (pcm: Uint8Array): void => {
    const wav = pcmToWav(pcm, format);
    const position = packetCount++;
    const audio = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength).toString("base64");
    const volume = volumeOf(pcm);
    sendTail = sendTail.then(() => sendJson({
      type: "append",
      position,
      audio_packets: {
        packets: [audio],
        volumes: [volume],
        packet_duration: 1,
        audio_encoding: "wav",
        byte_encoding: "base64",
      },
    }));
  };

  const appendPcm = (pcm: Uint8Array): void => {
    let at = 0;
    while (at < pcm.byteLength) {
      const take = Math.min(PACKET_PCM_BYTES - pendingAt, pcm.byteLength - at);
      pending.set(pcm.subarray(at, at + take), pendingAt);
      pendingAt += take;
      at += take;
      if (pendingAt === PACKET_PCM_BYTES) {
        enqueuePacket(pending.slice());
        pendingAt = 0;
      }
    }
  };

  const flushPending = (): void => {
    if (!pendingAt) return;
    const padded = new Uint8Array(PACKET_PCM_BYTES);
    padded.set(pending.subarray(0, pendingAt));
    pendingAt = 0;
    enqueuePacket(padded);
  };

  socket.on("open", () => {
    const selectedLanguage = (language || normalizedContext.language || "auto").trim();
    const start = {
      type: "auth",
      access_token: options.apiKey,
      ...(selectedLanguage && selectedLanguage !== "auto"
        ? { language: [selectedLanguage.split("-")[0]!.toLowerCase()] }
        : {}),
      context: flowContext(normalizedContext),
    };
    socket.send(JSON.stringify(start), (error) => {
      if (error) rejectAll(new DictationError("network_error", error.message, { cause: error }));
    });
  });
  socket.on("message", (raw) => {
    let message: {
      status?: string;
      final?: boolean;
      detail?: string;
      body?: { text?: unknown };
    };
    try { message = JSON.parse(String(raw)) as typeof message; } catch { return; }
    if (message.status === "auth") {
      readyResolve();
      return;
    }
    if (message.status === "text" && typeof message.body?.text === "string") {
      latest = message.body.text;
      if ((message.final || finalRequested) && finalResolve) {
        const done = finalResolve;
        finalResolve = null;
        finalReject = null;
        done(latest);
      }
      return;
    }
    if (message.status === "error") {
      rejectAll(new DictationError(
        /auth|token|key/i.test(message.detail ?? "") ? "invalid_credentials" : "provider_unavailable",
        message.detail || "Wispr Flow realtime transcription failed",
      ));
    }
  });
  socket.on("error", (error) => rejectAll(new DictationError("network_error", error.message || "Wispr Flow connection failed", { cause: error })));
  socket.on("close", (code, reason) => {
    closed = true;
    if (!failure && !(finalRequested && finalResolve === null)) {
      rejectAll(new DictationError(
        code === 1008 ? "invalid_credentials" : "network_error",
        reason?.toString() || `Wispr Flow connection closed (${code})`,
      ));
    }
  });

  return {
    async push(pcm) {
      if (failure) throw failure;
      appendPcm(pcm);
      await sendTail;
    },
    partial() {
      return latest;
    },
    async finalize() {
      if (failure) throw failure;
      if (finalRequested) {
        if (!finalResolve) return latest;
        throw new DictationError("protocol_error", "Wispr Flow finalization is already pending");
      }
      finalRequested = true;
      flushPending();
      await sendTail;
      if (packetCount === 0) {
        if (!closed) socket.close(1000, "empty dictation");
        return "";
      }
      const final = new Promise<string>((resolve, reject) => {
        finalResolve = resolve;
        finalReject = reject;
      });
      await sendJson({ type: "commit", total_packets: packetCount });
      const timeoutMs = options.finalTimeoutMs ?? FINAL_TIMEOUT_MS;
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new DictationError("network_error", "Timed out waiting for Wispr Flow final transcript")), timeoutMs);
        timer.unref?.();
      });
      try {
        return await Promise.race([final, timeout]);
      } finally {
        if (!closed) socket.close(1000, "dictation finalized");
      }
    },
    cancel() {
      closed = true;
      if (!failure) failure = new DictationError("session_expired", "Dictation was cancelled");
      finalReject?.(failure);
      finalReject = null;
      finalResolve = null;
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "dictation cancelled");
    },
  };
}

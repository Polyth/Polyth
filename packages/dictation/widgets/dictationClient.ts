// Browser microphone -> AudioWorklet PCM16 -> binary /ws dictation frames.
// JSON is reserved for control/ACK/transcript messages. Unacked PCM stays in a
// bounded replay buffer and is replayed after reconnect.
import {
  DICTATION_FORMAT,
  DictationError,
  createChunkBuffer,
  encodeDictationAudioFrame,
} from "@polyth/dictation";
import { api } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { startPcm16Capture, type Pcm16Capture } from "./audioCapture.ts";

export interface StreamingDictation {
  stop(): Promise<string>;
  cancel(): void;
}

export async function startStreamingDictation(opts: {
  sessionId?: string;
  language?: string;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
}): Promise<StreamingDictation> {
  const dto = await api.dictationCreate({
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.language ? { language: opts.language } : {}),
  });

  const buffer = createChunkBuffer();
  let ws: WebSocket | null = null;
  let capture: Pcm16Capture | null = null;
  let active = true;
  let failed: Error | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const fail = (error: unknown) => {
    if (!active || failed) return;
    failed = error instanceof Error ? error : new Error(String(error));
    opts.onError?.(failed.message);
    void capture?.pause().catch(() => {});
  };

  const send = (chunk: { seq: number; pcm: Uint8Array }) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(encodeDictationAudioFrame({
        dictationId: dto.id,
        seq: chunk.seq,
        sampleRate: DICTATION_FORMAT.sampleRate,
        channels: DICTATION_FORMAT.channels,
        payload: chunk.pcm,
      }));
    } catch (error) {
      fail(error);
    }
  };

  const connect = () => {
    if (!active) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    ws = sock;
    sock.onopen = () => {
      if (!active || ws !== sock) return;
      // Replay every unacked frame. The server suppresses duplicates and ACKs
      // only the highest contiguous sequence.
      for (const chunk of buffer.unacked()) send(chunk);
    };
    sock.onmessage = (e: MessageEvent) => {
      let msg: {
        type?: string;
        dictationId?: string;
        seq?: number;
        text?: string;
        message?: string;
        code?: string;
      };
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      if (msg.dictationId && msg.dictationId !== dto.id) return;
      if (msg.type === "dictation/ack" && typeof msg.seq === "number") {
        buffer.ack(msg.seq);
      } else if (msg.type === "dictation/transcript" && typeof msg.text === "string") {
        opts.onPartial?.(msg.text);
      } else if (msg.type === "dictation/error") {
        fail(Object.assign(
          new Error(msg.message ?? msg.code ?? tr("dictationclient.dictationFailed")),
          { code: msg.code ?? "provider_unavailable" },
        ));
      }
    };
    sock.onclose = () => {
      if (!active || ws !== sock) return;
      ws = null;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (active) connect();
      }, 600);
    };
    sock.onerror = () => sock.close();
  };
  connect();

  try {
    capture = await startPcm16Capture({
      targetSampleRate: DICTATION_FORMAT.sampleRate,
      chunkMs: 40,
      onChunk(pcm) {
        if (!active || failed) return;
        const beforeDropped = buffer.dropped();
        const seq = buffer.push(pcm);
        if (buffer.dropped() !== beforeDropped) {
          fail(new DictationError(
            "backpressure_overflow",
            "Dictation audio could not be replayed safely because the network buffer overflowed",
          ));
          return;
        }
        send({ seq, pcm });
      },
      onEnded() {
        fail(new DictationError("mic_denied", "Microphone became unavailable during dictation"));
      },
    });
  } catch (error) {
    active = false;
    ws?.close();
    void api.dictationCancel(dto.id).catch(() => {});
    throw error;
  }

  // Mobile WebViews commonly suspend audio when backgrounded. Suspend the
  // worklet too, then resume it without inventing silent PCM on return.
  const onVisibility = () => {
    if (!active || !capture) return;
    if (document.visibilityState === "hidden") void capture.pause().catch(() => {});
    else void capture.resume().catch((error) => fail(error));
  };
  document.addEventListener("visibilitychange", onVisibility);

  const teardown = () => {
    if (!active) return;
    active = false;
    document.removeEventListener("visibilitychange", onVisibility);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    capture?.stop();
    capture = null;
    ws?.close();
    ws = null;
  };

  return {
    async stop() {
      capture?.stop();
      capture = null;
      if (failed) {
        const error = failed;
        teardown();
        void api.dictationCancel(dto.id).catch(() => {});
        throw error;
      }

      // Let reconnect/ACK finish, but never finalize a transcript after known
      // missing audio. The caller keeps the original draft on this failure.
      const deadline = Date.now() + 4_000;
      while (buffer.unacked().length > 0 && Date.now() < deadline && !failed) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (failed || buffer.unacked().length > 0) {
        const error = failed ?? new DictationError("network_error", "Timed out while delivering microphone audio");
        teardown();
        void api.dictationCancel(dto.id).catch(() => {});
        throw error;
      }

      teardown();
      const final = await api.dictationFinalize(dto.id);
      return final.transcript;
    },
    cancel() {
      teardown();
      void api.dictationCancel(dto.id).catch(() => {});
    },
  };
}

// Browser microphone -> AudioWorklet PCM16 -> binary /ws dictation frames.
// JSON is reserved for control/ACK/transcript messages. Unacked PCM stays in a
// bounded replay buffer and is replayed after reconnect.
import {
  DICTATION_FORMAT,
  DictationError,
  createChunkBuffer,
  encodeDictationAudioFrame,
  type DictationContext,
  type DictationSessionDto,
} from "@polyth/dictation";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { startPcm16Capture, type Pcm16Capture } from "./audioCapture.ts";

export interface DictationTransportMetrics {
  startedAt: number;
  capturedFrames: number;
  reconnects: number;
  replayedFrames: number;
  droppedFrames: number;
  firstPartialMs?: number;
  finalMs?: number;
}

export interface StreamingDictation {
  stop(): Promise<string>;
  cancel(): void;
  /** Local transport observations only; no provider billing/CPU values are inferred. */
  metrics?(): Readonly<DictationTransportMetrics>;
}

async function sessionJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("polyth:auth-required"));
    }
    const body = await response.json().catch(() => ({})) as { error?: unknown; message?: unknown };
    throw Object.assign(
      new Error(typeof body.message === "string" ? body.message : `Dictation request failed: HTTP ${response.status}`),
      {
        status: response.status,
        ...(typeof body.error === "string" ? { code: body.error } : {}),
      },
    );
  }
  return response.json() as Promise<T>;
}

const sessionPath = (id = ""): string =>
  `/api/dictation/sessions${id ? `/${encodeURIComponent(id)}` : ""}`;

interface AckWaiter {
  seq: number;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export async function startStreamingDictation(opts: {
  sessionId?: string;
  language?: string;
  context?: Partial<DictationContext>;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
}): Promise<StreamingDictation> {
  const startedAt = performance.now();
  const metrics: DictationTransportMetrics = {
    startedAt: Date.now(),
    capturedFrames: 0,
    reconnects: 0,
    replayedFrames: 0,
    droppedFrames: 0,
  };
  const createInput = {
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.context ? { context: opts.context } : {}),
  };
  const dto = await sessionJson<DictationSessionDto>(sessionPath(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createInput),
  });

  const buffer = createChunkBuffer();
  let ws: WebSocket | null = null;
  let capture: Pcm16Capture | null = null;
  let active = true;
  let failed: Error | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let acknowledgedSeq = dto.acknowledgedSeq;
  let lastSeq = dto.acknowledgedSeq;
  let opened = false;
  const ackWaiters = new Set<AckWaiter>();

  const settleAckWaiters = (): void => {
    for (const waiter of ackWaiters) {
      if (acknowledgedSeq < waiter.seq) continue;
      clearTimeout(waiter.timer);
      ackWaiters.delete(waiter);
      waiter.resolve();
    }
  };

  const rejectAckWaiters = (error: Error): void => {
    for (const waiter of ackWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    ackWaiters.clear();
  };

  const waitForAck = (seq: number, timeoutMs = 4_000): Promise<void> => {
    if (acknowledgedSeq >= seq) return Promise.resolve();
    if (failed) return Promise.reject(failed);
    return new Promise<void>((resolve, reject) => {
      const waiter: AckWaiter = {
        seq,
        resolve,
        reject,
        timer: setTimeout(() => {
          ackWaiters.delete(waiter);
          reject(new DictationError("network_error", `Timed out waiting for microphone audio ACK ${seq}`));
        }, timeoutMs),
      };
      ackWaiters.add(waiter);
    });
  };

  const cancelSession = (): void => {
    void sessionJson<{ ok: true }>(sessionPath(dto.id), { method: "DELETE" }).catch(() => {});
  };

  const fail = (error: unknown) => {
    if (!active || failed) return;
    failed = error instanceof Error ? error : new Error(String(error));
    rejectAckWaiters(failed);
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
      if (opened) metrics.reconnects++;
      opened = true;
      const replay = buffer.unacked();
      if (replay.length) metrics.replayedFrames += replay.length;
      for (const chunk of replay) send(chunk);
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
        acknowledgedSeq = Math.max(acknowledgedSeq, msg.seq);
        buffer.ack(acknowledgedSeq);
        settleAckWaiters();
      } else if (msg.type === "dictation/transcript" && typeof msg.text === "string") {
        if (metrics.firstPartialMs === undefined && msg.text.trim()) {
          metrics.firstPartialMs = Math.max(0, performance.now() - startedAt);
        }
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
        metrics.capturedFrames++;
        lastSeq = seq;
        const dropped = buffer.dropped() - beforeDropped;
        if (dropped > 0) {
          metrics.droppedFrames += dropped;
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
    rejectAckWaiters(error instanceof Error ? error : new Error(String(error)));
    ws?.close();
    cancelSession();
    throw error;
  }

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
        cancelSession();
        throw error;
      }

      try {
        await waitForAck(lastSeq);
      } catch (error) {
        teardown();
        cancelSession();
        throw error;
      }
      if (failed) {
        const error = failed;
        teardown();
        cancelSession();
        throw error;
      }

      teardown();
      const final = await sessionJson<DictationSessionDto>(`${sessionPath(dto.id)}/finalize`, { method: "POST" });
      metrics.finalMs = Math.max(0, performance.now() - startedAt);
      return final.transcript;
    },
    cancel() {
      rejectAckWaiters(new DictationError("session_expired", "Dictation was cancelled"));
      teardown();
      cancelSession();
    },
    metrics: () => ({ ...metrics }),
  };
}

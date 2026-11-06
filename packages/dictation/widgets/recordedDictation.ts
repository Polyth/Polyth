// Recorded dictation: the microphone records PCM16 into memory only. After
// the mic stops, the recording is uploaded in chunks to a batch session on the
// Polyth server and transcribed once. The audio never touches disk or
// IndexedDB; a failed send keeps it in memory so the caller can try again.
import {
  DICTATION_FORMAT,
  DICTATION_RECORDING_LIMITS,
  DictationError,
  type DictationContext,
  type DictationSessionDto,
} from "@polyth/dictation";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { startPcm16Capture, type Pcm16Capture } from "./audioCapture.ts";
import { sessionJson } from "./dictationClient.ts";

/** A finished recording, split into upload-sized PCM chunks. */
export interface Recording {
  readonly chunks: readonly Uint8Array[];
  readonly bytes: number;
  readonly durationMs: number;
}

export interface ActiveRecording {
  /** Audio recorded so far, in milliseconds. */
  elapsedMs(): number;
  /** Release the microphone and keep what was recorded. */
  stop(): Recording;
  /** Release the microphone and drop the audio. */
  cancel(): void;
}

const BYTES_PER_MS = (DICTATION_FORMAT.sampleRate * DICTATION_FORMAT.channels * 2) / 1000;

export async function startRecording(opts: {
  maxDurationMs?: number;
  onLevel?: (rms: number) => void;
  /** The cap was reached and capture already stopped; call stop() to send. */
  onLimit?: () => void;
  /** The microphone went away; call stop() to keep what was recorded. */
  onEnded?: () => void;
} = {}): Promise<ActiveRecording> {
  const chunkBytes = DICTATION_RECORDING_LIMITS.chunkBytes;
  const maxDurationMs = Math.min(opts.maxDurationMs ?? DICTATION_RECORDING_LIMITS.maxDurationMs, DICTATION_RECORDING_LIMITS.maxDurationMs);
  // Whole samples only, so every chunk the server receives stays aligned.
  const maxBytes = Math.floor((maxDurationMs * BYTES_PER_MS) / 2) * 2;
  const chunks: Uint8Array[] = [];
  let current = new Uint8Array(chunkBytes);
  let filled = 0;
  let bytes = 0;
  let capture: Pcm16Capture | null = null;
  let active = true;

  const append = (pcm: Uint8Array): boolean => {
    let offset = 0;
    const room = maxBytes - bytes;
    const take = Math.min(pcm.byteLength, room);
    while (offset < take) {
      const n = Math.min(take - offset, chunkBytes - filled);
      current.set(pcm.subarray(offset, offset + n), filled);
      filled += n;
      offset += n;
      if (filled === chunkBytes) {
        chunks.push(current);
        current = new Uint8Array(chunkBytes);
        filled = 0;
      }
    }
    bytes += take;
    return bytes < maxBytes;
  };

  const release = () => {
    if (!active) return;
    active = false;
    document.removeEventListener("visibilitychange", onVisibility);
    capture?.stop();
    capture = null;
  };

  const onVisibility = () => {
    if (!active || !capture) return;
    if (document.visibilityState === "hidden") void capture.pause().catch(() => {});
    else void capture.resume().catch(() => {});
  };

  capture = await startPcm16Capture({
    targetSampleRate: DICTATION_FORMAT.sampleRate,
    chunkMs: 40,
    ...(opts.onLevel ? { onLevel: opts.onLevel } : {}),
    onChunk(pcm) {
      if (!active) return;
      if (append(pcm)) return;
      release();
      queueMicrotask(() => opts.onLimit?.());
    },
    onEnded() {
      if (!active) return;
      release();
      queueMicrotask(() => opts.onEnded?.());
    },
  });
  document.addEventListener("visibilitychange", onVisibility);

  return {
    elapsedMs: () => bytes / BYTES_PER_MS,
    stop() {
      release();
      if (filled > 0) chunks.push(current.slice(0, filled));
      current = new Uint8Array(0);
      filled = 0;
      return { chunks: [...chunks], bytes, durationMs: bytes / BYTES_PER_MS };
    },
    cancel() {
      release();
      chunks.length = 0;
      current = new Uint8Array(0);
      filled = 0;
      bytes = 0;
    },
  };
}

const toBase64 = (bytes: Uint8Array): string => {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(bytes);
  let binary = "";
  for (let at = 0; at < bytes.byteLength; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
};

const sessionPath = (id: string, tail = ""): string =>
  `/api/dictation/sessions/${encodeURIComponent(id)}${tail}`;

/** Two uploads in flight keep a phone's link busy without queueing the whole
 *  recording at once. */
const UPLOAD_CONCURRENCY = 2;

/** Upload a recording and return its transcript. Each chunk is retried once
 *  on its own; any other failure abandons the server session and throws, and
 *  the caller still holds the recording for another attempt. */
export async function sendRecording(recording: Recording, opts: {
  sessionId?: string;
  language?: string;
  context?: Partial<DictationContext>;
  signal?: AbortSignal;
}): Promise<string> {
  if (recording.bytes === 0) return "";
  opts.signal?.throwIfAborted();
  const created = await sessionJson<DictationSessionDto>("/api/dictation/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "batch",
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.context ? { context: opts.context } : {}),
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const abandon = () => {
    void fetch(sessionPath(created.id), { method: "DELETE" }).catch(() => {});
  };
  try {
    const upload = async (index: number): Promise<void> => {
      const init = (): RequestInit => ({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq: index + 1, audio: toBase64(recording.chunks[index]!) }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      try {
        await sessionJson(sessionPath(created.id, "/audio"), init());
      } catch (error) {
        // Only a lost request is worth resending; the server answered otherwise.
        if (opts.signal?.aborted || (error as { status?: number }).status !== undefined) throw error;
        await sessionJson(sessionPath(created.id, "/audio"), init());
      }
    };
    let next = 0;
    let failed = false;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (failed || index >= recording.chunks.length) return;
        try {
          await upload(index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, recording.chunks.length) }, worker));
    const final = await sessionJson<DictationSessionDto>(sessionPath(created.id, "/finalize"), {
      method: "POST",
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return final.transcript;
  } catch (error) {
    abandon();
    if (opts.signal?.aborted) throw new DictationError("session_expired", tr("dictation.error.cancelled"));
    throw error;
  }
}

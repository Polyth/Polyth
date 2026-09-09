// Server-authoritative streaming dictation. The service owns audio session
// state, bounded reordering, duplicate suppression, acks, limits and
// idempotent finalization. Raw audio is never stored outside the live session.
import { normalizeDictationContext, type DictationContext } from "./providers.ts";

const randomUUID = (): string => globalThis.crypto.randomUUID();

export interface DictationFormat {
  encoding: "pcm_s16le";
  sampleRate: number;
  channels: number;
}

export const DICTATION_FORMAT: DictationFormat = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };

export interface DictationTimingDto {
  startedAt: number;
  firstPartialMs?: number;
  finalMs?: number;
}

export interface DictationSessionDto {
  id: string;
  sessionId?: string;
  status: "starting" | "recording" | "finalizing" | "done" | "failed";
  format: DictationFormat;
  acknowledgedSeq: number;
  transcript: string;
  timing: DictationTimingDto;
}

/** Compatibility seam used by batch and realtime providers. New providers can
 * normalize their vendor events internally while the service remains neutral. */
export interface SttStream {
  push(pcm: Uint8Array): void | Promise<void>;
  /** Latest interim transcript, when the engine produces one. */
  partial?(): string;
  finalize(): Promise<string>;
  cancel?(): void | Promise<void>;
}

export interface SttAdapter {
  engine: string;
  createStream(opts: { format: DictationFormat; language?: string; context?: DictationContext }): SttStream;
}

export interface DictationChunkResult {
  /** Highest contiguous sequence consumed by the provider. */
  ack: number;
  duplicate: boolean;
  /** True when the chunk is accepted but waiting for an earlier sequence. */
  buffered?: boolean;
  transcript?: { revision: number; text: string; final: boolean };
}

export interface DictationServiceOptions {
  /** No adapter = capability {available:false}; evaluated per call so a
   * settings change can flip availability without recreating the service. */
  adapter?: SttAdapter | null | (() => SttAdapter | null);
  unavailableReason?: string;
  maxSessions?: number;
  /** Total unique audio cap per dictation (default 10 MB). */
  maxBytes?: number;
  /** Duration cap derived from bytes at the PCM rate (default 120 s). */
  maxDurationMs?: number;
  /** Maximum distance from the contiguous ACK before the stream is invalid. */
  maxSeqGap?: number;
  /** Bounded server-side out-of-order queue. */
  maxBufferedChunks?: number;
  maxBufferedBytes?: number;
}

export interface DictationService {
  capability(): { available: boolean; engine?: string; reason?: string };
  create(input: { sessionId?: string; language?: string; context?: Partial<DictationContext> }): DictationSessionDto;
  get(id: string): DictationSessionDto | null;
  /** Idempotent per (id, seq). Replayed chunks re-ack without re-transcribing. */
  push(id: string, seq: number, pcm: Uint8Array): Promise<DictationChunkResult>;
  finalize(id: string): Promise<DictationSessionDto>;
  cancel(id: string): void;
}

interface SessionState {
  dto: DictationSessionDto;
  stream: SttStream;
  /** Unique bytes accepted (contiguous + buffered). */
  bytes: number;
  revision: number;
  finalizeP: Promise<DictationSessionDto> | null;
  pending: Map<number, Uint8Array>;
  pendingBytes: number;
}

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const copyDto = (dto: DictationSessionDto): DictationSessionDto => ({
  ...dto,
  format: { ...dto.format },
  timing: { ...dto.timing },
});

export function createDictationService(opts: DictationServiceOptions = {}): DictationService {
  const adapterOf = typeof opts.adapter === "function" ? opts.adapter : () => (opts.adapter as SttAdapter | null | undefined) ?? null;
  const maxSessions = opts.maxSessions ?? 8;
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxDurationMs = opts.maxDurationMs ?? 120_000;
  const maxSeqGap = opts.maxSeqGap ?? 256;
  const maxBufferedChunks = opts.maxBufferedChunks ?? 256;
  const maxBufferedBytes = opts.maxBufferedBytes ?? 2 * 1024 * 1024;
  const sessions = new Map<string, SessionState>();

  const durationMs = (bytes: number): number =>
    (bytes / (DICTATION_FORMAT.sampleRate * 2 * DICTATION_FORMAT.channels)) * 1000;

  const stateOf = (id: string): SessionState => {
    const s = sessions.get(id);
    if (!s) throw err("not-found", `dictation session ${id} not found`);
    return s;
  };

  const fail = (s: SessionState, code: string, message: string): never => {
    s.dto.status = "failed";
    void s.stream.cancel?.();
    s.pending.clear();
    s.pendingBytes = 0;
    throw err(code, message);
  };

  const refreshPartial = (s: SessionState): void => {
    const partial = s.stream.partial?.() ?? "";
    if (!partial || partial === s.dto.transcript) return;
    s.dto.transcript = partial;
    s.revision++;
    if (s.dto.timing.firstPartialMs === undefined) {
      s.dto.timing.firstPartialMs = Math.max(0, Date.now() - s.dto.timing.startedAt);
    }
  };

  return {
    capability() {
      const adapter = adapterOf();
      if (!adapter) return { available: false, reason: opts.unavailableReason ?? "no speech-to-text engine configured" };
      return { available: true, engine: adapter.engine };
    },

    create(input) {
      const adapter = adapterOf();
      if (!adapter) throw err("unavailable", opts.unavailableReason ?? "no speech-to-text engine configured");
      if (sessions.size >= maxSessions) throw err("limit", `too many dictation sessions (max ${maxSessions})`);
      const id = randomUUID();
      const context = normalizeDictationContext({
        ...(input.context ?? {}),
        language: input.language ?? input.context?.language ?? "auto",
      });
      const dto: DictationSessionDto = {
        id,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        status: "recording",
        format: { ...DICTATION_FORMAT },
        acknowledgedSeq: 0,
        transcript: "",
        timing: { startedAt: Date.now() },
      };
      sessions.set(id, {
        dto,
        stream: adapter.createStream({
          format: dto.format,
          ...(context.language !== "auto" ? { language: context.language } : {}),
          context,
        }),
        bytes: 0,
        revision: 0,
        finalizeP: null,
        pending: new Map(),
        pendingBytes: 0,
      });
      return copyDto(dto);
    },

    get(id) {
      const s = sessions.get(id);
      return s ? copyDto(s.dto) : null;
    },

    async push(id, seq, pcm) {
      const s = stateOf(id);
      if (s.dto.status !== "recording") throw err("conflict", `dictation is ${s.dto.status}`);
      if (!Number.isInteger(seq) || seq < 1 || seq > 0xffff_ffff) throw err("invalid-input", "seq must be a positive uint32");
      if ((pcm.byteLength & 1) !== 0) throw err("audio_format_error", "pcm_s16le chunks must contain whole 16-bit samples");

      if (seq <= s.dto.acknowledgedSeq || s.pending.has(seq)) {
        return { ack: s.dto.acknowledgedSeq, duplicate: true, ...currentTranscript(s) };
      }

      const distance = seq - s.dto.acknowledgedSeq;
      if (distance > maxSeqGap) {
        return fail(s, "gap", `audio gap: expected near seq ${s.dto.acknowledgedSeq + 1}, got ${seq}`);
      }
      if (s.bytes + pcm.byteLength > maxBytes || durationMs(s.bytes + pcm.byteLength) > maxDurationMs) {
        return fail(s, "too-long", "dictation exceeded the audio cap");
      }
      if (s.pending.size >= maxBufferedChunks || s.pendingBytes + pcm.byteLength > maxBufferedBytes) {
        return fail(s, "backpressure_overflow", "dictation reorder buffer overflowed");
      }

      const retained = pcm.slice();
      s.pending.set(seq, retained);
      s.pendingBytes += retained.byteLength;
      s.bytes += retained.byteLength;

      for (;;) {
        const nextSeq = s.dto.acknowledgedSeq + 1;
        const next = s.pending.get(nextSeq);
        if (!next) break;
        s.pending.delete(nextSeq);
        s.pendingBytes -= next.byteLength;
        await s.stream.push(next);
        s.dto.acknowledgedSeq = nextSeq;
      }
      refreshPartial(s);
      return {
        ack: s.dto.acknowledgedSeq,
        duplicate: false,
        ...(s.dto.acknowledgedSeq < seq ? { buffered: true } : {}),
        ...currentTranscript(s),
      };
    },

    async finalize(id) {
      const s = stateOf(id);
      if (s.dto.status === "done") return copyDto(s.dto);
      if (s.dto.status === "failed") throw err("conflict", "dictation failed");
      if (s.pending.size > 0) {
        throw err("gap", `cannot finalize with missing audio before seq ${Math.min(...s.pending.keys())}`);
      }
      if (!s.finalizeP) {
        s.dto.status = "finalizing";
        s.finalizeP = (async () => {
          try {
            const text = await s.stream.finalize();
            s.dto.transcript = text;
            s.revision++;
            s.dto.status = "done";
            s.dto.timing.finalMs = Math.max(0, Date.now() - s.dto.timing.startedAt);
          } catch (e) {
            s.dto.status = "failed";
            throw e;
          }
          return copyDto(s.dto);
        })();
      }
      return s.finalizeP;
    },

    cancel(id) {
      const s = sessions.get(id);
      if (!s) return;
      void s.stream.cancel?.();
      s.pending.clear();
      sessions.delete(id);
    },
  };

  function currentTranscript(s: SessionState): { transcript?: { revision: number; text: string; final: boolean } } {
    if (s.revision === 0) return {};
    return { transcript: { revision: s.revision, text: s.dto.transcript, final: s.dto.status === "done" } };
  }
}

// ---------------------------------------------------------------- client-side replay buffer

export interface BufferedChunk { seq: number; pcm: Uint8Array }

export interface ChunkBuffer {
  push(pcm: Uint8Array): number;
  ack(seq: number): void;
  unacked(): BufferedChunk[];
  dropped(): number;
  bytes(): number;
}

export function createChunkBuffer(opts: { maxBytes?: number } = {}): ChunkBuffer {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const chunks: BufferedChunk[] = [];
  let nextSeq = 1;
  let total = 0;
  let droppedCount = 0;
  return {
    push(pcm) {
      const seq = nextSeq++;
      chunks.push({ seq, pcm });
      total += pcm.byteLength;
      while (total > maxBytes && chunks.length > 1) {
        const evicted = chunks.shift()!;
        total -= evicted.pcm.byteLength;
        droppedCount++;
      }
      return seq;
    },
    ack(seq) {
      while (chunks.length > 0 && chunks[0]!.seq <= seq) {
        total -= chunks.shift()!.pcm.byteLength;
      }
    },
    unacked: () => [...chunks],
    dropped: () => droppedCount,
    bytes: () => total,
  };
}

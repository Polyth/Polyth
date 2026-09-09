// Server-authoritative streaming dictation. The service owns audio session
// state, bounded reordering, duplicate suppression, acks, limits and
// idempotent finalization. Raw audio is never stored outside the live session.
import { normalizeDictationContext, type DictationContext } from "./providers.ts";
import {
  decodeDictationAudioFrame,
  isDictationAudioFrame,
  type DictationAudioFrame,
} from "./wire.ts";

const randomUUID = (): string => globalThis.crypto.randomUUID();

export interface DictationFormat {
  encoding: "pcm_s16le";
  sampleRate: number;
  channels: number;
}

export const DICTATION_FORMAT: DictationFormat = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };

export interface DictationTimingDto {
  startedAt: number;
  /** Provider stream became usable, observed by the first successful PCM write. */
  connectMs?: number;
  /** First contiguous PCM chunk accepted by the provider. */
  firstAudioMs?: number;
  /** First non-empty transcript revision observed by Polyth. */
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

export interface SttStream {
  push(pcm: Uint8Array): void | Promise<void>;
  partial?(): string;
  finalize(): Promise<string>;
  cancel?(): void | Promise<void>;
}

export interface SttAdapter {
  engine: string;
  createStream(opts: { format: DictationFormat; language?: string; context?: DictationContext }): SttStream;
}

export interface DictationChunkResult {
  ack: number;
  duplicate: boolean;
  buffered?: boolean;
  transcript?: { revision: number; text: string; final: boolean };
}

export interface DictationServiceOptions {
  adapter?: SttAdapter | null | (() => SttAdapter | null);
  unavailableReason?: string;
  /** Maximum simultaneously recording/finalizing sessions. Completed results do not consume this budget. */
  maxSessions?: number;
  maxBytes?: number;
  maxDurationMs?: number;
  maxSeqGap?: number;
  maxBufferedChunks?: number;
  maxBufferedBytes?: number;
  /** Recording session with no activity for this long expires. Default 2 min. */
  idleTimeoutMs?: number;
  /** Keep done/failed result metadata this long for idempotent finalize/get. Default 5 min. */
  resultRetentionMs?: number;
  /** Deterministic test seam. */
  now?: () => number;
}

export interface DictationService {
  /** Binary hot-path decoding stays package-owned; the core WS gateway only
   * consumes this structural method and never imports @polyth/dictation. */
  decodeAudioFrame(value: ArrayBuffer | ArrayBufferView): DictationAudioFrame | null;
  capability(): { available: boolean; engine?: string; reason?: string };
  create(input: { sessionId?: string; language?: string; context?: Partial<DictationContext> }): DictationSessionDto;
  get(id: string): DictationSessionDto | null;
  push(id: string, seq: number, pcm: Uint8Array): Promise<DictationChunkResult>;
  finalize(id: string): Promise<DictationSessionDto>;
  cancel(id: string): void;
  /** Package/server teardown: cancel live provider work and forget retained results. */
  closeAll(): void;
}

interface SessionState {
  dto: DictationSessionDto;
  stream: SttStream;
  bytes: number;
  revision: number;
  finalizeP: Promise<DictationSessionDto> | null;
  pending: Map<number, Uint8Array>;
  /** Accepted but not yet acknowledged seqs, including the one currently in provider.push(). */
  acceptedSeqs: Set<number>;
  pendingBytes: number;
  lastActivityAt: number;
  /** Serializes provider writes. Vendor streams are not assumed re-entrant. */
  providerTail: Promise<void>;
  /** Finalization closes admission synchronously before waiting for the provider tail. */
  acceptingAudio: boolean;
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
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const resultRetentionMs = opts.resultRetentionMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, SessionState>();

  const durationMs = (bytes: number): number =>
    (bytes / (DICTATION_FORMAT.sampleRate * 2 * DICTATION_FORMAT.channels)) * 1000;

  const liveCount = (): number => {
    let count = 0;
    for (const s of sessions.values()) {
      if (s.dto.status === "recording" || s.dto.status === "finalizing" || s.dto.status === "starting") count++;
    }
    return count;
  };

  const clearAudioState = (s: SessionState): void => {
    s.pending.clear();
    s.acceptedSeqs.clear();
    s.pendingBytes = 0;
  };

  const sweep = (): void => {
    const at = now();
    for (const [id, s] of sessions) {
      if (s.dto.status === "recording" && at - s.lastActivityAt > idleTimeoutMs) {
        void s.stream.cancel?.();
        clearAudioState(s);
        sessions.delete(id);
        continue;
      }
      if ((s.dto.status === "done" || s.dto.status === "failed") && at - s.lastActivityAt > resultRetentionMs) {
        sessions.delete(id);
      }
    }
  };

  const stateOf = (id: string): SessionState => {
    const s = sessions.get(id);
    if (!s) throw err("not-found", `dictation session ${id} not found`);
    if (s.dto.status === "recording" && now() - s.lastActivityAt > idleTimeoutMs) {
      void s.stream.cancel?.();
      clearAudioState(s);
      sessions.delete(id);
      throw err("session_expired", `dictation session ${id} expired after inactivity`);
    }
    return s;
  };

  const fail = (s: SessionState, code: string, message: string): never => {
    s.dto.status = "failed";
    s.acceptingAudio = false;
    s.lastActivityAt = now();
    void s.stream.cancel?.();
    clearAudioState(s);
    throw err(code, message);
  };

  const failWith = (s: SessionState, error: unknown): never => {
    s.dto.status = "failed";
    s.acceptingAudio = false;
    s.lastActivityAt = now();
    void s.stream.cancel?.();
    clearAudioState(s);
    throw error;
  };

  const refreshPartial = (s: SessionState): void => {
    const partial = s.stream.partial?.() ?? "";
    if (!partial || partial === s.dto.transcript) return;
    s.dto.transcript = partial;
    s.revision++;
    if (s.dto.timing.firstPartialMs === undefined) {
      s.dto.timing.firstPartialMs = Math.max(0, now() - s.dto.timing.startedAt);
    }
  };

  const queueProviderDrain = (s: SessionState): Promise<void> => {
    const task = s.providerTail.then(async () => {
      for (;;) {
        const nextSeq = s.dto.acknowledgedSeq + 1;
        const next = s.pending.get(nextSeq);
        if (!next) break;
        s.pending.delete(nextSeq);
        s.pendingBytes -= next.byteLength;
        try {
          await s.stream.push(next);
        } catch (error) {
          failWith(s, error);
        }
        s.dto.acknowledgedSeq = nextSeq;
        s.acceptedSeqs.delete(nextSeq);
        const elapsed = Math.max(0, now() - s.dto.timing.startedAt);
        if (s.dto.timing.connectMs === undefined) s.dto.timing.connectMs = elapsed;
        if (s.dto.timing.firstAudioMs === undefined) s.dto.timing.firstAudioMs = elapsed;
        refreshPartial(s);
      }
    });
    s.providerTail = task;
    return task;
  };

  return {
    decodeAudioFrame(value) {
      return isDictationAudioFrame(value) ? decodeDictationAudioFrame(value) : null;
    },

    capability() {
      const adapter = adapterOf();
      if (!adapter) return { available: false, reason: opts.unavailableReason ?? "no speech-to-text engine configured" };
      return { available: true, engine: adapter.engine };
    },

    create(input) {
      sweep();
      const adapter = adapterOf();
      if (!adapter) throw err("unavailable", opts.unavailableReason ?? "no speech-to-text engine configured");
      if (liveCount() >= maxSessions) throw err("limit", `too many live dictation sessions (max ${maxSessions})`);
      const id = randomUUID();
      const startedAt = now();
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
        timing: { startedAt },
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
        acceptedSeqs: new Set(),
        pendingBytes: 0,
        lastActivityAt: startedAt,
        providerTail: Promise.resolve(),
        acceptingAudio: true,
      });
      return copyDto(dto);
    },

    get(id) {
      sweep();
      const s = sessions.get(id);
      return s ? copyDto(s.dto) : null;
    },

    async push(id, seq, pcm) {
      const s = stateOf(id);
      if (s.dto.status !== "recording" || !s.acceptingAudio) {
        throw err("conflict", `dictation is ${s.dto.status === "recording" ? "finalizing" : s.dto.status}`);
      }
      if (!Number.isInteger(seq) || seq < 1 || seq > 0xffff_ffff) throw err("invalid-input", "seq must be a positive uint32");
      if ((pcm.byteLength & 1) !== 0) throw err("audio_format_error", "pcm_s16le chunks must contain whole 16-bit samples");
      s.lastActivityAt = now();

      if (seq <= s.dto.acknowledgedSeq || s.acceptedSeqs.has(seq)) {
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
      s.acceptedSeqs.add(seq);
      s.pendingBytes += retained.byteLength;
      s.bytes += retained.byteLength;

      await queueProviderDrain(s);
      s.lastActivityAt = now();
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
      if (s.finalizeP) return s.finalizeP;

      s.acceptingAudio = false;
      const operation = (async (): Promise<DictationSessionDto> => {
        await s.providerTail;
        if (s.pending.size > 0) {
          s.acceptingAudio = true;
          throw err("gap", `cannot finalize with missing audio before seq ${Math.min(...s.pending.keys())}`);
        }
        s.dto.status = "finalizing";
        s.lastActivityAt = now();
        try {
          const text = await s.stream.finalize();
          s.dto.transcript = text;
          s.revision++;
          s.dto.status = "done";
          s.dto.timing.finalMs = Math.max(0, now() - s.dto.timing.startedAt);
          s.lastActivityAt = now();
          clearAudioState(s);
        } catch (error) {
          s.dto.status = "failed";
          s.acceptingAudio = false;
          s.lastActivityAt = now();
          clearAudioState(s);
          throw error;
        }
        return copyDto(s.dto);
      })();
      s.finalizeP = operation;
      try {
        return await operation;
      } catch (error) {
        if (s.dto.status === "recording") {
          s.finalizeP = null;
          s.acceptingAudio = true;
        }
        throw error;
      }
    },

    cancel(id) {
      const s = sessions.get(id);
      if (!s) return;
      s.acceptingAudio = false;
      void s.stream.cancel?.();
      clearAudioState(s);
      sessions.delete(id);
    },

    closeAll() {
      for (const s of sessions.values()) {
        s.acceptingAudio = false;
        void s.stream.cancel?.();
        clearAudioState(s);
      }
      sessions.clear();
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

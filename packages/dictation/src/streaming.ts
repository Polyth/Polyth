// Server-authoritative streaming dictation (WP15). The service owns audio
// session state, chunk dedupe/acks, caps, and a provider-neutral STT adapter
// seam. Raw audio is consumed by the adapter and never stored or logged;
// nothing here touches the session event log — interim transcripts are
// transient composer state by design.
// Platform-neutral on purpose: the chunk buffer runs in the browser bundle,
// so Web Crypto (available in Node 22 and browsers) supplies ids.
const randomUUID = (): string => globalThis.crypto.randomUUID();

export interface DictationFormat {
  encoding: "pcm_s16le";
  sampleRate: number;
  channels: number;
}

export const DICTATION_FORMAT: DictationFormat = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };

export interface DictationSessionDto {
  id: string;
  sessionId?: string;
  status: "starting" | "recording" | "finalizing" | "done" | "failed";
  format: DictationFormat;
  acknowledgedSeq: number;
  transcript: string;
}

/** One live STT stream; created per dictation session by the adapter. */
export interface SttStream {
  push(pcm: Uint8Array): void | Promise<void>;
  /** Latest interim transcript, when the engine produces one. */
  partial?(): string;
  finalize(): Promise<string>;
  cancel?(): void;
}

export interface SttAdapter {
  engine: string;
  createStream(opts: { format: DictationFormat; language?: string }): SttStream;
}

export interface DictationChunkResult {
  ack: number;
  duplicate: boolean;
  transcript?: { revision: number; text: string; final: boolean };
}

export interface DictationServiceOptions {
  /** No adapter = capability {available:false}; the web app keeps Web Speech.
   *  A function is re-evaluated per call so settings changes flip the
   *  capability honestly without recreating the service (F8). */
  adapter?: SttAdapter | null | (() => SttAdapter | null);
  unavailableReason?: string;
  maxSessions?: number;
  /** Total audio cap per dictation (default 10 MB). */
  maxBytes?: number;
  /** Duration cap derived from bytes at the PCM rate (default 120 s). */
  maxDurationMs?: number;
  /** A seq jump larger than this fails the session (client lost audio). */
  maxSeqGap?: number;
}

export interface DictationService {
  capability(): { available: boolean; engine?: string; reason?: string };
  create(input: { sessionId?: string; language?: string }): DictationSessionDto;
  get(id: string): DictationSessionDto | null;
  /** Idempotent per (id, seq): replayed chunks re-ack without re-transcribing. */
  push(id: string, seq: number, pcm: Uint8Array): Promise<DictationChunkResult>;
  finalize(id: string): Promise<DictationSessionDto>;
  cancel(id: string): void;
}

interface SessionState {
  dto: DictationSessionDto;
  stream: SttStream;
  bytes: number;
  revision: number;
  finalizeP: Promise<DictationSessionDto> | null;
}

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export function createDictationService(opts: DictationServiceOptions = {}): DictationService {
  const adapterOf = typeof opts.adapter === "function" ? opts.adapter : () => (opts.adapter as SttAdapter | null | undefined) ?? null;
  const maxSessions = opts.maxSessions ?? 8;
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxDurationMs = opts.maxDurationMs ?? 120_000;
  const maxSeqGap = opts.maxSeqGap ?? 50;
  const sessions = new Map<string, SessionState>();

  const durationMs = (bytes: number): number =>
    (bytes / (DICTATION_FORMAT.sampleRate * 2 * DICTATION_FORMAT.channels)) * 1000;

  const stateOf = (id: string): SessionState => {
    const s = sessions.get(id);
    if (!s) throw err("not-found", `dictation session ${id} not found`);
    return s;
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
      const dto: DictationSessionDto = {
        id,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        status: "recording",
        format: { ...DICTATION_FORMAT },
        acknowledgedSeq: 0,
        transcript: "",
      };
      sessions.set(id, {
        dto,
        stream: adapter.createStream({ format: dto.format, ...(input.language ? { language: input.language } : {}) }),
        bytes: 0,
        revision: 0,
        finalizeP: null,
      });
      return { ...dto };
    },

    get(id) {
      const s = sessions.get(id);
      return s ? { ...s.dto } : null;
    },

    async push(id, seq, pcm) {
      const s = stateOf(id);
      if (s.dto.status !== "recording") throw err("conflict", `dictation is ${s.dto.status}`);
      if (!Number.isInteger(seq) || seq < 1) throw err("invalid-input", "seq must be a positive integer");
      // Replay after reconnect: anything at or below the ack is already
      // transcribed — re-ack so the client can drop it, transcribe nothing.
      if (seq <= s.dto.acknowledgedSeq) {
        return { ack: s.dto.acknowledgedSeq, duplicate: true, ...currentTranscript(s) };
      }
      if (seq !== s.dto.acknowledgedSeq + 1) {
        if (seq - s.dto.acknowledgedSeq > maxSeqGap) {
          s.dto.status = "failed";
          s.stream.cancel?.();
          throw err("gap", `audio gap: expected seq ${s.dto.acknowledgedSeq + 1}, got ${seq}`);
        }
        throw err("out-of-order", `expected seq ${s.dto.acknowledgedSeq + 1}, got ${seq}`);
      }
      s.bytes += pcm.byteLength;
      if (s.bytes > maxBytes || durationMs(s.bytes) > maxDurationMs) {
        s.dto.status = "failed";
        s.stream.cancel?.();
        throw err("too-long", "dictation exceeded the audio cap");
      }
      await s.stream.push(pcm);
      s.dto.acknowledgedSeq = seq;
      const partial = s.stream.partial?.() ?? "";
      if (partial && partial !== s.dto.transcript) {
        s.dto.transcript = partial;
        s.revision++;
      }
      return { ack: seq, duplicate: false, ...currentTranscript(s) };
    },

    async finalize(id) {
      const s = stateOf(id);
      if (s.dto.status === "done") return { ...s.dto };
      if (s.dto.status === "failed") throw err("conflict", "dictation failed");
      // Finalizes exactly once: concurrent callers share the same promise.
      if (!s.finalizeP) {
        s.dto.status = "finalizing";
        s.finalizeP = (async () => {
          try {
            const text = await s.stream.finalize();
            s.dto.transcript = text;
            s.revision++;
            s.dto.status = "done";
          } catch (e) {
            s.dto.status = "failed";
            throw e;
          }
          return { ...s.dto };
        })();
      }
      return s.finalizeP;
    },

    cancel(id) {
      const s = sessions.get(id);
      if (!s) return;
      s.stream.cancel?.();
      sessions.delete(id);
    },
  };

  function currentTranscript(s: SessionState): { transcript?: { revision: number; text: string; final: boolean } } {
    if (s.revision === 0) return {};
    return { transcript: { revision: s.revision, text: s.dto.transcript, final: s.dto.status === "done" } };
  }
}

// ---------------------------------------------------------------- client-side chunk buffer

export interface BufferedChunk { seq: number; pcm: Uint8Array }

/** Bounded PCM retention until the server acks (WP15). After a reconnect the
 *  caller replays `unacked()` in order; the server re-acks duplicates. */
export interface ChunkBuffer {
  /** Assign the next seq, retain the chunk, return the seq. */
  push(pcm: Uint8Array): number;
  /** Server acknowledged everything at or below `seq`; drop it. */
  ack(seq: number): void;
  /** In-order replay list for reconnect. */
  unacked(): BufferedChunk[];
  /** Chunks evicted because the bound was hit; audio was lost. */
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

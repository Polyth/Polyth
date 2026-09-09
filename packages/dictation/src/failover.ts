import {
  DictationError,
  normalizeDictationError,
  type DictationContext,
  type DictationErrorCode,
} from "./providers.ts";
import type { DictationFormat, SttAdapter, SttStream } from "./streaming.ts";

const DEFAULT_REPLAY_BYTES = 10 * 1024 * 1024;
const RECOVERABLE = new Set<DictationErrorCode>([
  "provider_unavailable",
  "rate_limited",
  "network_error",
  "session_expired",
  "unsupported_language",
  "local_model_missing",
  "local_model_downloading",
  "local_model_failed",
  "worker_crashed",
]);

export interface FailoverSttOptions {
  /** Maximum raw PCM retained only while the primary is active. */
  maxReplayBytes?: number;
  /** Override for tests/special providers; safety errors stay non-recoverable by default. */
  recoverable?: (error: DictationError) => boolean;
}

/**
 * One explicit primary -> fallback transition. Audio is retained only in RAM,
 * only until the transition, and only up to maxReplayBytes. There is no
 * tertiary cascade and no fallback at all unless the caller supplied one.
 */
export function createFailoverSttAdapter(
  primary: SttAdapter,
  fallback: SttAdapter,
  options: FailoverSttOptions = {},
): SttAdapter {
  const maxReplayBytes = Math.max(64 * 1024, options.maxReplayBytes ?? DEFAULT_REPLAY_BYTES);
  const recoverable = options.recoverable ?? ((error: DictationError) => RECOVERABLE.has(error.code));

  return {
    engine: `${primary.engine}->${fallback.engine}`,
    createStream(opts: { format: DictationFormat; language?: string; context?: DictationContext }): SttStream {
      const primaryStream = primary.createStream(opts);
      let active = primaryStream;
      let fallbackStream: SttStream | null = null;
      let switched = false;
      let replayable = true;
      let replayBytes = 0;
      let retained: Uint8Array[] = [];

      const retain = (pcm: Uint8Array): void => {
        if (switched || !replayable) return;
        if (replayBytes + pcm.byteLength > maxReplayBytes) {
          // Keep the primary working; simply make a later provider switch
          // impossible rather than dropping/replaying an incomplete prefix.
          replayable = false;
          replayBytes = 0;
          retained = [];
          return;
        }
        const copy = pcm.slice();
        retained.push(copy);
        replayBytes += copy.byteLength;
      };

      const switchProvider = async (raw: unknown): Promise<SttStream> => {
        const failure = normalizeDictationError(raw);
        if (switched || !recoverable(failure)) throw failure;
        if (!replayable) {
          throw new DictationError(
            failure.code,
            `${failure.message}; explicit fallback was not attempted because the in-memory replay budget was exceeded`,
            { retryAfterMs: failure.retryAfterMs, cause: failure },
          );
        }
        const next = fallback.createStream(opts);
        try {
          for (const chunk of retained) await next.push(chunk);
        } catch (error) {
          await next.cancel?.();
          throw normalizeDictationError(error);
        }
        fallbackStream = next;
        active = next;
        switched = true;
        retained = [];
        replayBytes = 0;
        await primaryStream.cancel?.();
        return next;
      };

      return {
        async push(pcm) {
          retain(pcm);
          try {
            await active.push(pcm);
          } catch (error) {
            if (switched) throw normalizeDictationError(error);
            const next = await switchProvider(error);
            // `pcm` was already included in retained before the failed push and
            // therefore was replayed exactly once into the fallback above.
            active = next;
          }
        },
        partial: () => active.partial?.() ?? "",
        async finalize() {
          try {
            return await active.finalize();
          } catch (error) {
            if (switched) throw normalizeDictationError(error);
            const next = await switchProvider(error);
            return next.finalize();
          }
        },
        async cancel() {
          await Promise.allSettled([
            primaryStream.cancel?.() ?? Promise.resolve(),
            fallbackStream?.cancel?.() ?? Promise.resolve(),
          ]);
          retained = [];
          replayBytes = 0;
        },
      };
    },
  };
}
